import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * dashboard_tokens stores an HMAC of the token, never the raw bearer (one-time use). steer_idempotency dedupes steer
 * writes per (user, key), bound to the body via request_hash.
 */
export const migration028: Migration = {
  version: 28,
  name: 'dashboard-tables',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE dashboard_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL REFERENCES users(id),
        token_hmac  TEXT NOT NULL UNIQUE,
        issued_at   TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT
      );
      CREATE INDEX idx_dashboard_tokens_unused
        ON dashboard_tokens(user_id, expires_at)
        WHERE used_at IS NULL;

      CREATE TABLE steer_idempotency (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL,
        task_id         TEXT NOT NULL,
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
      CREATE INDEX idx_steer_idempotency_age
        ON steer_idempotency(reserved_at);
    `);
  },
};
