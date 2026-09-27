/**
 * Persists a recurring task's root-post anchor ACROSS fires, keyed by (session, destination): each fire is a fresh
 * turn, so the per-turn anchor would mint a new top-level post every time. The series stays in one thread until it
 * rotates (`anchorRotationKey`). Recorded delivery-side, since the platform thread id exists only after the first
 * send.
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
