/**
 * Shared scoped live-row count for a scheduled series (QA-fix H1).
 *
 * The move flow's compensation/invariant (scheduled-move.ts) and the sweep's
 * recovery (host-sweep.ts) both need to ask "how many live (pending|paused)
 * task rows exist for this series across a SPECIFIC set of sessions?" — not a
 * bare-series_id fleet-wide scan (which over-counts an unrelated group that
 * happens to reuse the same series_id, the M1 false-resolve). This is the one
 * shared, scoped, fail-safe counter both callers route through.
 *
 * Fail-safe (F6 / M2): if ANY named session's inbound.db exists but can't be
 * read, the whole count is `unreadable=true`. Callers MUST treat unreadable as
 * "live state UNKNOWN" and NEVER restore (restoring on unknown risks a double
 * live row). A locator whose inbound.db is simply ABSENT contributes 0 and is
 * NOT unreadable — a missing target session legitimately means no insert
 * landed there.
 *
 * Opens go through the module's read-only session, which is { readonly: true }
 * + busy_timeout 1000 by default (the board read-path precedent — never the
 * write path's 5000ms; M2 hygiene / ADV-S3) and can neither provision nor
 * migrate a session it is only counting.
 *
 * DEPENDENCY: the recovery idempotency story (host-sweep.ts recoverMoveIntents)
 * relies on `journal_mode=DELETE` on session DBs — a readonly count opened right
 * AFTER a writable restore must observe the committed row. Under WAL that
 * after-write visibility guarantee changes and the re-check semantics would need
 * re-verification. DELETE is load-bearing (container/agent-runner connection.ts).
 */
import { readSessionInbound } from '../mailbox/index.js';

export interface SessionLocator {
  agentGroupId: string;
  sessionId: string;
}

export interface LiveCountResult {
  count: number;
  /** True if ANY existing session's inbound.db threw on read → live state UNKNOWN. */
  unreadable: boolean;
}

/**
 * Count live (pending|paused) task rows for `seriesId` across exactly the named
 * `locators`. Null locators are skipped (e.g. a target session not yet
 * resolved). Returns `{ count, unreadable }` per the fail-safe contract above.
 */
export function countLiveRowsInSessions(
  dataDir: string,
  locators: Array<SessionLocator | null>,
  seriesId: string,
): LiveCountResult {
  let count = 0;
  let unreadable = false;

  for (const loc of locators) {
    if (!loc) continue;
    try {
      // `undefined` = no mailbox at that locator → contributes 0, NOT
      // unreadable: a missing target session legitimately means no insert
      // landed there. A present-but-unreadable file throws instead, which is
      // what taints the result below.
      count += readSessionInbound({ ...loc, dataDir }, (mailbox) => mailbox.countLiveSeriesRows(seriesId)) ?? 0;
    } catch {
      // Existent-but-unreadable → live state UNKNOWN. Taint the whole result so
      // callers never silently treat it as "0 live rows" and restore.
      unreadable = true;
    }
  }

  return { count, unreadable };
}
