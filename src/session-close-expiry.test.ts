/**
 * #520 — the wiring half: what the closed-session release actually frees, and
 * that the backlog drain makes progress.
 *
 * The inbound op's own semantics (which statuses, why no age/recurrence/fence
 * guard) are covered in `src/modules/mailbox/session-db-ops.test.ts`. Asserted
 * here are the two properties the leak turns on, both of which survived a green
 * suite once already:
 *
 *  - the release clears ALL THREE things `sessionHasOpenWork` counts, not just
 *    the inbound rows — so `pinned()` below transcribes the whole predicate
 *    from `src/storage-manager.ts:803-830` rather than checking `messages_in`;
 *  - the drain's window ADVANCES across runs, so sessions past the cap are not
 *    starved.
 *
 * Every case asserts which sessions came unpinned, never that the source says
 * the right thing.
 *
 * Runs against real session directories on disk through the mailbox seam, with
 * a faked central-DB driver supplying the `sessions` rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('session-close-expiry') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers at module scope (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const sessionRows = vi.hoisted(() => ({ value: [] as Array<{ id: string; agent_group_id: string }> }));
const allCalls = vi.hoisted(() => ({ sql: [] as string[] }));

vi.mock('./db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/connection.js')>()),
  getDb: () => ({
    all: (sql: string) => {
      allCalls.sql.push(sql);
      // The real query is ORDER BY id; the fake honours it so the cursor cases
      // exercise rotation rather than an accident of insertion order.
      return Promise.resolve([...sessionRows.value].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    },
  }),
}));

// Drives `writeOutboundWhenStopped`'s ownership check without a live runtime.
const ownsOutbound = vi.hoisted(() => ({ value: false }));
vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  containerOwnsOutbound: () => ownsOutbound.value,
}));

// The memory-admission budget probe is a `docker info` round-trip at first use;
// point the runtime binary at a name that cannot exist.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
}));

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getAgentMailbox } from './mailbox/index.js';
import { drainClosedSessionPendingBacklog, expireClosedSessionWork } from './session-close-expiry.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const AGENT_GROUP_ID = 'ag-closed-expiry';
const SESSIONS_ROOT = path.join(TEST_DATA_DIR, 'v2-sessions');
const CURSOR_PATH = path.join(TEST_DATA_DIR, 'closed-session-drain-cursor.json');

function sessionDir(sessionId: string): string {
  return path.join(SESSIONS_ROOT, AGENT_GROUP_ID, sessionId);
}

/** Enough of a Session for the release path, which reads only `id`. */
function sessionRow(sessionId: string): Session {
  return { id: sessionId, agent_group_id: AGENT_GROUP_ID } as Session;
}

function prepareSession(sessionId: string): void {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId });
}

interface SeedRow {
  id: string;
  status?: string;
  processAfter?: string | null;
  recurrence?: string | null;
  kind?: string;
}

function seedInbound(sessionId: string, rows: SeedRow[]): void {
  const db = new Database(path.join(sessionDir(sessionId), 'inbound.db'));
  try {
    let seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    for (const r of rows) {
      seq += 2;
      db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, process_after, recurrence, series_id, trigger)
         VALUES (@id, @seq, @kind, @timestamp, @status, '{}', @processAfter, @recurrence, @id, 1)`,
      ).run({
        id: r.id,
        seq,
        kind: r.kind ?? 'chat',
        timestamp: new Date(Date.now() - 43 * 24 * 60 * 60 * 1000).toISOString(),
        status: r.status ?? 'pending',
        processAfter: r.processAfter ?? null,
        recurrence: r.recurrence ?? null,
      });
    }
  } finally {
    db.close();
  }
}

/** A container claim the runner never acked — link 2 of the predicate. */
function seedProcessingClaim(sessionId: string, messageId: string): void {
  const db = new Database(path.join(sessionDir(sessionId), 'outbound.db'));
  try {
    db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
      messageId,
      'processing',
      new Date(Date.now() - 43 * 24 * 60 * 60 * 1000).toISOString(),
    );
  } finally {
    db.close();
  }
}

/** A durable follow-up promise — link 3 of the predicate. */
function seedContinuation(sessionId: string, key: 'work_continuation' | 'pending_next', task: string): void {
  const db = new Database(path.join(sessionDir(sessionId), 'outbound.db'));
  try {
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify({ id: 'wc-1', task }),
      new Date(Date.now() - 43 * 24 * 60 * 60 * 1000).toISOString(),
    );
  } finally {
    db.close();
  }
}

/**
 * The outbound-only cohort: a closed session whose `inbound.db` is gone while
 * `outbound.db` survives. `SqliteAgentMailbox.exists` is `inbound && outbound`,
 * so the mailbox-session funnel cannot see one of these at all.
 */
function dropInbound(sessionId: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(path.join(sessionDir(sessionId), `inbound.db${suffix}`), { force: true });
  }
}

/** What outbound.db still holds, read directly rather than through the seam. */
function outboundState(sessionId: string): { claims: number; continuations: number } {
  const db = new Database(path.join(sessionDir(sessionId), 'outbound.db'), { readonly: true });
  try {
    return {
      claims: (
        db.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE status = 'processing'").get() as { n: number }
      ).n,
      continuations: (
        db
          .prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation', 'pending_next')")
          .get() as { n: number }
      ).n,
    };
  } finally {
    db.close();
  }
}

function inboundStatuses(sessionId: string): Record<string, string> {
  const db = new Database(path.join(sessionDir(sessionId), 'inbound.db'), { readonly: true });
  try {
    return Object.fromEntries(
      (db.prepare('SELECT id, status FROM messages_in').all() as Array<{ id: string; status: string }>).map((r) => [
        r.id,
        r.status,
      ]),
    );
  } finally {
    db.close();
  }
}

/**
 * `sessionHasOpenWork` (src/storage-manager.ts:803-830), transcribed.
 *
 * All three links, in the same order and with the same SQL, because clearing
 * only the first one is the exact defect these cases exist to catch. The real
 * function cannot be imported here — it resolves paths from its own DATA_DIR
 * view and opens its own read-only handles — so the predicate is reproduced.
 *
 * A MISSING file reads as pinned, which is faithful rather than convenient:
 * `dbHasRows` opens `fileMustExist: true`, catches, and answers `null`, and
 * `sessionHasOpenWork` returns that `null` to callers who treat it exactly like
 * `true`. So a half-present session is pinned by the absent file whatever its
 * rows say — the fact the outbound-only cases below assert.
 */
function pinned(sessionId: string): boolean {
  const inPath = path.join(sessionDir(sessionId), 'inbound.db');
  if (!fs.existsSync(inPath)) return true;
  const inbound = new Database(inPath, { readonly: true });
  try {
    if (inbound.prepare("SELECT 1 AS found FROM messages_in WHERE status IN ('processing', 'pending') LIMIT 1").get()) {
      return true;
    }
  } finally {
    inbound.close();
  }

  const outPath = path.join(sessionDir(sessionId), 'outbound.db');
  if (!fs.existsSync(outPath)) return true;
  const outbound = new Database(outPath, { readonly: true });
  try {
    if (outbound.prepare("SELECT 1 AS found FROM processing_ack WHERE status = 'processing' LIMIT 1").get()) {
      return true;
    }
    return (
      outbound
        .prepare(
          `SELECT 1 AS found FROM session_state
            WHERE key IN ('work_continuation', 'pending_next')
              AND value IS NOT NULL
              AND trim(value) NOT IN ('', 'null')
            LIMIT 1`,
        )
        .get() !== undefined
    );
  } finally {
    outbound.close();
  }
}

beforeEach(() => {
  sessionRows.value = [];
  allCalls.sql = [];
  ownsOutbound.value = false;
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('expireClosedSessionWork — releases all three things that pin a session', () => {
  const release = (sessionId: string) =>
    withExistingMailboxSession(AGENT_GROUP_ID, sessionId, (mailbox) =>
      expireClosedSessionWork(mailbox, sessionRow(sessionId), 'spent-task-session-gc'),
    );

  it('expires the inbound rows and unpins the session', async () => {
    prepareSession('sess-1');
    seedInbound('sess-1', [
      { id: 'chat-old' },
      { id: 'claimed', status: 'processing' },
      { id: 'future', processAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
      { id: 'series', kind: 'task', recurrence: '0 9 * * *' },
      { id: 'already-done', status: 'completed' },
    ]);
    expect(pinned('sess-1')).toBe(true);

    const result = await release('sess-1');

    expect(result?.expired).toBe(4);
    expect(inboundStatuses('sess-1')).toEqual({
      'chat-old': 'expired',
      claimed: 'expired',
      future: 'expired',
      series: 'expired',
      'already-done': 'completed',
    });
    expect(pinned('sess-1')).toBe(false);
  });

  it('clears an orphan outbound processing_ack — inbound alone leaves the session pinned', async () => {
    prepareSession('sess-1');
    // No inbound rows at all: the ONLY thing pinning this session is the claim
    // in outbound.db, which is link 2 of the predicate.
    seedProcessingClaim('sess-1', 'm-claimed');
    expect(pinned('sess-1')).toBe(true);

    const result = await release('sess-1');

    expect(result?.claimsCleared).toBe(1);
    expect(pinned('sess-1')).toBe(false);
  });

  it('clears a durable work_continuation — link 3 of the predicate', async () => {
    prepareSession('sess-1');
    seedContinuation('sess-1', 'work_continuation', 'finish the migration');
    expect(pinned('sess-1')).toBe(true);

    const result = await release('sess-1');

    expect(result?.continuationCleared).toBe(true);
    expect(pinned('sess-1')).toBe(false);
  });

  it('clears the legacy pending_next spelling too', async () => {
    prepareSession('sess-1');
    seedContinuation('sess-1', 'pending_next', 'legacy promise');
    expect(pinned('sess-1')).toBe(true);

    await release('sess-1');

    expect(pinned('sess-1')).toBe(false);
  });

  it('releases all three at once', async () => {
    prepareSession('sess-1');
    seedInbound('sess-1', [{ id: 'stranded' }]);
    seedProcessingClaim('sess-1', 'm-claimed');
    seedContinuation('sess-1', 'work_continuation', 'finish the migration');

    const result = await release('sess-1');

    expect(result).toEqual({ expired: 1, claimsCleared: 1, continuationCleared: true });
    expect(pinned('sess-1')).toBe(false);
  });

  it('leaves outbound alone when a container owns the session, and still expires inbound', async () => {
    prepareSession('sess-1');
    seedInbound('sess-1', [{ id: 'stranded' }]);
    seedProcessingClaim('sess-1', 'm-claimed');
    seedContinuation('sess-1', 'work_continuation', 'finish the migration');
    ownsOutbound.value = true;

    const result = await release('sess-1');

    // inbound.db is host-owned, so that half always runs.
    expect(result?.expired).toBe(1);
    // outbound.db has one writer and a container is it.
    expect(result?.claimsCleared).toBe(0);
    expect(result?.continuationCleared).toBe(false);
    expect(pinned('sess-1')).toBe(true);
  });
});

describe('drainClosedSessionPendingBacklog — the window advances', () => {
  function seedClosedSessions(ids: string[]): void {
    for (const id of ids) {
      prepareSession(id);
      seedInbound(id, [{ id: `${id}-row` }]);
    }
    sessionRows.value = ids.map((id) => ({ id, agent_group_id: AGENT_GROUP_ID }));
  }

  const unpinned = (ids: string[]): string[] => ids.filter((id) => !pinned(id)).sort();

  it('drains the WHOLE backlog across successive runs when it exceeds the cap', async () => {
    // The starvation case: 5 retained sessions, a cap of 2. Without a cursor
    // every run re-walks the same prefix and sess-d/sess-e never open at all.
    const ids = ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e'];
    seedClosedSessions(ids);

    const first = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);
    expect(first.visited).toBe(2);
    expect(first.deferred).toBe(3);
    expect(unpinned(ids)).toEqual(['sess-a', 'sess-b']);

    const second = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);
    expect(second.visited).toBe(2);
    expect(unpinned(ids)).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-d']);

    // Run 3 resumes after sess-d, takes sess-e, and wraps onto sess-a. The
    // wrap costs a no-op re-open, which the cap already bounds; what matters
    // is that every session in the backlog has now been reached.
    const third = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);
    expect(third.visited).toBe(2);
    expect(unpinned(ids)).toEqual(ids.slice().sort());
  });

  it('a session that releases NOTHING still spends budget — the cap bounds opens, not work', async () => {
    // sess-a is already clean; it must not let the run open a third session.
    const ids = ['sess-a', 'sess-b', 'sess-c'];
    for (const id of ids) prepareSession(id);
    seedInbound('sess-b', [{ id: 'b-row' }]);
    seedInbound('sess-c', [{ id: 'c-row' }]);
    sessionRows.value = ids.map((id) => ({ id, agent_group_id: AGENT_GROUP_ID }));

    const run = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);

    expect(run.visited).toBe(2);
    expect(run.expired).toBe(1);
    expect(run.deferred).toBe(1);
    expect(pinned('sess-c')).toBe(true);
  });

  it('records a cursor when the cap bites and clears it after a full lap', async () => {
    seedClosedSessions(['sess-a', 'sess-b', 'sess-c']);

    const first = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);
    expect(first.cursor).toBe('sess-b');
    expect(JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')).after).toBe('sess-b');

    // Budget now exceeds the backlog: the run gets through a whole lap without
    // the cap biting, so the cursor is cleared rather than left pointed at an
    // id reclaim may remove before the next boot.
    const second = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 10);
    expect(second.deferred).toBe(0);
    expect(second.cursor).toBeNull();
    expect(JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')).after).toBeNull();
  });

  it('wraps past the end of the list rather than stopping at it', async () => {
    seedClosedSessions(['sess-a', 'sess-b', 'sess-c']);
    // Park the cursor on the LAST id: the next run must wrap to sess-a instead
    // of finding an empty tail and doing nothing.
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ after: 'sess-c' }));

    const run = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 1);

    expect(run.visited).toBe(1);
    expect(unpinned(['sess-a', 'sess-b', 'sess-c'])).toEqual(['sess-a']);
  });

  it('a cursor naming a session that no longer exists starts from the top', async () => {
    seedClosedSessions(['sess-a', 'sess-b']);
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ after: 'sess-zzz-reclaimed' }));

    const run = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 1);

    expect(run.visited).toBe(1);
    expect(unpinned(['sess-a', 'sess-b'])).toEqual(['sess-a']);
  });

  it('a corrupt cursor file is treated as "start from the beginning", not an error', async () => {
    seedClosedSessions(['sess-a', 'sess-b']);
    fs.writeFileSync(CURSOR_PATH, '{not json at all');

    const run = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 1);

    expect(run.visited).toBe(1);
    expect(unpinned(['sess-a', 'sess-b'])).toEqual(['sess-a']);
  });

  it('a broken session consumes budget and advances the cursor, so it cannot wedge the window', async () => {
    prepareSession('sess-b');
    seedInbound('sess-b', [{ id: 'b-row' }]);
    // Existence gate passes, the open throws.
    fs.mkdirSync(sessionDir('sess-a'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir('sess-a'), 'inbound.db'), 'not a sqlite file');
    sessionRows.value = ['sess-a', 'sess-b'].map((id) => ({ id, agent_group_id: AGENT_GROUP_ID }));

    const first = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 1);
    expect(first.visited).toBe(1);
    expect(first.cursor).toBe('sess-a');
    expect(pinned('sess-b')).toBe(true);

    const second = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 1);
    expect(second.visited).toBe(1);
    expect(pinned('sess-b')).toBe(false);
  });

  it('releases closed sessions and leaves an ACTIVE session untouched', async () => {
    prepareSession('sess-closed');
    prepareSession('sess-active');
    seedInbound('sess-closed', [{ id: 'stranded' }, { id: 'stranded-2', status: 'processing' }]);
    seedInbound('sess-active', [
      { id: 'live-pending' },
      // The case `sessionHasOpenWork`'s doc comment exists for: a monthly
      // recurrence that legitimately sits unconsumed with a future fire time.
      {
        id: 'live-monthly',
        kind: 'task',
        recurrence: '0 9 1 * *',
        processAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    seedProcessingClaim('sess-active', 'm-live');
    seedContinuation('sess-active', 'work_continuation', 'still owed');

    // Only the closed session is in the driver's result set — the query the
    // drain issues is scoped to status = 'closed'.
    sessionRows.value = [{ id: 'sess-closed', agent_group_id: AGENT_GROUP_ID }];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.expired).toBe(2);
    expect(allCalls.sql[0]).toContain("status = 'closed'");
    expect(allCalls.sql[0]).toContain('ORDER BY id');
    expect(pinned('sess-closed')).toBe(false);
    expect(inboundStatuses('sess-active')).toEqual({ 'live-pending': 'pending', 'live-monthly': 'pending' });
    expect(pinned('sess-active')).toBe(true);
  });

  it('releases a closed session that kept outbound.db and lost inbound.db', async () => {
    // The cohort the mailbox-session funnel cannot see: `exists` is
    // `inbound && outbound`, so gating or routing on inbound alone skips this
    // session on every boot forever. Empty on this host today; this test is
    // the only thing that will ever exercise the path.
    prepareSession('sess-outbound-only');
    seedProcessingClaim('sess-outbound-only', 'm-claimed');
    seedContinuation('sess-outbound-only', 'work_continuation', 'never resumable');
    dropInbound('sess-outbound-only');
    expect(outboundState('sess-outbound-only')).toEqual({ claims: 1, continuations: 1 });
    sessionRows.value = [{ id: 'sess-outbound-only', agent_group_id: AGENT_GROUP_ID }];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.visited).toBe(1);
    expect(result.claimsCleared).toBe(1);
    expect(result.continuationsCleared).toBe(1);
    expect(result.inboundOnlySkipped).toBe(0);
    expect(outboundState('sess-outbound-only')).toEqual({ claims: 0, continuations: 0 });
  });

  it('an outbound-only session stays pinned after release — the missing file is the pin', async () => {
    // Stated as a test rather than a comment so the limitation cannot quietly
    // stop being true: `sessionHasOpenWork` reads inbound.db first, and a file
    // that is not there answers `null`, which every caller treats as pinned.
    // Releasing the state is still correct; it just does not unpin the dir.
    prepareSession('sess-outbound-only');
    seedProcessingClaim('sess-outbound-only', 'm-claimed');
    dropInbound('sess-outbound-only');
    sessionRows.value = [{ id: 'sess-outbound-only', agent_group_id: AGENT_GROUP_ID }];

    await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(outboundState('sess-outbound-only').claims).toBe(0);
    expect(pinned('sess-outbound-only')).toBe(true);
  });

  it('leaves an outbound-only session alone when a container owns it', async () => {
    prepareSession('sess-outbound-only');
    seedProcessingClaim('sess-outbound-only', 'm-claimed');
    seedContinuation('sess-outbound-only', 'work_continuation', 'still owed');
    dropInbound('sess-outbound-only');
    sessionRows.value = [{ id: 'sess-outbound-only', agent_group_id: AGENT_GROUP_ID }];
    ownsOutbound.value = true;

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.visited).toBe(1);
    expect(result.claimsCleared).toBe(0);
    expect(outboundState('sess-outbound-only')).toEqual({ claims: 1, continuations: 1 });
  });

  it('reports an inbound-only session instead of silently releasing nothing', async () => {
    // The mirror cohort. No inbound-keyed funnel exists, so the honest answer
    // is a count and a warning — not a mailbox-session call that answers
    // `undefined` while the drain reports success.
    prepareSession('sess-inbound-only');
    seedInbound('sess-inbound-only', [{ id: 'stranded' }]);
    fs.rmSync(path.join(sessionDir('sess-inbound-only'), 'outbound.db'), { force: true });
    sessionRows.value = [{ id: 'sess-inbound-only', agent_group_id: AGENT_GROUP_ID }];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.visited).toBe(1);
    expect(result.inboundOnlySkipped).toBe(1);
    expect(result.expired).toBe(0);
  });

  it('skips closed sessions whose directory reclaim already removed', async () => {
    prepareSession('sess-still-there');
    seedInbound('sess-still-there', [{ id: 'stranded' }]);
    sessionRows.value = [
      { id: 'sess-reclaimed', agent_group_id: AGENT_GROUP_ID },
      { id: 'sess-still-there', agent_group_id: AGENT_GROUP_ID },
    ];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.scanned).toBe(2);
    expect(result.visited).toBe(1);
    expect(result.expired).toBe(1);
  });

  it('is idempotent — a second drain releases nothing', async () => {
    seedClosedSessions(['sess-closed']);

    expect((await drainClosedSessionPendingBacklog(SESSIONS_ROOT)).expired).toBe(1);
    expect((await drainClosedSessionPendingBacklog(SESSIONS_ROOT)).expired).toBe(0);
  });

  it('an unreadable central DB yields an empty, non-throwing drain', async () => {
    const { drainClosedSessionPendingBacklog: drain } = await import('./session-close-expiry.js');
    const connection = await import('./db/connection.js');
    const spy = vi.spyOn(connection, 'getDb').mockReturnValue({
      all: () => Promise.reject(new Error('database is locked')),
    } as unknown as ReturnType<typeof connection.getDb>);
    try {
      await expect(drain(SESSIONS_ROOT)).resolves.toEqual({
        scanned: 0,
        visited: 0,
        expired: 0,
        claimsCleared: 0,
        continuationsCleared: 0,
        deferred: 0,
        inboundOnlySkipped: 0,
        cursor: null,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
