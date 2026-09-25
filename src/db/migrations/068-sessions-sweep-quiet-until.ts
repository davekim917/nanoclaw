import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `sessions.sweep_quiet_until` — the host sweep's quiet mark, made durable.
 *
 * The sweep skips a fully-quiet session (no container, nothing due, no work
 * continuation) until the earlier of its next scheduled row and a jittered
 * backoff cap. That mark lived only in a process-local `Map`, so every host
 * restart threw the whole cache away and the first tick after a boot swept
 * every active session — ~850 of them, a ~450 s tick, nine times in the 22
 * hours of log examined. This column is where the mark now
 * survives the restart; `startHostSweep` warms the map from it.
 *
 * ISO-8601 UTC, the same shape as `last_active` and `last_outbound_at`, so the
 * warm query can compare the two with `datetime()` on both sides.
 *
 * Nullable with no backfill, and NULL means exactly what it means today: no
 * mark, sweep this session. There is nothing to reconstruct — the value is a
 * *prediction* computed against a per-session `inbound.db` read
 * (`getNextFutureProcessAfter`), and a migration must not open those files to
 * invent one (migration 052's header states the rule). Every row starts NULL
 * and takes a real mark the first tick it is found quiet, which is one
 * ordinary cold sweep — precisely the behavior this column then removes.
 *
 * ── The invalidation contract this column depends on ──
 * A mark must never outlive a change to when the session next has work due.
 * Two writers clear it, and only two: `updateSession` (src/db/sessions.ts)
 * nulls it in the same statement that writes `last_active`, and
 * `withQuietInvalidationSync` — REQUIRED immediately before any write that
 * changes due-ness (task insert, `process_after` edit, recurrence re-arm), in
 * the same synchronous turn as that write — does the same and additionally
 * refuses when no ACTIVE session row matched. A future writer that sets
 * `last_active` with raw SQL somewhere else would silently reintroduce the
 * defect.
 */
export const migration068: Migration = {
  version: 68,
  name: 'sessions-sweep-quiet-until',
  up: (db: Database.Database) => {
    db.exec('ALTER TABLE sessions ADD COLUMN sweep_quiet_until TEXT');
  },
};
