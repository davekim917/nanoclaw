/**
 * Observatory "snooze until it moves". Not client state (a snooze lost on reload makes the operator believe the
 * thread is handled) and not archive (`archived_at` means DONE and nothing un-archives on activity). The row records
 * the thread's activity stamp at snooze time and expires by comparison, with no sweep or timer; nullable so a thread
 * with no activity is snoozeable too. Keyed by (thread_id, user_id): one operator's triage, never a fleet-wide hide.
 * No FK: a thread is a group of sessions, not a table, and a stale row is inert.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration054: Migration = {
  version: 54,
  name: 'thread-snoozes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_snoozes (
        thread_id           TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        snoozed_at_activity TEXT,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (thread_id, user_id)
      );
    `);
  },
};
