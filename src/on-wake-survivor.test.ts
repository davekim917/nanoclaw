/**
 * Acceptance cases for the survivor `on_wake` reconciliation (seam 4 series F1,
 * docs/specs/upstream-restart-survival-seam/plan.md §7.F).
 *
 * `on_wake = 1` means "visible only on a container's FIRST poll". Before
 * adoption existed that was safe, because every container died with its host.
 * A container the host now ADOPTS is long past its first poll, so a row left at
 * `on_wake = 1` is unreachable forever: the runner adds `AND on_wake = 0` to
 * every selection query from poll 2 onward.
 *
 * The op therefore withdraws the one note whose text is false for a container
 * that was never stopped, and converts the rest to ordinary pending rows at the
 * front of the queue. The three DB-level cases run the REAL op against a real
 * SQLite handle; the two probe cases run through a REAL mailbox session on
 * disk, because the `claimed` probe and its fail-closed edge are wiring, not
 * op, behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('on-wake-survivor') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers at module scope, so importOriginal() would install them in this
// file's worker (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The memory-admission budget probe is a `docker info` round-trip at first use.
// Point the runtime binary at a name that does not exist so nothing in this
// file's import graph can reach a daemon; no case here spawns anything.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
}));

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { reconcileSurvivorWakeRows as reconcileSurvivorSession } from './container-runner.js';
import { getAgentMailbox } from './mailbox/index.js';
import { reconcileSurvivorWakeRows } from './modules/mailbox/ops/admission.js';
import { insertDeferredMessageWithContextIfNew, insertMessage } from './modules/mailbox/ops/ingress.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const AGENT_GROUP_ID = 'ag-on-wake-survivor';
const STAMP = '2026-09-05T00:00:00.000Z';

/** The inbound schema the host writes through, minimal but faithful. */
function makeInbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      scheduled_for TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0,
      repo_fence_epoch TEXT,
      repo_fence_original_trigger INTEGER
    );
  `);
  return db;
}

/** A bare first-poll wake row — what `groups restart --message` writes. */
function seedRestartMessage(db: Database.Database, id: string, text = 'restarting for a rebuild'): void {
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: STAMP,
    platformId: AGENT_GROUP_ID,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
}

/** The host-restart accountability note, pair and all. */
function seedHostRestartNote(db: Database.Database, id: string): void {
  insertDeferredMessageWithContextIfNew(db, {
    id,
    kind: 'chat',
    timestamp: STAMP,
    platformId: AGENT_GROUP_ID,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: '[system] The NanoClaw host restarted and stopped your container mid-work.',
      sender: 'system',
      senderId: 'system',
      _system: { kind: 'agent_host_restart', reason: 'test' },
    }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
  // `insertDeferredMessageWithContextIfNew` writes the pair inert; the sweep's
  // due admission is what makes it wakeable. Model the state the previous host
  // left behind: admitted, on_wake still set, never consumed.
  db.prepare('UPDATE messages_in SET trigger = 1 WHERE id = ?').run(id);
}

interface Row {
  id: string;
  seq: number;
  trigger: number;
  on_wake: number;
}

function rows(db: Database.Database): Row[] {
  return db.prepare('SELECT id, seq, trigger, on_wake FROM messages_in ORDER BY seq').all() as Row[];
}

function row(db: Database.Database, id: string): Row | undefined {
  return db.prepare('SELECT id, seq, trigger, on_wake FROM messages_in WHERE id = ?').get(id) as Row | undefined;
}

/**
 * The runner's post-first-poll selection, transcribed.
 *
 * `container/agent-runner/src/modules/mailbox/selection.ts` cannot be imported
 * here — it opens its handles through `bun:sqlite` — so its predicate is
 * reproduced: the same `status = 'pending'` / due / `AND on_wake = 0` filter
 * (added for every poll after the first), the same `ORDER BY seq DESC LIMIT n`
 * window, and the same recall-partner completion. `isFirstPoll = false` is the
 * whole point of the case: it is the poll a survivor is on.
 */
function getPendingMessages(db: Database.Database, isFirstPoll: boolean, limit = 5): string[] {
  const onWakeFilter = isFirstPoll ? '' : 'AND on_wake = 0';
  const recent = db
    .prepare(
      `SELECT id, seq FROM messages_in
        WHERE status = 'pending'
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          ${onWakeFilter}
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(limit * 4 + 8) as Array<{ id: string; seq: number }>;
  return recent.map((r) => r.id);
}

describe('reconcileSurvivorWakeRows — the op', () => {
  const nothingClaimed = (): boolean => false;

  it('an unconsumed restart-message row is converted and re-seqed to the front', () => {
    const db = makeInbound();
    seedRestartMessage(db, 'restart-1');
    // Ordinary chat that arrived AFTER the wake row, so the wake row is no
    // longer at the front of a `seq DESC` window.
    insertMessage(db, {
      id: 'chat-later',
      kind: 'chat',
      timestamp: STAMP,
      platformId: AGENT_GROUP_ID,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text: 'a later message', sender: 'system', senderId: 'system' }),
      processAfter: null,
      recurrence: null,
    });
    // Give the trigger a recall partner, the shape the pairing rule protects.
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger, on_wake)
       VALUES ('recall-restart-1', 100, 'system', ?, 'pending', ?, 0, 1)`,
    ).run(STAMP, JSON.stringify({ subtype: 'recall_context' }));

    const result = reconcileSurvivorWakeRows(db, nothingClaimed);

    expect(result).toEqual({ converted: 1, withdrawn: 0 });
    const trigger = row(db, 'restart-1')!;
    const recall = row(db, 'recall-restart-1')!;
    expect(trigger.on_wake).toBe(0);
    expect(recall.on_wake).toBe(0);
    expect(trigger.trigger).toBe(1);
    // The spacing `taskPairIsAdmitted` and the admission checker rely on.
    expect(recall.seq).toBe(trigger.seq - 2);
    // Re-seqed to the FRONT: a row left where it was can fall outside the
    // survivor's `ORDER BY seq DESC LIMIT n` window and never surface.
    expect(rows(db).at(-1)!.id).toBe('restart-1');
    db.close();
  });

  it('a host-restart accountability note is withdrawn, not converted', () => {
    const db = makeInbound();
    seedHostRestartNote(db, 'host-restart-42-abc');

    const result = reconcileSurvivorWakeRows(db, nothingClaimed);

    expect(result).toEqual({ converted: 0, withdrawn: 1 });
    // Both halves gone. Delivering this note to a container that was never
    // stopped would tell an agent mid-turn that its work was lost.
    expect(row(db, 'host-restart-42-abc')).toBeUndefined();
    expect(row(db, 'recall-host-restart-42-abc')).toBeUndefined();
    db.close();
  });

  it('a deferred pair the sweep already admitted is not touched twice', () => {
    const db = makeInbound();
    seedRestartMessage(db, 'already-admitted');
    // `admitDueRow` clears `on_wake` on BOTH halves when it makes a deferred
    // pair wakeable, so this is the steady state after a normal admission.
    db.prepare('UPDATE messages_in SET on_wake = 0').run();
    const before = rows(db);

    const result = reconcileSurvivorWakeRows(db, nothingClaimed);

    expect(result).toEqual({ converted: 0, withdrawn: 0 });
    expect(rows(db)).toEqual(before);
    db.close();
  });

  it('a converted row is selectable by a container past its first poll', () => {
    const db = makeInbound();
    seedRestartMessage(db, 'restart-selectable');
    // The case the whole series exists for: before the conversion the row is
    // invisible to every poll a survivor will ever make.
    expect(getPendingMessages(db, false)).not.toContain('restart-selectable');
    expect(getPendingMessages(db, true)).toContain('restart-selectable');

    reconcileSurvivorWakeRows(db, nothingClaimed);

    expect(getPendingMessages(db, false)).toContain('restart-selectable');
    db.close();
  });
});

describe('reconcileSurvivorWakeRows — the claimed probe', () => {
  const SESSION_ID = 'sess-on-wake-survivor';

  function sessionDir(sessionId: string): string {
    return path.join(TEST_DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, sessionId);
  }

  function prepareMailbox(sessionId: string): void {
    fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId });
  }

  function seedWakeRow(sessionId: string, id: string): void {
    const inbound = new Database(path.join(sessionDir(sessionId), 'inbound.db'));
    seedRestartMessage(inbound, id);
    inbound.close();
  }

  function inboundRow(sessionId: string, id: string): Row | undefined {
    const inbound = new Database(path.join(sessionDir(sessionId), 'inbound.db'), { readonly: true });
    try {
      return inbound.prepare('SELECT id, seq, trigger, on_wake FROM messages_in WHERE id = ?').get(id) as
        | Row
        | undefined;
    } finally {
      inbound.close();
    }
  }

  function reconcile(sessionId: string): Promise<{ converted: number; withdrawn: number } | undefined> {
    return withExistingMailboxSession(AGENT_GROUP_ID, sessionId, (mailbox) => mailbox.reconcileSurvivorWakeRows());
  }

  beforeEach(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.join(TEST_DATA_DIR, 'v2-sessions'), { recursive: true, force: true });
  });

  it('a row with a processing_ack in any status is left untouched', async () => {
    prepareMailbox(SESSION_ID);
    seedWakeRow(SESSION_ID, 'acked-row');
    // A survivor still on its FIRST poll when the host adopted it: it CAN have
    // taken this row, and the ack is the only evidence of that.
    const outbound = new Database(path.join(sessionDir(SESSION_ID), 'outbound.db'));
    outbound
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('acked-row', 'done', ?)")
      .run(STAMP);
    outbound.close();

    await expect(reconcile(SESSION_ID)).resolves.toEqual({ converted: 0, withdrawn: 0 });
    expect(inboundRow(SESSION_ID, 'acked-row')!.on_wake).toBe(1);
  });

  it('an unopenable outbound.db leaves every row untouched', async () => {
    prepareMailbox(SESSION_ID);
    seedWakeRow(SESSION_ID, 'unprovable-row');
    // Present but not a database: `sessionDbPathIsGone` is false, so the probe
    // reaches the opener and fails there. Consumption becomes unprovable, and
    // unprovable is fail-closed.
    fs.writeFileSync(path.join(sessionDir(SESSION_ID), 'outbound.db'), 'not a sqlite file at all');

    await expect(reconcile(SESSION_ID)).resolves.toEqual({ converted: 0, withdrawn: 0 });
    expect(inboundRow(SESSION_ID, 'unprovable-row')!.on_wake).toBe(1);
  });

  it('the reconciliation never runs against a session with no mailbox', async () => {
    const session = {
      id: 'sess-no-mailbox',
      agent_group_id: AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: STAMP,
    } as Session;

    // The host-side entry point, which is what `adoptRunningSessions` calls.
    await expect(reconcileSurvivorSession(session)).resolves.toEqual({ converted: 0, withdrawn: 0 });

    // Invariant I-10: the host never authors an `outbound.db`. A provisioning
    // opener here would have created the whole session directory.
    expect(fs.existsSync(sessionDir('sess-no-mailbox'))).toBe(false);
  });
});
