import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Finishes 031: NOT NULL on `target_*` (a table rebuild, since ALTER TABLE cannot tighten nullability) and drops
 * `task_id`.
 */
export const migration033: Migration = {
  version: 33,
  name: 'steer-idempotency-drop-task-id',
  up: (db: Database.Database) => {
    db.exec(`
      -- Defensive backfill before DROP. Migration 031 ran the same UPDATE
      -- but if 031 deployed standalone for any window and the old DAO
      -- kept writing task_id without target_type, those rows would land
      -- with target_type/target_id NULL and the rebuild INSERT below
      -- would silently lose them. A second UPDATE is cheap and idempotent.
      UPDATE steer_idempotency
         SET target_type = COALESCE(target_type, 'task'),
             target_id   = COALESCE(target_id, task_id)
       WHERE target_type IS NULL OR target_id IS NULL;

      ALTER TABLE steer_idempotency DROP COLUMN task_id;

      -- Rebuild to enforce NOT NULL on target_type/target_id. This pattern
      -- (CREATE → INSERT SELECT → DROP → RENAME) is the SQLite-safe
      -- equivalent of adding a NOT NULL constraint to an existing column.
      CREATE TABLE steer_idempotency_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL,
        target_type     TEXT NOT NULL CHECK (target_type IN ('task', 'session')),
        target_id       TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        reserved_at     TEXT NOT NULL,
        applied_at      TEXT,
        cached_response TEXT,
        echo_attempted  INTEGER NOT NULL DEFAULT 0,
        request_hash    TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key)
      );

      INSERT INTO steer_idempotency_new
        (id, user_id, idempotency_key, target_type, target_id, message_id, text,
         status, reserved_at, applied_at, cached_response, echo_attempted, request_hash)
      SELECT id, user_id, idempotency_key, target_type, target_id, message_id, text,
             status, reserved_at, applied_at, cached_response, echo_attempted, request_hash
        FROM steer_idempotency;

      DROP TABLE steer_idempotency;
      ALTER TABLE steer_idempotency_new RENAME TO steer_idempotency;

      CREATE INDEX idx_steer_idempotency_age
        ON steer_idempotency(reserved_at);
    `);
  },
};
