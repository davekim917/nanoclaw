/**
 * Backs a thread close that actually ends the work.
 * `sessions.done_proposal` is a read-side MIRROR of the container's `session_state.done_proposal`, refreshed by the
 * host sweep, so the thread list need not open one file per row. Up to one sweep interval stale, which is fine for a
 * display flag and NOT for the close decision, which re-reads the container's own copy. Only the mirror writes it.
 * `thread_closures`: a close spans wrap-up, confirmation, clearing saved work, stopping containers and archiving, so
 * the intent must survive the container it ends and a host restart. One in flight per `thread_id` (no FK: a thread is
 * not a table); `session_ids` freezes the fan-out at request time. `state`: `awaiting_confirmation` → `finalizing` →
 * `closed`. `forced` marks a finalize without the agent's confirmation, the only case the host clears a
 * container-owned `work_continuation`.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration055: Migration = {
  version: 55,
  name: 'thread-closures',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_closures (
        thread_id      TEXT PRIMARY KEY,
        requested_by   TEXT NOT NULL,
        requested_at   TEXT NOT NULL,
        reason         TEXT,
        agent_proposed INTEGER NOT NULL DEFAULT 0,
        session_ids    TEXT NOT NULL,
        state          TEXT NOT NULL DEFAULT 'awaiting_confirmation',
        forced         INTEGER NOT NULL DEFAULT 0,
        closed_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_closures_state ON thread_closures(state);
    `);

    const columns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
    if (!columns.has('done_proposal')) {
      db.exec('ALTER TABLE sessions ADD COLUMN done_proposal TEXT');
    }
  },
};
