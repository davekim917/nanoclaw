/**
 * Migration 054 — thread_snoozes
 *
 * The Observatory console's triage mode has three verdicts, and one of them
 * ("snooze until it moves") had no store at all. Client-side state was not an
 * option: a snooze that evaporates on reload is worse than no snooze, because
 * the operator believes the thread is handled.
 *
 * Archive was the other candidate and it is the wrong one. `archived_at` means
 * DONE (DESIGN.md §5 computes the `done` state from exactly that column), and a
 * snoozed thread is the opposite — it is work that should come back the moment
 * it moves. Reusing archive would both lie about the state and strand the
 * thread, since nothing un-archives on activity.
 *
 * So the snooze records the thread's activity stamp AT THE MOMENT OF SNOOZING,
 * and expires by comparison rather than by a timer: the thread is snoozed for
 * exactly as long as `last_activity_at` has not moved past
 * `snoozed_at_activity`. No sweep, no `process_after` row, no clock. Nullable
 * because a thread with no activity at all is snoozeable too — such a row
 * un-snoozes on its first activity, which is the same rule.
 *
 * Keyed by (thread_id, user_id): a snooze is one operator's triage decision
 * about their own queue, never a fleet-wide hide. There is no FK on either
 * column — `thread_id` is not a table (a thread is a GROUP of sessions, §3.1),
 * and a stale row for a thread that no longer exists is inert: the read joins
 * against the page's thread ids and simply never matches.
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
