/**
 * Remembers the thread a steer on a release-board item opened, so a second steer (another operator, or a double
 * press) posts into it instead of opening a duplicate. First writer wins: the PRIMARY KEY is the dedupe. Keyed by
 * (workgroup_id, item_id) because item ids are repo-scoped and two workgroups may share a repo. `created_by` is a
 * `users.id`, resolved to a name at read time.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration050: Migration = {
  version: 50,
  name: 'observatory-item-threads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_item_threads (
        workgroup_id  TEXT NOT NULL,
        item_id       TEXT NOT NULL,
        thread_id     TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        created_by    TEXT NOT NULL,
        PRIMARY KEY (workgroup_id, item_id)
      );
    `);
  },
};
