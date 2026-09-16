/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import {
  bumpLastOutbound,
  getRunningSessions,
  getSessionsActiveSince,
  createPendingQuestion,
  getPendingApproval,
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
import { recordTaskRunOutcome } from './db/task-run-outcomes.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { runGuarded, type DeliveryGuardSpec, type GuardedDeliveryHandler } from './delivery-guard.js';
import { allowedWikiOutbound, wikiEnrollment } from './wiki-admission/policy.js';
import { isUnguarded, unguarded, type Unguarded } from './guard/index.js';
import { log } from './log.js';
import { scrubSecrets } from './secret-scrubber.js';
import { archiveMessage } from './message-archive.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, readOutboxFiles, withExistingMailboxSession } from './session-manager.js';
import { sessionOutboundStorageStat, type NanoclawMailboxSession } from './modules/mailbox/index.js';
import type { OutboundMessage } from './modules/mailbox/ops/delivery.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import { flagNeedsInput, getTaskByChildSession } from './modules/orchestrator-dispatch/db/tasks.js';
import { appendRunLog } from './modules/scheduling/run-log.js';
import { emitDashboardEvent, emitSessionEvent } from './dashboard/api/events.js';
import type { OutboundFile } from './channels/adapter.js';
import { isChannelVariant, type PendingApproval, type Session } from './types.js';

/**
 * A session is a spawn-task child when a row in the `tasks` table names it
 * as `child_session_id`. For these sessions the dashboard becomes a
 * persistent work log: thinking blocks render as fresh, durable messages in
 * the spawn thread rather than the ephemeral post-then-edit-then-delete
 * pattern that chat UX uses. Without this, only the final answer survives
 * in the thread and all in-flight progress vanishes when the answer posts.
 *
 * The cache is per-host-process and never invalidated — once a session is a
 * spawn child, it stays one for its entire lifetime, so a single positive
 * result is permanent. Negative results (regular chat session) are cached
 * too because we'd otherwise hit the central DB on every status delivery
 * for every chat session.
 */
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

/**
 * Attempt counts live in the `delivery_attempts` table, so they survive a
 * host restart: a poison message gets MAX_DELIVERY_ATTEMPTS total, not
 * MAX_DELIVERY_ATTEMPTS per process lifetime (the old in-memory counter
 * reset on every restart, so a crash-looping host retried it forever).
 * Bookkeeping failures must never break delivery: a failed read delivers
 * without a stored count, a failed record skips the give-up decision for this
 * tick (the message just retries next poll), and a failed clear leaves a stale
 * row the next lifecycle of the same id clears.
 *
 * The count is consulted BEFORE the adapter is called, not only after a
 * failure, because recording attempt N and marking the message permanently
 * failed are two separate writes. A host that dies between them leaves a row
 * at the cap with no terminal `delivered` row, and a successor that only ever
 * read the count after its own failure would call the adapter again — attempt
 * N+1, unbounded across repeated crashes in that window, and a duplicate
 * user-visible message whenever the failure happened after the send left the
 * host. Reading first makes the stored row terminal on its own.
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

/**
 * The stored row, or `undefined` when there is none and when the read failed.
 * The whole row rather than just the count: `last_error` is the only surviving
 * description of why the message failed under the previous host, and the
 * terminal give-up has to carry it forward.
 */
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

// ── Sweep change-gate (docs/specs/bounded-periodic-work/plan.md) ──
//
// The sweep opened both SQLite files for every session active in the last 7
// days — ~1,657 per cycle — to find the ~17 that had actually changed. Session
// DBs use journal_mode=DELETE, so every commit lands in the main file and moves
// its mtime; a stat answers "could this session possibly have work?" for the
// cost of one syscall. Same shape as `usageRollupMtimeCache` in host-sweep.
//
// Two rules keep the failure mode bounded, because a wrong skip here is a
// silently undelivered chat message rather than an error:
//
//   1. Arm only after a drain proves the session has NOTHING outstanding —
//      not even a future `deliver_after` row, and not after a delivery error.
//      Retry state now lives in the central DB's `delivery_attempts` rows
//      rather than in process memory, but THE RULE IS UNCHANGED and must not
//      be relaxed on that basis: the retry itself is still driven by polling
//      the session's own outbound.db, and a failed delivery writes nothing
//      there, so its mtime does not move. Arming on a drain that ended in an
//      error would skip that session until the backoff in rule 2 expires.
//   2. Expire the skip on time as well as on the change signal, so a bug in
//      the signal costs bounded delay instead of permanent silence.
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

/**
 * When a quiet session must be polled regardless of its change signal.
 *
 * Jittered per session across the second half of the window: sessions armed in
 * the same cycle would otherwise expire in the same cycle and re-create the
 * very ~1,657-session burst this gate exists to remove, once every backoff
 * period.
 */
export function quietDeliveryDeadlineMs(sessionId: string, armedAtMs: number): number {
  const half = QUIET_DELIVERY_BACKOFF_MS / 2;
  return armedAtMs + half + Math.floor(sessionJitterFraction(sessionId) * half);
}

/** Pure so the skip decision has one thing to unit-test. */
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

/** Test seam — the cache is process-local and rebuilt from disk on restart. */
export function peekQuietDeliveryMark(sessionId: string): QuietDeliveryMark | undefined {
  return quietDeliveryCache.get(sessionId);
}

export function _resetQuietDeliveryCacheForTest(): void {
  quietDeliveryCache.clear();
}

/**
 * Test seam: force the cache into a state the public path refuses to produce —
 * "armed" while the session still has a due row. That is exactly the corrupted
 * change-signal the time bound exists to survive, and it cannot be reached by
 * arming legitimately (arming requires a clean drain) or by freezing the file
 * (utimes has no nanosecond precision).
 */
export function _setQuietDeliveryMarkForTest(sessionId: string, mark: QuietDeliveryMark): void {
  quietDeliveryCache.set(sessionId, mark);
}

/**
 * What a drain concluded about the session.
 *
 * `clean` is the only outcome that may arm the skip: it means every row in
 * `messages_out` has a `delivered` row. `busy` exists because a concurrent
 * `pollActive` drain makes `deliverSessionMessages` a no-op — arming on that
 * would mark a session quiet without ever having looked at it.
 */
export type DrainOutcome = 'busy' | 'clean' | 'pending' | 'error';

/**
 * Per-session tracking of the currently-visible status line. First
 * `kind='status'` in a turn posts a fresh message and caches the route
 * + platform message id here; subsequent status events in the same turn
 * edit that message in place. On real chat delivery the orphan is
 * deleted via `deleteMessage` (using the *stored* route, not the chat
 * delivery's route — `send_message` can target a different
 * channel/thread than the session's status was posted to) and tracking
 * is cleared.
 */
interface StatusTrack {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  /** Instance the status was posted through — the orphan delete must reuse it
   *  or it routes through the default-instance adapter (a sibling bot). */
  instance?: string;
  /** Batch anchor (turn id) the tracked status belongs to. The container
   *  stamps it on every status row's `in_reply_to`. A status whose anchor
   *  differs from the tracked one belongs to a NEW turn — used to detect the
   *  prior turn ending without a chat-final (which would otherwise leave the
   *  💭 orphan undeleted and the next turn editing it in place above the
   *  user's newer message). Null only when the turn had no inbound anchor. */
  inReplyTo: string | null;
  /** Discord rejected further edits to this message with code 30046. Keep
   *  the route until a replacement post succeeds, but never retry the doomed
   *  edit while the replacement is pending. */
  editExhausted?: boolean;
}
const statusTracking = new Map<string, StatusTrack>();

/**
 * Delete this session's tracked 💭 status and clear the tracking entry.
 *
 * Two callers, one rule — a status line is scaffolding, never an outcome:
 *   - a chat-final landed, so the status has been superseded;
 *   - the turn ended without one, so the status is all the user would see.
 *
 * Uses the *stored* route (pinned when the status was first posted), not the
 * caller's — `send_message` can deliver a chat reply to a different
 * channel/thread than the status went to, and deleting via the reply's route
 * would target the wrong channel.
 *
 * Errors are swallowed: a failed delete (network, permission revoked, message
 * already gone) leaves the orphan visible but must never block `markDelivered`
 * for the real answer — that would retry and duplicate it.
 */
/**
 * Drop a session's 💭 status because its container is being killed.
 *
 * The container signals a graceful turn end with a `turn_end` row, but a killed
 * container never gets to — and for scheduled-task sessions that is the NORMAL
 * exit, not an edge case. `markCompleted` fires inside processQuery on the first
 * result (so the sweep doesn't see stale claims while the stream stays open for
 * follow-ups), which drops processingClaimCount to 0; the idle reaper then kills
 * the container seconds later with the stream still open, so the batch tail —
 * and its emitTurnEnd — is never reached. Observed on the support-inbox poller:
 * ack at 13:31:18.689Z, kill at 13:31:30, leaving the thinking label as the
 * run's only visible output in #support.
 *
 * Covers every kill reason (idle reap, 30-min ceiling, host restart, OOM), so
 * the host never depends on a dying process to clean up after itself.
 */
export async function clearSessionStatusOnKill(sessionId: string): Promise<void> {
  await dropOrphanStatus(sessionId);
}

async function dropOrphanStatus(sessionId: string, opts: { skip?: boolean } = {}): Promise<void> {
  const orphan = opts.skip ? undefined : statusTracking.get(sessionId);
  if (orphan && deliveryAdapter?.deleteMessage) {
    try {
      await deliveryAdapter.deleteMessage(
        orphan.channelType,
        orphan.platformId,
        orphan.threadId,
        orphan.messageId,
        orphan.instance,
      );
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
  statusTracking.delete(sessionId);
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
 * Per-session anchor for threading a turn's multiple channel-root messages.
 *
 * When a session emits several user-facing messages in one turn to a channel
 * *root* — i.e. the outbound row's `thread_id` is null because the session
 * isn't bound to a thread — the first message posts fresh and becomes the
 * thread parent; later messages of the same turn reply under it instead of
 * each landing as a separate top-level post.
 *
 * Turn-scoped and in-memory on purpose: a scheduled task MUST stay
 * thread-unbound (binding it to a thread would tie its lifetime to a session
 * that dies), and within one fire this is the right fix — the anchor lives
 * delivery-side, keyed by the turn's `in_reply_to`. It does NOT survive
 * across fires (each fire gets a fresh inbound id, so a new turn always
 * resets it) — that's `task_thread_anchors` (db/task-thread-anchors.ts), a
 * persistent, rotating anchor keyed by (session, destination). Task-session
 * posts use that one instead; this one only ever engages for everything
 * else (see `taskAnchorEligible` / `turnAnchorEligible` in deliverMessage).
 *
 * Sessions already bound to a thread (per-thread channel replies carry a
 * non-null `thread_id`) are untouched — the anchor only engages when
 * `thread_id` is null AND `in_reply_to` is set.
 */
interface ChatThreadAnchor {
  inReplyTo: string;
  channelType: string;
  platformId: string;
  messageId: string;
}
const chatThreadAnchor = new Map<string, ChatThreadAnchor>();

/**
 * Sessions whose turn anchor proved unusable, keyed sessionId -> that turn's
 * `in_reply_to`. Set when a threaded send under the anchor throws; the rest of
 * that turn then posts at root without re-paying a failing call. A new turn has
 * a different `in_reply_to`, so threading is retried — a transient failure
 * costs one turn, not the session.
 */
const chatThreadAnchorDisabled = new Map<string, string>();

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
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
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

/**
 * Invariant guard: channel_type and platform_id must BOTH be null or BOTH be non-null.
 * A mix (one null, one set) indicates corrupted routing state and should fail loudly
 * before any adapter call or DB write that relies on this pair.
 */
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
  // pollActive wraps its own body in try/catch and always reschedules itself,
  // so its returned promise never rejects — void is safe here.
  void pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  // pollSweep wraps its own body in try/catch and always reschedules itself,
  // so its returned promise never rejects — void is safe here.
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

// A session idle past this horizon has no deliverable outbound left — its
// container hasn't written in a week. Iterating EVERY active session ever
// created (3k+, synchronous SQLite each) cost ~3s of event-loop time per
// minute; the recent-activity bound keeps the cycle in the tens of ms.
const SWEEP_POLL_ACTIVITY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;
  // The 7-day horizon stopped bounding this loop once session volume grew
  // (2350 sessions/cycle observed) and every stall drops live Discord inbound
  // at the local forward hop, so the per-session change-gate inside the cycle
  // is what keeps the work proportional to what actually changed.
  //
  // try/catch mirrors pollActive: without it, a throw here would reject this
  // function's promise and skip the reschedule below, silently killing the
  // sweep loop forever instead of just skipping one cycle.
  try {
    await runSweepDeliveryCycle();
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }
  setTimeout(() => {
    void pollSweep();
  }, SWEEP_POLL_MS);
}

/**
 * Granular kind tag for the inbox board. For `chat-sdk` messages, the raw
 * `messages_out.kind` is just `chat-sdk` — too coarse for the dashboard to
 * tell "agent asked you a question" from "agent posted a streaming status".
 * Returning `chat-sdk:<content.type>` (or plain `chat-sdk` if the payload
 * doesn't carry a type) gives the inbox a single string to compare against.
 *
 * Anything that fails to parse falls back to the raw `msg.kind` — the inbox
 * treats unknown tags as plain outbound activity, which is the safe default.
 */
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
  // Keep the `chat-sdk:*` namespace contract so inbox consumers can
  // pattern-match by prefix; a bare `chat-sdk` would split the schema.
  return 'chat-sdk:unknown';
}

export async function deliverSessionMessages(session: Session): Promise<DrainOutcome> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above. `busy` rather than a bare return so
  // the sweep cannot mistake "another poll owns this" for "nothing to do".
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

  // The whole queue snapshot in ONE mailbox session, closed before anything
  // else runs. Nothing below this block may execute while a session is open on
  // this key: a delivery action handler that writes to the session it is
  // delivering for — `spawn_cancel` notifying its parent is the live case —
  // opens its own session and would hit the nesting guard, and the channel
  // adapter call is a network round trip with no business holding SQLite
  // handles. Plan §4.5b, invariants I-3 and I-9.
  let snapshot: { delivered: ReadonlySet<string>; outstanding: string[]; due: OutboundMessage[] } | undefined;
  try {
    snapshot = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds();
      return {
        delivered,
        // Everything outstanding, not just what is due — a row scheduled for
        // later sits in a file that may never change again, so it must block
        // arming.
        outstanding: mailbox.listOutboundMessageIds().filter((id) => !delivered.has(id)),
        due: mailbox.getDueOutboundMessages(),
      };
    });
  } catch {
    // Same answer the two raw opens gave: a session whose files are present
    // but unopenable (a stale reclaim claim, a descriptor ceiling) is
    // 'pending', so the sweep retries and never arms the quiet gate off a
    // failure.
    return 'pending';
  }
  // `undefined` is the vanished/not-yet-provisioned session: a read never
  // provisions one (invariant I-4), and there is nothing to deliver from a
  // mailbox that does not exist.
  if (snapshot === undefined) return 'pending';
  const { delivered, outstanding } = snapshot;

  if (outstanding.length === 0) return 'clean';

  const undelivered = snapshot.due.filter((m) => !delivered.has(m.id));
  if (undelivered.length === 0) return 'pending';

  // Bump `tasks.last_progress_at` once per drain if this session is a
  // spawn-task child. Only `spawn_progress` MCP calls update that column
  // today, so an agent that's actively thinking, posting status, and
  // running tool calls but hasn't explicitly pinged `spawn_progress`
  // within 30 minutes gets reaped by the no-progress watchdog as if it
  // were stuck. Observed against spawn-9048e8cfbcc024c2 (EXAMPLE-61) at
  // 20:11:05 UTC on 2026-05-11: the watchdog reaped exactly 33 seconds
  // before the child called spawn_complete — the agent was delivering
  // status messages within the same second. Counting any outbound row as
  // "progress" makes the no-progress timer mean what it says.
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
  const deliveredNow = new Set<string>();

  /**
   * Terminal drop for one message, reached either from this tick's own
   * failure or from a stored count that is already at the cap. `decidedFrom`
   * says which, so the operator reading the first `giving up` line after a
   * restart can tell a fresh exhaustion from an inherited one.
   */
  const giveUpOnMessage = async (
    msg: (typeof undelivered)[number],
    attempts: number,
    errMsg: string,
    decidedFrom: 'this attempt' | 'a count stored before this host started',
    err?: unknown,
  ): Promise<void> => {
    log.error('Message delivery failed permanently, giving up', {
      messageId: msg.id,
      sessionId: session.id,
      attempts,
      decidedFrom,
      err: err ?? errMsg,
    });
    await ackDelivery(agentGroup.id, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id, errMsg));
    await clearAttemptRow(msg.id);
    // Incident 2026-09-01: the row dropped here was a repository
    // publication that had already fenced ~1400 session inbound DBs in
    // its workgroup. Its strict release fails fast on the first bad
    // session, so every session behind that one stayed fenced — deaf,
    // unspawnable, and with no code path left to free it. Giving up on
    // the message is the last moment the host knows the transition has
    // ended, so release any fence no live publication still owns.
    // Lazy import: session-manager already imports delivery, so a static
    // edge here would close a module-init cycle (CLAUDE.md).
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

  for (const msg of undelivered) {
    // A stored count already at the cap is terminal on its own — the crash
    // window described on the helpers above leaves exactly that row behind.
    // Deciding from it BEFORE the adapter runs is what stops a successor host
    // spending attempt N+1, and stops a re-send of a message whose failure
    // happened after it had already left the previous host.
    const stored = await readAttemptRow(msg.id);
    if (stored !== undefined && stored.attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Terminal, like the give-up below, so the drain must not arm the quiet
      // cache this tick. The `delivered` row it writes takes the message out
      // of `outstanding` on the next drain.
      sawError = true;
      // The persisted adapter error, verbatim, because it is what the failure
      // actually was: the runner surfaces `delivered.error` to synchronous
      // callers (`send_file` and friends, container/agent-runner/src/db/
      // delivery-acks.ts), and a missing scope or an oversized file is only
      // actionable if that text survives the restart. The generic line is a
      // fallback for a row with no error stored, never a replacement.
      await giveUpOnMessage(
        msg,
        stored.attempts,
        stored.last_error && stored.last_error.length > 0
          ? stored.last_error
          : `delivery abandoned: ${stored.attempts} attempts recorded before this host started`,
        'a count stored before this host started',
      );
      // Nothing was sent, so nothing can overtake this row: unlike the retry
      // branch below, a terminal decision does not have to break the drain.
      continue;
    }
    try {
      const result = await deliverMessage(msg, session);
      // System actions like request_bash_gate return deferAck:true — the
      // handler owns the `delivered` row lifecycle and writes it later
      // (on admin approval or timeout). Auto-acking here would race
      // ahead of the human and silently unblock a gated command.
      if (!result.deferAck) {
        await ackDelivery(agentGroup.id, session.id, (mailbox) =>
          mailbox.markDelivered(msg.id, result.platformMsgId ?? null),
        );
        deliveredNow.add(msg.id);
        // Mirror the outbound timestamp into the central sessions row so
        // the inbox board can compute attention-state without opening
        // every per-session outbound.db. Only bump for messages that
        // actually went to a platform — system actions handled in-host
        // and agent-to-agent internal traffic aren't operator-visible
        // and would otherwise keep dormant sessions out of the stale
        // lane forever. Mirrors the typing-indicator gate below.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          const tag = outboundKindTag(msg);
          try {
            await bumpLastOutbound(session.id, tag);
          } catch (err) {
            log.warn('bumpLastOutbound failed', {
              sessionId: session.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          // Push the inbox-board SSE so an operator watching the inbox
          // sees the new last_outbound_at without waiting for poll.
          emitSessionEvent({
            session_id: session.id,
            agent_group_id: session.agent_group_id,
            kind: 'outbound',
            outbound_kind: tag,
          });
        }
      }
      await clearAttemptRow(msg.id);

      // Pause the typing indicator after a real user-facing message
      // lands on the user's screen, so the client has time to visually
      // clear the indicator before the next heartbeat tick brings it
      // back. Skip the pause for internal traffic (system actions,
      // agent-to-agent routing) — the user doesn't see those and
      // shouldn't get a gap in their typing indicator for them.
      if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
        pauseTypingRefreshAfterDelivery(session.id);
      }
    } catch (err) {
      sawError = true;
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
        // Preserve outbound ordering across retries. Continuing would let a
        // newer status/chat overtake this row; if the failed row later
        // retries, it can overwrite newer progress or appear after the final
        // answer. The next poll resumes from this oldest undelivered row.
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
 * Write one `delivered` row in its own short mailbox session.
 *
 * `withExistingMailboxSession`, not `withMailboxSession`: the mailbox this
 * acks was open moments ago to read the row, so provisioning can only mean the
 * session was reclaimed underneath us — and provisioning would then recreate
 * the directory a reclaim had just removed and create the outbound.db the host
 * must never author (`modules/mailbox/openers.ts`). A vanished session loses
 * its ack, which leaves the row outstanding exactly as an unwritable handle
 * did before, and says so instead of writing into an unlinked inode.
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

/**
 * One session's turn in the sweep: stat, gate, drain, arm.
 *
 * The stat is taken BEFORE the DBs are opened and that value is what gets
 * stored, so a commit landing mid-drain leaves a newer mtime on disk than the
 * armed one and is re-polled next cycle instead of being swallowed.
 */
export async function sweepDeliverSession(session: Session, nowMs: number): Promise<DrainOutcome | 'skipped'> {
  // A live container is about to write, and pollActive already drains it every
  // second — never gate it. `isContainerRunning` is the authoritative signal:
  // spawn records the container in its in-memory map (container-runner.ts,
  // `activeContainers.set`) before the central row is updated, and the sweep
  // snapshots every session up front, so `session.container_status` can still
  // read 'stopped' for a container that is already writing. The row is kept as
  // a fallback for the reverse skew.
  // Imported lazily: a static import would pull container-runner (docker,
  // spawn, image builds) into the module graph of everything that imports
  // delivery. Node caches the module, so this is a map lookup after the first
  // call.
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

/**
 * One sweep cycle over every session in the delivery horizon.
 *
 * Exported so the counters are testable without driving the 60s timer chain.
 */
export async function runSweepDeliveryCycle(nowMs: number = Date.now()): Promise<{ polled: number; skipped: number }> {
  const startedAtMs = Date.now();
  let polled = 0;
  let skipped = 0;
  const seen = new Set<string>();
  try {
    const sessions = await getSessionsActiveSince(new Date(nowMs - SWEEP_POLL_ACTIVITY_HORIZON_MS).toISOString());
    for (const session of sessions) {
      seen.add(session.id);
      // One unreadable session must not abort the cycle for every session
      // behind it. The drain now touches `delivered` for every swept session,
      // not just ones with due rows, so a legacy or corrupt session DB has a
      // wider blast radius than it used to.
      try {
        const outcome = await sweepDeliverSession(session, nowMs);
        if (outcome === 'skipped') skipped++;
        else polled++;
      } catch (err) {
        log.warn('Sweep delivery failed for session', { sessionId: session.id, err });
        quietDeliveryCache.delete(session.id); // never arm off a failure
        polled++;
      }
      // Yield after EVERY session, not every 25 — same correction host-sweep
      // made for the same reason. Each drain opens two SQLite files
      // synchronously, so a batch was one contiguous event-loop freeze.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Bounded to sessions still in the horizon, mirroring host-sweep's
    // quiet-cache cleanup — otherwise the map grows with every session ever seen.
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
 * Per-series thread-anchor opt-out (`content.threadAnchor === false`, set via
 * `ncl tasks … --thread-anchor false`). Read from the series' own task row in
 * the session's inbound.db and cached briefly so the flag costs one DB open
 * per session per TTL, not one per delivered message. Any failure (legacy
 * shared task thread, missing row, unparseable content) means NOT exempt —
 * the anchored default is the safe one for the storm shape.
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
  },
  session: Session,
): Promise<{ platformMsgId?: string; deferAck?: true }> {
  assertChannelRoutingConsistency({ channelType: msg.channel_type, platformId: msg.platform_id });

  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return {};
  }

  const content = JSON.parse(msg.content);

  const wikiGroup = await getAgentGroup(session.agent_group_id);
  if (wikiGroup) {
    const { readContainerConfig } = await import('./container-config.js');
    // Enrollment, not the model's tool list, constrains raw outbound rows too.
    const cfg = readContainerConfig(wikiGroup.folder);
    if (wikiEnrollment(wikiGroup.id, cfg.wikiMaintenance === true)) {
      if (!allowedWikiOutbound(msg.kind, content.action))
        throw new Error('Wiki maintenance outbound capability denied');
    }
  }

  // An agent's ask_question must never reuse a pending approval's id: its
  // buttons would carry that id, and a click on them would decode through the
  // approval's own options (src/db/sessions.ts:819-824), leaving only the card
  // binding in response-handler.ts between it and the approval.
  //
  // Compare the id a CLICK will decode, not the one that was written. Both
  // click parsers cut the question id out of `ncq:<questionId>:<index>` at the
  // first ':' after the prefix (chat-sdk-bridge.ts:1146-1147, :2032-2036), so
  // `appr-real:x` is stored whole, walks straight past an exact-match check,
  // and then reaches the handlers as `appr-real`. A suffixed id is unusable
  // for the agent's own card either way — pending_questions is keyed by the
  // whole id, so the click decodes to an id that row does not have — which is
  // why an ambiguous id is refused outright rather than only when it collides.
  //
  // ask_user_question mints its own id
  // (container/agent-runner/src/mcp-tools/interactive.ts:89), so only a raw
  // outbound row can carry either shape. Refused whole: no card, no pending
  // question.
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

  // Spawn-child workers sometimes ask via chat-sdk's `ask_question` instead
  // of calling `spawn_request_steer`. Both signal "operator attention
  // wanted" — light up the dashboard's Needs You lane for either. Worker
  // continuing autonomously is fine; the flag clears on the next steer
  // write per src/dashboard/steer.ts.
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

  // System actions — handle internally (self-mod, cli_request, agent routing, etc.)

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
    // `taskSeriesId` (`src/db/sessions.ts:182`) rather than a raw slice: the bare `system:tasks` a
    // pre-migration install may still hold is 12 characters, and slicing 13 off
    // it yielded an EMPTY series id.
    //
    // Where that landed is worth being exact about, because the two writes
    // below are protected differently. `appendRunLog` was never at risk: its
    // charset guard (`/^[a-z0-9-]+$/`, `src/modules/scheduling/run-log.ts:24`)
    // requires at least one character, so `''` threw before any filesystem
    // write and the `catch` below turned it into a warning. Execution then
    // continued to `recordTaskRunOutcome`
    // (`src/db/task-run-outcomes.ts:47-61`), which is an unguarded
    // `INSERT OR IGNORE` — so the malformed series id reached the central
    // ledger that T24 reads to decide escalations
    // (`src/modules/sweep-task-escalation/index.ts:170-172`). The file was
    // safe; the ledger was not.
    //
    // A session naming no series has no run log to append to and no series to
    // record against, so say so and drop the row rather than inventing one.
    const series = taskSeriesId(session.thread_id);
    if (session.messaging_group_id === null && series !== null) {
      const text = typeof content.text === 'string' ? content.text : '';
      try {
        await appendRunLog(session.agent_group_id, series, text);
      } catch (err) {
        log.warn('Failed to append task run log', { id: msg.id, sessionId: session.id, err });
      }
      // The run log is a markdown file nothing queries. Mirror the same event
      // into the central run-outcome ledger, which the escalation sweep reads
      // and which outlives S19's close of the spent task session (migration
      // 075). Only the runner's END-OF-RUN summary carries `auto: true`; a
      // mid-run `ncl tasks append-log` note is not a fire and must never move
      // a streak.
      //
      // Best-effort and separately caught: a task run's log line reaching the
      // series file must not depend on the ledger write, nor the reverse.
      if (content.auto === true) {
        try {
          await recordTaskRunOutcome({
            agentGroupId: session.agent_group_id,
            sessionId: session.id,
            seriesId: series,
            outboundId: msg.id,
            outcome: content.isError === true ? 'failed' : 'ok',
            model: typeof content.model === 'string' ? content.model : null,
            // Scrubbed HERE, not at read time: this row is durable and the
            // text is agent output. `scrubSecrets` runs on the outbound
            // delivery path below, never inside the adapter, so a value
            // recorded raw would sit in the central DB — and then ride into an
            // operator DM — having passed no scrubber at all.
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
  }

  // Status messages — post-then-edit per session. First status in a turn
  // posts a fresh line; subsequent statuses edit it in place. The tracking
  // clears when a real chat message delivers (handled at the end), so the
  // next turn starts with a new status line instead of clobbering history.
  //
  // EXCEPTION: spawn-task child sessions render their thread as a durable
  // work log — every thinking block is a fresh, persistent message in the
  // spawn thread. Edit-in-place and the on-chat orphan delete are bypassed
  // so progress survives the final answer.
  if (msg.kind === 'status') {
    if (!msg.channel_type || !msg.platform_id) {
      log.warn('Status message missing routing fields, dropping', { id: msg.id });
      return {};
    }
    const appendMode = await isSpawnChildSession(session.id);
    if (appendMode) {
      // Spawn-task child sessions used to render every thinking block as a
      // durable message in the worker's Slack/Discord thread — a "durable
      // work log" pattern. Operator feedback after the inbox board
      // shipped: the 💭 stream is just noise in chat, and SessionDetail
      // already surfaces thinking blocks as a collapsible group in the
      // dashboard. Suppress channel delivery for spawn-child status only;
      // the outbound.db row stays (so SessionDetail still sees the
      // thinking), markDelivered fires in the caller, and the
      // last_outbound bump + SSE downstream of this branch still notify
      // the inbox. Final spawn_progress / spawn_complete / spawn_failed
      // messages flow through their own MCP handlers, not this branch.
      log.info('Status suppressed in chat for spawn-child session', {
        id: msg.id,
        sessionId: session.id,
      });
      return {};
    }
    // Turn-boundary reset. A status row carries its turn's batch anchor in
    // `in_reply_to`. If a tracked status belongs to a DIFFERENT turn than the
    // one now arriving, the prior turn ended without a chat-final to run the
    // orphan cleanup (the agent thought/used tools but emitted no user-facing
    // <message> block — common in multi-bot threads or pure-tool turns). That
    // orphan still sits in the thread, now ABOVE the user's newer message.
    // Without this reset the next turn's status would edit that stale message
    // in place. Delete it via the *stored* route and drop tracking so the new
    // turn posts a fresh status line below the user's message instead.
    const stale = statusTracking.get(session.id);
    if (stale && stale.inReplyTo !== msg.in_reply_to) {
      if (deliveryAdapter.deleteMessage) {
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

    const existing = statusTracking.get(session.id);
    const freshOutbound = scrubSecrets(msg.content);
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

      // Discord code 30046 makes further edits to this message useless. Keep
      // the old status visible and tracked until its replacement posts, but
      // mark the edit path exhausted so a retry goes straight to a fresh post.
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
      // Pin the route at post-time. The cleanup branch on chat delivery uses
      // *this* route to delete the orphan, NOT the chat-final's route — the
      // agent's send_message MCP tool can target a different channel/thread,
      // and using the wrong (channel, ts) pair on Slack's chat.delete could
      // delete an unrelated message if the timestamps happened to collide.
      statusTracking.set(session.id, {
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        threadId: msg.thread_id,
        messageId: platformMsgId,
        instance: deliverInstance,
        inReplyTo: msg.in_reply_to,
      });
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

  // Scrub any registered secret values out of outbound text before it
  // reaches the adapter. Defense-in-depth — OneCLI already keeps API keys
  // away from the agent, but scrub content anyway in case an agent ever
  // ends up with a secret (e.g. by reading a file) and tries to echo it.
  const scrubbedContent = scrubSecrets(msg.content);

  // Final chat replies always post fresh (not as an edit of the in-flight
  // status bubble). When a user follow-up message arrives during the turn,
  // morphing the status into the answer would land the answer above the
  // follow-up in the thread — visually confusing. Status updates still
  // post-then-edit on their own (kind='status' branch above), so the
  // thinking bubble remains a single growing message; only the final
  // answer separates out into its own message at the bottom.

  const baseThreadId = msg.thread_id && msg.thread_id.length > 0 ? msg.thread_id : null;

  // Rolling task-session thread anchor (fleet-hardening Phase 1.4). A task
  // session is 1:1 with a series (thread_id = system:tasks:<seriesId>, see
  // resolveTaskSession) and lives for the series' whole life, but each fire
  // is a fresh turn with a fresh in_reply_to — so the per-turn anchor below
  // resets every fire, and every fire minted a brand-new top-level post
  // (and, on Slack, a brand-new thread every wired sibling had to re-notice).
  // task_thread_anchors persists the anchor ACROSS fires instead, keyed by
  // (session, destination) in the central DB, and rotates to a fresh
  // top-level post once `anchorRotationKey` disagrees (default: UTC day
  // change). Scoped to task sessions with no explicit thread_id — an
  // agent-targeted thread (baseThreadId set) is always left untouched.
  // Per-series opt-out (`ncl tasks … --thread-anchor false`): a series whose
  // contract is one NEW thread per logical item — a smoke campaign's
  // one-root-per-SHA, a per-ticket dispatcher — must never have consecutive
  // roots glued into one day-thread. content.threadAnchor === false exempts
  // the whole series; the anchor default stays ON because the storm shape
  // (repeated status posts) is the common case.
  const isTaskSessionPost = session.messaging_group_id === null && isTaskThread(session.thread_id);
  const taskAnchorEligible = isTaskSessionPost && baseThreadId === null && !(await isThreadAnchorExempt(session));

  // Per-turn channel-root threading (see ChatThreadAnchor above) — everything
  // that isn't a task-session post. Only engages when the agent didn't
  // already target a thread (thread_id null) and the turn has an inbound
  // anchor (in_reply_to set). The first message of the turn posts at root
  // and is recorded below; later messages of the same turn reply under it.
  const turnAnchorEligible = !taskAnchorEligible && baseThreadId === null && msg.in_reply_to != null;

  let effectiveThreadId = baseThreadId;
  let usedAnchor = false;
  if (taskAnchorEligible) {
    const anchor = await getTaskThreadAnchor(session.id, msg.channel_type, msg.platform_id);
    if (anchor && anchorRotationKey(anchor.createdAt) === anchorRotationKey(new Date().toISOString())) {
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
      anchor.platformId === msg.platform_id
    ) {
      // Adapters decode a thread id as `<platform-address>:<thread>` —
      // `discord:<guild>:<channel>:<thread>`, `slack:<channel>:<ts>`. `platform_id`
      // IS that address, so appending the anchor's message id produces the encoded
      // form both decoders accept.
      //
      // This previously passed the BARE message id, which no adapter can decode:
      // @chat-adapter/discord's decodeThreadId requires parts[0] === 'discord',
      // slack's requires parts[0] === 'slack'. So every message after a turn's
      // first threw ValidationError, burned 3 retries, and was dropped — silently
      // truncating every multi-message scheduled task on both platforms. Observed
      // 2026-07-25: the example-retail meeting digest posted its first 1.7KB chunk
      // and lost the next three ("Invalid Discord thread ID: 123456789000000009"
      // — that snowflake is a *message* id, never a thread id).
      effectiveThreadId = `${anchor.platformId}:${anchor.messageId}`;
      usedAnchor = true;
    }
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
    if (!usedAnchor) throw err;
    // Platforms disagree on whether a parent message is addressable as a thread.
    // Slack threads on the parent's ts. Discord needs a thread object first; its
    // adapter opens one on first use (installMessageThreadAutoCreate, discord.ts),
    // which can still fail (DMs, missing permission). Never let that cost the
    // message: post at root instead.
    //
    // Also record that anchoring is off for the REST OF THIS TURN (turn anchor)
    // or drop the stale anchor outright (task anchor — the next fire just
    // starts a fresh one), so the remaining messages go straight to root
    // rather than each paying a failed call.
    log.warn('Threaded delivery under anchor failed — posting at root', {
      id: msg.id,
      sessionId: session.id,
      taskAnchor: taskAnchorEligible,
      attemptedThreadId: effectiveThreadId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (taskAnchorEligible) {
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

  // Record a fresh root post as the anchor for what follows. Only when we
  // actually posted at root (effectiveThreadId still null) — a message that
  // already threaded under an existing anchor must not overwrite it, or the
  // next post would chain off it instead of the original root.
  if (effectiveThreadId === null && platformMsgId) {
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

  // A real chat message supersedes any in-flight progress status. Delete
  // the orphan thinking-block message so it doesn't linger in the thread,
  // then clear the tracking entry. Uses the *stored* route (pinned when
  // the status was first posted) — `send_message` can deliver this chat
  // reply to a different channel/thread than the status was posted to,
  // and using the chat reply's route to call `chat.delete` would target
  // the wrong channel.
  //
  // Errors are swallowed: a delete failure (network, permission revoked,
  // message already gone) leaves the orphan visible but must NOT block
  // markDelivered for the chat reply itself — that would cause retry/
  // duplicate of the real answer.
  if (msg.kind === 'chat') {
    // Skip orphan delete for spawn-task children — they were posted in
    // append mode (durable work log), so there's no orphan to clean up.
    // The statusTracking map is also untouched in append mode, but call
    // `delete` anyway as a defensive no-op in case a regular chat row ever
    // got tracked before the session was classified as a spawn child.
    const isSpawnChild = await isSpawnChildSession(session.id);
    await dropOrphanStatus(session.id, { skip: isSpawnChild });

    // Mirror agent replies into the central archive (2.9). Scrubbed text
    // so any accidentally-included secret stays out of searchable history.
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
          threadId: msg.thread_id,
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

  return { platformMsgId: platformMsgId ?? undefined };
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
 * Return value for a system-action delivery handler.
 *
 * - `undefined` / `void` — default: the outer delivery loop marks the
 *   message as delivered in inbound.db after the handler returns.
 * - `{ deferAck: true }` — handler takes ownership of the `delivered` row
 *   for this message. The outer loop must NOT call markDelivered — the
 *   handler will mark delivered/failed itself later (e.g. after an async
 *   admin approval). Required for bash-gate: the gate's requestId IS the
 *   msg.id, and the container polls `delivered` for that id as its ack
 *   signal, so a premature auto-ack would short-circuit the gate.
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
 * Turn boundary from the container, emitted once per turn exit (including the
 * durable work-continuation path). Sweeps up a 💭 status the turn never
 * superseded with a chat-final. Without it, a turn that thought + acted but
 * emitted no `<message>` leaves the thinking label as its only visible output —
 * and in a task session (support-inbox poller, scheduled job) there is no next
 * turn to reset it, so it stands as the "answer" forever.
 *
 * ORDERING: the container writes this row BEFORE `checkpointTurnEnd` and
 * `markCompleted`, so the inbound rows for the turn may still be claimed as
 * `processing` when it arrives — the checkpoint shells out to git and can take
 * seconds. Do not treat this as a signal that the turn's inbound state has
 * settled.
 *
 * No-op when a chat-final already cleared tracking, which is the common case.
 * That no-op is load-bearing: the container emits unconditionally precisely
 * because the host is the only side that knows whether a status is tracked.
 */
registerDeliveryAction(
  'turn_end',
  async (_content, session) => {
    await dropOrphanStatus(session.id);
    return undefined;
  },
  unguarded('turn boundary — deletes only this session’s own status line, no privileged effect'),
);
