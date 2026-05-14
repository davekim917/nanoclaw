import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Thread-level walkie-talkie state for the cross-bot collaboration protocol.
 *
 * When two sibling agents (e.g. `illie` and `illie-codex`) are wired to the
 * same channel and the user asks them to collaborate in a thread, each
 * outbound chat message can end with one of these trailers:
 *
 *   [over]  — "I'm passing the baton; sibling please continue."
 *             Router auto-routes the platform-echo of this bot's outbound to
 *             siblings even if their engage_pattern wouldn't match.
 *
 *   [out]   — "We're done. Don't auto-fire anyone on bot-authored echoes
 *             until the user sends a new message."
 *
 * The default state for a thread is `active` (auto-routing follows the
 * normal pattern/mention rules). `closed` is set when any agent emits
 * `[out]`; it resets to `active` on the next user-authored inbound message
 * in the same thread.
 *
 * Key shape: (messaging_group_id, thread_id) — DMs collapse to the
 * messaging_group_id alone and use thread_id='' as a sentinel.
 */
export const migration034: Migration = {
  version: 34,
  name: 'walkie-talkie-state',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_walkie_state (
        messaging_group_id TEXT NOT NULL,
        thread_id          TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (messaging_group_id, thread_id)
      );
    `);
  },
};
