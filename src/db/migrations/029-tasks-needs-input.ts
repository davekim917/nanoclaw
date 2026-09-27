import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `needs_input` is 1 while a spawned worker waits on the operator (auto-cleared on the next steer write);
 * `steer_question` is the question it passed to spawn_request_steer.
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
