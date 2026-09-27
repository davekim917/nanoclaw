import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A multi-model turn writes one turn_usage row per model, so row counts over-count turns. `turn_id` is generated once
 * per `result` event, outside the per-model loop, so `COUNT(DISTINCT turn_id)` is the honest turn count.
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
