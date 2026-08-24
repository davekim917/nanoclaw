import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 061 — turn_usage turn_id column
 *
 * Added after migration 060 (additive ALTER, same pattern as the
 * container-side turn_usage columns in
 * container/agent-runner/src/db/connection.ts). Every existing migration
 * stays immutable — this is its own step rather than an edit to 059/060.
 *
 * A turn spanning multiple models (Opus parent + Sonnet subagents) writes
 * one turn_usage row PER MODEL, so usage_daily's row-count-based `turns`
 * over-counts real turns by one for every extra model on a split turn
 * (measured ~1.3-1.6x fleet-wide by timestamp-clustering — an inference this
 * column replaces with a measurement). `turn_id` is generated once per
 * `result` event in poll-loop.ts, outside the per-model recordTurnUsage
 * loop, so every row a single turn produces shares it —
 * `SELECT COUNT(DISTINCT turn_id)` is the honest turn count.
 */
export const migration061: Migration = {
  version: 61,
  name: 'turn-usage-turn-id',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('turn_id')) db.exec(`ALTER TABLE turn_usage ADD COLUMN turn_id TEXT`);
  },
};
