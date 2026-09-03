/**
 * Read-only session access for the host's operator surfaces.
 *
 * `withExistingMailboxSession` is the default for a caller that only reads
 * (invariant I-4: reads never provision). It is NOT the right funnel for the
 * dashboard, and this file is that exception, stated once:
 *
 *  - `session()` opens inbound.db READ-WRITE and, on the first touch of a path
 *    in a process, runs the legacy migrations (`migrateMessagesInTable` plus
 *    the fork's `ensureNanoclawInboundSchema`). That is DDL. A dashboard
 *    request fans out across EVERY session in the fleet, including ones this
 *    host has never opened and ones that are mid-reclaim; a console poll must
 *    not be what migrates them, and must never write to a session it is only
 *    listing.
 *  - The board's opens are `{ readonly: true }` with a 1s busy_timeout, not
 *    the write path's 5s — a slow session must degrade to `unreadable` on that
 *    request, never hold the console's event loop for five seconds per file.
 *
 * So the operator surfaces get a genuinely read-only session: a `readonly`
 * handle (SQLite itself refuses a write), no schema-ensure, no migration memo,
 * no storage-activity marker, and no provisioning of any kind. A session whose
 * file is gone answers `undefined`; a session whose file is present but
 * unreadable THROWS, so the caller's per-session catch can count it unreadable
 * rather than silently reporting healthy-and-empty.
 *
 * These helpers are synchronous. `better-sqlite3` is synchronous, the ops are
 * single statements, and the surfaces that call them (`readContainerState`,
 * the board's per-session assembly) are synchronous today — making them async
 * would ripple through the dashboard for no behavior gained.
 *
 * See docs/specs/upstream-mailbox-seam/plan.md §4.2, §4.8 I-4.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getContainerState, getProcessingClaims, type ContainerState, type ProcessingClaim } from './ops/sweep.js';
import { inboundHasMessage } from './ops/ingress.js';
import {
  getLatestSeriesRow,
  getLatestTaskRow,
  getLiveSeriesRow,
  getLiveTaskRow,
  hasWorkContinuation,
  latestReplyTimestampByTrigger,
  listDuplicateLiveTaskSeriesIds,
  listLatestRecurringSeriesRows,
  listLiveOneOffTaskRows,
  listLiveTaskRows,
  listLiveTaskRowsForSeries,
  listOutboundSystemMessages,
  listProcessingClaimedMessageIds,
  listRecentTaskFires,
  listTurnUsageSince,
  type OutboundSystemRow,
  type ScheduledTaskRow,
  type SessionTurnUsageRow,
  type TaskFireRow,
} from './ops/reads.js';
import { recoverHotJournal, sessionDbPathIsGone } from './openers.js';

/**
 * Which session to read, and where its data lives.
 *
 * `dataDir` overrides the install's `DATA_DIR`. The scheduled board threads an
 * injected fixture root through its whole read path (its `ReadOptions` test
 * seam) and `DATA_DIR` is a module constant with no env override, so without
 * this the board's suites would read and write the live install's data
 * directory. Production callers omit it.
 */
export interface SessionReadLocation {
  agentGroupId: string;
  sessionId: string;
  dataDir?: string;
}

export interface SessionReadOptions {
  /**
   * `busy_timeout` for the read handle. Defaults to the dashboard's 1s: a
   * board request opens every session in the fleet and a contended one must
   * degrade to `unreadable` on that request rather than stall the console.
   * Callers reading a single named session pass the write path's 5000.
   */
  busyTimeoutMs?: number;
  /**
   * Roll a hot journal back before opening.
   *
   * A rollback is a WRITE, so it is off by default: a fleet-wide console read
   * must not write to sessions it is merely listing. The one caller that turns
   * it on is the steer write path's pre-write probe, which owns that session's
   * write anyway and whose read would otherwise fail permanently on any
   * session whose host write was interrupted.
   */
  recoverJournal?: boolean;
}

/** The ops a read-only session exposes. Reads only — by construction. */
export interface InboundSessionRead {
  inboundHasMessage(messageId: string): boolean;
  listDuplicateLiveTaskSeriesIds(): string[];
  listLatestRecurringSeriesRows(): ScheduledTaskRow[];
  listLiveOneOffTaskRows(): ScheduledTaskRow[];
  listLiveTaskRows(): ScheduledTaskRow[];
  listLiveTaskRowsForSeries(seriesId: string): ScheduledTaskRow[];
  getLiveSeriesRow(seriesId: string): ScheduledTaskRow | null;
  getLatestSeriesRow(seriesId: string): ScheduledTaskRow | null;
  getLiveTaskRow(seriesId: string): ScheduledTaskRow | null;
  getLatestTaskRow(seriesId: string): ScheduledTaskRow | null;
  listRecentTaskFires(seriesId: string, limit: number): TaskFireRow[];
}

export interface OutboundSessionRead {
  getContainerState(): ContainerState | null;
  getProcessingClaimRows(): ProcessingClaim[];
  listProcessingClaimedMessageIds(): string[];
  hasWorkContinuation(): boolean;
  latestReplyTimestampByTrigger(): Map<string, string>;
  listOutboundSystemMessages(): OutboundSystemRow[];
  listTurnUsageSince(afterId: number): SessionTurnUsageRow[];
}

export type { ContainerState, OutboundSystemRow, ProcessingClaim, ScheduledTaskRow, SessionTurnUsageRow, TaskFireRow };

/**
 * Resolve one side of a session's mailbox under `dataDir`, with the same
 * canonicalize-and-contain check the board's `:key` open site has always
 * applied: the resolved path must be EXACTLY
 * `<dataDir>/v2-sessions/<agentGroupId>/<sessionId>/<side>.db` and must stay
 * strictly inside the v2-sessions base. A locator that resolves anywhere else
 * is not a session, and `null` here reads as "no mailbox" at every caller.
 */
function resolveReadPath(location: SessionReadLocation, side: 'inbound' | 'outbound'): string | null {
  const base = path.resolve(location.dataDir ?? DATA_DIR, 'v2-sessions');
  const resolved = path.resolve(base, location.agentGroupId, location.sessionId, `${side}.db`);
  const expected = path.join(base, location.agentGroupId, location.sessionId, `${side}.db`);
  return resolved === expected && resolved.startsWith(base + path.sep) ? resolved : null;
}

function openRead(dbPath: string, options: SessionReadOptions): Database.Database {
  if (options.recoverJournal) recoverHotJournal(dbPath);
  const db = new Database(dbPath, { readonly: true });
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 1000}`);
  return db;
}

/**
 * Read a session's inbound.db, or `undefined` when it has no mailbox.
 *
 * `undefined` means ABSENT, and only absent — a present-but-unreadable file
 * throws, because "I could not read it" and "there is nothing there" are
 * different answers and an operator surface that collapses them reports a
 * broken session as an empty one.
 */
export function readSessionInbound<T>(
  location: SessionReadLocation,
  action: (session: InboundSessionRead) => T,
  options: SessionReadOptions = {},
): T | undefined {
  const dbPath = resolveReadPath(location, 'inbound');
  if (dbPath === null || sessionDbPathIsGone(dbPath)) return undefined;
  const db = openRead(dbPath, options);
  try {
    return action({
      inboundHasMessage: (messageId) => inboundHasMessage(db, messageId),
      listDuplicateLiveTaskSeriesIds: () => listDuplicateLiveTaskSeriesIds(db),
      listLatestRecurringSeriesRows: () => listLatestRecurringSeriesRows(db),
      listLiveOneOffTaskRows: () => listLiveOneOffTaskRows(db),
      listLiveTaskRows: () => listLiveTaskRows(db),
      listLiveTaskRowsForSeries: (seriesId) => listLiveTaskRowsForSeries(db, seriesId),
      getLiveSeriesRow: (seriesId) => getLiveSeriesRow(db, seriesId),
      getLatestSeriesRow: (seriesId) => getLatestSeriesRow(db, seriesId),
      getLiveTaskRow: (seriesId) => getLiveTaskRow(db, seriesId),
      getLatestTaskRow: (seriesId) => getLatestTaskRow(db, seriesId),
      listRecentTaskFires: (seriesId, limit) => listRecentTaskFires(db, seriesId, limit),
    });
  } finally {
    db.close();
  }
}

/** Read a session's outbound.db, or `undefined` when it has no mailbox. */
export function readSessionOutbound<T>(
  location: SessionReadLocation,
  action: (session: OutboundSessionRead) => T,
  options: SessionReadOptions = {},
): T | undefined {
  const dbPath = resolveReadPath(location, 'outbound');
  if (dbPath === null || sessionDbPathIsGone(dbPath)) return undefined;
  const db = openRead(dbPath, options);
  try {
    return action({
      getContainerState: () => getContainerState(db),
      getProcessingClaimRows: () => getProcessingClaims(db),
      listProcessingClaimedMessageIds: () => listProcessingClaimedMessageIds(db),
      hasWorkContinuation: () => hasWorkContinuation(db),
      latestReplyTimestampByTrigger: () => latestReplyTimestampByTrigger(db),
      listOutboundSystemMessages: () => listOutboundSystemMessages(db),
      listTurnUsageSince: (afterId) => listTurnUsageSince(db, afterId),
    });
  } finally {
    db.close();
  }
}
