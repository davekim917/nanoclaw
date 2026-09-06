/**
 * Live attachment for a hand-created Slack app.
 *
 * Slack app tokens remain in the host's existing `.env` credential store. The
 * attach path writes that durable pair, registers the same workspace factory
 * used at boot, and starts it without a host restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { REPO_ROOT } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  assertSameWorkgroupWiring,
  createMessagingGroup,
  ensureAgentDestinationForWiring,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { centralTransaction } from '../db/central-lease.js';
import { getDb } from '../db/connection.js';
import { upsertEnvKeys } from '../env-file.js';
import { getOwners } from '../modules/permissions/db/user-roles.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import { registerSecrets, scrubSecrets } from '../secret-scrubber.js';
import { resolveOperatorSlackUserId } from '../slack-user-identity.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import { getActiveAdapters, getChannelAdapterExact, startChannelAdapter } from './channel-registry.js';
import { loadSlackWorkspaces, registerSlackWorkspace } from './slack.js';
import {
  appTokenKeyForChannelType,
  botTokenKeyForChannelType,
  slackChannelTypeForSlug,
  slackCall,
  slackConversationsOpen,
  slugForSlackChannelType,
} from './slack-lib.js';
import { getKnownSlackBots, type SlackBotIdentity } from './slack-mentions.js';

export type AddSlackWorkspaceInput = {
  instance: string;
  botToken: string;
  appToken: string;
  agentGroupId?: string;
};

export type SlackWorkspaceAttachment = {
  instance: string;
  channelType: string;
  teamId: string | null;
  botUserId: string | null;
  active: boolean;
};

export type SlackWorkspaceAttachResult = SlackWorkspaceAttachment & {
  status: 'started' | 'already-active';
  messagingGroupId?: string;
  wiringCreated?: boolean;
};

type ValidatedSlackIdentity = Pick<SlackBotIdentity, 'teamId' | 'userId'> & { botId: string };

let attachChain: Promise<void> = Promise.resolve();

function serializeAttach<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = attachChain;
  attachChain = previous.then(() => done);
  return previous.then(async () => {
    try {
      return await work();
    } finally {
      release();
    }
  });
}

function attachError(message: string): Error {
  // Do not retain a raw `cause`: callers and log serializers can walk causes,
  // and third-party errors are not a safe place to preserve supplied tokens.
  return new Error(scrubSecrets(message));
}

function validateToken(value: string, prefix: 'xoxb-' | 'xapp-', flag: string): void {
  if (!value.startsWith(prefix)) throw attachError(`${flag} must start with ${prefix}`);
  if (value.length <= prefix.length || /[\r\n'"]/.test(value)) {
    throw attachError(`${flag} has an invalid token shape`);
  }
}

function normalizeInstance(instance: string): string {
  if (typeof instance !== 'string' || instance.trim() === '') {
    throw attachError('--instance is required');
  }
  return normalizeName(instance);
}

/**
 * The current operator policy permits one attached bot per Slack team. Keep
 * the policy isolated here: changing it to permit sibling bots changes this
 * predicate without weakening same-instance identity checks below.
 */
export function duplicateSlackBotChannelType(
  channelType: string,
  identity: ValidatedSlackIdentity,
  knownBots: ReadonlyMap<string, Pick<SlackBotIdentity, 'teamId' | 'userId'>> = getKnownSlackBots(),
): string | null {
  for (const [knownChannelType, known] of knownBots) {
    if (knownChannelType !== channelType && known.teamId === identity.teamId) {
      return knownChannelType;
    }
  }
  return null;
}

async function validateSlackIdentity(botToken: string): Promise<ValidatedSlackIdentity> {
  try {
    const auth = await slackCall(botToken, 'auth.test', {}, 'hot-attach-auth-test');
    const teamId = typeof auth.team_id === 'string' ? auth.team_id : null;
    const userId = typeof auth.user_id === 'string' ? auth.user_id : null;
    const botId = typeof auth.bot_id === 'string' ? auth.bot_id : null;
    if (!teamId || !userId || !botId) throw attachError('Slack auth.test returned no team, bot user, or bot identity');
    return { teamId, userId, botId };
  } catch (err) {
    throw attachError(`Slack credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function rejectSymlinkedEnvFile(rootDir: string): void {
  const envPath = path.join(rootDir, '.env');
  try {
    const stat = fs.lstatSync(envPath);
    if (stat.isSymbolicLink()) throw attachError('.env must not be a symbolic link before attaching Slack credentials');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (err instanceof Error && err.message.startsWith('.env must not')) throw err;
    throw attachError('cannot inspect .env for Slack attachment');
  }
}

function writeWorkspaceTokens(rootDir: string, channelType: string, botToken: string, appToken: string): void {
  upsertEnvKeys(rootDir, {
    [botTokenKeyForChannelType(channelType)]: botToken,
    [appTokenKeyForChannelType(channelType)]: appToken,
  });
}

function attachmentFor(channelType: string, fallbackIdentity?: ValidatedSlackIdentity): SlackWorkspaceAttachment {
  const identity = getKnownSlackBots().get(channelType);
  return {
    instance: slugForSlackChannelType(channelType),
    channelType,
    teamId: identity?.teamId ?? fallbackIdentity?.teamId ?? null,
    botUserId: identity?.userId ?? fallbackIdentity?.userId ?? null,
    active: getChannelAdapterExact(channelType) !== undefined,
  };
}

async function validateInput(input: AddSlackWorkspaceInput): Promise<{ slug: string; channelType: string }> {
  if (typeof input.botToken !== 'string' || typeof input.appToken !== 'string') {
    throw attachError('--bot-token and --app-token are required');
  }
  validateToken(input.botToken, 'xoxb-', '--bot-token');
  validateToken(input.appToken, 'xapp-', '--app-token');
  if (input.agentGroupId !== undefined) {
    if (typeof input.agentGroupId !== 'string' || input.agentGroupId.trim() === '') {
      throw attachError('--agent-group-id must be a non-empty string');
    }
    if (!(await getAgentGroup(input.agentGroupId))) {
      throw attachError(`agent group not found: ${input.agentGroupId}`);
    }
  }
  const slug = normalizeInstance(input.instance);
  return { slug, channelType: slackChannelTypeForSlug(slug) };
}

async function openAndWireOwnerDm(
  agentGroupId: string,
  channelType: string,
  botToken: string,
): Promise<{ messagingGroupId: string; wiringCreated: boolean }> {
  const owners = await getOwners();
  const operator = resolveOperatorSlackUserId(
    owners.map((owner) => owner.user_id),
    channelType,
  );
  if (!operator) {
    throw attachError(`no owner Slack identity is available in workspace ${channelType}`);
  }

  let dmId: string;
  try {
    dmId = await slackConversationsOpen(botToken, [operator.slackUserId], 'hot-attach-open-owner-dm');
  } catch (err) {
    throw attachError(
      `could not open the owner DM for ${channelType}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const platformId = `slack:${dmId}`;
  const now = new Date().toISOString();
  const newMessagingGroup: MessagingGroup = {
    id: randomUUID(),
    channel_type: channelType,
    platform_id: platformId,
    instance: channelType,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now,
  };
  const newWiring: MessagingGroupAgent = {
    id: randomUUID(),
    messaging_group_id: newMessagingGroup.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now,
  };

  return centralTransaction(async () => {
    const messagingGroup = await getMessagingGroupByPlatform(channelType, platformId, channelType);
    const group = messagingGroup ?? newMessagingGroup;
    if (!messagingGroup) {
      await createMessagingGroup(group);
    }

    if (await getMessagingGroupAgentByPair(group.id, agentGroupId)) {
      return { messagingGroupId: group.id, wiringCreated: false };
    }
    const wiring = { ...newWiring, messaging_group_id: group.id };
    await assertSameWorkgroupWiring(group.id, agentGroupId);
    await getDb().run(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, default_model, default_effort, default_tone, instructions_profile, created_at
       ) VALUES (
         @id, @messaging_group_id, @agent_group_id, @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @default_model, @default_effort, @default_tone, @instructions_profile, @created_at
       )`,
      wiring,
    );
    await ensureAgentDestinationForWiring(wiring);
    return { messagingGroupId: group.id, wiringCreated: true };
  }, 'attach Slack owner DM');
}

async function addSlackWorkspaceInner(input: AddSlackWorkspaceInput): Promise<SlackWorkspaceAttachResult> {
  const { channelType } = await validateInput(input);

  rejectSymlinkedEnvFile(REPO_ROOT);
  const configuredWorkspace = loadSlackWorkspaces().find((workspace) => workspace.channelType === channelType);
  const wasActive = getChannelAdapterExact(channelType) !== undefined;
  // auth.test validates the bot token only. A failed Socket Mode start must
  // permit correcting its app token on an inactive instance.
  if (
    configuredWorkspace &&
    (configuredWorkspace.botToken !== input.botToken || (wasActive && configuredWorkspace.appToken !== input.appToken))
  ) {
    throw attachError(`Slack workspace ${channelType} already has stored credentials; refusing to replace them`);
  }

  const identity = await validateSlackIdentity(input.botToken);

  const activeIdentity = getKnownSlackBots().get(channelType);
  if (activeIdentity && (activeIdentity.teamId !== identity.teamId || activeIdentity.userId !== identity.userId)) {
    throw attachError(`active Slack workspace ${channelType} has a different bot identity; refusing to replace it`);
  }
  // A configured app may be offline, so the live identity cache alone cannot
  // prove that its team is available. Validate those saved bot tokens too.
  const knownBots = new Map<string, Pick<SlackBotIdentity, 'teamId' | 'userId'>>(getKnownSlackBots());
  for (const workspace of loadSlackWorkspaces()) {
    if (workspace.channelType === channelType || knownBots.has(workspace.channelType)) continue;
    registerSecrets({ botToken: workspace.botToken });
    knownBots.set(workspace.channelType, await validateSlackIdentity(workspace.botToken));
  }
  const duplicateChannelType = duplicateSlackBotChannelType(channelType, identity, knownBots);
  if (duplicateChannelType) {
    throw attachError(`Slack bot is already attached as ${duplicateChannelType}; use that instance instead`);
  }

  if (!configuredWorkspace || !wasActive) {
    writeWorkspaceTokens(REPO_ROOT, channelType, input.botToken, input.appToken);
  }

  let status: 'started' | 'already-active' = 'already-active';
  const persistedWorkspace = loadSlackWorkspaces().find((workspace) => workspace.channelType === channelType);
  if (
    !persistedWorkspace ||
    persistedWorkspace.botToken !== input.botToken ||
    persistedWorkspace.appToken !== input.appToken
  ) {
    throw attachError(`Slack workspace ${channelType} does not match the validated credentials after writing`);
  }
  if (!wasActive) {
    // Re-registering an inactive key is safe; doing so while active is
    // deliberately avoided. The factory receives only this freshly re-read
    // persisted object, never the CLI argument object.
    registerSlackWorkspace(persistedWorkspace);
    const startResult = await startChannelAdapter(channelType);
    if (startResult === 'no-credentials') {
      throw attachError(`Slack workspace ${channelType} did not expose credentials after attachment`);
    }
    status = startResult;
  }

  const result: SlackWorkspaceAttachResult = {
    ...attachmentFor(channelType, identity),
    status,
  };
  if (input.agentGroupId) {
    Object.assign(result, await openAndWireOwnerDm(input.agentGroupId, channelType, persistedWorkspace.botToken));
  }
  return result;
}

/** Attach one Socket Mode Slack app to the running host without a restart. */
export async function addSlackWorkspace(input: AddSlackWorkspaceInput): Promise<SlackWorkspaceAttachResult> {
  return serializeAttach(async () => {
    // Register supplied strings before every fallible operation so the CLI's
    // untrusted error surface can scrub them even when validation fails.
    if (typeof input.botToken === 'string' || typeof input.appToken === 'string') {
      registerSecrets({
        ...(typeof input.botToken === 'string' ? { botToken: input.botToken } : {}),
        ...(typeof input.appToken === 'string' ? { appToken: input.appToken } : {}),
      });
    }
    try {
      return await addSlackWorkspaceInner(input);
    } catch (err) {
      throw attachError(err instanceof Error ? err.message : 'Slack workspace attachment failed');
    }
  });
}

/** List configured Slack apps without returning token values. */
export function listSlackWorkspaces(): SlackWorkspaceAttachment[] {
  const configured = new Set(loadSlackWorkspaces().map((workspace) => workspace.channelType));
  for (const adapter of getActiveAdapters()) {
    if (adapter.channelType === 'slack' || adapter.channelType.startsWith('slack-')) {
      configured.add(adapter.instance ?? adapter.channelType);
    }
  }
  return [...configured].sort().map((channelType) => attachmentFor(channelType));
}
