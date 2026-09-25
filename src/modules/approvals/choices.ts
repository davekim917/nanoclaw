/**
 * Choice cards — approvals whose buttons are the requester's own options.
 *
 * A module that wants an answer rather than an approve/reject decision calls
 * requestApproval with custom `options` and registers a handler here under the
 * same action. The response handler then routes the row through this file:
 *
 *   - Authority is never thread membership: isAuthorizedApprovalClick skips its
 *     any-thread-member shortcut for these, requires owner/admin privilege on
 *     the agent group, and a card may narrow that further to named approvers
 *     (choiceClickAllowed).
 *   - The bridge does not edit an answer card on click (src/answer-cards.ts).
 *     The host edits it here, and only after the first authorized click has won
 *     the pending→approved compare-and-swap AND its answer was delivered. So a
 *     refused click, an unknown option and a losing click all leave the card
 *     exactly as it was, still live, with nothing to repair.
 *   - A click whose answer cannot be delivered is not consumed: the row goes
 *     back to pending and the card stays live.
 *   - retireChoice closes an open card without an answer (superseded).
 *
 * A leaf file like finalize.ts, so primitive.ts and response-handler.ts carry
 * only the seams. Keyed by action like the approval registry, so the rules are
 * back in force as soon as the owning module re-registers after a host restart.
 */
import { registerAnswerCardAction } from '../../answer-cards.js';
import type { NormalizedOption } from '../../channels/ask-question.js';
import { recordChoiceReceipt } from '../../db/choice-receipts.js';
import {
  deletePendingApproval,
  getSession,
  transitionPendingApprovalStatus,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import type { PendingApproval, Session } from '../../types.js';
import { getUser } from '../permissions/db/users.js';
import { notifyApprovalResolved } from './primitive.js';
import { parseReleaseShipScope, releaseShipScopeJson } from './release-ship-scope.js';

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

/**
 * Deliver the answer. Resolve to the session that received it, or null when no
 * live session can take it. Throw only when the answer was NOT recorded: once
 * the row is written, a failed wake is not a failed delivery, because the sweep
 * wakes a session with due rows (sweep-scheduling, sweep-continuation).
 */
export type ChoiceHandler = (ctx: ChoiceHandlerContext) => Promise<Session | null>;

const choiceHandlers = new Map<string, ChoiceHandler>();

export function registerChoiceHandler(action: string, handler: ChoiceHandler): void {
  if (choiceHandlers.has(action)) {
    log.warn('Choice handler re-registered (overwriting)', { action });
  }
  choiceHandlers.set(action, handler);
  registerAnswerCardAction(action);
}

export function getChoiceHandler(action: string): ChoiceHandler | undefined {
  return choiceHandlers.get(action);
}

/**
 * Whether `userId` is among the card's named approvers. A card without
 * `approvers` (payload) names none, and the response handler's owner/admin
 * check is the whole rule. Narrowing only: that check still applies to a
 * listed user. A listed Slack id matches the clicker's same-workspace sibling
 * ids, the equivalence role checks use (equivalentSlackUserIds).
 */
export function choiceClickAllowed(approval: PendingApproval, userId: string): boolean {
  const approvers = payloadApprovers(approval);
  if (approvers === undefined) return true;
  const clicker = new Set(equivalentSlackUserIds(userId));
  return approvers.some((approver) => clicker.has(approver));
}

/**
 * Resolve an authorized click on a choice card. Any stored option is a
 * legitimate answer — there is no approve/reject vocabulary here — and the
 * first click wins: the pending→approved compare-and-swap
 * (transitionPendingApprovalStatus) lets exactly
 * one racing click through, and the row is deleted once the answer is
 * delivered, so a later click finds nothing.
 */
export async function resolveChoice(approval: PendingApproval, selectedOption: string, userId: string): Promise<void> {
  const handler = getChoiceHandler(approval.action);
  if (!handler) return;

  const option = storedOptions(approval).find((o) => o.value === selectedOption);
  if (!option) {
    // Untrusted transport input, not a decision. The card was not touched.
    log.warn('Ignoring choice response with an unknown option', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    return;
  }

  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved'))) {
    // The winner delivers and edits the card.
    log.info('Ignoring click on an already-resolved choice', { approvalId: approval.approval_id, userId });
    return;
  }
  // The authorization decision is the successful CAS, not an arbitrarily
  // delayed answer delivery or recorder write. Capture it before every await
  // below and pass it unchanged into the immutable receipt.
  const resolvedAt = new Date().toISOString();

  let deliveredTo: Session | null;
  try {
    deliveredTo = await handler({
      approval,
      requester: await liveSession(approval.session_id),
      value: option.value,
      label: option.label,
      userId,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the answer was not recorded (ChoiceHandler); keep the click unconsumed
  } catch (err) {
    log.error('Choice answer could not be delivered — card left open', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId,
      err,
    });
    await updatePendingApprovalStatus(approval.approval_id, 'pending');
    return;
  }

  if (!deliveredTo) {
    log.error('Choice answered but no live session can take it — card left open', {
      approvalId: approval.approval_id,
      action: approval.action,
      sessionId: approval.session_id,
      userId,
    });
    await updatePendingApprovalStatus(approval.approval_id, 'pending');
    return;
  }

  log.info('Choice resolved', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    sessionId: deliveredTo.id,
  });
  await writeChoiceReceipt(approval, deliveredTo, option, userId, resolvedAt);
  await deletePendingApproval(approval.approval_id);
  const name = (await getUser(userId))?.display_name || userId;
  await editChoiceCard(approval, cardText(approval, `✅ ${option.label} — ${name}`));
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

/** Same predicate as unwakeableReason in src/container-runner.ts. */
async function liveSession(sessionId: string | null): Promise<Session | undefined> {
  const session = sessionId ? await getSession(sessionId) : undefined;
  return session && session.status === 'active' && session.archived_at == null ? session : undefined;
}

/**
 * Write the durable receipt for a resolved choice (migration 077,
 * choice_receipts) — the external release policy's evidence that THIS card
 * resolved to THIS value, for THIS user, once the `pending_approvals` row
 * that carries all three is gone. Best-effort: a write failure here must not
 * unwind a delivery that already happened, so it is caught and logged, never
 * thrown — the click stays consumed and the card stays resolved either way.
 * A consumer that finds no receipt for a request id has to treat it as
 * unverified and fail closed on its own side; that's the tradeoff for never
 * reopening an answered card over a receipt-table hiccup.
 */
async function writeChoiceReceipt(
  approval: PendingApproval,
  deliveredTo: Session,
  option: NormalizedOption,
  userId: string,
  resolvedAt: string,
): Promise<void> {
  try {
    await recordChoiceReceipt({
      requestId: approval.request_id,
      approvalId: approval.approval_id,
      action: approval.action,
      agentGroupId: approval.agent_group_id,
      sessionId: deliveredTo.id,
      platformId: approval.platform_id,
      threadId: approval.thread_id,
      platformMessageId: approval.platform_message_id,
      value: option.value,
      label: option.label,
      clickerUserId: userId,
      releaseScopeJson: receiptReleaseScopeJson(approval),
      resolvedAt,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the answer is already delivered; a receipt-write failure must not reopen the card
  } catch (err) {
    log.error('Failed to write choice receipt — answer was still delivered', {
      approvalId: approval.approval_id,
      requestId: approval.request_id,
      err,
    });
  }
}

/** A corrupt pending payload can never manufacture externally trusted scope. */
function receiptReleaseScopeJson(approval: PendingApproval): string | null {
  try {
    const payload = JSON.parse(approval.payload) as { approvalScope?: unknown };
    const scope = parseReleaseShipScope(payload.approvalScope);
    return scope ? releaseShipScopeJson(scope) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupt payload is unscoped, never an authority grant
  } catch {
    return null;
  }
}

/**
 * Edit a choice card's message to `text`. The editCardResolution pattern
 * in onecli-approvals.ts: dispatch through `instance ?? channel_type`,
 * because dispatch is exact-key, and fail loudly — the row is gone by now, so
 * a swallowed failure leaves live-looking buttons that do nothing.
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

function payloadApprovers(approval: PendingApproval): string[] | undefined {
  try {
    const approvers = (JSON.parse(approval.payload) as { approvers?: unknown }).approvers;
    return Array.isArray(approvers) ? approvers.filter((a): a is string => typeof a === 'string') : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload names no approvers; the admin check still applies
  } catch {
    return undefined;
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
