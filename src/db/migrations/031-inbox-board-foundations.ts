import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Foundation schema for the operator inbox at /dashboard/inbox.
 *
 * Two changes, bundled because they ship together for the same feature:
 *
 *   1. sessions: archive + Haiku-generated title columns. The inbox shows
 *      every session, not just spawn-dispatched tasks, so the operator needs
 *      a way to dismiss quiet sessions without killing the container, and
 *      a short human label per session so the board doesn't render bare
 *      session IDs.
 *
 *   2. steer_idempotency: generalize from task-only steering to (target_type,
 *      target_id) so the same DAO can deduplicate writes against task-attached
 *      sessions AND standalone sessions from the inbox view. Columns are
 *      added nullable + backfilled here; the legacy `task_id` column is left
 *      in place. C5 swaps the DAO to read/write the generalized columns and
 *      drops `task_id` via a table rebuild — keeping that work out of this
 *      commit means migration 031 has zero coupling with running app code.
 *
 *      Backfill rule: every existing row is a task-steer, so
 *        target_type = 'task'
 *        target_id   = task_id
 *
 * Partial index on archived_at mirrors migration 030's pattern on tasks —
 * predicate is highly selective once the inbox is in steady-state use, and
 * leaves the default `WHERE archived_at IS NULL` path on the regular
 * sessions indexes.
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
