/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getDb } from './db/connection.js';
import { persistInboundAttachments } from './attachment-downloader.js';
import { getChannelAdapter, getChannelDefaults, hasDeclaredChannelDefaults } from './channels/channel-registry.js';
import { resolveThreadPolicy, resolveUnknownSenderPolicy } from './channels/channel-defaults.js';
import { gateCommand, preFanoutGate, getInterceptHandler } from './command-gate.js';
import type { InterceptContext } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { ackInboundReceipt, isHumanChatSdkContent } from './task-list-host.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  channelNameProvenance,
  createMessagingGroup,
  createMessagingGroupAgentInTransaction,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
  updateMessagingGroup,
} from './db/messaging-groups.js';
import { centralTransaction } from './db/central-lease.js';
import { insertOrAdopt } from './db/insert-or-adopt.js';
import {
  claimChannelIngress,
  claimDeferredChannelIngress,
  completeChannelIngress,
  completeDeferredChannelIngress,
  deferChannelIngress,
  releaseChannelIngress,
  type ChannelIngressReceiptKey,
} from './db/channel-ingress-receipts.js';
import { findSessionForAgent, markSessionEngaged } from './db/sessions.js';
import { buildThreadContextBlock, withThreadContext } from './thread-context.js';
import { cancelPendingGatesForSession, sessionHasActiveGates } from './modules/bash-gate/index.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, sessionMessageExists, writeSessionMessageIfNew } from './session-manager.js';
import { withExistingNanoclawOutbound } from './modules/mailbox/index.js';
import { archiveMessage } from './message-archive.js';
import { parseMessageFlags, formatFlagConfirmation, type FlagIntent } from './flag-parser.js';
import { maybeRenameNewThread } from './topic-title.js';
import { sessionStillActive } from './container-runner.js';
import { requestWake } from './request-wake.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import type { AgentGroup, ChannelType, MessagingGroup, MessagingGroupAgent } from './types.js';
import { isChannelVariant } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

/**
 * The agent group a new messaging group in this workspace inherits for auto-wire, or null (approval gate).
 * Scope: Discord guild id; any other adapter its channel_type (Slack/GitHub/Linear variants carry the workspace).
 */
/**
 * Channel types carrying a tenant-scoped workspace id; without one, an unrelated tenant's fresh chat would
 * auto-claim the wrong agent.
 */
function adapterHasWorkspaceIdentity(channelType: string): boolean {
  // Discord: guild id parsed from platform_id; includes `discord-<suffix>` multi-bot variants.
  if (isDiscordChannelType(channelType)) return true;
  // Slack variants carry the workspace suffix; bare "slack" is ambiguous.
  if (isChannelVariant(channelType, 'slack' satisfies ChannelType)) return true;
  // `github-<owner>-<repo>` and `linear-<team>` carry their scope in the suffix.
  if (isChannelVariant(channelType, 'github' satisfies ChannelType)) return true;
  if (isChannelVariant(channelType, 'linear' satisfies ChannelType)) return true;
  return false;
}

/** The group's tone on this platform only if all its channels there agree; otherwise null (group default applies). */
async function unanimousToneFor(agentGroupId: string, channelType: string): Promise<string | null> {
  const rows = await getDb().all<{ tone: string | null }>(
    `SELECT DISTINCT mga.default_tone AS tone
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
        WHERE mga.agent_group_id = ? AND m.channel_type = ?`,
    agentGroupId,
    channelType,
  );
  return rows.length === 1 ? rows[0].tone : null;
}

/** The workspace stopped having one incumbent before the insert; leaves via the approval-gate path, not a warning. */
class AutoWireUniquenessLost extends Error {}

async function inheritedAgentGroupFor(
  mg: MessagingGroup,
): Promise<{ id: string; sourceMessagingGroupId: string } | null> {
  type InheritRow = { agent_group_id: string; messaging_group_id: string; cnt: number };
  let rows: InheritRow[];

  if (isDiscordChannelType(mg.channel_type) && mg.platform_id.startsWith('discord:')) {
    const guildId = mg.platform_id.split(':')[1];
    if (!guildId) return null;
    // Same channel_type (same bot): with multi-bot forks each bot inherits only its own wirings.
    rows = await getDb().all<InheritRow>(
      `SELECT mga.agent_group_id, MIN(mga.messaging_group_id) AS messaging_group_id, COUNT(*) AS cnt
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
         WHERE m.channel_type = ?
           AND m.platform_id LIKE ?
           AND m.id != ?
         GROUP BY mga.agent_group_id
         ORDER BY COUNT(*) DESC, MIN(m.created_at) ASC`,
      mg.channel_type,
      `discord:${guildId}:%`,
      mg.id,
    );
  } else if (adapterHasWorkspaceIdentity(mg.channel_type)) {
    rows = await getDb().all<InheritRow>(
      `SELECT mga.agent_group_id, MIN(mga.messaging_group_id) AS messaging_group_id, COUNT(*) AS cnt
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
         WHERE m.channel_type = ?
           AND m.id != ?
         GROUP BY mga.agent_group_id
         ORDER BY COUNT(*) DESC, MIN(m.created_at) ASC`,
      mg.channel_type,
      mg.id,
    );
  } else {
    // No workspace identity: refuse (the first chat from any tenant would auto-claim another tenant's agent).
    log.info('auto-wire refused: adapter has no workspace identity', { channelType: mg.channel_type });
    return null;
  }

  if (rows.length === 0) return null;
  // SECURITY: refuse when the workspace is wired to several agent groups, or one tenant's agent could claim
  // another's new channel.
  if (rows.length > 1) {
    log.info('auto-wire refused: workspace has wirings to multiple agent groups', {
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      candidates: rows.map((r) => r.agent_group_id),
    });
    return null;
  }
  return { id: rows[0].agent_group_id, sourceMessagingGroupId: rows[0].messaging_group_id };
}

/**
 * Whether THIS sibling bot answers an intercepted command: each sibling receives its own copy of a message, so
 * there is no fan-out loop to dedupe in. Addressed to this bot (mention or DM): yes. Another bot named: no. Nobody
 * named: exactly one sibling, the highest-priority wiring across same-platform-id siblings in the workgroup.
 */
async function isSoleInterceptResponder(
  mg: MessagingGroup,
  isMention: boolean,
  leadingMention: boolean,
): Promise<boolean> {
  if (isMention || mg.is_group === 0) return true;
  if (leadingMention) return false;

  const winner = await getDb().get<{ mg_id: string }>(
    `WITH my_wg AS (
         SELECT DISTINCT COALESCE(ag.workgroup_id, ag.folder) AS wg
         FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mga.messaging_group_id = ?
       )
       SELECT mg2.id AS mg_id
         FROM messaging_groups mg2
         JOIN messaging_group_agents mga2 ON mga2.messaging_group_id = mg2.id
         JOIN agent_groups ag2 ON ag2.id = mga2.agent_group_id
        WHERE mg2.platform_id = ?
          AND COALESCE(ag2.workgroup_id, ag2.folder) IN (SELECT wg FROM my_wg)
        GROUP BY mg2.id
        ORDER BY MAX(mga2.priority) DESC, mg2.channel_type ASC, mg2.id ASC
        LIMIT 1`,
    mg.id,
    mg.platform_id,
  );

  // No workgroup context to disambiguate: fail open so the request is answered, not dropped by every candidate.
  return winner === undefined || winner.mg_id === mg.id;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => Promise<string | null>;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string; replayPending?: boolean };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
  /** The thread THIS wiring replies on, already policy-stripped: a decline notice must honor the same thread policy. */
  effectiveThreadId: string | null,
) => AccessGateResult | Promise<AccessGateResult>;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/** Insert the auto-created messaging group, or adopt the row a concurrent route won (both can miss the lookup). */
export async function autoCreateMessagingGroup(
  mg: MessagingGroup,
  instance: string,
): Promise<{ mg: MessagingGroup; agentCount: number }> {
  // Carry the winner's wiring count out, so an adopted row keeps its wirings instead of reading 0.
  let adoptedAgentCount = 0;
  const { row, created } = await insertOrAdopt(mg, createMessagingGroup, async () => {
    const winner = await getMessagingGroupWithAgentCount(mg.channel_type, mg.platform_id, instance);
    if (!winner) return undefined;
    adoptedAgentCount = winner.agentCount;
    return winner.mg;
  });
  if (!created) return { mg: row, agentCount: adoptedAgentCount };
  log.info('Auto-created messaging group', { id: mg.id, channelType: mg.channel_type, platformId: mg.platform_id });
  return { mg: row, agentCount: 0 };
}

export type UnwiredChannelResolverFn = (
  event: InboundEvent,
  mg: MessagingGroup,
) => MessagingGroupAgent[] | Promise<MessagingGroupAgent[]>;

let unwiredChannelResolver: UnwiredChannelResolverFn | null = null;

export function setUnwiredChannelResolver(fn: UnwiredChannelResolverFn): void {
  if (unwiredChannelResolver) {
    log.warn('Unwired-channel resolver overwritten');
  }
  unwiredChannelResolver = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => Promise<AccessGateResult>;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When an interceptor returns true the message is
 * consumed and routing stops. Multiple interceptors may register; they run in
 * registration order and the first to claim the message (return true) wins.
 *
 * Used by modules to capture free-text DM replies during multi-step approval
 * flows — the permissions module (agent naming during channel registration)
 * and the approvals module (reject-with-reason capture).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

const messageInterceptors: MessageInterceptorFn[] = [];

export function registerMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptors.push(fn);
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay after approval. Its boolean result says whether this exact event was
 * persisted and must remain deferred.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<boolean>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

interface ParsedContent {
  text?: string;
  sender?: string;
  senderId?: string;
  /** Present when chat-sdk-bridge downloaded files with the message. */
  attachments?: unknown[];
}

function safeParseContent(raw: string): ParsedContent {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

export function isSlackChannelType(channelType: string): boolean {
  // Accepts bare 'slack' too (the default single-workspace adapter), unlike adapterHasWorkspaceIdentity.
  return channelType === 'slack' || isChannelVariant(channelType, 'slack' satisfies ChannelType);
}

/**
 * Discord channel-type predicate that tolerates multi-bot variants.
 *
 * Every Discord gate must accept `discord-<suffix>` multi-bot variants too, or a secondary bot silently loses
 * Discord-specific behavior.
 */
export function isDiscordChannelType(channelType: string): boolean {
  return channelType === 'discord' || isChannelVariant(channelType, 'discord' satisfies ChannelType);
}

/**
 * Slack DM thread-on-first-reply: convert a root DM address (`slack:<D-channel>:`) into
 * `slack:<D-channel>:<event.ts>` so each top-level DM gets its own session and replies thread under it. Done here
 * because the adapter's normalizer only covers bare `slack`, not this fork's `slack-<workspace>` adapters.
 */
function effectiveThreadIdForAgent(
  event: InboundEvent,
  adapterSupportsThreads: boolean,
  sessionMode: MessagingGroupAgent['session_mode'],
): string | null {
  if (!adapterSupportsThreads || sessionMode !== 'per-thread' || event.isDM !== true) {
    return event.threadId;
  }
  if (!isSlackChannelType(event.channelType) || !event.platformId.startsWith('slack:')) {
    return event.threadId;
  }
  if (!event.message.id) return event.threadId;

  const rootDmThreadIds = new Set<string | null>([null, '', event.platformId, `${event.platformId}:`]);
  if (!rootDmThreadIds.has(event.threadId)) return event.threadId;
  return `${event.platformId}:${event.message.id}`;
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  const receipt = receiptKey(event);
  if (!(await claimChannelIngress(receipt))) {
    log.debug('Duplicate channel event ignored before routing side effects', { ...receipt });
    return;
  }
  await routeClaimedInbound(event, receipt);
}

function receiptKey(event: InboundEvent): ChannelIngressReceiptKey {
  return {
    channelType: event.channelType,
    instance: event.instance ?? event.channelType,
    platformId: event.platformId,
    messageId: event.message.id,
  };
}

/** Replay only the event intentionally released by a completed approval. */
export async function replayDeferredInbound(event: InboundEvent): Promise<void> {
  const receipt = receiptKey(event);
  if (!(await claimDeferredChannelIngress(receipt))) {
    log.debug('Deferred channel event replay ignored because it is already claimed or completed', { ...receipt });
    return;
  }
  await routeClaimedInbound(event, receipt);
}

/** Resolve a denied or abandoned approval without allowing recovery to reopen it. */
export async function completeDeferredInbound(event: InboundEvent): Promise<void> {
  await completeDeferredChannelIngress(receiptKey(event));
}

async function routeClaimedInbound(event: InboundEvent, receipt: ChannelIngressReceiptKey): Promise<void> {
  let replayPending = false;
  try {
    await routeInboundClaimed(event, () => {
      replayPending = true;
    });
    if (replayPending) await deferChannelIngress(receipt);
    else await completeChannelIngress(receipt);
  } catch (err) {
    await releaseChannelIngress(receipt);
    throw err;
  }
}

async function routeInboundClaimed(event: InboundEvent, markReplayPending: () => void): Promise<void> {
  // Pre-route interceptors — let modules consume messages before any routing
  // (e.g. free-text DM replies during multi-step approval flows). They run in
  // registration order; the first to claim the message stops routing. The
  // sequential await is intentional — first-to-claim is order-dependent.
  for (const intercept of messageInterceptors) {
    if (await intercept(event)) return;
  }

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel. Resolved
  //    by the RECEIVING instance — sibling instances of one platform can
  //    differ in thread support.
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam. Exact-on-instance: an unknown named
  //    instance falls through to auto-create rather than hijacking a
  //    sibling instance's row.
  const found = await getMessagingGroupWithAgentCount(
    event.channelType,
    event.platformId,
    event.instance ?? event.channelType,
  );

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Unknown DM/group: default to group (mention) mode. DM-style means engage-on-everything, so an undeclared
    // adapter's group chat would answer every message.
    const isGroupChat = event.message.isGroup ?? (event.isDM === undefined ? true : event.isDM === false);
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      // Persist the receiving instance — without this, the first bot's row
      // would absorb every sibling instance's traffic.
      instance: event.instance ?? event.channelType,
      name: null,
      is_group: isGroupChat ? 1 : 0,
      // Undeclared adapters: public-by-default (fork policy; upstream would use 'request_approval').
      unknown_sender_policy: hasDeclaredChannelDefaults(event.instance ?? event.channelType, event.channelType)
        ? resolveUnknownSenderPolicy(event.instance ?? event.channelType, isGroupChat, event.channelType)
        : 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    const created = await autoCreateMessagingGroup(mg, event.instance ?? event.channelType);
    mg = created.mg;
    agentCount = created.agentCount;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    // Workspace-trust auto-wire: a workspace/guild that already has a wired channel wires a new one to its
    // incumbent agent group without an approval card. The first channel in a new workspace still escalates.
    const inheritedAgent = await inheritedAgentGroupFor(mg);
    if (inheritedAgent) {
      try {
        // Tone travels with the agent identity, but only when its channels on this platform AGREE (copying one
        // arbitrary wiring's tone guesses). Tone ONLY: model/effort are per-channel pins and must not spread.
        const inheritedTone = await unanimousToneFor(inheritedAgent.id, mg.channel_type);
        const isGroup = event.message.isGroup ?? mg.is_group === 1;
        const wiring: MessagingGroupAgent = {
          id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          messaging_group_id: mg.id,
          agent_group_id: inheritedAgent.id,
          // Groups default to plain mention; DMs always engage (Slack emits no reliable self-mention in DMs, so
          // mention mode would silently swallow unmentioned DM turns).
          engage_mode: isGroup ? 'mention' : 'pattern',
          engage_pattern: isGroup ? null : '.',
          session_mode: 'per-thread',
          priority: 0,
          sender_scope: 'all',
          ignored_message_policy: 'accumulate',
          default_model: null,
          default_effort: null,
          default_tone: inheritedTone,
          // Not inherited: channel instructions are one room's rules.
          instructions_profile: null,
          created_at: new Date().toISOString(),
        };
        // The uniqueness proof and the insert are ONE transaction: the workspace could gain a second agent group
        // while the tone lookup awaited, and a stale incumbent must not be wired past a gate that now says no.
        // Adopts a concurrent route's identical wiring instead of failing.
        await centralTransaction(async () => {
          const incumbent = await inheritedAgentGroupFor(mg);
          if (!incumbent || incumbent.id !== inheritedAgent.id) throw new AutoWireUniquenessLost();
          await insertOrAdopt(
            wiring,
            async (candidate) => {
              // The in-transaction leaf: the exported wrapper opens its own `centralTransaction`, and the lease
              // refuses to nest.
              await createMessagingGroupAgentInTransaction(candidate);
            },
            async () => (await getMessagingGroupAgents(mg.id)).find((w) => w.agent_group_id === inheritedAgent.id),
          );
        }, 'auto-wire uniqueness proof + wiring insert');
        log.info('Workspace-trust auto-wire', {
          messagingGroupId: mg.id,
          inheritedFrom: inheritedAgent.sourceMessagingGroupId,
          agentGroupId: inheritedAgent.id,
          channelType: event.channelType,
          platformId: event.platformId,
        });
        // Resolve the channel name as the approval path does (a NULL name hides the row from name-keyed queries).
        // Non-critical: never undo a wiring that already succeeded.
        try {
          if (adapter?.resolveChannelName) {
            const name = await adapter.resolveChannelName(mg.platform_id);
            // `classified` must outrank the generic metadata fetch's raw platform name.
            if (name) {
              await updateMessagingGroup(mg.id, {
                name,
                name_source: channelNameProvenance(mg.channel_type, 'classified'),
              });
            }
          }
        } catch {
          /* non-critical — the wiring stands either way */
        }
        return routeInboundClaimed(event, markReplayPending);
      } catch (err) {
        if (err instanceof AutoWireUniquenessLost) {
          log.info('auto-wire refused: workspace uniqueness was lost before the wiring landed', {
            messagingGroupId: mg.id,
            channelType: event.channelType,
            platformId: event.platformId,
            candidate: inheritedAgent.id,
          });
        } else {
          log.warn('Workspace-trust auto-wire failed — falling through to approval', {
            messagingGroupId: mg.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Env-var auto-wire (NANOCLAW_DEFAULT_AGENT_GROUP_<TYPE>): the resolver persists the wiring; [] falls through
    // to the approval gate.
    if (unwiredChannelResolver) {
      const wirings = await unwiredChannelResolver(event, mg);
      if (wirings.length > 0) {
        log.info('Env-var auto-wire', {
          messagingGroupId: mg.id,
          channelType: event.channelType,
          platformId: event.platformId,
          agentGroupIds: wirings.map((w) => w.agent_group_id),
        });
        return routeInboundClaimed(event, markReplayPending);
      }
    }

    const parsed = safeParseContent(event.message.content);
    await recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Defer only the exact event the approval row retains; later messages stay ordinary drops.
      try {
        if (await channelRequestGate(mg, event)) markReplayPending();
      } catch (err) {
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err });
      }
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? await senderResolver(event) : null;

  // 2a. Populate user_dms for inbound 1:1 DMs so DM-dependent gates don't deny a first DM. Requires isDM === true:
  //     is_group=0 is not proof of a DM (it defaults to 0 without adapter evidence), and caching a shared channel
  //     as a user's DM would poison DM resolution.
  if (userId !== null && event.isDM === true) {
    try {
      const { upsertUserDm } = await import('./modules/permissions/db/user-dms.js');
      await upsertUserDm({
        user_id: userId,
        channel_type: mg.channel_type,
        messaging_group_id: mg.id,
        resolved_at: new Date().toISOString(),
      });
    } catch (err) {
      // Permissions module not installed: non-fatal.
      log.debug('router: skipped user_dms upsert (permissions module unavailable)', { err: String(err) });
    }
  }

  // 2b. Pre-fan-out intercept gate: runs ONCE per inbound, before agents
  //     are resolved. Handles /dashboard-token and other INTERCEPT_COMMANDS.
  //     FILTERED commands are dropped. Unknown/ADMIN commands fall through.
  if (userId !== null && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    const preGate = await preFanoutGate(event.message.content, userId);
    if (preGate.action === 'intercept' || preGate.action === 'deny') {
      // Each sibling bot gets its OWN inbound event for one platform message, so only one sibling may intercept.
      if (!(await isSoleInterceptResponder(mg, isMention, preGate.leadingMention === true))) {
        log.debug('Pre-fanout intercept skipped — not the addressed or deterministic sibling', {
          command: preGate.command,
          messagingGroupId: mg.id,
        });
        return;
      }
    }
    if (preGate.action === 'intercept') {
      const handler = getInterceptHandler(preGate.handlerName);
      if (handler) {
        const ctx: InterceptContext = {
          userId,
          replyMessagingGroupId: mg.id,
          command: preGate.command,
          args: preGate.args,
        };
        try {
          await Promise.race([
            handler(ctx),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('intercept handler timeout')), 5000)),
          ]);
        } catch (err) {
          const isTimeout = err instanceof Error && err.message === 'intercept handler timeout';
          if (isTimeout) {
            log.warn('Intercept handler timed out', { handlerName: preGate.handlerName, command: preGate.command });
          } else {
            log.error('Intercept handler threw', {
              handlerName: preGate.handlerName,
              command: preGate.command,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        log.warn('No intercept handler registered', { handlerName: preGate.handlerName });
      }
      return;
    }
    if (preGate.action === 'filter') {
      log.debug('Pre-fanout filtered command dropped');
      return;
    }
    if (preGate.action === 'deny') {
      log.info('Pre-fanout intercept denied (not admin)', { command: preGate.command, userId });
      // A user without a role gets a short, non-leaky refusal rather than silence.
      const deliveryAdapter = getDeliveryAdapter();
      if (deliveryAdapter) {
        await deliveryAdapter
          .deliver(
            mg.channel_type,
            mg.platform_id,
            event.threadId,
            'chat',
            JSON.stringify({ text: `You don't have access to run ${preGate.command}. Ask an admin to add you.` }),
          )
          .catch((err) => {
            log.warn('Pre-fanout deny reply failed to deliver', { command: preGate.command, err: String(err) });
          });
      }
      return;
    }
    // 'pass' — fall through to fan-out
  }

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = await getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  // Per-wiring thread policy inputs, resolved once per event. Each wiring's
  // threads override (NULL = inherit) resolves against the channel's declared
  // defaults, hard-bounded by the live adapter's raw capability. Undeclared
  // adapters resolve through the behavior-faithful fallback, so a NULL-threads
  // wiring reproduces the historical supportsThreads-derived routing exactly.
  const channelDefaults = getChannelDefaults(mg.instance ?? mg.channel_type, mg.channel_type);
  const supportsThreads = adapter?.supportsThreads === true;

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = await getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    // Effective thread id for THIS wiring: the event-derived address is
    // policy-stripped when the wiring (or its channel declaration) opts out
    // of threads. event.replyTo is operator intent from the CLI admin
    // transport and is never nulled. Guard: platform thread ids must never
    // collide with the reserved 'system:%' session namespace
    // (src/db/sessions.ts) — they are platform-native identifiers, and this
    // is the only place an inbound thread id enters session resolution.
    const threadsEnabled = resolveThreadPolicy(
      agent.threads ?? null,
      channelDefaults,
      mg.is_group === 1,
      supportsThreads,
    );
    const effectiveThreadId = threadsEnabled ? event.threadId : null;

    const engages = await evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId, supportsThreads);

    const accessDecision =
      engages && accessGate ? await accessGate(event, userId, mg, agent.agent_group_id, effectiveThreadId) : null;
    if (accessDecision && !accessDecision.allowed && accessDecision.replayPending) markReplayPending();
    const accessOk = engages && (!accessDecision || accessDecision.allowed);
    const scopeOk = engages && (!senderScopeGate || (await senderScopeGate(event, userId, mg, agent)).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        threadsEnabled,
        effectiveThreadId,
        true,
        parsed,
        adapter,
      );
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Uses this wiring's OWN effective thread
      // id — a non-null value already implies the adapter supports threads
      // (resolveThreadPolicy hard-ANDs the capability). DMs, non-threaded
      // platforms, and thread-opted-out wirings skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.subscribe &&
        effectiveThreadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, effectiveThreadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: effectiveThreadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        threadsEnabled,
        effectiveThreadId,
        false,
        parsed,
        adapter,
      );
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    await recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
async function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
  adapterSupportsThreads: boolean,
): Promise<boolean> {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-pattern': {
      // Both a platform @-mention AND a pattern match: siblings sharing one bot user pick by keyword.
      if (!isMention) return false;
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention-sticky': {
      if (isMention) return true;
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      // Threaded adapters: a channel-root message must not stick (a fresh @mention starts a thread).
      if (adapterSupportsThreads && threadId === null) return false;
      // The stick is ENGAGEMENT (`engaged_at`), not session existence: any path can create a session row.
      const existing = await findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing?.engaged_at != null;
    }
    default:
      return false;
  }
}

/**
 * Mirror an inbound user message into archive.db (assistant replies are archived on delivery). An upsert, so both
 * paths may call it. The return value is a precondition for the non-engaged skip, not diagnostics.
 */
function archiveInboundUserMessage(
  agent: MessagingGroupAgent,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  parsedContent: ParsedContent,
  effectiveThreadId: string | null,
): boolean {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!parsedContent.text) return false;
  try {
    archiveMessage({
      id: messageIdForAgent(event.message.id, agent.agent_group_id),
      agentGroupId: agent.agent_group_id,
      messagingGroupId: mg.id,
      channelType: event.channelType,
      channelName: mg.name ?? null,
      platformId: event.platformId,
      threadId: effectiveThreadId,
      role: 'user',
      senderId: userId,
      senderName: parsedContent.sender ?? null,
      text: parsedContent.text,
      sentAt: event.message.timestamp,
    });
    return true;
  } catch (err) {
    log.warn('Failed to archive inbound user message', {
      agentGroupId: agent.agent_group_id,
      platformMessageId: event.message.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * THE scope line for the non-engaged session skip: currently every sender (a session should not exist until an
 * agent is engaged). To narrow to bots, never test the platform-id prefix (Slack bot events carry `U…` ids); use
 * the author's `isBot` flag and the known sibling-bot id set.
 */
function skipEligibleSender(_parsedContent: ParsedContent, _userId: string | null): boolean {
  return true;
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  threadsEnabled: boolean,
  effectiveThreadId: string | null,
  wake: boolean,
  parsedContent: ParsedContent,
  adapter: ReturnType<typeof getChannelAdapter>,
): Promise<void> {
  // Apply the resolved thread policy (wiring override AND channel declaration
  // AND adapter capability — resolveThreadPolicy at fanout): thread-enabled
  // wiring in a group chat → per-thread session regardless of wiring
  // session_mode. agent-shared preserved (it's a cross-channel directive the
  // adapter doesn't know about). Root Slack DMs may synthesize a thread id
  // below when the wiring is per-thread (fork feature).
  let effectiveSessionMode = agent.session_mode;
  if (threadsEnabled && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  // Fork: synthesize a per-thread id for root Slack DMs, reassigning the policy-resolved address so session
  // resolution and delivery agree.
  if (threadsEnabled) {
    effectiveThreadId = effectiveThreadIdForAgent(event, true, effectiveSessionMode);
  }

  // A non-waking message does not mint a per-thread session (a session means "an agent is engaged here"). Sound
  // only where the wake path can reconstruct it: this mirrors the thread-context backfill (same kinds, thread
  // policy and adapter capability), which replays the thread while `engaged_at` is NULL. NOT skipped: messages
  // with attachments (replay recovers no files) and anything the archive refused. The archive call below is what
  // the skip DEPENDS ON (the message's only remaining copy), so it runs LAST and a `false` falls through to session
  // creation; never make it fire-and-forget. Accepted replay gaps: the 50-message cap, Slack's uncursored
  // `conversations.replies` (a very long thread replays its start), and edits/deletes shown as they now stand.
  if (
    !wake &&
    skipEligibleSender(parsedContent, userId) &&
    !parsedContent.attachments?.length &&
    (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') &&
    threadsEnabled &&
    effectiveSessionMode === 'per-thread' &&
    effectiveThreadId !== null &&
    typeof adapter?.fetchThreadHistory === 'function' &&
    (await findSessionForAgent(agent.agent_group_id, mg.id, effectiveThreadId)) === undefined &&
    archiveInboundUserMessage(agent, mg, event, userId, parsedContent, effectiveThreadId)
  ) {
    log.debug('Skipped session creation for non-engaged thread message', {
      agentGroupId: agent.agent_group_id,
      messagingGroupId: mg.id,
      threadId: effectiveThreadId,
      platformMessageId: event.message.id,
    });
    return;
  }

  const { session, created } = await resolveSession(
    agent.agent_group_id,
    mg.id,
    effectiveThreadId,
    effectiveSessionMode,
  );
  const routedMessageId = messageIdForAgent(event.message.id, agent.agent_group_id);

  // Old session DBs predate the receipt table: re-check the per-session id before any side effect (this also makes
  // a partial fan-out retry harmless).
  if (await sessionMessageExists(agent.agent_group_id, session.id, routedMessageId)) {
    log.debug('Duplicate session message ignored before agent side effects', {
      sessionId: session.id,
      agentGroup: session.agent_group_id,
      platformMessageId: event.message.id,
    });
    return;
  }

  // A follow-up to a session with a pending bash/destructive gate implicitly rejects it so the turn can end.
  if (!created && sessionHasActiveGates(session.id)) {
    cancelPendingGatesForSession(session.id, 'Cancelled — user sent a follow-up message.').catch((err) => {
      log.warn('cancelPendingGatesForSession failed', { sessionId: session.id, err });
    });
  }

  // Title freshly created Discord threads (src/topic-title.ts). Gated on `wake`: a non-engaging accumulate sibling
  // must not clobber the engaged sibling's title.
  if (created && wake) {
    const firstText = parsedContent.text ?? '';
    if (firstText) await maybeRenameNewThread(event.channelType, effectiveThreadId, firstText, event.message.id);
  }

  const persistedContent = persistInboundAttachments(
    agent.agent_group_id,
    session.id,
    routedMessageId,
    event.message.content,
  );

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event, with the wiring's thread policy applied). When
  // the caller supplied `replyTo` (CLI admin transport acting on operator
  // intent), the reply is redirected there — replyTo is exempt from
  // thread-policy stripping.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: effectiveThreadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = await gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      // Outbound-keyed and existing-only: never provision a mailbox for a denial, and an inbound-keyed funnel would
      // answer `undefined` when inbound.db was reclaimed but outbound.db remains, dropping the reply.
      await withExistingNanoclawOutbound(session.agent_group_id, session.id, (outbound) =>
        outbound.writeOutboundDirect({
          id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          platformId: deliveryAddr.platformId,
          channelType: deliveryAddr.channelType,
          threadId: deliveryAddr.threadId,
          content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
        }),
      );
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  // The host posts the flag confirmation directly and attaches structured intent (the container never re-parses).
  // Only when `wake`: a sibling's accumulate path must not echo or store flags meant for another agent.
  let flagIntent: FlagIntent | undefined;
  let flagCleanedText: string | null = null;
  // The posted ⚙️ ack's settings line, so the runner can say "queued" in the same words; only for rows a person typed.
  let flagAck: string | undefined;
  if (wake && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    const rawText = parsedContent.text ?? '';
    // Flag vocabulary is provider-specific; precedence mirrors spawn, with agent_groups.agent_provider filling the
    // gap for groups created mid-run (no container_configs row until the next restart).
    const provider = resolveProviderName(
      session.agent_provider,
      (await getContainerConfig(session.agent_group_id))?.provider ?? agentGroup.agent_provider,
    );
    const parsed = parseMessageFlags(rawText, provider);
    if (parsed.intent || parsed.errors.length > 0 || parsed.warnings.length > 0) {
      flagIntent = parsed.intent;
      flagCleanedText = parsed.cleanedText;
      const notice = formatFlagConfirmation(parsed.intent ?? {}, parsed.warnings, parsed.errors);
      if (notice) {
        const settingsLine = notice.split('\n')[0];
        if (parsed.intent && settingsLine.startsWith('⚙️')) flagAck = settingsLine;
        // Outbound-keyed, as for the denial notice above.
        await withExistingNanoclawOutbound(session.agent_group_id, session.id, (outbound) =>
          outbound.writeOutboundDirect({
            id: `flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({ text: notice }),
          }),
        );
      }
    }
  }

  // On engaged mentions in a thread, prepend recent platform thread history (the cutoff rule is shared with the
  // agent-to-agent wake path in src/thread-context.ts).
  let contentForWrite = persistedContent;
  if (flagIntent || flagCleanedText !== null) {
    const parsed = JSON.parse(contentForWrite) as Record<string, unknown>;
    if (flagCleanedText !== null) parsed.text = flagCleanedText;
    if (flagIntent) parsed.flagIntent = flagIntent;
    if (flagAck) parsed.flagAck = flagAck;
    contentForWrite = JSON.stringify(parsed);
  }
  if (
    wake &&
    threadsEnabled &&
    effectiveThreadId !== null &&
    (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')
  ) {
    // `session` predates `markSessionEngaged` below, so `engaged_at` is the pre-wake state the backfill asks about.
    contentForWrite = withThreadContext(
      contentForWrite,
      await buildThreadContextBlock({
        session,
        adapter,
        threadId: effectiveThreadId,
        excludeMessageId: event.message.id,
      }),
    );
  }

  // Start typing indicator before writeSessionMessage so recall injection
  // latency doesn't delay visible feedback on chat/chat-sdk paths.
  if (wake && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      event.channelType,
      event.platformId,
      effectiveThreadId,
      mg.instance,
    );
  }

  // Archive BEFORE the session write: the pre-turn recall row resolves sender names from messages_archive, so a
  // thread's first sender would otherwise be unnamed until their second message.
  archiveInboundUserMessage(agent, mg, event, userId, parsedContent, effectiveThreadId);

  const inserted = await writeSessionMessageIfNew(
    session.agent_group_id,
    session.id,
    {
      id: routedMessageId,
      kind: event.message.kind,
      timestamp: event.message.timestamp,
      platformId: deliveryAddr.platformId,
      channelType: deliveryAddr.channelType,
      messagingGroupId: mg.id,
      threadId: deliveryAddr.threadId,
      content: contentForWrite,
      trigger: wake ? 1 : 0,
    },
    // The only write that may stamp platform_msg_id. `event.message.id` is set for every event, including
    // host-synthesized ones; only `nativeId` is trust-bearing (genuine adapter ingress only).
    { platformMessageId: event.message.nativeId },
  );
  if (!inserted) {
    if (wake) stopTypingRefresh(session.id);
    log.debug('Duplicate routed message ignored', {
      sessionId: session.id,
      agentGroup: session.agent_group_id,
      platformMessageId: event.message.id,
    });
    return;
  }

  // Stamped AFTER the backfill read (needs pre-wake state) and the write (a failed or duplicate insert never engages).
  if (wake) await markSessionEngaged(session.id);
  // The 👀 receipt only once durable, and only for a live human message (not a replayed one).
  if (wake && !event.recovered && isHumanChatSdkContent(event.message.kind, event.message.content)) {
    ackInboundReceipt(event.channelType, event.platformId, effectiveThreadId, event.message.id, mg.instance);
  }

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // For non-chat kinds, typing indicator fires here (after write) as before.
    // Typing fires via the adapter instance that owns this chat's row.
    if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') {
      startTypingRefresh(
        session.id,
        session.agent_group_id,
        event.channelType,
        event.platformId,
        effectiveThreadId,
        mg.instance,
      );
    }
    {
      // Priority is applied atomically inside the wake; the liveness proof is the wake's own guard.
      const woke = await requestWake(session, 'inbound-message', {
        priority: 'interactive',
        guard: sessionStillActive(session.id),
      });
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(session.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
