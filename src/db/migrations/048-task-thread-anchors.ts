/**
 * Migration 048 — task_thread_anchors
 *
 * Fleet-hardening Phase 1.4: a recurring task session posts to the same
 * destination on every fire, but each fire is a fresh turn with a fresh
 * `in_reply_to` — so the existing per-turn root-post anchor (delivery.ts's
 * in-memory `chatThreadAnchor`, keyed by session + in_reply_to) resets every
 * fire and every fire mints a brand-new top-level post (and, on Slack, a
 * brand-new thread every wired sibling has to re-notice). This table
 * persists the anchor ACROSS fires instead, keyed by (session, destination),
 * so a series stays in one rolling thread until it rotates (default: UTC
 * day change — see `anchorRotationKey` in `../task-thread-anchors.ts`).
 *
 * Host-owned, central DB: the platform thread id only exists after the
 * adapter's first send, so it's recorded delivery-side from the send
 * result, not by the container. One row per (session, destination) — a task
 * session could in principle post to more than one destination.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration048: Migration = {
  version: 48,
  name: 'task-thread-anchors',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_thread_anchors (
        session_id          TEXT NOT NULL,
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        thread_platform_id  TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, channel_type, platform_id)
      );
    `);
  },
};
