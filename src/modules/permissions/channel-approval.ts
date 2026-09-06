/**
 * Unknown-channel registration flow.
 *
 * When the router hits an unwired messaging group AND the message was
 * addressed to the bot (SDK-confirmed mention or DM), it calls
 * `requestChannelApproval` instead of silently dropping. The flow:
 *
 *   1. Gather all existing agent groups.
 *   2. Pick an eligible approver (owner / admin) and a reachable DM for
 *      them, reusing the same primitives the sender-approval flow uses.
 *   3. Record a `pending_channel_approvals` row holding the original event
 *      so it can be re-routed on connect/create.
 *   4. Deliver a card with three action families:
 *        a. Connect to [agent] — one button per existing agent group.
 *           Single-agent installs get a one-click connect.
 *        b. Connect new agent — prompts for a free-text name, creates
 *           the agent immediately on reply.
 *        c. Reject — deny the channel.
 * On connect (handler in index.ts):
 *   - Create `messaging_group_agents` with the channel's declared engage
 *     defaults (resolveWiringDefaults, DM vs group context;
 *      sender_scope='known', ignored_message_policy='accumulate')
 *   - Add the triggering sender to `agent_group_members` so sender_scope
 *     doesn't bounce the replayed message into a sender-approval cascade
 *   - Delete the pending row, replay the original event
 *
 * On connect new agent (handler in index.ts):
 *   - Prompt for a free-text agent name via DM
 *   - On reply: create the agent group + filesystem, then wire
 *     and replay as above
 *
 * On reject:
 *   - Set `messaging_groups.denied_at = now()` so the router stops
 *     escalating on this channel until an admin explicitly re-wires
 *   - Delete the pending row
 *
 * Dedup: `pending_channel_approvals` PK on messaging_group_id. A replay of
 * the retained event remains deferred; a later mention while pending is an
 * ordinary completed drop and never replaces the event awaiting approval.
 *
 * Failure modes (log + no row, so a future attempt can try again):
 *   - No agent groups exist (install never set up a first agent).
 *   - No eligible approver in user_roles (no owner yet).
 *   - Approver has no reachable DM.
 * Once the row exists, delivery failures leave it available for dashboard or
 * manual review; only failures before persistence return without a row.
 */
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { channelNameProvenance, getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { conversationDisplayName, formatParticipantList } from '../../channels/adapter.js';
import type { ChannelConversation, InboundEvent } from '../../channels/adapter.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  createPendingChannelApproval,
  getPendingChannelApproval,
  hasInFlightChannelApproval,
} from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

// ── Value constants (response handler in index.ts parses these) ──

export const CONNECT_PREFIX = 'connect:';
export const NEW_AGENT_VALUE = 'new_agent';
export const CHOOSE_EXISTING_VALUE = 'choose_existing';
export const REJECT_VALUE = 'reject';

/**
 * What approving here actually grants, stated on the card itself.
 *
 * Deliberately does NOT claim "the same authority as you": an approved member
 * still cannot run admin commands (`command-gate.ts` gates those on
 * `hasAdminPrivilege`). It names the real blast radius instead — the agent's
 * shared context, workspace files, memory and connected tools — because the
 * approver is deciding about that, not about one message.
 */
export const AGENT_ACCESS_SCOPE_WARNING =
  "Anyone approved here can interact with the agent and potentially access anything the agent can access, including other conversations' context, its workspace files and memory, and any connected tools.";

// ── Channel-card interceptor seam (B2/D24) ──
// A channel module can claim the escalation for its own channel type before
// a registration card goes out — e.g. the slack-room-membership module's
// owner-presence rule (owner in the room → auto-wire, no card) and its
// Slackbot shadow-channel backstop. The seam is deliberately generic: this
// module registers/consults by channel_type only and never imports channel
// code. 'handled' = the interceptor consumed the escalation (wired, declined,
// or deliberately ignored it); 'card' = proceed with today's card flow.
// Interceptor errors fall back to the card — a broken module must never make
// escalations silently vanish.

export type ChannelCardDecision = 'card' | 'handled';
export type ChannelCardInterceptor = (mg: MessagingGroup, event: InboundEvent) => Promise<ChannelCardDecision>;

const channelCardInterceptors = new Map<string, ChannelCardInterceptor>();

export function registerChannelCardInterceptor(channelType: string, fn: ChannelCardInterceptor): void {
  if (channelCardInterceptors.has(channelType)) {
    log.warn('Channel-card interceptor overwritten', { channelType });
  }
  channelCardInterceptors.set(channelType, fn);
}

/** Test-only: clear all registrations so cases don't depend on registration order. */
export function _resetChannelCardInterceptorsForTesting(): void {
  channelCardInterceptors.clear();
}

// ── Utilities ──

function toFolder(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

// ── Card builders ──

function visibleAgentGroupsForApprover(
  agentGroups: AgentGroup[],
  approverUserId: string | null | undefined,
): AgentGroup[] {
  if (!approverUserId) return agentGroups;
  return agentGroups.filter((agentGroup) => hasAdminPrivilege(approverUserId, agentGroup.id));
}

function buildApprovalOptions(agentGroups: AgentGroup[], approverUserId?: string | null): RawOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = [];
  if (visibleAgentGroups.length === 1) {
    options.push({
      label: `Connect to ${visibleAgentGroups[0].name}`,
      selectedLabel: `✅ Connected to ${visibleAgentGroups[0].name}`,
      value: `${CONNECT_PREFIX}${visibleAgentGroups[0].id}`,
      style: 'primary',
    });
  } else if (visibleAgentGroups.length > 1) {
    options.push({
      label: 'Choose existing agent',
      selectedLabel: '📋 Choosing…',
      value: CHOOSE_EXISTING_VALUE,
    });
  }
  options.push({
    label: 'Connect new agent',
    selectedLabel: '🆕 Connecting new agent…',
    value: NEW_AGENT_VALUE,
  });
  options.push({
    label: 'Reject',
    selectedLabel: '🙅 Rejected',
    value: REJECT_VALUE,
    style: 'danger',
  });
  return options;
}

function buildQuestionText(
  isGroup: boolean,
  senderName: string | undefined,
  channelName: string | null,
  channelType: string,
  ruleNote: string | null,
  conversation?: ChannelConversation | null,
): string {
  const who = senderName ?? 'Someone';
  const note = ruleNote ? ` If connected, the agent ${ruleNote}.` : '';
  if (isGroup) {
    const where = describeWhere(channelName, channelType, conversation);
    return `${who} mentioned your bot in ${where}.${note} ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle this channel?`;
  }
  return `${who} sent your bot a DM on ${channelType}.${note} ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle it?`;
}

/**
 * Where the mention happened, in the most specific form the adapter could
 * give us. A group DM has no name a human recognizes — the platform's own
 * label is a slug like `mpdm-alice--bob--carol-1` — so it is described by who
 * is in it. Everything else keeps the existing channel-name rendering.
 */
function describeWhere(
  channelName: string | null,
  channelType: string,
  conversation?: ChannelConversation | null,
): string {
  if (conversation?.type === 'group_dm') {
    const names = conversation.participantNames;
    return names && names.length > 0
      ? `a group DM with ${formatParticipantList(names)} on ${channelType}`
      : `a group DM on ${channelType}`;
  }
  return channelName ? `${channelName} on ${channelType}` : `a ${channelType} channel`;
}

/**
 * Human summary of the engage rule an approval would create, from the same
 * resolution the wire step uses. Null when the declaration is unresolvable
 * (mis-declared pattern mode) — the card still works without the preview.
 */
function describeResolvedRule(
  channelKey: string,
  isGroup: boolean,
  agentGroupName: string,
  channelType: string,
): string | null {
  try {
    const engage = resolveWiringDefaults(channelKey, isGroup, agentGroupName, channelType);
    if (engage.engage_mode !== 'pattern') {
      return isGroup ? 'will respond to @-mentions in this group' : 'will respond to @-mentions';
    }
    return engage.engage_pattern === '.'
      ? 'will respond to all messages'
      : `will respond to messages matching ${engage.engage_pattern}`;
  } catch {
    return null;
  }
}

// ── Main flow ──

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
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
export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<boolean> {
  const { messagingGroupId, event } = input;

  if (await hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    const existing = getPendingChannelApproval(messagingGroupId);
    return existing ? isSameInboundEvent(existing.original_message, event) : false;
  }

  // Channel-module interceptor: consulted before any card work so a module
  // can auto-wire / decline / suppress for its own channel type. Runs after
  // the in-flight dedupe (a pending card already owns this channel) and
  // before the approver checks (an auto-wire needs no reachable approver).
  // `getMessagingGroup` is synchronous in the fork, so this is a cheap extra
  // read rather than a reason to hoist the later `originMg` (card text,
  // instance) up to here — that lookup stays where it is.
  {
    const interceptMg = getMessagingGroup(messagingGroupId);
    const interceptor = interceptMg ? channelCardInterceptors.get(interceptMg.channel_type) : undefined;
    if (interceptMg && interceptor) {
      try {
        if ((await interceptor(interceptMg, event)) === 'handled') {
          log.debug('Channel registration handled by interceptor — no card', {
            messagingGroupId,
            channelType: interceptMg.channel_type,
          });
          // false: no pending row was retained for this event, so the
          // router must not call markReplayPending() for it.
          return false;
        }
      } catch (err) {
        log.warn('Channel-card interceptor threw — falling back to the card', { messagingGroupId, err });
      }
    }
  }

  const agentGroups = await getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return false;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = await pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return false;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';

  // Classify the conversation once, and reuse it for both the persisted name
  // and the card text — a second lookup would be a second API round trip for
  // the same answer. Key by instance so a named instance's own adapter (and
  // bot identity) does the lookup.
  let conversation: ChannelConversation | null = null;
  if (originMg) {
    const channelAdapter = getChannelAdapter(originMg.instance ?? originMg.channel_type);
    if (channelAdapter?.resolveConversation) {
      try {
        conversation = await channelAdapter.resolveConversation(originMg.platform_id);
      } catch {
        /* non-critical — the card falls back to generic rendering */
      }
    }
    if (conversation) {
      // The classification above already carries the name — deriving it
      // here is what keeps this to ONE round trip.
      //
      // Written unconditionally (not gated on `!originMg.name`): this is the
      // first inbound event for a fresh, unwired mg, and `reportChannelMetadata`
      // (chat-sdk-bridge.ts, one-shot per channel per process) races this same
      // event with its own, cruder name lookup. The `classified` stamp is what
      // settles that race in one direction: it outranks the raw fetch's
      // `adapter` stamp, so this answer wins whether it lands first or second,
      // and the raw fetch cannot take it back on a later restart either.
      //
      // Rewritten when the NAME is new or when its PROVENANCE is: a name the
      // raw fetch happened to get right still carries an `adapter` stamp, and
      // leaving it there would let a later raw fetch overwrite an answer the
      // classifier has since confirmed.
      const name = conversationDisplayName(conversation);
      const nameSource = channelNameProvenance(originMg.channel_type, 'classified');
      if (name && (name !== originMg.name || originMg.name_source !== nameSource)) {
        await updateMessagingGroup(originMg.id, { name, name_source: nameSource });
        originMg.name = name;
        originMg.name_source = nameSource;
      }
    } else if (!originMg.name && channelAdapter?.resolveChannelName) {
      // No rich classification available (adapter lacks the seam, or the
      // lookup failed) — fall back to the plain resolver. Set-once: an
      // adapter without the seam can't tell a stale legacy name from a good
      // one, so an already-set name is left alone here as before.
      //
      // Still stamped `classified`: `resolveChannelName` is the classification
      // seam's other face (on Slack it is a projection of the same
      // `resolveConversation`), so its answer must outrank the raw fetch for
      // the same reason the branch above does.
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          const nameSource = channelNameProvenance(originMg.channel_type, 'classified');
          await updateMessagingGroup(originMg.id, { name, name_source: nameSource });
          originMg.name = name;
          originMg.name_source = nameSource;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  // Same-channel-type only: refuse to deliver an approval card carrying
  // a user's message body into a different workspace/platform than the
  // one it originated in, even if the same human owner is reachable
  // there. The dropped_messages row written by the router (reason
  // 'no_agent_wired') already preserves operator visibility; the owner
  // can review pending registrations via the dashboard.
  //
  // `instance` so a cold DM row created for this delivery is stamped with
  // the origin's adapter instance, not the bare channel_type — see the
  // comment on the `adapter.deliver` call below.
  const delivery = await pickApprovalDelivery(approvers, originChannelType, {
    sameChannelTypeOnly: true,
    instance: originMg?.instance ?? event.instance,
  });
  if (!delivery) {
    log.warn('Channel registration skipped — no in-workspace approver reachable on origin channel_type', {
      messagingGroupId,
      originChannelType,
      targetAgentGroupId: referenceGroup.id,
      approverCount: approvers.length,
    });
    return false;
  }

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  let senderName: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
  } catch {
    // non-critical
  }

  const channelName = originMg?.name ?? null;
  const title = isGroup ? '📣 Bot mentioned in new channel' : '💬 New direct message';
  // Preview the engage rule an approval would create. The reference group's
  // name only feeds {name} pattern substitution — a best-effort preview when
  // the approver ends up picking a different agent.
  const ruleNote = describeResolvedRule(
    originMg?.instance ?? originChannelType,
    isGroup,
    referenceGroup.name,
    originChannelType,
  );
  const question = buildQuestionText(isGroup, senderName, channelName, originChannelType, ruleNote, conversation);
  const options = normalizeOptions(buildApprovalOptions(agentGroups, delivery.userId));

  const created = await createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: referenceGroup.id,
    original_message: JSON.stringify(event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
    question,
    options_json: JSON.stringify(options),
  });
  if (!created) {
    const raced = getPendingChannelApproval(messagingGroupId);
    return raced ? isSameInboundEvent(raced.original_message, event) : false;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration row created but no delivery adapter is wired', { messagingGroupId });
    return true;
  }

  try {
    // Instance-addressed: `delivery.messagingGroup.instance` is the exact
    // adapter instance `pickApprovalDelivery` resolved this DM on. Without
    // it, an install whose bots are all named instances resolves no adapter
    // under the bare channel_type, or the wrong sibling bot answers.
    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: messagingGroupId,
        title,
        question,
        options,
      }),
      undefined,
      delivery.messagingGroup.instance,
    );
    log.info('Channel registration card delivered', {
      messagingGroupId,
      agentGroupCount: agentGroups.length,
      approver: delivery.userId,
    });
  } catch (err) {
    log.error('Channel registration card delivery failed', { messagingGroupId, err });
  }
  return true;
}

// ── Helpers for the response handler (index.ts) ──

/**
 * Build normalized options for the agent-selection follow-up card.
 */
export function buildAgentSelectionOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
): NormalizedOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = visibleAgentGroups.map((ag) => ({
    label: ag.name,
    selectedLabel: `✅ Connected to ${ag.name}`,
    value: `${CONNECT_PREFIX}${ag.id}`,
  }));
  options.push({
    label: 'Cancel',
    selectedLabel: '🙅 Cancelled',
    value: REJECT_VALUE,
  });
  return normalizeOptions(options);
}

/**
 * How many times folder allocation may lose the unique-key race before giving
 * up. Each loss advances the numeric suffix past the folder the winner took,
 * so exhausting this needs five approvers naming the same agent at the same
 * instant. Bounded rather than unbounded because a stuck loop here would hang
 * a router interceptor.
 */
const FOLDER_ALLOCATION_ATTEMPTS = 5;

/**
 * Create a new agent group and initialize its filesystem. Handles
 * folder-name collisions with numeric suffixes.
 *
 * Concurrency: the `getAgentGroupByFolder` scan yields (async driver), so two
 * approvers naming agents that normalize to the same folder can both settle on
 * it and both INSERT; `agent_groups.folder` is UNIQUE, so one loses. Losing is
 * NOT adoptable here — the winner's row is a DIFFERENT operator's agent, with
 * its own name and its own channel to wire — so the loser re-runs allocation,
 * which now sees the taken folder and moves to the next suffix. `insertOrAdopt`
 * supplies the "did I lose?" signal; the retry policy is this function's.
 */
export async function createNewAgentGroup(name: string): Promise<AgentGroup> {
  const baseFolder = toFolder(name);
  let folder = baseFolder;
  let suffix = 2;
  let agId = '';

  let allocated = false;
  for (let attempt = 1; attempt <= FOLDER_ALLOCATION_ATTEMPTS && !allocated; attempt++) {
    // Disk-aware dedupe: a folder present on disk with no claiming DB row is
    // deleted-group residue (or a dangling symlink — groupFolderExistsOnDisk
    // uses lstat, not existsSync, so it still counts as present). Adopting it
    // would silently re-scope the old group's data under the new agent's
    // identity, so skip to the next suffix instead — same behavior as the
    // agent-reachable minted-name path (templates/create-agent.ts).
    while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
      folder = `${baseFolder}-${suffix}`;
      suffix++;
    }

    agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const currentFolder = folder;
    const { created } = await insertOrAdopt<AgentGroup>(
      {
        id: agId,
        name,
        folder: currentFolder,
        agent_provider: null,
        created_at: new Date().toISOString(),
      },
      createAgentGroup,
      () => getAgentGroupByFolder(currentFolder),
    );
    if (created) {
      allocated = true;
    } else {
      log.warn('Channel registration: agent folder taken by a concurrent create, retrying', {
        folder: currentFolder,
        attempt,
      });
    }
  }

  if (!allocated) {
    throw new Error(
      `Could not allocate a folder for agent "${name}" after ${FOLDER_ALLOCATION_ATTEMPTS} attempts (concurrent creates)`,
    );
  }

  const ag = (await getAgentGroup(agId))!;
  // Channel-approved groups are created on the instance default provider
  // (DEFAULT_AGENT_PROVIDER, or claude when unset) — initGroupFilesystem stamps
  // it onto the fresh config row. The operator flips a group afterward with
  // `ncl groups config update --provider`.
  initGroupFilesystem(ag);
  return ag;
}
