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
import { dispatchTaskEvent, type TaskDispatchInput, type TaskDispatchResult } from './ops/task-dispatch.js';
import { readTaskSettlement, type TaskSettlement } from './ops/task-settlement.js';
export { dispatchSeriesId, dispatchEventId, validateDispatchKey } from './ops/task-dispatch.js';

import { sessionMailboxDir, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';
import { SqliteAgentMailbox, wrapSqliteInbound, wrapSqliteOutbound } from '../../mailbox/sqlite/index.js';
import {
  deleteOrphanProcessingClaims,
  migrateMessagesInTable as upstreamMigrateMessagesInTable,
} from '../../mailbox/sqlite/session-db.js';
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
  openOutboundDbWritable,
  sessionDbPathIsGone,
} from './openers.js';
import { deleteHostInboundProvenance } from '../../db/host-inbound-provenance.js';
import { hostInboundDbPathFor, removeHostInboundDir, resolveInboundDbPath } from './host-inbound.js';
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
  withdrawUnconsumedWake,
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
  markLifecycleTerminal,
  markPending,
  type OutboundMessage as ForkOutboundMessage,
} from './ops/delivery.js';
import {
  getChannelDestination,
  getInboundRoutingAnchor,
  getInboundRequestIdentity,
  getRecoverableLifecycleStatus,
  getLatestRoutedTaskRow,
  getLatestTaskContent,
  getRecentInboundChatSenders,
  hasRestartNoteSince,
  type ChannelDestination,
  type InboundChatSenderRow,
  type InboundRequestIdentity,
  type InboundRoutingAnchor,
  type RecoverableLifecycleStatus,
  type RoutedTaskRow,
} from './ops/lookups.js';
import {
  getLiveTaskRow,
  getLiveTaskRowById,
  listTurnUsageSince,
  type ScheduledTaskRow,
  type SessionTurnUsageRow,
} from './ops/reads.js';
import {
  admitDueRow,
  admitPendingUpgradeRow,
  deferForFreshContextRetry,
  demoteUnpairedLegacyTasks,
  hasPendingRecallPairedTrigger,
  listDueAdmissionRows,
  listUnpairedPendingUpgradeRows,
  reconcileSurvivorWakeRows,
  restoreInertTaskSchedule,
  taskPairIsAdmitted,
  type DueAdmissionRow,
  type PendingUpgradeRow,
} from './ops/admission.js';
import {
  armNextTask,
  cancelSeriesWithStrandClear,
  cancelTaskRow,
  cancelTaskRowWithMoveReceipt,
  getCliTaskRow,
  getCompletedRecurring,
  getCreatedTaskRow,
  hasMoveCancellationReceipt,
  insertRecurrence,
  insertTaskRow,
  listCliTaskSeries,
  listDueTaskRows,
  resolvePendingTask,
  restoreTaskRow,
  restoreTaskSeries,
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
  type TaskSeriesCollision,
  type TaskSeriesSnapshot,
  type UpsertedTaskSeries,
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
  expireClosedSessionPending,
  expireStalePending,
  getContainerState,
  getDueWakePriority,
  getNextFutureProcessAfter,
  getProcessingClaims,
  hasProcessingAck,
  listOverdueRecurringRows,
  syncProcessingAcks,
  type ContainerState as ForkContainerState,
  type OverdueRecurringRow,
  type ProcessingClaim,
} from './ops/sweep.js';
import {
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  type HostWorkContinuation,
} from './ops/continuation.js';
import {
  countRecoveryAttemptsSinceRealInbound,
  hasDueRecoveryWake,
  hasNonStatusReplyTo,
  latestInboundTimestamp,
  latestOutboundChat,
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
  type OutboundChatRow,
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
export { writeOutboundDirectRow } from './ops/recovery.js';
export type { DirectOutboundRow, InboundMessageRouting, OutboundChatRow } from './ops/recovery.js';
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
  cancelTaskRow,
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
  type TaskSeriesCollision,
  type TaskSeriesSnapshot,
  type TaskUpdate,
  type UpsertedTaskSeries,
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
 * Where the host keeps `inbound.db` since #749, and the spawn path's migration
 * onto it. The database itself is still reached through a mailbox session —
 * these are the layout and the one-time move, for the spawn path that has to
 * mount the host-owned directory read-only.
 */
export {
  HOST_INBOUND_DIR_NAME,
  assertHostOwnedInboundDb,
  hostInboundDbPathFor,
  hostInboundDirFor,
  hostInboundMounts,
  inboundDbIsHostOwned,
  migrateInboundDbToHostDir,
  removeForeignInboundSidecars,
  resolveInboundDbPath,
} from './host-inbound.js';

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
export type { ContainerState, OverdueRecurringRow, ProcessingClaim } from './ops/sweep.js';

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
  /** Preserve the delivery receipt while marking its activity line terminal. */
  markLifecycleTerminal(messageOutId: string): boolean;
  /** Tiered column read: provider health and memory telemetry when present. */
  getContainerState(): NanoclawContainerState | null;
  /** Fork insert: allocates the even seq itself and accepts the fork's kinds. */
  insertMessage(message: NanoclawInboundInsert): Promise<void>;

  // --- fork-only ingress --------------------------------------------------
  insertMessageIfNew(message: MessageInsert): boolean;
  insertMessageWithContext(trigger: MessageInsert, context: MessageInsert | null): void;
  insertMessageWithContextIfNew(trigger: MessageInsert, context: MessageInsert | null): boolean;
  insertDeferredMessageWithContextIfNew(message: MessageInsert): boolean;
  /**
   * Withdraw an `on_wake` row and its recall partner, but only on a proof that
   * no container could have claimed the message.
   *
   * `containerOwnsOutbound` is the caller's half of that proof — the container
   * registry is host state this module cannot see — and must be a live probe,
   * not a value read earlier: it is invoked inside the op, immediately before
   * the delete. The outbound `processing_ack` half is read here. See
   * `withdrawUnconsumedWake` in `ops/ingress.ts` for why the inbound row's own
   * `status` cannot answer this.
   */
  withdrawUnconsumedWake(messageId: string, containerOwnsOutbound: () => boolean): boolean;
  /**
   * Reconcile every unconsumed `on_wake` row a SURVIVING container can no
   * longer select — withdrawing the host-restart accountability note, and
   * converting the rest to ordinary pending rows at the front of the queue.
   *
   * Takes no ownership probe, unlike `withdrawUnconsumedWake`: see the wiring
   * for why the container registry is the wrong authority here.
   */
  reconcileSurvivorWakeRows(): { converted: number; withdrawn: number };
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
  getInboundRequestIdentity(sequence: number): InboundRequestIdentity | null;
  getRecoverableLifecycleStatus(outboundId?: string): RecoverableLifecycleStatus | null;

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
  /**
   * Expire everything a TERMINALLY CLOSED session still holds — no age cutoff,
   * no recurrence guard. Only ever correct once the session row is (or is
   * about to be) `closed`; see the op for why each guard is dropped.
   */
  expireClosedSessionPending(): number;
  getDueWakePriority(): 'interactive' | 'scheduled';
  /**
   * Fused: reads outbound processing_ack and writes inbound statuses in one
   * action. Returns the ids completed because the runner had already answered
   * them with no ack left to sync (see the op).
   */
  syncProcessingAcks(): string[];
  /** Recurring occurrences due since before `cutoffIso` with nothing in the session being worked (see the op). */
  listOverdueRecurringRows(cutoffIso: string): OverdueRecurringRow[];
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
  dispatchTaskEvent(input: TaskDispatchInput): TaskDispatchResult;
  readTaskSettlement(eventId: string, threadId: string | null, observer?: boolean): TaskSettlement;
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
  /**
   * Undo one `upsertTaskSeries`, addressed by the row it actually touched.
   *
   * Both arguments come from that upsert's own return value. A series can hold
   * more than one live row, so undoing by `series_id` would cancel a sibling
   * occurrence this write never touched.
   */
  restoreTaskSeries(touchedId: string, prior: TaskSeriesSnapshot | null, priorRecall: TaskSeriesSnapshot | null): void;
  cancelSeriesWithStrandClear(taskId: string): number;
  /**
   * Cancel ONE row by its exact id — the by-id twin of upstream's series-wide
   * `cancelTask`, for a writer acting on a row it read earlier.
   */
  cancelTaskRow(rowId: string): number;
  /** Atomically cancel one task row and record the given move-intent receipt. */
  cancelTaskRowWithMoveReceipt(rowId: string, receiptId: string): number;
  /** Whether this source inbox durably records the exact move cancellation. */
  hasMoveCancellationReceipt(receiptId: string): boolean;
  /**
   * The newest LIVE (`pending`/`paused`) task row of a series.
   *
   * The read-only funnels have carried this since PR 6; the WRITE session
   * needs it too, because a writer that approved a row before an await has to
   * re-prove that row is still the live one before it mutates. Same op, same
   * statement (invariant I-2) — the surface differs, the SQL does not.
   */
  getLiveTaskRow(seriesId: string): ScheduledTaskRow | null;
  /** Exact live task occurrence lookup; used to prove a move owns its target row. */
  getLiveTaskRowById(rowId: string): ScheduledTaskRow | null;
  upsertTaskSeries(row: {
    id: string;
    seriesId: string;
    processAfter: string;
    /** The slot this occurrence is FOR, when it differs from `processAfter` (board move only). */
    scheduledFor?: string | null;
    recurrence: string;
    content: string;
    status?: 'pending' | 'paused';
    rejectExistingLiveSeries?: boolean;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    /** Returns the row it touched and that row's prior state, for `restoreTaskSeries`. */
  }): UpsertedTaskSeries | TaskSeriesCollision;
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
  /** A pending primary row still has the recall partner required for admission. */
  hasPendingRecallPairedTrigger(): boolean;
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
  /** Most recent outbound `chat` row (status edits excluded), or null. */
  latestOutboundChat(): OutboundChatRow | null;
  markInboundCompletedIfPending(messageId: string): void;
  outboundHasContentLike(marker: string): boolean;
  outboundHasRecentContentLike(marker: string, withinSeconds: number): boolean;
  hasNonStatusReplyTo(messageId: string): boolean;
  /** The fork's `MAX(seq) + 2` direct write; opens the writable outbound handle. */
  writeOutboundDirect(message: DirectOutboundRow): void;
}

/**
 * The outbound-owned READS, named once.
 *
 * Every signature is the session's own — a `Pick`, not a second declaration —
 * so each op has one definition however it is reached (invariant I-2). This
 * is the half that is safe on any session, including one the host is only
 * inspecting: nothing here writes the container-owned file.
 *
 * Deliberately the SAME op vocabulary as PR 7's read-only `OutboundSessionRead`
 * — same names, same signatures — so the two can be expressed in terms of each
 * other rather than maintained as parallel types. `getProcessingClaimRows`
 * matches it exactly; `getContainerState` returns `NanoclawContainerState`,
 * which extends `ops/sweep`'s `ContainerState` that PR 7 declares, so it is
 * assignable in that direction. PR 7's other reads (`listTurnUsageSince`,
 * `listOutboundTail`, `hasWorkContinuation`, …) live in `ops/reads.ts`, which
 * is PR 6's file and does not exist on this head; they join this vocabulary
 * when PR 6 merges down, and the union belongs in ONE of these two types then,
 * not in a third.
 */
export type NanoclawOutboundRead = Pick<
  NanoclawMailboxSession,
  | 'getContainerState'
  | 'getProcessingClaimRows'
  | 'readRepositoryMountBarrierAck'
  | 'readDoneProposal'
  | 'readContinuationPresence'
>;

/**
 * The reads plus the outbound WRITES the host performs.
 *
 * Three, and they are the reason this type is not simply `NanoclawOutboundRead`:
 *
 *  - `clearWorkContinuation` — the thread-close force-clear, a host write to a
 *    container-owned key, valid only with the container confirmed stopped (see
 *    the policy around it in `dashboard/thread-close.ts`).
 *  - `deleteOrphanProcessingClaims` — the same shape and the same policy: the
 *    sweep's orphan-claim clear after a container death, and the closed-session
 *    release (#520), which has to reach it on a session whose `inbound.db` is
 *    gone. Upstream binds this op too, so this exposes an existing op on the
 *    outbound-keyed surface rather than adding one.
 *  - `writeOutboundDirect` — the router's two notices (a command-gate denial,
 *    a flag confirmation), which append an id-unique row rather than mutating
 *    container-owned state. Outbound-keyed because they read nothing from
 *    inbound.db; through the mailbox session they were silently dropped for a
 *    session whose inbound.db had been reclaimed.
 */
export type NanoclawOutboundSession = NanoclawOutboundRead &
  Pick<NanoclawMailboxSession, 'clearWorkContinuation' | 'deleteOrphanProcessingClaims' | 'writeOutboundDirect'>;

export type NanoclawMailboxAction<T> = (mailbox: NanoclawMailboxSession) => T | Promise<T>;

/**
 * Extra arguments the outbound funnels demand when their action is async.
 *
 * Empty for every synchronous action, so the call site is unchanged. For an
 * action returning a promise it is `[never]`, and the call fails to compile
 * for want of an argument nothing can supply.
 *
 * A conditional on the RETURN type would not do this — it types the result and
 * defers the complaint to whatever consumes it. A conditional on the parameter
 * (`(o) => T extends PromiseLike<unknown> ? never : T`) is worse: a conditional
 * is not an inference site, so `T` never binds and every action passes. The
 * arity check is the one form that both preserves inference for `T` (including
 * `void`, which an intersection guard rejects) and refuses at the call itself.
 */
export type SyncActionOnly<T> = T extends PromiseLike<unknown> ? [actionMustNotBeAsync: never] : [];

/** Structural promise test — `instanceof Promise` misses a thenable from another realm. */
function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

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
    // `super.prepare()` creates the LEGACY `<session>/inbound.db` when it is
    // missing, which is what a fresh session needs; the SPAWN path is what
    // later hard-links it into `<session>/.host/`. On every later call that
    // link is still there, so upstream's existence check finds the file and
    // creates nothing, and no upstream file has to change (#749).
    //
    // PROVISIONING DELIBERATELY DOES NOT MIGRATE, and that is a safety
    // property rather than an omission. A container's `/workspace` is a
    // read-WRITE bind of the session directory, fixed at spawn, and the
    // read-only `.host` overlay exists only in a mount set built at spawn
    // (`hostInboundMounts`, `src/container-runner.ts:4471`). Migrating from
    // here would create `.host/` UNDERNEATH a container that is already
    // running — inside its writable mount, with no overlay over it — handing
    // that container the host's journal path and the authoritative file
    // itself. That is strictly worse than the pre-#749 state, where at least
    // the file was overlaid read-only. And this runs live: `prepare()` is
    // reached on any in-session task create (`src/db/scheduled-tasks.ts`) and
    // from the documented-reset re-provision (`src/session-manager.ts`).
    //
    // So migration belongs to the one seam that also builds the mounts:
    // `buildMounts` migrates and then REFUSES the spawn unless the session is
    // host-owned (`assertHostOwnedInboundDb`). A session that is live when
    // this deploys keeps exactly today's exposure — no regression — and
    // becomes protected at its next spawn, which is also why the deploy needs
    // no container restart.
    super.prepare(key);
    const sessionPath = sessionMailboxDir(key);
    // The RESOLVED path: host-owned once the spawn path has migrated this
    // session, the legacy name while it has not. Naming the host-owned path
    // unconditionally would provision a SECOND, empty database under `.host/`
    // for a session whose real one is still at the legacy name.
    ensureSchema(resolveInboundDbPath(sessionPath), 'inbound');
    ensureSchema(sessionMailboxPath(key, 'outbound'), 'outbound');
  }

  override async destroy(key: MailboxSessionKey): Promise<void> {
    const sessionPath = sessionMailboxDir(key);
    // Both spellings: the memo is keyed on whatever path `session()` resolved,
    // which is the host-owned one for a migrated session and the legacy one
    // for a session this host has not migrated yet.
    this.nanoclawMigrated.delete(hostInboundDbPathFor(sessionPath));
    this.nanoclawMigrated.delete(sessionMailboxPath(key, 'inbound'));
    await super.destroy(key);
    removeHostInboundDir(sessionPath);
    // The provenance record goes with the file it describes. Leaving it would
    // mean a later session reusing this (agent group, session id) pair — or a
    // directory recreated under it — inheriting a record that no longer
    // describes anything this host created.
    await deleteHostInboundProvenance(key.agentGroupId, key.sessionId);
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
    const inboundPath = resolveInboundDbPath(sessionMailboxDir(key));
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
/**
 * The outbound ops, bound to handles the caller owns.
 *
 * One composition, two entry points: `forkOps` spreads it into the full
 * mailbox session, and `withExistingNanoclawOutbound` hands it out on its own
 * to a caller that has no business with inbound.db. Both accessors stay lazy,
 * so an action that only reads never opens the writer.
 *
 * `outboundPresent` false degrades the READS to empty, exactly as it does
 * inside a mailbox session. The outbound-keyed funnel always passes true — it
 * has already established the file is there.
 */
export function composeOutboundOps(
  readableOutbound: () => Database.Database,
  writableOutbound: () => Database.Database,
  outboundPresent: boolean,
): NanoclawOutboundSession {
  const readOutbound = <T>(empty: T, read: (outbound: Database.Database) => T): T =>
    outboundPresent ? read(readableOutbound()) : empty;
  return {
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
    getProcessingClaimRows: () => readOutbound([], getProcessingClaims),
    readRepositoryMountBarrierAck: () => readOutbound(null, readRepositoryMountBarrierAck),
    // These three honour `outboundPresent` too, and the last one has to.
    //
    // They used to open the accessors directly, so on an inbound-only
    // never-woken session the reads could throw and — the part that matters —
    // `clearWorkContinuation` would take the WRITABLE handle and author the
    // container-owned `outbound.db` the host must never create (I-10). Every
    // current caller happens to guard these or reach them through the
    // outbound-only funnel, so it was latent rather than live; a doc comment
    // promising the degrade while three ops ignored it is exactly how it stops
    // being latent.
    //
    // The empty values are the same answers a present-but-empty outbound.db
    // gives: no proposal, no continuation record, and nothing cleared.
    readDoneProposal: () => readOutbound(null, readDoneProposal),
    readContinuationPresence: () => readOutbound(null, readContinuationPresence),
    clearWorkContinuation: () => (outboundPresent ? clearWorkContinuation(writableOutbound()) : null),
    // Rebinds upstream's op (`wrapSqliteOutbound` provides one too, and this
    // spread wins) for the single reason the three above were rewritten:
    // upstream's takes `writable()` unconditionally, so on a session with no
    // outbound.db it would author the container-owned file the host must never
    // create (I-10). "No claims to delete" is a true answer for a session that
    // never ran, exactly as "nothing to clear" is for the continuation.
    deleteOrphanProcessingClaims: () => (outboundPresent ? deleteOrphanProcessingClaims(writableOutbound()) : 0),
    // The direct notice deliberately does NOT degrade, which is the write rule
    // rather than an exception to it: `openOutboundDbWritable` refuses a
    // missing file instead of creating one, so a never-woken session raises
    // `SessionDbMissingError` here — the failure the router's two notice
    // writers already handle. `clearWorkContinuation` degrades because
    // "nothing to clear" is a true answer for a session that never ran;
    // "the notice was written" would not be.
    writeOutboundDirect: (message) => writeOutboundDirectRow(writableOutbound(), message),
  };
}

/**
 * Run one operation against a session's OUTBOUND database alone.
 *
 * Resolves `undefined` — never provisions, never throws — when `outbound.db`
 * is genuinely absent. That is the never-woken shape: the container owns that
 * file, and one that never ran has not written it.
 *
 * Deliberately NOT the mailbox session. That funnel's existence check is keyed
 * on `inbound.db`, so it answers `undefined` for a session whose inbound.db is
 * gone while outbound.db remains — a real cohort — and any caller reading
 * outbound state through it reports that state as empty when it is not. Four
 * separate review findings across this series were instances of that one
 * mistake, the last of them the router's two notices. The rule the seam
 * settles on: the existence question a read asks is keyed to the file the read
 * actually touches.
 *
 * The action receives the module's TYPED outbound ops, not a raw `Database` —
 * a handle leaving the module is the shape the seam exists to remove
 * (invariant I-9), whether or not the ratchet's name patterns happen to catch
 * the parameter. The ops are the same composition `forkOps` spreads, so an op
 * cannot behave differently depending on which funnel reached it.
 *
 * Both handles open lazily and only if the action asks: a pure read never
 * opens the writer, and once the writer is open the reads share it, so a
 * clear-then-verify sees its own write on one connection. A file that is
 * present but will not open raises `SessionDbUnopenableError` from the
 * opener — unreadable is a fault, never an empty answer. A file that vanishes
 * between the existence check and the first op raises `SessionDbMissingError`
 * rather than resolving `undefined`; that race is a fault too.
 *
 * Lives HERE rather than beside the two read funnels in `read-only.ts`, which
 * is where the rest of the "ways in" are documented. It is built from
 * `composeOutboundOps` directly above, and `read-only.ts` cannot import that
 * without a static import cycle through this barrel — which the host's ESM
 * rules say to avoid rather than rely on hoisting to survive.
 *
 * The action must be SYNCHRONOUS. This function is `async` only so callers can
 * `await` it beside the other funnels; its body does not await, and the
 * handles close as soon as the action RETURNS. An `async` action returns a
 * promise at that moment, so its continuation would resume onto closed
 * handles — `The database connection is not open`, or worse, a handle opened
 * after the await that nothing ever closes. The rest parameter below makes
 * that a compile error rather than a runtime surprise, and the runtime check
 * in the sync core catches the JavaScript caller the types cannot reach.
 */
export async function withExistingNanoclawOutbound<T>(
  agentGroupId: string,
  sessionId: string,
  action: (outbound: NanoclawOutboundSession) => T,
  ...sync: SyncActionOnly<T>
): Promise<T | undefined> {
  return withExistingNanoclawOutboundSync(agentGroupId, sessionId, action, ...sync);
}

/**
 * The same funnel, without the promise.
 *
 * The body below never awaited anything: `action` returns `T`, better-sqlite3
 * is synchronous, and the `async` keyword on the form above is conformance
 * with the mailbox interface rather than a statement about the work. That
 * distinction stops being cosmetic the moment a caller needs SEVERAL sessions'
 * outbound state as of ONE instant.
 *
 * A `Promise.all` fan-out cannot give that. Each read resolves at its own
 * moment, so by the time the last one lands the first is already history — and
 * for thread-close, "history" is a container that has since taken new work and
 * cleared its proposal. Deciding from that set kills a working agent. Called in
 * a loop with nothing awaited between the calls and the decision, this gives
 * the one instant the decision needs.
 *
 * Same existence rule, same typed ops, same fault behavior as the async form —
 * it IS the async form's body, so the two cannot drift.
 */
export function withExistingNanoclawOutboundSync<T>(
  agentGroupId: string,
  sessionId: string,
  action: (outbound: NanoclawOutboundSession) => T,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-level only
  ..._sync: SyncActionOnly<T>
): T | undefined {
  const outboundPath = sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
  if (sessionDbPathIsGone(outboundPath)) return undefined;
  let readable: Database.Database | undefined;
  let writable: Database.Database | undefined;
  try {
    const result = action(
      composeOutboundOps(
        () => writable ?? (readable ??= openOutboundDb(outboundPath)),
        () => (writable ??= openOutboundDbWritable(outboundPath)),
        true,
      ),
    );
    // The type above stops a TypeScript caller; this stops the ones it cannot
    // see — plain JavaScript, an `as never`, a callback whose return type is
    // widened through a generic. Returning the promise would hand back a value
    // that only resolves after `finally` has closed the handles it needs, so
    // the failure surfaces here, at the call, instead of somewhere downstream
    // as a closed-connection error nobody can trace back.
    if (isThenable(result)) {
      throw new TypeError(
        'withExistingNanoclawOutbound requires a synchronous action: the outbound handles close when it ' +
          'returns, so an async action resumes onto closed handles. Read what you need synchronously and ' +
          'await outside the funnel.',
      );
    }
    return result;
  } finally {
    writable?.close();
    readable?.close();
  }
}

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
    | 'markLifecycleTerminal'
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
    // The outbound-owned ops come from the one composition the outbound-keyed
    // funnel also uses, so the two surfaces cannot drift apart.
    ...composeOutboundOps(readableOutbound, writableOutbound, outboundPresent),

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
    markLifecycleTerminal: (messageOutId) => markLifecycleTerminal(inbound, messageOutId),
    insertMessage: async (message) => {
      runInsertMessage(inbound, toMessageInsert(message), false);
    },

    insertMessageIfNew: (message) => insertMessageIfNew(inbound, message),
    insertMessageWithContext: (trigger, context) => insertMessageWithContext(inbound, trigger, context),
    insertMessageWithContextIfNew: (trigger, context) => insertMessageWithContextIfNew(inbound, trigger, context),
    insertDeferredMessageWithContextIfNew: (message) => insertDeferredMessageWithContextIfNew(inbound, message),
    withdrawUnconsumedWake: (messageId, containerOwnsOutbound) =>
      withdrawUnconsumedWake(inbound, messageId, () => {
        // Ownership first: it is a Map lookup, and a container that owns
        // outbound.db can write a claim between this read and the delete, so no
        // ack read could rule it out anyway.
        if (containerOwnsOutbound()) return true;
        // A session with no outbound.db has never run a container, so nothing
        // can have claimed. `outboundPresent` is a real ENOENT/ENOTDIR — an
        // unreadable file reaches the opener and throws below.
        if (!outboundPresent) return false;
        try {
          return hasProcessingAck(readableOutbound(), messageId);
        } catch {
          // Unopenable, corrupt, or missing the table: consumption is
          // unprovable, so preserve the row. Losing the message costs more than
          // one stale restart notice.
          return true;
        }
      }),
    reconcileSurvivorWakeRows: () =>
      reconcileSurvivorWakeRows(inbound, (messageId) => {
        // The ack half of `withdrawUnconsumedWake`'s proof, MINUS its ownership
        // half, and the subtraction is the load-bearing part.
        // `containerOwnsOutbound` short-circuits to "a claim is possible" for
        // any RUNNING container — which is true of every adopted session by
        // construction — so reusing it here would refuse every reconciliation
        // this op exists to perform.
        //
        // The ack read alone is the honest probe: a container past its first
        // poll provably cannot select an `on_wake = 1` row, because the runner
        // adds `AND on_wake = 0` to all three selection queries from poll 2
        // onward. The only survivor that could still consume one is a container
        // still ON its first poll when the host adopted it, and that is exactly
        // what a `processing_ack` read catches.
        //
        // KNOWN WINDOW, deferred (fork issue #459): a survivor that has SELECTED
        // an `on_wake` row on its first poll but has not yet written the
        // `processing_ack` reads here as unclaimed, so the row can be converted
        // or withdrawn under it. Closing it needs a fence across the host/runner
        // boundary — the runner would have to publish selection, not just
        // acknowledgement — which is a protocol change, not a probe change, so
        // the probe deliberately stays as it is. The blast radius is one turn's
        // worth of rows in the milliseconds between a survivor's first select
        // and its ack, on the one boot that adopts it.
        if (!outboundPresent) return false;
        try {
          return hasProcessingAck(readableOutbound(), messageId);
        } catch {
          // Unopenable, corrupt, or missing the table: consumption is
          // unprovable, so leave the row exactly as it is.
          return true;
        }
      }),
    nextEvenSeq: () => nextEvenSeq(inbound),
    upsertSessionRouting: (routing) => upsertSessionRouting(inbound, routing),
    readSessionRouting: () => readSessionRouting(inbound),
    setSessionRoutingSpawnTaskId: (taskId) => setSessionRoutingSpawnTaskId(inbound, taskId),
    replaceDestinationRows: (entries) => replaceDestinations(inbound, entries),
    inboundHasMessage: (messageId) => inboundHasMessage(inbound, messageId),

    markPending: (messageOutId) => markPending(inbound, messageOutId),
    getDueOutboundMessages: () => readOutbound([], getDueOutboundMessages),
    listOutboundMessageIds: () => readOutbound([], listOutboundMessageIds),

    getRecentInboundChatSenders: (limit) => getRecentInboundChatSenders(inbound, limit),
    getChannelDestination: (name) => getChannelDestination(inbound, name),
    getLatestTaskContent: (seriesId) => getLatestTaskContent(inbound, seriesId),
    getLatestRoutedTaskRow: (seriesId) => getLatestRoutedTaskRow(inbound, seriesId),
    getInboundRoutingAnchor: (messageId) => getInboundRoutingAnchor(inbound, messageId),
    getInboundRequestIdentity: (sequence) => getInboundRequestIdentity(inbound, sequence),
    getRecoverableLifecycleStatus: (outboundId) =>
      readOutbound(null, (outbound) => getRecoverableLifecycleStatus(inbound, outbound, outboundId)),

    getNextFutureProcessAfter: () => getNextFutureProcessAfter(inbound),
    expireStalePending: (maxAgeMs) => expireStalePending(inbound, maxAgeMs),
    expireClosedSessionPending: () => expireClosedSessionPending(inbound),
    getDueWakePriority: () => getDueWakePriority(inbound),
    syncProcessingAcks: () => readOutbound([], (outbound) => syncProcessingAcks(inbound, outbound)),
    listOverdueRecurringRows: (cutoffIso) =>
      listOverdueRecurringRows(inbound, outboundPresent ? readableOutbound() : null, cutoffIso),
    // A never-woken session has no turn usage: empty is the honest answer here,
    // not the opener's throw (the rollup runs over every session every tick).
    listTurnUsageSince: (afterId) => readOutbound([], (outbound) => listTurnUsageSince(outbound, afterId)),

    insertTaskRow: (row) => insertTaskRow(inbound, row),
    dispatchTaskEvent: (input) => dispatchTaskEvent(inbound, input, outboundPresent ? readableOutbound() : null),
    readTaskSettlement: (eventId, threadId, observer) =>
      readTaskSettlement(inbound, outboundPresent ? readableOutbound() : null, eventId, threadId, observer),
    resumeTask: (taskId) => resumeTask(inbound, taskId),
    updateTask: (taskId, update) => updateTask(inbound, taskId, update),
    getCompletedRecurringRows: () => getCompletedRecurring(inbound),
    insertRecurrence: (msg, newId, nextRun, status) => insertRecurrence(inbound, msg, newId, nextRun, status),
    armNextRecurrence: (originalId, msg, newId, nextRun, status) =>
      armNextTask(inbound, originalId, msg, newId, nextRun, status),
    restoreTaskRow: (snapshot) => restoreTaskRow(inbound, snapshot),
    restoreTaskSeries: (touchedId, prior, priorRecall) => restoreTaskSeries(inbound, touchedId, prior, priorRecall),
    cancelSeriesWithStrandClear: (taskId) => cancelSeriesWithStrandClear(inbound, taskId),
    cancelTaskRow: (rowId) => cancelTaskRow(inbound, rowId),
    cancelTaskRowWithMoveReceipt: (rowId, receiptId) => cancelTaskRowWithMoveReceipt(inbound, rowId, receiptId),
    hasMoveCancellationReceipt: (receiptId) => hasMoveCancellationReceipt(inbound, receiptId),
    getLiveTaskRow: (seriesId) => getLiveTaskRow(inbound, seriesId),
    getLiveTaskRowById: (rowId) => getLiveTaskRowById(inbound, rowId),
    upsertTaskSeries: (row) => upsertTaskSeries(inbound, row),
    listDueTaskRows: () => listDueTaskRows(inbound),
    resolvePendingTask: (taskId, status) => resolvePendingTask(inbound, taskId, status),
    setPendingTaskContent: (taskId, content) => setPendingTaskContent(inbound, taskId, content),
    listCliTaskSeries: (status) => listCliTaskSeries(inbound, status),
    getCliTaskRow: (id) => getCliTaskRow(inbound, id),
    getCreatedTaskRow: (id) => getCreatedTaskRow(inbound, id),

    demoteUnpairedLegacyTasks: () => demoteUnpairedLegacyTasks(inbound),
    hasPendingRecallPairedTrigger: () => hasPendingRecallPairedTrigger(inbound),
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

    hasRestartNoteSince: (since) => hasRestartNoteSince(inbound, since),

    readRepoIngressFence: () => readRepoIngressFence(inbound),
    activateRepoIngressFence: (epoch) => activateRepoIngressFence(inbound, epoch),
    admitRepoIngressFenceMessage: (epoch, messageId) => admitRepoIngressFenceMessage(inbound, epoch, messageId),
    releaseRepoIngressFence: (epoch, generation) => releaseRepoIngressFence(inbound, epoch, generation),

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
    latestOutboundChat: () => readOutbound(null, latestOutboundChat),
    markInboundCompletedIfPending: (messageId) => markInboundCompletedIfPending(inbound, messageId),
    outboundHasContentLike: (marker) => readOutbound(false, (outbound) => outboundHasContentLike(outbound, marker)),
    outboundHasRecentContentLike: (marker, withinSeconds) =>
      readOutbound(false, (outbound) => outboundHasRecentContentLike(outbound, marker, withinSeconds)),
    hasNonStatusReplyTo: (messageId) => readOutbound(false, (outbound) => hasNonStatusReplyTo(outbound, messageId)),
  };
}
