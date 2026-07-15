/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * Also contains C3 watchdog integration tests.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  SESSION_ARTIFACT_IDLE_MS,
  SPAWN_GRACE_MS,
  _notifyKillCeilingForTesting,
  _resetStuckProcessingRowsForTesting,
  _sweepTaskWatchdogForTesting,
  autoArchiveOldCompleted,
  decideStuckAction,
  parseSqliteUtc,
  pruneIdleSessionArtifacts,
  pruneIdleThreadArtifacts,
  pruneSteerIdempotency,
  shouldCloseTaskSession,
} from './host-sweep.js';
import { getDb } from './db/connection.js';
import type { Session } from './types.js';

// ─── Module mocks for C3 watchdog integration tests ──────────────────────────
// These mocks are hoisted and only affect tests that use them. The existing
// decideStuckAction / resetStuckProcessingRows tests are pure and don't invoke
// these imports, so they are unaffected.

const mockGetActiveTasks = vi.fn();
const mockTransitionToTerminal = vi.fn();
const mockGetCapabilityConfig = vi.fn();
const mockPendingTerminalDispatchOutboundSeenAt = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockHasContainerEverRun = vi.fn();
const mockGetSession = vi.fn();
const mockRunReconcilerSweep = vi.fn();

vi.mock('./modules/orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: (...args: unknown[]) => mockGetActiveTasks(...args),
    transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
    getOrphanedTasks: vi.fn().mockReturnValue([]),
  };
});

vi.mock('./modules/orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: (...args: unknown[]) => mockGetCapabilityConfig(...args),
}));

vi.mock('./modules/orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalSpawnOutboundSeenAt: (...args: unknown[]) => mockPendingTerminalDispatchOutboundSeenAt(...args),
  };
});

vi.mock('./session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
    outboundDbPath: real.outboundDbPath,
  };
});

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    hasContainerEverRun: (...args: unknown[]) => mockHasContainerEverRun(...args),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  };
});

vi.mock('./db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/sessions.js')>();
  return {
    ...real,
    getSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

vi.mock('./modules/orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => mockRunReconcilerSweep(),
  runReconcilerOnStartup: vi.fn(),
}));

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('extends the ceiling while a native Codex item is in flight', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // Native Codex subagents can legitimately run past the default
      // 30-minute ceiling without emitting app-server notifications.
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-codex', 45 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('keeps the native Codex extension bounded by its declared timeout', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - oneHrMs - 1,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - oneHrMs - 1).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance while a native Codex item is in flight', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 6 * 60 * 1000,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-codex', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill a fresh container for a claim made before it spawned', () => {
    // Pre-existing claim from a long-dead prior container; new one just
    // spawned and hasn't reached its agent-runner startup cleanup hook
    // yet. Without the grace window, every recovery attempt would be
    // killed within ms of spawn — the deadlock that stranded the
    // plugin-updater session for 4 days post-cutover.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // fresh container, no heartbeat yet
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - 10_000, // spawned 10s ago, well within grace
    });
    expect(res.action).toBe('ok');
  });

  it('still kills for a fresh-container claim that aged past tolerance during the grace window', () => {
    // Claim was made AFTER spawn (so it's the current container's own work)
    // and has aged past tolerance with no heartbeat. The grace window only
    // covers pre-existing claims, not new ones produced by the live
    // container — those still need to be enforced normally.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const spawnedAtMs = BASE - claimedAgeMs - 1_000; // spawn predates the claim
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
      spawnedAtMs,
    });
    expect(res.action).toBe('kill-claim');
  });

  it('kills for a pre-existing claim once the grace window has elapsed', () => {
    // Container spawned > SPAWN_GRACE_MS ago and the stale claim is still
    // there — startup cleanup either failed to run or didn't cover this
    // row. After the grace window, the kill path runs as before so a
    // permanently-broken container can't camp on a session forever.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000,
    });
    expect(res.action).toBe('kill-claim');
  });

  it('does not kill-ceiling when stale heartbeat predates spawn and we are in grace', () => {
    // Heartbeat on disk is from a long-dead prior container instance; the
    // fresh container has only been alive for 10s and hasn't touched the
    // heartbeat file yet. Without this protection, a host restart would
    // SIGKILL every freshly-spawned container whose previous heartbeat was
    // already past the ceiling — the exact respawn loop seen in the
    // 2026-05-15 incident.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS, // 1h stale
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 10_000, // 10s ago
    });
    expect(res.action).toBe('ok');
  });

  it('does kill-ceiling once spawn-grace has elapsed without a fresh heartbeat', () => {
    // Container has been alive long enough that the agent-runner should
    // have written its first heartbeat. Still seeing prior-container's
    // stale mtime → kill is the right call (the new container is wedged).
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS,
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000, // past grace
    });
    expect(res.action).toBe('kill-ceiling');
  });

  it('does kill-ceiling when heartbeat predates spawn but ages past ceiling AFTER spawn', () => {
    // Pathological: heartbeat is newer than spawn (so it's the current
    // container's own write), but it's still > 30 min old. That means the
    // current container has gone genuinely silent for the full ceiling
    // window — kill is correct.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 35 * 60 * 1000, // 35 min ago
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 40 * 60 * 1000, // spawned before the heartbeat
    });
    expect(res.action).toBe('kill-ceiling');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });

  it('retries an input that produced only progress/status rows', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-status-only', 3, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-status-only', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('progress-1', 2, 'm-status-only', ?, 'status', '{}')",
      )
      .run(new Date().toISOString());

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    const row = inDb
      .prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?')
      .get('m-status-only') as { status: string; tries: number; process_after: string | null };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('does not retry an input after a non-status response was written', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-answered', 4, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-answered', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('reply-1', 4, 'm-answered', ?, 'chat', '{}')",
      )
      .run(new Date().toISOString());

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-answered') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('completed');
    expect(row.tries).toBe(0);
    expect(row.process_after).toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: Task watchdog integration tests
//
// Tests the sweepTaskWatchdog() pass that runs after the per-session sweep loop.
// Uses vi.mock (hoisted at top of file) to intercept DB and container calls.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-04-20T12:00:00.000Z');

function makeTask(
  overrides: Partial<{
    task_id: string;
    parent_session_id: string;
    parent_agent_group_id: string;
    child_session_id: string | null;
    status: 'pending' | 'running';
    admitted_at: string;
    started_at: string | null;
    last_progress_at: string | null;
    deadline: string | null;
  }> = {},
) {
  return {
    task_id: 'task-watchdog-1',
    idempotency_key: 'idem-w1',
    parent_session_id: 'parent-sess',
    parent_agent_group_id: 'parent-ag',
    parent_messaging_group_id: null,
    child_session_id: 'child-sess',
    status: 'running' as const,
    task_content: '{}',
    request_hash: 'hash',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    started_at: new Date(NOW - 9 * 60 * 1000).toISOString(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless' as const,
    created_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function fakeParentSession() {
  return {
    id: 'parent-sess',
    agent_group_id: 'parent-ag',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'running' as const,
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('sweepTaskWatchdog (C3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue(fakeParentSession());
    mockIsContainerRunning.mockReturnValue(true);
    // Default: container has been observed running. Individual tests that
    // need the "never started yet" case override per-call.
    mockHasContainerEverRun.mockReturnValue(true);
    mockWakeContainer.mockResolvedValue(true);
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockGetCapabilityConfig.mockReturnValue(null); // use defaults
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_watchdog_terminates_no_progress_task: reaped task gets failed + parent notified', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago — past 30 min default
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
    // Watchdog now writes kind='chat' so the orchestrator surfaces the
    // failure to the user via a normal turn input (the prior `kind='system'`
    // envelope had no consumer and sat silently in the inbound).
    expect(mockWriteSessionMessage).toHaveBeenCalledWith(
      task.parent_agent_group_id,
      task.parent_session_id,
      expect.objectContaining({ kind: 'chat' }),
    );
    const writeCallArgs = mockWriteSessionMessage.mock.calls[0]?.[2];
    const parsed = writeCallArgs ? JSON.parse(writeCallArgs.content) : {};
    expect(parsed.text).toContain('Task failed (watchdog)');
    expect(parsed.text).toContain('no_progress_timeout');
    expect(parsed._task_update).toMatchObject({
      task_id: task.task_id,
      status: 'failed',
      fail_reason: 'no_progress_timeout',
      source: 'watchdog',
    });
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  it('test_watchdog_skips_when_drain_active: task with recent terminal outbound is not reaped', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    // Drain guard: terminal action seen 30s ago, within 120s grace
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(new Date(NOW - 30 * 1000).toISOString());
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('CAS guard: 0-rows transitionToTerminal skips parent notification', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(false); // CAS failed — already terminal

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('test_one_task_failure_doesnt_skip_others: error in one task does not prevent processing others', async () => {
    // Both tasks have stale progress — both should trigger transitionToTerminal.
    // The first call throws (simulates a corrupt task failing mid-reap).
    const badTask = makeTask({
      task_id: 'bad-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — triggers reap
    });
    const goodTask = makeTask({
      task_id: 'good-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — should also be reaped
    });
    mockGetActiveTasks.mockReturnValue([badTask, goodTask]);
    // First call (bad task) — throws to simulate a corrupt/unrecoverable failure mid-loop
    // Second call (good task) — returns true
    mockTransitionToTerminal
      .mockImplementationOnce(() => {
        throw new Error('synthetic failure');
      })
      .mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    // Both tasks were attempted — try/catch isolation ensures good task ran
    expect(mockTransitionToTerminal).toHaveBeenCalledTimes(2);
    // Only good task (second call) succeeded, so only one parent notification
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('uses per-orchestrator config when available', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago
    });
    // Custom timeout of 60 min — 35 min is within timeout, so no reap
    mockGetCapabilityConfig.mockReturnValue({
      noProgressTimeoutSec: 3600,
      spawnDeadlineSec: 600,
      drainGraceSec: 180,
      concurrencyCap: 5,
    });
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
  });

  it('falls back to default timeouts when capability config is absent', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago — past 30 min default
    });
    mockGetCapabilityConfig.mockReturnValue(null); // no config
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    // Default 1800s = 30 min; 35 min ago should trigger no-progress reap
    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
  });

  // test_watchdog_fail_reason_canonical: all 4 watchdog actions produce canonical fail_reason values
  it.each([
    {
      label: 'no-progress → no_progress_timeout',
      taskOverrides: { last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
      expectedFailReason: 'no_progress_timeout',
    },
    {
      label: 'deadline → deadline_exceeded',
      taskOverrides: {
        deadline: new Date(NOW - 60 * 60 * 1000).toISOString(),
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
      },
      expectedFailReason: 'deadline_exceeded',
    },
    {
      label: 'spawn-deadline → spawn_deadline',
      taskOverrides: {
        status: 'pending' as const,
        started_at: null,
        last_progress_at: null,
        admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10 min > 5 min spawn deadline
      },
      expectedFailReason: 'spawn_deadline',
    },
    {
      label: 'container-exit → container_exit',
      taskOverrides: {
        child_session_id: 'child-sess',
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(), // recent progress
      },
      expectedFailReason: 'container_exit',
      childContainerStopped: true,
    },
  ])(
    'test_watchdog_fail_reason_canonical: $label',
    async ({ taskOverrides, expectedFailReason, childContainerStopped }) => {
      const task = makeTask(taskOverrides);
      mockGetActiveTasks.mockReturnValue([task]);
      mockTransitionToTerminal.mockReturnValue(true);
      if (childContainerStopped) {
        mockIsContainerRunning.mockReturnValue(false);
        // Sticky bit: container WAS observed running, now stopped — the
        // case `fail-container-exit` is designed for. Without this the
        // bug-fix logic treats the child as "never started" and returns ok.
        mockHasContainerEverRun.mockReturnValue(true);
      }

      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      await _sweepTaskWatchdogForTesting();

      expect(mockTransitionToTerminal).toHaveBeenCalledWith(
        task.task_id,
        'failed',
        expect.objectContaining({ fail_reason: expectedFailReason }),
      );
    },
  );

  it('test_watchdog_does_not_reap_container_exit_before_container_ever_started', async () => {
    // Regression: under concurrency cap the 4th-of-4 spawned child created
    // its session row immediately but waited 78s for an actual container.
    // The watchdog ran during the gap, saw `isContainerRunning(child) === false`,
    // and reaped as `fail-container-exit` — terminally failing a task before
    // it had a chance to start. Observed against the spawn-board build for
    // task spawn-80a5ba9b2f8b532b at 01:53:10 UTC on 2026-05-11; the
    // container then actually spawned, the child completed the work, and
    // its `spawn_complete` was discarded because the task was already
    // terminal.
    //
    // Correct behavior: when the container has never been observed running,
    // `childContainerStatus` is null, not 'stopped', and the watchdog must
    // not reap as container_exit. (Other reapers — no_progress_timeout,
    // spawn_deadline — still cover legitimate stuck-spawn failure modes.)
    const task = makeTask({
      child_session_id: 'child-sess-queued',
      last_progress_at: new Date(NOW - 30 * 1000).toISOString(), // 30s old, well within timeout
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockIsContainerRunning.mockReturnValue(false);
    mockHasContainerEverRun.mockReturnValue(false); // critical: never started

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'container_exit' }),
    );
  });
});

// ── D7: pruneSteerIdempotency ─────────────────────────────────────────────────

describe('pruneSteerIdempotency — D7', () => {
  beforeEach(() => {
    const db = initTestDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Seed a user required by FK
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES ('u1', 'test', NULL, datetime('now'))",
      )
      .run();
  });

  afterEach(() => {
    closeDb();
  });

  it('test_prune_removes_old_applied', () => {
    // applied row 2 min ago — should be deleted
    getDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted, applied_at)
       VALUES ('u1', 'key-old', 'task', 'task-1', 'msg-1', 'hi', 'h1', datetime('now', '-3 minutes'), 'applied', 1, datetime('now', '-2 minutes'))`,
      )
      .run();
    // applied row 30 sec ago — should remain
    getDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted, applied_at)
       VALUES ('u1', 'key-fresh', 'task', 'task-1', 'msg-2', 'hi', 'h2', datetime('now', '-31 seconds'), 'applied', 1, datetime('now', '-30 seconds'))`,
      )
      .run();

    pruneSteerIdempotency();

    const rows = getDb().prepare("SELECT idempotency_key FROM steer_idempotency WHERE status = 'applied'").all() as {
      idempotency_key: string;
    }[];
    expect(rows.map((r) => r.idempotency_key)).not.toContain('key-old');
    expect(rows.map((r) => r.idempotency_key)).toContain('key-fresh');
  });

  it('test_prune_removes_old_pending', () => {
    getDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
       VALUES ('u1', 'pend-old', 'task', 'task-2', 'msg-3', 'hi', 'h3', datetime('now', '-10 minutes'), 'pending', 0)`,
      )
      .run();

    pruneSteerIdempotency();

    const rows = getDb().prepare("SELECT idempotency_key FROM steer_idempotency WHERE status = 'pending'").all();
    expect(rows.length).toBe(0);
  });

  it('test_prune_preserves_recent_pending', () => {
    getDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
       VALUES ('u1', 'pend-new', 'task', 'task-3', 'msg-4', 'hi', 'h4', datetime('now', '-1 minute'), 'pending', 0)`,
      )
      .run();

    pruneSteerIdempotency();

    const rows = getDb()
      .prepare("SELECT idempotency_key FROM steer_idempotency WHERE idempotency_key = 'pend-new'")
      .all();
    expect(rows.length).toBe(1);
  });

  it('test_sweep_calls_prune: pruneSteerIdempotency is exported and callable', () => {
    // Verify the function is exported and can be called without error on an empty table
    expect(() => pruneSteerIdempotency()).not.toThrow();
  });
});

describe('autoArchiveOldCompleted', () => {
  beforeEach(() => {
    const db = initTestDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Seed agent_group + session so task FKs hold
    getDb()
      .prepare(
        "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'ag-1', 'ag-1', NULL, datetime('now'))",
      )
      .run();
    getDb()
      .prepare("INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('sess-1', 'ag-1', datetime('now'))")
      .run();
  });
  afterEach(() => {
    closeDb();
  });

  function insertCompletedTask(taskId: string, completedAt: string): void {
    getDb()
      .prepare(
        `INSERT INTO tasks (
          task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          status, task_content, request_hash, admitted_at, completed_at,
          dispatch_completion_attempts, surface_mode, needs_input, created_at
        ) VALUES (?, ?, 'sess-1', 'ag-1', 'completed', '{}', 'h', ?, ?, 0, 'headless', 0, ?)`,
      )
      .run(taskId, taskId, completedAt, completedAt, completedAt);
  }

  it('archives completed tasks older than 24 hours', () => {
    insertCompletedTask('old', new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    insertCompletedTask('fresh', new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString());

    autoArchiveOldCompleted();

    const rows = getDb().prepare('SELECT task_id, archived_at FROM tasks ORDER BY task_id').all() as Array<{
      task_id: string;
      archived_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r.archived_at]));
    expect(byId['old']).not.toBeNull();
    expect(byId['fresh']).toBeNull();
  });

  it('does not re-archive already-archived rows', () => {
    const original = '2026-05-01T00:00:00.000Z';
    insertCompletedTask('t1', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    getDb().prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = 't1'`).run(original);

    autoArchiveOldCompleted();

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as { archived_at: string };
    expect(row.archived_at).toBe(original);
  });

  it('leaves failed tasks alone regardless of age', () => {
    getDb()
      .prepare(
        `INSERT INTO tasks (
          task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          status, task_content, request_hash, admitted_at, failed_at,
          dispatch_completion_attempts, surface_mode, needs_input, created_at
        ) VALUES ('f1', 'f1', 'sess-1', 'ag-1', 'failed', '{}', 'h', ?, ?, 0, 'headless', 0, ?)`,
      )
      .run(
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
      );

    autoArchiveOldCompleted();

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('f1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });
});

describe('pruneIdleSessionArtifacts', () => {
  let tmpRoot: string;
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    mockIsContainerRunning.mockReset();
    mockIsContainerRunning.mockReturnValue(false);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-prune-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSession(opts: {
    group: string;
    sess: string;
    dbAgeMs: number;
    withNodeModules?: boolean;
    withPnpmStore?: boolean;
    nodeModulesInWorktree?: boolean;
  }): string {
    const dir = path.join(tmpRoot, opts.group, opts.sess);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'inbound.db');
    const db = new Database(dbPath);
    db.exec("CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed')");
    db.close();
    const mtime = (Date.now() - opts.dbAgeMs) / 1000;
    fs.utimesSync(dbPath, mtime, mtime);
    if (opts.withNodeModules) {
      const nm = path.join(dir, 'node_modules');
      fs.mkdirSync(nm);
      fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
    }
    if (opts.withPnpmStore) {
      const ps = path.join(dir, '.pnpm-store');
      fs.mkdirSync(ps);
      fs.writeFileSync(path.join(ps, 'index.db'), 'x');
    }
    if (opts.nodeModulesInWorktree) {
      const nested = path.join(dir, 'worktrees', 'repo', 'node_modules');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'pkg.json'), '{}');
    }
    return dir;
  }

  it('removes node_modules and .pnpm-store from idle sessions', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-old',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withNodeModules: true,
      withPnpmStore: true,
      nodeModulesInWorktree: true,
    });

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.pnpm-store'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'worktrees', 'repo', 'node_modules'))).toBe(false);
    // Session dir and DB file untouched
    expect(fs.existsSync(path.join(dir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'worktrees', 'repo'))).toBe(true);
  });

  it('leaves recently-active sessions alone', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-fresh',
      dbAgeMs: HOUR, // 1 hour < 24 hour default
      withNodeModules: true,
    });

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });

  it('skips sessions whose container is currently running', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-running',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withNodeModules: true,
    });
    mockIsContainerRunning.mockImplementation((sid: string) => sid === 'sess-running');

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });

  it('ignores non-sess dirs (e.g. .claude-shared, .claude-memory)', () => {
    const sharedDir = path.join(tmpRoot, 'ag-1', '.claude-shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    const nmInShared = path.join(sharedDir, 'node_modules');
    fs.mkdirSync(nmInShared);
    fs.writeFileSync(path.join(nmInShared, 'pkg.json'), '{}');

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(nmInShared)).toBe(true);
  });

  it('does not follow symlinks out of the session subtree', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-symlink',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-store-'));
    const outsideNm = path.join(outside, 'node_modules');
    fs.mkdirSync(outsideNm);
    fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
    try {
      fs.symlinkSync(outside, path.join(dir, 'shared-link'));

      pruneIdleSessionArtifacts(Date.now(), tmpRoot);

      expect(fs.existsSync(outsideNm)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('no-ops on a non-existent sessions root', () => {
    expect(() => pruneIdleSessionArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'))).not.toThrow();
  });
});

describe('pruneIdleThreadArtifacts', () => {
  let tmpRoot: string;
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-thread-prune-'));
    mockIsContainerRunning.mockReset();
    mockIsContainerRunning.mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeThread(opts: {
    key: string;
    activityAgeMs: number;
    withPnpmStore?: boolean;
    withNodeModules?: boolean;
  }): { worktreeDir: string; repoDir: string } {
    const worktreeDir = path.join(tmpRoot, opts.key, 'worktrees');
    const repoDir = path.join(worktreeDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    if (opts.withPnpmStore) {
      const store = path.join(worktreeDir, '.pnpm-store');
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'index.db'), 'x');
    }
    if (opts.withNodeModules) {
      const nm = path.join(repoDir, 'node_modules');
      fs.mkdirSync(nm, { recursive: true });
      fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
    }
    const mtime = (Date.now() - opts.activityAgeMs) / 1000;
    fs.utimesSync(worktreeDir, mtime, mtime);
    return { worktreeDir, repoDir };
  }

  it('removes package caches from idle thread worktrees but preserves repos', () => {
    const { worktreeDir, repoDir } = makeThread({
      key: 'thread-old',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
      withNodeModules: true,
    });

    pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(repoDir)).toBe(true);
  });

  it('leaves recently active thread worktrees alone', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-fresh',
      activityAgeMs: HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('uses session activity when supplied instead of stale filesystem mtime', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-db-active',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(
      Date.now(),
      tmpRoot,
      new Map([
        [worktreeDir, { lastActivityMs: Date.now() - HOUR, hasRunningContainer: false, hasBusySession: false }],
      ]),
    );

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('skips thread worktrees with a running container', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-running',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(
      Date.now(),
      tmpRoot,
      new Map([
        [
          worktreeDir,
          {
            lastActivityMs: Date.now() - SESSION_ARTIFACT_IDLE_MS - HOUR,
            hasRunningContainer: true,
            hasBusySession: false,
          },
        ],
      ]),
    );

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('does not follow symlinks out of the thread worktree subtree', () => {
    const { repoDir } = makeThread({
      key: 'thread-symlink',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-thread-store-'));
    const outsideNm = path.join(outside, 'node_modules');
    fs.mkdirSync(outsideNm);
    fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
    try {
      fs.symlinkSync(outside, path.join(repoDir, 'shared-link'));

      pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

      expect(fs.existsSync(outsideNm)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('no-ops on a non-existent thread root', () => {
    expect(() => pruneIdleThreadArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'), new Map())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// kill-ceiling notify (Layer-3 fix)
//
// Background: host-sweep used to silently reap a stale-heartbeat container
// after ABSOLUTE_CEILING_MS (30 min). Users waiting on a wedged agent saw
// nothing for the entire window, then the container came back as if
// nothing happened. `notifyKillCeiling` writes a chat outbound on the
// session's primary route before kill, so the user gets a "resend please"
// signal within a sweep tick of the heartbeat going stale.
// ─────────────────────────────────────────────────────────────────────────────

function makeNotifyTestDbs(opts?: { withRouting?: boolean; recentNotice?: boolean }): {
  inDb: Database.Database;
  outDb: Database.Database;
} {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE session_routing (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type  TEXT,
      platform_id   TEXT,
      thread_id     TEXT,
      spawn_task_id TEXT,
      session_id    TEXT
    );
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  if (opts?.withRouting !== false) {
    inDb
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, 'slack', 'C-TEST', 'T-TEST')`,
      )
      .run();
  }
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE messages_out (
      id           TEXT PRIMARY KEY,
      seq          INTEGER UNIQUE,
      in_reply_to  TEXT,
      timestamp    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      platform_id  TEXT,
      channel_type TEXT,
      thread_id    TEXT,
      content      TEXT NOT NULL
    );
  `);
  if (opts?.recentNotice) {
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content)
         VALUES ('prior', 1, datetime('now'), 'chat', '{"_system":{"kind":"agent_restart_inactivity"}}')`,
      )
      .run();
  }
  return { inDb, outDb };
}

describe('notifyKillCeiling (Layer-3 fix)', () => {
  // `pendingClaims=1` means the container had an in-flight inbound when we
  // killed it — i.e. a user was actually waiting. That's the only case
  // where the notify should fire (see the spam-gate test below for the
  // claims=0 case).
  it('writes a visible chat outbound with the session route before killContainer', () => {
    const { inDb, outDb } = makeNotifyTestDbs();
    const heartbeatAgeMs = 32 * 60_000;

    _notifyKillCeilingForTesting(inDb, outDb, fakeSession(), heartbeatAgeMs, 1);

    const rows = outDb
      .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_out')
      .all() as Array<{
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].channel_type).toBe('slack');
    expect(rows[0].platform_id).toBe('C-TEST');
    expect(rows[0].thread_id).toBe('T-TEST');
    const body = JSON.parse(rows[0].content) as { text: string; _system?: { kind: string } };
    expect(body.text).toContain('32 minutes');
    expect(body.text).toContain('picked up automatically');
    expect(body.text).toContain('no need to resend');
    expect(body._system?.kind).toBe('agent_restart_inactivity');
  });

  it('reports a persisted Codex control-plane failure instead of calling it generic silence', () => {
    const { inDb, outDb } = makeNotifyTestDbs();
    _notifyKillCeilingForTesting(inDb, outDb, fakeSession(), 62 * 60_000, 1, {
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: 3_600_000,
      tool_started_at: '2026-07-15T11:22:53.000Z',
      provider_status: 'failed',
      provider_failure_reason: 'three JSON-RPC health probes timed out',
    });

    const row = outDb.prepare('SELECT content FROM messages_out').get() as { content: string };
    const body = JSON.parse(row.content) as {
      text: string;
      _system: { provider_status: string; provider_failure_reason: string };
    };
    expect(body.text).toContain('Codex control-plane recovery did not complete');
    expect(body.text).toContain('three JSON-RPC health probes timed out');
    expect(body.text).not.toContain('went silent');
    expect(body._system.provider_status).toBe('failed');
  });

  it('skips when no inbound was claimed at kill time (idle session, no user waiting)', () => {
    // The kill-ceiling sweep fires on every container that hits the 30-min
    // idle ceiling, not just ones with users waiting on a reply. Without
    // this gate, every quiet operator gets a restart notice every half
    // hour across every wired session. Routing is present (session DID
    // wake before) — the only thing that distinguishes "user waiting" from
    // "idle" is whether any inbound was claimed (processing_ack) when we
    // killed.
    const { inDb, outDb } = makeNotifyTestDbs();
    _notifyKillCeilingForTesting(inDb, outDb, fakeSession(), 32 * 60_000, 0);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('skips when the session has never been routed (fresh session_routing row missing)', () => {
    const { inDb, outDb } = makeNotifyTestDbs({ withRouting: false });
    _notifyKillCeilingForTesting(inDb, outDb, fakeSession(), 32 * 60_000, 1);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('is idempotent within 60s — a re-firing sweep tick does not duplicate the notice', () => {
    const { inDb, outDb } = makeNotifyTestDbs({ recentNotice: true });
    _notifyKillCeilingForTesting(inDb, outDb, fakeSession(), 32 * 60_000, 1);
    // Only the seed row should be present; the second call recognized the
    // marker and skipped.
    const rows = outDb.prepare('SELECT id FROM messages_out').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('prior');
  });
});

// ─── D3: move-intent recovery + D4: audit body prune ──────────────────────────
// Self-contained: these helpers take an explicit central-DB handle + options,
// so they don't rely on the file-level getDb/session-manager mocks above.
describe('recoverMoveIntents (D3) + pruneAuditBodies (D4)', () => {
  // Lazy import inside the describe so the helpers resolve against the real
  // host-sweep module (already imported at top).
  let recoverMoveIntents: typeof import('./host-sweep.js').recoverMoveIntents;
  let pruneAuditBodies: typeof import('./host-sweep.js').pruneAuditBodies;
  let migration043: typeof import('./db/migrations/043-scheduled-audit.js').migration043;
  let ensureSchema: typeof import('./db/session-db.js').ensureSchema;
  let openInboundDb: typeof import('./db/session-db.js').openInboundDb;

  // Unique per-file temp root (mkdtempSync) so parallel vitest workers never
  // share a fixed path and clobber each other's rmSync.
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-d3d4-test-'));
  const NOW = Date.parse('2026-06-13T12:00:00Z');
  const SWEEP_MS = 60_000;

  beforeEach(async () => {
    ({ recoverMoveIntents, pruneAuditBodies } = await import('./host-sweep.js'));
    ({ migration043 } = await import('./db/migrations/043-scheduled-audit.js'));
    ({ ensureSchema, openInboundDb } = await import('./db/session-db.js'));
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
  });

  function centralDb(): Database.Database {
    const db = new Database(':memory:');
    migration043.up(db);
    // Recovery resolves the target channel-root session id from `sessions`
    // (M1 scoped count); provide the table so the lookup is exercised, not a
    // missing-table fallback.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
        thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    return db;
  }

  function addTargetSession(db: Database.Database, id: string, ag: string, mg: string): void {
    db.prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status) VALUES (?, ?, ?, NULL, 'active')",
    ).run(id, ag, mg);
  }

  function seedInbound(agentGroupId: string, sessionId: string): string {
    const dir = path.join(DIR, 'v2-sessions', agentGroupId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'inbound.db');
    ensureSchema(p, 'inbound');
    return p;
  }

  function insertLive(inboundPath: string, seriesId: string): void {
    const db = openInboundDb(inboundPath);
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
       VALUES (?, ?, 'task', datetime('now'), 'pending', ?, '0 9 * * *', ?, '{}')`,
    ).run(`live-${seriesId}`, seq, new Date(NOW + 3600_000).toISOString(), seriesId);
    db.close();
  }

  function writeIntent(
    db: Database.Database,
    opts: {
      seriesId: string;
      ag: string;
      sess: string;
      tsMs: number;
      snapshot?: object | null;
      noSnapshot?: boolean;
      targetAgentGroupId?: string;
      targetMessagingGroupId?: string;
    },
  ): void {
    const snapshot = opts.snapshot ?? {
      id: `orig-${opts.seriesId}`,
      series_id: opts.seriesId,
      status: 'pending',
      process_after: new Date(NOW + 3600_000).toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
      platform_id: 'p:1',
      channel_type: 'discord',
      thread_id: null,
      kind: 'task',
    };
    const detail: Record<string, unknown> = opts.noSnapshot ? {} : { snapshot };
    if (opts.targetAgentGroupId) detail.targetAgentGroupId = opts.targetAgentGroupId;
    if (opts.targetMessagingGroupId) detail.targetMessagingGroupId = opts.targetMessagingGroupId;
    db.prepare(
      `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, detail_json, correlation_id)
       VALUES (?, 'owner', 'move_intent', ?, ?, ?, ?, ?)`,
    ).run(
      new Date(opts.tsMs).toISOString(),
      opts.ag,
      opts.sess,
      opts.seriesId,
      opts.noSnapshot ? null : JSON.stringify(detail),
      `corr-${opts.seriesId}`,
    );
  }

  it('test_recover_stamps_when_live_row_exists', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess');
    insertLive(inbound, 'ser-1'); // a live row exists for the series
    writeIntent(db, { seriesId: 'ser-1', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-1'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // stamped
    expect(row.detail_json).toBeNull(); // body purged
    // No restore performed — the existing live row is the only one.
    const live = openInboundDb(inbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-1' AND status='pending'")
      .get() as { c: number };
    expect(live.c).toBe(1);
    db.close();
  });

  it('test_recover_restores_when_zero_live_rows', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess'); // empty — simulates crash post-cancel
    writeIntent(db, { seriesId: 'ser-2', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // restoreTaskRow inserted a live row from the snapshot.
    const live = openInboundDb(inbound)
      .prepare(
        "SELECT series_id, status, recurrence FROM messages_in WHERE series_id='ser-2' AND status IN ('pending','paused')",
      )
      .all() as Array<{ series_id: string; status: string; recurrence: string | null }>;
    expect(live).toHaveLength(1);
    expect(live[0].recurrence).toBe('0 9 * * *');
    const row = db
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-2'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy();
    expect(row.detail_json).toBeNull(); // body purged
    db.close();
  });

  it('test_recover_idempotent_no_double_restore', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess');
    writeIntent(db, { seriesId: 'ser-3', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW }); // first pass restores
    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW }); // second pass must be a no-op

    const live = openInboundDb(inbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-3' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(live.c).toBe(1); // exactly one — no double restore
    db.close();
  });

  it('does not recover an intent younger than one sweep interval', () => {
    const db = centralDb();
    seedInbound('src-ag', 'src-sess');
    writeIntent(db, { seriesId: 'ser-4', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 5_000 }); // 5s old

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-4'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeNull(); // too young — left alone
    db.close();
  });

  // ── M1: scoped {source,target} count — an UNRELATED group's same series_id ─────
  // must NOT cause a false resolve. The crashed source still gets restored.
  it('test_recover_scoped_count_ignores_unrelated_group', () => {
    const db = centralDb();
    // Source session is EMPTY (crashed post-cancel, before the target insert).
    const srcInbound = seedInbound('src-ag', 'src-sess');
    // Target session exists but has NO live row (insert never landed).
    seedInbound('tgt-ag', 'tgt-sess');
    addTargetSession(db, 'tgt-sess', 'tgt-ag', 'tgt-mg');
    // An UNRELATED group has a live row reusing the SAME series_id — the exact
    // condition the bare-series_id fleet scan over-counted (M1 false-resolve).
    const unrelated = seedInbound('other-ag', 'other-sess');
    insertLive(unrelated, 'ser-scoped');

    writeIntent(db, {
      seriesId: 'ser-scoped',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      targetAgentGroupId: 'tgt-ag',
      targetMessagingGroupId: 'tgt-mg',
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // The scoped {source,target} count is 0 → the crashed source IS restored,
    // the unrelated group's row is ignored.
    const restored = openInboundDb(srcInbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-scoped' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(restored.c).toBe(1);
    const row = db
      .prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-scoped'")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // resolved after restore
    db.close();
  });

  it('test_recover_scoped_count_stamps_when_target_has_live_row', () => {
    // The move SUCCEEDED (target has the live row) but the intent was never
    // stamped (crash after insert). Scoped count sees the target row → stamp, do
    // NOT restore the source (would double the live rows).
    const db = centralDb();
    const srcInbound = seedInbound('src-ag', 'src-sess'); // empty source
    const tgtInbound = seedInbound('tgt-ag', 'tgt-sess');
    addTargetSession(db, 'tgt-sess', 'tgt-ag', 'tgt-mg');
    insertLive(tgtInbound, 'ser-tgt'); // target carries the live row

    writeIntent(db, {
      seriesId: 'ser-tgt',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      targetAgentGroupId: 'tgt-ag',
      targetMessagingGroupId: 'tgt-mg',
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // Source NOT restored (the target's live row is the one live row).
    const srcCount = openInboundDb(srcInbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-tgt' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(srcCount.c).toBe(0);
    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-tgt'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeTruthy();
    db.close();
  });

  // ── ADV-S2: a dangling unrecoverable intent must resolve (no permanent zombie) ─
  it('test_recover_no_snapshot_resolves_intent', () => {
    const db = centralDb();
    seedInbound('src-ag', 'src-sess');
    // Intent with NO snapshot body (purged-but-still-unresolved) → unrecoverable,
    // but it must NOT surface forever as a repair row: stamp resolved_at.
    writeIntent(db, {
      seriesId: 'ser-nosnap',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      noSnapshot: true,
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db
      .prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-nosnap'")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // resolved — no permanent zombie
    db.close();
  });

  it('test_recover_source_dir_missing_resolves_intent', () => {
    const db = centralDb();
    // No source inbound.db on disk at all → cannot restore, but must resolve so
    // it does not surface as an unclearable stalled repair row forever.
    writeIntent(db, {
      seriesId: 'ser-nodir',
      ag: 'gone-ag',
      sess: 'gone-sess',
      tsMs: NOW - 2 * SWEEP_MS,
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-nodir'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeTruthy(); // resolved — no permanent zombie
    db.close();
  });

  // ── D4 ──
  function insertAudit(db: Database.Database, opts: { action: string; tsMs: number; bodies?: boolean }): number {
    const r = db
      .prepare(
        `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, before_preview, after_preview, detail_json)
       VALUES (?, 'owner', ?, 'ag', 'sess', 'ser', ?, ?, ?)`,
      )
      .run(
        new Date(opts.tsMs).toISOString(),
        opts.action,
        opts.bodies === false ? null : 'before body',
        opts.bodies === false ? null : 'after body',
        opts.bodies === false ? null : '{"x":1}',
      );
    return Number(r.lastInsertRowid);
  }

  it('test_prune_nulls_bodies_after_90d', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'edit', tsMs: NOW - 91 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db
      .prepare('SELECT actor, action, before_preview, after_preview, detail_json FROM scheduled_audit WHERE id = ?')
      .get(id) as Record<string, unknown>;
    expect(row.before_preview).toBeNull();
    expect(row.after_preview).toBeNull();
    expect(row.detail_json).toBeNull();
    expect(row.actor).toBe('owner'); // metadata intact
    expect(row.action).toBe('edit');
    db.close();
  });

  it('test_prune_keeps_recent_bodies', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'edit', tsMs: NOW - 10 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db.prepare('SELECT before_preview FROM scheduled_audit WHERE id = ?').get(id) as {
      before_preview: string | null;
    };
    expect(row.before_preview).toBe('before body'); // unchanged
    db.close();
  });

  it('test_prune_preserves_cancel_metadata', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'cancel', tsMs: NOW - 100 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db.prepare('SELECT action FROM scheduled_audit WHERE id = ?').get(id) as { action: string };
    expect(row.action).toBe('cancel'); // row survives so history can still label the cancellation
    db.close();
  });
});

describe('shouldCloseTaskSession', () => {
  it('closes a spent per-task session (no live tasks, no container)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 0)).toBe(true);
  });

  it('keeps it while a task is still live (recurring re-armed, or pending/paused)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 1)).toBe(false);
  });

  it('keeps it while its container is running (mid-fire)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', true, 0)).toBe(false);
  });

  it('never touches non-task sessions', () => {
    expect(shouldCloseTaskSession('telegram:12345', false, 0)).toBe(false);
    expect(shouldCloseTaskSession(null, false, 0)).toBe(false);
  });
});
