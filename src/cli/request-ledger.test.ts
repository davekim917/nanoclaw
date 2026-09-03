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
  DATA_DIR: '/tmp/nanoclaw-test-cli-request-ledger',
  GROUPS_DIR: '/tmp/nanoclaw-test-cli-request-ledger/groups',
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-request-ledger';

const dispatch = vi.fn();
vi.mock('./dispatch.js', () => ({ dispatch: (...args: unknown[]) => dispatch(...args) }));

vi.mock('../log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getDeliveryAction, type DeliveryActionHandler } from '../delivery.js';
import { inboundDbPath, initSessionFolder } from '../session-manager.js';
import type { Session } from '../types.js';
import './delivery-action.js';
import { claimCliRequest, completeCliRequest, pruneCliRequestExecutions, releaseCliRequest } from './request-ledger.js';

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

/** One delivery attempt. `writable: false` makes the response write genuinely fail. */
async function attempt(writable: boolean): Promise<void> {
  const db = new Database(inboundDbPath(AG, SESSION_ID), { readonly: !writable });
  try {
    await handler()(request, session(), db);
  } finally {
    db.close();
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

  it('a dispatch that throws before the command ran is retried as before', async () => {
    // `dispatch()` turns handler failures into error frames, so a throw is its
    // own pre-handler plumbing failing — the command never ran, and the retry
    // must be a real first attempt.
    dispatch.mockRejectedValueOnce(new Error('container config read failed'));

    await expect(attempt(true)).rejects.toThrow('container config read failed');
    expect(ledgerRows()).toHaveLength(0); // claim released
    expect(responseRows()).toHaveLength(0);

    await attempt(true);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(responseRows()[0].content).frame).toEqual({
      id: 'req-1',
      ok: true,
      data: { id: 'task-created-once' },
    });
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

  it('releaseCliRequest frees an executing claim but not a completed one', () => {
    releaseCliRequest(SESSION_ID, 'req-9');
    expect(claimCliRequest(SESSION_ID, 'req-9', 'groups-list').state).toBe('fresh');

    completeCliRequest(SESSION_ID, 'req-9', { id: 'req-9', ok: true, data: 'kept' });
    releaseCliRequest(SESSION_ID, 'req-9');
    expect(claimCliRequest(SESSION_ID, 'req-9', 'groups-list').state).toBe('done');
  });

  it('an unparseable stored frame reports ambiguity rather than re-running the command', () => {
    getDb()
      .prepare(`UPDATE cli_request_executions SET status = 'done', response = 'not json' WHERE request_id = 'req-9'`)
      .run();
    expect(claimCliRequest(SESSION_ID, 'req-9', 'groups-list').state).toBe('executing');
  });

  it('prune drops rows past the retry window and keeps fresh ones', () => {
    getDb()
      .prepare(`UPDATE cli_request_executions SET claimed_at = '2020-01-01T00:00:00.000Z' WHERE request_id = 'req-9'`)
      .run();
    claimCliRequest(SESSION_ID, 'req-10', 'groups-list');

    pruneCliRequestExecutions();

    const remaining = getDb().prepare('SELECT request_id FROM cli_request_executions').all() as Array<{
      request_id: string;
    }>;
    expect(remaining.map((r) => r.request_id)).toEqual(['req-10']);
  });
});
