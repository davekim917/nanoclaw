import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Groups root posts by agent-named INCIDENT rather than UTC day (048): one top-level post per `send_message({
 * thread_key })` key, repeats in its thread across midnight. Keyed by agent group, not session, so a recreated task
 * session keeps threading open incidents; and per messaging group, because two adapter instances on one conversation
 * are separate rows with separate bot identities. `created_at` is informational; keys unused past the retention
 * window are absent and pruned on write. No FK, as in 048.
 */
export const migration081: Migration = {
  version: 81,
  name: 'thread-key-anchors',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_key_anchors (
        agent_group_id      TEXT NOT NULL,
        messaging_group_id  TEXT NOT NULL,
        thread_key          TEXT NOT NULL,
        thread_platform_id  TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        last_used_at        TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, messaging_group_id, thread_key)
      );
    `);
  },
};
