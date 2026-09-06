import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration072 } from './072-observatory-signal.js';
import { migration073 } from './073-observatory-signal-workgroup-cascade.js';
import { runMigrations } from './index.js';

const tables = ['observatory_projects', 'observatory_reviews'] as const;

function tableInfo(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function indexInfo(db: Database.Database, table: string) {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((index) => {
      const { name, unique, origin, partial } = index as {
        name: string;
        unique: number;
        origin: string;
        partial: number;
      };
      return { name, unique, origin, partial };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function rows(db: Database.Database, table: (typeof tables)[number]) {
  return db.prepare(`SELECT rowid, * FROM ${table} ORDER BY id`).all() as Array<{ workgroup_id: string }>;
}

describe('migration073', () => {
  it('upgrades populated 072 observatory tables to cascade with unrelated data intact', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      db.exec(`
        CREATE TABLE workgroups (id TEXT PRIMARY KEY);
        INSERT INTO workgroups VALUES ('wg-target'), ('wg-unrelated');
      `);
      runMigrations(db, [migration072]);
      db.exec(`
        INSERT INTO observatory_projects VALUES
          ('project-target', 'wg-target', 'Target', 'Target project', '["repo-target"]', '["channel-target"]', 2, 'system', '2026-01-01T00:00:00.000Z'),
          ('project-unrelated', 'wg-unrelated', 'Unrelated', 'Unrelated project', '["repo-unrelated"]', '["channel-unrelated"]', 3, 'system', '2026-01-02T00:00:00.000Z');
        INSERT INTO observatory_reviews VALUES
          ('review-target', 'wg-target', 'source', 'target-source', 'target-hash', 4, '{"target":true}', '2026-01-03T00:00:00.000Z'),
          ('review-unrelated', 'wg-unrelated', 'source', 'unrelated-source', 'unrelated-hash', 5, '{"unrelated":true}', '2026-01-04T00:00:00.000Z');
      `);
      const columnsBefore = Object.fromEntries(tables.map((table) => [table, tableInfo(db, table)]));
      const indexesBefore = Object.fromEntries(tables.map((table) => [table, indexInfo(db, table)]));
      const rowsBefore = Object.fromEntries(tables.map((table) => [table, rows(db, table)]));

      runMigrations(db, [migration072, migration073]);

      expect(db.prepare('SELECT name FROM schema_version ORDER BY version').pluck().all()).toEqual([
        'observatory-signal',
        'observatory-signal-workgroup-cascade',
      ]);
      for (const table of tables) {
        expect(rows(db, table)).toEqual(rowsBefore[table]);
        expect(tableInfo(db, table)).toEqual(columnsBefore[table]);
        expect(indexInfo(db, table)).toEqual(indexesBefore[table]);
        expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toMatchObject([
          { table: 'workgroups', from: 'workgroup_id', to: 'id', on_delete: 'CASCADE' },
        ]);
      }

      db.prepare('DELETE FROM workgroups WHERE id = ?').run('wg-target');
      expect(db.prepare('SELECT id FROM workgroups ORDER BY id').pluck().all()).toEqual(['wg-unrelated']);
      for (const table of tables) {
        expect(rows(db, table)).toEqual(rowsBefore[table].filter((row) => row.workgroup_id === 'wg-unrelated'));
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
