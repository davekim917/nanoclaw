import { canonicalWorkItem, isAdmissibleOutcomeRequestSource, renderWorkOutcome } from './outcome-reporting-schema.js';
import { claimWorkOutcome, settleWorkOutcome } from './db/work-outcome-receipts.js';
/**
 * Outbound message delivery: reads messages_out from outbound.db (container-owned, opened read-only) and tracks
 * delivery in inbound.db's `delivered` table. Never writes outbound.db (single writer per file).
 */
import {
  bumpLastOutbound,
  getRunningSessions,
  getSession,
  getSessionsActiveSince,
  createPendingQuestion,
  getPendingApproval,
  getPendingApprovalsBySession,
  isTaskThread,
  taskSeriesId,
  TASKS_SYSTEM_THREAD_ID,
} from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import {
  clearDeliveryAttempt,
  getDeliveryAttempt,
  recordDeliveryAttempt,
  type DeliveryAttemptRow,
} from './db/coordination.js';
import {
  getTaskThreadAnchor,
  setTaskThreadAnchor,
  deleteTaskThreadAnchor,
  anchorRotationKey,
} from './db/task-thread-anchors.js';
import {
  deleteThreadKeyAnchor,
  getThreadKeyAnchor,
  recordThreadKeyAnchor,
  touchThreadKeyAnchor,
  THREAD_KEY_PATTERN,
  type ThreadKeyAddress,
} from './db/thread-key-anchors.js';
import { recordTaskRunOutcome } from './db/task-run-outcomes.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { runGuarded, type DeliveryGuardSpec, type GuardedDeliveryHandler } from './delivery-guard.js';
import { allowedWikiOutbound, wikiEnrollment } from './wiki-admission/policy.js';
import { isUnguarded, unguarded, type Unguarded } from './guard/index.js';
import { log } from './log.js';
import { scrubSecrets } from './secret-scrubber.js';
import { humanizeOutboundContent } from './verdict-tokens.js';
import { archiveMessage } from './message-archive.js';
import { resolveContinueThread } from './continue-thread.js';
import type { RouteCheckRequest } from './thread-route-check.js';
import { forgetRouteVerdict, routeVerdict, routeVetoNotice, type RouteCheckVerdict } from './thread-route-verdict.js';
import { isRouteCheckedKey, splitThreadKey } from './thread-route-split.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, readOutboxFiles, withExistingMailboxSession } from './session-manager.js';
import { sessionOutboundStorageStat, type NanoclawMailboxSession } from './modules/mailbox/index.js';
import type { OutboundMessage } from './modules/mailbox/ops/delivery.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import { TASK_LIST_ENABLED } from './config.js';
import {
  deferTaskListOnRateLimit,
  noteHeldTaskListPost,
  noteTaskListDelivered,
  retireSupersededTaskList,
  supersededTaskListEdits,
  taskListCooldownMs,
  taskListPostReceipt,
} from './task-list-host.js';
import { flagNeedsInput, getTaskByChildSession } from './modules/orchestrator-dispatch/db/tasks.js';
import { appendRunLog } from './modules/scheduling/run-log.js';
import { isGateRow, orderGateRowsBySeq, recordGateRow } from './modules/scheduling/gate-row.js';
import { emitDashboardEvent, emitSessionEvent } from './dashboard/api/events.js';
import type { OutboundFile } from './channels/adapter.js';
import { isChannelVariant, type PendingApproval, type Session } from './types.js';

/** Cached per process and never invalidated: a session's spawn-child status never changes. */
const spawnChildSessionCache = new Map<string, boolean>();
async function isSpawnChildSession(sessionId: string): Promise<boolean> {
  const cached = spawnChildSessionCache.get(sessionId);
  if (cached !== undefined) return cached;
  const isChild = (await getTaskByChildSession(sessionId)) !== null;
  spawnChildSessionCache.set(sessionId, isChild);
  return isChild;
}

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** A deterministic policy refusal: retrying cannot change the verdict, so it is recorded on the first attempt. */
class DeliveryRefusal extends Error {}

/**
 * Attempt counts live in the `delivery_attempts` table, so they survive a
 * host restart: a poison message gets MAX_DELIVERY_ATTEMPTS total, not
 * MAX_DELIVERY_ATTEMPTS per process lifetime (the old in-memory counter
 * reset on every restart, so a crash-looping host retried it forever).
 * Bookkeeping failures never break delivery. The count is read BEFORE calling the adapter: recording attempt N and
 * marking the message failed are separate writes, so a host dying between them would otherwise re-send forever.
 */
async function recordAttemptRow(messageId: string, sessionId: string, err: unknown): Promise<number | null> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    return await recordDeliveryAttempt({
      messageId,
      sessionId,
      now: new Date().toISOString(),
      nextAttemptAt: null,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (recordErr) {
    log.error('Failed to record delivery attempt — retrying next poll without a count', {
      messageId,
      sessionId,
      err: recordErr,
    });
    return null;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** The stored row, or `undefined` (none, or the read failed). Carries `last_error` from a previous host. */
async function readAttemptRow(messageId: string): Promise<DeliveryAttemptRow | undefined> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never block delivery */
  try {
    return await getDeliveryAttempt(messageId);
  } catch (err) {
    log.warn('Failed to read delivery attempt row — delivering without a stored count', { messageId, err });
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function clearAttemptRow(messageId: string): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    await clearDeliveryAttempt(messageId);
  } catch (err) {
    log.warn('Failed to clear delivery attempt row', { messageId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

// Sweep change-gate: a stat of the session DB (journal_mode=DELETE, so every commit moves the main file's mtime)
// decides whether a session can have work. A wrong skip is a silently undelivered message, so: (1) arm only after
// a drain proves NOTHING is outstanding, never after a delivery error (a failed delivery writes nothing to
// outbound.db, so its mtime never moves); (2) expire the skip on time too, bounding the cost of a signal bug.
export const QUIET_DELIVERY_BACKOFF_MS = 10 * 60_000;

export interface QuietDeliveryMark {
  mtimeNs: bigint;
  size: number;
  armedAtMs: number;
}
const quietDeliveryCache = new Map<string, QuietDeliveryMark>();

/** Deterministic [0,1) from a session id — stable across restarts (FNV-1a). */
function sessionJitterFraction(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

/** Jittered across the second half of the window, or sessions armed together would expire together in one burst. */
export function quietDeliveryDeadlineMs(sessionId: string, armedAtMs: number): number {
  const half = QUIET_DELIVERY_BACKOFF_MS / 2;
  return armedAtMs + half + Math.floor(sessionJitterFraction(sessionId) * half);
}

export function shouldSkipQuietDelivery(
  cached: QuietDeliveryMark | undefined,
  current: { mtimeNs: bigint; size: number },
  nowMs: number,
  sessionId: string,
): boolean {
  if (!cached) return false;
  if (cached.mtimeNs !== current.mtimeNs || cached.size !== current.size) return false;
  return nowMs <= quietDeliveryDeadlineMs(sessionId, cached.armedAtMs);
}

export function peekQuietDeliveryMark(sessionId: string): QuietDeliveryMark | undefined {
  return quietDeliveryCache.get(sessionId);
}

export function _resetQuietDeliveryCacheForTest(): void {
  quietDeliveryCache.clear();
}

/** Test seam: an "armed" mark while a due row exists, the corrupted state the time bound must survive. */
export function _setQuietDeliveryMarkForTest(sessionId: string, mark: QuietDeliveryMark): void {
  quietDeliveryCache.set(sessionId, mark);
}

/** Only `clean` may arm the skip. `busy`: a concurrent drain made this one a no-op, so nothing was looked at. */
export type DrainOutcome = 'busy' | 'clean' | 'pending' | 'error';

/**
 * The visible status line per session: the first status in a turn posts, later ones edit in place. Deleted via
 * the STORED route on chat delivery (`send_message` may target a different channel/thread).
 */
interface StatusTrack {
  outboundId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  /** Instance the status was posted through — the orphan delete must reuse it
   *  or it routes through the default-instance adapter (a sibling bot). */
  instance?: string;
  /** Turn anchor (`in_reply_to`); a status with a different anchor means the prior turn ended without a chat-final. */
  inReplyTo: string | null;
  /** Discord refused further edits (code 30046): never retry the edit while a replacement post is pending. */
  editExhausted?: boolean;
  /** True only for the runner-authored deterministic lifecycle row. */
  lifecycle?: boolean;
  /** Tracked but never posted; `messageId` is empty, so nothing may edit or delete it. */
  unposted?: boolean;
}
const statusTracking = new Map<string, StatusTrack>();
const lifecycleRecoveryMisses = new Set<string>();

/** Simulates host-process memory loss while leaving durable mailbox rows intact. */
export function _resetStatusTrackingForTest(): void {
  statusTracking.clear();
  lifecycleRecoveryMisses.clear();
}

/**
 * Drop a session's 💭 status because its container is being killed: a killed container never emits `turn_end`,
 * and for scheduled tasks that is the NORMAL exit (the idle reaper kills after the first result). Covers every
 * kill reason, so the host never depends on a dying process to clean up.
 */
export async function clearSessionStatusOnKill(sessionId: string): Promise<void> {
  await stopSessionLifecycleStatus(sessionId, 'Stopped.', undefined);
}

async function stopSessionLifecycleStatus(
  sessionId: string,
  text: string,
  outboundId: string | undefined,
): Promise<void> {
  let status = statusTracking.get(sessionId);
  if (status && !status.lifecycle) {
    await dropOrphanStatus(sessionId);
    return;
  }
  if (!status) status = await recoverLifecycleStatus(sessionId, outboundId);
  if (status?.unposted) {
    statusTracking.delete(sessionId);
    return;
  }
  if (!status || !deliveryAdapter) return;
  try {
    await deliveryAdapter.deliver(
      status.channelType,
      status.platformId,
      status.threadId,
      'status',
      JSON.stringify({ operation: 'edit', messageId: status.messageId, text }),
      undefined,
      status.instance,
    );
  } catch (err) {
    log.warn('Failed to mark lifecycle status stopped; deleting stale working line', {
      sessionId,
      messageId: status.messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (deliveryAdapter.deleteMessage) {
      try {
        await deliveryAdapter.deleteMessage(
          status.channelType,
          status.platformId,
          status.threadId,
          status.messageId,
          status.instance,
        );
      } catch {
        // Best effort: the adapter rejected both safe terminal operations.
      }
    }
  }
  statusTracking.delete(sessionId);
}

async function recoverLifecycleStatus(sessionId: string, outboundId?: string): Promise<StatusTrack | undefined> {
  if (!outboundId && lifecycleRecoveryMisses.has(sessionId)) return undefined;
  const session = await getSession(sessionId);
  if (!session) {
    if (!outboundId) lifecycleRecoveryMisses.add(sessionId);
    return undefined;
  }
  const recovered = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getRecoverableLifecycleStatus(outboundId),
  );
  if (!recovered) {
    if (!outboundId) lifecycleRecoveryMisses.add(sessionId);
    return undefined;
  }
  lifecycleRecoveryMisses.delete(sessionId);
  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const mg =
    origin && origin.channel_type === recovered.channelType && origin.platform_id === recovered.platformId
      ? origin
      : await getMessagingGroupByPlatform(recovered.channelType, recovered.platformId);
  return {
    outboundId: recovered.outboundId,
    channelType: recovered.channelType,
    platformId: recovered.platformId,
    threadId: recovered.threadId,
    messageId: recovered.platformMessageId,
    instance: mg?.instance,
    inReplyTo: recovered.inReplyTo,
    lifecycle: true,
  };
}

async function dropOrphanStatus(
  sessionId: string,
  opts: { skip?: boolean; recoverLifecycle?: boolean } = {},
): Promise<boolean> {
  let orphan = opts.skip ? undefined : statusTracking.get(sessionId);
  if (!orphan && opts.recoverLifecycle && !opts.skip) orphan = await recoverLifecycleStatus(sessionId);
  let deleted = false;
  if (orphan && !orphan.unposted && deliveryAdapter?.deleteMessage) {
    try {
      await deliveryAdapter.deleteMessage(
        orphan.channelType,
        orphan.platformId,
        orphan.threadId,
        orphan.messageId,
        orphan.instance,
      );
      deleted = true;
    } catch (err) {
      log.warn('Failed to delete orphan thinking-block status — leaving as-is', {
        sessionId,
        channelType: orphan.channelType,
        platformId: orphan.platformId,
        messageId: orphan.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (opts.recoverLifecycle && !opts.skip) lifecycleRecoveryMisses.add(sessionId);
  statusTracking.delete(sessionId);
  return deleted;
}

export interface DeliveredConversation {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

function sameConversation(status: StatusTrack, delivered: DeliveredConversation): boolean {
  return (
    status.channelType === delivered.channelType &&
    status.platformId === delivered.platformId &&
    status.threadId === delivered.threadId
  );
}

async function editSessionLifecycleStatus(status: StatusTrack, text: string): Promise<void> {
  if (!status.lifecycle || status.unposted || !deliveryAdapter) return;
  await deliveryAdapter.deliver(
    status.channelType,
    status.platformId,
    status.threadId,
    'status',
    JSON.stringify({ operation: 'edit', messageId: status.messageId, text }),
    undefined,
    status.instance,
  );
}

async function markSessionLifecycleWaiting(sessionId: string, status: StatusTrack): Promise<void> {
  await editSessionLifecycleStatus(status, 'Waiting for approval.');
  statusTracking.set(sessionId, status);
}

async function markSessionLifecycleTerminal(sessionId: string, status: StatusTrack): Promise<void> {
  if (!status.lifecycle) return;
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Cannot mark lifecycle terminal for missing session ${sessionId}`);
  const marked = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.markLifecycleTerminal(status.outboundId),
  );
  if (!marked) throw new Error(`Cannot mark missing lifecycle delivery ${status.outboundId} terminal`);
}

export async function settleSessionStatusAfterPublicDelivery(
  sessionId: string,
  options: { conversation?: DeliveredConversation; waitWhenElsewhere?: boolean } = {},
): Promise<void> {
  try {
    const status = statusTracking.get(sessionId) ?? (await recoverLifecycleStatus(sessionId));
    if (!status) return;
    if (options.conversation) {
      if (!sameConversation(status, options.conversation)) {
        if (options.waitWhenElsewhere) await markSessionLifecycleWaiting(sessionId, status);
        return;
      }
    }
    statusTracking.set(sessionId, status);
    await markSessionLifecycleTerminal(sessionId, status);
    const isSpawnChild = await isSpawnChildSession(sessionId);
    const deleted = await dropOrphanStatus(sessionId, { skip: isSpawnChild });
    if (!deleted && status.lifecycle) await editSessionLifecycleStatus(status, 'Response delivered.');
  } catch (err) {
    log.warn('Public message delivered but lifecycle settlement failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Discord refuses further edits after an old message reaches its edit cap. */
function isDiscordStatusEditLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 30046 || code === '30046') return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /\b30046\b/.test(message) &&
    /discord api error|maximum number of edits to messages older than 1 hour/i.test(message)
  );
}

function isDiscordChannelType(channelType: string): boolean {
  return channelType === 'discord' || isChannelVariant(channelType, 'discord');
}

/**
 * Per-turn anchor for several channel-ROOT messages (null `thread_id`, set `in_reply_to`): the first posts fresh
 * and later ones reply under it. In memory and turn-scoped on purpose; task sessions use the persistent
 * `task_thread_anchors` instead, except a `threadAnchor:false` task, whose posts fall back to this anchor.
 */
interface ChatThreadAnchor {
  inReplyTo: string;
  channelType: string;
  platformId: string;
  messageId: string;
}
const chatThreadAnchor = new Map<string, ChatThreadAnchor>();

/** Turns whose anchor failed (sessionId → `in_reply_to`): the rest of that turn posts at root; the next retries. */
const chatThreadAnchorDisabled = new Map<string, string>();

/**
 * `content.threadKey` from send_message/send_file. A malformed key is ignored (the row delivers as unkeyed) rather
 * than refused.
 */
function readThreadKey(content: { threadKey?: unknown }, msgId: string, sessionId: string): string | null {
  const raw = content.threadKey;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && THREAD_KEY_PATTERN.test(raw)) return raw;
  log.warn('Ignoring a malformed threadKey — delivering unkeyed', { id: msgId, sessionId });
  return null;
}

/**
 * Keyed-anchor bookkeeping after the post already landed: a failed write is logged, never thrown, or the row would
 * fail and re-post a message the channel already shows.
 */
async function settleThreadKeyAnchor(
  addr: ThreadKeyAddress,
  outcome: {
    threaded: boolean;
    fellBack: boolean;
    platformMsgId: string | undefined;
    msgId: string;
    adoptedThreadPlatformId?: string;
  },
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    if (outcome.threaded && outcome.adoptedThreadPlatformId)
      await recordThreadKeyAnchor(addr, outcome.adoptedThreadPlatformId, nowIso);
    else if (outcome.threaded) await touchThreadKeyAnchor(addr, nowIso);
    else if (outcome.platformMsgId) await recordThreadKeyAnchor(addr, outcome.platformMsgId, nowIso);
    else if (outcome.fellBack) await deleteThreadKeyAnchor(addr);
  } catch (err) {
    log.warn('Keyed thread anchor bookkeeping failed after delivery — the post stands', {
      id: outcome.msgId,
      threadKey: addr.threadKey,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Serializes lookup → post → record per keyed destination: a thread key is group-scoped, so two sessions posting
 * the same new key would both miss the lookup and both post a root. One process, so an in-memory chain suffices.
 */
const threadKeyLocks = new Map<string, Promise<void>>();
let threadKeyLockWaiters = 0;

/** Test-only: how many deliveries are queued behind another holder of their key's lock. */
export function _threadKeyLockWaitersForTest(): number {
  return threadKeyLockWaiters;
}

async function withThreadKeyLock<T>(
  msg: { id: string; channel_type: string | null; platform_id: string | null; content: string },
  session: Session,
  deliver: () => Promise<T>,
): Promise<T> {
  let threadKey: unknown;
  try {
    threadKey = (JSON.parse(msg.content) as { threadKey?: unknown } | null)?.threadKey;
  } catch {
    // Unparseable content: deliverMessage's own JSON.parse reports it.
    return deliver();
  }
  if (typeof threadKey !== 'string' || !THREAD_KEY_PATTERN.test(threadKey)) return deliver();
  // Coarser than the anchor's identity on purpose (all instances on this address); over-serializing is harmless.
  const lockKey = JSON.stringify([session.agent_group_id, msg.channel_type, msg.platform_id, threadKey]);
  const prior = threadKeyLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = prior.then(() => held);
  threadKeyLocks.set(lockKey, tail);
  threadKeyLockWaiters++;
  try {
    await prior;
  } finally {
    threadKeyLockWaiters--;
  }
  try {
    return await deliver();
  } finally {
    release();
    if (threadKeyLocks.get(lockKey) === tail) threadKeyLocks.delete(lockKey);
  }
}

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 */
const inflightDeliveries = new Set<string>();

/**
 * Run `fn` holding the session's delivery slot, waiting (bounded) for an in-flight drain; for work that must be
 * ORDERED after the drain's sends. Past the wait it returns `undefined` without calling `fn`.
 */
export async function withSessionDeliverySlot<T>(
  sessionId: string,
  fn: () => Promise<T>,
  waitMs = 30_000,
): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  while (inflightDeliveries.has(sessionId)) {
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  inflightDeliveries.add(sessionId);
  try {
    return await fn();
  } finally {
    inflightDeliveries.delete(sessionId);
  }
}

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
  ): Promise<void>;
  deleteMessage?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    instance?: string,
  ): Promise<void>;
  postParent?(channelType: string, platformId: string, text: string): Promise<{ messageId: string }>;
  createThread?(
    channelType: string,
    platformId: string,
    parentMessageId: string,
    title: string,
    firstMessage: string,
  ): Promise<{ threadId: string; messageId: string }>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** channel_type and platform_id must BOTH be null or BOTH set; a mix is corrupted routing state. */
export function assertChannelRoutingConsistency({
  channelType,
  platformId,
}: {
  channelType: string | null;
  platformId: string | null;
}): void {
  const isNull = (v: string | null | undefined): boolean => v === null || v === undefined || v === '';
  if (isNull(channelType) !== isNull(platformId)) {
    throw new Error(
      `inconsistent channel routing: channel_type and platform_id must both be null or both non-null. ` +
        `Got channelType=${JSON.stringify(channelType)}, platformId=${JSON.stringify(platformId)}`,
    );
  }
}

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  // pollActive never rejects (it catches and reschedules itself), so void is safe.
  void pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  // pollSweep never rejects (it catches and reschedules itself), so void is safe.
  void pollSweep();
}

// Stall attribution: both loops do synchronous SQLite per session, so a slow
// cycle is a stall suspect. One line per slow cycle convicts or clears them.
async function pollActive(): Promise<void> {
  if (!activePolling) return;

  const startedAtMs = Date.now();
  let polled = 0;
  try {
    const sessions = await getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
      polled++;
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }
  const cycleMs = Date.now() - startedAtMs;
  if (cycleMs >= 1_000) {
    log.info('Active delivery poll timing', { cycleMs, polled });
  }

  setTimeout(() => {
    void pollActive();
  }, ACTIVE_POLL_MS);
}

// A session idle past this horizon has no deliverable outbound left; iterating every session ever created stalls
// the event loop.
const SWEEP_POLL_ACTIVITY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;
  // A throw must not skip the reschedule below, or the sweep loop dies silently.
  try {
    await runSweepDeliveryCycle();
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }
  setTimeout(() => {
    void pollSweep();
  }, SWEEP_POLL_MS);
}

/** `chat-sdk:<content.type>` for chat-sdk rows so the inbox can tell a question from a status; else the raw kind. */
function outboundKindTag(msg: { kind: string; content: string }): string {
  if (msg.kind !== 'chat-sdk') return msg.kind;
  try {
    const parsed = JSON.parse(msg.content) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return `chat-sdk:${(parsed as { type: string }).type}`;
    }
  } catch {
    /* malformed JSON — fall through */
  }
  // Keep the `chat-sdk:*` namespace so inbox consumers can match by prefix.
  return 'chat-sdk:unknown';
}

export async function deliverSessionMessages(session: Session): Promise<DrainOutcome> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above. `busy`, not a bare return, so the sweep never reads it as "nothing to do".
  if (inflightDeliveries.has(session.id)) return 'busy';
  inflightDeliveries.add(session.id);

  try {
    return await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<DrainOutcome> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return 'pending';

  // The queue snapshot in ONE mailbox session, closed before anything else runs: a delivery action handler may open
  // its own session on this key (nesting guard), and adapter calls must not hold SQLite handles.
  let snapshot: { delivered: ReadonlySet<string>; outstanding: string[]; due: OutboundMessage[] } | undefined;
  try {
    snapshot = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds();
      return {
        delivered,
        // Everything outstanding, not just due: a row scheduled for later must block arming.
        outstanding: mailbox.listOutboundMessageIds().filter((id) => !delivered.has(id)),
        due: mailbox.getDueOutboundMessages(),
      };
    });
  } catch {
    // Present but unopenable: 'pending', so the sweep retries and never arms the quiet gate off a failure.
    return 'pending';
  }
  // Vanished or never provisioned (a read never provisions one): nothing to deliver.
  if (snapshot === undefined) return 'pending';
  const { delivered, outstanding } = snapshot;

  if (outstanding.length === 0) return 'clean';

  const due = snapshot.due.filter((m) => !delivered.has(m.id));
  if (due.length === 0) return 'pending';
  // Superseded task-list edits are never sent: each edit carries the whole list, so only the newest matters.
  const supersededEdits = supersededTaskListEdits(due);
  const undelivered = orderGateRowsBySeq(due.filter((m) => !supersededEdits.has(m.id)));
  if (supersededEdits.size > 0) {
    await ackDelivery(agentGroup.id, session.id, (mailbox) => {
      for (const id of supersededEdits) mailbox.markDelivered(id, null);
    });
    if (undelivered.length === 0) {
      return outstanding.every((id) => delivered.has(id) || supersededEdits.has(id)) ? 'clean' : 'pending';
    }
  }

  // Any outbound row counts as spawn-child progress, or an active child that never calls `spawn_progress` gets
  // reaped by the no-progress watchdog as stuck.
  if (await isSpawnChildSession(session.id)) {
    try {
      await getDb().run(
        `UPDATE tasks SET last_progress_at = ? WHERE child_session_id = ?`,
        new Date().toISOString(),
        session.id,
      );
    } catch (err) {
      log.warn('Failed to bump last_progress_at for spawn child', {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let sawError = false;
  const deliveredNow = new Set<string>(supersededEdits);

  /** `decidedFrom` tells a fresh exhaustion from one inherited from a previous host's stored count. */
  const giveUpOnMessage = async (
    msg: (typeof undelivered)[number],
    attempts: number,
    errMsg: string,
    decidedFrom: 'this attempt' | 'a count stored before this host started',
    err?: unknown,
  ): Promise<void> => {
    const refused = err instanceof DeliveryRefusal;
    (refused ? log.warn : log.error)(
      refused ? 'Message delivery refused by policy, not retried' : 'Message delivery failed permanently, giving up',
      {
        messageId: msg.id,
        sessionId: session.id,
        attempts,
        decidedFrom,
        err: err ?? errMsg,
      },
    );
    await ackDelivery(agentGroup.id, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id, errMsg));
    await clearAttemptRow(msg.id);
    // Giving up is the last moment the host knows a transition has ended: release any repo-ingress fence no live
    // publication owns, or sessions behind a failed publication stay fenced forever. Lazy import: session-manager
    // imports delivery (module-init cycle).
    try {
      const { releaseOrphanedRepoIngressFencesForDroppedMessage } = await import('./repo-fence-recovery.js');
      await releaseOrphanedRepoIngressFencesForDroppedMessage(msg, session);
    } catch (recoveryErr) {
      log.error('Orphaned repository fence recovery after a dropped delivery failed', {
        messageId: msg.id,
        sessionId: session.id,
        err: recoveryErr,
      });
    }
  };

  // Initial task-list posts stepped past for a rate limit; an answer that
  // overtakes them retires them (noteHeldTaskListPost).
  const heldListPosts = new Set<string>();
  for (const msg of undelivered) {
    // A list row waits out its platform's rate-limit cooldown; it stays outstanding.
    if (msg.kind === 'task_list' && taskListCooldownMs(msg.channel_type) > 0) {
      noteHeldTaskListPost(heldListPosts, msg);
      continue;
    }
    // A stored count at the cap is terminal on its own: decide BEFORE the adapter runs, so a successor host never
    // re-sends (see the attempt helpers above).
    const stored = isGateRow(msg) ? undefined : await readAttemptRow(msg.id);
    if (stored !== undefined && stored.attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Terminal: must not arm the quiet cache this tick.
      sawError = true;
      // The persisted adapter error verbatim: the runner surfaces `delivered.error` to synchronous callers.
      await giveUpOnMessage(
        msg,
        stored.attempts,
        stored.last_error && stored.last_error.length > 0
          ? stored.last_error
          : `delivery abandoned: ${stored.attempts} attempts recorded before this host started`,
        'a count stored before this host started',
      );
      // Nothing was sent, so nothing can overtake this row: no need to break the drain.
      continue;
    }
    try {
      const result = await withThreadKeyLock(msg, session, () => deliverMessage(msg, session));
      // Its routing check is still running in the background: nothing was sent, and later rows wait behind it.
      if (result.routePending) break;
      // deferAck: the handler owns the `delivered` row (e.g. request_bash_gate on approval); auto-acking would
      // silently unblock a gated command.
      if (!result.deferAck) {
        await ackDelivery(agentGroup.id, session.id, (mailbox) => {
          mailbox.markDelivered(msg.id, result.platformMsgId ?? null, result.notice, result.taskListRoute);
          if (msg.kind === 'chat' && !result.recordOnly)
            for (const id of heldListPosts) mailbox.markDelivered(id, null);
        });
        if (msg.kind === 'chat' && !result.recordOnly) heldListPosts.clear();
        deliveredNow.add(msg.id);
        // Mirror into the central row for the inbox board; only operator-visible platform sends count, or dormant
        // sessions never reach the stale lane.
        if (!result.recordOnly && msg.kind !== 'system' && msg.channel_type !== 'agent') {
          const tag = outboundKindTag(msg);
          try {
            await bumpLastOutbound(session.id, tag);
          } catch (err) {
            log.warn('bumpLastOutbound failed', {
              sessionId: session.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          emitSessionEvent({
            session_id: session.id,
            agent_group_id: session.agent_group_id,
            kind: 'outbound',
            outbound_kind: tag,
          });
        }
      }
      await clearAttemptRow(msg.id);

      // Pause typing after a user-visible message so the client clears the indicator; not for internal traffic or
      // a task-list post (the agent is still working).
      if (!result.recordOnly && msg.kind !== 'system' && msg.kind !== 'task_list' && msg.channel_type !== 'agent') {
        pauseTypingRefreshAfterDelivery(session.id);
      }
    } catch (err) {
      // A rate-limited list row is not failing, it is early: cool it down
      // uncharged and let the answers behind it through.
      if (msg.kind === 'task_list' && deferTaskListOnRateLimit(msg.channel_type, err)) {
        noteHeldTaskListPost(heldListPosts, msg);
        continue;
      }
      sawError = true;
      // A gate row is a result the ledger must eventually hold: no attempt cap.
      if (isGateRow(msg)) {
        log.warn('Gate result not recorded — retrying next poll', { messageId: msg.id, sessionId: session.id, err });
        break;
      }
      if (err instanceof DeliveryRefusal) {
        await giveUpOnMessage(msg, 1, err.message, 'this attempt', err);
        continue;
      }
      const attempts = await recordAttemptRow(msg.id, session.id, err);
      if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS) {
        await giveUpOnMessage(msg, attempts, err instanceof Error ? err.message : String(err), 'this attempt', err);
      } else {
        log.warn('Message delivery failed, will retry', {
          messageId: msg.id,
          sessionId: session.id,
          // null: the bookkeeping write itself failed; count unknown this tick.
          attempt: attempts,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
          err,
        });
        // Preserve ordering: break so a newer status/chat cannot overtake this row. Except a task-list row:
        // progress must never hold an answer back, and a newer edit supersedes it.
        if (msg.kind === 'task_list') {
          noteHeldTaskListPost(heldListPosts, msg);
          continue;
        }
        break;
      }
    }
  }
  if (sawError) return 'error';
  // A `deferAck` handler owns its row's lifecycle and writes `delivered`
  // later, so those rows are still outstanding and must block arming.
  return outstanding.every((id) => deliveredNow.has(id)) ? 'clean' : 'pending';
}

/**
 * `withExistingMailboxSession`, never the provisioning opener: provisioning here would recreate a reclaimed
 * session and the outbound.db the host must never author. A vanished session loses its ack (the row stays
 * outstanding).
 */
async function ackDelivery(
  agentGroupId: string,
  sessionId: string,
  write: (mailbox: NanoclawMailboxSession) => void,
): Promise<void> {
  const acked = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => {
    write(mailbox);
    return true;
  });
  if (!acked) log.warn('Delivery ack skipped — session mailbox is gone', { sessionId });
}

/** The stat is taken BEFORE the drain and that value is stored, so a commit mid-drain is re-polled next cycle. */
export async function sweepDeliverSession(session: Session, nowMs: number): Promise<DrainOutcome | 'skipped'> {
  // Never gate a live container (pollActive drains it). `isContainerRunning` is authoritative: the sweep's session
  // snapshot can still read 'stopped' for a container already writing. Lazy import keeps container-runner out of
  // every delivery importer's module graph.
  const { isContainerRunning } = await import('./container-runner.js');
  const containerLive =
    isContainerRunning(session.id) || session.container_status === 'running' || session.container_status === 'idle';

  // `null` — no storage yet, unreadable, or a rollback still owed on the file
  // — falls through and lets the drain decide instead of arming.
  const current = containerLive ? null : sessionOutboundStorageStat(session.agent_group_id, session.id);

  if (current && shouldSkipQuietDelivery(quietDeliveryCache.get(session.id), current, nowMs, session.id)) {
    return 'skipped';
  }

  const outcome = await deliverSessionMessages(session);
  if (outcome === 'clean' && current) {
    quietDeliveryCache.set(session.id, { ...current, armedAtMs: nowMs });
  } else {
    quietDeliveryCache.delete(session.id);
  }
  return outcome;
}

/** Exported so the counters are testable without driving the 60s timer chain. */
export async function runSweepDeliveryCycle(nowMs: number = Date.now()): Promise<{ polled: number; skipped: number }> {
  const startedAtMs = Date.now();
  let polled = 0;
  let skipped = 0;
  const seen = new Set<string>();
  try {
    const sessions = await getSessionsActiveSince(new Date(nowMs - SWEEP_POLL_ACTIVITY_HORIZON_MS).toISOString());
    for (const session of sessions) {
      seen.add(session.id);
      // One unreadable session must not abort the cycle.
      try {
        const outcome = await sweepDeliverSession(session, nowMs);
        if (outcome === 'skipped') skipped++;
        else polled++;
      } catch (err) {
        log.warn('Sweep delivery failed for session', { sessionId: session.id, err });
        quietDeliveryCache.delete(session.id); // never arm off a failure
        polled++;
      }
      // Yield after EVERY session: each drain opens two SQLite files synchronously.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Bounded to sessions still in the horizon, or the map grows forever.
    for (const id of quietDeliveryCache.keys()) if (!seen.has(id)) quietDeliveryCache.delete(id);
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }
  // Emitted every cycle, not only slow ones: a fast skip-heavy cycle is the
  // healthy state, and it must not look identical to a sweep that stopped.
  log.info('Sweep delivery poll timing', { cycleMs: Date.now() - startedAtMs, polled, skipped });
  return { polled, skipped };
}

/**
 * Per-series opt-out (`--thread-anchor false`), cached per TTL to avoid a DB open per message. Any failure means
 * NOT exempt (the anchored default is the safe one).
 */
const threadAnchorExemptCache = new Map<string, { exempt: boolean; at: number }>();
const THREAD_ANCHOR_CACHE_TTL_MS = 5 * 60 * 1000;

async function isThreadAnchorExempt(session: Session): Promise<boolean> {
  const prefix = `${TASKS_SYSTEM_THREAD_ID}:`;
  if (!session.thread_id?.startsWith(prefix)) return false;
  const cached = threadAnchorExemptCache.get(session.id);
  if (cached && Date.now() - cached.at < THREAD_ANCHOR_CACHE_TTL_MS) return cached.exempt;

  let exempt = false;
  try {
    const seriesId = session.thread_id.slice(prefix.length);
    const content = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getLatestTaskContent(seriesId),
    );
    if (content) exempt = (JSON.parse(content) as { threadAnchor?: unknown }).threadAnchor === false;
  } catch {
    exempt = false;
  }
  threadAnchorExemptCache.set(session.id, { exempt, at: Date.now() });
  return exempt;
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
    timestamp?: string;
  },
  session: Session,
): Promise<{
  platformMsgId?: string;
  deferAck?: true;
  recordOnly?: true;
  notice?: string;
  routePending?: true;
  taskListRoute?: string;
}> {
  if (msg.kind === 'work_log') return { recordOnly: true };
  if (await recordGateRow(msg, session)) return { recordOnly: true };
  assertChannelRoutingConsistency({ channelType: msg.channel_type, platformId: msg.platform_id });

  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return {};
  }

  const content = JSON.parse(msg.content);

  // The host switch also reaches adopted containers (off: list rows go nowhere); a row from an interrupted
  // container must not revive the list. A spawn child's list stays internal.
  if (msg.kind === 'task_list' && (!TASK_LIST_ENABLED || (await isSpawnChildSession(session.id)))) {
    return { recordOnly: true };
  }

  let externalOutcomeChannels: string[] = [];
  const wikiGroup = await getAgentGroup(session.agent_group_id);
  if (wikiGroup) {
    const { readContainerConfig } = await import('./container-config.js');
    // Enrollment, not the model's tool list, constrains raw outbound rows too.
    const cfg = readContainerConfig(wikiGroup.folder);
    externalOutcomeChannels = cfg.outcomeReportingExternalChannels ?? [];
    if (wikiEnrollment(wikiGroup.id, cfg.wikiMaintenance === true)) {
      if (!allowedWikiOutbound(msg.kind, content.action))
        throw new DeliveryRefusal('Wiki maintenance outbound capability denied');
    }
  }

  // An ask_question id must never be decodable as a pending approval's id (a click would decode through the
  // approval's options). Click parsers cut at the first ':' after `ncq:`, so compare the id a CLICK decodes, and
  // refuse an ambiguous (suffixed) id outright.
  if (
    content &&
    typeof content === 'object' &&
    content.type === 'ask_question' &&
    typeof content.questionId === 'string'
  ) {
    const decodedQuestionId = content.questionId.split(':')[0];
    const ambiguous = decodedQuestionId !== content.questionId;
    if (ambiguous || (await getPendingApproval(decodedQuestionId))) {
      log.warn(
        ambiguous
          ? 'Refusing an ask_question whose id a click would decode to a different id'
          : 'Refusing an ask_question that reuses a pending approval id',
        {
          id: msg.id,
          sessionId: session.id,
          questionId: content.questionId,
          decodedQuestionId,
        },
      );
      return {};
    }
  }

  // An `ask_question` from a spawn child lights the dashboard's Needs You lane like `spawn_request_steer`.
  if (msg.kind === 'chat-sdk' && content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (c.type === 'ask_question') {
      const task = await getTaskByChildSession(session.id);
      if (task && task.status === 'running') {
        const title = typeof c.title === 'string' ? c.title : null;
        const questionText = typeof c.question === 'string' ? c.question : null;
        const summary = title ?? questionText ?? null;
        try {
          if (await flagNeedsInput(task.task_id, summary ? summary.slice(0, 500) : null)) {
            emitDashboardEvent('task_event', {
              task_id: task.task_id,
              kind: 'needs_input',
              agent_group_id: task.parent_agent_group_id,
            });
          }
        } catch (err) {
          log.warn('delivery: ask_question → flagNeedsInput failed', {
            taskId: task.task_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (msg.kind === 'system') {
    const result = await handleSystemAction(content, session);
    if (result && result.deferAck) return { deferAck: true };
    return {};
  }

  // Task-run log: the runner mirrors a run's final text here (one-door
  // delivery — final text never reaches a channel; the send_message tool is
  // the only delivery path from a task session). Append to the series log,
  // never deliver. The caller marks it delivered so it isn't retried.
  if (msg.kind === 'task_log') {
    // `taskSeriesId`, not a raw slice (a legacy `system:tasks` yields an EMPTY id that would reach the run-outcome
    // ledger). A session naming no series has nothing to append or record: drop the row.
    const series = taskSeriesId(session.thread_id);
    if (session.messaging_group_id === null && series !== null) {
      const text = typeof content.text === 'string' ? content.text : '';
      try {
        await appendRunLog(session.agent_group_id, series, text);
      } catch (err) {
        log.warn('Failed to append task run log', { id: msg.id, sessionId: session.id, err });
      }
      // Mirror END-OF-RUN summaries (`auto: true`) into the run-outcome ledger the escalation sweep reads; a mid-run
      // `append-log` note must never move a streak. Caught separately from the log append.
      if (content.auto === true) {
        try {
          await recordTaskRunOutcome({
            agentGroupId: session.agent_group_id,
            sessionId: session.id,
            seriesId: series,
            outboundId: msg.id,
            outcome: content.isError === true ? 'failed' : 'ok',
            model: typeof content.model === 'string' ? content.model : null,
            // Scrubbed HERE: this durable row can later reach an operator DM without passing any other scrubber.
            detail: scrubSecrets(text).slice(0, 500) || null,
          });
        } catch (err) {
          log.warn('Failed to record task run outcome', { id: msg.id, sessionId: session.id, err });
        }
      }
    } else if (session.messaging_group_id === null && isTaskThread(session.thread_id)) {
      log.warn('task_log row from a task session that names no series — ignoring', {
        id: msg.id,
        sessionId: session.id,
        threadId: session.thread_id,
      });
    } else {
      log.warn('task_log row outside a task session — ignoring', { id: msg.id, sessionId: session.id });
    }
    return {};
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!(await hasTable(getDb(), 'agent_destinations'))) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return {};
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  let deliverMessagingGroupId: string | undefined;
  if (msg.channel_type && msg.platform_id) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // fall back to the by-platform lookup (default-instance-first).
    const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : await getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && (await hasTable(getDb(), 'agent_destinations'))) {
      const row = await getDb().get(
        'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        session.agent_group_id,
        'channel',
        mg.id,
      );
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
    deliverMessagingGroupId = mg.id;
  }
  if (msg.kind === 'task_list' && content.operation === 'delete')
    return retireSupersededTaskList(deliveryAdapter, session, msg);

  // Status: the first in a turn posts, later ones edit in place; a real chat message clears the tracking.
  if (msg.kind === 'status') {
    // The task list and platform status line replace the 💭 stream (row kept for the dashboard, never posted). An
    // agent-shared session has no conversation for a list, so it keeps its 💭 progress.
    const agentShared = session.messaging_group_id === null && !isTaskThread(session.thread_id);
    if (TASK_LIST_ENABLED && !agentShared) return { recordOnly: true };
    const typedProgress = content.reporting?.version === 1 && content.reporting?.purpose === 'progress';
    if (!msg.channel_type || !msg.platform_id) {
      log.warn('Status message missing routing fields, dropping', { id: msg.id });
      return {};
    }
    const appendMode = await isSpawnChildSession(session.id);
    if (appendMode) {
      // Spawn-child status is suppressed in chat (the dashboard shows thinking); the row is still marked delivered.
      log.info('Status suppressed in chat for spawn-child session', {
        id: msg.id,
        sessionId: session.id,
      });
      return {};
    }
    // Typed progress may update this turn's activity line but never start a public narration stream of its own;
    // exact conversation + turn matching keeps task, sibling and redirected traffic record-only. A host-memory reset
    // before the turn's first progress post leaves nothing to recover, so that turn's progress stays internal.
    if (typedProgress) {
      let lifecycle = statusTracking.get(session.id);
      if (!lifecycle) {
        lifecycle = await recoverLifecycleStatus(session.id);
        if (lifecycle) statusTracking.set(session.id, lifecycle);
      }
      if (
        !lifecycle?.lifecycle ||
        lifecycle.inReplyTo !== msg.in_reply_to ||
        !sameConversation(lifecycle, {
          channelType: msg.channel_type,
          platformId: msg.platform_id,
          threadId: msg.thread_id,
        })
      ) {
        return { recordOnly: true };
      }
    }
    // Turn-boundary reset: a tracked status from a DIFFERENT turn is an orphan above the user's newer message.
    // Delete it via the stored route so this turn posts a fresh line below instead of editing the stale one.
    const stale = statusTracking.get(session.id);
    if (stale && stale.inReplyTo !== msg.in_reply_to) {
      if (!stale.unposted && deliveryAdapter.deleteMessage) {
        try {
          await deliveryAdapter.deleteMessage(
            stale.channelType,
            stale.platformId,
            stale.threadId,
            stale.messageId,
            stale.instance,
          );
        } catch (err) {
          log.warn('Failed to delete stale prior-turn status — leaving as-is', {
            sessionId: session.id,
            messageId: stale.messageId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      statusTracking.delete(session.id);
    }

    // The liveness row stays unposted (the typing indicator already shows work); tracked so the first typed
    // progress can post the activity line.
    if (content.reporting?.version === 1 && content.reporting?.purpose === 'liveness') {
      statusTracking.set(session.id, {
        outboundId: msg.id,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        threadId: msg.thread_id,
        messageId: '',
        instance: deliverInstance,
        inReplyTo: msg.in_reply_to,
        lifecycle: true,
        unposted: true,
      });
      return { recordOnly: true };
    }

    const tracked = statusTracking.get(session.id);
    const lifecycleOwner = tracked?.lifecycle && (typedProgress || tracked.unposted) ? tracked : undefined;
    const existing = tracked?.unposted ? undefined : tracked;
    const freshOutbound = humanizeOutboundContent(scrubSecrets(msg.content));
    const replacingExhaustedStatus = existing?.editExhausted === true;
    let outbound = freshOutbound;
    if (existing && !replacingExhaustedStatus) {
      const parsed = JSON.parse(outbound);
      outbound = JSON.stringify({
        operation: 'edit',
        messageId: existing.messageId,
        text: parsed.text,
      });
    }
    let mode: 'edit' | 'post' | 'repost' = existing ? (replacingExhaustedStatus ? 'repost' : 'edit') : 'post';
    let replacedStatus: StatusTrack | undefined = replacingExhaustedStatus ? existing : undefined;
    let platformMsgId: string | undefined;
    try {
      platformMsgId = await deliveryAdapter.deliver(
        msg.channel_type,
        msg.platform_id,
        msg.thread_id,
        msg.kind,
        outbound,
        undefined,
        deliverInstance,
      );
    } catch (err) {
      if (!existing || !isDiscordChannelType(msg.channel_type) || !isDiscordStatusEditLimitError(err)) throw err;

      // Discord 30046: further edits are useless. Keep the old line tracked until the replacement posts.
      existing.editExhausted = true;
      platformMsgId = await deliveryAdapter.deliver(
        msg.channel_type,
        msg.platform_id,
        msg.thread_id,
        msg.kind,
        freshOutbound,
        undefined,
        deliverInstance,
      );
      if (!platformMsgId) {
        throw new Error('Discord replacement status post returned no message id', { cause: err });
      }
      mode = 'repost';
      replacedStatus = existing;
    }
    if (mode === 'repost' && !platformMsgId) {
      throw new Error('Discord replacement status post returned no message id');
    }
    if (platformMsgId && mode !== 'edit') {
      // Pin the route at post time: cleanup must use it, not the chat-final's route (a wrong (channel, ts) pair on
      // Slack's chat.delete could delete an unrelated message).
      statusTracking.set(session.id, {
        outboundId: lifecycleOwner?.outboundId ?? msg.id,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        threadId: msg.thread_id,
        messageId: platformMsgId,
        instance: deliverInstance,
        inReplyTo: msg.in_reply_to,
        lifecycle: lifecycleOwner !== undefined,
      });
      // Keep the lifecycle receipt pointed at the visible line. Best-effort after platform success: a DB fault
      // must not retry and duplicate the public post.
      if (lifecycleOwner) {
        try {
          await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
            mailbox.markDelivered(lifecycleOwner.outboundId, platformMsgId),
          );
        } catch (err) {
          log.warn('Activity repost succeeded but lifecycle receipt refresh failed', {
            sessionId: session.id,
            outboundId: lifecycleOwner.outboundId,
            platformMsgId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (lifecycleOwner) lifecycleRecoveryMisses.delete(session.id);
    }
    if (replacedStatus && platformMsgId) {
      if (deliveryAdapter.deleteMessage) {
        try {
          await deliveryAdapter.deleteMessage(
            replacedStatus.channelType,
            replacedStatus.platformId,
            replacedStatus.threadId,
            replacedStatus.messageId,
            replacedStatus.instance,
          );
        } catch (deleteErr) {
          log.warn('Failed to delete Discord status after edit cap — replacement remains visible', {
            sessionId: session.id,
            messageId: replacedStatus.messageId,
            err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
          });
        }
      }
      log.warn('Discord status edit cap reached — posted fresh status', {
        sessionId: session.id,
        replacedMessageId: replacedStatus.messageId,
        platformMsgId,
      });
    }
    log.info('Status delivered', {
      id: msg.id,
      sessionId: session.id,
      mode,
      platformMsgId: platformMsgId ?? (mode === 'edit' ? existing?.messageId : undefined),
    });
    return { platformMsgId: platformMsgId ?? undefined };
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && (await hasTable(getDb(), 'pending_questions'))) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = await createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        question: typeof content.question === 'string' ? content.question : '',
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return {};
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  // Defense in depth: scrub registered secret values from every agent-authored post; verdict tokens are humanized
  // here too (the one door all chat posts pass through).
  const scrubbedContent = humanizeOutboundContent(scrubSecrets(msg.content));

  // Final replies always post fresh, never as an edit of the status bubble, so the answer lands below any
  // follow-up that arrived mid-turn.

  const isRoutineOutcome = content.reporting?.version === 1 && content.reporting.purpose === 'outcome';
  let baseThreadId = msg.thread_id && msg.thread_id.length > 0 ? msg.thread_id : null;
  if (isRoutineOutcome && session.messaging_group_id === null && isTaskThread(session.thread_id)) {
    // A recurring task's old conversation is not the new human work item's thread.
    baseThreadId = null;
    const legacyWorkItem = (content.reporting.outcome as Record<string, unknown> | undefined)?.workItem;
    if (legacyWorkItem !== undefined) {
      const item = canonicalWorkItem(legacyWorkItem);
      const slackRequest = /^slack:[^:]+:([^:]+):(\d{10})(\d{6})$/.exec(item);
      if (slackRequest && msg.platform_id === `slack:${slackRequest[1]}`)
        baseThreadId = `${msg.platform_id}:${slackRequest[2]}.${slackRequest[3]}`;
    }
  }

  // Rolling task-session anchor: each fire is a fresh turn, so `task_thread_anchors` persists the anchor ACROSS
  // fires per (session, destination), rotating on `anchorRotationKey` (default: UTC day). Never overrides an
  // explicit thread_id. A series with `threadAnchor === false` (one NEW thread per item) is exempt. Edits and
  // reactions follow the anchor to reach in-thread messages but never drop or record one.
  const isInPlaceOp = content.operation === 'edit' || content.operation === 'reaction';
  const isTaskSessionPost = session.messaging_group_id === null && isTaskThread(session.thread_id);

  // Keyed anchor (`content.threadKey`): the first post under a key lands at root and is recorded; later posts
  // thread beneath it with no rotation. Beats both other anchors, never an explicit thread_id. Keyed per agent
  // group and per messaging group, so two adapter instances never share a parent.
  const threadKey = isRoutineOutcome ? null : readThreadKey(content, msg.id, session.id);
  const keyAddr: ThreadKeyAddress | null =
    threadKey !== null && baseThreadId === null && deliverMessagingGroupId !== undefined
      ? { agentGroupId: session.agent_group_id, messagingGroupId: deliverMessagingGroupId, threadKey }
      : null;
  const keyedEligible = keyAddr !== null;

  const taskAnchorEligible =
    !isRoutineOutcome &&
    !keyedEligible &&
    isTaskSessionPost &&
    baseThreadId === null &&
    !(await isThreadAnchorExempt(session));

  // Per-turn channel-root threading (see ChatThreadAnchor) for every post the task anchor does not take. A task list is
  // progress: it never becomes the root the answer threads under, nor threads under an earlier message.
  const turnAnchorEligible =
    !isRoutineOutcome &&
    !taskAnchorEligible &&
    baseThreadId === null &&
    msg.in_reply_to != null &&
    msg.kind !== 'task_list';

  let effectiveThreadId = baseThreadId;
  let usedAnchor = false;
  let adoptedThreadPlatformId: string | undefined;
  // A vetoed post lands at root; a veto of the key's own thread also moves the post to a split key, so the earlier
  // request keeps its anchor and this one gets its own.
  let routeVeto: { verdict: RouteCheckVerdict; candidateThreadId: string; splitAddr?: ThreadKeyAddress } | undefined;
  if (keyAddr) {
    const checked = !isInPlaceOp && isRouteCheckedKey(keyAddr.threadKey);
    const { channel_type: channelType, platform_id: platformId } = msg;
    const routeCheck = (via: RouteCheckRequest['via'], threadPlatformId: string, split?: string) =>
      routeVerdict({
        via,
        threadKey: keyAddr.threadKey,
        postText: typeof content.text === 'string' ? content.text : '',
        channelType,
        platformId,
        threadPlatformId,
        agentGroupId: session.agent_group_id,
        messagingGroupId: keyAddr.messagingGroupId,
        sessionId: session.id,
        messageOutId: msg.id,
        queuedAt: msg.timestamp,
        splitThreadKey: split,
      });
    const anchor = await getThreadKeyAnchor(keyAddr, new Date().toISOString());
    if (anchor && !(isInPlaceOp && content.messageId === anchor.threadPlatformId)) {
      // Only a `handoff` post is judged: work sessions post their results as `decision` into their own thread, and
      // judging those would veto legitimate results. A routing post sent as `decision` therefore goes unchecked; the
      // current watcher routes only by handoff, but did post `decision` before it split dispatch from triage.
      const split =
        checked && content.reporting?.purpose === 'handoff' ? splitThreadKey(keyAddr.threadKey, msg.id) : null;
      const verdict = split !== null ? routeCheck('anchor', anchor.threadPlatformId, split) : undefined;
      if (verdict === 'pending') return { routePending: true };
      if (split !== null && verdict && !verdict.keep) {
        routeVeto = {
          verdict,
          candidateThreadId: anchor.threadPlatformId,
          splitAddr: { ...keyAddr, threadKey: split },
        };
      } else {
        effectiveThreadId = `${msg.platform_id}:${anchor.threadPlatformId}`;
        usedAnchor = true;
      }
    } else if (!anchor && !isInPlaceOp && content.continueThread !== undefined) {
      // No live anchor: the key may adopt an existing thread the host confirms is on
      // this messaging group (src/continue-thread.ts); unconfirmed posts at root as before.
      const adopted = await resolveContinueThread(
        content.continueThread,
        { messagingGroupId: keyAddr.messagingGroupId, channelType: msg.channel_type, platformId: msg.platform_id },
        { id: msg.id, sessionId: session.id, threadKey },
      );
      const verdict = adopted && checked ? routeCheck('adopt', adopted.threadPlatformId) : undefined;
      if (verdict === 'pending') return { routePending: true };
      if (adopted && verdict && !verdict.keep) {
        routeVeto = { verdict, candidateThreadId: adopted.threadPlatformId };
      } else if (adopted) {
        effectiveThreadId = adopted.threadId;
        adoptedThreadPlatformId = adopted.threadPlatformId;
        usedAnchor = true;
      }
    }
  } else if (taskAnchorEligible) {
    const anchor = await getTaskThreadAnchor(session.id, msg.channel_type, msg.platform_id);
    if (
      anchor &&
      anchorRotationKey(anchor.createdAt) === anchorRotationKey(new Date().toISOString()) &&
      !(isInPlaceOp && content.messageId === anchor.threadPlatformId)
    ) {
      // Same encoding as the turn anchor below: `<platform-address>:<thread>`.
      effectiveThreadId = `${msg.platform_id}:${anchor.threadPlatformId}`;
      usedAnchor = true;
    }
  } else if (turnAnchorEligible && chatThreadAnchorDisabled.get(session.id) !== msg.in_reply_to) {
    const anchor = chatThreadAnchor.get(session.id);
    if (
      anchor &&
      anchor.inReplyTo === msg.in_reply_to &&
      anchor.channelType === msg.channel_type &&
      anchor.platformId === msg.platform_id &&
      !(isInPlaceOp && content.messageId === anchor.messageId)
    ) {
      // Adapters decode `<platform-address>:<thread>` (e.g. `slack:<channel>:<ts>`); a BARE message id throws
      // ValidationError and the message is dropped after its retries.
      effectiveThreadId = `${anchor.platformId}:${anchor.messageId}`;
      usedAnchor = true;
    }
  }

  let outcomeClaim: { workgroup: string; key: string } | undefined;
  if (content.reporting?.version === 1 && content.reporting.purpose === 'outcome') {
    if (externalOutcomeChannels.includes(msg.platform_id))
      throw new DeliveryRefusal(
        'This channel has an existing terminal reporter. Hand off the outcome through that route; do not post a competing report.',
      );
    const rawOutcome = content.reporting.outcome as Record<string, unknown> | undefined;
    let trustedRequest: Parameters<typeof renderWorkOutcome>[2];
    if (rawOutcome?.workItem === undefined) {
      const sequence = rawOutcome?.requestId;
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
        throw new Error('Malformed harness request identity');
      const source = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.getInboundRequestIdentity(sequence as number),
      );
      if (!source) throw new DeliveryRefusal('Harness request identity does not belong to this source session');
      let sourceContent: {
        platformMsgId?: unknown;
        sender?: unknown;
        senderId?: unknown;
        origin?: unknown;
        author?: { isBot?: unknown };
      };
      try {
        sourceContent = JSON.parse(source.content) as typeof sourceContent;
      } catch (error) {
        throw new Error('Malformed harness request source', { cause: error });
      }
      if (!isAdmissibleOutcomeRequestSource(source.kind, sourceContent))
        throw new Error('Harness request identity is not an original human request');
      const platformMessageId =
        typeof sourceContent.platformMsgId === 'string' && sourceContent.platformMsgId
          ? sourceContent.platformMsgId
          : undefined;
      trustedRequest = {
        sessionId: session.id,
        messageId: source.id,
        sequence: source.seq,
        ...(platformMessageId && source.channel_type && source.platform_id
          ? {
              origin: {
                channelType: source.channel_type,
                platformId: source.platform_id,
                platformMessageId,
              },
            }
          : {}),
      };
    }
    const rendered = renderWorkOutcome(content.reporting.summary, rawOutcome, trustedRequest);
    if (content.text !== rendered.text || content.operation || content.files)
      throw new Error('Malformed outcome envelope');
    if (!wikiGroup) throw new Error('Outcome reporting requires a source agent group');
    const receiptScope = wikiGroup.workgroup_id ?? `agent-group:${wikiGroup.id}`;
    const claim = await claimWorkOutcome({
      workgroup_id: receiptScope,
      work_item: rendered.key,
      message_id: msg.id,
      session_id: session.id,
      channel_type: msg.channel_type,
      platform_id: msg.platform_id,
      thread_id: effectiveThreadId,
      content: scrubbedContent,
    });
    if (!claim.claimed) {
      if (claim.receipt.session_id !== session.id) {
        const receiptSession = await getSession(claim.receipt.session_id);
        if (!receiptSession || receiptSession.agent_group_id !== session.agent_group_id)
          throw new DeliveryRefusal(
            `Outcome not published: another agent owns the existing receipt` +
              `${claim.receipt.platform_message_id ? ` (${claim.receipt.platform_message_id})` : ''}. ` +
              'Merge this result through that owner report or use an explicitly requested separate reply.',
          );
      }
      if (claim.receipt.platform_id !== msg.platform_id)
        throw new Error(
          'This work item already belongs to another reporting destination; inspect its receipt rather than reposting.',
        );
      if (claim.receipt.state === 'delivered')
        return { platformMsgId: claim.receipt.platform_message_id ?? undefined, recordOnly: true };
      // Never re-send a claim whose platform acceptance is unknown, including after restart.
      return { deferAck: true };
    }
    outcomeClaim = { workgroup: receiptScope, key: rendered.key };
  }
  let platformMsgId: string | undefined;
  try {
    platformMsgId = await deliveryAdapter.deliver(
      msg.channel_type,
      msg.platform_id,
      effectiveThreadId,
      msg.kind,
      scrubbedContent,
      files,
      deliverInstance,
    );
  } catch (err) {
    if (outcomeClaim) {
      await settleWorkOutcome(
        outcomeClaim.workgroup,
        outcomeClaim.key,
        undefined,
        scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 1000),
      );
      log.error('Outcome delivery uncertain; reconcile receipt before retrying', { id: msg.id, sessionId: session.id });
      return { deferAck: true };
    }
    if (!usedAnchor) throw err;
    // Not every platform can thread on a parent (Discord's auto-thread can fail). Post at root, and turn anchoring
    // off for the rest of this turn (or drop a task anchor) so later messages skip the failing call.
    log.warn('Threaded delivery under anchor failed — posting at root', {
      id: msg.id,
      sessionId: session.id,
      taskAnchor: taskAnchorEligible,
      ...(keyedEligible ? { threadKey } : {}),
      attemptedThreadId: effectiveThreadId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (isInPlaceOp) {
      // The target just wasn't in the thread; the anchor itself is still good.
    } else if (keyAddr) {
      // Settled after the root post (`settleThreadKeyAnchor`), never before: if
      // that post throws too, the failure may be transient and the record stays.
    } else if (taskAnchorEligible) {
      await deleteTaskThreadAnchor(session.id, msg.channel_type, msg.platform_id);
    } else {
      chatThreadAnchor.delete(session.id);
      chatThreadAnchorDisabled.set(session.id, msg.in_reply_to as string);
    }
    effectiveThreadId = null;
    platformMsgId = await deliveryAdapter.deliver(
      msg.channel_type,
      msg.platform_id,
      null,
      msg.kind,
      scrubbedContent,
      files,
      deliverInstance,
    );
  }

  if (outcomeClaim) {
    // Persist BEFORE anchor/archive bookkeeping, so their failure cannot re-send the outcome.
    await settleWorkOutcome(outcomeClaim.workgroup, outcomeClaim.key, platformMsgId);
  }

  // Record only a fresh ROOT post as the anchor; overwriting it with a threaded reply would chain later posts off
  // the wrong message.
  if (keyAddr && !isInPlaceOp) {
    await settleThreadKeyAnchor(routeVeto?.splitAddr ?? keyAddr, {
      threaded: effectiveThreadId !== null,
      fellBack: usedAnchor && effectiveThreadId === null,
      platformMsgId,
      msgId: msg.id,
      adoptedThreadPlatformId,
    });
  } else if (effectiveThreadId === null && platformMsgId && !isInPlaceOp) {
    if (taskAnchorEligible) {
      await setTaskThreadAnchor(session.id, msg.channel_type, msg.platform_id, platformMsgId, new Date().toISOString());
    } else if (turnAnchorEligible) {
      chatThreadAnchor.set(session.id, {
        inReplyTo: msg.in_reply_to as string,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        messageId: platformMsgId,
      });
    }
  }
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // The list's current item becomes the platform's "is working…" status text.
  if (msg.kind === 'task_list')
    noteTaskListDelivered(session.id, JSON.parse(scrubbedContent) as Record<string, unknown>);

  // A real chat message supersedes in-flight status: delete the orphan via its stored route. Failures are
  // swallowed so they never block markDelivered (which would duplicate the answer).
  if (msg.kind === 'chat' || msg.kind === 'chat-sdk') {
    await settleSessionStatusAfterPublicDelivery(session.id);
  }

  if (msg.kind === 'chat') {
    // Scrubbed text, so a leaked secret stays out of searchable history.
    try {
      const parsed = JSON.parse(scrubbedContent) as Record<string, unknown>;
      const text =
        typeof parsed.text === 'string' ? parsed.text : typeof parsed.content === 'string' ? parsed.content : '';
      if (text && msg.channel_type && msg.platform_id) {
        const mg = await getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
        archiveMessage({
          id: msg.id,
          agentGroupId: session.agent_group_id,
          messagingGroupId: session.messaging_group_id,
          channelType: msg.channel_type,
          channelName: mg?.name ?? null,
          platformId: msg.platform_id,
          // Where the post actually landed (an anchored post has a null row thread_id).
          threadId: effectiveThreadId,
          role: 'assistant',
          senderId: session.agent_group_id,
          senderName: 'assistant',
          text,
          sentAt: new Date().toISOString(),
        });
      }
    } catch {
      // best-effort
    }
  }

  clearOutbox(session.agent_group_id, session.id, msg.id);
  if (keyAddr && isRouteCheckedKey(keyAddr.threadKey)) forgetRouteVerdict(msg.id);

  const notice =
    routeVeto && keyAddr
      ? routeVetoNotice({
          verdict: routeVeto.verdict,
          threadKey: keyAddr.threadKey,
          candidateThreadId: routeVeto.candidateThreadId,
          platformId: msg.platform_id,
          rootMessageId: platformMsgId,
          splitThreadKey: routeVeto.splitAddr?.threadKey,
        })
      : undefined;
  return {
    platformMsgId: platformMsgId ?? undefined,
    ...(notice ? { notice } : {}),
    ...taskListPostReceipt(msg.kind, content, msg.channel_type, msg.platform_id, effectiveThreadId, deliverInstance),
  };
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Unknown actions log "Unknown system action".
 *
 * Privileged delivery actions (create_agent, install_packages,
 * add_mcp_server) register with a guard spec: every path to the handler body
 * — dispatch, approved replay, test lookup — goes through the guard consult
 * (allow / hold / deny), so there is no unguarded route to it. On approve,
 * the continuation re-enters the same entry carrying the approval row as its
 * grant (`reenterGuardedDeliveryAction`), so the structural checks are
 * re-run live. Plain actions (the cli_request bridge — its inner
 * commands are guarded at dispatch) register with an
 * explicit `unguarded(<reason>)` declaration instead of a spec — omission is
 * not representable, so the decision to run unguarded is visible, and
 * justified, at the registration site.
 */
/**
 * `{ deferAck: true }`: the handler owns the `delivered` row and the outer loop must NOT mark it (bash-gate: the
 * container polls `delivered` for its requestId as the ack, so an auto-ack would short-circuit the gate).
 */
export type DeliveryActionResult = void | { deferAck: true };
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
) => Promise<DeliveryActionResult>;

type DeliveryEntry =
  | { guard: Unguarded; handler: DeliveryActionHandler }
  | { guard: DeliveryGuardSpec; handler: GuardedDeliveryHandler };

const deliveryActions = new Map<string, DeliveryEntry>();

function isUnguardedEntry(entry: DeliveryEntry): entry is Extract<DeliveryEntry, { guard: Unguarded }> {
  return isUnguarded(entry.guard);
}

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler, unguardedDecl: Unguarded): void;
export function registerDeliveryAction(action: string, handler: GuardedDeliveryHandler, spec: DeliveryGuardSpec): void;
export function registerDeliveryAction(
  action: string,
  handler: DeliveryActionHandler | GuardedDeliveryHandler,
  guardDecl: DeliveryGuardSpec | Unguarded,
): void {
  const existing = deliveryActions.get(action);
  if (existing) {
    // Replacing a guard-wrapped action with an unguarded handler would
    // disarm the guard while its catalog entry still exists — refuse. A
    // skill that wants to extend a guarded action must compose at the
    // module's exported functions instead, or re-register with a guard spec
    // of its own.
    if (isUnguarded(guardDecl) && !isUnguardedEntry(existing)) {
      throw new Error(
        `delivery action "${action}" is guard-wrapped; re-registering it without a guard spec would disarm the guard`,
      );
    }
    log.warn('Delivery action handler overwritten', { action });
  }
  // The overloads pair each handler shape with its declaration; the merged
  // implementation signature erases that pairing, hence the one cast.
  deliveryActions.set(action, { guard: guardDecl, handler } as DeliveryEntry);
}

/**
 * Approve continuation for a guard-wrapped delivery action: re-enter the
 * entry with the approval row as the grant. The guard treats the grant as
 * hold-satisfied but re-runs the structural checks, so approve-then-revoke
 * does not execute. Domains register this as their approval handler in the
 * same line that registers the action.
 */
export function reenterGuardedDeliveryAction(action: string) {
  return async (ctx: { session: Session; payload: Record<string, unknown>; approval: PendingApproval }) => {
    const entry = deliveryActions.get(action);
    if (!entry || isUnguardedEntry(entry)) {
      log.warn('Approved replay for an action that is not guard-wrapped — dropping', { action });
      return;
    }
    await runGuarded(action, entry.guard, entry.handler, ctx.payload, ctx.session, ctx.approval);
  };
}

/**
 * The invocable for a registered action — the raw handler for unguarded
 * entries, the guard-consulting path for guarded ones. Dispatch and tests
 * both come through here; there is no route around the guard.
 */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  const entry = deliveryActions.get(action);
  if (!entry) return undefined;
  if (isUnguardedEntry(entry)) return entry.handler;
  return (content, session) => runGuarded(action, entry.guard, entry.handler, content, session, null);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(content: Record<string, unknown>, session: Session): Promise<DeliveryActionResult> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = getDeliveryAction(action);
  if (registered) {
    return registered(content, session);
  }

  log.warn('Unknown system action', { action });
  return undefined;
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}

/**
 * Turn boundary from the container: sweeps up a 💭 status no chat-final superseded (a task session has no next
 * turn to reset it). Written BEFORE `checkpointTurnEnd`/`markCompleted`, so the turn's inbound rows may still be
 * `processing`. Usually a no-op; emitted unconditionally because only the host knows whether a status is tracked.
 */
registerDeliveryAction(
  'turn_end',
  async (content, session) => {
    const lifecycleStatusId = typeof content.lifecycleStatusId === 'string' ? content.lifecycleStatusId : undefined;
    if (!lifecycleStatusId) {
      await dropOrphanStatus(session.id);
      return undefined;
    }

    const pendingApprovals = await getPendingApprovalsBySession(session.id);
    if (pendingApprovals.length > 0) {
      const status = statusTracking.get(session.id) ?? (await recoverLifecycleStatus(session.id, lifecycleStatusId));
      if (!status) return undefined;
      await markSessionLifecycleWaiting(session.id, status);
      return undefined;
    }

    await stopSessionLifecycleStatus(session.id, 'Stopped before sending a reply.', lifecycleStatusId);
    return undefined;
  },
  unguarded('turn boundary — updates or deletes only this session’s own status line, no privileged effect'),
);
