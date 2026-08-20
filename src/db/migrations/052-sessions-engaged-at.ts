import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `sessions.engaged_at` — the explicit record that an agent actually engaged
 * in this session's thread, as opposed to the session row merely existing.
 *
 *   NULL  — the row exists but no agent has engaged here. Under the router's
 *           non-engaged skip (see `src/router.ts`) this is rarer than it used
 *           to be, but it still happens for every case the skip refuses:
 *           attachments present, non-per-thread session mode, adapters with
 *           no `fetchThreadHistory`, threads disabled, archive write failed.
 *   SET   — an agent genuinely engaged: a mention, a wake, or an inbound
 *           agent-to-agent message. Stamped at the moment of engagement by
 *           `markSessionEngaged` (`src/db/sessions.ts`), first-write-wins, so
 *           the value is "when this thread first engaged", never inferred
 *           after the fact.
 *
 * Two readers depend on set-versus-NULL being unambiguous:
 *   - `mention-sticky` engagement, which used to read session EXISTENCE as
 *     "the agent is already in this thread". That conflation is what minted
 *     phantom sessions; the column makes the fact explicit instead.
 *   - the thread-history backfill (`src/thread-context.ts`), whose whole rule
 *     is "NULL ⇒ this session has unbackfilled thread history ⇒ replay the
 *     thread from the top", regardless of which door the wake came through.
 *
 * ── The backfill below is a RECONSTRUCTION, not a record. ──
 * Rows created after this migration carry a true stamp taken at the moment of
 * engagement. Rows that predate it carry the best proxy available from central
 * data: the same three-way signal the dashboard already uses for "engaged".
 * `last_outbound_at IS NOT NULL` catches sessions that posted something;
 * `container_status <> 'stopped'` catches the ones that were genuinely woken,
 * did work, and never posted — backfilling from `last_outbound_at` alone would
 * silently strip those threads of mention-sticky status. For rows matched only
 * by the container arm, `last_outbound_at` is NULL, so we fall back to
 * `last_active` and then `created_at`: a matched row is never left NULL,
 * because the entire value of the column is that NULL means one thing.
 *
 * A future reader must NOT treat a backfilled value as evidence of when
 * engagement actually happened. The imprecision is self-healing — any thread
 * that gets re-engaged is stamped for real — which is why this stays a pure
 * central-DB UPDATE. Do not "improve" it by opening per-session `inbound.db`
 * files looking for `trigger=1` rows; that is thousands of file opens to
 * refine a value that corrects itself on next use.
 */
export const migration052: Migration = {
  version: 52,
  name: 'sessions-engaged-at',
  up: (db: Database.Database) => {
    db.exec('ALTER TABLE sessions ADD COLUMN engaged_at TEXT');
    // container_status is nullable with a 'stopped' default, so COALESCE it —
    // a bare `<> 'stopped'` evaluates to NULL (not true) on a NULL row and
    // would silently skip it.
    db.exec(`
      UPDATE sessions
         SET engaged_at = COALESCE(last_outbound_at, last_active, created_at)
       WHERE last_outbound_at IS NOT NULL
          OR COALESCE(container_status, 'stopped') <> 'stopped'
    `);
  },
};
