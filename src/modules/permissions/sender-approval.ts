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
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { centralTransaction } from '../../db/central-lease.js';
import { completeDeferredInbound } from '../../router.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover, pickOwnersFirst } from '../approvals/primitive.js';
import { AGENT_ACCESS_SCOPE_WARNING, isSameInboundEvent } from './channel-approval.js';
import {
  claimDeclineStamp,
  clearDeclineStamp,
  createPendingSenderApproval,
  getInFlightSenderApproval,
  isDeclineStampId,
} from './db/pending-sender-approvals.js';
import { getOwners } from './db/user-roles.js';
import { getUser } from './db/users.js';

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

/** True only when this exact event is the one retained for later replay. */
export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<boolean> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // A stale decline stamp occupies the UNIQUE key this flow needs; clear it.
  await clearDeclineStamp(messagingGroupId, senderIdentity);

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending. A replay of the retained event
  // stays deferred; a later, different message is intentionally dropped.
  const existing = await getInFlightSenderApproval(messagingGroupId, senderIdentity);
  if (existing) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return isSameInboundEvent(existing.original_message, event);
  }

  const approvers = await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return false;
  }

  const originMg = await getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  // Same-channel-type only: the card carries this workspace's user-originated
  // identity and message body. `instance` stamps a cold DM row with the origin's
  // adapter instance.
  const target = await pickApprovalDelivery(approvers, originChannelType, {
    sameChannelTypeOnly: true,
    instance: originMg?.instance ?? event.instance,
  });
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
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. ${AGENT_ACCESS_SCOPE_WARNING} Allow?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  const created = await createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: new Date().toISOString(),
    title,
    question,
    options_json: JSON.stringify(options),
  });
  if (!created) {
    const raced = await getInFlightSenderApproval(messagingGroupId, senderIdentity);
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
    // Instance-addressed: the exact adapter instance the DM was resolved on.
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
      undefined,
      target.messagingGroup.instance,
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

// ── Decline-and-notify (unknown_sender_policy = 'decline_notify') ──

/** At most one decline + one FYI per (sender, messaging group) per this window. */
const DECLINE_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Stamp key for a sender the resolver couldn't identify — the messaging
 *  group (a 1:1 DM) still keys the pair, so dedupe holds. */
const UNKNOWN_SENDER_KEY = 'unknown';

/**
 * OWNERS-FIRST candidate order for the FYI: it is a personal notice, not a
 * decision, so it needs whoever owns the agent. Admins are a reachability fallback.
 */
function fyiRecipients(agentGroupId: string | null): Promise<string[]> {
  return pickOwnersFirst(agentGroupId);
}

function nonEmpty(name: string | null | undefined): string | null {
  return name && name.length > 0 ? name : null;
}

/**
 * First owner with a display_name, for the decline copy when the FYI recipient
 * is not an owner we can name.
 */
async function ownerDisplayName(): Promise<string | null> {
  for (const owner of await getOwners()) {
    const name = (await getUser(owner.user_id))?.display_name;
    if (name && name.length > 0) return name;
  }
  return null;
}

export interface DeclineAndNotifyInput {
  messagingGroupId: string;
  /** Approver-resolution anchor; null falls back to global admins/owners. */
  agentGroupId: string | null;
  senderIdentity: string | null; // namespaced user id, when resolvable
  senderName: string | null;
  event: InboundEvent;
  /**
   * Dedupe per conversation instead of per sender. Callers that pass this own
   * clearing it: `requestSenderApproval` only clears a sender-keyed stamp.
   */
  dedupeKey?: string;
  /**
   * The wiring's policy-resolved reply thread, NOT the raw `event.threadId`.
   * Omitted outside router fanout, falling back to the event's own thread.
   */
  threadId?: string | null;
  /** Override the sender-facing decline copy. */
  declineText?: string;
  /** Override the owner-facing FYI copy. */
  fyiText?: string;
}

/**
 * The decline_notify continuation: (a) a short polite decline sent as the
 * bot into the sender's DM, (b) a one-line informational FYI to the owner's
 * DM — plain text, NOT an approval card, no buttons. Grants stay explicit
 * (`ncl members add`). Callers record the dropped message; dedupe is
 * self-contained here — a persisted decline stamp (pending_sender_approvals
 * shape) suppresses repeats for 24h.
 */
export async function declineAndNotify(input: DeclineAndNotifyInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  const senderKey = input.dedupeKey ?? senderIdentity ?? UNKNOWN_SENDER_KEY;

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('decline_notify skipped — no delivery adapter is wired', { messagingGroupId });
    return;
  }

  // Persist the stamp before sending: a delivery hiccup must not turn into a
  // decline storm on the sender's next message. FK needs a real agent group —
  // fall back to the first one (same reference-group pattern as the channel
  // card flow); with zero agent groups the stamp is skipped (no dedupe, rare
  // bootstrap state) but the decline still goes out.
  const stampAgentGroupId = agentGroupId ?? (await getAllAgentGroups())[0]?.id;
  if (stampAgentGroupId) {
    // Converting a pending CARD into a stamp destroys the only event that can
    // resolve its deferred ingress receipt, so read it first and close it only for
    // a real card and only if we win. The read and `claimDeclineStamp` (the
    // dedupe decision and the stamp in one statement) share one BEGIN IMMEDIATE
    // transaction, or a card inserted between them would never be closed.
    const { existing, claimed } = await centralTransaction(async () => {
      const before = await getInFlightSenderApproval(messagingGroupId, senderKey);
      const won = await claimDeclineStamp(
        {
          messaging_group_id: messagingGroupId,
          agent_group_id: stampAgentGroupId,
          sender_identity: senderKey,
        },
        new Date(Date.now() - DECLINE_NOTIFY_DEDUPE_MS).toISOString(),
      );
      return { existing: before, claimed: won };
    }, 'decline_notify stamp claim');
    if (!claimed) {
      log.debug('decline_notify deduped — declined within the last 24h', { messagingGroupId, senderIdentity });
      return;
    }

    if (existing && !isDeclineStampId(existing.id)) {
      try {
        await completeDeferredInbound(JSON.parse(existing.original_message) as InboundEvent);
      } catch (err) {
        log.debug('decline_notify: converted card had no resolvable deferred receipt', {
          messagingGroupId,
          approvalId: existing.id,
          err,
        });
      }
    }
  } else {
    // No agent group, no stamp: the decline still goes out, undeduped.
    log.debug('decline_notify stamp skipped — no agent groups exist', { messagingGroupId });
  }

  const originMg = await getMessagingGroup(messagingGroupId);

  // (a) Polite decline in the sender's DM, as the bot. Instance-addressed so
  // a per-agent bot identity registered as its own adapter instance answers
  // as itself. Threaded on the originating message: Slack auto-threads each root
  // DM, so a null thread would detach the decline. `input.threadId` is the
  // wiring's resolved address; the event's thread is the fallback.
  const declineThreadId = input.threadId !== undefined ? input.threadId : (event.threadId ?? null);

  // Resolve the FYI recipient BEFORE composing the decline: with several
  // owners, the name told to the stranger must be the owner actually notified.
  const approvers = await fyiRecipients(agentGroupId);
  const target =
    approvers.length > 0
      ? // Same-channel-type only: the FYI names a sender identity originating
        // in THIS workspace, so it must not fall back to a different surface.
        // `instance`: the FYI dispatches on the row's exact instance key.
        await pickApprovalDelivery(approvers, event.channelType, {
          sameChannelTypeOnly: true,
          instance: originMg?.instance ?? event.instance,
        })
      : null;

  // Name the recipient only when they are an owner (admins are a reachability
  // fallback). An unnamed owner recipient gets the generic label, never another
  // owner's name.
  const ownerIds = new Set((await getOwners()).map((r) => r.user_id));
  const targetIsOwner = target !== null && ownerIds.has(target.userId);
  const namedOwner = targetIsOwner ? nonEmpty((await getUser(target.userId))?.display_name) : await ownerDisplayName();
  const declineText =
    input.declineText ?? `I'm ${namedOwner ?? 'my owner'}'s personal agent — I can't help you directly.`;
  let declined = true;
  try {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      declineThreadId,
      'chat-sdk',
      JSON.stringify({ text: declineText }),
      undefined,
      originMg?.instance ?? event.instance,
    );
  } catch (err) {
    declined = false;
    log.warn('decline_notify: decline delivery failed', { messagingGroupId, err });
  }

  // (b) Owner FYI. The decline still goes out when nobody is reachable.
  if (approvers.length === 0) {
    log.warn('decline_notify FYI skipped — no owner or admin configured', { messagingGroupId, senderIdentity });
    return;
  }
  if (!target) {
    log.warn('decline_notify FYI skipped — no in-workspace approver reachable on the origin channel_type', {
      messagingGroupId,
      senderIdentity,
    });
    return;
  }

  const senderDisplay = senderName && senderName.length > 0 ? senderName : (senderIdentity ?? 'An unknown sender');
  const who =
    senderIdentity && senderDisplay !== senderIdentity ? `${senderDisplay} (${senderIdentity})` : senderDisplay;
  const outcome = declined
    ? 'I sent a polite decline'
    : "I couldn't deliver the decline, so they've had no reply (see the host log)";
  const fyiText =
    input.fyiText ??
    `FYI: ${who} DMed your agent on ${event.channelType} — ${outcome}. Allow them any time with \`ncl members add\`.`;
  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: fyiText }),
      undefined,
      // Exact-key dispatch: a bare channel_type sends as the wrong bot or none.
      target.messagingGroup.instance,
    );
    log.info(
      declined
        ? 'decline_notify handled — decline sent, owner notified'
        : 'decline_notify — owner notified, but the decline itself failed to deliver',
      {
        messagingGroupId,
        senderIdentity,
        notified: target.userId,
      },
    );
  } catch (err) {
    log.error('decline_notify: owner FYI delivery failed', { messagingGroupId, err });
  }
}
