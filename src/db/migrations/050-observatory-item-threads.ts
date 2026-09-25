/**
 * Migration 050 — observatory_item_threads
 *
 * A steer on a release-board ITEM opens a thread for work that has none. Until
 * now nothing remembered that: a claim has a file to write `thread_id` back to
 * (see observatory-steer.ts's `recordClaimThread`), an item does not, so the
 * thread was returned in the response and forgotten. Two operators pressing the
 * board's one-click ship on the same item — or one operator pressing it twice —
 * each got a brand-new thread for the same piece of work, and the agent got the
 * same ask twice in two places with no way to see the other.
 *
 * This is the item's missing file. First writer wins: the PRIMARY KEY IS the
 * dedupe, so a second steer resolves to the first thread and posts into it.
 *
 * Keyed by (workgroup_id, item_id), not item_id alone: board item ids are
 * repo-scoped strings the release watcher publishes ("<REPO>#<number>"), and two
 * workgroups working the same repo would otherwise share one row and post into
 * each other's threads.
 *
 * `created_by` is a `users.id`; the display name is resolved at read time so a
 * rename is never frozen into this table.
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
