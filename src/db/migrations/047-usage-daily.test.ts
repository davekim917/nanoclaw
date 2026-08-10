import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration047 } from './047-usage-daily.js';

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

describe('migration047', () => {
  it('creates usage_daily and usage_rollup_state with the spec columns', () => {
    const db = makeMigratedDb();
    expect(tableNames(db).has('usage_daily')).toBe(true);
    expect(tableNames(db).has('usage_rollup_state')).toBe(true);

    const usageDailyCols = new Set(
      (db.prepare('PRAGMA table_info(usage_daily)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of [
      'date',
      'agent_group_id',
      'provider',
      'model',
      'turns',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost_usd',
    ]) {
      expect(usageDailyCols.has(c)).toBe(true);
    }

    const rollupStateCols = new Set(
      (db.prepare('PRAGMA table_info(usage_rollup_state)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(rollupStateCols.has('session_dir')).toBe(true);
    expect(rollupStateCols.has('last_turn_usage_id')).toBe(true);

    db.close();
  });

  it('usage_daily PK is (date, agent_group_id, provider, model) — a second insert on the same key upserts, not duplicates', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO usage_daily (date, agent_group_id, provider, model, turns) VALUES ('2026-08-10', 'ag', 'claude', 'opus', 1)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO usage_daily (date, agent_group_id, provider, model, turns) VALUES ('2026-08-10', 'ag', 'claude', 'opus', 2)
           ON CONFLICT(date, agent_group_id, provider, model) DO UPDATE SET turns = turns + excluded.turns`,
        )
        .run(),
    ).not.toThrow();
    const row = db.prepare('SELECT turns FROM usage_daily').get() as { turns: number };
    expect(row.turns).toBe(3);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM usage_daily').get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration047.up(db)).not.toThrow();
    expect(tableNames(db).has('usage_daily')).toBe(true);
    expect(tableNames(db).has('usage_rollup_state')).toBe(true);
    db.close();
  });

  it('is registered in the migrations array after provider-health', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('usage-daily');
    expect(names).toContain('provider-health');
    db.close();
  });
});
