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
import fs from 'fs';
import type Database from 'better-sqlite3';

import { sessionMailboxDir, sessionMailboxPath } from '../../mailbox/sqlite/paths.js';
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
  markDelivered,
  markDeliveryFailed,
  markPending,
  type OutboundMessage as ForkOutboundMessage,
} from './ops/delivery.js';
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

export { SessionDbMissingError } from './openers.js';

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
   * Create the session's mailbox files if they are absent.
   *
   * Upstream's `prepare()` shape with the fork's `ensureSchema`: the fork
   * schema is a strict superset of upstream's baseline (H-4 pins that), so
   * calling `super.prepare()` first would open, write and close each fresh
   * file a second time for a schema this call immediately supersedes. One
   * open per fresh file is what `initSessionFolder` has always done, and this
   * is the hot path once PRs 3-6 route every write through
   * `withMailboxSession` (which prepares before every session).
   *
   * An EXISTING DB is left alone here and gets its legacy migrations at that
   * session's first `session()` — never in `prepare()`, which must not record
   * anything in the migration memo.
   */
  override prepare(key: MailboxSessionKey): void {
    fs.mkdirSync(sessionMailboxDir(key), { recursive: true });
    const inbound = sessionMailboxPath(key, 'inbound');
    const outbound = sessionMailboxPath(key, 'outbound');
    if (!fs.existsSync(inbound)) ensureSchema(inbound, 'inbound');
    if (!fs.existsSync(outbound)) ensureSchema(outbound, 'outbound');
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
      const session: NanoclawMailboxSession = {
        ...wrapSqliteInbound(inbound),
        ...wrapSqliteOutbound(readableOutbound, writableOutbound),
        ...forkOps(inbound, readableOutbound),
      };
      return await action(session);
    } finally {
      inbound.close();
      outbound?.close();
      outboundWriter?.close();
    }
  }
}

/**
 * The fork's ops, bound to the handles open for this session.
 *
 * Only the readable outbound handle is threaded in: no fork op writes to
 * outbound.db from inside a session today (`writeOutboundDirect` still uses
 * the raw helper in session-manager.ts, which PR 7 removes), and upstream's
 * own wrapper already owns the writable one.
 */
function forkOps(
  inbound: Database.Database,
  readableOutbound: () => Database.Database,
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
  };
}
