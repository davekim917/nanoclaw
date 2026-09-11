/**
 * Choice cards — approvals whose buttons are the requester's own options.
 *
 * A module that wants an answer rather than an approve/reject decision calls
 * requestApproval with custom `options` and registers a handler here under the
 * same action. The response handler then routes the row through this file
 * instead of the approve/reject path:
 *
 *   - Authority is never thread membership: isAuthorizedApprovalClick skips its
 *     any-thread-member shortcut for a registered choice action, so a choice
 *     needs the named approver or admin privilege on the agent group.
 *   - Any stored option is an answer, and the first authorized click wins
 *     (resolveChoice). The handler decides which session receives it.
 *   - A click the host refuses leaves the row pending and re-posts the card
 *     (refuseChoiceClick), because the bridge has already stripped its buttons.
 *   - retireChoice closes an open card without an answer (e.g. superseded).
 *
 * A leaf file like finalize.ts, so primitive.ts and response-handler.ts carry
 * only the seams. Keyed by action like the approval registry, so the rules are
 * back in force as soon as the owning module re-registers after a host restart.
 */
import type { NormalizedOption } from '../../channels/ask-question.js';
import { getDb } from '../../db/connection.js';
import {
  deletePendingApproval,
  getSession,
  transitionPendingApprovalStatus,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { notifyApprovalResolved } from './primitive.js';

export interface ChoiceHandlerContext {
  approval: PendingApproval;
  /** The session that asked, when it is still live; undefined once it has ended. */
  requester: Session | undefined;
  /** Value of the clicked option, verified against the row's stored options. */
  value: string;
  /** Button label of the clicked option. */
  label: string;
  /** Namespaced user ID (`<channel>:<handle>`) of the authorized clicker. */
  userId: string;
}

/** Deliver the answer. Resolves to the session that received it, or null when no live session can. */
export type ChoiceHandler = (ctx: ChoiceHandlerContext) => Promise<Session | null>;

const choiceHandlers = new Map<string, ChoiceHandler>();

export function registerChoiceHandler(action: string, handler: ChoiceHandler): void {
  if (choiceHandlers.has(action)) {
    log.warn('Choice handler re-registered (overwriting)', { action });
  }
  choiceHandlers.set(action, handler);
}

export function getChoiceHandler(action: string): ChoiceHandler | undefined {
  return choiceHandlers.get(action);
}

/**
 * The message whose thread is the card's conversation: the first message the
 * card was posted as. A re-post (refuseChoiceClick) moves the live card to a
 * new message but keeps this anchor in the payload, so an answer still lands
 * where replies to the original ask do.
 */
export function choiceAnchorMessageId(approval: PendingApproval): string | null {
  const anchor = parsePayload(approval).anchorMessageId;
  return typeof anchor === 'string' ? anchor : approval.platform_message_id;
}

/** The response handler refused a click on this choice card: keep it answerable. */
export async function refuseChoiceClick(approval: PendingApproval): Promise<void> {
  if (approval.status !== 'pending') return;
  await repostChoiceCard(
    approval,
    cardText(
      approval,
      'That click was not applied: only an admin of this agent can answer. The card has been re-posted below.',
    ),
  );
}

/**
 * Resolve an authorized click on a choice card. Any stored option is a
 * legitimate answer — there is no approve/reject vocabulary here — and the
 * first click wins: the pending→approved compare-and-swap
 * (transitionPendingApprovalStatus, src/db/sessions.ts:726-737) lets exactly
 * one racing click through, and the row is deleted once the handler has run,
 * so a later click finds nothing.
 */
export async function resolveChoice(approval: PendingApproval, selectedOption: string, userId: string): Promise<void> {
  const handler = getChoiceHandler(approval.action);
  if (!handler) return;

  const option = storedOptions(approval).find((o) => o.value === selectedOption);
  if (!option) {
    // Untrusted transport input, not a decision: keep the card answerable.
    log.warn('Ignoring choice response with an unknown option', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    if (approval.status === 'pending') {
      await repostChoiceCard(
        approval,
        cardText(approval, 'That click could not be read. The card has been re-posted below.'),
      );
    }
    return;
  }

  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved'))) {
    log.info('Ignoring click on an already-resolved choice', { approvalId: approval.approval_id, userId });
    return;
  }

  let deliveredTo: Session | null;
  try {
    deliveredTo = await handler({
      approval,
      requester: await liveSession(approval.session_id),
      value: option.value,
      label: option.label,
      userId,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- nothing reached the agent; reopen the card instead of losing the answer
  } catch (err) {
    log.error('Choice handler threw — reopening the card', {
      approvalId: approval.approval_id,
      action: approval.action,
      err,
    });
    await updatePendingApprovalStatus(approval.approval_id, 'pending');
    await repostChoiceCard(
      approval,
      cardText(approval, 'That answer could not be delivered. The card has been re-posted below.'),
    );
    return;
  }

  if (!deliveredTo) {
    log.warn('Choice answered but no live session can take it — resolved without delivery', {
      approvalId: approval.approval_id,
      action: approval.action,
      sessionId: approval.session_id,
      userId,
    });
    await deletePendingApproval(approval.approval_id);
    await editChoiceCard(approval, cardText(approval, 'No longer active: the conversation that asked this has ended.'));
    return;
  }

  log.info('Choice resolved', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    sessionId: deliveredTo.id,
  });
  await deletePendingApproval(approval.approval_id);
  // A choice resolves as approval of the chosen option.
  await notifyApprovalResolved({ approval, session: deliveredTo, outcome: 'approve', userId });
}

/**
 * Close an open choice card without an answer: claim it (pending→expired, so a
 * racing click loses), drop the row so a late click finds nothing, then edit
 * the card to its ask plus `line`. The row is retired even when the edit fails.
 * Returns false when the card was no longer open.
 */
export async function retireChoice(approval: PendingApproval, line: string): Promise<boolean> {
  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'expired'))) return false;
  await deletePendingApproval(approval.approval_id);
  await editChoiceCard(approval, cardText(approval, line));
  return true;
}

/** Same predicate as unwakeableReason (src/container-runner.ts:691-696). */
async function liveSession(sessionId: string | null): Promise<Session | undefined> {
  const session = sessionId ? await getSession(sessionId) : undefined;
  return session && session.status === 'active' && session.archived_at == null ? session : undefined;
}

/**
 * Edit a choice card's message to `text`. The editCardResolution pattern
 * (onecli-approvals.ts:513-538): dispatch through `instance ?? channel_type`,
 * because dispatch is exact-key, and fail loudly — the row is gone or about
 * to be, so a swallowed failure leaves live-looking buttons that do nothing.
 */
async function editChoiceCard(approval: PendingApproval, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !approval.platform_message_id || !approval.channel_type || !approval.platform_id) return;
  try {
    await adapter.deliver(
      approval.channel_type,
      approval.platform_id,
      approval.thread_id,
      'chat-sdk',
      JSON.stringify({ operation: 'edit', messageId: approval.platform_message_id, text }),
      undefined,
      approval.instance ?? approval.channel_type,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- the card edit is cosmetic; the row's state is already decided
  } catch (err) {
    log.error('Failed to edit choice card', { approvalId: approval.approval_id, err });
  }
}

/**
 * Put a still-pending card back in front of its deciders: edit the old message
 * to `notice`, post the card again with its stored buttons, and point the row
 * at the new message (keeping the first one as the conversation anchor).
 *
 * Needed because the chat-sdk bridge strips a card's buttons BEFORE the host
 * sees the click (chat-sdk-bridge.ts:1161-1193; Discord :2057-2085), so a click
 * the host refuses would otherwise leave a live row behind a dead card, and the
 * bridge's edit operation renders text only (chat-sdk-bridge.ts:1299-1316) —
 * the buttons cannot be edited back onto the old message.
 */
async function repostChoiceCard(approval: PendingApproval, notice: string): Promise<void> {
  if (!approval.channel_type || !approval.platform_id) return;
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  await editChoiceCard(approval, notice);
  try {
    const platformMsgId = await adapter.deliver(
      approval.channel_type,
      approval.platform_id,
      approval.thread_id,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approval.approval_id,
        title: approval.title,
        question: approval.question,
        options: JSON.parse(approval.options_json),
      }),
      undefined,
      approval.instance ?? approval.channel_type,
    );
    if (platformMsgId) {
      const payload = parsePayload(approval);
      if (payload.anchorMessageId === undefined && approval.platform_message_id) {
        payload.anchorMessageId = approval.platform_message_id;
      }
      await getDb().run(
        'UPDATE pending_approvals SET platform_message_id = ?, payload = ? WHERE approval_id = ?',
        platformMsgId,
        JSON.stringify(payload),
        approval.approval_id,
      );
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort like editApprovalCard: the row stays pending either way
  } catch (err) {
    log.warn('Failed to re-post choice card', { approvalId: approval.approval_id, err });
  }
}

function parsePayload(approval: PendingApproval): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(approval.payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload carries no anchor or key
  } catch {
    return {};
  }
}

function storedOptions(approval: PendingApproval): NormalizedOption[] {
  try {
    const parsed: unknown = JSON.parse(approval.options_json);
    return Array.isArray(parsed) ? (parsed as NormalizedOption[]) : [];
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupt metadata matches no option, so the click is ignored
  } catch {
    return [];
  }
}

/** Card body for a host-side edit of a choice card: the original ask, then what happened. */
function cardText(approval: PendingApproval, line: string): string {
  return [approval.title, approval.question, line].filter(Boolean).join('\n\n');
}
