import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';
import { migration056 } from './056-sessions-task-routing-platform-id.js';

/**
 * A pre-056 `sessions` table, hand-rolled so rows can exist BEFORE the
 * migration runs — the only way to prove the migration adds no backfill.
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
      created_at         TEXT NOT NULL
    );
  `);
  return db;
}

function insert(db: Database.Database, id: string, threadId: string | null, messagingGroupId: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
     VALUES (?, 'ag-1', ?, ?, 'active', '2026-08-01T00:00:00.000Z')`,
  ).run(id, messagingGroupId, threadId);
}

describe('migration056 — sessions.task_routing_platform_id', () => {
  it('adds a nullable task_routing_platform_id column on a fresh migrated DB', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string; notnull: number }>).filter(
      (c) => c.name === 'task_routing_platform_id',
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]!.notnull).toBe(0);
    db.close();
  });

  it('does NOT backfill: pre-existing rows stay NULL', () => {
    // Backfilling would mean opening per-session inbound.db files from a
    // migration, which is exactly what migration 052's header forbids. NULL
    // keeps the console's anchor-or-fallback behavior unchanged for old rows.
    const db = preMigrationDb();
    insert(db, 's-task', 'system:tasks:example-task-0001', null);
    insert(db, 's-chat', 'slack:CTESTCHAN01:1.1', 'mg-1');

    migration056.up(db);

    const rows = db.prepare('SELECT id, task_routing_platform_id FROM sessions ORDER BY id').all() as Array<{
      id: string;
      task_routing_platform_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: 's-chat', task_routing_platform_id: null },
      { id: 's-task', task_routing_platform_id: null },
    ]);
    db.close();
  });

  it('leaves messaging_group_id alone — the delivery.ts task discriminator is untouched', () => {
    // The whole point of a separate column: `messaging_group_id === null` is
    // how src/delivery.ts recognizes a task session (`task_log` run-log
    // appends, `isTaskSessionPost`). A migration that "helpfully" filled it in
    // would silently break both.
    const db = preMigrationDb();
    insert(db, 's-task', 'system:tasks:example-task-0001', null);

    migration056.up(db);

    const row = db.prepare('SELECT messaging_group_id FROM sessions WHERE id = ?').get('s-task') as {
      messaging_group_id: string | null;
    };
    expect(row.messaging_group_id).toBeNull();
    db.close();
  });

  it('is idempotent — re-running over an already-migrated table is a no-op', () => {
    const db = preMigrationDb();
    migration056.up(db);
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, thread_id, status, created_at, task_routing_platform_id)
                VALUES ('s-1', 'ag-1', 'system:tasks:t-1', 'active', '2026-08-01T00:00:00.000Z', 'slack:CTESTCHAN01')`,
    ).run();

    expect(() => migration056.up(db)).not.toThrow();

    const row = db.prepare('SELECT task_routing_platform_id FROM sessions WHERE id = ?').get('s-1') as {
      task_routing_platform_id: string | null;
    };
    expect(row.task_routing_platform_id).toBe('slack:CTESTCHAN01');
    db.close();
  });
});
