/**
 * At-most-once execution for the agent `ncl` transport (issue #273).
 *
 * The `cli_request` handler runs the command and then writes the response row.
 * A failure of that WRITE re-dispatches the outbound row, and before the
 * ledger that re-ran the command — three `ncl tasks create` series where the
 * agent asked for one. These tests drive the registered delivery action at its
 * real seam: a genuine SQLite write failure on the first attempt, then a
 * second attempt on a writable handle.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

// Process-unique, not a fixed /tmp path: two worktrees running this suite
// concurrently would otherwise chmod/delete each other's SQLite files (issue
// #274) — enforced by src/fixture-roots.test.ts.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('cli-request-ledger') }));

const dispatch = vi.fn();
vi.mock('./dispatch.js', () => ({ dispatch: (...args: unknown[]) => dispatch(...args) }));

vi.mock('../log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, deleteSession, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getDeliveryAction, type DeliveryActionHandler } from '../delivery.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../session-manager.js';
import type { Session } from '../types.js';
import './delivery-action.js';
import { claimCliRequest, completeCliRequest, pruneCliRequestExecutions } from './request-ledger.js';

const AG = 'ag-ledger';
const SESSION_ID = 'sess-ledger';

function session(): Session {
  return {
    id: SESSION_ID,
    agent_group_id: AG,
    messaging_group_id: 'mg-ledger',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

const request = { action: 'cli_request', requestId: 'req-1', command: 'tasks-create', args: { prompt: 'x' } };

function handler(): DeliveryActionHandler {
  const h = getDeliveryAction('cli_request');
  if (!h) throw new Error('cli_request action is not registered');
  return h;
}

/**
 * One delivery attempt. `writable: false` makes the response write genuinely
 * fail: the handler now opens its own mailbox session internally (no `inDb`
 * handle is passed in — the delivery loop stopped threading one through after
 * the mailbox seam moved this action off it), so the real open path has to
 * fail on its own, not via an injected readonly handle.
 *
 * The failure is induced by swapping the file for a same-named directory,
 * not by chmod (review finding, 2026-09-03): root bypasses permission bits,
 * as this suite's own containerized runs commonly are, so `0o444` silently
 * stopped producing a write failure there. Nothing can open a directory as a
 * regular sqlite file regardless of UID — better-sqlite3 raises
 * `SQLITE_CANTOPEN` either way, verified empirically as both root and a
 * non-root user. `sessionDbPathIsGone` (the mailbox opener's
 * missing-vs-broken test) only trusts `fs.statSync`, which a directory still
 * satisfies, so this surfaces as a real open failure — not the
 * vanished-mailbox path. The original file is renamed aside and restored so
 * the second attempt sees its real, unmodified content.
 */
async function attempt(writable: boolean): Promise<void> {
  const dbFile = inboundDbPath(AG, SESSION_ID);
  const backup = `${dbFile}.bak`;
  if (!writable) {
    fs.renameSync(dbFile, backup);
    fs.mkdirSync(dbFile);
  }
  try {
    await handler()(request, session());
  } finally {
    if (!writable) {
      fs.rmdirSync(dbFile);
      fs.renameSync(backup, dbFile);
    }
  }
}

function responseRows(): Array<{ id: string; content: string }> {
  const db = new Database(inboundDbPath(AG, SESSION_ID), { readonly: true });
  try {
    return db.prepare("SELECT id, content FROM messages_in WHERE id LIKE 'cli-resp-%'").all() as Array<{
      id: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

function ledgerRows(): Array<{ status: string; response: string | null }> {
  return getDb().prepare('SELECT status, response FROM cli_request_executions').all() as Array<{
    status: string;
    response: string | null;
  }>;
}

function requestIds(): string[] {
  return (getDb().prepare('SELECT request_id FROM cli_request_executions').all() as Array<{ request_id: string }>).map(
    (r) => r.request_id,
  );
}

/** Backdate a claim so the prune's floor and retention windows are in play. */
function age(requestId: string, claimedAt: string): void {
  getDb().prepare('UPDATE cli_request_executions SET claimed_at = ? WHERE request_id = ?').run(claimedAt, requestId);
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  initSessionFolder(AG, SESSION_ID);
  dispatch.mockReset();
  dispatch.mockResolvedValue({ id: 'req-1', ok: true, data: { id: 'task-created-once' } });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cli_request execution is at most once per request id', () => {
  it('a failed response write is retried without re-running the command', async () => {
    // Attempt 1: the command runs, the response write fails for a reason that
    // has nothing to do with it — the exact shape of the #273 defect.
    await expect(attempt(false)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(responseRows()).toHaveLength(0);

    // Attempt 2: the delivery loop re-dispatches the same outbound row.
    await attempt(true);

    expect(dispatch).toHaveBeenCalledTimes(1); // ← the fix: not 2
    const rows = responseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('cli-resp-req-1');
    expect(JSON.parse(rows[0].content).frame).toEqual({ id: 'req-1', ok: true, data: { id: 'task-created-once' } });
  });

  it('replays the recorded frame verbatim, including an error response', async () => {
    dispatch.mockResolvedValue({ id: 'req-1', ok: false, error: { code: 'forbidden', message: 'nope' } });

    await expect(attempt(false)).rejects.toThrow();
    await attempt(true);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(responseRows()[0].content).frame).toEqual({
      id: 'req-1',
      ok: false,
      error: { code: 'forbidden', message: 'nope' },
    });
  });

  it('a third attempt after a delivered response writes nothing and still does not dispatch', async () => {
    await expect(attempt(false)).rejects.toThrow();
    await attempt(true);
    // The loop can fail AFTER the write (markDelivered), which re-dispatches a
    // row whose response row already exists. `insertMessageIfNew` absorbs it.
    await attempt(true);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(responseRows()).toHaveLength(1);
  });

  it('a dispatch that throws keeps its claim — the retry answers, it does not re-dispatch', async () => {
    // Tempting to release the claim here: `dispatch()` converts every
    // command-handler failure into an error frame, so a throw came from its own
    // pre-handler plumbing. But the hold path writes a pending_approvals row
    // and delivers a card BEFORE it can fail, so a released claim would card
    // the same request twice.
    dispatch.mockRejectedValueOnce(new Error('container config read failed'));

    await expect(attempt(true)).rejects.toThrow('container config read failed');
    expect(ledgerRows()).toEqual([{ status: 'executing', response: null }]);
    expect(responseRows()).toHaveLength(0);

    await attempt(true);

    expect(dispatch).toHaveBeenCalledTimes(1); // not re-dispatched
    const frame = JSON.parse(responseRows()[0].content).frame;
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toMatch(/NOT run again/);
  });

  it('a claim left executing by a host that died mid-command is answered, never re-run', async () => {
    // No release, no completion: what a SIGKILL between dispatch and the
    // ledger write leaves behind.
    claimCliRequest(SESSION_ID, 'req-1', 'tasks-create');

    await attempt(true);

    expect(dispatch).not.toHaveBeenCalled();
    const frame = JSON.parse(responseRows()[0].content).frame;
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toMatch(/NOT run again/);
  });

  it('scopes the ledger to the session, since request ids are only unique per session', () => {
    expect(claimCliRequest('sess-a', 'req-1', 'tasks-create').state).toBe('fresh');
    expect(claimCliRequest('sess-b', 'req-1', 'tasks-create').state).toBe('fresh');
    expect(claimCliRequest('sess-a', 'req-1', 'tasks-create').state).toBe('executing');
  });
});

describe('ledger mechanics', () => {
  beforeEach(() => {
    claimCliRequest(SESSION_ID, 'req-9', 'groups-list');
  });

  it('completeCliRequest makes the next claim a done replay', () => {
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: [1, 2] });
    const claim = claimCliRequest(SESSION_ID, 'req-9', 'groups-list');
    expect(claim).toEqual({ state: 'done', response: { id: 'req-9', ok: true, data: [1, 2] } });
  });

  it('completeCliRequest never overwrites a recorded outcome', () => {
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 'first' });
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 'second' });
    const claim = claimCliRequest(SESSION_ID, 'req-9', 'groups-list');
    expect(claim).toEqual({ state: 'done', response: { id: 'req-9', ok: true, data: 'first' } });
  });

  it('an unparseable stored frame reports ambiguity rather than re-running the command', () => {
    getDb()
      .prepare(`UPDATE cli_request_executions SET status = 'done', response = 'not json' WHERE request_id = 'req-9'`)
      .run();
    expect(claimCliRequest(SESSION_ID, 'req-9', 'groups-list').state).toBe('executing');
  });

  it('prune keeps an aged claim that nothing has superseded — age alone is not terminal', () => {
    // A host that restarts mid-retry resets the delivery loop's attempt
    // counter, so an hours-old undelivered outbound row is still retryable.
    // Dropping its claim on a clock would let the command run twice.
    age('req-9', '2020-01-01T00:00:00.000Z');

    pruneCliRequestExecutions();

    expect(requestIds()).toEqual(['req-9']);
  });

  it('prune drops a claim a newer completed request from the same session has superseded', () => {
    // `drainSession` breaks on the first failed row, so a later row could only
    // be delivered once this one reached delivered-or-dropped.
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 1 });
    age('req-9', '2026-09-01T00:00:00.000Z');
    claimCliRequest(SESSION_ID, 'req-10', 'groups-list');
    completeCliRequest(SESSION_ID, 'req-10', { id: 'req-10', ok: true, data: 2 });
    age('req-10', '2026-09-02T00:00:00.000Z');

    pruneCliRequestExecutions();

    expect(requestIds()).toEqual(['req-10']);
  });

  it('supersession survives a backward clock step — insertion order wins, not claimed_at', () => {
    // Codex review round 11: a host restart followed by an NTP correction can
    // hand a chronologically LATER claim an EARLIER `claimed_at` than the row
    // before it. req-10 is inserted (and completed) strictly after req-9, but
    // its clock-stepped timestamp reads as centuries older. If the prune's
    // "newer" test used claimed_at, req-9 would incorrectly survive as
    // unsuperseded — reopening the at-most-once hole this table exists to
    // close. It must use insertion order (rowid) instead.
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 1 });
    age('req-9', '2026-09-01T00:00:00.000Z');
    claimCliRequest(SESSION_ID, 'req-10', 'groups-list');
    completeCliRequest(SESSION_ID, 'req-10', { id: 'req-10', ok: true, data: 2 });
    age('req-10', '1970-01-01T00:00:00.000Z'); // clock stepped backward after req-9

    pruneCliRequestExecutions();

    // req-9 is superseded (req-10 exists, completed, inserted after it) and
    // past the floor — pruned despite its claimed_at looking "newer" than
    // req-10's. req-10 is the session's tail — nothing is newer than it — so
    // it survives even though its own claimed_at is ancient.
    expect(requestIds()).toEqual(['req-10']);
  });

  it("prune never drops another session's claim, however new this session's requests are", () => {
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 1 });
    age('req-9', '2026-09-01T00:00:00.000Z');
    claimCliRequest('other-session', 'req-8', 'groups-list');
    completeCliRequest('other-session', 'req-8', { id: 'req-8', ok: true, data: 0 });
    age('req-8', '2026-09-01T00:00:00.000Z');
    claimCliRequest(SESSION_ID, 'req-10', 'groups-list');
    completeCliRequest(SESSION_ID, 'req-10', { id: 'req-10', ok: true, data: 2 });

    pruneCliRequestExecutions();

    expect(requestIds().sort()).toEqual(['req-10', 'req-8']);
  });

  it('prune leaves a superseded claim alone inside the floor, and never drops an executing one', () => {
    // Fresh rows are untouchable, and an `executing` claim is the one that most
    // needs to survive — it is the marker of a host that died mid-command.
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 1 });
    claimCliRequest(SESSION_ID, 'req-10', 'groups-list');
    completeCliRequest(SESSION_ID, 'req-10', { id: 'req-10', ok: true, data: 2 });
    claimCliRequest(SESSION_ID, 'req-11', 'groups-list'); // never completed
    age('req-11', '2020-01-01T00:00:00.000Z');

    pruneCliRequestExecutions();

    expect(requestIds().sort()).toEqual(['req-10', 'req-11', 'req-9']);
  });

  it('deleting the session takes its claims with it — nothing is left to retry them', () => {
    // The newest claim per session has no age at which it expires, so session
    // teardown is the only thing that can clear it.
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 1 });
    claimCliRequest('survivor-session', 'req-8', 'groups-list');

    deleteSession(SESSION_ID);

    expect(requestIds()).toEqual(['req-8']);
  });

  it('a week-old unsuperseded claim keeps the fact it ran and loses only its payload', () => {
    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 'stale' });
    age('req-9', '2020-01-01T00:00:00.000Z');

    pruneCliRequestExecutions();

    // Still refuses to re-run — a dropped payload downgrades a replay to the
    // ambiguous answer, it does not restore at-least-once.
    expect(claimCliRequest(SESSION_ID, 'req-9', 'groups-list').state).toBe('executing');
    expect(requestIds()).toEqual(['req-9']);
  });
});
