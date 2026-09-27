import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Central per-turn `turn_usage` ledger, a 1:1 mirror written by `rollupSessionUsage` in the same transaction as the
 * usage_daily upsert; the daily bucket cannot tell a fat-context turn from a long-loop one or name the session.
 * Columns newer than a container arrive NULL. `id` is a fresh central autoincrement: the source id is only unique
 * within one session.
 */
export const migration059: Migration = {
  version: 59,
  name: 'central-turn-usage',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_usage (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                 TEXT NOT NULL,
        session_id         TEXT NOT NULL,
        agent_group_id     TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model              TEXT,
        steps              INTEGER,
        duration_ms        INTEGER,
        trigger            TEXT,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        cache_read_tokens  INTEGER,
        cache_write_tokens INTEGER,
        cost_usd           REAL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_usage_ts ON turn_usage (ts);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_group_ts ON turn_usage (agent_group_id, ts);
    `);
  },
};
