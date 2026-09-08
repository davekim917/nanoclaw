/**
 * #520 — the wiring half: which sessions the closed-session expiry reaches.
 *
 * The op's own semantics (which statuses, why no age/recurrence/fence guard)
 * are covered in `src/modules/mailbox/session-db-ops.test.ts`. What is asserted
 * here is the property the leak actually turns on: the expiry sees CLOSED
 * sessions and only closed sessions. An active session's rows — including a
 * future-dated one, which is exactly what `sessionHasOpenWork`'s doc comment
 * was written to protect — must survive a drain untouched.
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
      return Promise.resolve(sessionRows.value);
    },
  }),
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

const AGENT_GROUP_ID = 'ag-closed-expiry';
const SESSIONS_ROOT = path.join(TEST_DATA_DIR, 'v2-sessions');

function sessionDir(sessionId: string): string {
  return path.join(SESSIONS_ROOT, AGENT_GROUP_ID, sessionId);
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

function seed(sessionId: string, rows: SeedRow[]): void {
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

function statuses(sessionId: string): Record<string, string> {
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

/** The predicate reclaim uses to decide a session dir is pinned. */
function hasOpenWork(sessionId: string): boolean {
  const db = new Database(path.join(sessionDir(sessionId), 'inbound.db'), { readonly: true });
  try {
    return (
      (
        db.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status IN ('processing', 'pending')").get() as {
          n: number;
        }
      ).n > 0
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  sessionRows.value = [];
  allCalls.sql = [];
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('expireClosedSessionWork — the single helper both close paths call', () => {
  it("expires a closed session's remaining rows and unpins it for reclaim", async () => {
    const sessionId = 'sess-closed-1';
    prepareSession(sessionId);
    seed(sessionId, [
      { id: 'chat-old' },
      { id: 'claimed', status: 'processing' },
      { id: 'future', processAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
      { id: 'series', kind: 'task', recurrence: '0 9 * * *' },
      { id: 'already-done', status: 'completed' },
    ]);
    expect(hasOpenWork(sessionId)).toBe(true);

    const expired = await withExistingMailboxSession(AGENT_GROUP_ID, sessionId, (mailbox) =>
      expireClosedSessionWork(mailbox, sessionId, 'spent-task-session-gc'),
    );

    expect(expired).toBe(4);
    expect(statuses(sessionId)).toEqual({
      'chat-old': 'expired',
      claimed: 'expired',
      future: 'expired',
      series: 'expired',
      'already-done': 'completed',
    });
    // The whole point: reclaim can now archive this directory.
    expect(hasOpenWork(sessionId)).toBe(false);
  });
});

describe('drainClosedSessionPendingBacklog', () => {
  it('expires rows in closed sessions and leaves an ACTIVE session untouched', async () => {
    prepareSession('sess-closed');
    prepareSession('sess-active');
    seed('sess-closed', [{ id: 'stranded' }, { id: 'stranded-2', status: 'processing' }]);
    seed('sess-active', [
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

    // Only the closed session is in the driver's result set — the query the
    // drain issues is scoped to status = 'closed'.
    sessionRows.value = [{ id: 'sess-closed', agent_group_id: AGENT_GROUP_ID }];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result).toEqual({ scanned: 1, visited: 1, expired: 2, deferred: 0 });
    expect(allCalls.sql[0]).toContain("status = 'closed'");
    expect(statuses('sess-closed')).toEqual({ stranded: 'expired', 'stranded-2': 'expired' });
    expect(statuses('sess-active')).toEqual({ 'live-pending': 'pending', 'live-monthly': 'pending' });
    expect(hasOpenWork('sess-active')).toBe(true);
  });

  it('skips closed sessions whose directory reclaim already removed — the pass is self-draining', async () => {
    prepareSession('sess-still-there');
    seed('sess-still-there', [{ id: 'stranded' }]);
    sessionRows.value = [
      { id: 'sess-reclaimed', agent_group_id: AGENT_GROUP_ID },
      { id: 'sess-still-there', agent_group_id: AGENT_GROUP_ID },
    ];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result).toEqual({ scanned: 2, visited: 1, expired: 1, deferred: 0 });
  });

  it('stops opening sessions at the limit and reports the remainder as deferred', async () => {
    for (const id of ['sess-a', 'sess-b', 'sess-c']) {
      prepareSession(id);
      seed(id, [{ id: `${id}-row` }]);
    }
    sessionRows.value = ['sess-a', 'sess-b', 'sess-c'].map((id) => ({ id, agent_group_id: AGENT_GROUP_ID }));

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT, 2);

    expect(result).toEqual({ scanned: 3, visited: 2, expired: 2, deferred: 1 });
    const expiredCount = ['sess-a', 'sess-b', 'sess-c'].filter((id) => !hasOpenWork(id)).length;
    expect(expiredCount).toBe(2);
  });

  it('is idempotent — a second drain expires nothing', async () => {
    prepareSession('sess-closed');
    seed('sess-closed', [{ id: 'stranded' }]);
    sessionRows.value = [{ id: 'sess-closed', agent_group_id: AGENT_GROUP_ID }];

    expect((await drainClosedSessionPendingBacklog(SESSIONS_ROOT)).expired).toBe(1);
    expect((await drainClosedSessionPendingBacklog(SESSIONS_ROOT)).expired).toBe(0);
  });

  it('an unreadable session does not abort the rest of the backlog', async () => {
    prepareSession('sess-good');
    seed('sess-good', [{ id: 'stranded' }]);
    // A directory with a file named inbound.db that is not a database: the
    // existence gate passes, the open throws.
    fs.mkdirSync(sessionDir('sess-corrupt'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir('sess-corrupt'), 'inbound.db'), 'not a sqlite file');
    sessionRows.value = [
      { id: 'sess-corrupt', agent_group_id: AGENT_GROUP_ID },
      { id: 'sess-good', agent_group_id: AGENT_GROUP_ID },
    ];

    const result = await drainClosedSessionPendingBacklog(SESSIONS_ROOT);

    expect(result.expired).toBe(1);
    expect(hasOpenWork('sess-good')).toBe(false);
  });

  it('an unreadable central DB yields an empty, non-throwing drain', async () => {
    const { drainClosedSessionPendingBacklog: drain } = await import('./session-close-expiry.js');
    const connection = await import('./db/connection.js');
    const spy = vi.spyOn(connection, 'getDb').mockReturnValue({
      all: () => Promise.reject(new Error('database is locked')),
    } as unknown as ReturnType<typeof connection.getDb>);
    try {
      await expect(drain(SESSIONS_ROOT)).resolves.toEqual({ scanned: 0, visited: 0, expired: 0, deferred: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
