import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Drops the orphan `thread_walkie_state` table left by the retired walkie-talkie protocol (migration 034's file is
 * gone, but deployed installs applied it).
 */
export const migration035: Migration = {
  version: 35,
  name: 'drop-thread-walkie-state',
  up: (db: Database.Database) => {
    db.exec(`DROP TABLE IF EXISTS thread_walkie_state;`);
  },
};
