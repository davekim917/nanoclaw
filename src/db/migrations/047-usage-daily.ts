/**
 * Migration 047 — usage_daily + usage_rollup_state
 *
 * Fleet-hardening Phase 0.1 (fleet-hardening plan §0.1): the
 * host has zero token/cost accounting today. Containers write per-turn usage
 * into their own session's outbound.db (`turn_usage`, container-writable —
 * the shape is a fixed contract with the container writer); the host
 * sweep rolls those rows up into these two CENTRAL-DB tables so `ncl usage`
 * can answer "what is a group spending" without any caller touching another
 * session's outbound.db directly.
 *
 * usage_daily: additive rollup, one row per (date, agent_group_id, provider,
 * model). UPSERT-only — a row is never read-modify-written from application
 * state, so replaying the same turn_usage id twice would double-count; that's
 * exactly what usage_rollup_state's watermark prevents.
 *
 * usage_rollup_state: one row per session directory (`<agent-group>/<session>`)
 * recording the highest turn_usage.id already folded into usage_daily. The
 * sweep only ever reads turn_usage WHERE id > watermark, so a session swept
 * twice in a row (or a sweep re-run after a host restart) cannot re-add rows
 * already counted.
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
