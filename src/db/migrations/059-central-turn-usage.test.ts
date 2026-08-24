import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration059 } from './059-central-turn-usage.js';

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

describe('migration059', () => {
  it('creates a central turn_usage table with the spec columns', () => {
    const db = makeMigratedDb();
    expect(tableNames(db).has('turn_usage')).toBe(true);

    const cols = new Set(
      (db.prepare('PRAGMA table_info(turn_usage)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of [
      'id',
      'ts',
      'session_id',
      'agent_group_id',
      'provider',
      'model',
      'steps',
      'duration_ms',
      'trigger',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost_usd',
    ]) {
      expect(cols.has(c)).toBe(true);
    }
    db.close();
  });

  it('indexes ts and (agent_group_id, ts)', () => {
    const db = makeMigratedDb();
    const indexes = (db.prepare('PRAGMA index_list(turn_usage)').all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_turn_usage_ts');
    expect(indexes).toContain('idx_turn_usage_group_ts');
    db.close();
  });

  it('accepts a row with NULL steps/duration_ms/trigger (old-container rollup case)', () => {
    const db = makeMigratedDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider) VALUES ('2026-08-10T00:00:00.000Z', 's1', 'ag', 'claude')`,
        )
        .run(),
    ).not.toThrow();
    const row = db.prepare('SELECT steps, duration_ms, trigger FROM turn_usage').get() as Record<string, unknown>;
    expect(row.steps).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.trigger).toBeNull();
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration059.up(db)).not.toThrow();
    expect(tableNames(db).has('turn_usage')).toBe(true);
    db.close();
  });

  it('is registered in the migrations array', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('central-turn-usage');
    db.close();
  });
});
