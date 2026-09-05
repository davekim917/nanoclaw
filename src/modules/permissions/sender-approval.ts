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
 *
 * This file also carries the `decline_notify` continuation: no card, no
 * buttons — a polite in-DM decline plus a one-line owner FYI, deduped per
 * (sender, messaging group) per 24h via a persisted decline stamp that reuses
 * this table's UNIQUE key. See declineAndNotify at the bottom.
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { completeDeferredInbound } from '../../router.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { AGENT_ACCESS_SCOPE_WARNING } from './channel-approval.js';
import {
  clearDeclineStamp,
  createPendingSenderApproval,
  getDeclineStampAt,
  getInFlightSenderApproval,
  isDeclineStampId,
  upsertDeclineStamp,
} from './db/pending-sender-approvals.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from './db/user-roles.js';
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

  // A stale decline stamp (this messaging group was decline_notify before
  // flipping back to request_approval) occupies the
  // UNIQUE(messaging_group_id, sender_identity) key this flow needs — clear
  // it so the in-flight check and the row insert see a clean slate.
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

// ── Decline-and-notify (unknown_sender_policy = 'decline_notify') ──

/** At most one decline + one FYI per (sender, messaging group) per this window. */
export const DECLINE_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Stamp key for a sender the resolver couldn't identify — the messaging
 *  group (a 1:1 DM) still keys the pair, so dedupe holds. */
const UNKNOWN_SENDER_KEY = 'unknown';

/**
 * OWNERS-FIRST candidate order for the FYI — the reverse of pickApprover.
 *
 * The FYI is a personal notice ("someone DMed YOUR agent"), not a decision
 * anyone can act on, so routing it to a group admin tells the wrong person.
 * pickApprover deliberately puts scoped admins first because a card needs
 * whoever can decide it; this notification needs whoever owns the agent.
 * Same reasoning, and the same live failure, as the escalation module's
 * escalationApprovers (src/modules/escalation/index.ts): the card landed in
 * a teammate's DM while the owner saw nothing. Admins stay on as
 * reachability fallback.
 */
async function fyiRecipients(agentGroupId: string | null): Promise<string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  for (const r of await getOwners()) add(r.user_id);
  for (const r of await getGlobalAdmins()) add(r.user_id);
  if (agentGroupId) {
    for (const r of await getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  return ordered;
}

/** A usable display name, or null — an empty string is not a name. */
function nonEmpty(name: string | null | undefined): string | null {
  return name && name.length > 0 ? name : null;
}

/**
 * First owner with a display_name, for the decline copy. Used only when the
 * FYI recipient is not itself an owner we can name — see declineAndNotify.
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
   * Override the dedupe key when the decline is scoped to the conversation
   * rather than to one sender — e.g. a channel module declining every
   * unauthorized invitation into the same conversation with one message.
   * Callers that pass this own both halves: `requestSenderApproval` only
   * clears a stamp keyed on the sender identity.
   */
  dedupeKey?: string;
  /**
   * Thread address to send the decline on — the wiring's policy-resolved
   * reply thread, NOT the raw `event.threadId`. The access gate gets this
   * from router fanout (`resolveThreadPolicy`), so a wiring that collapses
   * DM sub-threads to the root has its declines collapsed too. Omitted by
   * callers outside the fanout loop (channel modules), which fall back to
   * the event's own thread.
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

  // Dedupe: at most one decline + FYI per (sender, messaging group) per 24h,
  // or per (conversation) when the caller supplies its own key.
  const senderKey = input.dedupeKey ?? senderIdentity ?? UNKNOWN_SENDER_KEY;
  const stampedAt = await getDeclineStampAt(messagingGroupId, senderKey);
  if (stampedAt && Date.now() - new Date(stampedAt).getTime() < DECLINE_NOTIFY_DEDUPE_MS) {
    log.debug('decline_notify deduped — declined within the last 24h', { messagingGroupId, senderIdentity });
    return;
  }

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
    // Converting a pending CARD into a stamp destroys the retained event, and
    // that event is the only thing that can resolve its ingress receipt. The
    // first message left the receipt `deferred` (a card was pending); if we
    // overwrite without closing it, the receipt stays falsely deferred until
    // the 7-day prune with nothing left to resolve it. Close it first, and
    // only for a real card row — a stamp being refreshed has no receipt of
    // its own, and its body is the sentinel, not an event.
    const existing = await getInFlightSenderApproval(messagingGroupId, senderKey);
    if (existing && !isDeclineStampId(existing.id)) {
      try {
        completeDeferredInbound(JSON.parse(existing.original_message) as InboundEvent);
      } catch (err) {
        log.debug('decline_notify: converted card had no resolvable deferred receipt', {
          messagingGroupId,
          approvalId: existing.id,
          err,
        });
      }
    }
    await upsertDeclineStamp({
      messaging_group_id: messagingGroupId,
      agent_group_id: stampAgentGroupId,
      sender_identity: senderKey,
    });
  } else {
    log.debug('decline_notify stamp skipped — no agent groups exist', { messagingGroupId });
  }

  const originMg = getMessagingGroup(messagingGroupId);

  // (a) Polite decline in the sender's DM, as the bot. Instance-addressed so
  // a per-agent bot identity registered as its own adapter instance answers
  // as itself.
  //
  // Threaded on the originating message, not hard-null: this is a reply TO
  // the stranger, so it belongs where they wrote. Slack DMs make that load
  // bearing — the bridge turns each root DM message into its own thread
  // (chat-sdk-bridge.ts, the DM auto-threading block) and dm.threads is on
  // by default (slack.ts SLACK_DEFAULTS), so a null here posts the decline
  // at the channel root, detached from the message it answers. Adapters
  // without DM threading (Telegram et al.) carry a null threadId on the
  // event anyway, so this is a no-op there.
  //
  // `input.threadId` is the wiring's policy-resolved address, so a wiring
  // with threads off collapses the decline to the root exactly like the
  // agent's own replies. It is only absent for callers outside router
  // fanout, which have no wiring to honor and fall back to the event.
  const declineThreadId = input.threadId !== undefined ? input.threadId : (event.threadId ?? null);

  // Resolve the FYI recipient BEFORE composing the decline. `ownerDisplayName`
  // picks the first owner carrying a name with no regard for reachability,
  // while `pickApprovalDelivery` picks the first owner reachable on the origin
  // channel. On an install with several owners those are different people, so
  // composing first told the stranger they had reached one owner's agent while
  // a different owner got the notice — the wrong name disclosed to someone we
  // are in the middle of refusing.
  const approvers = await fyiRecipients(agentGroupId);
  const target =
    approvers.length > 0
      ? // Same-channel-type only: the FYI names a sender identity originating
        // in THIS workspace, so it must not fall back to a different surface
        // where the same owner happens to be registered (cross-tenant audit
        // 2026-05-03).
        //
        // `instance` so a cold DM row is created on the origin's adapter
        // instance. The FYI below dispatches on the row's exact instance key,
        // and a row stamped with the bare channel type resolves no adapter on
        // an install whose bots are all named instances — the owner would
        // silently miss the notice while the 24h stamp suppressed a retry.
        await pickApprovalDelivery(approvers, event.channelType, {
          sameChannelTypeOnly: true,
          instance: originMg?.instance ?? event.instance,
        })
      : null;

  // Name the recipient only when they are an owner. `fyiRecipients` falls back
  // to admins for reachability, and an admin is not whose personal agent this
  // is — in that case the honest name is still an owner's, even an unreachable
  // one.
  //
  // An owner recipient with no display_name gets the generic label, NOT
  // another owner's name: falling through to `ownerDisplayName()` there would
  // reintroduce exactly the mismatch this ordering exists to prevent, telling
  // the stranger they reached one owner while a different one is notified.
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

  // (b) Owner FYI — owners first (see fyiRecipients). Recipient was resolved
  // above so the decline could name them; the decline still goes out when
  // nobody is reachable, only the notice is skipped.
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
  // The FYI must not claim a decline that a platform error swallowed —
  // otherwise a transient failure leaves the stranger on silence while the
  // owner believes they were answered.
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
      // Exact-key dispatch: on an install whose bots are all named
      // instances there is nothing registered under the bare channel_type,
      // so an omitted instance either sends as the wrong sibling bot or
      // resolves no adapter at all.
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
