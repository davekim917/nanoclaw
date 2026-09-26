import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Gate lane for `task_run_outcomes`: one row per scripted fire that did not
 * wake the agent, keyed `outbound_id = 'gate:' || <occurrence id>`, beside the
 * existing turn rows.
 *
 * Additive only. A reverted host still inserts turn rows (`source` defaults to
 * 'turn' and the other columns are nullable); its lane-blind streak would count
 * gate rows, so the rollback deletes them.
 */
export const migration084: Migration = {
  version: 84,
  name: 'task-run-outcome-lanes',
  sqliteOnly: true,
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('task_run_outcomes')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const added: Array<[string, string]> = [
      ['source', "TEXT NOT NULL DEFAULT 'turn' CHECK (source IN ('turn', 'gate'))"],
      [
        'observation',
        "TEXT CHECK (observation IS NULL OR observation IN ('empty', 'unreadable', 'blocked', 'unfinished', 'wake', 'error', 'invalid', 'undeclared'))",
      ],
      ['bound_ms', 'INTEGER'],
      ['since', 'TEXT'],
    ];
    for (const [name, definition] of added) {
      if (!cols.has(name)) db.exec(`ALTER TABLE task_run_outcomes ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_run_outcomes_lane
        ON task_run_outcomes (agent_group_id, series_id, source, id DESC);
      DROP INDEX IF EXISTS idx_task_run_outcomes_series;
    `);
  },
};
