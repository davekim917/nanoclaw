import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration061 } from './061-turn-usage-turn-id.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration061', () => {
  it('adds turn_id to the central turn_usage table', () => {
    const db = makeMigratedDb();
    const cols = new Set(
      (db.prepare('PRAGMA table_info(turn_usage)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('turn_id')).toBe(true);
    db.close();
  });

  it('supports counting distinct turns across split-turn rows', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model, turn_id) VALUES
       ('2026-08-24T00:00:00.000Z', 's1', 'ag', 'claude', 'opus', 't-1'),
       ('2026-08-24T00:00:00.000Z', 's1', 'ag', 'claude', 'sonnet', 't-1'),
       ('2026-08-24T00:01:00.000Z', 's1', 'ag', 'claude', 'opus', 't-2')`,
    ).run();
    const { rows } = db.prepare('SELECT COUNT(*) AS rows FROM turn_usage').get() as { rows: number };
    const { turns } = db.prepare('SELECT COUNT(DISTINCT turn_id) AS turns FROM turn_usage').get() as {
      turns: number;
    };
    expect(rows).toBe(3);
    expect(turns).toBe(2);
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration061.up(db)).not.toThrow();
    db.close();
  });

  it('is registered in the migrations array', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('turn-usage-turn-id');
    db.close();
  });
});
