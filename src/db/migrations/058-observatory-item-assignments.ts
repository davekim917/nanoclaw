import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Which agent an ownerless attention item was assigned to, and when. Items are derived per poll and stay ownerless
 * until the agent claims the work minutes later, so without a row every Assign press queued another task. The PRIMARY
 * KEY is the dedupe and is written BEFORE dispatch, so a double-click loses on the insert; it also survives restarts
 * and decorates the list so the item stops reading as ownerless immediately.
 * `assigned_at` is a re-assignment window, not a lock: the row is upsertable once older than `ASSIGN_DEDUPE_MS`, so
 * work an agent never picks up is not stranded. Keyed by (workgroup_id, item_id) as in 050. `item_id` is the NATURAL
 * id without the display `board:` prefix. `assigned_by` is a `users.id`.
 */
export const migration058: Migration = {
  version: 58,
  name: 'observatory-item-assignments',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_item_assignments (
        workgroup_id   TEXT NOT NULL,
        item_id        TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        assigned_at    TEXT NOT NULL,
        assigned_by    TEXT NOT NULL,
        PRIMARY KEY (workgroup_id, item_id)
      );
    `);
  },
};
