/**
 * Chat-invokable per-channel model/effort defaults (fork addition).
 *
 * Registers two delivery actions — `set_channel_model`, `set_channel_effort`
 * — that the container's channel-config MCP tool emits. See
 * `container/agent-runner/src/mcp-tools/channel-config.ts` for the agent-
 * facing side.
 *
 * Terminology (v2):
 *   - channel = messaging_group (one chat on one platform)
 *   - agent   = agent_group (one persona/workspace)
 *   - wiring  = messaging_group_agents row (channel ↔ agent link)
 *
 * Precedence the mutation interacts with (most specific wins):
 *   1. Per-session flag in chat: -m / -m1 / -e / -e1
 *   2. Per-channel wiring: messaging_group_agents.default_model / _effort  ← this module
 *   3. Per-agent container.json: defaultModel / defaultEffort
 *   4. Host env: ANTHROPIC_DEFAULT_OPUS_MODEL / NANOCLAW_DEFAULT_EFFORT
 *   5. Hardcoded: claude-opus-4-6[1m] / high
 *
 * Authorization (trust-minimal, mirrors permissions/grant.ts):
 *   1. Caller identity derived from session's latest inbound chat message.
 *   2. Caller must be owner / global admin / admin-of-the-target-agent.
 *   3. Target channel defaults to the session's own messaging_group if
 *      the agent didn't specify one. A named channel must have an
 *      existing wiring with THIS agent.
 *
 * Container restart: after a successful mutation, we don't restart the
 * container. Env is read at spawn time, so the NEW default only takes
 * effect on the NEXT container spawn. The current session keeps its
 * current model until the user types `-m` or the container otherwise
 * cycles. notify message says so.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

// Reuse the caller derivation pattern from grant.ts. Copied (not imported)
// because this module is default-tier and grant.ts is optional — a fork
// that drops permissions shouldn't cascade-break channel-config.
function deriveCallerId(session: Session, inDb: Database.Database): string | null {
  const row = inDb
    .prepare(`SELECT content, channel_type FROM messages_in WHERE kind='chat' ORDER BY timestamp DESC LIMIT 1`)
    .get() as { content?: string; channel_type?: string } | undefined;
  if (!row?.content) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawId = (() => {
    const direct = parsed.senderId;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const author = parsed.author as { userId?: unknown } | undefined;
    if (typeof author?.userId === 'string' && author.userId.length > 0) return author.userId;
    return null;
  })();
  if (!rawId) return null;
  if (rawId.includes(':')) return rawId;
  const mgFallback = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
  if (!channelType) return null;
  return `${channelType}:${rawId}`;
}

function hasMutateAuthority(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}

/**
 * Resolve the target channel for the mutation. If `channelName` is given,
 * look it up in the session's destinations map (inbound.db). Otherwise
 * use the session's own messaging_group. Returns null if unresolved.
 */
function resolveChannelMessagingGroupId(
  session: Session,
  inDb: Database.Database,
  channelName: string | undefined,
): string | null {
  if (!channelName) {
    return session.messaging_group_id ?? null;
  }
  // Look up the destination by name from inbound.db's destinations table
  // (host writes this before each container wake; container reads it
  // live). type='channel' rows carry channel_type + platform_id; map
  // those back to a messaging_group id.
  const row = inDb
    .prepare(`SELECT channel_type, platform_id FROM destinations WHERE name = ? AND type = 'channel'`)
    .get(channelName) as { channel_type?: string; platform_id?: string } | undefined;
  if (!row?.channel_type || !row.platform_id) return null;
  // destinations lives in the session's inbound.db (host writes it at
  // wake). messaging_groups lives in central v2.db — cross-DB join by
  // (channel_type, platform_id).
  const mg = getMessagingGroupByPlatform(row.channel_type, row.platform_id);
  return mg?.id ?? null;
}

interface ChannelConfigArgs {
  channel?: unknown;
  model?: unknown;
  effort?: unknown;
}

async function handleSetChannelModel(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const args = content as ChannelConfigArgs;
  const channelName = typeof args.channel === 'string' ? args.channel : undefined;
  // model: string = set, null = clear, anything else = reject
  const model = args.model === null ? null : typeof args.model === 'string' ? args.model : undefined;
  if (model === undefined) {
    notifyAgent(session, 'set_channel_model failed: `model` must be a string (to pin) or null (to clear).');
    return;
  }

  const callerId = deriveCallerId(session, inDb);
  if (!callerId) {
    notifyAgent(session, 'set_channel_model failed: could not identify the user who sent this message.');
    return;
  }
  const agent = getAgentGroup(session.agent_group_id);
  if (!agent) {
    notifyAgent(session, 'set_channel_model failed: agent group not found.');
    return;
  }
  if (!hasMutateAuthority(callerId, agent.id)) {
    notifyAgent(session, `set_channel_model denied: ${callerId} is not an owner / admin of ${agent.name}.`);
    return;
  }

  const mgId = resolveChannelMessagingGroupId(session, inDb, channelName);
  if (!mgId) {
    notifyAgent(session, `set_channel_model failed: channel ${channelName ?? '(current)'} not resolvable.`);
    return;
  }

  const wiring = getMessagingGroupAgentByPair(mgId, agent.id);
  if (!wiring) {
    notifyAgent(session, `set_channel_model failed: channel ${channelName ?? mgId} is not wired to this agent.`);
    return;
  }

  updateMessagingGroupAgent(wiring.id, { default_model: model });
  log.info('Channel default_model updated', {
    wiringId: wiring.id,
    agentGroupId: agent.id,
    messagingGroupId: mgId,
    model,
    by: callerId,
  });
  const label = model === null ? 'cleared' : `set to ${model}`;
  notifyAgent(
    session,
    `✅ Channel default_model ${label} for ${channelName ?? 'current channel'}. Takes effect on next container spawn.`,
  );
}

async function handleSetChannelEffort(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const args = content as ChannelConfigArgs;
  const channelName = typeof args.channel === 'string' ? args.channel : undefined;
  const effort = args.effort === null ? null : typeof args.effort === 'string' ? args.effort : undefined;
  if (effort === undefined) {
    notifyAgent(session, 'set_channel_effort failed: `effort` must be low/medium/high/xhigh or null.');
    return;
  }
  if (effort !== null && !['low', 'medium', 'high', 'xhigh'].includes(effort)) {
    notifyAgent(session, `set_channel_effort failed: invalid effort level ${JSON.stringify(effort)}.`);
    return;
  }

  const callerId = deriveCallerId(session, inDb);
  if (!callerId) {
    notifyAgent(session, 'set_channel_effort failed: could not identify the user who sent this message.');
    return;
  }
  const agent = getAgentGroup(session.agent_group_id);
  if (!agent) {
    notifyAgent(session, 'set_channel_effort failed: agent group not found.');
    return;
  }
  if (!hasMutateAuthority(callerId, agent.id)) {
    notifyAgent(session, `set_channel_effort denied: ${callerId} is not an owner / admin of ${agent.name}.`);
    return;
  }

  const mgId = resolveChannelMessagingGroupId(session, inDb, channelName);
  if (!mgId) {
    notifyAgent(session, `set_channel_effort failed: channel ${channelName ?? '(current)'} not resolvable.`);
    return;
  }

  const wiring = getMessagingGroupAgentByPair(mgId, agent.id);
  if (!wiring) {
    notifyAgent(session, `set_channel_effort failed: channel ${channelName ?? mgId} is not wired to this agent.`);
    return;
  }

  updateMessagingGroupAgent(wiring.id, { default_effort: effort });
  log.info('Channel default_effort updated', {
    wiringId: wiring.id,
    agentGroupId: agent.id,
    messagingGroupId: mgId,
    effort,
    by: callerId,
  });
  const label = effort === null ? 'cleared' : `set to ${effort}`;
  notifyAgent(
    session,
    `✅ Channel default_effort ${label} for ${channelName ?? 'current channel'}. Takes effect on next container spawn.`,
  );
}

registerDeliveryAction('set_channel_model', handleSetChannelModel);
registerDeliveryAction('set_channel_effort', handleSetChannelEffort);

// Export for testing.
export { deriveCallerId as _deriveCallerId, resolveChannelMessagingGroupId as _resolveChannelMessagingGroupId };
