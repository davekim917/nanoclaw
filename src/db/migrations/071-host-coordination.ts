import type { Migration } from './index.js';

/**
 * Durable homes for host-coordination facts now held only in memory (retry counts, stop/respawn intent, incarnation
 * fencing, wake signals). Shadow schema: the in-memory maps stay authoritative until a follow-up flips authority to
 * these rows.
 * `session_claims.incarnation` increments per container start; a compare-and-set on it fences spawn dedup and stale
 * `finish()`. `delivery_attempts` keys on mailbox message id and holds only attempt bookkeeping. `wake_signals` uses
 * text ids, not AUTOINCREMENT, to stay portable.
 * Upstream's 024 under upstream's `name`, numbered to sort after the fork's local migrations.
 */
export const migration071: Migration = {
  version: 71,
  name: 'host-coordination',
  up(db) {
    db.exec(`
      CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        hostname TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        stopped_at TEXT
      );

      CREATE TABLE session_claims (
        session_id TEXT PRIMARY KEY,
        incarnation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_at TEXT,
        container_ref TEXT,
        stop_intent TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE delivery_attempts (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_delivery_attempts_session ON delivery_attempts(session_id);

      CREATE TABLE wake_signals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by TEXT
      );
      CREATE INDEX idx_wake_signals_session_pending ON wake_signals(session_id, consumed_at);
    `);
  },
};
