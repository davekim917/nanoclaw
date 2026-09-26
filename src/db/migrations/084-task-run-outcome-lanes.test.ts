import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration084 } from './084-task-run-outcome-lanes.js';
import { migrations, runMigrations } from './index.js';

function preLaneDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(
    db,
    migrations.filter((m) => m !== migration084),
  );
  return db;
}

function indexes(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_run_outcomes' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

const insertTurnRow = (db: Database.Database, outboundId: string) =>
  db
    .prepare(
      `INSERT INTO task_run_outcomes
         (agent_group_id, session_id, series_id, outbound_id, outcome, model, detail, recorded_at)
       VALUES ('ag', 'sess', 'series', ?, 'failed', NULL, 'boom', '2026-09-26T00:00:00.000Z')`,
    )
    .run(outboundId);

describe('migration 084: task run outcome lanes', () => {
  it('adds the lane columns to existing rows as turn rows, and swaps the series index for the lane index', () => {
    const db = preLaneDb();
    insertTurnRow(db, 'out-before');
    expect(indexes(db)).toContain('idx_task_run_outcomes_series');

    runMigrations(db);

    expect(
      db
        .prepare("SELECT source, observation, bound_ms, since FROM task_run_outcomes WHERE outbound_id = 'out-before'")
        .get(),
    ).toEqual({ source: 'turn', observation: null, bound_ms: null, since: null });
    expect(indexes(db)).toEqual([
      'idx_task_run_outcomes_lane',
      'idx_task_run_outcomes_recorded_at',
      'sqlite_autoindex_task_run_outcomes_1',
    ]);
    db.close();
  });

  it('still accepts the insert a reverted host writes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertTurnRow(db, 'out-after');
    expect(db.prepare("SELECT source FROM task_run_outcomes WHERE outbound_id = 'out-after'").get()).toEqual({
      source: 'turn',
    });
    db.close();
  });

  it('refuses an unknown lane or observation', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const insert = (source: string, observation: string | null) =>
      db
        .prepare(
          `INSERT INTO task_run_outcomes
             (agent_group_id, session_id, series_id, outbound_id, outcome, recorded_at, source, observation)
           VALUES ('ag', 'sess', 'series', ?, 'failed', '2026-09-26T00:00:00.000Z', ?, ?)`,
        )
        .run(`${source}-${observation}`, source, observation);
    expect(() => insert('gate', 'unreadable')).not.toThrow();
    expect(() => insert('cron', 'unreadable')).toThrow(/CHECK/);
    expect(() => insert('gate', 'fine')).toThrow(/CHECK/);
    db.close();
  });

  it('is idempotent', () => {
    const db = preLaneDb();
    runMigrations(db);
    expect(() => migration084.up(db)).not.toThrow();
    db.close();
  });
});
