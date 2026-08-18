import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration050 } from './050-observatory-item-threads.js';

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

const insert = (db: Database.Database, wg: string, item: string, thread: string) =>
  db
    .prepare(
      `INSERT INTO observatory_item_threads (workgroup_id, item_id, thread_id, created_at, created_by)
       VALUES (?, ?, ?, '2026-08-18T00:00:00.000Z', 'u-1')
       ON CONFLICT(workgroup_id, item_id) DO NOTHING`,
    )
    .run(wg, item, thread);

describe('migration050', () => {
  it('creates observatory_item_threads with the spec columns', () => {
    const db = makeMigratedDb();
    expect(tableNames(db).has('observatory_item_threads')).toBe(true);
    const cols = new Set(
      (db.prepare('PRAGMA table_info(observatory_item_threads)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of ['workgroup_id', 'item_id', 'thread_id', 'created_at', 'created_by']) {
      expect(cols.has(c)).toBe(true);
    }
    db.close();
  });

  // The PK IS the dedupe — first writer wins, and a loser can tell it lost.
  it('a second claim on the same item does not overwrite the first, and reports zero changes', () => {
    const db = makeMigratedDb();
    expect(insert(db, 'wg-1', 'X#1', 'slack:C1:1.1').changes).toBe(1);
    expect(insert(db, 'wg-1', 'X#1', 'slack:C1:2.2').changes).toBe(0);
    const row = db.prepare('SELECT thread_id FROM observatory_item_threads').get() as { thread_id: string };
    expect(row.thread_id).toBe('slack:C1:1.1');
    db.close();
  });

  // Board item ids are repo-scoped strings, not globally unique.
  it('scopes the key to the workgroup, so two workgroups never share a thread', () => {
    const db = makeMigratedDb();
    insert(db, 'wg-1', 'X#1', 'slack:C1:1.1');
    expect(insert(db, 'wg-2', 'X#1', 'slack:C9:9.9').changes).toBe(1);
    const rows = db
      .prepare('SELECT workgroup_id, thread_id FROM observatory_item_threads ORDER BY workgroup_id')
      .all() as { workgroup_id: string; thread_id: string }[];
    expect(rows).toEqual([
      { workgroup_id: 'wg-1', thread_id: 'slack:C1:1.1' },
      { workgroup_id: 'wg-2', thread_id: 'slack:C9:9.9' },
    ]);
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration050.up(db)).not.toThrow();
    expect(tableNames(db).has('observatory_item_threads')).toBe(true);
    db.close();
  });

  it('is registered in the migrations array after the session-triple index', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('observatory-item-threads');
    expect(names).toContain('unique-active-session-triple');
    db.close();
  });
});
