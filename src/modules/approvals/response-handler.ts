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
import type { PendingApproval, Session } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { choiceClickAllowed, getChoiceHandler, resolveChoice } from './choices.js';
import { finalizeReject, writeApprovalNote } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import {
  editApprovalCardResolution,
  getApprovalHandler,
  notifyApprovalResolved,
  REJECT_WITH_REASON_VALUE,
} from './primitive.js';
import { armReasonCapture } from './reason-capture.js';

/** Thread-target cards live in the originating chat, where thread access IS the approval authority. */
async function isThreadDelivery(approval: PendingApproval, session: Session): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return false;
  return approval.channel_type === mg.channel_type && approval.platform_id === mg.platform_id;
}

/**
 * The clicked message must be the card the host posted. With no stored id a
 * choice card refuses (its id is backfilled just after delivery); any other
 * kind resolves.
 */
function isClickOnApprovalCard(approval: PendingApproval, payload: ResponsePayload): boolean {
  if (!approval.platform_message_id) return !getChoiceHandler(approval.action);
  return payload.messageId === approval.platform_message_id;
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = await getPendingApproval(payload.questionId);
  if (!approval) return false;

  // Every approval resolves only from its own card: an agent can post a raw
  // ask_question card carrying the same approval id. Claimed, so no later
  // handler takes the id either.
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

  // Ahead of isAuthorizedApprovalClick: the OneCLI resolver enforces its own
  // approver-set auth and claims every onecli_credential row.
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
    // Unreachable today; guards the module-approval path below, which would
    // delete a still-clickable credential row.
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
 * `ncl approvals approve|reject`: the same resolution as an authorized click.
 * Callers MUST have rejected agent-originated requests: an agent must never
 * resolve an approval, least of all its own.
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

  // Unknown values are untrusted transport input: the approval stays pending.
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
  const notify = (text: string): Promise<void> => writeApprovalNote(session, text);

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

  // The bridge edits no approval card on click; the card shows live buttons until this lands.
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

  // Any thread member may resolve a thread-delivered card. Choice cards never
  // take this shortcut: an answer is a decision the agent acts on.
  if (approval.session_id && !getChoiceHandler(approval.action)) {
    const session = await getSession(approval.session_id);
    if (session && (await isThreadDelivery(approval, session))) return true;
  }

  if (getChoiceHandler(approval.action) && !choiceClickAllowed(approval, userId)) return false;

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? (await getSession(approval.session_id))?.agent_group_id : null);

  if (!agentGroupId) {
    return withCentralSync(() => isOwner(userId) || isGlobalAdmin(userId), 'approval click authority');
  }

  return withCentralSync(() => hasAdminPrivilege(userId, agentGroupId), 'approval click authority');
}
