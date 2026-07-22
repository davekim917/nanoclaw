/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval` to:
 *
 *   1. Pick an eligible approver (owner / admin of the agent group).
 *   2. Open / reuse a DM to that approver on a reachable channel.
 *   3. Record a pending_sender_approvals row that holds the original message
 *      so it can be re-routed on approve.
 *   4. Deliver an Approve / Deny card.
 *
 * On approve: the handler in index.ts adds an agent_group_members row for
 * the sender and re-invokes routeInbound with the stored event — the second
 * routing attempt passes the gate because the user is now a member.
 *
 * Failure modes (logged + row NOT created, so the dedup gate lets a future
 * attempt try again):
 *   - No eligible approver in user_roles — fresh install, no owner yet.
 *   - Approver has no reachable DM (no user_dms row + channel can't
 *     openDM) — e.g. owner hasn't registered on any channel we're wired to.
 * Once the row exists, delivery failures leave it available for dashboard or
 * manual review; only failures before persistence return without a row.
 *
 * Dedup: `pending_sender_approvals` has UNIQUE(messaging_group_id,
 * sender_identity). A replay of the retained event remains deferred; a later
 * message from that sender is dropped without replacing it or sending another
 * card.
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingSenderApproval, getInFlightSenderApproval } from './db/pending-sender-approvals.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve', style: 'primary' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject', style: 'danger' },
];

function generateId(): string {
  return `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // namespaced user id (channel_type:handle)
  senderName: string | null;
  event: InboundEvent;
}

function isSameInboundEvent(raw: string, event: InboundEvent): boolean {
  try {
    const stored = JSON.parse(raw) as InboundEvent;
    return (
      stored.channelType === event.channelType &&
      (stored.instance ?? stored.channelType) === (event.instance ?? event.channelType) &&
      stored.platformId === event.platformId &&
      stored.message.id === event.message.id
    );
  } catch {
    return false;
  }
}

/** True only when this exact event is the one retained for later replay. */
export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<boolean> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending. A replay of the retained event
  // stays deferred; a later, different message is intentionally dropped.
  const existing = getInFlightSenderApproval(messagingGroupId, senderIdentity);
  if (existing) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return isSameInboundEvent(existing.original_message, event);
  }

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return false;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  // Same-channel-type only: the card contains the sender's user-originated
  // identity and (often) message body from this workspace — don't fall
  // back cross-workspace to a different surface where the same owner
  // happens to be registered. If nobody on this channel_type can be
  // notified, no row is created and a future message can try again.
  const target = await pickApprovalDelivery(approvers, originChannelType, { sameChannelTypeOnly: true });
  if (!target) {
    log.warn('Unknown-sender approval skipped — no in-workspace approver reachable on origin channel_type', {
      messagingGroupId,
      originChannelType,
      agentGroupId,
      senderIdentity,
    });
    return false;
  }

  const approvalId = generateId();
  const senderDisplay = senderName && senderName.length > 0 ? senderName : senderIdentity;
  const originName = originMg?.name ?? `a ${originChannelType} channel`;

  const title = '👤 New sender';
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. Allow?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  const created = createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });
  if (!created) {
    const raced = getInFlightSenderApproval(messagingGroupId, senderIdentity);
    return raced ? isSameInboundEvent(raced.original_message, event) : false;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    // Without a delivery adapter, the card can't be sent. Log + leave the
    // row in place so the admin can see it via DB or manual tooling; the
    // dedup gate will suppress further cards until it's cleared.
    log.error('Unknown-sender approval row created but no delivery adapter is wired', {
      approvalId,
    });
    return true;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options,
      }),
    );
    log.info('Unknown-sender approval card delivered', {
      approvalId,
      senderIdentity,
      approver: target.userId,
      messagingGroupId,
      agentGroupId,
    });
  } catch (err) {
    log.error('Unknown-sender approval card delivery failed', {
      approvalId,
      err,
    });
  }
  return true;
}

/**
 * Option value the admin clicked that means "allow" — shared with the
 * response handler so the two sides can't drift.
 */
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';
