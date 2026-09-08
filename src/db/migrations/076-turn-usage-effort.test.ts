import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration076 } from './076-turn-usage-effort.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration076', () => {
  it('adds effort and effort_requested to the central turn_usage table', () => {
    const db = makeMigratedDb();
    const cols = new Set(
      (db.prepare('PRAGMA table_info(turn_usage)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('effort')).toBe(true);
    expect(cols.has('effort_requested')).toBe(true);
    db.close();
  });

  it('keeps effective and requested effort apart on a clamped (Haiku) row', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model, turn_id, effort, effort_requested) VALUES
       ('2026-09-07T00:00:00.000Z', 's1', 'ag', 'claude', 'claude-opus-5[1m]', 't-1', 'high', 'high'),
       ('2026-09-07T00:00:00.000Z', 's1', 'ag', 'claude', 'claude-haiku-4-5-20251001', 't-2', NULL, 'high')`,
    ).run();
    // The distinction the second column exists for: a NULL effective effort
    // with a non-NULL requested one is "the config reached the container and
    // the model dropped it", NOT "nothing was ever configured".
    const clamped = db
      .prepare(`SELECT effort, effort_requested FROM turn_usage WHERE model LIKE 'claude-haiku%'`)
      .get() as { effort: string | null; effort_requested: string | null };
    expect(clamped.effort).toBeNull();
    expect(clamped.effort_requested).toBe('high');
    db.close();
  });

  it('leaves pre-cutoff rows NULL — the column is not backfillable', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model)
       VALUES ('2026-08-01T00:00:00.000Z', 's1', 'ag', 'claude', 'claude-opus-5[1m]')`,
    ).run();
    const row = db.prepare('SELECT effort, effort_requested FROM turn_usage').get() as {
      effort: string | null;
      effort_requested: string | null;
    };
    expect(row.effort).toBeNull();
    expect(row.effort_requested).toBeNull();
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration076.up(db)).not.toThrow();
    db.close();
  });

  it('is registered in the migrations array', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('turn-usage-effort');
    db.close();
  });
});
