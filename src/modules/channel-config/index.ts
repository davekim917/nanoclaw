/**
 * `set_channel_model` / `set_channel_effort`: per-wiring defaults. A per-session
 * chat flag still beats these; they beat container.json. Caller must be owner,
 * global admin, or admin of the target agent; a named channel must already be
 * wired to THIS agent. Takes effect at the NEXT container spawn (env is read
 * at spawn), not in the running session.
 */

import { withCentralSync } from '../../db/central-lease.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { deriveCallerId } from '../../caller-identity.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { parseMessageFlags } from '../../flag-parser.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

function hasMutateAuthority(userId: string, agentGroupId: string): Promise<boolean> {
  return withCentralSync(
    () => isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId),
    'channel-config authority',
  );
}

/** Named channel via the session's destinations map, else its own messaging group; null if unresolved. */
async function resolveChannelMessagingGroupId(
  session: Session,
  channelName: string | undefined,
): Promise<string | null> {
  if (!channelName) {
    return session.messaging_group_id ?? null;
  }
  // Existing-only: a session with no mailbox has no destinations map.
  const row = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getChannelDestination(channelName),
  );
  if (!row?.channel_type || !row.platform_id) return null;
  // Cross-DB join: destinations live in inbound.db, messaging_groups in central.
  const mg = await getMessagingGroupByPlatform(row.channel_type, row.platform_id);
  return mg?.id ?? null;
}

interface ChannelConfigArgs {
  channel?: unknown;
  model?: unknown;
  effort?: unknown;
}

type ParsedChannelValue = { value?: string | null; error?: string };

/**
 * Codex values go through the chat-flag vocabulary (dot forms normalize,
 * family names stay as typed so the wiring follows the next release); other
 * providers' model strings pass through for forward-compatible SDK ids. Effort
 * is validated for every provider so `max`/`ultra` can't reach a Claude or
 * OpenCode wiring by accident.
 */
function parseChannelModel(model: string, provider: string): ParsedChannelValue {
  if (provider !== 'codex') return { value: model };
  const parsed = parseMessageFlags(`-m ${model}`, provider);
  if (parsed.errors.length > 0 || parsed.cleanedText.trim() !== '' || !parsed.intent?.stickyModel) {
    return { error: parsed.errors.join('; ') || `invalid model ${JSON.stringify(model)}` };
  }
  return { value: parsed.intent.stickyModel };
}

function parseChannelEffort(effort: string, provider: string): ParsedChannelValue {
  const normalized = effort.trim().toLowerCase();
  const parsed = parseMessageFlags(`-e ${normalized}`, provider);
  if (
    parsed.errors.length > 0 ||
    parsed.cleanedText.trim() !== '' ||
    !parsed.intent?.stickyEffort ||
    parsed.intent.stickyUltracode
  ) {
    return { error: parsed.errors.join('; ') || `invalid effort ${JSON.stringify(effort)}` };
  }
  return { value: parsed.intent.stickyEffort };
}

async function handleSetChannelModel(content: Record<string, unknown>, session: Session): Promise<void> {
  const args = content as ChannelConfigArgs;
  const channelName = typeof args.channel === 'string' ? args.channel : undefined;
  const model = args.model === null ? null : typeof args.model === 'string' ? args.model : undefined;
  if (model === undefined) {
    await notifyAgent(session, 'set_channel_model failed: `model` must be a string (to pin) or null (to clear).');
    return;
  }

  const callerId = await deriveCallerId(session);
  if (!callerId) {
    await notifyAgent(session, 'set_channel_model failed: could not identify the user who sent this message.');
    return;
  }
  const agent = await getAgentGroup(session.agent_group_id);
  if (!agent) {
    await notifyAgent(session, 'set_channel_model failed: agent group not found.');
    return;
  }
  if (!(await hasMutateAuthority(callerId, agent.id))) {
    await notifyAgent(session, `set_channel_model denied: ${callerId} is not an owner / admin of ${agent.name}.`);
    return;
  }

  const mgId = await resolveChannelMessagingGroupId(session, channelName);
  if (!mgId) {
    await notifyAgent(session, `set_channel_model failed: channel ${channelName ?? '(current)'} not resolvable.`);
    return;
  }

  const wiring = await getMessagingGroupAgentByPair(mgId, agent.id);
  if (!wiring) {
    await notifyAgent(session, `set_channel_model failed: channel ${channelName ?? mgId} is not wired to this agent.`);
    return;
  }

  const provider = resolveProviderName(
    session.agent_provider,
    (await getContainerConfig(agent.id))?.provider ?? agent.agent_provider,
  );
  const parsedModel: ParsedChannelValue = model === null ? { value: null } : parseChannelModel(model.trim(), provider);
  if (parsedModel.error || (model !== null && !parsedModel.value)) {
    await notifyAgent(session, `set_channel_model failed: ${parsedModel.error ?? 'invalid model'}.`);
    return;
  }
  const normalizedModel = parsedModel.value ?? null;

  await updateMessagingGroupAgent(wiring.id, { default_model: normalizedModel });
  log.info('Channel default_model updated', {
    wiringId: wiring.id,
    agentGroupId: agent.id,
    messagingGroupId: mgId,
    model: normalizedModel,
    by: callerId,
  });
  const label =
    normalizedModel === null
      ? 'cleared'
      : normalizedModel === model
        ? `set to ${normalizedModel}`
        : `set to ${normalizedModel} (via ${model})`;
  // Best-effort, never awaited: an awaited rejection leaves the message
  // undelivered, and the retry re-applies the whole handler.
  void Promise.resolve(
    notifyAgent(
      session,
      `✅ Channel default_model ${label} for ${channelName ?? 'current channel'}. Takes effect on next container spawn.`,
    ),
  ).catch((err) => log.warn('set_channel_model notification failed', { wiringId: wiring.id, err }));
}

async function handleSetChannelEffort(content: Record<string, unknown>, session: Session): Promise<void> {
  const args = content as ChannelConfigArgs;
  const channelName = typeof args.channel === 'string' ? args.channel : undefined;
  const effort = args.effort === null ? null : typeof args.effort === 'string' ? args.effort : undefined;
  if (effort === undefined) {
    await notifyAgent(session, 'set_channel_effort failed: `effort` must be a provider-supported level or null.');
    return;
  }

  const callerId = await deriveCallerId(session);
  if (!callerId) {
    await notifyAgent(session, 'set_channel_effort failed: could not identify the user who sent this message.');
    return;
  }
  const agent = await getAgentGroup(session.agent_group_id);
  if (!agent) {
    await notifyAgent(session, 'set_channel_effort failed: agent group not found.');
    return;
  }
  if (!(await hasMutateAuthority(callerId, agent.id))) {
    await notifyAgent(session, `set_channel_effort denied: ${callerId} is not an owner / admin of ${agent.name}.`);
    return;
  }

  const mgId = await resolveChannelMessagingGroupId(session, channelName);
  if (!mgId) {
    await notifyAgent(session, `set_channel_effort failed: channel ${channelName ?? '(current)'} not resolvable.`);
    return;
  }

  const wiring = await getMessagingGroupAgentByPair(mgId, agent.id);
  if (!wiring) {
    await notifyAgent(session, `set_channel_effort failed: channel ${channelName ?? mgId} is not wired to this agent.`);
    return;
  }

  const provider = resolveProviderName(
    session.agent_provider,
    (await getContainerConfig(agent.id))?.provider ?? agent.agent_provider,
  );
  const parsedEffort: ParsedChannelValue = effort === null ? { value: null } : parseChannelEffort(effort, provider);
  if (parsedEffort.error || (effort !== null && !parsedEffort.value)) {
    await notifyAgent(session, `set_channel_effort failed: ${parsedEffort.error ?? 'invalid effort'}.`);
    return;
  }
  const normalizedEffort = parsedEffort.value ?? null;

  await updateMessagingGroupAgent(wiring.id, { default_effort: normalizedEffort });
  log.info('Channel default_effort updated', {
    wiringId: wiring.id,
    agentGroupId: agent.id,
    messagingGroupId: mgId,
    effort: normalizedEffort,
    by: callerId,
  });
  const label = normalizedEffort === null ? 'cleared' : `set to ${normalizedEffort}`;
  // Best-effort, as above.
  void Promise.resolve(
    notifyAgent(
      session,
      `✅ Channel default_effort ${label} for ${channelName ?? 'current channel'}. Takes effect on next container spawn.`,
    ),
  ).catch((err) => log.warn('set_channel_effort notification failed', { wiringId: wiring.id, err }));
}

const CHANNEL_CONFIG_ACTION = unguarded(
  'handler derives the human caller from session input and enforces owner/admin authority before mutation',
);
registerDeliveryAction('set_channel_model', handleSetChannelModel, CHANNEL_CONFIG_ACTION);
registerDeliveryAction('set_channel_effort', handleSetChannelEffort, CHANNEL_CONFIG_ACTION);
