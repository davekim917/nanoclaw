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
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { AgentGroup } from '../../types.js';
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
): string {
  const who = senderName ?? 'Someone';
  const note = ruleNote ? ` If connected, the agent ${ruleNote}.` : '';
  if (isGroup) {
    const where = channelName ? `${channelName} on ${channelType}` : `a ${channelType} channel`;
    return `${who} mentioned your bot in ${where}.${note} How would you like to handle this channel?`;
  }
  return `${who} sent your bot a DM on ${channelType}.${note} How would you like to handle it?`;
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

  if (hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    const existing = getPendingChannelApproval(messagingGroupId);
    return existing ? isSameInboundEvent(existing.original_message, event) : false;
  }

  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return false;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return false;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';

  // Resolve channel name if not yet persisted. Key by instance so a named
  // instance's own adapter (and bot identity) does the lookup.
  if (originMg && !originMg.name) {
    const channelAdapter = getChannelAdapter(originMg.instance ?? originMg.channel_type);
    if (channelAdapter?.resolveChannelName) {
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          updateMessagingGroup(originMg.id, { name });
          originMg.name = name;
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
  const delivery = await pickApprovalDelivery(approvers, originChannelType, { sameChannelTypeOnly: true });
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
  const question = buildQuestionText(isGroup, senderName, channelName, originChannelType, ruleNote);
  const options = normalizeOptions(buildApprovalOptions(agentGroups, delivery.userId));

  const created = createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: referenceGroup.id,
    original_message: JSON.stringify(event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
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
 * Create a new agent group and initialize its filesystem. Handles
 * folder-name collisions with numeric suffixes.
 */
export function createNewAgentGroup(name: string): AgentGroup {
  let folder = toFolder(name);
  const baseFolder = folder;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${baseFolder}-${suffix}`;
    suffix++;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const ag = getAgentGroup(agId)!;
  // Channel-approved groups are created on the instance default provider
  // (DEFAULT_AGENT_PROVIDER, or claude when unset) — initGroupFilesystem stamps
  // it onto the fresh config row. The operator flips a group afterward with
  // `ncl groups config update --provider`.
  initGroupFilesystem(ag);
  return ag;
}
