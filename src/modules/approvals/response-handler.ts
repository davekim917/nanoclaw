/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler, pickApprover } from './primitive.js';

/**
 * Detect whether this approval was delivered into the session's own thread/
 * channel (deliveryTarget='thread') vs DM'd to an admin (deliveryTarget='admin').
 * Compares the approval row's stored destination against the session's
 * messaging group. Thread-target cards live in the originating chat, where
 * thread access IS the approval authority — see primitive.ts. Admin-target
 * cards require clicker-identity verification against pickApprover.
 */
function isThreadDelivery(approval: PendingApproval, session: Session): boolean {
  if (!session.messaging_group_id) return false;
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) return false;
  return approval.channel_type === mg.channel_type && approval.platform_id === mg.platform_id;
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first.
  if (resolveOneCLIApproval(payload.questionId, payload.value, payload.userId ?? '')) {
    return true;
  }

  // DB-backed pending_approvals.
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

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

  // SECURITY (cross-tenant audit 2026-05-03): for admin-target cards, verify
  // the clicker is in pickApprover's set. The card is DM'd to a specific
  // admin so practically only they see it, but defense-in-depth: reject any
  // click from outside the approver set (handles DM cache poisoning,
  // unintended forwards, multi-admin compromise where one admin's session
  // is stolen). For thread-target cards, thread access IS the approval
  // authority — see primitive.ts comment block.
  if (!isThreadDelivery(approval, session)) {
    const approvers = pickApprover(session.agent_group_id);
    if (userId && !approvers.includes(userId)) {
      log.warn('Approval click rejected: clicker not in approver set', {
        approvalId: approval.approval_id,
        action: approval.action,
        userId,
        approvers,
      });
      await notify(`Your ${approval.action} click was rejected — clicker is not an authorized approver.`);
      // Don't delete the row; let it expire or another approver retry.
      return;
    }
  }

  if (selectedOption !== 'approve') {
    await notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    await notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    await notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
