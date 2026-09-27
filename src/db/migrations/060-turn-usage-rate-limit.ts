import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Persists the Claude Agent SDK's `rate_limit_event` telemetry, making allowance burn a measurement rather than an
 * inference from cost. Always NULL for Codex and OpenCode rows.
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
