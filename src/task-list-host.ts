/**
 * Live task list, host side; the runner owns the list itself. Kept here so the upstream-owned delivery and typing
 * modules carry only one-line hooks. delivery.ts is reached by dynamic import: it statically imports this module.
 */
import { parseRetryAfterMs } from './channels/chat-sdk-bridge.js';
import { TASK_LIST_ENABLED } from './config.js';
import { resolveGroupTimezone } from './container-config.js';
import { withCentralSync } from './db/central-lease.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import type { TaskListPostRoute, TaskListSettlement } from './modules/mailbox/ops/lookups.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { takesAWake } from './modules/sweep-continuation/kill-state.js';
import { scrubSecrets } from './secret-scrubber.js';
import { withExistingMailboxSession } from './session-manager.js';
import { formatLocalTime } from './timezone.js';
import type { Session } from './types.js';
import type { ChannelDeliveryAdapter } from './delivery.js';

/** Edits replaced by a later edit of the same message in this batch; `due` must be in delivery order. */
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

const TASK_LIST_SUPERSEDED_STUB = 'Latest task list below ↓';

export function taskListPostReceipt(
  kind: string,
  content: { operation?: unknown },
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance: string | undefined,
): { taskListRoute?: string } {
  if (kind !== 'task_list' || content.operation !== undefined) return {};
  const route: TaskListPostRoute = { channelType, platformId, threadId, instance: instance ?? null };
  return { taskListRoute: JSON.stringify(route) };
}

/**
 * The route a retirement may act on: exactly the address the destination check authorized for the row, with only
 * the thread taken from the host's receipt; null when the receipt is on any other address.
 */
function retireRoute(
  recorded: TaskListPostRoute | null,
  authorized: Omit<TaskListPostRoute, 'threadId'>,
): TaskListPostRoute | null {
  if (
    !recorded ||
    recorded.channelType !== authorized.channelType ||
    recorded.platformId !== authorized.platformId ||
    recorded.instance !== authorized.instance
  ) {
    return null;
  }
  return { ...authorized, threadId: recorded.threadId };
}

export async function retireSupersededTaskList(
  adapter: ChannelDeliveryAdapter,
  session: Session,
  msg: { id: string; content: string; channel_type: string | null; platform_id: string | null },
  authorizedInstance: string | undefined,
): Promise<{ recordOnly: true }> {
  const messageId = (JSON.parse(msg.content) as { messageId?: unknown }).messageId;
  const { channel_type: authorizedChannel, platform_id: authorizedPlatform } = msg;
  const route =
    typeof messageId === 'string' && authorizedChannel && authorizedPlatform
      ? retireRoute(
          (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
            mailbox.getTaskListPostRoute(messageId),
          )) ?? null,
          { channelType: authorizedChannel, platformId: authorizedPlatform, instance: authorizedInstance ?? null },
        )
      : null;
  if (!route || typeof messageId !== 'string') {
    log.warn('Task list delete refused — target is not a list post this session delivered', {
      id: msg.id,
      sessionId: session.id,
    });
    return { recordOnly: true };
  }
  const { channelType, platformId, threadId } = route;
  const instance = route.instance ?? undefined;
  const context = { id: msg.id, sessionId: session.id, messageId };
  if (!adapter.deleteMessage) {
    log.warn('Adapter cannot delete a superseded task list — editing it to a stub', context);
  } else {
    try {
      await adapter.deleteMessage(channelType, platformId, threadId, messageId, instance);
      return { recordOnly: true };
    } catch (err) {
      if (parseRetryAfterMs(err) !== null) throw err;
      log.warn('Failed to delete a superseded task list — editing it to a stub', {
        ...context,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await adapter.deliver(
    channelType,
    platformId,
    threadId,
    'task_list',
    JSON.stringify({ operation: 'edit', messageId, text: TASK_LIST_SUPERSEDED_STUB }),
    undefined,
    instance,
  );
  return { recordOnly: true };
}

const KILL_EDIT_MAX_ATTEMPTS = 4;
/** A cooldown longer than this is not waited out: the list keeps its last state. */
const KILL_EDIT_MAX_WAIT_MS = 5 * 60_000;
const KILL_EDIT_WAIT_BUFFER_MS = 250;

/**
 * The runner's own label says "stopped" (or who every open item waits on), which is all it can know. The host
 * replaces it only with the one thing it knows for certain: a `wait` the agent armed that has not come due. It never
 * says the session is resuming. A label the host composes is host literals and host-formatted times only, so nothing
 * the container wrote sits under a state the host vouches for; with no such `wait`, no usable timestamp, or a session
 * that takes no wake, the runner's own label stands. So it does when the label cannot be composed: by now the dead
 * container's queued rows are recorded delivered, and an edit that is not sent leaves the list looking live.
 */
async function killSubtext(
  session: Session,
  edit: NonNullable<TaskListSettlement['edit']>,
  nextCheckAt: string | null,
  reason: string,
): Promise<string> {
  if (edit.listedAt === null || nextCheckAt === null) return edit.interruptedSubtext;
  try {
    const timezone = await resolveGroupTimezone(session.agent_group_id);
    const nextCheck = formatLocalTime(nextCheckAt, timezone);
    return `paused · next check ${nextCheck} · todos as of ${formatLocalTime(edit.listedAt, timezone)}`;
  } catch (err) {
    log.warn(KILL_LABEL_UNAVAILABLE, { sessionId: session.id, reason, err });
    return edit.interruptedSubtext;
  }
}

const KILL_LABEL_UNAVAILABLE = 'Task list kill label unavailable — keeping the runner’s own';

/** The `wait` the label may name. Nothing but the session's own inbound rows is read unless one is armed. */
async function armedWaitAt(mailbox: NanoclawMailboxSession, session: Session, reason: string): Promise<string | null> {
  try {
    const at = mailbox.getNextScheduledWakeAt();
    if (at === null) return null;
    return (await withCentralSync(() => takesAWake(session.id), 'task list kill label')) ? at : null;
  } catch (err) {
    log.warn(KILL_LABEL_UNAVAILABLE, { sessionId: session.id, reason, err });
    return null;
  }
}

/**
 * Never throws. Fenced through the session's delivery slot: the dead container's queued list rows are recorded
 * delivered-unsent durably first, so a restart can't replay them over the interrupted form. The edit target comes
 * from host-owned evidence and must be the session's own conversation; the wording is container-written unless the
 * host composed the label. Rate-limit cooldowns are waited out OUTSIDE the slot, re-deciding each time.
 */
export async function settleTaskListOnKill(sessionId: string, reason: string): Promise<void> {
  setTypingStatusText(sessionId, null);
  if (!TASK_LIST_ENABLED) return;
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
        const settlement = await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
          const found = mailbox.getTaskListSettlement(killedAt);
          if (!found) return null;
          for (const rowId of found.staleRowIds) mailbox.markDelivered(rowId, null);
          return { ...found, nextCheckAt: found.edit ? await armedWaitAt(mailbox, session, reason) : null };
        });
        const edit = settlement?.edit;
        if (!edit) return 0;
        if (
          edit.channelType !== origin.channel_type ||
          edit.platformId !== origin.platform_id ||
          // A channel-level session holds its lists in the threads of the messages it answered.
          (session.thread_id !== null && edit.threadId !== session.thread_id)
        ) {
          log.warn('Task list is not in this session’s own conversation — not marking it interrupted', {
            sessionId,
          });
          return 0;
        }
        const cooling = taskListCooldownMs(edit.channelType);
        if (cooling > 0) return cooling;
        const subtext = await killSubtext(session, edit, settlement.nextCheckAt, reason);
        try {
          await adapter.deliver(
            edit.channelType,
            edit.platformId,
            edit.threadId,
            'task_list',
            // Container-written, unless the host composed the subtext.
            scrubSecrets(
              JSON.stringify({
                operation: 'edit',
                messageId: edit.platformMessageId,
                text: edit.interruptedText,
                subtext,
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
 * Per platform, when its task-list rate-limit cooldown ends. Platform-wide because Slack's update limits are
 * per workspace; answers never consult it and a paused row is not charged a delivery attempt.
 */
const taskListCooldowns = new Map<string, number>();

export function taskListCooldownMs(channelType: string | null): number {
  const key = channelType ?? '';
  const until = taskListCooldowns.get(key);
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left > 0) return left;
  taskListCooldowns.delete(key);
  return 0;
}

/** True (not a delivery failure) when `err` is a rate limit. */
export function deferTaskListOnRateLimit(channelType: string | null, err: unknown): boolean {
  const retryAfterMs = parseRetryAfterMs(err);
  if (retryAfterMs === null) return false;
  const key = channelType ?? '';
  taskListCooldowns.set(key, Math.max(taskListCooldowns.get(key) ?? 0, Date.now() + retryAfterMs));
  return true;
}

/** A held initial POST is retired if an answer delivers after it, rather than landing below the answer. */
export function noteHeldTaskListPost(held: Set<string>, msg: { id: string; content: string }): void {
  try {
    if ((JSON.parse(msg.content) as { operation?: unknown }).operation === undefined) held.add(msg.id);
  } catch {
    // Unparseable: the delivery path records its own failure for it.
  }
}

export function _clearTaskListCooldownsForTest(): void {
  taskListCooldowns.clear();
}

/** Slack's `assistant.threads.setStatus` rejects a `loading_messages` entry of 51+ characters. */
const STATUS_TEXT_MAX = 50;

function clipStatusText(text: string): string {
  if (text.length <= STATUS_TEXT_MAX) return text;
  let cut = text.slice(0, STATUS_TEXT_MAX - 1);
  // Never leave half of a surrogate pair (an emoji cut in two).
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const statusTexts = new Map<string, string>();

export function setTypingStatusText(sessionId: string, text: string | null): void {
  if (text && text.trim()) statusTexts.set(sessionId, text.trim());
  else statusTexts.delete(sessionId);
}

/** Undefined (the adapter's own default) with the switch off. */
export function typingStatusFor(sessionId: string): string | undefined {
  if (!TASK_LIST_ENABLED) return undefined;
  const item = statusTexts.get(sessionId);
  if (!item) return 'is thinking…';
  return clipStatusText(`is working: ${item}`);
}

export function noteTaskListDelivered(sessionId: string, content: Record<string, unknown>): void {
  const meta = content.taskList as { activeText?: unknown } | undefined;
  if (meta && 'activeText' in meta) {
    setTypingStatusText(sessionId, typeof meta.activeText === 'string' ? meta.activeText : null);
  }
}

/** Fire-and-forget: a failed reaction must never hold up the message it acknowledges. */
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

export function isHumanChatSdkContent(kind: string, content: string): boolean {
  if (kind !== 'chat-sdk') return false;
  try {
    const author = (JSON.parse(content) as { author?: { isBot?: unknown } }).author;
    return author?.isBot === false;
  } catch {
    return false;
  }
}
