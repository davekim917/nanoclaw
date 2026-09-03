/**
 * The fork's `AgentMailbox` implementation.
 *
 * `NanoclawAgentMailbox` extends upstream's `SqliteAgentMailbox` (whose files
 * under `src/mailbox/` are byte-identical to upstream and never edited) with
 * the fork's session-DB behavior: the missing-DB guards and storage-activity
 * marker on the open funnels, the repository-ingress fence, the UPSERT
 * delivery rows, the tiered container-state read, and the fused
 * processing-ack sync. See docs/specs/upstream-mailbox-seam/plan.md §4.2.
 */
import type Database from 'better-sqlite3';

import { sessionMailboxPath } from '../../mailbox/sqlite/paths.js';
import { SqliteAgentMailbox, wrapSqliteInbound, wrapSqliteOutbound } from '../../mailbox/sqlite/index.js';
import { migrateMessagesInTable as upstreamMigrateMessagesInTable } from '../../mailbox/sqlite/session-db.js';
import { parseIsoTimestamp } from '../../mailbox/model.js';
import type {
  ContainerState as UpstreamContainerState,
  InboundMessage,
  MailboxSession,
  MailboxSessionKey,
  SessionRouting as UpstreamSessionRouting,
} from '../../mailbox/types.js';

import {
  SessionDbMissingError,
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  sessionDbPathIsGone,
} from './openers.js';
import { ensureNanoclawInboundSchema, ensureSchema } from './schema.js';
import {
  activateRepoIngressFence,
  admitRepoIngressFenceMessage,
  readRepoIngressFence,
  readRepositoryMountBarrierAck,
  releaseRepoIngressFence,
  type RepoIngressAdmissionResult,
  type RepoIngressFence,
  type RepoIngressReleaseResult,
} from './ops/fence.js';
import {
  inboundHasMessage,
  insertDeferredMessageWithContextIfNew,
  insertMessageIfNew,
  insertMessageWithContext,
  insertMessageWithContextIfNew,
  nextEvenSeq,
  readSessionRouting,
  replaceDestinations,
  runInsertMessage,
  setSessionRoutingSpawnTaskId,
  upsertSessionRouting,
  type DestinationRow,
  type MessageInsert,
  type SessionRouting as ForkSessionRouting,
} from './ops/ingress.js';
import {
  getDueOutboundMessages,
  listOutboundMessageIds,
  outboundStorageStat,
  markDelivered,
  markDeliveryFailed,
  markPending,
  type OutboundMessage as ForkOutboundMessage,
} from './ops/delivery.js';
import {
  getChannelDestination,
  getInboundRoutingAnchor,
  getLatestRoutedTaskRow,
  getLatestTaskContent,
  getRecentInboundChatSenders,
  hasRestartNoteSince,
  type ChannelDestination,
  type InboundChatSenderRow,
  type InboundRoutingAnchor,
  type RoutedTaskRow,
} from './ops/lookups.js';
import { listTurnUsageSince, type SessionTurnUsageRow } from './ops/reads.js';
import {
  admitDueRow,
  admitPendingUpgradeRow,
  deferForFreshContextRetry,
  demoteUnpairedLegacyTasks,
  listDueAdmissionRows,
  listUnpairedPendingUpgradeRows,
  restoreInertTaskSchedule,
  taskPairIsAdmitted,
  type DueAdmissionRow,
  type PendingUpgradeRow,
} from './ops/admission.js';
import {
  armNextTask,
  cancelSeriesWithStrandClear,
  getCliTaskRow,
  getCompletedRecurring,
  getCreatedTaskRow,
  insertRecurrence,
  insertTaskRow,
  listCliTaskSeries,
  listDueTaskRows,
  resolvePendingTask,
  restoreTaskRow,
  resumeTask,
  setPendingTaskContent,
  updateTask,
  upsertTaskSeries,
  type CliTaskRow,
  type CreatedTaskRow,
  type HostGatedTaskRow,
  type RecurringMessage as ForkRecurringMessage,
  type TaskRowInsert,
  type TaskRowSnapshot,
  type TaskUpdate as ForkTaskUpdate,
} from './ops/tasks.js';
import {
  hasMatchingBootstrapRecall,
  listOpenChatContents,
  listRecentRecallRows,
  readProviderRecallState,
  type ProviderRecallState,
} from './ops/recall.js';
import {
  clearWorkContinuation,
  readContinuationPresence,
  readDoneProposal,
  type ContinuationPresence,
  type DoneProposal,
} from './ops/session-state.js';
import {
  countDueMessages,
  expireStalePending,
  getContainerState,
  getDueWakePriority,
  getNextFutureProcessAfter,
  getProcessingClaims,
  syncProcessingAcks,
  type ContainerState as ForkContainerState,
  type ProcessingClaim,
} from './ops/sweep.js';
import {
  canAttemptContinuationRecovery,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './ops/continuation.js';
import {
  countRecoveryAttemptsSinceRealInbound,
  hasDueRecoveryWake,
  hasNonStatusReplyTo,
  latestInboundTimestamp,
  latestOutboundTimestamp,
  latestRecoveryMarkerId,
  latestRecoveryMarkerTimestamp,
  markInboundCompletedIfPending,
  outboundHasContentLike,
  outboundHasRecentContentLike,
  parkDueRecoveryWakes,
  readMessageRouting,
  writeOutboundDirectRow,
  type DirectOutboundRow,
  type InboundMessageRouting,
} from './ops/recovery.js';

export { SessionDbMissingError, SessionDbUnopenableError } from './openers.js';
export { parseSqliteUtc } from './sqlite-utc.js';
export {
  canAttemptContinuationRecovery,
  readWorkContinuation,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  WORK_CONTINUATION_TASK_MAX_CHARS,
  type HostWorkContinuation,
} from './ops/continuation.js';
export type { DirectOutboundRow, InboundMessageRouting } from './ops/recovery.js';
export { INTERACTIVE_WAKE_MAX_AGE_MS, type ContainerState as ForkContainerStateRow } from './ops/sweep.js';
export { readRepoIngressFence } from './ops/fence.js';
export {
  hasMatchingBootstrapRecall,
  listOpenChatContents,
  listRecentRecallRows,
  readProviderRecallState,
  type ProviderRecallState,
} from './ops/recall.js';
export { nextEvenSeq, type DestinationRow, type MessageInsert } from './ops/ingress.js';
export {
  cancelAllTasks,
  cancelTask,
  clearRecurrence,
  deleteTask,
  pauseTask,
  trailingFailedRuns,
} from '../../mailbox/sqlite/tasks.js';
export {
  cancelSeriesWithStrandClear,
  getCompletedRecurring,
  insertRecurrence,
  insertTaskRow,
  restoreTaskRow,
  resumeTask,
  updateTask,
  type CliTaskRow,
  type CreatedTaskRow,
  type HostGatedTaskRow,
  type RecurringMessage,
  type TaskRowInsert,
  type TaskRowSnapshot,
  type TaskUpdate,
} from './ops/tasks.js';
export type { DueAdmissionRow, PendingUpgradeRow } from './ops/admission.js';
export {
  CLOSE_REASON_MAX_CHARS,
  clearWorkContinuation,
  readContinuationPresence,
  readDoneProposal,
  type ContinuationPresence,
  type DoneProposal,
} from './ops/session-state.js';

/**
 * The session directory layout, for callers that only need a PATH.
 *
 * Re-exported from upstream's `sqlite/paths.ts` so no fork file has to reach
 * into the driver directory (and so the layout has one definition). A caller
 * that wants the DATA there opens a mailbox session instead.
 */
export { sessionMailboxDir, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';

/**
 * Read-only session access for the operator surfaces (dashboard, Observatory,
 * the dispatch watchdog). A console read must never provision, migrate or
 * write a session it is only listing — see read-only.ts for why `session()` is
 * the wrong funnel there.
 */
export {
  readSessionInbound,
  readSessionOutbound,
  type InboundSessionRead,
  type OutboundSessionRead,
  type SessionReadLocation,
  type SessionReadOptions,
} from './read-only.js';
export type {
  MessageTailRow,
  OutboundSystemRow,
  ScheduledTaskRow,
  SessionTurnUsageRow,
  TaskDeliveryRoute,
  TaskFireRow,
  TaskRoutingStamp,
} from './ops/reads.js';
export type { ContainerState, ProcessingClaim } from './ops/sweep.js';

/**
 * `(mtime, size)` of a session's outbound.db for the delivery sweep's quiet
 * gate, or `null` when the file must not be armed off (absent, unreadable, or
 * mid-rollback). Path-level rather than a session op: the sweep needs the
 * answer before any handle opens, and for sessions that have no mailbox.
 */
export function sessionOutboundStorageStat(
  agentGroupId: string,
  sessionId: string,
): { mtimeNs: bigint; size: number } | null {
  return outboundStorageStat(sessionMailboxPath({ agentGroupId, sessionId }, 'outbound'));
}

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Mirror of upstream's module-private `sqliteTimestamp` (src/mailbox/sqlite/index.ts).
 * Copied rather than imported because upstream does not export it and its
 * files are never edited; the drift manifest makes any upstream change to it
 * a loud failure at the next sync.
 */
function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

/**
 * The fork's container-state record: upstream's three normalized camelCase
 * fields plus the fork's raw column set (provider health + memory telemetry).
 * A superset of both, so it stays assignable to upstream's `ContainerState`
 * while the fork's sweep keeps reading the snake_case columns.
 */
export interface NanoclawContainerState extends UpstreamContainerState, ForkContainerState {}

/** Insert shapes the fork accepts: its own, or upstream's `InboundWrite`. */
export type NanoclawInboundInsert = MessageInsert | InboundMessage;

/**
 * The mailbox session the fork's actions receive.
 *
 * Extends upstream's `MailboxSession` — every upstream op stays available and
 * keeps upstream's semantics. The members redeclared here are the ones whose
 * fork behavior differs (fence-aware counting, UPSERT delivery rows, the
 * tiered container-state read, routing that maintains the fork's extra
 * columns, an insert that accepts the fork's open `kind` set); the rest are
 * fork-only additions.
 *
 * Ops the fork implements byte-identically to upstream (`markMessageFailed`,
 * `retryWithBackoff`, `getMessageForRetry`, `getDeliveredIds`,
 * `getInboundSourceSessionId`, `getMostRecentPeerSourceSessionId`,
 * `deleteOrphanProcessingClaims`) are deliberately NOT redeclared — upstream's
 * wrapper already provides them, and a second copy would break "one
 * implementation of any SQL statement" (invariant I-2) on purpose.
 */
export interface NanoclawMailboxSession extends MailboxSession {
  // --- upstream members with fork behavior -------------------------------
  /** Writes through the fork upsert, which also maintains spawn_task_id/session_id. */
  setRouting(routing: UpstreamSessionRouting): void;
  /** Fence-aware: epoch-tagged rows are inert and never counted. */
  countDueMessages(): number;
  /** UPSERT over an earlier 'pending'/'failed' row; clears `error`. */
  markDelivered(messageOutId: string, platformMessageId: string | null): void;
  /** UPSERT that records the adapter's error message. */
  markDeliveryFailed(messageOutId: string, errorMessage?: string): void;
  /** Tiered column read: provider health and memory telemetry when present. */
  getContainerState(): NanoclawContainerState | null;
  /** Fork insert: allocates the even seq itself and accepts the fork's kinds. */
  insertMessage(message: NanoclawInboundInsert): Promise<void>;

  // --- fork-only ingress --------------------------------------------------
  insertMessageIfNew(message: MessageInsert): boolean;
  insertMessageWithContext(trigger: MessageInsert, context: MessageInsert | null): void;
  insertMessageWithContextIfNew(trigger: MessageInsert, context: MessageInsert | null): boolean;
  insertDeferredMessageWithContextIfNew(message: MessageInsert): boolean;
  nextEvenSeq(): number;
  upsertSessionRouting(routing: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    spawn_task_id?: string | null;
    session_id?: string | null;
  }): void;
  readSessionRouting(): ForkSessionRouting | null;
  /** Stamp the owning dispatched task without touching the chat routing columns. */
  setSessionRoutingSpawnTaskId(taskId: string): void;
  /** Snake-case destination rows; upstream's `replaceDestinations` takes the record shape. */
  replaceDestinationRows(entries: DestinationRow[]): void;
  inboundHasMessage(messageId: string): boolean;

  // --- fork-only delivery -------------------------------------------------
  markPending(messageOutId: string): void;
  getDueOutboundMessages(): ForkOutboundMessage[];
  /** Every outbound id, due or not — what "outstanding" means to the drain loop. */
  listOutboundMessageIds(): string[];

  // --- fork-only lookups --------------------------------------------------
  // Narrow reads the delivery family used to run on the handle the loop
  // passed its action handlers (plan §4.5b, invariant I-9).
  getRecentInboundChatSenders(limit: number): InboundChatSenderRow[];
  getChannelDestination(name: string): ChannelDestination | null;
  getLatestTaskContent(seriesId: string): string | null;
  getLatestRoutedTaskRow(seriesId: string): RoutedTaskRow | null;
  getInboundRoutingAnchor(messageId: string): InboundRoutingAnchor | null;

  /**
   * Does this session have a `outbound.db` yet?
   *
   * False for the never-woken cohort (see `exists`). Every outbound READ on
   * this session already degrades to empty for that case, so callers need this
   * only where the absence should skip a whole BLOCK of work — the running-
   * container SLA, and the two callees that still take a raw outbound handle.
   */
  hasOutbound(): boolean;

  // --- fork-only sweep ----------------------------------------------------
  getNextFutureProcessAfter(): string | null;
  expireStalePending(maxAgeMs: number): number;
  getDueWakePriority(): 'interactive' | 'scheduled';
  /** Fused: reads outbound processing_ack and writes inbound statuses in one action. */
  syncProcessingAcks(): void;
  /** Raw snake_case claim rows; upstream's `getProcessingClaims` returns the record shape. */
  getProcessingClaimRows(): ProcessingClaim[];
  /**
   * Per-turn usage rows newer than the central watermark, oldest first.
   * `[]` when the container never wrote the table — the normal case, not an
   * error, so the caller never probes `sqlite_master` itself.
   */
  listTurnUsageSince(afterId: number): SessionTurnUsageRow[];

  // --- fork-only tasks ----------------------------------------------------
  // Upstream's task ops on `MailboxSession` are reused wherever the statement
  // matches (`cancelTask`, `pauseTask`, `deleteTask`, `clearRecurrence`,
  // `trailingFailedRuns`, `listLiveTasks`, `getTask`, `getTaskStats`,
  // `countLiveTasks`, `findTaskBySeriesSlug`); only the ops below differ.
  /** Fork insert: routing columns, and `trigger = 0` so the row lands inert. */
  insertTaskRow(row: TaskRowInsert): void;
  /** Fork resume: also drops the stale recall pair and re-seqs the occurrence. */
  resumeTask(taskId: string): number;
  /** Fork update: script/threadAnchor/quietStatus/flagIntent/chatLimit + recall invalidation. */
  updateTask(taskId: string, update: ForkTaskUpdate): number;
  /** Fork shape: includes 'expired' and carries the routing columns forward. */
  getCompletedRecurringRows(): ForkRecurringMessage[];
  insertRecurrence(
    msg: ForkRecurringMessage,
    newId: string,
    nextRun: string | null,
    status?: 'pending' | 'paused',
  ): void;
  /**
   * Upstream's `armNextTask` under a fork name: same one-transaction guarantee,
   * fork insert semantics. Renamed rather than overridden because the fork's
   * clone needs the whole source row, which upstream's two-argument shape
   * cannot carry.
   */
  armNextRecurrence(
    originalId: string,
    msg: ForkRecurringMessage,
    newId: string,
    nextRun: string | null,
    status?: 'pending' | 'paused',
  ): void;
  restoreTaskRow(snapshot: TaskRowSnapshot): void;
  cancelSeriesWithStrandClear(taskId: string): number;
  upsertTaskSeries(row: {
    id: string;
    seriesId: string;
    processAfter: string;
    recurrence: string;
    content: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
  }): void;
  listDueTaskRows(): HostGatedTaskRow[];
  resolvePendingTask(taskId: string, status: 'completed' | 'failed'): void;
  setPendingTaskContent(taskId: string, content: string): void;
  /**
   * The `ncl tasks` board's own series view. Not upstream's `listLiveTasks` /
   * `getTask`: those pick a series' representative row by a paused-or-future
   * rank and return a `TaskRecord`, which carries no routing columns — and the
   * CLI's table shows where a task posts.
   */
  listCliTaskSeries(status?: 'pending' | 'paused'): CliTaskRow[];
  getCliTaskRow(id: string): CliTaskRow | undefined;
  getCreatedTaskRow(id: string): CreatedTaskRow | undefined;

  // --- host-owned due admission -------------------------------------------
  /** The recall POLICY stays with session-manager; these commit its decision. */
  demoteUnpairedLegacyTasks(): void;
  listDueAdmissionRows(): DueAdmissionRow[];
  admitDueRow(recall: MessageInsert, taskId: string): boolean;
  listUnpairedPendingUpgradeRows(): PendingUpgradeRow[];
  admitPendingUpgradeRow(recall: MessageInsert, messageId: string): boolean;
  deferForFreshContextRetry(messageId: string, backoffSec: number): void;
  taskPairIsAdmitted(taskId: string): boolean;
  restoreInertTaskSchedule(taskId: string, processAfter: string | null): void;

  // --- fork-only recall pairing -------------------------------------------
  readProviderRecallState(provider: string): ProviderRecallState;
  listOpenChatContents(): Array<{ content: string }>;
  listRecentRecallRows(limit: number): Array<{ id: string; status: string; content: string }>;
  hasMatchingBootstrapRecall(excludeRecallId: string | null, provider: string, contextEpoch: number): boolean;

  // --- fork-only container session state ----------------------------------
  readContinuationPresence(): ContinuationPresence | null;
  /** Opens outbound.db read-write. The only host write to a container-owned key. */
  clearWorkContinuation(): ContinuationPresence | null;
  readDoneProposal(): DoneProposal | null;
  hasRestartNoteSince(since: string): boolean;

  // --- fork-only repository fence ----------------------------------------
  readRepoIngressFence(): RepoIngressFence | null;
  activateRepoIngressFence(epoch: string): RepoIngressFence;
  admitRepoIngressFenceMessage(epoch: string, messageId: string): RepoIngressAdmissionResult;
  releaseRepoIngressFence(epoch: string, generation: string): RepoIngressReleaseResult;
  readRepositoryMountBarrierAck(): string | null;

  // --- fork-only work continuation (outbound session_state) ---------------
  readWorkContinuation(): HostWorkContinuation | null;
  readContinuationRecoveryAttemptAt(continuation: HostWorkContinuation): number;
  /** Writes outbound: opens the writable handle. Only valid with the container stopped. */
  incrementWorkContinuationResumeAttempt(expectedId: string): HostWorkContinuation | null;
  migrateLegacyWorkContinuationForRecovery(): HostWorkContinuation | null;
  restoreWorkContinuationResumeAttempt(
    attempted: HostWorkContinuation,
    previous: HostWorkContinuation,
  ): HostWorkContinuation | null;

  // --- fork-only self-heal accountability ---------------------------------
  hasDueRecoveryWake(nowIso: string): boolean;
  parkDueRecoveryWakes(nowIso: string): number;
  countRecoveryAttemptsSinceRealInbound(idPrefix: string): number;
  latestRecoveryMarkerTimestamp(idPrefix: string): string | null;
  latestRecoveryMarkerId(idPrefix: string): string | null;
  readMessageRouting(messageId: string): InboundMessageRouting | undefined;
  latestInboundTimestamp(): string | null;
  latestOutboundTimestamp(): string | null;
  markInboundCompletedIfPending(messageId: string): void;
  outboundHasContentLike(marker: string): boolean;
  outboundHasRecentContentLike(marker: string, withinSeconds: number): boolean;
  hasNonStatusReplyTo(messageId: string): boolean;
  /** The fork's `MAX(seq) + 2` direct write; opens the writable outbound handle. */
  writeOutboundDirect(message: DirectOutboundRow): void;
}

export type NanoclawMailboxAction<T> = (mailbox: NanoclawMailboxSession) => T | Promise<T>;

/** Normalize upstream's boolean flag shape onto the fork's 0|1 columns. */
function toMessageInsert(message: NanoclawInboundInsert): MessageInsert {
  const flag = (value: boolean | 0 | 1 | undefined): 0 | 1 | undefined =>
    value === undefined ? undefined : value ? 1 : 0;
  return { ...message, trigger: flag(message.trigger), onWake: flag(message.onWake) };
}

export class NanoclawAgentMailbox extends SqliteAgentMailbox {
  /**
   * Inbound DB paths whose legacy-shape migrations already ran this process.
   *
   * Named apart from upstream's identically-purposed `migrated` because that
   * one is `private` — TypeScript refuses a subclass member of the same name,
   * and the fork cannot reuse the base's memo without upstream making it
   * `protected` (asked for upstream; see plan §4.2).
   *
   * Written ONLY in `session()`. `prepare()` must never add to it: a session
   * DB that already exists on disk is skipped by `prepare()`, so recording it
   * there would suppress the legacy migrations that DB needs (H-2).
   */
  private readonly nanoclawMigrated = new Set<string>();

  /**
   * True when this session has a mailbox — which the fork decides on
   * `inbound.db` ALONE.
   *
   * Two changes from upstream's probe, each load-bearing:
   *
   * 1. **Inbound only.** Upstream requires both files. The fork has a live
   *    cohort that has only ever had `inbound.db` — never-woken sessions,
   *    documented in `storage-manager.ts` where the idle gates work around
   *    exactly that shape — because `outbound.db` is the CONTAINER's file and
   *    a session that never spawned one has no reason to own it. Requiring
   *    both would report those sessions as having no mailbox at all, so a read
   *    path would skip their task admission and due-message handling entirely,
   *    and `container-restart` would leave their ingress unfenced through a
   *    repository transition while it still accepts host writes. `inbound.db`
   *    is the host-owned file and the honest marker of "this session exists";
   *    a missing outbound side is a normal state, and `session()` degrades
   *    every outbound READ to empty for it rather than failing the caller.
   * 2. **Errno-aware.** Only ENOENT/ENOTDIR mean gone; `existsSync` reports
   *    EACCES — a session whose directory the host merely cannot traverse — as
   *    absent too. That answer propagates: `session()` would raise
   *    `SessionDbMissingError` and `withExistingMailboxSession` would resolve
   *    `undefined`, so `container-restart`'s skip-the-vanished branch would
   *    silently leave a present-but-unreadable session's ingress UNFENCED. A
   *    present session must reach the opener and fail there on its real error.
   */
  override async exists(key: MailboxSessionKey): Promise<boolean> {
    return !sessionDbPathIsGone(sessionMailboxPath(key, 'inbound'));
  }

  /**
   * Provision the session's mailbox files.
   *
   * `super.prepare()` first — it creates whichever files are MISSING, with
   * upstream's baseline — and then the fork's `ensureSchema` on both,
   * ALWAYS, existing files included. The unconditional second half is the
   * point: a DB that already exists may still be missing baseline tables, and
   * the v1→v2 migration provisions over exactly such a directory. Guarding it
   * on `existsSync` left those sessions without `session_routing`, so every
   * later spawn failed on `ALTER TABLE session_routing`.
   *
   * Cost is the same as `initSessionFolder`'s has always been, plus upstream's
   * two `existsSync` calls. That is a session-creation path today; PRs 3-6
   * route every write through `withMailboxSession`, which prepares first, so
   * that batch should measure whether this needs a per-path memo rather than
   * assume it — assuming it is what caused the bug above.
   *
   * The migration memo is deliberately untouched here: an existing DB's legacy
   * migrations belong to its first `session()` (H-2).
   */
  override prepare(key: MailboxSessionKey): void {
    super.prepare(key);
    ensureSchema(sessionMailboxPath(key, 'inbound'), 'inbound');
    ensureSchema(sessionMailboxPath(key, 'outbound'), 'outbound');
  }

  override async destroy(key: MailboxSessionKey): Promise<void> {
    this.nanoclawMigrated.delete(sessionMailboxPath(key, 'inbound'));
    await super.destroy(key);
  }

  /**
   * Run one logical operation against a session's mailbox.
   *
   * Re-implements upstream's `session()` (rather than delegating) because the
   * fork's ops need the open handles and upstream's migration memo is private.
   * The drift manifest turns any upstream change to `sqlite/index.ts` into a
   * loud failure at the next sync so this copy is reviewed then.
   */
  override async session<T>(key: MailboxSessionKey, action: NanoclawMailboxAction<T>): Promise<T> {
    const inboundPath = sessionMailboxPath(key, 'inbound');
    const outboundPath = sessionMailboxPath(key, 'outbound');
    // A vanished session reports as SessionDbMissingError, not upstream's
    // "not prepared" Error: sweep, delivery and container-restart all branch
    // on that type to skip a session instead of failing the tick.
    if (!(await this.exists(key))) throw new SessionDbMissingError(inboundPath);
    const inbound = openInboundDb(inboundPath);
    let outbound: Database.Database | undefined;
    let outboundWriter: Database.Database | undefined;
    // Sampled once, at session entry, because a session is one short logical
    // operation — the same point the pre-seam host decided it by opening the
    // file. Only a real ENOENT/ENOTDIR counts as absent, so an unreadable
    // outbound still reaches the opener and fails there.
    const outboundPresent = !sessionDbPathIsGone(outboundPath);
    const readableOutbound = () => (outbound ??= openOutboundDb(outboundPath));
    const writableOutbound = () => (outboundWriter ??= openOutboundDbRw(outboundPath));
    try {
      if (!this.nanoclawMigrated.has(inboundPath)) {
        // Upstream's legacy migrations first, then the fork's. The fork's
        // `migrateMessagesInTable` is a superset of upstream's, so running
        // both is redundant by construction — deliberately so: upstream's runs
        // from upstream's own copy, so a future divergence shows up here as a
        // schema difference rather than silently in production.
        upstreamMigrateMessagesInTable(inbound);
        ensureNanoclawInboundSchema(inbound);
        this.nanoclawMigrated.add(inboundPath);
      }
      // Sequences are allocated per file (inbound writes scan messages_in,
      // direct outbound writes scan messages_out) — the host must never read
      // the container-owned outbound.db just to insert an inbound row; the
      // two-DB split exists to avoid exactly that cross-mount coupling.
      return await action(composeNanoclawSession(inbound, readableOutbound, writableOutbound, outboundPresent));
    } finally {
      inbound.close();
      outbound?.close();
      outboundWriter?.close();
    }
  }
}

/**
 * Build the session an action receives from handles that are already open.
 *
 * `session()` is its only production caller. It is exported so a test can
 * drive the exact same session surface over in-memory databases without
 * reimplementing the composition — one definition of "what a Nanoclaw mailbox
 * session is", which is what invariant I-2 asks for.
 */
export function composeNanoclawSession(
  inbound: Database.Database,
  readableOutbound: () => Database.Database,
  writableOutbound: () => Database.Database = readableOutbound,
  outboundPresent = true,
): NanoclawMailboxSession {
  return {
    ...wrapSqliteInbound(inbound),
    ...wrapSqliteOutbound(readableOutbound, writableOutbound),
    ...forkOps(inbound, readableOutbound, writableOutbound, outboundPresent),
  };
}

/**
 * The fork's ops, bound to the handles open for this session.
 *
 * Both outbound accessors are threaded in and both are lazy: a session that
 * never touches outbound.db opens no handle, and one that only reads it never
 * opens the writer. The writable one serves the three host-side writers that
 * already existed — the direct outbound notice, the work-continuation recovery
 * admission, and the thread-close path force-clearing a container-owned
 * continuation (`clearWorkContinuation`) — every one of which runs only with
 * the container confirmed stopped.
 */
function forkOps(
  inbound: Database.Database,
  readableOutbound: () => Database.Database,
  writableOutbound: () => Database.Database,
  outboundPresent: boolean,
): Omit<NanoclawMailboxSession, keyof MailboxSession> &
  Pick<
    NanoclawMailboxSession,
    | 'setRouting'
    | 'countDueMessages'
    | 'markDelivered'
    | 'markDeliveryFailed'
    | 'getContainerState'
    | 'insertMessage'
    | 'resumeTask'
    | 'updateTask'
  > {
  /**
   * Run an outbound READ, or answer `empty` when this session has no
   * `outbound.db`.
   *
   * The never-woken cohort (see `exists`) is a normal state, not a fault, and
   * the pre-seam sweep expressed exactly this by carrying a nullable outbound
   * handle and guarding every use of it. One helper here replaces ~8 such
   * guards at the callers and, unlike them, cannot be forgotten by the next
   * op. WRITES deliberately do NOT degrade: they still raise
   * `SessionDbMissingError` from the opener, which is what every host-side
   * outbound writer already handles.
   */
  const readOutbound = <T>(empty: T, read: (outbound: Database.Database) => T): T =>
    outboundPresent ? read(readableOutbound()) : empty;

  return {
    hasOutbound: () => outboundPresent,

    setRouting: (routing) =>
      upsertSessionRouting(inbound, {
        channel_type: routing.channelType,
        platform_id: routing.platformId,
        thread_id: routing.threadId,
      }),
    countDueMessages: () => countDueMessages(inbound),
    markDelivered: (messageOutId, platformMessageId) => markDelivered(inbound, messageOutId, platformMessageId),
    markDeliveryFailed: (messageOutId, errorMessage) => markDeliveryFailed(inbound, messageOutId, errorMessage),
    getContainerState: () => {
      const row = readOutbound(null, getContainerState);
      if (!row) return null;
      return {
        ...row,
        currentTool: row.current_tool,
        toolDeclaredTimeoutMs: row.tool_declared_timeout_ms,
        toolStartedAt: row.tool_started_at === null ? null : parseIsoTimestamp(sqliteTimestamp(row.tool_started_at)),
      };
    },
    insertMessage: async (message) => {
      runInsertMessage(inbound, toMessageInsert(message), false);
    },

    insertMessageIfNew: (message) => insertMessageIfNew(inbound, message),
    insertMessageWithContext: (trigger, context) => insertMessageWithContext(inbound, trigger, context),
    insertMessageWithContextIfNew: (trigger, context) => insertMessageWithContextIfNew(inbound, trigger, context),
    insertDeferredMessageWithContextIfNew: (message) => insertDeferredMessageWithContextIfNew(inbound, message),
    nextEvenSeq: () => nextEvenSeq(inbound),
    upsertSessionRouting: (routing) => upsertSessionRouting(inbound, routing),
    readSessionRouting: () => readSessionRouting(inbound),
    setSessionRoutingSpawnTaskId: (taskId) => setSessionRoutingSpawnTaskId(inbound, taskId),
    replaceDestinationRows: (entries) => replaceDestinations(inbound, entries),
    inboundHasMessage: (messageId) => inboundHasMessage(inbound, messageId),

    markPending: (messageOutId) => markPending(inbound, messageOutId),
    getDueOutboundMessages: () => readOutbound([], getDueOutboundMessages),
    listOutboundMessageIds: () => listOutboundMessageIds(readableOutbound()),

    getRecentInboundChatSenders: (limit) => getRecentInboundChatSenders(inbound, limit),
    getChannelDestination: (name) => getChannelDestination(inbound, name),
    getLatestTaskContent: (seriesId) => getLatestTaskContent(inbound, seriesId),
    getLatestRoutedTaskRow: (seriesId) => getLatestRoutedTaskRow(inbound, seriesId),
    getInboundRoutingAnchor: (messageId) => getInboundRoutingAnchor(inbound, messageId),

    getNextFutureProcessAfter: () => getNextFutureProcessAfter(inbound),
    expireStalePending: (maxAgeMs) => expireStalePending(inbound, maxAgeMs),
    getDueWakePriority: () => getDueWakePriority(inbound),
    syncProcessingAcks: () => readOutbound(undefined, (outbound) => syncProcessingAcks(inbound, outbound)),
    getProcessingClaimRows: () => readOutbound([], getProcessingClaims),
    // A never-woken session has no turn usage: empty is the honest answer here,
    // not the opener's throw (the rollup runs over every session every tick).
    listTurnUsageSince: (afterId) => readOutbound([], (outbound) => listTurnUsageSince(outbound, afterId)),

    insertTaskRow: (row) => insertTaskRow(inbound, row),
    resumeTask: (taskId) => resumeTask(inbound, taskId),
    updateTask: (taskId, update) => updateTask(inbound, taskId, update),
    getCompletedRecurringRows: () => getCompletedRecurring(inbound),
    insertRecurrence: (msg, newId, nextRun, status) => insertRecurrence(inbound, msg, newId, nextRun, status),
    armNextRecurrence: (originalId, msg, newId, nextRun, status) =>
      armNextTask(inbound, originalId, msg, newId, nextRun, status),
    restoreTaskRow: (snapshot) => restoreTaskRow(inbound, snapshot),
    cancelSeriesWithStrandClear: (taskId) => cancelSeriesWithStrandClear(inbound, taskId),
    upsertTaskSeries: (row) => upsertTaskSeries(inbound, row),
    listDueTaskRows: () => listDueTaskRows(inbound),
    resolvePendingTask: (taskId, status) => resolvePendingTask(inbound, taskId, status),
    setPendingTaskContent: (taskId, content) => setPendingTaskContent(inbound, taskId, content),
    listCliTaskSeries: (status) => listCliTaskSeries(inbound, status),
    getCliTaskRow: (id) => getCliTaskRow(inbound, id),
    getCreatedTaskRow: (id) => getCreatedTaskRow(inbound, id),

    demoteUnpairedLegacyTasks: () => demoteUnpairedLegacyTasks(inbound),
    listDueAdmissionRows: () => listDueAdmissionRows(inbound),
    admitDueRow: (recall, taskId) => admitDueRow(inbound, recall, taskId),
    listUnpairedPendingUpgradeRows: () => listUnpairedPendingUpgradeRows(inbound),
    admitPendingUpgradeRow: (recall, messageId) => admitPendingUpgradeRow(inbound, recall, messageId),
    deferForFreshContextRetry: (messageId, backoffSec) => deferForFreshContextRetry(inbound, messageId, backoffSec),
    taskPairIsAdmitted: (taskId) => taskPairIsAdmitted(inbound, taskId),
    restoreInertTaskSchedule: (taskId, processAfter) => restoreInertTaskSchedule(inbound, taskId, processAfter),

    readProviderRecallState: (provider) => readProviderRecallState(readableOutbound(), provider),
    listOpenChatContents: () => listOpenChatContents(inbound),
    listRecentRecallRows: (limit) => listRecentRecallRows(inbound, limit),
    hasMatchingBootstrapRecall: (excludeRecallId, provider, contextEpoch) =>
      hasMatchingBootstrapRecall(inbound, excludeRecallId, provider, contextEpoch),

    readContinuationPresence: () => readContinuationPresence(readableOutbound()),
    clearWorkContinuation: () => clearWorkContinuation(writableOutbound()),
    readDoneProposal: () => readDoneProposal(readableOutbound()),
    hasRestartNoteSince: (since) => hasRestartNoteSince(inbound, since),

    readRepoIngressFence: () => readRepoIngressFence(inbound),
    activateRepoIngressFence: (epoch) => activateRepoIngressFence(inbound, epoch),
    admitRepoIngressFenceMessage: (epoch, messageId) => admitRepoIngressFenceMessage(inbound, epoch, messageId),
    releaseRepoIngressFence: (epoch, generation) => releaseRepoIngressFence(inbound, epoch, generation),
    readRepositoryMountBarrierAck: () => readOutbound(null, readRepositoryMountBarrierAck),

    readWorkContinuation: () => readOutbound(null, readWorkContinuation),
    readContinuationRecoveryAttemptAt: (continuation) =>
      readOutbound(0, (outbound) => readContinuationRecoveryAttemptAt(outbound, continuation)),
    incrementWorkContinuationResumeAttempt: (expectedId) =>
      incrementWorkContinuationResumeAttempt(writableOutbound(), expectedId),
    migrateLegacyWorkContinuationForRecovery: () => migrateLegacyWorkContinuationForRecovery(writableOutbound()),
    restoreWorkContinuationResumeAttempt: (attempted, previous) =>
      restoreWorkContinuationResumeAttempt(writableOutbound(), attempted, previous),

    hasDueRecoveryWake: (nowIso) => hasDueRecoveryWake(inbound, nowIso),
    parkDueRecoveryWakes: (nowIso) => parkDueRecoveryWakes(inbound, nowIso),
    countRecoveryAttemptsSinceRealInbound: (idPrefix) => countRecoveryAttemptsSinceRealInbound(inbound, idPrefix),
    latestRecoveryMarkerTimestamp: (idPrefix) => latestRecoveryMarkerTimestamp(inbound, idPrefix),
    latestRecoveryMarkerId: (idPrefix) => latestRecoveryMarkerId(inbound, idPrefix),
    readMessageRouting: (messageId) => readMessageRouting(inbound, messageId),
    latestInboundTimestamp: () => latestInboundTimestamp(inbound),
    latestOutboundTimestamp: () => readOutbound(null, latestOutboundTimestamp),
    markInboundCompletedIfPending: (messageId) => markInboundCompletedIfPending(inbound, messageId),
    outboundHasContentLike: (marker) => readOutbound(false, (outbound) => outboundHasContentLike(outbound, marker)),
    outboundHasRecentContentLike: (marker, withinSeconds) =>
      readOutbound(false, (outbound) => outboundHasRecentContentLike(outbound, marker, withinSeconds)),
    hasNonStatusReplyTo: (messageId) => readOutbound(false, (outbound) => hasNonStatusReplyTo(outbound, messageId)),
    writeOutboundDirect: (message) => writeOutboundDirectRow(writableOutbound(), message),
  };
}
