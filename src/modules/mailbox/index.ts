/**
 * The fork's `AgentMailbox`: extends upstream's `SqliteAgentMailbox` (whose
 * files under `src/mailbox/` are byte-identical to upstream and never edited)
 * with the fork's session-DB behavior.
 */
import type Database from 'better-sqlite3';
import {
  dispatchTaskEvent,
  hasTaskDispatchEvents,
  type TaskDispatchInput,
  type TaskDispatchResult,
} from './ops/task-dispatch.js';
import { readTaskSettlement, type TaskSettlement } from './ops/task-settlement.js';
export { dispatchSeriesId, validateDispatchKey } from './ops/task-dispatch.js';

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
  getNextScheduledWakeAt,
  getTaskListSettlement,
  type TaskListSettlement,
  getLatestRoutedTaskRow,
  getLatestTaskContent,
  getTaskOccurrenceSeriesId,
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
  readTaskListInFlight,
  readWorktreeInFlight,
  type ContinuationPresence,
  type DoneProposal,
  type TaskListInFlight,
  type WorktreeInFlight,
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
  listStuckGateResults,
  hasUnrecordedGateRows,
  syncProcessingAcks,
  type ContainerState as ForkContainerState,
  type OverdueRecurringRows,
  type ProcessingClaim,
  type StuckGateResults,
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
export { isContinuationParked, type HostWorkContinuation } from './ops/continuation.js';
export { type ContainerState as ForkContainerStateRow } from './ops/sweep.js';
export { type ProviderRecallState } from './ops/recall.js';
export { type DestinationRow, type MessageInsert } from './ops/ingress.js';
export { cancelTask, pauseTask } from '../../mailbox/sqlite/tasks.js';
export {
  cancelSeriesWithStrandClear,
  getCompletedRecurring,
  insertRecurrence,
  insertTaskRow,
  restoreTaskRow,
  resumeTask,
  updateTask,
  type CliTaskRow,
  type RecurringMessage,
  type TaskRowSnapshot,
  type TaskUpdate,
} from './ops/tasks.js';
export {
  CLOSE_REASON_MAX_CHARS,
  clearWorkContinuation,
  readDoneProposal,
  type DoneProposal,
  type TaskListInFlight,
  type WorktreeInFlight,
} from './ops/session-state.js';

/** The layout, for callers that only need a PATH; for the data, open a mailbox session. */
export { sessionMailboxDir, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';

/** The host-owned inbound layout and the spawn path's one-time migration onto it. */
export {
  HOST_INBOUND_DIR_NAME,
  assertHostOwnedInboundDb,
  hostInboundDbPathFor,
  hostInboundDirFor,
  hostInboundMounts,
  migrateInboundDbToHostDir,
  resolveInboundDbPath,
} from './host-inbound.js';

/** Read-only session access for operator surfaces; see read-only.ts. */
export { readSessionInbound, readSessionOutbound, type SessionReadLocation } from './read-only.js';
export type { MessageTailRow, ScheduledTaskRow, TaskFireRow } from './ops/reads.js';
export type { ContainerState } from './ops/sweep.js';

/**
 * Path-level (needed before any handle opens, and for sessions with no
 * mailbox); `null` means do not arm the quiet gate.
 */
export function sessionOutboundStorageStat(
  agentGroupId: string,
  sessionId: string,
): { mtimeNs: bigint; size: number } | null {
  return outboundStorageStat(sessionMailboxPath({ agentGroupId, sessionId }, 'outbound'));
}

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Copy of upstream's module-private `sqliteTimestamp` (not exported, and
 * upstream files are never edited); the drift manifest flags upstream changes.
 */
function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

/**
 * Upstream's normalized fields plus the fork's raw columns, so it stays
 * assignable to upstream's `ContainerState`.
 */
interface NanoclawContainerState extends UpstreamContainerState, ForkContainerState {}

type NanoclawInboundInsert = MessageInsert | InboundMessage;

/**
 * Extends upstream's `MailboxSession`; members redeclared here have fork
 * behavior, the rest are fork-only. Ops the fork implements byte-identically
 * are deliberately NOT redeclared: one implementation of any SQL statement.
 */
export interface NanoclawMailboxSession extends MailboxSession {
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

  insertMessageIfNew(message: MessageInsert): boolean;
  insertMessageWithContext(trigger: MessageInsert, context: MessageInsert | null): void;
  insertMessageWithContextIfNew(trigger: MessageInsert, context: MessageInsert | null): boolean;
  insertDeferredMessageWithContextIfNew(message: MessageInsert): boolean;
  /**
   * Withdraw an `on_wake` row and its recall partner only on proof no container
   * could have claimed it. `containerOwnsOutbound` must be a LIVE probe: it is
   * invoked inside the op, immediately before the delete.
   */
  withdrawUnconsumedWake(messageId: string, containerOwnsOutbound: () => boolean): boolean;
  /**
   * Reconcile every unconsumed `on_wake` row a SURVIVING container can no longer
   * select. Takes no ownership probe: the registry is the wrong authority here.
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

  markPending(messageOutId: string): void;
  getDueOutboundMessages(): ForkOutboundMessage[];
  /** Due or not: what "outstanding" means to the drain loop. */
  listOutboundMessageIds(): string[];

  getRecentInboundChatSenders(limit: number): InboundChatSenderRow[];
  getChannelDestination(name: string): ChannelDestination | null;
  getLatestTaskContent(seriesId: string): string | null;
  getTaskOccurrenceSeriesId(occurrenceId: string): string | null;
  getLatestRoutedTaskRow(seriesId: string): RoutedTaskRow | null;
  getInboundRoutingAnchor(messageId: string): InboundRoutingAnchor | null;
  getInboundRequestIdentity(sequence: number): InboundRequestIdentity | null;
  getRecoverableLifecycleStatus(outboundId?: string): RecoverableLifecycleStatus | null;
  /** When the earliest `wait` the agent armed comes due, if it has not yet (see the op). */
  getNextScheduledWakeAt(): string | null;
  getTaskListSettlement(killedAt: string): TaskListSettlement | null;

  /**
   * False for never-woken sessions. Outbound READS already degrade to empty,
   * so use this only to skip a whole block of work.
   */
  hasOutbound(): boolean;

  getNextFutureProcessAfter(): string | null;
  expireStalePending(maxAgeMs: number): number;
  /**
   * No age cutoff, no recurrence guard: correct only once the session row is
   * (or is about to be) `closed`.
   */
  expireClosedSessionPending(): number;
  getDueWakePriority(): 'interactive' | 'scheduled';
  /**
   * Fused: reads outbound processing_ack and writes inbound statuses. Returns
   * the ids completed because the runner had already answered them.
   */
  syncProcessingAcks(): string[];
  /** Recurring occurrences due since before `cutoffIso` that no container has acknowledged (see the op). */
  listOverdueRecurringRows(cutoffIso: string): OverdueRecurringRows;
  /** Gate-lane results not on record since before `cutoffIso` (see the op). */
  listStuckGateResults(cutoffIso: string): StuckGateResults;
  /** A container gate row delivery has not recorded yet (see the op). */
  hasUnrecordedGateRows(): boolean;
  /** Raw snake_case claim rows; upstream's `getProcessingClaims` returns the record shape. */
  getProcessingClaimRows(): ProcessingClaim[];
  /** Oldest first; `[]` when the container never wrote the table (the normal case). */
  listTurnUsageSince(afterId: number): SessionTurnUsageRow[];

  // Upstream's task ops are reused wherever the statement matches; only these differ.
  /** Fork insert: routing columns, and `trigger = 0` so the row lands inert. */
  insertTaskRow(row: TaskRowInsert): void;
  dispatchTaskEvent(input: TaskDispatchInput): TaskDispatchResult;
  hasTaskDispatchEvents(): boolean;
  readTaskSettlement(
    eventId: string,
    threadId: string | null,
    observer?: boolean,
    futureInputs?: boolean,
  ): TaskSettlement;
  /** Fork resume: also drops the stale recall pair and re-seqs the occurrence. */
  resumeTask(taskId: string): number;
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
   * Upstream's `armNextTask` under a fork name (same one-transaction guarantee):
   * the fork's clone needs the whole source row, which upstream's shape can't carry.
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
   * Undo one `upsertTaskSeries` by the row it touched (from its return value):
   * undoing by `series_id` would cancel a sibling occurrence.
   */
  restoreTaskSeries(touchedId: string, prior: TaskSeriesSnapshot | null, priorRecall: TaskSeriesSnapshot | null): void;
  cancelSeriesWithStrandClear(taskId: string): number;
  /** The by-id twin of upstream's series-wide `cancelTask`. */
  cancelTaskRow(rowId: string): number;
  cancelTaskRowWithMoveReceipt(rowId: string, receiptId: string): number;
  hasMoveCancellationReceipt(receiptId: string): boolean;
  /**
   * On the WRITE session too: a writer that approved a row before an await must
   * re-prove it is still the live one before mutating.
   */
  getLiveTaskRow(seriesId: string): ScheduledTaskRow | null;
  /** Proves a move owns its target row. */
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
   * Not upstream's `listLiveTasks`/`getTask`: those return a `TaskRecord` with
   * no routing columns, and the CLI shows where a task posts.
   */
  listCliTaskSeries(status?: 'pending' | 'paused'): CliTaskRow[];
  getCliTaskRow(id: string): CliTaskRow | undefined;
  getCreatedTaskRow(id: string): CreatedTaskRow | undefined;

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

  readProviderRecallState(provider: string): ProviderRecallState;
  listOpenChatContents(): Array<{ content: string }>;
  listRecentRecallRows(limit: number): Array<{ id: string; status: string; content: string }>;
  hasMatchingBootstrapRecall(excludeRecallId: string | null, provider: string, contextEpoch: number): boolean;

  readContinuationPresence(): ContinuationPresence | null;
  /** Opens outbound.db read-write. The only host write to a container-owned key. */
  clearWorkContinuation(): ContinuationPresence | null;
  readDoneProposal(): DoneProposal | null;
  readWorktreeInFlight(): WorktreeInFlight | null;
  readTaskListInFlight(): TaskListInFlight | null;
  hasRestartNoteSince(since: string): boolean;

  readRepoIngressFence(): RepoIngressFence | null;
  activateRepoIngressFence(epoch: string): RepoIngressFence;
  admitRepoIngressFenceMessage(epoch: string, messageId: string): RepoIngressAdmissionResult;
  releaseRepoIngressFence(epoch: string, generation: string): RepoIngressReleaseResult;
  readRepositoryMountBarrierAck(): string | null;

  readWorkContinuation(): HostWorkContinuation | null;
  readContinuationRecoveryAttemptAt(continuation: HostWorkContinuation): number;
  /** Writes outbound: opens the writable handle. Only valid with the container stopped. */
  incrementWorkContinuationResumeAttempt(expectedId: string): HostWorkContinuation | null;
  migrateLegacyWorkContinuationForRecovery(): HostWorkContinuation | null;
  restoreWorkContinuationResumeAttempt(
    attempted: HostWorkContinuation,
    previous: HostWorkContinuation,
  ): HostWorkContinuation | null;

  hasDueRecoveryWake(nowIso: string): boolean;
  parkDueRecoveryWakes(nowIso: string): number;
  countRecoveryAttemptsSinceRealInbound(idPrefix: string): number;
  latestRecoveryMarkerTimestamp(idPrefix: string): string | null;
  latestRecoveryMarkerId(idPrefix: string): string | null;
  readMessageRouting(messageId: string): InboundMessageRouting | undefined;
  latestInboundTimestamp(): string | null;
  latestOutboundTimestamp(): string | null;
  /** Status edits excluded. */
  latestOutboundChat(): OutboundChatRow | null;
  markInboundCompletedIfPending(messageId: string): void;
  outboundHasContentLike(marker: string): boolean;
  outboundHasRecentContentLike(marker: string, withinSeconds: number): boolean;
  hasNonStatusReplyTo(messageId: string): boolean;
  /** The fork's `MAX(seq) + 2` direct write; opens the writable outbound handle. */
  writeOutboundDirect(message: DirectOutboundRow): void;
}

/**
 * The outbound READS, as a `Pick` of the session's own signatures (one
 * definition per op). Safe on any session: nothing here writes the
 * container-owned file. Same vocabulary as read-only `OutboundSessionRead`;
 * a union of the two belongs in ONE of them, not a third type.
 */
type NanoclawOutboundRead = Pick<
  NanoclawMailboxSession,
  | 'getContainerState'
  | 'getProcessingClaimRows'
  | 'readRepositoryMountBarrierAck'
  | 'readDoneProposal'
  | 'readWorktreeInFlight'
  | 'readTaskListInFlight'
  | 'readContinuationPresence'
>;

/**
 * The reads plus the three outbound WRITES the host performs, each valid only
 * with the container stopped or append-only: `clearWorkContinuation`
 * (thread-close force-clear), `deleteOrphanProcessingClaims`, and
 * `writeOutboundDirect` (router notices, outbound-keyed so they still land when
 * inbound.db was reclaimed).
 */
export type NanoclawOutboundSession = NanoclawOutboundRead &
  Pick<NanoclawMailboxSession, 'clearWorkContinuation' | 'deleteOrphanProcessingClaims' | 'writeOutboundDirect'>;

export type NanoclawMailboxAction<T> = (mailbox: NanoclawMailboxSession) => T | Promise<T>;

/**
 * Makes an async action a compile error: `[never]` demands an argument nothing
 * can supply. Neither a conditional on the return type nor on the parameter
 * works (the latter isn't an inference site, so every action passes).
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

function toMessageInsert(message: NanoclawInboundInsert): MessageInsert {
  const flag = (value: boolean | 0 | 1 | undefined): 0 | 1 | undefined =>
    value === undefined ? undefined : value ? 1 : 0;
  return { ...message, trigger: flag(message.trigger), onWake: flag(message.onWake) };
}

export class NanoclawAgentMailbox extends SqliteAgentMailbox {
  /**
   * Named apart from upstream's `private` `migrated`. Written ONLY in
   * `session()`: `prepare()` skips existing DBs, so recording there would
   * suppress the legacy migrations they need.
   */
  private readonly nanoclawMigrated = new Set<string>();

  /**
   * Decided on `inbound.db` ALONE (upstream requires both): never-woken sessions
   * have only inbound.db, and requiring both would skip their task admission and
   * leave their ingress unfenced. Errno-aware: only ENOENT/ENOTDIR mean gone, so
   * an untraversable (EACCES) session reaches the opener and fails on its real error.
   */
  override async exists(key: MailboxSessionKey): Promise<boolean> {
    return !sessionDbPathIsGone(sessionMailboxPath(key, 'inbound'));
  }

  /**
   * `super.prepare()` creates missing files; the fork's `ensureSchema` then runs
   * on both ALWAYS, because an existing DB may still lack baseline tables (the
   * v1→v2 migration provisions over such directories). The migration memo is
   * untouched here.
   */
  override prepare(key: MailboxSessionKey): void {
    // PROVISIONING DELIBERATELY DOES NOT MIGRATE to `.host/`: `prepare()` runs
    // under live containers whose `/workspace` is read-WRITE, and creating
    // `.host/` there would hand the container the authoritative file with no
    // overlay. Only `buildMounts` migrates, then refuses a non-host-owned spawn.
    super.prepare(key);
    const sessionPath = sessionMailboxDir(key);
    // The RESOLVED path: naming `.host/` unconditionally would provision a
    // second, empty database for a not-yet-migrated session.
    ensureSchema(resolveInboundDbPath(sessionPath), 'inbound');
    ensureSchema(sessionMailboxPath(key, 'outbound'), 'outbound');
  }

  override async destroy(key: MailboxSessionKey): Promise<void> {
    const sessionPath = sessionMailboxDir(key);
    // Both spellings: the memo is keyed on whichever path `session()` resolved.
    this.nanoclawMigrated.delete(hostInboundDbPathFor(sessionPath));
    this.nanoclawMigrated.delete(sessionMailboxPath(key, 'inbound'));
    await super.destroy(key);
    removeHostInboundDir(sessionPath);
    // The provenance record goes with the file, or a reused (group, session id)
    // would inherit it.
    await deleteHostInboundProvenance(key.agentGroupId, key.sessionId);
  }

  /**
   * Re-implements upstream's `session()` because fork ops need the open handles
   * and upstream's memo is private; the drift manifest flags upstream changes.
   */
  override async session<T>(key: MailboxSessionKey, action: NanoclawMailboxAction<T>): Promise<T> {
    const inboundPath = resolveInboundDbPath(sessionMailboxDir(key));
    const outboundPath = sessionMailboxPath(key, 'outbound');
    // SessionDbMissingError, not upstream's Error: callers branch on it to skip
    // a vanished session.
    if (!(await this.exists(key))) throw new SessionDbMissingError(inboundPath);
    const inbound = openInboundDb(inboundPath);
    let outbound: Database.Database | undefined;
    let outboundWriter: Database.Database | undefined;
    // Sampled once at entry; only ENOENT/ENOTDIR counts as absent.
    const outboundPresent = !sessionDbPathIsGone(outboundPath);
    const readableOutbound = () => (outbound ??= openOutboundDb(outboundPath));
    const writableOutbound = () => (outboundWriter ??= openOutboundDbWritable(outboundPath));
    try {
      if (!this.nanoclawMigrated.has(inboundPath)) {
        // Upstream's migrations, then the fork's superset: redundant on purpose,
        // so a future divergence surfaces as a schema difference.
        upstreamMigrateMessagesInTable(inbound);
        ensureNanoclawInboundSchema(inbound);
        this.nanoclawMigrated.add(inboundPath);
      }
      // Sequences are allocated per file: the host must never read the
      // container-owned outbound.db just to insert an inbound row.
      return await action(composeNanoclawSession(inbound, readableOutbound, writableOutbound, outboundPresent));
    } finally {
      inbound.close();
      outbound?.close();
      outboundWriter?.close();
    }
  }
}

/**
 * The outbound ops, shared by `forkOps` and `withExistingNanoclawOutbound` so
 * they can't drift. Lazy: a read-only action never opens the writer.
 * `outboundPresent` false degrades the READS to empty.
 */
function composeOutboundOps(
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
    // These honour `outboundPresent` too, and `clearWorkContinuation` must:
    // otherwise it would author the container-owned outbound.db the host must
    // never create.
    readDoneProposal: () => readOutbound(null, readDoneProposal),
    readWorktreeInFlight: () => readOutbound(null, readWorktreeInFlight),
    readTaskListInFlight: () => readOutbound(null, readTaskListInFlight),
    readContinuationPresence: () => readOutbound(null, readContinuationPresence),
    clearWorkContinuation: () => (outboundPresent ? clearWorkContinuation(writableOutbound()) : null),
    // Rebinds upstream's op: upstream's takes `writable()` unconditionally and
    // would create outbound.db on a session that never ran.
    deleteOrphanProcessingClaims: () => (outboundPresent ? deleteOrphanProcessingClaims(writableOutbound()) : 0),
    // Deliberately NOT degraded: the writer refuses a missing file, and "the
    // notice was written" would be a false answer.
    writeOutboundDirect: (message) => writeOutboundDirectRow(writableOutbound(), message),
  };
}

/**
 * One operation against a session's OUTBOUND database alone; `undefined` (never
 * provision, never throw) when outbound.db is absent. Not the mailbox session:
 * that keys existence on inbound.db, so a session whose inbound.db is gone but
 * outbound.db remains would read as empty. The existence question is keyed to
 * the file the read touches.
 *
 * Hands out typed ops, never a raw `Database`. Handles open lazily and the
 * reads share an open writer. Present-but-unopenable raises
 * `SessionDbUnopenableError`; a file vanishing mid-call raises
 * `SessionDbMissingError`. Lives here, not read-only.ts, to avoid an import
 * cycle through the barrel.
 *
 * The action must be SYNCHRONOUS: handles close when it returns, so an async
 * continuation would run on closed handles. Enforced at compile time and at runtime.
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
 * Synchronous form, for reading SEVERAL sessions as of ONE instant: a
 * `Promise.all` fan-out resolves each at its own moment, and thread-close
 * deciding from stale state kills a working agent. Same body as the async form.
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
    // Catches callers the type can't (plain JS, `as never`, widened generics):
    // returning the promise would resolve after `finally` closed its handles.
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
 * Both outbound accessors are lazy. The writable one serves only host writers
 * that run with the container confirmed stopped.
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
   * An outbound READ, or `empty` for a session with no outbound.db (a normal
   * state). WRITES deliberately do not degrade.
   */
  const readOutbound = <T>(empty: T, read: (outbound: Database.Database) => T): T =>
    outboundPresent ? read(readableOutbound()) : empty;

  return {
    // The same composition the outbound-keyed funnel uses.
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
        // Ownership first: an owning container can write a claim between an ack
        // read and the delete, so no ack read could rule it out.
        if (containerOwnsOutbound()) return true;
        // No outbound.db: no container ever ran, so nothing can have claimed.
        if (!outboundPresent) return false;
        try {
          return hasProcessingAck(readableOutbound(), messageId);
        } catch {
          // Consumption unprovable: preserve the row (losing a message costs more).
          return true;
        }
      }),
    reconcileSurvivorWakeRows: () =>
      reconcileSurvivorWakeRows(inbound, (messageId) => {
        // The ack half of the proof WITHOUT the ownership half: every adopted
        // survivor is running, so ownership would refuse every reconciliation.
        // Past its first poll the runner never selects `on_wake = 1` rows, so
        // an ack read catches the only survivor that could. Known window: a row
        // selected on the first poll but not yet acked reads as unclaimed; closing
        // it needs a protocol change.
        if (!outboundPresent) return false;
        try {
          return hasProcessingAck(readableOutbound(), messageId);
        } catch {
          // Consumption unprovable: leave the row as it is.
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
    getTaskOccurrenceSeriesId: (occurrenceId) => getTaskOccurrenceSeriesId(inbound, occurrenceId),
    getLatestRoutedTaskRow: (seriesId) => getLatestRoutedTaskRow(inbound, seriesId),
    getInboundRoutingAnchor: (messageId) => getInboundRoutingAnchor(inbound, messageId),
    getInboundRequestIdentity: (sequence) => getInboundRequestIdentity(inbound, sequence),
    getRecoverableLifecycleStatus: (outboundId) =>
      readOutbound(null, (outbound) => getRecoverableLifecycleStatus(inbound, outbound, outboundId)),
    getNextScheduledWakeAt: () => getNextScheduledWakeAt(inbound),
    getTaskListSettlement: (killedAt) =>
      readOutbound(null, (outbound) => getTaskListSettlement(inbound, outbound, killedAt)),

    getNextFutureProcessAfter: () => getNextFutureProcessAfter(inbound),
    expireStalePending: (maxAgeMs) => expireStalePending(inbound, maxAgeMs),
    expireClosedSessionPending: () => expireClosedSessionPending(inbound),
    getDueWakePriority: () => getDueWakePriority(inbound),
    syncProcessingAcks: () => readOutbound([], (outbound) => syncProcessingAcks(inbound, outbound)),
    listOverdueRecurringRows: (cutoffIso) =>
      listOverdueRecurringRows(inbound, outboundPresent ? readableOutbound() : null, cutoffIso),
    listStuckGateResults: (cutoffIso) =>
      listStuckGateResults(inbound, outboundPresent ? readableOutbound() : null, cutoffIso),
    hasUnrecordedGateRows: () => hasUnrecordedGateRows(inbound, outboundPresent ? readableOutbound() : null),
    // Never-woken sessions: empty, not the opener's throw (runs every tick).
    listTurnUsageSince: (afterId) => readOutbound([], (outbound) => listTurnUsageSince(outbound, afterId)),

    insertTaskRow: (row) => insertTaskRow(inbound, row),
    dispatchTaskEvent: (input) => dispatchTaskEvent(inbound, input, outboundPresent ? readableOutbound() : null),
    hasTaskDispatchEvents: () => hasTaskDispatchEvents(inbound),
    readTaskSettlement: (eventId, threadId, observer, futureInputs) =>
      readTaskSettlement(
        inbound,
        outboundPresent ? readableOutbound() : null,
        eventId,
        threadId,
        observer,
        futureInputs,
      ),
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
