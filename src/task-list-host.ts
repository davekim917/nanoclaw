/**
 * Live task list — host side (docs/specs/slack-task-list/plan.md).
 *
 * The runner owns the list (container/agent-runner/src/task-list.ts): it
 * decides post vs edit, renders it, and keeps the durable record in
 * `session_state.task_list`. The host does four small things, all here so the
 * upstream-owned delivery and typing modules carry only one-line hooks:
 *
 *   - coalescing queued edits of one list (`supersededTaskListEdits`);
 *   - marking a list interrupted when its container is killed mid-work,
 *     fenced so the dead container's queued updates cannot revive it
 *     (`settleTaskListOnKill`);
 *   - the platform status line's text — "is working: <current item>"
 *     (`setTypingStatusText` / `typingStatusFor`);
 *   - the 👀 receipt on a human's message (`ackInboundReceipt`).
 *
 * delivery.ts is reached by dynamic import: it statically imports this module.
 */
import { parseRetryAfterMs } from './channels/chat-sdk-bridge.js';
import { TASK_LIST_ENABLED } from './config.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { scrubSecrets } from './secret-scrubber.js';
import { withExistingMailboxSession } from './session-manager.js';

/**
 * Kill reasons that end a container AFTER its work, not during it. The idle
 * reapers fire only once the agent has stopped, so a list still showing ✱
 * there is the agent's own bookkeeping, not an interruption — leave it.
 */
const IDLE_EXIT_REASONS = new Set(['scheduled-task-idle', 'chat-idle-reap']);

/**
 * Task-list edits in a delivery batch that a LATER edit of the same message
 * in the same batch replaces. Every edit carries the whole list, so only the
 * newest needs to reach the platform; the rest are recorded delivered unsent.
 * `due` is in delivery order. Posts are never superseded — an edit can only
 * target a post that already delivered.
 */
export function supersededTaskListEdits(
  due: ReadonlyArray<{ id: string; kind: string; content: string }>,
): Set<string> {
  const latestByTarget = new Map<string, string>();
  const superseded = new Set<string>();
  for (const row of due) {
    if (row.kind !== 'task_list') continue;
    let target: unknown;
    try {
      const content = JSON.parse(row.content) as { operation?: unknown; messageId?: unknown };
      target = content.operation === 'edit' ? content.messageId : undefined;
    } catch {
      continue;
    }
    if (typeof target !== 'string') continue;
    const previous = latestByTarget.get(target);
    if (previous) superseded.add(previous);
    latestByTarget.set(target, row.id);
  }
  return superseded;
}

/** Rate-limited interrupted edits are retried this many times in all. */
const KILL_EDIT_MAX_ATTEMPTS = 4;
/** A cooldown longer than this is not waited out: the list keeps its last state. */
const KILL_EDIT_MAX_WAIT_MS = 5 * 60_000;
const KILL_EDIT_WAIT_BUFFER_MS = 250;

/**
 * Edit a session's unfinished task list to its "interrupted" form because its
 * container is being killed mid-work, so a dead agent never leaves a
 * live-looking list. Never throws; its caller does not wait on it.
 *
 * Ordered and fenced through the session's delivery slot: it waits for any
 * drain in flight, records the dead container's still-queued list rows
 * delivered-unsent (durably, in inbound.db, so a host restart cannot replay
 * them over the interrupted form), then edits. Where it edits comes from
 * host-owned evidence (`getTaskListSettlement`) and must be the session's own
 * conversation; only the wording — pre-rendered by the runner on every update
 * — comes from the container's record.
 *
 * A rate limit does not lose the edit: it waits out the platform's cooldown
 * OUTSIDE the slot (answers keep flowing) and tries again, re-deciding from
 * scratch each time, so a replacement container that took the list over in
 * the meantime is left alone.
 */
export async function settleTaskListOnKill(sessionId: string, reason: string): Promise<void> {
  setTypingStatusText(sessionId, null);
  if (!TASK_LIST_ENABLED || IDLE_EXIT_REASONS.has(reason)) return;
  const killedAt = new Date().toISOString();
  try {
    const session = await getSession(sessionId);
    const origin = session?.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    if (!session || !origin) return;
    const { getDeliveryAdapter, withSessionDeliverySlot } = await import('./delivery.js');
    for (let attempt = 1; ; attempt++) {
      const waitMs = await withSessionDeliverySlot(sessionId, async (): Promise<number> => {
        const adapter = getDeliveryAdapter();
        if (!adapter) return 0;
        const settlement = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
          const found = mailbox.getTaskListSettlement(killedAt);
          if (found) for (const rowId of found.staleRowIds) mailbox.markDelivered(rowId, null);
          return found;
        });
        const edit = settlement?.edit;
        if (!edit) return 0;
        if (
          edit.channelType !== origin.channel_type ||
          edit.platformId !== origin.platform_id ||
          // A channel-level session (no thread of its own) holds its lists in
          // the threads of the messages it answered, all in its own channel.
          (session.thread_id !== null && edit.threadId !== session.thread_id)
        ) {
          log.warn('Task list is not in this session’s own conversation — not marking it interrupted', {
            sessionId,
          });
          return 0;
        }
        const cooling = taskListCooldownMs(edit.channelType);
        if (cooling > 0) return cooling;
        try {
          await adapter.deliver(
            edit.channelType,
            edit.platformId,
            edit.threadId,
            'task_list',
            // Scrubbed whole, like every other outbound payload (delivery.ts):
            // both fields are container-written.
            scrubSecrets(
              JSON.stringify({
                operation: 'edit',
                messageId: edit.platformMessageId,
                text: edit.interruptedText,
                subtext: edit.interruptedSubtext,
              }),
            ),
            undefined,
            origin.instance,
          );
        } catch (err) {
          if (deferTaskListOnRateLimit(edit.channelType, err)) return taskListCooldownMs(edit.channelType) || 1;
          throw err;
        }
        log.info('Task list marked interrupted', { sessionId, reason, skippedRows: settlement.staleRowIds.length });
        return 0;
      });
      if (waitMs === undefined) {
        log.warn('Task list left as is — a delivery for this session did not finish in time', { sessionId, reason });
        return;
      }
      if (waitMs === 0) return;
      if (attempt >= KILL_EDIT_MAX_ATTEMPTS || waitMs > KILL_EDIT_MAX_WAIT_MS) {
        log.warn('Task list left as is — still rate-limited', { sessionId, reason, attempt, waitMs });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs + KILL_EDIT_WAIT_BUFFER_MS));
    }
  } catch (err) {
    log.warn('Failed to mark task list interrupted — leaving its last state', {
      sessionId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Per platform (channel type), when its rate-limit cooldown ends. A task-list
 * write that hits a rate limit pauses EVERY task-list write on that platform
 * until Retry-After passes — a newer revision of the same list, another
 * session's list, the kill-time interrupted edit — so a busy list cannot keep
 * probing a limit it has already been told about. Platform-wide rather than
 * per channel because Slack's update limits are per workspace, and a pause of
 * a few seconds costs nothing: answers never consult it, and a paused row is
 * not charged a delivery attempt, so a long cooldown cannot exhaust a final
 * refresh. Memory-only: after a host restart the next write simply tries.
 */
const taskListCooldowns = new Map<string, number>();

/** Milliseconds left in this platform's task-list cooldown; 0 when there is none. */
export function taskListCooldownMs(channelType: string | null): number {
  const key = channelType ?? '';
  const until = taskListCooldowns.get(key);
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left > 0) return left;
  taskListCooldowns.delete(key);
  return 0;
}

/** If `err` is a rate limit, start this platform's cooldown and return true (not a delivery failure). */
export function deferTaskListOnRateLimit(channelType: string | null, err: unknown): boolean {
  const retryAfterMs = parseRetryAfterMs(err);
  if (retryAfterMs === null) return false;
  const key = channelType ?? '';
  taskListCooldowns.set(key, Math.max(taskListCooldowns.get(key) ?? 0, Date.now() + retryAfterMs));
  return true;
}

/**
 * Note an initial task-list POST the drain stepped past for a rate limit. If
 * an answer delivers after it in the same drain, the post is retired
 * (recorded delivered-unsent) rather than sent later BELOW the answer; the
 * runner reads that as a failed post and its next update posts afresh. Edits
 * can safely land late — they change a message already in place.
 */
export function noteHeldTaskListPost(held: Set<string>, msg: { id: string; content: string }): void {
  try {
    if ((JSON.parse(msg.content) as { operation?: unknown }).operation !== 'edit') held.add(msg.id);
  } catch {
    // Unparseable: the delivery path records its own failure for it.
  }
}

/** Test seam: forget every cooldown. */
export function _clearTaskListCooldownsForTest(): void {
  taskListCooldowns.clear();
}

/** Longest task-list item shown in a status line before it is clipped. */
const STATUS_ITEM_MAX = 60;

/**
 * Per session, the task list's current item (set when a task_list row
 * delivers). It becomes the platform status line — "is working: Run the
 * migration" — so work with a list reads as specific, and work without one
 * as "is thinking…".
 */
const statusTexts = new Map<string, string>();

export function setTypingStatusText(sessionId: string, text: string | null): void {
  if (text && text.trim()) statusTexts.set(sessionId, text.trim());
  else statusTexts.delete(sessionId);
}

/** Status-line text for a session; undefined (the adapter's own default) with the switch off. */
export function typingStatusFor(sessionId: string): string | undefined {
  if (!TASK_LIST_ENABLED) return undefined;
  const item = statusTexts.get(sessionId);
  if (!item) return 'is thinking…';
  return `is working: ${item.length > STATUS_ITEM_MAX ? `${item.slice(0, STATUS_ITEM_MAX - 1)}…` : item}`;
}

/**
 * Update the status-line item from a delivered task_list row. A superseded
 * pointer carries no activeText and leaves it alone.
 */
export function noteTaskListDelivered(sessionId: string, content: Record<string, unknown>): void {
  const meta = content.taskList as { activeText?: unknown } | undefined;
  if (meta && 'activeText' in meta) {
    setTypingStatusText(sessionId, typeof meta.activeText === 'string' ? meta.activeText : null);
  }
}

/**
 * 👀 on a human's message the moment an agent takes it — the receipt half of
 * the UX. Slack only, like the list's rendering; fire-and-forget, a failed
 * reaction must never hold up the message it acknowledges.
 */
export function ackInboundReceipt(
  channelType: string,
  platformId: string,
  threadId: string | null,
  messageId: string,
  instance: string | undefined,
): void {
  if (!TASK_LIST_ENABLED || !channelType.startsWith('slack')) return;
  void import('./delivery.js')
    .then(({ getDeliveryAdapter }) =>
      getDeliveryAdapter()?.deliver(
        channelType,
        platformId,
        threadId,
        'chat',
        JSON.stringify({ operation: 'reaction', messageId, emoji: 'eyes' }),
        undefined,
        instance,
      ),
    )
    .catch((err: unknown) =>
      log.debug('Receipt reaction failed', { messageId, err: err instanceof Error ? err.message : String(err) }),
    );
}

/** A chat-sdk message whose serialized author says it is not a bot. */
export function isHumanChatSdkContent(kind: string, content: string): boolean {
  if (kind !== 'chat-sdk') return false;
  try {
    const author = (JSON.parse(content) as { author?: { isBot?: unknown } }).author;
    return author?.isBot === false;
  } catch {
    return false;
  }
}
