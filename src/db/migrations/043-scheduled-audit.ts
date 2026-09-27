import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Provenance for the Scheduled Tasks Board. `cancelTask` marks rows `completed`, so a board cancellation is
 * indistinguishable from a natural completion in the session DBs; this table is what tells them apart and carries the
 * audit trail. Central DB only, never a session inbound.db.
 * `action` has no CHECK: the enum is enforced in the app so it can widen without a migration. Move rows are written
 * once per side, sharing a `correlation_id`. Prompt bodies are hashed and previewed (512 chars); scripts are
 * hash-only. `detail_json` never holds secret names, only counts and hashes; a move_intent row carries the full
 * source-row snapshot there until it resolves, when it is purged and `resolved_at` stamped.
 */
export const migration043: Migration = {
  version: 43,
  name: 'scheduled-audit',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL DEFAULT (datetime('now')),
        actor           TEXT NOT NULL,
        action          TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        series_id       TEXT NOT NULL,
        before_hash     TEXT,
        after_hash      TEXT,
        before_preview  TEXT,
        after_preview   TEXT,
        before_len      INTEGER,
        after_len       INTEGER,
        detail_json     TEXT,
        correlation_id  TEXT,
        resolved_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_series ON scheduled_audit(series_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_correlation ON scheduled_audit(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_unresolved ON scheduled_audit(action, resolved_at);
    `);
  },
};
