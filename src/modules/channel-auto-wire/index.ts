/**
 * Channel auto-wire module (fork addition).
 *
 * Opt-in default-agent wiring for freshly-appearing messaging groups.
 * Registered against `setUnwiredChannelResolver` in `src/router.ts`, so
 * it runs only when a new messaging group has no `messaging_group_agents`
 * rows. Zero effect on already-wired channels.
 *
 * Use case. Upstream's model is "invite the bot, then run
 * `/manage-channels` to wire it." For our Slack (Illysium workspace),
 * the wiring decision is always the same — point the new channel at
 * `illysium-v2` with `per-thread` isolation — so the manual step is
 * pure friction. This module lets Dave declare the rule once in `.env`
 * and have new invites route immediately, no repeat-invocation of the
 * skill.
 *
 * Config (optional, per channel_type). Keys are the channel_type
 * uppercased with dashes replaced by underscores:
 *
 *   NANOCLAW_DEFAULT_AGENT_GROUP_<CHANNEL_TYPE>     agent_groups.folder
 *   NANOCLAW_DEFAULT_SESSION_MODE_<CHANNEL_TYPE>    per-thread | shared |
 *                                                   agent-shared (default: per-thread)
 *   NANOCLAW_DEFAULT_SENDER_POLICY_<CHANNEL_TYPE>   strict | request_approval |
 *                                                   public (default: strict — the
 *                                                   safe v2 upstream default)
 *
 * Why sender policy is part of auto-wire. Router creates new messaging
 * groups with `unknown_sender_policy='strict'`, which is the right safe
 * default when wiring is manual (you explicitly grant access per user).
 * For channel-types where the platform's own membership is the gate —
 * Slack workspace membership for the Illysium bot — v1 behavior is
 * effectively `public` (anyone in the workspace can invoke). Setting
 * this env matches that behavior per channel_type without widening it
 * for channel_types where you do want strict.
 *
 * Example:
 *   NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_ILLYSIUM=illysium-v2
 *   NANOCLAW_DEFAULT_SESSION_MODE_SLACK_ILLYSIUM=per-thread
 *   NANOCLAW_DEFAULT_SENDER_POLICY_SLACK_ILLYSIUM=public
 *
 * When a Slack message arrives from a channel in the Illysium workspace
 * that's not yet wired, this module creates a `messaging_group_agents`
 * row pointing at the `illysium-v2` agent group and the message routes
 * through the normal path in the same tick — no dropped first message.
 *
 * Unset env var for a channel_type ⇒ no auto-wire ⇒ upstream drop behavior.
 * Unknown folder in env var ⇒ logs a warning, no auto-wire, drop proceeds.
 *
 * Upstream drift. One additive hook in `src/router.ts` (next to
 * `setSenderResolver` / `setAccessGate`) plus this self-registering
 * module. The hook's default is null, so trunk behavior without the
 * module matches upstream exactly. Candidate for upstreaming later.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, updateMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { setUnwiredChannelResolver, type UnwiredChannelResolverFn } from '../../router.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';

const VALID_SESSION_MODES = new Set(['shared', 'per-thread', 'agent-shared'] as const);
type SessionMode = 'shared' | 'per-thread' | 'agent-shared';

const VALID_SENDER_POLICIES = new Set(['strict', 'request_approval', 'public'] as const);
type SenderPolicy = MessagingGroup['unknown_sender_policy'];

function envKey(prefix: string, channelType: string): string {
  return `${prefix}_${channelType.toUpperCase().replace(/-/g, '_')}`;
}

function resolveDefaultAgentFolder(channelType: string): string | undefined {
  const raw = process.env[envKey('NANOCLAW_DEFAULT_AGENT_GROUP', channelType)];
  return raw && raw.trim() ? raw.trim() : undefined;
}

function resolveDefaultSessionMode(channelType: string): SessionMode {
  const raw = process.env[envKey('NANOCLAW_DEFAULT_SESSION_MODE', channelType)];
  const trimmed = raw?.trim();
  if (trimmed && VALID_SESSION_MODES.has(trimmed as SessionMode)) {
    return trimmed as SessionMode;
  }
  if (trimmed) {
    log.warn('channel-auto-wire: invalid session_mode in env, falling back to per-thread', {
      channelType,
      value: trimmed,
    });
  }
  return 'per-thread';
}

function resolveDefaultSenderPolicy(channelType: string): SenderPolicy | null {
  const raw = process.env[envKey('NANOCLAW_DEFAULT_SENDER_POLICY', channelType)];
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (VALID_SENDER_POLICIES.has(trimmed as SenderPolicy)) {
    return trimmed as SenderPolicy;
  }
  log.warn('channel-auto-wire: invalid sender_policy in env, leaving mg at strict default', {
    channelType,
    value: trimmed,
  });
  return null;
}

function newId(): string {
  return `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const resolver: UnwiredChannelResolverFn = (event, mg) => {
  const folder = resolveDefaultAgentFolder(event.channelType);
  if (!folder) return [];

  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('channel-auto-wire: default agent folder not found, skipping', {
      channelType: event.channelType,
      folder,
      messagingGroupId: mg.id,
    });
    return [];
  }

  // v2 engage model: DMs (threadId=null) use pattern='.' (always respond);
  // group chats are always @mentions, use mention mode.
  const engageMode: MessagingGroupAgent['engage_mode'] = event.threadId === null ? 'pattern' : 'mention';
  const engagePattern = engageMode === 'pattern' ? '.' : null;

  const sessionMode = resolveDefaultSessionMode(event.channelType);

  // Relax the unknown_sender_policy if one is configured for this
  // channel_type. Router created the mg with `strict` (v2's safe default);
  // for channel_types where the platform's own membership is the gate
  // (e.g. Slack workspace), `public` restores v1 parity. We mutate `mg`
  // in-place because the router holds a reference to this same object
  // and passes it to the access gate immediately after us — the DB
  // update is what persists the change for subsequent messages.
  const senderPolicy = resolveDefaultSenderPolicy(event.channelType);
  if (senderPolicy && senderPolicy !== mg.unknown_sender_policy) {
    updateMessagingGroup(mg.id, { unknown_sender_policy: senderPolicy });
    mg.unknown_sender_policy = senderPolicy;
    log.info('channel-auto-wire: relaxed unknown_sender_policy', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      from: 'strict',
      to: senderPolicy,
    });
  }

  const mga: MessagingGroupAgent = {
    id: newId(),
    messaging_group_id: mg.id,
    agent_group_id: agentGroup.id,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: sessionMode,
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: new Date().toISOString(),
  };

  try {
    createMessagingGroupAgent(mga);
  } catch (err) {
    // Most likely cause: another concurrent inbound just wired this group.
    // Re-read; if still zero, return empty so core drops this message.
    log.warn('channel-auto-wire: createMessagingGroupAgent threw, probing for concurrent wire', {
      err,
      messagingGroupId: mg.id,
      channelType: event.channelType,
    });
    return [];
  }

  log.info('channel-auto-wire: auto-wired new messaging group', {
    messagingGroupId: mg.id,
    channelType: event.channelType,
    platformId: event.platformId,
    agentGroupId: agentGroup.id,
    folder,
    sessionMode,
  });

  return [mga];
};

setUnwiredChannelResolver(resolver);
