import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration048 } from './048-task-thread-anchors.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
}

describe('migration048', () => {
  it('creates task_thread_anchors with the spec columns', () => {
    const db = makeMigratedDb();
    expect(tableNames(db).has('task_thread_anchors')).toBe(true);

    const cols = new Set(
      (db.prepare('PRAGMA table_info(task_thread_anchors)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of ['session_id', 'channel_type', 'platform_id', 'thread_platform_id', 'created_at']) {
      expect(cols.has(c)).toBe(true);
    }
    db.close();
  });

  it('PK is (session_id, channel_type, platform_id) — a second insert on the same key upserts, not duplicates', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO task_thread_anchors (session_id, channel_type, platform_id, thread_platform_id, created_at)
       VALUES ('s-1', 'slack', 'C1', 'ts-1', '2026-08-10T00:00:00.000Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_thread_anchors (session_id, channel_type, platform_id, thread_platform_id, created_at)
           VALUES ('s-1', 'slack', 'C1', 'ts-2', '2026-08-11T00:00:00.000Z')
           ON CONFLICT(session_id, channel_type, platform_id) DO UPDATE SET
             thread_platform_id = excluded.thread_platform_id,
             created_at = excluded.created_at`,
        )
        .run(),
    ).not.toThrow();
    const row = db.prepare('SELECT thread_platform_id, created_at FROM task_thread_anchors').get() as {
      thread_platform_id: string;
      created_at: string;
    };
    expect(row.thread_platform_id).toBe('ts-2');
    expect(row.created_at).toBe('2026-08-11T00:00:00.000Z');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM task_thread_anchors').get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration048.up(db)).not.toThrow();
    expect(tableNames(db).has('task_thread_anchors')).toBe(true);
    db.close();
  });

  it('is registered in the migrations array after usage-daily', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('task-thread-anchors');
    expect(names).toContain('usage-daily');
    db.close();
  });
});
