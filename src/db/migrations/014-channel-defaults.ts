import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-wiring default model and effort. Both nullable: absence falls through to container.json, then host env, then
 * the hardcoded default.
 */
export const migration014: Migration = {
  version: 14,
  name: 'channel-defaults',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('default_model')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_model TEXT`);
    }
    if (!cols.has('default_effort')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_effort TEXT`);
    }
  },
};
