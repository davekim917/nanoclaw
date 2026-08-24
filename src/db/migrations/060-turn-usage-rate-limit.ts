import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 060 — turn_usage rate-limit columns
 *
 * Added after migration 059's central `turn_usage` table (additive ALTER,
 * same pattern as the container-side turn_usage columns in
 * container/agent-runner/src/db/connection.ts). Every existing migration
 * stays immutable — this is its own step rather than an edit to 059.
 *
 * `rate_limit_type`/`rate_limit_utilization`/`rate_limit_resets_at` persist
 * the Claude Agent SDK's `rate_limit_event` telemetry, which used to be
 * discarded once logged. "What share of our weekly allowance have we
 * burned" was previously only inferable from cost estimates — and those
 * estimates were themselves inflated by the cumulative-usage bug fixed
 * alongside this (see container/agent-runner/src/db/turn-usage.ts). This
 * makes it a direct measurement. Claude-only: always NULL for Codex/OpenCode
 * rows, whose protocols expose nothing equivalent.
 */
export const migration060: Migration = {
  version: 60,
  name: 'turn-usage-rate-limit',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, type] of [
      ['rate_limit_type', 'TEXT'],
      ['rate_limit_utilization', 'REAL'],
      ['rate_limit_resets_at', 'TEXT'],
    ] as const) {
      if (!cols.has(name)) db.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${type}`);
    }
  },
};
