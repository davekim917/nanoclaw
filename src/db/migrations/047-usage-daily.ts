/**
 * Central usage rollup of the per-session `turn_usage` rows. `usage_daily` is additive and UPSERT-only, so replaying
 * a row would double-count; `usage_rollup_state`'s per-session watermark (highest turn_usage.id folded) is what
 * prevents it across repeat sweeps and restarts.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration047: Migration = {
  version: 47,
  name: 'usage-daily',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        date                TEXT NOT NULL,
        agent_group_id      TEXT NOT NULL,
        provider            TEXT NOT NULL,
        model               TEXT NOT NULL DEFAULT '',
        turns               INTEGER NOT NULL DEFAULT 0,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, agent_group_id, provider, model)
      );

      CREATE TABLE IF NOT EXISTS usage_rollup_state (
        session_dir         TEXT PRIMARY KEY,
        last_turn_usage_id  INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
