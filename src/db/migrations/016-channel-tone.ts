import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/** Per-wiring default tone. Null falls through to container.json `tone`, then to no tone injection. */
export const migration016: Migration = {
  version: 16,
  name: 'channel-tone',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('default_tone')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_tone TEXT`);
    }
  },
};
