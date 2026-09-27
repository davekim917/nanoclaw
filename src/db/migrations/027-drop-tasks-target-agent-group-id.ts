import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Drops tasks.target_agent_group_id: children always spawn in the parent's own agent group. DROP COLUMN (SQLite
 * 3.35+) also drops its index.
 */
export const migration027: Migration = {
  version: 27,
  name: 'drop-tasks-target-agent-group-id',
  up: (db: Database.Database) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_target_group;
      ALTER TABLE tasks DROP COLUMN target_agent_group_id;
    `);
  },
};
