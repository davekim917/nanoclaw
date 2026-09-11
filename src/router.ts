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
 * Resolve "what agent group should a new messaging_group in this workspace
 * inherit from?" for workspace-trust auto-wire. Returns null when the
 * workspace/guild has no prior wiring — those stay on the approval-gate path.
 *
 * Scope key:
 *   Slack: channel_type (e.g. "slack-example-labs") — already includes the workspace.
 *   Discord: guild id (first segment of "discord:<guildId>:<channelId>") — channel_type
 *     is just "discord" and doesn't differentiate guilds.
 *   Other: channel_type.
 *
 * Picks the agent_group with the most wirings in-scope (breaks ties by first
 * match). The caller creates the messaging_group_agents row using this id.
 */
/**
 * Channel types that embed a workspace/guild identifier strong enough to make
 * "first agent wired in this scope wins" auto-wire safe. Other adapters
 * (Telegram, WhatsApp, Webex, etc.) don't have a tenant-scoped identifier
 * baked into the channel_type, so a fresh chat from an unrelated tenant
 * would auto-claim the wrong agent. Those fall through to the approval gate.
 */
function adapterHasWorkspaceIdentity(channelType: string): boolean {
  // Discord: handled separately (guild id parsed from platform_id).
  // Includes multi-bot variants (`discord-<suffix>`) for forks running
  // multiple Discord apps in one process.
  if (isDiscordChannelType(channelType)) return true;
  // Slack channel types are stamped with the workspace suffix
  // ("slack-<workspace>"); bare "slack" without suffix is ambiguous.
  if (isChannelVariant(channelType, 'slack' satisfies ChannelType)) return true;
  // GitHub repo and Linear team are workspace-scoped via their adapter's
  // channel_type suffix convention (`github-<owner>-<repo>`, `linear-<team>`).
  if (isChannelVariant(channelType, 'github' satisfies ChannelType)) return true;
  if (isChannelVariant(channelType, 'linear' satisfies ChannelType)) return true;
  return false;
}

/**
 * The tone this agent group uses on this platform, but only when every one of
 * its existing channels there agrees. Returns null when they differ (or when
 * they unanimously have none), so the wiring falls through to the group
 * default rather than adopting an arbitrary channel's override.
 */
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

/**
 * The workspace stopped having exactly one incumbent between the auto-wire
 * decision and its insert (#482).
 *
 * Thrown so the refusal leaves through the caller's existing "could not
 * auto-wire" path — the operator approval gate — rather than duplicating that
 * fall-through. Distinguished from a real failure at the catch, because a race
 * lost on purpose is not an error to warn about.
 */
class AutoWireUniquenessLost extends Error {}

async function inheritedAgentGroupFor(
  mg: MessagingGroup,
): Promise<{ id: string; sourceMessagingGroupId: string } | null> {
  type InheritRow = { agent_group_id: string; messaging_group_id: string; cnt: number };
  let rows: InheritRow[];

  if (isDiscordChannelType(mg.channel_type) && mg.platform_id.startsWith('discord:')) {
    const guildId = mg.platform_id.split(':')[1];
    if (!guildId) return null;
    // Scope the lookup to the same channel_type (same bot identity). With
    // multi-bot forks, example-agent + example-agent-codex can both have wirings in the same
    // guild — they're separate bots, so a fresh channel under one bot should
    // inherit only that bot's wirings, not the other's.
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
    // Adapter without workspace identity — refuse auto-wire. Falls through
    // to the operator approval gate (channel-registration). Without this
    // guard, the first Telegram chat from any tenant would auto-claim the
    // agent already wired for a different Telegram chat (cross-tenant).
    log.info('auto-wire refused: adapter has no workspace identity', { channelType: mg.channel_type });
    return null;
  }

  if (rows.length === 0) return null;
  // SECURITY: refuse auto-wire when the workspace/guild has wirings to
  // multiple distinct agent groups. The original "most existing wirings
  // wins" heuristic would let the wrong tenant's agent claim a freshly
  // created channel intended for another tenant — falls through to the
  // operator approval gate instead.
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
 * Decide whether THIS messaging group's sibling bot is the one that should
 * act on an intercepted command (Bug: fan-out duplication — see routeInboundClaimed
 * section 2b). Sibling agents in one workgroup each run their own bot user /
 * channel_type "instance" (docs/workgroups.md), so a single Slack message
 * reaches the router once PER sibling as a separate InboundEvent/mg — there is
 * no single fan-out loop across them to dedupe within.
 *
 *  - Addressed straight at this bot (platform-confirmed mention, or a DM/1:1
 *    context) — always eligible; reuses the same `isMention` signal the
 *    fan-out loop's evaluateEngage() uses for engage_mode='mention', no
 *    second mention parser.
 *  - The raw text named a bot but not this one (`leadingMention` true and we
 *    weren't the addressee) — not our command to answer.
 *  - Nobody was named (bare "/command" that every sibling bot in the channel
 *    receives its own copy of) — exactly one sibling answers so the user
 *    isn't left on read: the wiring with the highest `priority` across every
 *    sibling messaging_group sharing this platform_id and workgroup, tied
 *    broken by channel_type then messaging_group id (stable, no clock).
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

  // No workgroup context to disambiguate against (standalone install, or the
  // wiring/agent-group rows raced) — fail open so the request still gets
  // answered rather than silently dropped by every candidate.
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
  /**
   * The thread address THIS wiring would reply on — `event.threadId` already
   * policy-stripped by resolveThreadPolicy (null when the wiring or its
   * channel declaration opts out of threads, or the adapter can't thread).
   *
   * The gate needs it because a refusal can still speak to the sender
   * (decline_notify), and a bot-authored reply has to honor the same thread
   * policy the agent's replies do — otherwise a wiring that deliberately
   * collapses DM sub-threads to the root gets its declines posted inside
   * them. Passed in rather than recomputed: fanout has already resolved it
   * for this wiring, and duplicating the computation is how the two sides
   * drift.
   */
  effectiveThreadId: string | null,
) => AccessGateResult | Promise<AccessGateResult>;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Unwired-channel resolver hook. Runs only when a messaging group has zero
 * agents wired. A module can opt-in to auto-wire the first message to a
 * default agent group — see `src/modules/channel-auto-wire/`. The resolver
 * is expected to persist a `messaging_group_agents` row as a side effect
 * so subsequent messages resolve via the normal path; returning an empty
 * array falls through to the standard "no agent wired" drop.
 */
/**
 * Insert the auto-created messaging group, or adopt the row a concurrent route
 * won with. The lookup above yields (async driver), so two addressed messages
 * for a never-seen channel can both see no row and both insert on the same
 * `(channel_type, platform_id, instance)` unique key; the loser re-reads the
 * winner instead of aborting its route — the same shape as
 * `resolveActiveSession` in db/scheduled-tasks.ts. Exported for its test.
 */
export async function autoCreateMessagingGroup(
  mg: MessagingGroup,
  instance: string,
): Promise<{ mg: MessagingGroup; agentCount: number }> {
  // `getMessagingGroupWithAgentCount` returns the row AND its wiring count,
  // but the primitive's `reload` is row-shaped — carry the count out sideways
  // so the adopted row keeps the wirings the winner may already have, instead
  // of the 0 a freshly-inserted row has.
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

export function getUnwiredChannelResolver(): UnwiredChannelResolverFn | null {
  return unwiredChannelResolver;
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
  // Bare 'slack' AND workspace variants — the default single-workspace Slack
  // adapter uses bare 'slack', so this predicate must accept both (unlike
  // adapterHasWorkspaceIdentity, which is deliberately variant-only).
  return channelType === 'slack' || isChannelVariant(channelType, 'slack' satisfies ChannelType);
}

/**
 * Discord channel-type predicate that tolerates multi-bot variants.
 *
 * Forks running multiple Discord apps in one process tag the secondary
 * adapter with a suffix (`discord-<suffix>`) so dedupe keyspaces don't
 * collide. Every Discord-flavored gate in this file must accept both
 * bare `discord` and `discord-*`, otherwise the secondary bot would
 * silently lose Discord-specific behavior (guild-id auto-wire,
 * mention-sticky engage default, etc.).
 */
export function isDiscordChannelType(channelType: string): boolean {
  return channelType === 'discord' || isChannelVariant(channelType, 'discord' satisfies ChannelType);
}

/**
 * Slack DM thread-on-first-reply.
 *
 * @chat-adapter/slack represents a root DM with no thread_ts as
 * `slack:<D-channel>:`. The chat-sdk bridge has a Slack-only normalizer for
 * bare `adapter.name === 'slack'`, but this fork intentionally renames
 * multi-workspace Slack adapters to `slack-<workspace>` so dedupe keys don't
 * collide. There is no slack.ts config knob for "use event.ts as thread_ts".
 *
 * Do the minimum router-level synthesis for per-thread Slack DMs: convert a
 * root DM address into Slack's encoded thread id `slack:<D-channel>:<event.ts>`.
 * That gives each top-level DM message its own session and makes outbound
 * replies post under the user's message. The scope is deliberately Slack-only;
 * other threaded adapters keep their adapter-provided thread id unchanged.
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
    // Adapter tells us whether this is a DM or a group chat — prefer the
    // explicit message.isGroup, then the isDM inverse. When BOTH are
    // unknown (an adapter that declares neither), default to group/mention
    // mode, not DM-style: downstream, is_group=0 resolves to
    // engage_pattern='.' (always-engage on every message), so defaulting
    // unknown to DM-style would make an actual group chat on an
    // undeclared adapter reply to everything in the channel unprompted.
    // Defaulting to group/mention mode instead means the worst case is a
    // real DM that needs an explicit mention until the operator notices
    // and flips it — the safe direction to be wrong in.
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
      // Declared adapters get their declared policy (DM vs group context).
      // Fork policy for UNDECLARED adapters: public-by-default — any sender
      // in the channel can mention the bot without a separate sender-approval
      // cascade (sibling gate + auto-wire flow, 2026-05-13); upstream's
      // faithful fallback would be 'request_approval'. Operator can lock
      // individual channels down later via messaging_groups.unknown_sender_policy.
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

    // Workspace-trust auto-wire: if the workspace (Slack channel_type suffix)
    // or Discord guild already has at least one wired channel, we know the
    // owner trusts the bot in that workspace — wire the new channel to the
    // incumbent agent group without an approval card. Matches v1 behavior
    // where adding the bot to a new channel in an already-installed workspace
    // "just worked." First channel in a new workspace/guild still escalates.
    const inheritedAgent = await inheritedAgentGroupFor(mg);
    if (inheritedAgent) {
      try {
        // Voice travels with the agent identity, so a channel auto-wired from
        // an existing one inherits its tone. Without this every auto-wired
        // channel ran with NO tone injection while the hand-wired ones kept
        // theirs, so one agent sounded like two different agents depending on
        // which of its channels you were in (owner report 2026-08-08).
        //
        // Only when the agent's existing channels AGREE. Copying one arbitrary
        // wiring guesses: `inheritedAgentGroupFor` returns MIN(messaging_group_id),
        // which has nothing to do with which channel is representative, so on a
        // platform where tone varies per channel it propagates whichever row
        // sorted first. Verified 2026-08-08: a new Discord guild channel would
        // have inherited the casual tone set on the one channel deliberately
        // different from every other. Disagreement means we don't know, so
        // leave NULL and let the group default in container.json answer.
        //
        // Tone ONLY: default_model / default_effort are sticky per-channel
        // operational pins (`-m` / `-e` persist), and spreading one channel's
        // pin to every future channel is a worse bug than the one this fixes.
        const inheritedTone = await unanimousToneFor(inheritedAgent.id, mg.channel_type);
        const isGroup = event.message.isGroup ?? mg.is_group === 1;
        const wiring: MessagingGroupAgent = {
          id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          messaging_group_id: mg.id,
          agent_group_id: inheritedAgent.id,
          // Group chats default to plain mention so each invocation is
          // intentional. DMs always engage: Slack does not require or reliably
          // emit a self-mention there, so persisting mention mode makes later
          // unmentioned DM turns silently accumulate without waking the agent.
          // mention-sticky stays available as an explicit group override.
          engage_mode: isGroup ? 'mention' : 'pattern',
          engage_pattern: isGroup ? null : '.',
          session_mode: 'per-thread',
          priority: 0,
          sender_scope: 'all',
          ignored_message_policy: 'accumulate',
          default_model: null,
          default_effort: null,
          default_tone: inheritedTone,
          // Not inherited the way tone is: channel instructions are the rules
          // of a specific room, so carrying them into a brand-new room would
          // silently extend a scoped rule set past its scope.
          instructions_profile: null,
          created_at: new Date().toISOString(),
        };
        // The uniqueness proof and the insert are ONE transaction (#482).
        //
        // `inheritedAgentGroupFor` refuses a workspace wired to more than one
        // agent group — that refusal is the whole reason a second tenant's
        // channel cannot be auto-claimed. But it ran before the tone lookup and
        // before this insert, both of which await, and another channel in the
        // same workspace can be wired to a DIFFERENT agent in that window. The
        // insert would then connect a new channel to a stale incumbent, past a
        // gate that has since started saying no, with no approval anywhere.
        //
        // So it is re-run here, on the lease that also carries the insert, and
        // the row goes in only while its own precondition still holds. The
        // check excludes this messaging group, so re-running it is idempotent.
        //
        // Lookup-then-insert on the async driver: a concurrent route can win the
        // same wiring; adopt it instead of failing this message (seam 3 primitive).
        await centralTransaction(async () => {
          const incumbent = await inheritedAgentGroupFor(mg);
          if (!incumbent || incumbent.id !== inheritedAgent.id) throw new AutoWireUniquenessLost();
          await insertOrAdopt(
            wiring,
            async (candidate) => {
              // The in-transaction leaf, not the exported wrapper: that one
              // opens its OWN `centralTransaction`, and the lease refuses to
              // nest, so calling it from here would throw
              // `CentralLeaseReentrancyError` on every eligible channel.
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
        // Resolve the channel name the same way the approval path does. Only
        // that path used to do it, so a workspace-trust auto-wire left name
        // NULL forever — the row was invisible to any name-keyed roster query,
        // and the agent's own pre-turn context (channelName, below) told it it
        // was nowhere. A sibling auto-wired into #dispatch mid-thread on
        // 2026-08-07 could not name the room it was posting in. Non-critical:
        // never let a name lookup undo a wiring that already succeeded.
        try {
          if (adapter?.resolveChannelName) {
            const name = await adapter.resolveChannelName(mg.platform_id);
            // `classified`, not `adapter`: this is the classification seam's
            // answer, and it must outrank the generic metadata fetch that will
            // report this same channel's raw platform name later.
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
        // Re-enter routing with the fresh wiring in place.
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

    // Env-var auto-wire: when the operator pre-declared a default agent
    // for this channel_type via NANOCLAW_DEFAULT_AGENT_GROUP_<TYPE>, the
    // channel-auto-wire module's resolver persists a messaging_group_agents
    // row as a side effect; we re-enter routing with the fresh wiring in
    // place. Resolver returns [] when no env var is set / folder is missing
    // / the wiring insert raced — falls through to the approval gate below.
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
      // Defer only the exact event retained by the approval row. Later
      // messages while a card is pending remain ordinary drops and cannot
      // strand unrelated ingress receipts indefinitely.
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

  // 2a. Eagerly populate the user_dms cache for inbound 1:1 DMs. The cache
  //     was historically only written lazily by ensureUserDm() on the
  //     outbound-DM path (approvals, DMs we initiate), which meant
  //     features depending on "is this messaging_group the user's DM?"
  //     (Slack user-token gate, future per-user DM features) would
  //     incorrectly deny on a first-time inbound DM until something else
  //     prewarmed the cache. Writing here makes the cache reliable.
  //
  //     Guard: require event.isDM === true explicitly (not just
  //     mg.is_group === 0). The messaging-group creation path defaults
  //     is_group to 0 when the adapter doesn't pass isDM (line above
  //     this branch — `event.isDM === false ? 1 : 0`), so is_group=0
  //     can mean "uncertain adapter" rather than "confirmed DM." Caching
  //     a shared channel as a user's DM would poison subsequent DM
  //     resolution. (Codex P2 catch on PR #108 follow-up.)
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
      // Permissions module not installed — downstream features that depend
      // on this cache will just see no row. Non-fatal.
      log.debug('router: skipped user_dms upsert (permissions module unavailable)', { err: String(err) });
    }
  }

  // 2b. Pre-fan-out intercept gate: runs ONCE per inbound, before agents
  //     are resolved. Handles /dashboard-token and other INTERCEPT_COMMANDS.
  //     FILTERED commands are dropped. Unknown/ADMIN commands fall through.
  if (userId !== null && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    const preGate = await preFanoutGate(event.message.content, userId);
    if (preGate.action === 'intercept' || preGate.action === 'deny') {
      // Sibling bots (separate channel_type/instance per bot user — see
      // docs/workgroups.md) each get their OWN inbound event for the same
      // underlying platform message, so this "runs once per inbound" gate
      // still runs once per SIBLING. Without this check every sibling wired
      // into the channel would intercept/deny the same command (observed:
      // three bots each minted a dashboard token for one `/dashboard-token`).
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
      // Real incident: a user typed an intercept command before they had any
      // role/membership and got no response at all — reads as the product
      // being broken. Reply with a short, non-leaky refusal (no role/permission
      // internals) through the same delivery path the intercept handlers use.
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
      // Hybrid: requires both a platform @-mention AND a text-pattern match.
      // Use when two sibling agents share one bot user (e.g. helper + helper-codex
      // on the same Slack app) and a keyword in the message text decides
      // which sibling fires. Without isMention, random chatter mentioning
      // the keyword would wake the bot; without the pattern, both siblings
      // would fire on every @-mention.
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
      // Threaded adapters (Discord, Slack): channel-root messages have
      // threadId=null and must not stick — we require a fresh @mention to
      // start a new thread. Only messages inside an existing thread carry
      // the sticky session. Non-threaded adapters (Telegram group chat etc.)
      // always have threadId=null; for them, session-existence IS the stick.
      if (adapterSupportsThreads && threadId === null) return false;
      // The stick is ENGAGEMENT, not session existence. Reading existence was
      // the original mistake: it made a session row — a storage detail any
      // path can create — carry a behavioral meaning, which is precisely what
      // forced the non-engaged skip below to exempt mention-sticky wirings.
      // `engaged_at` states the fact outright (migration 052), so a thread the
      // agent has never engaged in does not stick, whether or not a row exists.
      const existing = await findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing?.engaged_at != null;
    }
    default:
      return false;
  }
}

/**
 * Mirror an inbound user message into archive.db for future-wake thread
 * context replay. Scoped per-agent-group to match the archive's PK slicing;
 * assistant replies are archived on delivery.ts's path.
 *
 * Called from both delivery paths — the normal one before the session row is
 * written (so same-turn recall can resolve the trigger sender), and the
 * non-engaged skip below, which never resolves a session.
 * The insert is an upsert keyed on the per-agent message id, so calling it
 * twice for one message is a no-op rewrite.
 *
 * Returns whether a row was actually written. The skip path treats that
 * boolean as a precondition, not as diagnostics — see the guard.
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
 * Whose non-engaged messages are eligible for the session skip below.
 *
 * THIS IS THE SCOPE LINE. It exists as its own predicate so the
 * bot-versus-human question is one auditable, revertible place rather than a
 * clause buried in a nine-term condition.
 *
 * Currently: everyone. The operator widened it from bot-only deliberately —
 * "we don't need to retain history of chatter without any agent engagement".
 * The model, not the disk, is the point: a session should not exist until an
 * agent is engaged. (`sessionActiveCap` was 2000 against 6,812 active
 * sessions, the large majority of them threads no agent ever touched.)
 *
 * To narrow back to bots only, this is the one function to change — and when
 * you do, do NOT identify bots by platform-id prefix (`U…` vs `B…`). Slack
 * puts a `U`-prefixed `event.user` on bot events, so the prefix is not a bot
 * test. The two reliable signals are the platform's own `isBot` flag on the
 * serialized author, and the install's known sibling-bot id set
 * (`isSiblingBotSender` / `setSiblingBotIdsProvider` in
 * `src/modules/permissions/`).
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

  // Slack DM thread-on-first-reply (fork): synthesize a per-thread id for
  // root DMs. Reassigns the policy-resolved address so session resolution
  // AND the delivery address below stay consistent. threadsEnabled implies
  // effectiveThreadId === event.threadId, so the event view is current.
  if (threadsEnabled) {
    effectiveThreadId = effectiveThreadIdForAgent(event, true, effectiveSessionMode);
  }

  // ── A non-waking message does not get to mint a per-thread session. ──
  //
  // A session is supposed to mean "an agent is engaged in this thread". It had
  // drifted into meaning "a message once landed here": a `mention`-mode agent
  // wired to a busy channel minted a per-thread session for every notification
  // and every passing human remark, none of which would ever wake. Those rows
  // are what `sessionActiveCap` has been fighting.
  //
  // Skipping is only sound where the wake path can reconstruct what an
  // accumulate would have provided, so this condition is the deliberate mirror
  // of the thread-context backfill below — same message kinds, same thread
  // policy, same adapter capability. When someone does engage in this thread,
  // `engaged_at` is still NULL at that moment, so `buildThreadContextBlock`
  // replays the whole thread and the skipped messages come back as context.
  // That recovery is keyed on the SESSION's engagement state, not on whether
  // this particular call created the row, so it holds no matter which path
  // (mention, agent-to-agent, anything later) brings the session into being.
  //
  // Two things are deliberately NOT skipped. Messages carrying attachments:
  // `fetchThreadHistory` returns `{sender, text, timestamp, isAnchor?}` and
  // reconstructs no files, so a replay genuinely cannot recover them (see
  // `src/channels/adapter.ts`). And anything the archive refused —
  //
  // *** The `archiveInboundUserMessage(...)` call below is the thing the skip
  // DEPENDS ON, not a side effect on the way out. *** Skipping writes no
  // session row, so the archive row is the message's only remaining copy: it
  // is what `messages_archive` retrieval reads, and what the workgroup
  // archive retains as conversation history.
  // If the archive throws and we skip
  // anyway, the message ceases to exist — no row, no retry, no error anyone
  // sees. So it is evaluated LAST, and a `false` return falls through to
  // ordinary session creation, where the message is at least durable. Do not
  // "simplify" this into a fire-and-forget call before the `if`.
  //
  // ── Accepted costs, so the tradeoff is legible where it is taken ──
  // Replay is not a lossless substitute for the stream, and these three gaps
  // were accepted deliberately rather than overlooked:
  //   1. The replay is capped at THREAD_CONTEXT_LIMIT (50) messages, and
  //      effectively 49 — the triggering mention consumes one via
  //      `excludeMessageId`. A longer thread loses its oldest messages.
  //   2. Slack's `conversations.replies` is called once, no cursor,
  //      `direction: backward`. Past roughly 200 messages it returns a stale
  //      EARLY window, so a very long thread replays its beginning, not its
  //      tail.
  //   3. Replay reflects the platform's CURRENT state, so edits and deletes
  //      show as they now stand — the streamed copy accumulate would have kept
  //      is gone.
  // The right response to any of these is a bigger cap or cursoring in the
  // adapter, not reinstating a session row per un-engaged thread.
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

  // A receipt table added after existing session DBs cannot retroactively know
  // their old platform ids. Check the actual per-session id before every side
  // effect as a migration-safe second line of defense, and also make a partial
  // fan-out retry harmless for agents whose row was already committed.
  if (await sessionMessageExists(agent.agent_group_id, session.id, routedMessageId)) {
    log.debug('Duplicate session message ignored before agent side effects', {
      sessionId: session.id,
      agentGroup: session.agent_group_id,
      platformMessageId: event.message.id,
    });
    return;
  }

  // v1 behavior: a follow-up message to a session with a pending
  // bash/destructive gate implicitly rejects the gate so the agent's
  // PreToolUse hook unblocks, the current turn ends, and the next
  // turn processes the new message. Guarded by an in-memory set so
  // the common no-gate case skips the DB read.
  if (!created && sessionHasActiveGates(session.id)) {
    cancelPendingGatesForSession(session.id, 'Cancelled — user sent a follow-up message.').catch((err) => {
      log.warn('cancelPendingGatesForSession failed', { sessionId: session.id, err });
    });
  }

  // Rename freshly-created Discord threads to a Haiku-derived topic title.
  // Fire-and-forget; failures log and move on. See src/topic-title.ts for
  // the why and the platform-gating (Discord only).
  //
  // Gate on `wake`, not just `created`: every wired sibling with
  // ignored_message_policy='accumulate' gets a session created here even when
  // it DIDN'T engage (wake=false) — it's just stashing the message for later
  // context. Those non-engaging siblings must not title the thread. Without
  // this gate, an accumulate sibling whose session is created later in the
  // turn (fed downstream text — e.g. the engaged sibling's tool output) would
  // clobber the engaged sibling's correct opening-prompt title. Only the
  // sibling actually responding to the user names the thread.
  if (created && wake) {
    const firstText = parsedContent.text ?? '';
    if (firstText) await maybeRenameNewThread(event.channelType, effectiveThreadId, firstText);
  }

  // Persist any base64-encoded attachments from chat-sdk-bridge onto the
  // filesystem and replace their inline data URLs with file:// paths. The
  // container sees them as regular file references.
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
      // Existing-only: a denial is not a reason to provision a mailbox
      // (invariant I-10). OUTBOUND-keyed, not the mailbox session: writing the
      // notice needs nothing from inbound.db, and a retained session whose
      // inbound.db has been reclaimed while outbound.db remains would answer
      // `undefined` from the inbound-keyed funnel — the denial would be logged
      // with no reply ever written. Pre-seam this opened outbound.db directly,
      // so the inbound dependency would have been new.
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

  // Host emits the flag confirmation directly to outbound so it lands
  // without waiting for the agent turn. Structured intent is attached to
  // messages_in.content so the container never re-parses text.
  //
  // Wake gate: skip the flag dispatcher entirely when `wake=false`. The
  // accumulate path delivers the message as silent context (the agent
  // isn't being addressed), so applying `-e`/`-m` flags from a message
  // that was for a sibling would (a) post a duplicate "effort → X" reply
  // from this agent's bot user — visible noise in the channel — and (b)
  // store the flag in this session's sticky config when the operator
  // never intended it. Observed: `@Example Assistant -e max` triggered Example Assistant Codex's
  // accumulate path on the shared Example Retail channel; Example Assistant Codex emitted its own
  // "effort → max" message and stored the sibling-targeted value in its own
  // session_state even though the operator never addressed that agent.
  let flagIntent: FlagIntent | undefined;
  let flagCleanedText: string | null = null;
  if (wake && (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')) {
    const rawText = parsedContent.text ?? '';
    // Flag vocabulary is provider-specific (codex accepts gpt-5.5, rejects
    // claude ids; claude the reverse). Precedence mirrors container spawn
    // (sessions.agent_provider → container config → 'claude'), with
    // agent_groups.agent_provider as the gap-filler: groups created mid-run
    // have no container_configs row until backfillContainerConfigs runs at
    // the next host restart (see group-init.ts — the FK ordering note), but
    // the create flows do stamp the group row. Without this rung a fresh
    // codex sibling would parse flags with the claude vocabulary until the
    // next restart (codex-review finding on PR #124).
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
        // Outbound-keyed for the same reason as the denial notice above: an
        // inbound-keyed existence check would silently drop this confirmation
        // for a session whose inbound.db is gone and outbound.db is not.
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

  // Thread-context parity with v1: on engaged mentions inside a thread, fetch
  // recent thread history from the platform (covers messages from other bots,
  // plain user messages that never engaged us, and anything the skip above
  // declined to store) and prepend it to the trigger. The cutoff rule lives in
  // `src/thread-context.ts` because the agent-to-agent wake path has to apply
  // the identical rule — see that file.
  let contentForWrite = persistedContent;
  if (flagIntent || flagCleanedText !== null) {
    const parsed = JSON.parse(contentForWrite) as Record<string, unknown>;
    if (flagCleanedText !== null) parsed.text = flagCleanedText;
    if (flagIntent) parsed.flagIntent = flagIntent;
    contentForWrite = JSON.stringify(parsed);
  }
  if (
    wake &&
    threadsEnabled &&
    effectiveThreadId !== null &&
    (event.message.kind === 'chat' || event.message.kind === 'chat-sdk')
  ) {
    // `session` was read before `markSessionEngaged` runs below, so its
    // `engaged_at` still describes the state BEFORE this wake — which is the
    // question the backfill asks. Text is already flag- and mention-free here
    // (the flag parser ran above), so prepending is a straight concat.
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

  // Archive BEFORE the session write: writeSessionMessageIfNew synchronously
  // builds the pre-turn recall row, whose preference lane (pre-turn-context.ts)
  // resolves each sender's canonical users.display_name via
  // recentConversationSenders reading messages_archive. On a thread's first
  // message the trigger sender has no other archive rows yet, so if the
  // archive write happened after this call, the trigger's own name couldn't
  // resolve until their second message. Archiving first makes the trigger's
  // row visible to that same-turn read.
  archiveInboundUserMessage(agent, mg, event, userId, parsedContent, effectiveThreadId);

  const inserted = await writeSessionMessageIfNew(session.agent_group_id, session.id, {
    id: routedMessageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    messagingGroupId: mg.id,
    threadId: deliveryAddr.threadId,
    content: contentForWrite,
    trigger: wake ? 1 : 0,
  });
  if (!inserted) {
    if (wake) stopTypingRefresh(session.id);
    log.debug('Duplicate routed message ignored', {
      sessionId: session.id,
      agentGroup: session.agent_group_id,
      platformMessageId: event.message.id,
    });
    return;
  }

  // The message is durable and this wiring engaged — record the fact. Stamped
  // AFTER the backfill read above, which needs the pre-wake state, and after
  // the write, so a duplicate or a failed insert never claims engagement.
  if (wake) await markSessionEngaged(session.id);

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
      // Priority is applied atomically inside wakeContainer. If this session
      // was queued for scheduled work, the returned promise now represents
      // the real promotion/admission result rather than a stale queued=false.
      //
      // The liveness proof is the wake's, not ours: a `getSession` here proved
      // the row live before the call, and the call then awaits admission, the
      // memory queue and the spawn preparation.
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
