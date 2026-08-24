import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration060 } from './060-turn-usage-rate-limit.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration060', () => {
  it('adds rate_limit_type/utilization/resets_at to the central turn_usage table', () => {
    const db = makeMigratedDb();
    const cols = new Set(
      (db.prepare('PRAGMA table_info(turn_usage)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('rate_limit_type')).toBe(true);
    expect(cols.has('rate_limit_utilization')).toBe(true);
    expect(cols.has('rate_limit_resets_at')).toBe(true);
    db.close();
  });

  it('accepts a row with the new columns populated', () => {
    const db = makeMigratedDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, rate_limit_type, rate_limit_utilization, rate_limit_resets_at)
           VALUES ('2026-08-24T00:00:00.000Z', 's1', 'ag', 'claude', 'seven_day', 0.91, '2026-08-25T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();
    const row = db.prepare('SELECT rate_limit_type, rate_limit_utilization FROM turn_usage').get() as Record<
      string,
      unknown
    >;
    expect(row.rate_limit_type).toBe('seven_day');
    expect(row.rate_limit_utilization).toBe(0.91);
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration060.up(db)).not.toThrow();
    db.close();
  });

  it('is registered in the migrations array', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('turn-usage-rate-limit');
    db.close();
  });
});
