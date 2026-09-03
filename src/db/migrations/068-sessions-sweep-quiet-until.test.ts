import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';
import { migration068 } from './068-sessions-sweep-quiet-until.js';
import {
  createSession,
  getWarmQuietSessionMarks,
  persistQuietSessionMarks,
  updateSession,
  type QuietSessionMark,
} from '../sessions.js';
import type { Session } from '../../types.js';

/**
 * A pre-065 `sessions` table, hand-rolled so rows can exist BEFORE the
 * migration runs — the only way to prove it adds no backfill.
 */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL,
      messaging_group_id TEXT,
      thread_id          TEXT,
      status             TEXT DEFAULT 'active',
      last_active        TEXT,
      created_at         TEXT NOT NULL
    );
  `);
  return db;
}

function insertRaw(db: Database.Database, id: string, lastActive: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, status, last_active, created_at)
     VALUES (?, 'ag-1', 'active', ?, '2026-08-01T00:00:00.000Z')`,
  ).run(id, lastActive);
}

describe('migration068 — sessions.sweep_quiet_until', () => {
  it('adds a nullable sweep_quiet_until column on a fresh migrated DB', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string; notnull: number }>).filter(
      (c) => c.name === 'sweep_quiet_until',
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]!.notnull).toBe(0);
    db.close();
  });

  it('does NOT backfill: pre-existing rows stay NULL', () => {
    // There is nothing to reconstruct. The value is a prediction computed from
    // a per-session inbound.db read, and migration 052's header forbids a
    // migration opening those files to invent one. NULL means "sweep me",
    // which is exactly today's post-boot behavior.
    const db = preMigrationDb();
    insertRaw(db, 's-quiet', '2026-08-20T00:00:00.000Z');
    insertRaw(db, 's-busy', null);

    migration068.up(db);

    const rows = db.prepare('SELECT id, sweep_quiet_until FROM sessions ORDER BY id').all() as Array<{
      id: string;
      sweep_quiet_until: string | null;
    }>;
    expect(rows).toEqual([
      { id: 's-busy', sweep_quiet_until: null },
      { id: 's-quiet', sweep_quiet_until: null },
    ]);
    db.close();
  });
});

describe('the persisted quiet mark (S2-PR15)', () => {
  function session(id: string, lastActive: string | null): Session {
    return {
      id,
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      // Distinct per session: migration 049's partial unique index over
      // (agent_group_id, COALESCE(messaging_group_id,''), COALESCE(thread_id,''))
      // WHERE status='active' rejects a second active row with the same triple.
      thread_id: `thr-${id}`,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: lastActive,
      created_at: '2026-08-01T00:00:00.000Z',
    } as Session;
  }

  function markOf(id: string): string | null {
    const row = getDb().prepare('SELECT sweep_quiet_until FROM sessions WHERE id = ?').get(id) as
      | { sweep_quiet_until: string | null }
      | undefined;
    return row?.sweep_quiet_until ?? null;
  }

  const ACTIVE = '2026-08-20T00:00:00.000Z';
  const FUTURE = '2099-01-01T00:00:00.000Z';
  const PAST = '2000-01-01T00:00:00.000Z';

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'ag', 'ag', '2026-08-01T00:00:00.000Z')`,
    ).run();
  });

  afterEach(() => {
    closeDb();
  });

  it('writes a whole tick of marks in one batch', () => {
    createSession(session('s-1', ACTIVE));
    createSession(session('s-2', ACTIVE));
    createSession(session('s-3', ACTIVE));

    const marks: QuietSessionMark[] = [
      { sessionId: 's-1', quietUntil: '2026-09-03T12:20:00.000Z', lastActive: ACTIVE },
      { sessionId: 's-3', quietUntil: '2026-09-03T12:25:00.000Z', lastActive: ACTIVE },
    ];
    persistQuietSessionMarks(marks);

    expect(markOf('s-1')).toBe('2026-09-03T12:20:00.000Z');
    expect(markOf('s-2')).toBeNull();
    expect(markOf('s-3')).toBe('2026-09-03T12:25:00.000Z');
  });

  it('an empty batch writes nothing', () => {
    createSession(session('s-1', null));
    persistQuietSessionMarks([]);
    expect(markOf('s-1')).toBeNull();
  });

  // Codex F1. The mark is computed against the last_active read at the START of
  // that session's sweep, but the batch is flushed only after the WHOLE fan-out
  // and the driver yields between sessions. Ingress in one of those yields bumps
  // last_active and clears the column; an unconditional write would put the now
  // stale expiry straight back, and a restart before the next tick would warm it
  // and skip a genuinely due session without ever opening its inbound.db.
  it('does not write back a mark whose last_active moved between the sweep and the flush', () => {
    createSession(session('s-stable', ACTIVE));
    createSession(session('s-moved', ACTIVE));
    createSession(session('s-null', null));

    // The ingress that lands mid-fan-out, through the real writer.
    updateSession('s-moved', { last_active: '2026-09-03T12:00:00.000Z' });

    persistQuietSessionMarks([
      { sessionId: 's-stable', quietUntil: FUTURE, lastActive: ACTIVE },
      { sessionId: 's-moved', quietUntil: FUTURE, lastActive: ACTIVE },
      // A never-active session: the guard must compare NULL to NULL null-safely
      // (`IS`, not `=`), or every brand-new session silently loses its mark.
      { sessionId: 's-null', quietUntil: FUTURE, lastActive: null },
    ]);

    expect(markOf('s-stable')).toBe(FUTURE);
    expect(markOf('s-moved'), 'a stale mark was written back over the clear').toBeNull();
    expect(markOf('s-null')).toBe(FUTURE);
  });

  // The invalidation contract the whole warm path rests on. Without this the
  // first tick after a restart could honour a mark taken before a newly due
  // row was written, holding that row for the rest of the backoff.
  it('updateSession clears the mark in the same statement that moves last_active', () => {
    createSession(session('s-1', ACTIVE));
    persistQuietSessionMarks([{ sessionId: 's-1', quietUntil: FUTURE, lastActive: ACTIVE }]);
    expect(markOf('s-1')).toBe(FUTURE);

    updateSession('s-1', { last_active: '2026-09-03T12:00:00.000Z' });

    expect(markOf('s-1')).toBeNull();
  });

  it('an update that does not touch last_active leaves the mark alone', () => {
    // The mark is about when work is next DUE. A container going idle does not
    // change that, and clearing here would throw away the cache on every
    // container state transition.
    createSession(session('s-1', ACTIVE));
    persistQuietSessionMarks([{ sessionId: 's-1', quietUntil: FUTURE, lastActive: ACTIVE }]);

    updateSession('s-1', { container_status: 'idle' });

    expect(markOf('s-1')).toBe(FUTURE);
  });

  it('the warm read returns only active sessions whose mark is still in the future', () => {
    createSession(session('s-future', ACTIVE));
    createSession(session('s-expired', ACTIVE));
    createSession(session('s-unmarked', ACTIVE));
    createSession(session('s-closed', ACTIVE));
    persistQuietSessionMarks([
      { sessionId: 's-future', quietUntil: FUTURE, lastActive: ACTIVE },
      { sessionId: 's-expired', quietUntil: PAST, lastActive: ACTIVE },
      { sessionId: 's-closed', quietUntil: FUTURE, lastActive: ACTIVE },
    ]);
    updateSession('s-closed', { status: 'closed' });

    const warm = getWarmQuietSessionMarks('2026-09-03T12:00:00.000Z');

    expect(warm).toEqual([{ id: 's-future', sweep_quiet_until: FUTURE, last_active: ACTIVE }]);
  });
});
