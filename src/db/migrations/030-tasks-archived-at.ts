import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Operator-side archive flag for terminal tasks. NULL = visible on the
 * board; ISO timestamp = hidden by default, recoverable via the dashboard's
 * "Show archived" toggle.
 *
 *   - Completed tasks auto-archive after 24h via the host sweep loop
 *     (`src/host-sweep.ts:sweep`).
 *   - Failed tasks never auto-archive — operator must explicitly dismiss
 *     them via `POST /dashboard/api/tasks/:id/archive`.
 *   - Bulk dismiss for "I've addressed all failures" lives at
 *     `POST /dashboard/api/tasks/bulk-archive`.
 *
 * Partial index on `archived_at IS NOT NULL` keeps the default-view query
 * cheap (predicate is highly selective once the auto-archive sweep starts
 * running) while leaving the common `WHERE archived_at IS NULL` path free
 * to use existing per-status indexes.
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
