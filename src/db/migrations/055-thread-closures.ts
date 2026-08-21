/**
 * Migration 055 — thread closure: `thread_closures` + `sessions.done_proposal`
 *
 * The Observatory had a Dismiss action that archived a thread: it hid the row
 * from the operator and never stopped the agent, so work kept running unseen.
 * It was removed because hiding running work is a blindness switch. These two
 * stores back the replacement — a close that actually ends the work.
 *
 * ## `sessions.done_proposal`
 *
 * A read-side MIRROR of the container's own `session_state.done_proposal`
 * record (`container/agent-runner/src/db/session-state.ts`), refreshed by the
 * host sweep off the outbound.db handle it already holds.
 *
 * It exists only because of where the console reads from. The proposal is
 * container-owned state living in a per-session SQLite file, and the thread
 * list would have to open one file per row to see it — the single most
 * expensive thing on that path, which `api/threads.ts` goes to some length to
 * avoid. Mirroring it onto the row the list already selects makes the flag
 * free; the cost is up to one sweep interval of staleness, which is acceptable
 * for a display flag and is NOT acceptable for the close decision — that path
 * re-reads the container's own copy for the one thread it is acting on.
 *
 * Nothing but the mirror writes this column, and the mirror only ever copies
 * what `propose_done` wrote. There is no host-side path that can invent one.
 *
 * ## `thread_closures`
 *
 * A close is not one write. It asks the agent to wrap up, waits for it to
 * confirm, clears its saved work, stops its container and only then archives —
 * so the operator's intent has to survive the container it is ending, and a
 * host restart in the middle of it. That is a durable row, not in-process
 * state.
 *
 * Keyed on `thread_id` because a close is a decision about a THREAD (§3.1: a
 * thread is N sessions, one per participating agent) and there may be only one
 * in flight at a time. `session_ids` freezes the fan-out at request time: an
 * agent that joins the thread after the operator decided was not part of what
 * they closed. No FK on `thread_id` — a thread is not a table.
 *
 * `state` is the three-step sequence, not a status label:
 *   `awaiting_confirmation` → the wrap-up went out, the agent has not answered
 *   `finalizing`            → the decision is made (confirmed, or the window
 *                             elapsed); continuations cleared, containers
 *                             stopping, sessions archiving
 *   `closed`                → every session in the fan-out is archived
 *
 * `forced` records that the finalize ran without the agent's confirmation —
 * the only case in which the host clears a `work_continuation` the container
 * normally owns. It is kept because "we ended work an agent still believed it
 * had" is exactly the thing a later reader needs to be able to find.
 *
 * Every timestamp here is written from JS as `new Date().toISOString()`, so
 * this table needs nothing from migration 053's naive-timestamp normalizer.
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
