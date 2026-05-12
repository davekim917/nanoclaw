import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Adds explicit needs-input state to the tasks table.
 *
 *   needs_input     — 1 when the spawned worker has stopped to ask the
 *                     operator something and is idle waiting for steer.
 *                     0 by default. Auto-cleared on next steer write.
 *   steer_question  — optional free-text question the worker passed when
 *                     it called spawn_request_steer.
 *
 * Designed for the dashboard's "Needs you" attention group: without this,
 * an idle-waiting worker is indistinguishable from a worker actively
 * chewing on Phase 2.
 */
export const migration029: Migration = {
  version: 29,
  name: 'tasks-needs-input',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN needs_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN steer_question TEXT;

      CREATE INDEX IF NOT EXISTS idx_tasks_needs_input
        ON tasks(needs_input)
        WHERE needs_input = 1;
    `);
  },
};
