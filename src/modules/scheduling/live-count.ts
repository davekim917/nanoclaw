/**
 * Scoped live-row count for a scheduled series, shared by the move flow and
 * the sweep's move recovery. Scoped to named sessions: a fleet-wide series_id
 * scan over-counts an unrelated group reusing the id.
 *
 * Fail-safe: if ANY named session's inbound.db exists but can't be read, the
 * result is `unreadable` and callers MUST NOT restore (a double live row).
 * An ABSENT inbound.db contributes 0. Recovery relies on session DBs using
 * `journal_mode=DELETE`, so a read-only count right after a restore sees it.
 */
import { readSessionInbound } from '../mailbox/index.js';

export interface SessionLocator {
  agentGroupId: string;
  sessionId: string;
}

export interface LiveCountResult {
  count: number;
  unreadable: boolean;
}

/** Count live (pending|paused) rows for `seriesId` across exactly `locators`; null locators are skipped. */
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
      // `undefined` = no mailbox there → 0; a present-but-unreadable file throws.
      count += readSessionInbound({ ...loc, dataDir }, (mailbox) => mailbox.countLiveSeriesRows(seriesId)) ?? 0;
    } catch {
      // Never let unknown read as "0 live rows" and trigger a restore.
      unreadable = true;
    }
  }

  return { count, unreadable };
}
