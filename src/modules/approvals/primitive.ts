/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getSession, updatePendingApprovalMessageId } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** Two-button approval UI — the only options the primitive supports today. */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. Resolution uses ensureUserDm, which may
 * trigger a platform openDM call on cache miss.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
  /**
   * Where to deliver the approval card.
   *
   * - `'admin'` (default) — DM the first reachable admin from pickApprover.
   *   Use for bot-config / system-level actions that only admins should
   *   decide (self-mod package installs, MCP server changes, new-sender
   *   acceptance, credential releases).
   * - `'thread'` — post into the originating conversation (session's own
   *   messaging_group, threaded reply if the session has a thread_id).
   *   Use for work-level gates where the requesting teammate or anyone
   *   in the channel should be able to self-approve (bash/email gates,
   *   destructive-command gates). Response-handler.ts does NOT check
   *   clicker identity against pickApprover — thread access IS the
   *   approval authority for this target.
   */
  deliveryTarget?: 'thread' | 'admin';
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName, deliveryTarget = 'admin' } = opts;

  // Resolve delivery destination based on target policy.
  // thread: originating messaging_group + session's thread_id.
  // admin:  first reachable admin's DM (v1/v2 default behavior).
  let destination: { channelType: string; platformId: string; threadId: string | null; label: string };
  if (deliveryTarget === 'thread') {
    if (!session.messaging_group_id) {
      notifyAgent(session, `${action} failed: session has no originating channel to post approval in.`);
      return;
    }
    const mg = getMessagingGroup(session.messaging_group_id);
    if (!mg) {
      notifyAgent(session, `${action} failed: originating channel not found.`);
      return;
    }
    destination = {
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      threadId: session.thread_id,
      label: `thread ${mg.channel_type}/${mg.platform_id}${session.thread_id ? ':' + session.thread_id : ''}`,
    };
  } else {
    const approvers = pickApprover(session.agent_group_id);
    if (approvers.length === 0) {
      notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
      return;
    }
    const originChannelType = session.messaging_group_id
      ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) {
      notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
      return;
    }
    destination = {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      threadId: null,
      label: `admin DM ${target.userId}`,
    };
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    agent_group_id: session.agent_group_id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
    // Populate the routing columns so the host can edit the card later
    // — cancel-on-follow-up (bash-gate), timeout, or other resolutions
    // that fire after the click path. platform_message_id gets backfilled
    // from adapter.deliver's return value immediately below.
    channel_type: destination.channelType,
    platform_id: destination.platformId,
    thread_id: destination.threadId,
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      const platformMsgId = await adapter.deliver(
        destination.channelType,
        destination.platformId,
        destination.threadId,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
      if (platformMsgId) {
        updatePendingApprovalMessageId(approvalId, platformMsgId);
      }
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, target: destination.label, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${destination.label}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, target: destination.label, deliveryTarget });
}

/**
 * Edit an approval card in-place (e.g. to show "cancelled" or "timed out").
 * Looks up the card's platform routing from its pending_approvals row. If
 * the row is missing any of { channel_type, platform_id, platform_message_id }
 * we skip silently — those fields are only populated for cards dispatched
 * via the current `requestApproval` code path; legacy rows or cards that
 * failed to deliver won't have them.
 *
 * The `tid` passed to editMessage mirrors what was passed to deliver:
 * `threadId ?? platformId` (the Chat SDK bridge's convention — see
 * chat-sdk-bridge.ts `deliver`).
 */
export async function editApprovalCard(approval: PendingApproval, newBody: string): Promise<void> {
  if (!approval.channel_type || !approval.platform_id || !approval.platform_message_id) return;
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      approval.channel_type,
      approval.platform_id,
      approval.thread_id,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: approval.platform_message_id,
        text: newBody,
      }),
    );
  } catch (err) {
    log.warn('Failed to edit approval card', { approvalId: approval.approval_id, err });
  }
}
