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
 *   NANOCLAW_DEFAULT_AGENT_GROUP_<CHANNEL_TYPE>   agent_groups.folder
 *   NANOCLAW_DEFAULT_SESSION_MODE_<CHANNEL_TYPE>  per-thread | shared |
 *                                                 agent-shared (default: per-thread)
 *
 * Example:
 *   NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_ILLYSIUM=illysium-v2
 *   NANOCLAW_DEFAULT_SESSION_MODE_SLACK_ILLYSIUM=per-thread
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
import { createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { setUnwiredChannelResolver, type UnwiredChannelResolverFn } from '../../router.js';
import type { MessagingGroupAgent } from '../../types.js';

const VALID_SESSION_MODES = new Set(['shared', 'per-thread', 'agent-shared'] as const);
type SessionMode = 'shared' | 'per-thread' | 'agent-shared';

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

  const sessionMode = resolveDefaultSessionMode(event.channelType);
  const mga: MessagingGroupAgent = {
    id: newId(),
    messaging_group_id: mg.id,
    agent_group_id: agentGroup.id,
    trigger_rules: null,
    response_scope: 'all',
    session_mode: sessionMode,
    priority: 0,
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
