import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 059 — central `turn_usage` (per-turn ledger)
 *
 * usage_daily (migration 047) collapses every turn into a (date,
 * agent_group_id, provider, model) bucket — enough to answer "what is a
 * group spending" but not enough to tell a fat-context turn (large prefix,
 * few steps) apart from a long-loop turn (many sequential API calls against
 * a modest prefix). Those have opposite fixes, and the daily bucket makes
 * them indistinguishable.
 *
 * This table is a 1:1 mirror of each session's per-turn turn_usage rows,
 * written by rollupSessionUsage (src/db/usage.ts) in the SAME transaction as
 * the existing usage_daily upsert — usage_daily's shape and watermark are
 * untouched. `session_id` lets a spend spike be traced back to the session
 * that caused it, which the daily aggregate cannot.
 *
 * `steps`/`duration_ms`/`trigger` are new container-side columns (see
 * container/agent-runner/src/db/connection.ts's additive migration for
 * turn_usage) — a row rolled up from a container that predates them arrives
 * with NULLs here rather than throwing.
 *
 * `id` is a fresh central autoincrement, not the source outbound.db's row
 * id — that id is only unique within one session's own turn_usage table, not
 * across the fleet.
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
