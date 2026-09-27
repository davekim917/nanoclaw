/**
 * Opt-in default-agent wiring for a new messaging group with no wiring rows,
 * registered via `setUnwiredChannelResolver`. Per channel_type (uppercased,
 * dashes → underscores):
 *
 *   NANOCLAW_DEFAULT_AGENT_GROUP_<CHANNEL_TYPE>     agent_groups.folder
 *   NANOCLAW_DEFAULT_SESSION_MODE_<CHANNEL_TYPE>    per-thread | shared |
 *                                                   agent-shared (default: per-thread)
 *   NANOCLAW_DEFAULT_SENDER_POLICY_<CHANNEL_TYPE>   strict | request_approval |
 *                                                   decline_notify | public
 *                                                   (default: strict)
 *   NANOCLAW_DEFAULT_IGNORED_POLICY_<CHANNEL_TYPE>  accumulate | drop
 *                                                   (default: accumulate)
 *
 * The sender policy widens access for every new channel of that type; use
 * `public` only where platform membership is itself the gate. Unset or unknown
 * folder ⇒ no auto-wire (upstream drop behavior).
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, updateMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import { log } from '../../log.js';
import { setUnwiredChannelResolver, type UnwiredChannelResolverFn } from '../../router.js';
import type { MessagingGroup, MessagingGroupAgent, SessionMode } from '../../types.js';
import { SESSION_MODES } from '../../types.js';

const VALID_SESSION_MODES = new Set<string>(SESSION_MODES);

const VALID_SENDER_POLICIES = new Set(['strict', 'request_approval', 'decline_notify', 'public'] as const);
type SenderPolicy = MessagingGroup['unknown_sender_policy'];

const VALID_IGNORED_POLICIES = new Set(['drop', 'accumulate'] as const);
type IgnoredMessagePolicy = MessagingGroupAgent['ignored_message_policy'];

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

function resolveDefaultIgnoredPolicy(channelType: string): IgnoredMessagePolicy {
  const raw = process.env[envKey('NANOCLAW_DEFAULT_IGNORED_POLICY', channelType)];
  const trimmed = raw?.trim();
  if (trimmed && VALID_IGNORED_POLICIES.has(trimmed as IgnoredMessagePolicy)) {
    return trimmed as IgnoredMessagePolicy;
  }
  if (trimmed) {
    log.warn('channel-auto-wire: invalid ignored_message_policy in env, falling back to accumulate', {
      channelType,
      value: trimmed,
    });
  }
  return 'accumulate';
}

function newId(): string {
  return `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const resolver: UnwiredChannelResolverFn = async (event, mg) => {
  const folder = resolveDefaultAgentFolder(event.channelType);
  if (!folder) return [];

  const agentGroup = await getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('channel-auto-wire: default agent folder not found, skipping', {
      channelType: event.channelType,
      folder,
      messagingGroupId: mg.id,
    });
    return [];
  }

  // Never infer DM-ness from threadId: DMs can have subthreads, and
  // non-threaded group platforms always have null thread ids.
  const isGroup = event.message.isGroup ?? mg.is_group === 1;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention' : 'pattern';
  const engagePattern = engageMode === 'pattern' ? '.' : null;

  const sessionMode = resolveDefaultSessionMode(event.channelType);

  // Mutate `mg` in place: the router passes this same object to the access
  // gate right after us; the DB update persists it for later messages.
  const senderPolicy = resolveDefaultSenderPolicy(event.channelType);
  if (senderPolicy && senderPolicy !== mg.unknown_sender_policy) {
    await updateMessagingGroup(mg.id, { unknown_sender_policy: senderPolicy });
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
    ignored_message_policy: resolveDefaultIgnoredPolicy(event.channelType),
    session_mode: sessionMode,
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: new Date().toISOString(),
  };

  // Two initial messages for one unwired channel can both reach this insert;
  // the loser adopts the winner's wiring.
  try {
    const { row, created } = await insertOrAdopt(
      mga,
      async (candidate) => {
        await createMessagingGroupAgent(candidate);
      },
      async () => (await getMessagingGroupAgents(mg.id)).find((w) => w.agent_group_id === agentGroup.id),
    );
    if (!created) {
      log.info('channel-auto-wire: adopted the wiring a concurrent inbound created', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        wiringId: row.id,
      });
      return [row];
    }
  } catch (err) {
    log.warn('channel-auto-wire: createMessagingGroupAgent threw and no concurrent wire was found', {
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
