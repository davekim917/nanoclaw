/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/decline_notify/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroup,
  setMessagingGroupDeniedAt,
  getMessagingGroupAgents,
} from '../../db/messaging-groups.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import {
  completeDeferredInbound,
  replayDeferredInbound,
  setAccessGate,
  setChannelRequestGate,
  registerMessageInterceptor,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { withCentralSync } from '../../db/central-lease.js';
import { guard } from '../../guard/index.js';
import { log } from '../../log.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { canAccessAgentGroup, isSiblingBotSender } from './access.js';
import {
  AGENT_ACCESS_SCOPE_WARNING,
  buildAgentSelectionOptions,
  CHOOSE_EXISTING_VALUE,
  CONNECT_PREFIX,
  createNewAgentGroup,
  NEW_AGENT_VALUE,
  REJECT_VALUE,
  requestChannelApproval,
} from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import {
  createPendingChannelApproval,
  deletePendingChannelApproval,
  getPendingChannelApproval,
  updatePendingChannelApprovalCard,
  type PendingChannelApproval,
} from './db/pending-channel-approvals.js';
import {
  createPendingSenderApproval,
  deletePendingSenderApproval,
  getPendingSenderApproval,
} from './db/pending-sender-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { getUser, upsertUser } from './db/users.js';
import './grant.js';
import { declineAndNotify, requestSenderApproval } from './sender-approval.js';
import { channelsRegister, sendersAdmit } from './guard.js';
import { ensureUserDm } from './user-dm.js';

// ── Free-text name input state ──
// Tracks approvers waiting for a text reply with the agent name. Keyed by
// namespaced userId (e.g. "slack:U0ABC"). Cleared on receipt or restart.
interface PendingNameInput {
  channelMgId: string;
  dmChannelType: string;
  dmPlatformId: string;
  // Named-instance approver DM: without this, a reply on the approver's
  // bare-channel-type conversation would be matched to a different
  // sibling bot's conversation carrying the same channelType/platformId.
  dmInstance?: string;
}
const awaitingNameInput = new Map<string, PendingNameInput>();

async function extractAndUpsertUser(event: InboundEvent): Promise<string | null> {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!(await getUser(userId))) {
    await upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

async function completeStoredDeferredInbound(raw: string): Promise<void> {
  try {
    await completeDeferredInbound(JSON.parse(raw) as InboundEvent);
  } catch {
    // Malformed legacy approval rows have no recoverable receipt key.
  }
}

async function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
  /** This wiring's policy-resolved reply thread — see AccessGateFn. */
  effectiveThreadId: string | null,
): Promise<boolean> {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  // The admission decision is the guard's senders.admit decision (./guard.ts)
  // — unknown_sender_policy verbatim: strict → deny, request_approval → hold,
  // decline_notify → deny, public → allow (short-circuited before the gate).
  // Drop-recording, the hold creation and the decline side effects stay here.
  // Under the central lease: `guard()`'s reads are raw by design (seam 3
  // §4.5 I-1).
  const decision = await withCentralSync(
    () =>
      guard(sendersAdmit, {
        actor: userId ? { kind: 'human', userId } : { kind: 'system' },
        payload: {
          messagingGroupId: mg.id,
          agentGroupId,
          senderIdentity: userId,
          policy: mg.unknown_sender_policy,
        },
      }),
    'senders.admit guard',
  );

  if (decision.effect === 'allow') return false; // public is handled before this gate.

  const isDeclineNotify = mg.unknown_sender_policy === 'decline_notify';

  log.info(
    isDeclineNotify
      ? 'MESSAGE DROPPED — unknown sender (decline-and-notify policy)'
      : decision.effect === 'hold'
        ? 'MESSAGE DROPPED — unknown sender (approval requested)'
        : 'MESSAGE DROPPED — unknown sender (strict policy)',
    {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    },
  );
  await recordDroppedMessage(dropRecord);

  // decline_notify: polite in-DM decline + one-line owner FYI, no card.
  // Fire-and-forget like the hold path — declineAndNotify dedupes itself
  // (24h stamp) and logs its own failures; the sender's message stays
  // dropped either way, so nothing is retained for replay.
  // Gated on the guard's own verdict, not on the policy string alone: the
  // guard (./guard.ts) is the decision seam, so a future policy change that
  // makes decline_notify hold must card, not decline behind the guard's back.
  if (decision.effect === 'deny' && isDeclineNotify) {
    // The decline copy assumes a 1:1 DM surface, so this needs POSITIVE
    // evidence of one — `mg.is_group !== 1` is not that. An adapter that
    // reports neither isDM nor isGroup (older chat-sdk plugin builds;
    // `adapterIsDM` returns undefined) gets is_group = 0 from the router's
    // auto-create default, so 0 can mean "uncertain", not "confirmed DM"
    // — the same reason the user_dms cache requires `event.isDM === true`
    // (src/router.ts, the 2a branch). Without the evidence the drop above
    // stands and nothing is sent: silence beats posting "I'm <owner>'s
    // personal agent" into a channel.
    const confirmedDm = mg.is_group !== 1 && (event.isDM === true || event.message.isGroup === false);
    if (!confirmedDm) {
      log.warn('decline_notify skipped — no confirmed 1:1 DM context (no public decline)', {
        messagingGroupId: mg.id,
        isGroupRow: mg.is_group,
      });
      return false;
    }
    void declineAndNotify({
      messagingGroupId: mg.id,
      agentGroupId,
      senderIdentity: userId,
      senderName,
      event,
      threadId: effectiveThreadId,
    }).catch((err) => log.error('decline_notify flow threw', { err }));
    return false;
  }

  // Persist the exact event only for a held sender with a stable identity.
  // A deny or identity-less hold remains an ordinary completed drop.
  if (decision.effect === 'hold' && userId) {
    return requestSenderApproval({
      messagingGroupId: mg.id,
      agentGroupId,
      senderIdentity: userId,
      senderName,
      event,
    }).catch((err) => {
      log.error('Sender-approval flow threw', { err });
      return false;
    });
  }
  return false;
}

setSenderResolver(extractAndUpsertUser);

// ── Sibling-bot allow-list ──
// Provider injected by the host once channel adapters are up (see
// `setSiblingBotIdsProvider` wiring in src/index.ts). Returns the set of
// platform user-ids belonging to NanoClaw's OWN bots in this process. The
// access gate consults it so sibling agents can engage each other even under a
// `strict` messaging group. Defaults to empty (fail-closed) until wired, and
// is read live at message time so it reflects the current adapter registries.
const EMPTY_BOT_IDS: ReadonlySet<string> = new Set();
let getSiblingBotIds: () => ReadonlySet<string> = () => EMPTY_BOT_IDS;
export function setSiblingBotIdsProvider(provider: () => ReadonlySet<string>): void {
  getSiblingBotIds = provider;
}

setAccessGate(async (event, userId, mg, agentGroupId, effectiveThreadId): Promise<AccessGateResult> => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    await handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event, effectiveThreadId);
    return {
      allowed: false,
      reason: 'unknown_user',
      replayPending: false,
    };
  }

  const decision = await canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  // Sibling agent bots are trusted peers, not strangers. A message authored by
  // one of our own bots is allowed past the strict / request_approval gate so
  // siblings can hand off to each other (the whole point of clone-as-codex /
  // -opencode). Unknown humans and third-party bots still fall through to the
  // drop / approval path below.
  if (isSiblingBotSender(userId, getSiblingBotIds())) {
    log.debug('ACCESS — sibling agent bot allowed past gate', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      policy: mg.unknown_sender_policy,
    });
    return { allowed: true };
  }

  const replayPending = await handleUnknownSender(mg, userId, agentGroupId, decision.reason, event, effectiveThreadId);
  return {
    allowed: false,
    reason: decision.reason,
    replayPending,
  };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  async (
    _event: InboundEvent,
    userId: string | null,
    _mg: MessagingGroup,
    agent: MessagingGroupAgent,
  ): Promise<AccessGateResult> => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = await canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = await getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  // payload.userId is the raw platform userId (e.g. "6037840640"); namespace it
  // with the channel type so it matches users(id) format. Some platforms
  // (e.g. Teams "29:xxx") already include a colon — mirror resolveOrCreateUser
  // logic and only prefix when the raw id has no colon.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null &&
    (clickerId === row.approver_user_id ||
      (await withCentralSync(() => hasAdminPrivilege(clickerId, row.agent_group_id), 'sender approval click')));
  if (!isAuthorized) {
    log.warn('Unknown-sender approval click rejected — unauthorized clicker', {
      approvalId: row.id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true; // claim the response so it's not unclaimed-logged, but do nothing
  }
  // The card is only actionable while the group still runs the flow that
  // issued it. `decline_notify` promises the opposite of a card — no buttons,
  // no approval path, grants stay explicit (`ncl members add`) — so a button
  // delivered before the flip must not still grant membership afterwards.
  //
  // Checked here rather than by deleting rows inside the policy update: the
  // click is the decision seam, so this holds no matter how the policy
  // changed (ncl, dashboard, auto-wire, a direct DB edit), and it covers the
  // window before the sender's next message converts the card into a stamp.
  // Only decline_notify voids the card. `strict` and `public` do not: neither
  // promises there is no approval path, so an admin approving an outstanding
  // card there is a legitimate explicit grant, and that behavior predates
  // this policy.
  const currentMg = await getMessagingGroup(row.messaging_group_id);
  const voidedByPolicyFlip = currentMg?.unknown_sender_policy === 'decline_notify';

  // ── Claim the card before acting on it (issue #443, Codex round 1) ──
  //
  // `getPendingSenderApproval` above is awaited, so it yields. Two callbacks
  // for the SAME card — an adapter retry, a double-click — can therefore both
  // find the row live, and every branch below ends in an effect that must not
  // happen twice: the approve branch replays the retained message
  // (`replayDeferredInbound`), which is a real second delivery to the agent,
  // and the deny and policy-flip branches each close out the deferred inbound.
  //
  // The DELETE is the arbiter rather than a lock: SQLite applies it once, so
  // exactly one caller sees `changes === 1`. The loser returns `true` — the
  // response IS claimed, by the winner, so reporting it unclaimed would be
  // wrong — and does nothing else.
  //
  // It also has to happen HERE, before the approve branch's `addMember`, and
  // that is the same ordering the pre-seam code already needed for a different
  // reason: the row must be gone before `replayDeferredInbound` runs, or the
  // second routing attempt sees an in-flight row and short-circuits.
  const claimed = await deletePendingSenderApproval(row.id);
  if (!claimed) {
    log.debug('Unknown-sender approval click ignored — another callback already resolved this card', {
      approvalId: row.id,
      clickerId,
    });
    return true;
  }

  // The card is only actionable while the group still runs the flow that
  // issued it — see the comment above the policy read.
  if (voidedByPolicyFlip) {
    log.warn('Unknown-sender approval click rejected — group switched to decline_notify', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      messagingGroupId: row.messaging_group_id,
      clickerId,
    });
    // Void the card the same way a deny does: the row (and with it the
    // retained message body) is already dropped by the claim above; close out
    // the deferred inbound so it does not sit unresolved.
    await completeStoredDeferredInbound(row.original_message);
    return true;
  }

  const approverId = clickerId;
  const approved = payload.value === 'approve';

  if (approved) {
    // The claim above already removed the row, and that row held the ONLY copy
    // of the retained inbound (`original_message`). If the member write fails
    // here, a plain rethrow would leave the sender approved-but-not-admitted
    // with nothing left to replay and no card to click again (issue #443,
    // Codex round 2).
    //
    // So the claim is made recoverable by putting the row back, rather than by
    // adding a `claimed_at` column — a column means a migration, and the row
    // object is already in hand, complete with its body and render metadata.
    // `createPendingSenderApproval` is INSERT OR IGNORE, so a concurrent flow
    // that re-created the card in the meantime wins and this is a no-op.
    try {
      await addMember({
        user_id: row.sender_identity,
        agent_group_id: row.agent_group_id,
        added_by: approverId,
        added_at: new Date().toISOString(),
      });
    } catch (err) {
      const restored = await createPendingSenderApproval(row);
      log.error('Unknown sender approval failed to add the member — card restored for retry', {
        approvalId: row.id,
        senderIdentity: row.sender_identity,
        agentGroupId: row.agent_group_id,
        restored,
        err,
      });
      return true;
    }
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await replayDeferredInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  await completeStoredDeferredInbound(row.original_message);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  return requestChannelApproval({ messagingGroupId: mg.id, event });
});

/**
 * Wire an approved channel to an agent group and replay the stored event.
 * Shared by both approve paths (connect-existing button, free-text new-agent
 * name reply) so they produce identical wirings. Returns true when the wiring
 * was created — callers must not confirm success to the approver otherwise.
 *
 * Engage defaults come from the channel's declared defaults (DM vs group
 * context). isGroup uses the adapter's own flag with the persisted row as
 * fallback — never `threadId !== null` (DM sub-threads exist on Slack/Discord;
 * non-threaded group platforms like WhatsApp have null threadIds in groups).
 */
async function wireApprovedChannel(
  row: PendingChannelApproval,
  agentGroupId: string,
  approverId: string,
): Promise<boolean> {
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await deletePendingChannelApproval(row.messaging_group_id);
    return false;
  }

  // Claim the card before any write. This is the terminal branch — it creates
  // the wiring, admits the sender and replays the retained message — and the
  // caller reached it across several awaits, so a duplicate callback can be
  // here too. Every individual effect below is already idempotent or
  // self-claiming (`insertOrAdopt` on the wiring, INSERT OR IGNORE on the
  // member, `replayDeferredInbound`'s own receipt claim), so the claim is the
  // belt rather than the only guard — but it means the log lines and the
  // approver's confirmation reflect one act, not two.
  if (!(await deletePendingChannelApproval(row.messaging_group_id))) {
    log.debug('Channel registration: another callback already wired this channel', {
      messagingGroupId: row.messaging_group_id,
    });
    return false;
  }

  const mg = await getMessagingGroup(row.messaging_group_id);
  const isGroup = event.message.isGroup ?? mg?.is_group === 1;
  const agentGroupName = (await getAgentGroup(agentGroupId))?.name ?? '';

  let engage: { engage_mode: MessagingGroupAgent['engage_mode']; engage_pattern: string | null };
  try {
    engage = resolveWiringDefaults(
      mg?.instance ?? mg?.channel_type ?? event.channelType,
      isGroup,
      agentGroupName,
      mg?.channel_type ?? event.channelType,
    );
  } catch (err) {
    // Mis-declared adapter (pattern mode without a pattern). Drop the pending
    // row so a future mention can retry once the declaration is fixed.
    log.error('Channel registration: channel defaults unresolvable', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await completeDeferredInbound(event);
    return false;
  }

  // Everything from here to the member write runs with the card already
  // claimed (deleted) and the retained inbound still deferred. A failure in
  // this stretch used to lose the retry path: no card, no wiring, a receipt
  // nothing would ever complete (fork issue #452, site 2). The claim stays a
  // DELETE — it is the arbiter between duplicate callbacks — so the recovery
  // is to put the full row BACK on failure: the next click (or the retained
  // inbound's own retry) finds the card exactly as it was.
  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await wireAndAdmit(row, agentGroupId, approverId, engage, mgaId, event);
  } catch (err) {
    const restored = await createPendingChannelApproval(row).catch((restoreErr: unknown) => {
      log.error('Channel registration: wiring failed AND the pending card could not be restored', {
        messagingGroupId: row.messaging_group_id,
        err,
        restoreErr,
      });
      return false;
    });
    log.error('Channel registration: wiring failed after the card was claimed — card restored for retry', {
      messagingGroupId: row.messaging_group_id,
      agentGroupId,
      restored,
      err,
    });
    throw err;
  }

  try {
    await replayDeferredInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
}

/** The central writes of an approved channel registration: wiring row + sender membership. */
async function wireAndAdmit(
  row: PendingChannelApproval,
  agentGroupId: string,
  approverId: string,
  engage: { engage_mode: MessagingGroupAgent['engage_mode']; engage_pattern: string | null },
  mgaId: string,
  event: InboundEvent,
): Promise<void> {
  const wiring: MessagingGroupAgent = {
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: agentGroupId,
    engage_mode: engage.engage_mode,
    engage_pattern: engage.engage_pattern,
    // Deliberate card-flow choices, not channel defaults: the triggering
    // sender is auto-admitted below, so 'known' keeps other strangers gated;
    // 'accumulate' / 'shared' / priority 0 are the flow's fixed semantics.
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    // Fork policy (134dc2dc): per-thread is the default session_mode across
    // all wiring origins.
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: new Date().toISOString(),
  };
  // Lookup-then-insert on the async driver: a concurrent route can win the
  // same wiring; adopt it instead of failing this message (seam 3 primitive).
  await insertOrAdopt(
    wiring,
    async (candidate) => {
      await createMessagingGroupAgent(candidate);
    },
    async () => (await getMessagingGroupAgents(row.messaging_group_id)).find((w) => w.agent_group_id === agentGroupId),
  );
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId,
    mgaId,
    engageMode: engage.engage_mode,
    approverId,
  });

  const senderUserId = await extractAndUpsertUser(event);
  if (senderUserId) {
    await addMember({
      user_id: senderUserId,
      agent_group_id: agentGroupId,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
  }
}

/**
 * Response handler for the unknown-channel registration card.
 *
 * Claim rule: questionId matches a pending_channel_approvals row (keyed
 * by messaging_group_id). If no such row, return false so downstream
 * handlers get a shot.
 *
 * Value dispatch:
 *   connect:<id>    — wire to an existing agent group, replay the message
 *   choose_existing — send a follow-up card listing all agents
 *   new_agent       — prompt for a free-text agent name (interceptor
 *                     captures the reply and creates immediately)
 *   reject          — set denied_at, delete pending row
 */
async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = await withCentralSync(() => getPendingChannelApproval(payload.questionId), 'pending approval read');
  if (!row) return false;

  // Origin conversation's adapter instance — threaded into ensureUserDm below
  // so the follow-up card / name prompt lands on the SAME sibling bot's DM
  // the registration card itself was delivered on, instead of falling back
  // to whichever adapter the bare channel_type happens to resolve.
  const originMg = await getMessagingGroup(row.messaging_group_id);

  // Click authorization is the guard's channels.register decision (./guard.ts):
  // the delivered approver, or an admin of the pending row's anchor agent group.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const decision = await withCentralSync(
    () =>
      guard(channelsRegister, {
        actor: { kind: 'human', userId: clickerId ?? '' },
        payload: { questionId: payload.questionId },
      }),
    'channels.register guard',
  );
  if (!clickerId || decision.effect !== 'allow') {
    log.warn('Channel registration click rejected — unauthorized clicker', {
      messagingGroupId: row.messaging_group_id,
      clickerId,
      expectedApprover: row.approver_user_id,
      reason: decision.reason,
    });
    return true;
  }
  const approverId = clickerId;

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    // Claim before acting, same rule as the sender card: this branch is
    // terminal, so a duplicate callback must not run it twice. The
    // intermediate branches below (choose_existing, new_agent) deliberately do
    // NOT claim — they leave the card live for a second click by design.
    if (!(await deletePendingChannelApproval(row.messaging_group_id))) return true;
    await setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
    await completeStoredDeferredInbound(row.original_message);
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return true;
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id, { instance: originMg?.instance });
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;

    const agentGroups = await getAllAgentGroups();
    const options = await buildAgentSelectionOptions(agentGroups, approverId);
    const title = '📋 Choose an agent';
    const question = `Which agent should handle this channel? ${AGENT_ACCESS_SCOPE_WARNING}`;
    await updatePendingChannelApprovalCard(row.messaging_group_id, title, question, JSON.stringify(options));

    try {
      // Instance-addressed: `approverDm.instance` is the exact adapter
      // instance `ensureUserDm` resolved this DM on above.
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: row.messaging_group_id,
          title,
          question,
          options,
        }),
        undefined,
        approverDm.instance,
      );
    } catch (err) {
      log.error('Channel registration: agent-selection card delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }
    return true;
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id, { instance: originMg?.instance });
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    awaitingNameInput.set(row.approver_user_id, {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
      dmInstance: approverDm.instance,
    });

    try {
      // Instance-addressed: `approverDm.instance` is the exact adapter
      // instance `ensureUserDm` resolved this DM on above.
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
        undefined,
        approverDm.instance,
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      awaitingNameInput.delete(row.approver_user_id);
    }
    return true;
  }

  // ── Resolve target agent group (connect to existing or create new) ──
  let targetAgentGroupId: string;

  if (payload.value.startsWith(CONNECT_PREFIX)) {
    targetAgentGroupId = payload.value.slice(CONNECT_PREFIX.length);
    const ag = await getAgentGroup(targetAgentGroupId);
    if (!ag) {
      log.error('Channel registration: target agent group no longer exists', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
      });
      await deletePendingChannelApproval(row.messaging_group_id);
      await completeStoredDeferredInbound(row.original_message);
      return true;
    }
    if (!(await withCentralSync(() => hasAdminPrivilege(approverId, targetAgentGroupId), 'channel approval target'))) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return true;
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return true;
  }

  // ── Wire + replay (shared path for connect and create) ──
  await wireApprovedChannel(row, targetAgentGroupId, approverId);
  return true;
}

registerResponseHandler(handleChannelApprovalResponse);

// ── Free-text name interceptor ──
// Captures the next DM from an approver who clicked "Create new agent",
// creates the agent immediately, wires the channel, and replays.

registerMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const userId = await extractAndUpsertUser(event);
  if (!userId) return false;

  const pending = awaitingNameInput.get(userId);
  if (!pending) return false;
  if (event.channelType !== pending.dmChannelType || event.platformId !== pending.dmPlatformId) return false;
  // Instance-matched too: the same channelType/platformId can be shared by
  // more than one sibling bot's conversation (e.g. a direct-addressable
  // channel where the platform_id is the user's own handle) — a reply that
  // arrived on a DIFFERENT instance is a different conversation, not the
  // approver answering this prompt.
  if ((event.instance ?? event.channelType) !== (pending.dmInstance ?? pending.dmChannelType)) return false;

  awaitingNameInput.delete(userId);

  let text: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = (typeof parsed.text === 'string' ? parsed.text : undefined)?.trim();
  } catch {
    /* fall through */
  }

  if (!text) {
    log.warn('Channel registration: empty name reply, ignoring', { userId });
    return true;
  }

  const row = await withCentralSync(() => getPendingChannelApproval(pending.channelMgId), 'pending approval read');
  if (!row) return true;

  // Origin instance for the follow-up notifications below, same reasoning as
  // handleChannelApprovalResponse: keep every reply to this approver on the
  // sibling bot the registration started on.
  const originMg = await getMessagingGroup(row.messaging_group_id);

  // `awaitingNameInput` is already deleted by here, so a throw out of this
  // interceptor would strand the approver with no card, no agent, and no
  // message. Creation can now legitimately fail (folder allocation gives up
  // after N concurrent losses), so report it instead of propagating.
  let ag: AgentGroup;
  try {
    ag = await createNewAgentGroup(text);
  } catch (err) {
    log.error('Channel registration: agent group creation failed', {
      messagingGroupId: row.messaging_group_id,
      agentName: text,
      err,
    });
    await notifyApprover(
      row.approver_user_id,
      `⚠️ Couldn't create agent "${text}" — check the host logs.`,
      originMg?.instance,
    );
    return true;
  }

  log.info('Channel registration: new agent group created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    agentName: ag.name,
    folder: ag.folder,
  });

  const wired = await wireApprovedChannel(row, ag.id, userId);

  await notifyApprover(
    row.approver_user_id,
    wired
      ? `✅ Agent "${ag.name}" created and connected.`
      : `⚠️ Agent "${ag.name}" was created but the channel couldn't be connected — check the host logs.`,
    originMg?.instance,
  );
  return true;
});

/** Best-effort DM to the approver; delivery failures are never fatal here. */
async function notifyApprover(approverUserId: string, text: string, instance?: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  const dm = await ensureUserDm(approverUserId, { instance });
  if (!dm) return;
  adapter
    .deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text }), undefined, dm.instance)
    .catch(() => {});
}
