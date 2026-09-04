import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The heartbeat lives under DATA_DIR, which is a hard-coded resolve of the
 * project root — so the only way to point it at a fixture is to replace the
 * path helper. Partial mock: every other session-manager export (including
 * `withExistingMailboxSession`, which these cases never reach because they
 * call `warnSessionIfWorkInFlight` directly) stays the real one.
 */
const heartbeatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restart-warn-'));
vi.mock('./session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-manager.js')>()),
  heartbeatPath: (agentGroupId: string, sessionId: string) =>
    path.join(heartbeatRoot, `${agentGroupId}__${sessionId}.heartbeat`),
}));

/**
 * Partial, not wholesale: `log.js` also exports `setLogScrubber`, which
 * `secret-scrubber.ts` reaches for at import time through this module's own
 * dependency graph. Replacing the module outright makes that import throw
 * before a single case runs.
 */
vi.mock('./log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./log.js')>();
  return {
    ...actual,
    log: { ...actual.log, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { log } from './log.js';
import { RESTART_WARN_HEARTBEAT_FRESH_MS, warnSessionIfWorkInFlight } from './host-restart-warn.js';
import { hasRestartNoteSince } from './modules/mailbox/ops/lookups.js';
import { getContainerState, getProcessingClaims } from './modules/mailbox/ops/sweep.js';
import { insertDeferredMessageWithContextIfNew } from './modules/mailbox/ops/ingress.js';
import { readWorkContinuation } from './modules/mailbox/ops/continuation.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import type { Session } from './types.js';

/**
 * The five ops `warnSessionIfWorkInFlight` reaches for, bound to the pair of
 * in-memory handles this suite builds.
 *
 * The functions are the module's REAL ops, so the statements under test are
 * exactly the production ones — only the handles are the fixture's. That is
 * what lets these cases keep asserting on `inDb`/`outDb` after the mailbox
 * seam removed the handle parameters (mailbox seam PR 4).
 */
function mailboxOver(inDb: Database.Database, outDb: Database.Database): NanoclawMailboxSession {
  return {
    hasRestartNoteSince: (since: string) => hasRestartNoteSince(inDb, since),
    getContainerState: () => getContainerState(outDb),
    readWorkContinuation: () => readWorkContinuation(outDb),
    getProcessingClaimRows: () => getProcessingClaims(outDb),
    insertDeferredMessageWithContextIfNew: (message: Parameters<typeof insertDeferredMessageWithContextIfNew>[1]) =>
      insertDeferredMessageWithContextIfNew(inDb, message),
  } as unknown as NanoclawMailboxSession;
}

function makeDbs(): { inDb: Database.Database; outDb: Database.Database } {
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
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL,
      provider_status          TEXT,
      provider_last_event_at   TEXT,
      provider_last_probe_at   TEXT,
      provider_probe_failures  INTEGER,
      provider_recovery_attempts INTEGER,
      provider_failure_reason  TEXT,
      memory_current_bytes     INTEGER,
      memory_peak_bytes        INTEGER,
      memory_max_bytes         INTEGER,
      memory_oom_events        INTEGER,
      memory_oom_kill_events   INTEGER,
      memory_telemetry_at      TEXT
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

/**
 * Add the fork's `provider_executing` column. `makeDbs` deliberately omits it,
 * so the default fixture exercises the LEGACY tier — `getContainerState` falls
 * back to tool-only columns and the field reads undefined — while these cases
 * exercise a modern outbound DB.
 */
function withProviderExecuting(outDb: Database.Database, executing: 0 | 1): void {
  outDb.exec('ALTER TABLE container_state ADD COLUMN provider_executing INTEGER NOT NULL DEFAULT 0');
  outDb
    .prepare(
      `INSERT INTO container_state (id, provider_executing, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider_executing = excluded.provider_executing`,
    )
    .run(executing, new Date().toISOString());
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Touch the fixture heartbeat `agoMs` in the past, the way a streaming turn
 * would have. Absent unless a case asks for it, so every other case in this
 * file keeps exercising the "no heartbeat signal" path.
 */
function touchHeartbeat(session: Session, agoMs: number): void {
  const file = path.join(heartbeatRoot, `${session.agent_group_id}__${session.id}.heartbeat`);
  fs.writeFileSync(file, '');
  const at = new Date(Date.now() - agoMs);
  fs.utimesSync(file, at, at);
}

afterEach(() => {
  for (const entry of fs.readdirSync(heartbeatRoot)) fs.rmSync(path.join(heartbeatRoot, entry), { force: true });
  vi.clearAllMocks();
});

/** The one line that says a session was considered and found to have no signal. */
function noSignalLogCalls(): unknown[][] {
  return vi
    .mocked(log.info)
    .mock.calls.filter(([message]) => message === 'host-restart: no accountability note, no work-in-flight signal');
}

function noteRows(inDb: Database.Database) {
  return inDb.prepare("SELECT * FROM messages_in WHERE content LIKE '%agent_host_restart%'").all() as Array<
    Record<string, unknown>
  >;
}

describe('warnSessionIfWorkInFlight', () => {
  it('does not treat internal narration as proof that work remains', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'status', '{}')")
      .run(new Date().toISOString());

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('fires when a tool is in flight even if the last outbound was a chat message', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());
    outDb
      .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
      .run(new Date().toISOString(), new Date().toISOString());

    expect(
      warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'host startup after an unclean stop'),
    ).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('fires when an explicit continuation is stored', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());
    outDb.prepare('INSERT INTO session_state VALUES (?, ?, ?)').run(
      'work_continuation',
      JSON.stringify({
        id: 'cont-1',
        task: 'write the dbt tests',
        phase: 'queued',
        chain: 2,
        resume_attempts: 0,
        recovery_episode: 0,
      }),
      new Date().toISOString(),
    );

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
    const pair = inDb.prepare('SELECT id, trigger, on_wake, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      on_wake: number;
      content: string;
    }>;
    expect(pair).toHaveLength(2);
    expect(pair[0].id).toBe(`recall-${pair[1].id}`);
    expect(pair.map((row) => row.trigger)).toEqual([0, 0]);
    expect(pair.map((row) => row.on_wake)).toEqual([1, 1]);
    expect(JSON.parse(pair[0].content)).toEqual({ subtype: 'recall_context', deferred: true });
  });

  it('stays quiet for an idle session whose last act was a user-facing message', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('is idempotent within the restart window', () => {
    const { inDb, outDb } = makeDbs();
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run('m-1', 'processing', new Date().toISOString());

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'first')).toBe(true);
    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'second')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('ignores stale tool state and stale processing claims', () => {
    const { inDb, outDb } = makeDbs();
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    outDb
      .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
      .run(stale, stale);
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run('m-1', 'processing', stale);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'startup')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('allows a distinct restart episode after the ten-minute replay window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
      const { inDb, outDb } = makeDbs();
      outDb
        .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
        .run(new Date().toISOString(), new Date().toISOString());
      expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'first restart')).toBe(true);

      vi.setSystemTime(new Date('2026-07-28T12:11:00.000Z'));
      expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'second restart')).toBe(true);
      expect(noteRows(inDb)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a legacy outbound DB without processing_ack', () => {
    const { inDb, outDb } = makeDbs();
    outDb.exec('DROP TABLE processing_ack');
    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'startup')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });
});

describe('a long autonomous turn interrupted by a restart', () => {
  /**
   * The 2026-09-04 incident, reproduced exactly. sess-1788440696563-ae2rvy was
   * four minutes into one open query when the host went down:
   *
   *   - its triggering row was claimed and then marked `completed` seconds
   *     later, because the runner releases the claim as soon as the first
   *     result event lands and keeps the query open for follow-up pushes;
   *   - it was between two tool calls, so container_state carried no
   *     current_tool;
   *   - it had never called continue_work, so there was no continuation;
   *   - it was posting status edits up to five seconds before the SIGTERM,
   *     and its heartbeat was touched at the same time.
   *
   * Every signal the predicate had was absent while the agent was
   * demonstrably mid-turn. No note meant no on_wake row, so nothing respawned
   * the session and the user waiting in Slack got silence.
   */
  function incidentDbs(): { inDb: Database.Database; outDb: Database.Database } {
    const { inDb, outDb } = makeDbs();
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    // The triggering row, admitted four minutes ago and long since released.
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('m-trigger', 1, 'chat-sdk', ?, 'processed', 1, '{}')`,
      )
      .run(fourMinutesAgo);
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-trigger', 'completed', ?)")
      .run(fourMinutesAgo);
    // Live status narration, which is deliberately NOT evidence on its own.
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'status', '{}')")
      .run(new Date(Date.now() - 5_000).toISOString());
    // Between tools: a row exists, but no tool is open.
    outDb
      .prepare('INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, NULL, NULL, ?)')
      .run(new Date(Date.now() - 5_000).toISOString());
    return { inDb, outDb };
  }

  it('writes the accountability note on a heartbeat from five seconds ago', () => {
    const { inDb, outDb } = incidentDbs();
    const session = fakeSession();
    touchHeartbeat(session, 5_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(true);
    const pair = inDb.prepare('SELECT id, trigger, on_wake FROM messages_in WHERE id != ? ORDER BY seq').all(
      'm-trigger',
    ) as Array<{ id: string; trigger: number; on_wake: number }>;
    expect(pair).toHaveLength(2);
    expect(pair.map((row) => row.on_wake), 'the note must be on_wake so the NEXT container sees it').toEqual([1, 1]);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('is what changed: the same session gets nothing without a heartbeat', () => {
    const { inDb, outDb } = incidentDbs();

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('leaves an idle container alone — a stale heartbeat is not work in flight', () => {
    // The spam guard this clause must not break. An idle container never
    // touches its heartbeat, so its mtime is the end of its last turn; at ten
    // minutes it is well outside the live window and must stay silent.
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, 10 * 60 * 1000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('trusts a heartbeat touched while we were reading it', () => {
    // The graceful-shutdown warn runs BEFORE stopAllContainers, so the
    // container is alive and still touching this file. A stamp a little newer
    // than the caller's entry clock is the normal case and the single most
    // conclusive evidence there is; rejecting it would leave the busiest
    // mid-turn container as the one session with no note.
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, -2_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('ignores a stamp too far ahead to be a concurrent touch', () => {
    // Container and host share one clock and one filesystem, so a minute into
    // the future is a bad timestamp, not a write that raced our stat. Believing
    // it would warn this session on every restart forever.
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, -60_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
    expect((noSignalLogCalls()[0][1] as { heartbeatAgeMs: number | null }).heartbeatAgeMs).toBeNull();
  });
});

describe('the heartbeat freshness boundary', () => {
  // No fake timers here: the signal IS a real file mtime, so faking the clock
  // over real I/O would test the mock rather than the read.
  it('a heartbeat one second past the window is not work in flight, and says so', () => {
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, RESTART_WARN_HEARTBEAT_FRESH_MS + 1_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
    const calls = noSignalLogCalls();
    expect(calls, 'the reason line is the only trace a skipped session leaves').toHaveLength(1);
    const fields = calls[0][1] as { heartbeatAgeMs: number | null; hasProcessingClaim: boolean };
    expect(fields.heartbeatAgeMs).toBeGreaterThan(RESTART_WARN_HEARTBEAT_FRESH_MS);
    expect(fields.hasProcessingClaim).toBe(false);
  });

  it('a missing heartbeat is not work in flight, and reports a null age', () => {
    const { inDb, outDb } = makeDbs();

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
    const calls = noSignalLogCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { heartbeatAgeMs: number | null }).heartbeatAgeMs).toBeNull();
  });

  it('the shutdown warn and the startup backstop agree on one note per interruption', () => {
    // Both paths run seconds apart against the same dead container, so the
    // heartbeat-derived recovery key must round to the same value and the
    // second call must find the note already there.
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, 5_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(true);
    expect(
      warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'host startup after an unclean stop'),
      'the dedupe must hold across both restart paths',
    ).toBe(false);
    expect(noteRows(inDb)).toHaveLength(1);
  });
});

describe('the heartbeat is paired with provider_executing', () => {
  // The runner touches the heartbeat after EVERY stream event, including the
  // terminal `result` that ends a turn. So a session whose turn just finished
  // normally has an mtime seconds old, and the heartbeat ALONE would warn it —
  // the idle spam the guard exists to prevent. `provider_executing` is lowered
  // on that same `result`, which is what tells the two apart.
  it('a turn that just ended is not work in flight, however fresh the heartbeat', () => {
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 0);
    const session = fakeSession();
    touchHeartbeat(session, 1_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
    const fields = noSignalLogCalls()[0][1] as { providerExecuting: number | null };
    expect(fields.providerExecuting).toBe(0);
  });

  it('a turn still executing is work in flight', () => {
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 1);
    const session = fakeSession();
    touchHeartbeat(session, 5_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('an executing turn with a stale heartbeat is not enough from the startup backstop', () => {
    // There the previous host is gone, so a raised flag is whatever a dead
    // container last wrote and nothing has reset it — believing it would warn
    // this session on every boot.
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 1);
    const session = fakeSession();
    touchHeartbeat(session, RESTART_WARN_HEARTBEAT_FRESH_MS + 1_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'host startup after an unclean stop')).toBe(
      false,
    );
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('a LIVE executing turn needs no heartbeat corroboration', () => {
    // Codex has no total-turn and no idle timeout by design, and its health
    // probe only starts after 60s of quiet — so a healthy turn can stream
    // nothing for well past the freshness window. A pushed follow-up turn in
    // that state holds no claim, may sit between tools, and may have no
    // continuation. During graceful shutdown the container is still running,
    // so the flag is current state and is evidence on its own.
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 1);
    const session = fakeSession();
    touchHeartbeat(session, 10 * 60 * 1000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown', true)).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('a live container that is NOT executing still gets nothing', () => {
    // The live-container branch must not become "warn every running session".
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 0);
    const session = fakeSession();
    touchHeartbeat(session, 10 * 60 * 1000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown', true)).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('a live executing turn with no heartbeat file at all still gets a note', () => {
    // Exercises the recoveryKey fallback: no tool stamp, no claim, no
    // heartbeat mtime to round.
    const { inDb, outDb } = makeDbs();
    withProviderExecuting(outDb, 1);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), fakeSession(), 'graceful host shutdown', true)).toBe(
      true,
    );
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('a legacy outbound DB without the column still trusts the heartbeat', () => {
    // makeDbs has no provider_executing, so getContainerState drops to the
    // tool-only tier and the field reads undefined. Undefined must not veto.
    const { inDb, outDb } = makeDbs();
    const session = fakeSession();
    touchHeartbeat(session, 5_000);

    expect(warnSessionIfWorkInFlight(mailboxOver(inDb, outDb), session, 'graceful host shutdown')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });
});
