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
 *   3. Per-agent container.json: model / effort, then defaultModel / defaultEffort
 *   4. Install-wide DEFAULT_OPUS_MODEL in src/flag-parser.ts (single source of
 *      truth for "default"); effort has no install-wide constant — with no
 *      override the claude provider applies its per-model-family default.
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

/**
 * Resolve the target channel for the mutation. If `channelName` is given,
 * look it up in the session's destinations map (inbound.db). Otherwise
 * use the session's own messaging_group. Returns null if unresolved.
 */
async function resolveChannelMessagingGroupId(
  session: Session,
  channelName: string | undefined,
): Promise<string | null> {
  if (!channelName) {
    return session.messaging_group_id ?? null;
  }
  // Look up the destination by name from inbound.db's destinations table
  // (host writes this before each container wake; container reads it
  // live). type='channel' rows carry channel_type + platform_id; map
  // those back to a messaging_group id. Its own short mailbox session:
  // delivery holds none while a handler runs (plan §4.5b), and a session with
  // no mailbox has no destinations map to resolve against.
  const row = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getChannelDestination(channelName),
  );
  if (!row?.channel_type || !row.platform_id) return null;
  // destinations lives in the session's inbound.db (host writes it at
  // wake). messaging_groups lives in central v2.db — cross-DB join by
  // (channel_type, platform_id).
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
 * Channel defaults use the same provider-aware vocabulary as chat flags.
 * Codex's friendly `luna`/`terra`/`sol` names are normalized to gpt-* ids;
 * other providers retain their existing model strings for forward-compatible
 * SDK ids. Effort is validated for every provider so `max`/`ultra` cannot be
 * written to a Claude or OpenCode wiring by accident.
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
  // model: string = set, null = clear, anything else = reject
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
  // Best-effort: updateMessagingGroupAgent above already committed. This is a
  // system-action delivery handler — an awaited rejection here would leave
  // the message undelivered, so the delivery loop retries the whole handler
  // (re-applying an already-applied model change) rather than just
  // re-attempting the notification.
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
  // Best-effort — see the matching comment in handleSetChannelModel above.
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

// Export for testing.
export { deriveCallerId as _deriveCallerId, resolveChannelMessagingGroupId as _resolveChannelMessagingGroupId };
