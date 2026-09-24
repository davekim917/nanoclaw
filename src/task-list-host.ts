/**
 * Live task list — host side (docs/specs/slack-task-list/plan.md).
 *
 * The runner owns the list (container/agent-runner/src/task-list.ts): it
 * decides post vs edit, renders it, and keeps the durable record in
 * `session_state.task_list`. The host does four small things, all here so the
 * upstream-owned delivery and typing modules carry only one-line hooks:
 *
 *   - the switch's delivery gate, plus the fence that stops a killed
 *     container's queued update from reviving a list marked interrupted
 *     (`taskListRowAdmissible`);
 *   - marking a list interrupted when its container is killed mid-work
 *     (`settleTaskListOnKill`);
 *   - the platform status line's text — "is working: <current item>"
 *     (`setTypingStatusText` / `typingStatusFor`);
 *   - the 👀 receipt on a human's message (`ackInboundReceipt`).
 *
 * delivery.ts is reached by dynamic import: it statically imports this module.
 */
import { TASK_LIST_ENABLED } from './config.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
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
 * Per session, the list revision the host marked interrupted. A queued update
 * from the dead container at or below it must not revive the ✱; a newer
 * container writes higher revisions (the counter lives in the session's
 * durable record) and passes, clearing the fence.
 */
const interruptedTaskLists = new Map<string, number>();

/** Test hook: forget interrupted-list fences (host-memory reset). */
export function _resetInterruptedTaskListsForTest(): void {
  interruptedTaskLists.clear();
}

/** Should delivery send this task_list row? False = record it delivered, post nothing. */
export function taskListRowAdmissible(sessionId: string, content: Record<string, unknown>): boolean {
  if (!TASK_LIST_ENABLED) return false;
  const revision = (content.taskList as { revision?: unknown } | undefined)?.revision;
  const fence = interruptedTaskLists.get(sessionId);
  if (fence === undefined || typeof revision !== 'number') return true;
  if (revision <= fence) return false;
  interruptedTaskLists.delete(sessionId);
  return true;
}

/**
 * Edit a session's unfinished task list to its "interrupted" form because its
 * container is being killed mid-work, so a dead agent never leaves a
 * live-looking list. The runner pre-renders that form on every update
 * (`interruptedText`), so the host renders nothing. Never throws.
 */
export async function settleTaskListOnKill(sessionId: string, reason: string): Promise<void> {
  setTypingStatusText(sessionId, null);
  if (!TASK_LIST_ENABLED || IDLE_EXIT_REASONS.has(reason)) return;
  try {
    const { getDeliveryAdapter } = await import('./delivery.js');
    const adapter = getDeliveryAdapter();
    const session = await getSession(sessionId);
    if (!adapter || !session) return;
    const list = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.readTaskList(),
    );
    if (!list || list.finished || list.stale) return;
    interruptedTaskLists.set(sessionId, list.revision);
    const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      origin && origin.channel_type === list.channelType && origin.platform_id === list.platformId
        ? origin
        : await getMessagingGroupByPlatform(list.channelType, list.platformId);
    await adapter.deliver(
      list.channelType,
      list.platformId,
      list.threadId,
      'task_list',
      JSON.stringify({
        operation: 'edit',
        messageId: list.platformMessageId,
        text: scrubSecrets(list.interruptedText),
        subtext: list.interruptedSubtext,
      }),
      undefined,
      mg?.instance,
    );
    log.info('Task list marked interrupted', { sessionId, reason, revision: list.revision });
  } catch (err) {
    log.warn('Failed to mark task list interrupted — leaving its last state', {
      sessionId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
