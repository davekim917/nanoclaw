import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 062 — thread_titles
 *
 * Durable idempotency + retry state for Discord thread topic-titling
 * (src/topic-title.ts). Closes two bugs:
 *
 *  1. `maybeRenameNewThread`'s only idempotency guard was an in-process
 *     `Set` — reset on every host restart, and blind to
 *     storage-manager's session archival (`SESSION_ARTIFACT_IDLE_HOURS`),
 *     which deliberately lets an idle thread's next message create a fresh
 *     session row. That "new session" trips the router's `created && wake`
 *     gate again and re-titles an already-titled thread off a FOLLOW-UP
 *     message instead of the original one.
 *  2. `callHaiku`'s single immediate retry landed both attempts in the same
 *     429 window, silently losing the title forever with nothing persisted
 *     to retry from.
 *
 * `first_message` is the load-bearing column: a retry must regenerate from
 * the ORIGINAL opening message of the thread, never a later follow-up —
 * regenerating from a follow-up is the exact bug being fixed.
 *
 * `channel_type` is NOT part of the spec's minimal shape but is required in
 * practice: `@chat-adapter/discord`'s `encodeThreadId` hardcodes a literal
 * `discord:` prefix on every thread id regardless of which bot instance
 * produced it (verified in
 * node_modules/@chat-adapter/discord/dist/index.js), so `thread_id` alone
 * cannot tell a sibling-bot thread (`discord-<suffix>`) from the primary
 * bot's. Without a stored channel_type, the host-sweep retry step (which has
 * no live router event to read it from) would resolve the wrong bot token —
 * or silently fall back to the primary bot — for every sibling-bot retry.
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
