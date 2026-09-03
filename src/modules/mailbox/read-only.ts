/**
 * The module's existing-only session funnels — the three ways to reach ONE
 * session's storage without provisioning it.
 *
 * Two are read-only (`readSessionInbound`, `readSessionOutbound`) and one
 * writes (`withExistingNanoclawOutbound`, the thread-close force-clear). They
 * live together because they share the same absence rule and the same
 * classified openers via `withOpenedSessionDb`; only which opener, and whether
 * the handle can write, differs. The read-only rationale below governs the
 * first two.
 *
 * (Filename is narrower than the contents now. PR 4's round 4 introduces its
 * own outbound-ops module and these converge there, so renaming this file now
 * would only manufacture a conflict for that merge.)
 *
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
 * These helpers do NOT reuse the module's read-write funnels wholesale, and
 * `readSessionInbound` in particular must not: `openInboundDb` opens
 * READ-WRITE (no `readonly`), sets `journal_mode = DELETE` — a write to the
 * header — and plants a storage-activity marker whose lifetime is the
 * handle's. A console request fans out across every session in the fleet, so
 * routing it there would write to every session it merely lists and would
 * churn a reclaim-blocking marker per session per poll. What the two funnels
 * share is the FAILURE CLASSIFICATION (`assertQueryable`, below), which is the
 * part that was genuinely forked.
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
  countLiveSeriesRows,
  getLatestSeriesRow,
  getLatestTaskDeliveryRoute,
  getLatestTaskRoutingStamp,
  getLatestTaskRow,
  getLiveSeriesRow,
  getLiveTaskRow,
  hasPendingRecurrence,
  hasTriggeredInboundRow,
  hasWorkContinuation,
  latestInboundMessageId,
  latestReplyTimestampByTrigger,
  listDuplicateLiveTaskSeriesIds,
  listInboundTail,
  listLatestRecurringSeriesRows,
  listLiveOneOffTaskRows,
  listLiveTaskRows,
  listLiveTaskRowsForSeries,
  listOutboundSystemMessages,
  listOutboundTail,
  listProcessingClaimedMessageIds,
  listRecentTaskFires,
  listTurnUsageSince,
  type MessageTailRow,
  type OutboundSystemRow,
  type ScheduledTaskRow,
  type SessionTurnUsageRow,
  type TaskDeliveryRoute,
  type TaskFireRow,
  type TaskRoutingStamp,
} from './ops/reads.js';
import {
  assertQueryable,
  asMissingDbError,
  recoverHotJournal,
  SessionDbMissingError,
  sessionDbPathIsGone,
} from './openers.js';
import { sessionMailboxPath } from '../../mailbox/sqlite/paths.js';

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
   * must not write to sessions it is merely listing.
   *
   * The rule for turning it on is the seam's rule everywhere — restate what
   * the open being replaced did, and no more. Pass it wherever that open was
   * READ-WRITE (a read-write open always rolls a hot journal back on the way
   * in) or recovered one explicitly; leave it off wherever the old open was a
   * bare `readonly` handle, which never did. Do not add it to a new caller on
   * the theory that recovery is harmless: without a replaced open to restate,
   * it is a console read writing to a session it is only inspecting.
   *
   * Every caller that passes it today reads a single named session the caller
   * already owns or is about to write, never a fleet fan-out.
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
  latestInboundMessageId(): string | null;
  hasPendingRecurrence(): boolean;
  hasTriggeredInboundRow(): boolean;
  listInboundTail(limit: number): MessageTailRow[];
  countLiveSeriesRows(seriesId: string): number;
  getLatestTaskRoutingStamp(seriesId: string): TaskRoutingStamp | null;
  getLatestTaskDeliveryRoute(): TaskDeliveryRoute | null;
}

export interface OutboundSessionRead {
  getContainerState(): ContainerState | null;
  getProcessingClaimRows(): ProcessingClaim[];
  listProcessingClaimedMessageIds(): string[];
  hasWorkContinuation(): boolean;
  latestReplyTimestampByTrigger(): Map<string, string>;
  listOutboundSystemMessages(): OutboundSystemRow[];
  listTurnUsageSince(afterId: number): SessionTurnUsageRow[];
  listOutboundTail(limit: number): MessageTailRow[];
}

export type {
  ContainerState,
  MessageTailRow,
  OutboundSystemRow,
  ProcessingClaim,
  ScheduledTaskRow,
  SessionTurnUsageRow,
  TaskDeliveryRoute,
  TaskFireRow,
  TaskRoutingStamp,
};

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

/**
 * Open one side read-only, with the SAME failure classification the module's
 * read-write funnels apply.
 *
 * `assertQueryable` is the shared half: a handle that constructs but cannot
 * answer `SELECT 1 FROM sqlite_master` is a present-but-unopenable DB, and it
 * raises `SessionDbUnopenableError` here exactly as it does through
 * `openInboundDb`/`openOutboundDb`. Before this, the read path constructed a
 * handle and handed it out unprobed, so the same corrupt file was a silent
 * empty read on one funnel and a classified error on the other — one behavior
 * with two answers, which is the fork this closes.
 *
 * What is deliberately NOT shared is the part that writes. `openOutboundDb`
 * recovers a hot journal unconditionally; a rollback is a write, and a
 * fleet-wide console read must not perform one on every session it lists, so
 * it stays opt-in through `recoverJournal`. Callers that own the session's
 * write anyway (the steer probe, the usage rollup) pass it and get byte-for-byte
 * the read-write funnel's behavior.
 */
function openRead(dbPath: string, options: SessionReadOptions): Database.Database {
  if (options.recoverJournal) recoverHotJournal(dbPath);
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 1000}`);
  } catch (err) {
    // The construction half. better-sqlite3 opens eagerly, so a mode-000 file
    // or an exhausted descriptor table fails HERE, not at the first query —
    // classifying only post-construction failures would have left the common
    // case raising a raw SqliteError on this funnel and a classified one on
    // the read-write funnels.
    db?.close();
    throw asMissingDbError(err, dbPath);
  }
  assertQueryable(db, dbPath);
  return db;
}

/**
 * `openRead`, with a vanished file answered as absence rather than an error.
 *
 * The public contract is "`undefined` means ABSENT, and only absent". The
 * `sessionDbPathIsGone` pre-check answers that for every ordinary case, and
 * this closes the race where the file is removed between that check and the
 * open — which classifies as `SessionDbMissingError` and is still, honestly,
 * absence. A present-but-unopenable DB keeps throwing.
 */
function openReadOrAbsent(dbPath: string, options: SessionReadOptions): Database.Database | undefined {
  try {
    return openRead(dbPath, options);
  } catch (err) {
    if (err instanceof SessionDbMissingError) return undefined;
    throw err;
  }
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
  const db = openReadOrAbsent(dbPath, options);
  if (!db) return undefined;
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
      latestInboundMessageId: () => latestInboundMessageId(db),
      hasPendingRecurrence: () => hasPendingRecurrence(db),
      hasTriggeredInboundRow: () => hasTriggeredInboundRow(db),
      listInboundTail: (limit) => listInboundTail(db, limit),
      countLiveSeriesRows: (seriesId) => countLiveSeriesRows(db, seriesId),
      getLatestTaskRoutingStamp: (seriesId) => getLatestTaskRoutingStamp(db, seriesId),
      getLatestTaskDeliveryRoute: () => getLatestTaskDeliveryRoute(db),
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
  const db = openReadOrAbsent(dbPath, options);
  if (!db) return undefined;
  try {
    return action({
      getContainerState: () => getContainerState(db),
      getProcessingClaimRows: () => getProcessingClaims(db),
      listProcessingClaimedMessageIds: () => listProcessingClaimedMessageIds(db),
      hasWorkContinuation: () => hasWorkContinuation(db),
      latestReplyTimestampByTrigger: () => latestReplyTimestampByTrigger(db),
      listOutboundSystemMessages: () => listOutboundSystemMessages(db),
      listTurnUsageSince: (afterId) => listTurnUsageSince(db, afterId),
      listOutboundTail: (limit) => listOutboundTail(db, limit),
    });
  } finally {
    db.close();
  }
}

