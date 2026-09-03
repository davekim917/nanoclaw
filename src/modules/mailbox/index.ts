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
  type ChannelDestination,
  type InboundChatSenderRow,
  type InboundRoutingAnchor,
  type RoutedTaskRow,
} from './ops/lookups.js';
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

export { SessionDbMissingError } from './openers.js';
export { parseSqliteUtc } from './sqlite-utc.js';
export {
  canAttemptContinuationRecovery,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './ops/continuation.js';
export type { DirectOutboundRow, InboundMessageRouting } from './ops/recovery.js';
export { INTERACTIVE_WAKE_MAX_AGE_MS, type ContainerState as ForkContainerStateRow } from './ops/sweep.js';

/**
 * The session directory layout, for callers that only need a PATH.
 *
 * Re-exported from upstream's `sqlite/paths.ts` so no fork file has to reach
 * into the driver directory (and so the layout has one definition). A caller
 * that wants the DATA there opens a mailbox session instead.
 */
export { sessionMailboxDir, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';

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

  // --- fork-only sweep ----------------------------------------------------
  getNextFutureProcessAfter(): string | null;
  expireStalePending(maxAgeMs: number): number;
  getDueWakePriority(): 'interactive' | 'scheduled';
  /** Fused: reads outbound processing_ack and writes inbound statuses in one action. */
  syncProcessingAcks(): void;
  /** Raw snake_case claim rows; upstream's `getProcessingClaims` returns the record shape. */
  getProcessingClaimRows(): ProcessingClaim[];

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

  // --- TRANSITIONAL: raw handles for callers not yet on the seam ----------
  /**
   * The open inbound / readable outbound handles behind this session.
   *
   * These exist for exactly one reason: a handful of helpers the host sweep
   * calls still take a `Database.Database` and live in files owned by other
   * PRs of this series (`modules/scheduling/*`, `dashboard/thread-close.ts`,
   * `session-manager.ts`, `db/usage.ts`). Handing them the session's own
   * handle keeps the sweep on ONE open per session per duty instead of
   * reopening the file beside a live session.
   *
   * Every use is a debt, not an API: `src/mailbox-seam-ratchet.ts` counts
   * these names as raw access, so a file that calls one stays on the
   * allowlist until its callee moves behind the seam. PR 7 deletes both.
   *
   * The handle is valid only for the duration of the action; never store it.
   */
  legacyInboundHandle(): Database.Database;
  legacyOutboundHandle(): Database.Database;
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
   * True when this session's mailbox files are present.
   *
   * Overrides upstream's `existsSync` probe with the errno-aware one. Only
   * ENOENT/ENOTDIR mean gone; `existsSync` reports EACCES — a session whose
   * directory the host merely cannot traverse — as absent too. That answer
   * propagates: `session()` would raise `SessionDbMissingError` and
   * `withExistingMailboxSession` would resolve `undefined`, so
   * `container-restart`'s skip-the-vanished branch would silently leave a
   * present-but-unreadable session's ingress UNFENCED. A present session must
   * reach the opener and fail there on its real error.
   */
  override async exists(key: MailboxSessionKey): Promise<boolean> {
    return (
      !sessionDbPathIsGone(sessionMailboxPath(key, 'inbound')) &&
      !sessionDbPathIsGone(sessionMailboxPath(key, 'outbound'))
    );
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
      return await action(composeNanoclawSession(inbound, readableOutbound, writableOutbound));
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
): NanoclawMailboxSession {
  return {
    ...wrapSqliteInbound(inbound),
    ...wrapSqliteOutbound(readableOutbound, writableOutbound),
    ...forkOps(inbound, readableOutbound, writableOutbound),
  };
}

/**
 * The fork's ops, bound to the handles open for this session.
 *
 * Both outbound accessors are threaded in and both are lazy: an action that
 * only reads never opens the writable handle, so the host keeps its
 * read-only-by-default posture on the container-owned file. The writable one
 * is used by the two host-side writers that already existed — the direct
 * outbound notice and the work-continuation recovery admission — both of
 * which only run with the container confirmed stopped.
 */
function forkOps(
  inbound: Database.Database,
  readableOutbound: () => Database.Database,
  writableOutbound: () => Database.Database,
): Omit<NanoclawMailboxSession, keyof MailboxSession> &
  Pick<
    NanoclawMailboxSession,
    'setRouting' | 'countDueMessages' | 'markDelivered' | 'markDeliveryFailed' | 'getContainerState' | 'insertMessage'
  > {
  return {
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
      const row = getContainerState(readableOutbound());
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
    replaceDestinationRows: (entries) => replaceDestinations(inbound, entries),
    inboundHasMessage: (messageId) => inboundHasMessage(inbound, messageId),

    markPending: (messageOutId) => markPending(inbound, messageOutId),
    getDueOutboundMessages: () => getDueOutboundMessages(readableOutbound()),
    listOutboundMessageIds: () => listOutboundMessageIds(readableOutbound()),

    getRecentInboundChatSenders: (limit) => getRecentInboundChatSenders(inbound, limit),
    getChannelDestination: (name) => getChannelDestination(inbound, name),
    getLatestTaskContent: (seriesId) => getLatestTaskContent(inbound, seriesId),
    getLatestRoutedTaskRow: (seriesId) => getLatestRoutedTaskRow(inbound, seriesId),
    getInboundRoutingAnchor: (messageId) => getInboundRoutingAnchor(inbound, messageId),

    getNextFutureProcessAfter: () => getNextFutureProcessAfter(inbound),
    expireStalePending: (maxAgeMs) => expireStalePending(inbound, maxAgeMs),
    getDueWakePriority: () => getDueWakePriority(inbound),
    syncProcessingAcks: () => syncProcessingAcks(inbound, readableOutbound()),
    getProcessingClaimRows: () => getProcessingClaims(readableOutbound()),

    readRepoIngressFence: () => readRepoIngressFence(inbound),
    activateRepoIngressFence: (epoch) => activateRepoIngressFence(inbound, epoch),
    admitRepoIngressFenceMessage: (epoch, messageId) => admitRepoIngressFenceMessage(inbound, epoch, messageId),
    releaseRepoIngressFence: (epoch, generation) => releaseRepoIngressFence(inbound, epoch, generation),
    readRepositoryMountBarrierAck: () => readRepositoryMountBarrierAck(readableOutbound()),

    readWorkContinuation: () => readWorkContinuation(readableOutbound()),
    readContinuationRecoveryAttemptAt: (continuation) =>
      readContinuationRecoveryAttemptAt(readableOutbound(), continuation),
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
    latestOutboundTimestamp: () => latestOutboundTimestamp(readableOutbound()),
    markInboundCompletedIfPending: (messageId) => markInboundCompletedIfPending(inbound, messageId),
    outboundHasContentLike: (marker) => outboundHasContentLike(readableOutbound(), marker),
    outboundHasRecentContentLike: (marker, withinSeconds) =>
      outboundHasRecentContentLike(readableOutbound(), marker, withinSeconds),
    hasNonStatusReplyTo: (messageId) => hasNonStatusReplyTo(readableOutbound(), messageId),
    writeOutboundDirect: (message) => writeOutboundDirectRow(writableOutbound(), message),

    legacyInboundHandle: () => inbound,
    legacyOutboundHandle: () => readableOutbound(),
  };
}
