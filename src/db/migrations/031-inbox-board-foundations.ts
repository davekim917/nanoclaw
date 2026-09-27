import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Operator inbox foundations: session archive and title columns, and steer_idempotency generalized to (target_type,
 * target_id), backfilled as ('task', task_id). The legacy `task_id` column stays; migration 033 drops it.
 */
export const migration031: Migration = {
  version: 31,
  name: 'inbox-board-foundations',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN archived_at        TEXT;
      ALTER TABLE sessions ADD COLUMN title              TEXT;
      ALTER TABLE sessions ADD COLUMN title_generated_at TEXT;
      ALTER TABLE sessions ADD COLUMN title_basis_seq    INTEGER;

      CREATE INDEX IF NOT EXISTS idx_sessions_archived
        ON sessions(archived_at)
        WHERE archived_at IS NOT NULL;

      ALTER TABLE steer_idempotency ADD COLUMN target_type TEXT;
      ALTER TABLE steer_idempotency ADD COLUMN target_id   TEXT;

      UPDATE steer_idempotency
         SET target_type = 'task',
             target_id   = task_id
       WHERE target_type IS NULL;
    `);
  },
};
