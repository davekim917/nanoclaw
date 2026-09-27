import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Operator-side archive flag for terminal tasks: NULL is visible, a timestamp hides it by default. Completed tasks
 * auto-archive after 24h in the host sweep; failed ones only by explicit dismissal. The partial index keeps the
 * default view cheap without disturbing the per-status indexes.
 */
export const migration030: Migration = {
  version: 30,
  name: 'tasks-archived-at',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_tasks_archived
        ON tasks(archived_at)
        WHERE archived_at IS NOT NULL;
    `);
  },
};
