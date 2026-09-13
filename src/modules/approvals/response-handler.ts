/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on plain reject we relay a decline to the agent; on
 *      "Reject with reason…" we hold the row and capture the admin's next DM as
 *      a one-line reason (see reason-capture.ts). Reject finalization is shared
 *      via finalizeReject.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      row-keyed, so the card stays clickable across a host restart — see
 *      onecli-approvals.ts.
 *   3. Choice cards (`registerChoiceHandler`, choices.ts) — the card carries
 *      the requester's own buttons; any stored option is an answer.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { withCentralSync } from '../../db/central-lease.js';
import { requestWake } from '../../request-wake.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { choiceClickAllowed, getChoiceHandler, resolveChoice } from './choices.js';
import { finalizeReject } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import {
  editApprovalCardResolution,
  getApprovalHandler,
  notifyApprovalResolved,
  REJECT_WITH_REASON_VALUE,
} from './primitive.js';
import { armReasonCapture } from './reason-capture.js';

/**
 * Detect whether this approval was delivered into the session's own thread/
 * channel (deliveryTarget='thread') vs DM'd to an admin (deliveryTarget='admin').
 * Compares the approval row's stored destination against the session's
 * messaging group. Thread-target cards live in the originating chat, where
 * thread access IS the approval authority — see primitive.ts. Admin-target
 * cards require clicker-identity verification (isAuthorizedApprovalClick).
 */
async function isThreadDelivery(approval: PendingApproval, session: Session): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return false;
  return approval.channel_type === mg.channel_type && approval.platform_id === mg.platform_id;
}

/**
 * Whether a click was made on this approval's own card: the clicked message
 * must be the one the host posted, whose id is stored from deliver's return
 * (primitive.ts:463-465, onecli-approvals.ts:424). Without a stored id there
 * is nothing to match. A choice card then refuses, because its id is
 * backfilled just after delivery; any other kind resolves as it did before,
 * for a row stored without one (primitive.ts:463 skips a deliver that
 * returned no id).
 */
function isClickOnApprovalCard(approval: PendingApproval, payload: ResponsePayload): boolean {
  if (!approval.platform_message_id) return !getChoiceHandler(approval.action);
  return payload.messageId === approval.platform_message_id;
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = await getPendingApproval(payload.questionId);
  if (!approval) return false;

  // Every kind of approval, OneCLI and choice cards included, resolves only
  // from its own card. The button names just the approval id, and an agent
  // that writes a raw ask_question row can post a card of its own carrying
  // that id, and a click on it decodes through the approval's own options
  // (src/db/sessions.ts:819-824), so it reads as a real answer. Claimed, so
  // no later handler takes the id either.
  if (!isClickOnApprovalCard(approval, payload)) {
    log.warn('Ignoring a click that was not made on the approval card', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
      clickedMessageId: payload.messageId ?? null,
      cardMessageId: approval.platform_message_id,
    });
    return true;
  }

  // OneCLI credential approvals — row-keyed resolution first. The 3-arg
  // resolver looks the row up itself and enforces its own cross-tenant
  // approver-set auth (onecli-approvals.ts), so this runs ahead of
  // isAuthorizedApprovalClick and claims every onecli_credential row.
  if (await resolveOneCLIApproval(payload.questionId, payload.value, namespacedUserId(payload) ?? '')) {
    return true;
  }

  if (!(await isAuthorizedApprovalClick(approval, payload))) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return true;
  }

  if (approval.action === ONECLI_ACTION) {
    // Unreachable in practice: resolveOneCLIApproval above claims every
    // onecli_credential row it can find, and this branch is only reached when
    // getPendingApproval found one. Kept as a guard so a future refactor can't
    // route a credential row into the module-approval path below — that path
    // deletes the row, which would silently kill a card that is still
    // clickable and still has a held request behind it.
    log.warn('OneCLI approval row reached the module-approval path — ignoring', {
      approvalId: approval.approval_id,
    });
    return true;
  }

  if (getChoiceHandler(approval.action)) {
    await resolveChoice(approval, payload.value, namespacedUserId(payload) ?? '');
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, namespacedUserId(payload) ?? '');
  return true;
}

/**
 * Host-operator resolution path — `ncl approvals approve|reject`. Runs the
 * exact same resolution as an authorized card click. Exists because DM
 * delivery is best-effort (a card can land with an admin who isn't the right
 * decider, or a platform hiccup can eat it): the operator terminal must
 * always be able to resolve a pending approval. Callers MUST have rejected
 * agent-originated requests before calling — an agent must never resolve an
 * approval, least of all its own.
 */
export async function resolveApprovalFromHost(
  approvalId: string,
  decision: 'approve' | 'reject',
  userId: string,
): Promise<{ resolved: boolean; error?: string }> {
  const approval = await getPendingApproval(approvalId);
  if (!approval) return { resolved: false, error: `No pending approval ${approvalId}` };
  if (approval.action === ONECLI_ACTION) {
    return {
      resolved: false,
      error: 'OneCLI credential approvals resolve through the gateway flow, not the CLI.',
    };
  }
  if (getChoiceHandler(approval.action)) {
    return { resolved: false, error: 'Choice cards resolve by clicking one of their options, not approve/reject.' };
  }
  await handleRegisteredApproval(approval, decision, userId);
  return { resolved: true };
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    await deletePendingApproval(approval.approval_id);
    return;
  }
  const session = await getSession(approval.session_id);
  if (!session) {
    await deletePendingApproval(approval.approval_id);
    return;
  }

  // "Reject with reason…" — hold the row and capture the admin's next DM
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    await armReasonCapture(approval, session, userId);
    return;
  }

  // Plain Reject — instant fast path. Unknown values are untrusted transport
  // input, not a user decision: keep the approval pending instead of turning
  // a malformed callback into a rejection.
  if (selectedOption === 'reject') {
    await finalizeReject(approval, session, userId);
    return;
  }

  if (selectedOption !== 'approve') {
    log.warn('Ignoring approval response with an unknown option', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const notify = async (text: string): Promise<void> => {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    await notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    await editApprovalCardResolution(approval, selectedOption, userId);
    await deletePendingApproval(approval.approval_id);
    await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
    await requestWake(session, 'approval-response');
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, approval, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    await notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  // The bridge edits no approval card on click, so the card still shows live
  // buttons until this lands (primitive.ts editApprovalCardResolution).
  await editApprovalCardResolution(approval, selectedOption, userId);
  await deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
  await requestWake(session, 'approval-response');
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

async function isAuthorizedApprovalClick(approval: PendingApproval, payload: ResponsePayload): Promise<boolean> {
  const userId = namespacedUserId(payload);
  if (!userId) return false;

  // An approval may name a specific approver; only that exact user may resolve it.
  if (approval.approver_user_id) {
    return userId === approval.approver_user_id;
  }

  // Thread-delivered cards (deliveryTarget='thread', e.g. bash/email gates)
  // post into the originating conversation, where thread access IS the
  // approval authority — any thread member may resolve. See primitive.ts.
  // Choice cards never take this shortcut: an answer is a decision the agent
  // acts on, so it needs admin privilege exactly like an admin-DM card.
  if (approval.session_id && !getChoiceHandler(approval.action)) {
    const session = await getSession(approval.session_id);
    if (session && (await isThreadDelivery(approval, session))) return true;
  }

  // A choice card may narrow who answers to named approvers (choices.ts).
  if (getChoiceHandler(approval.action) && !choiceClickAllowed(approval, userId)) return false;

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? (await getSession(approval.session_id))?.agent_group_id : null);

  if (!agentGroupId) {
    return withCentralSync(() => isOwner(userId) || isGlobalAdmin(userId), 'approval click authority');
  }

  return withCentralSync(() => hasAdminPrivilege(userId, agentGroupId), 'approval click authority');
}
