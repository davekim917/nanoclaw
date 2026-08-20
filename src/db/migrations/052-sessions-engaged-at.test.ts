import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration052 } from './052-sessions-engaged-at.js';

/**
 * A pre-052 `sessions` table, hand-rolled so rows can exist BEFORE the
 * migration runs — which is the only way to exercise the backfill. Column
 * shapes mirror 001-initial + 032-sessions-last-outbound.
 */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL,
      status             TEXT DEFAULT 'active',
      container_status   TEXT DEFAULT 'stopped',
      last_active        TEXT,
      last_outbound_at   TEXT,
      created_at         TEXT NOT NULL
    );
  `);
  return db;
}

function insert(
  db: Database.Database,
  id: string,
  row: { container_status?: string | null; last_active?: string | null; last_outbound_at?: string | null },
): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, status, container_status, last_active, last_outbound_at, created_at)
     VALUES (?, 'ag-1', 'active', ?, ?, ?, '2026-08-01T00:00:00.000Z')`,
  ).run(
    id,
    row.container_status === undefined ? 'stopped' : row.container_status,
    row.last_active ?? null,
    row.last_outbound_at ?? null,
  );
}

function engagedAt(db: Database.Database, id: string): string | null {
  return (db.prepare('SELECT engaged_at FROM sessions WHERE id = ?').get(id) as { engaged_at: string | null })
    .engaged_at;
}

describe('migration052 — sessions.engaged_at', () => {
  it('adds a nullable engaged_at column on a fresh migrated DB', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string; notnull: number }>).filter(
      (c) => c.name === 'engaged_at',
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]!.notnull).toBe(0);
    db.close();
  });

  it('leaves a never-engaged session NULL — that is the whole point of the column', () => {
    const db = preMigrationDb();
    insert(db, 's-phantom', { container_status: 'stopped', last_active: '2026-08-02T00:00:00.000Z' });
    migration052.up(db);
    expect(engagedAt(db, 's-phantom')).toBeNull();
    db.close();
  });

  it('backfills from last_outbound_at when the session posted something', () => {
    const db = preMigrationDb();
    insert(db, 's-replied', {
      container_status: 'stopped',
      last_active: '2026-08-02T00:00:00.000Z',
      last_outbound_at: '2026-08-03T00:00:00.000Z',
    });
    migration052.up(db);
    expect(engagedAt(db, 's-replied')).toBe('2026-08-03T00:00:00.000Z');
    db.close();
  });

  it('backfills a woken-but-silent session from last_active — last_outbound_at alone under-counts', () => {
    // A container that started, did work, and posted nothing is genuinely
    // engaged. Matching on last_outbound_at only would strip these threads of
    // mention-sticky status until something re-engaged them.
    const db = preMigrationDb();
    insert(db, 's-running', { container_status: 'running', last_active: '2026-08-04T00:00:00.000Z' });
    insert(db, 's-idle', { container_status: 'idle', last_active: '2026-08-05T00:00:00.000Z' });
    migration052.up(db);
    expect(engagedAt(db, 's-running')).toBe('2026-08-04T00:00:00.000Z');
    expect(engagedAt(db, 's-idle')).toBe('2026-08-05T00:00:00.000Z');
    db.close();
  });

  it('falls back to created_at rather than leaving a matched row NULL', () => {
    const db = preMigrationDb();
    insert(db, 's-running-fresh', { container_status: 'running', last_active: null });
    migration052.up(db);
    expect(engagedAt(db, 's-running-fresh')).toBe('2026-08-01T00:00:00.000Z');
    db.close();
  });

  it('treats a NULL container_status as stopped instead of skipping the row silently', () => {
    // `container_status <> 'stopped'` is NULL — not true — on a NULL row, so
    // a bare comparison would neither match nor be visibly wrong.
    const db = preMigrationDb();
    insert(db, 's-null-status', { container_status: null, last_active: '2026-08-06T00:00:00.000Z' });
    insert(db, 's-null-status-replied', {
      container_status: null,
      last_outbound_at: '2026-08-07T00:00:00.000Z',
    });
    migration052.up(db);
    expect(engagedAt(db, 's-null-status')).toBeNull();
    expect(engagedAt(db, 's-null-status-replied')).toBe('2026-08-07T00:00:00.000Z');
    db.close();
  });
});
