import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Durable idempotency and retry state for Discord thread titling (src/topic-title.ts). An in-process guard is reset
 * by restarts and blind to session archival, which lets a follow-up message re-title an already-titled thread; and an
 * immediate 429 retry lost titles with nothing to retry from.
 * `first_message` is load-bearing: a retry must regenerate from the ORIGINAL opening message, never a follow-up.
 * `channel_type` is required because `@chat-adapter/discord` prefixes every thread id `discord:` whatever the bot
 * instance, so without it the sweep's retry would resolve the wrong bot token for a sibling bot.
 */
export const migration062: Migration = {
  version: 62,
  name: 'thread-titles',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_titles (
        thread_id     TEXT PRIMARY KEY,
        channel_type  TEXT NOT NULL,
        title         TEXT,            -- NULL until a title is successfully applied
        first_message TEXT NOT NULL,   -- the ORIGINAL opening message, captured once
        attempts      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        titled_at     TEXT             -- NULL until applied
      );
      CREATE INDEX IF NOT EXISTS idx_thread_titles_retry ON thread_titles(title, attempts);
    `);
  },
};
