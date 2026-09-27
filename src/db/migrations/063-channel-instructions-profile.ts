import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-wiring instructions profile: operating rules for one room, deliberately separate from `default_tone` (016),
 * which carries voice only. A profile NAME resolving to `groups/<folder>/channel-instructions/<name>.md`, mounted
 * read-only and injected by the runner. NULL (the norm) means none; there is no group-level fallback, since
 * standing-instructions.md already is that.
 */
export const migration063: Migration = {
  version: 63,
  name: 'channel-instructions-profile',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('instructions_profile')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN instructions_profile TEXT`);
    }
  },
};
