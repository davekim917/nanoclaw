import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * The walkie-talkie [over]/[out] trailer protocol (migration 034 +
 * src/modules/walkie-talkie/) was removed in commit 9043bd6 when the
 * fork pivoted to the two-Slack-app architecture for sibling agents.
 * Standard Slack `@`-mentions handle peer collaboration now.
 *
 * The 034 migration file was deleted in that commit, but the live
 * `thread_walkie_state` table it created stays around because the
 * earlier deploy already applied it (schema_version row preserved).
 * This drops the orphan table.
 */
export const migration035: Migration = {
  version: 35,
  name: 'drop-thread-walkie-state',
  up: (db: Database.Database) => {
    db.exec(`DROP TABLE IF EXISTS thread_walkie_state;`);
  },
};
