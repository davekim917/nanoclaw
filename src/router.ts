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
import { persistInboundAttachments } from './attachment-downloader.js';
import { upsertArchiveMessage } from './message-archive.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { maybeRenameNewThread } from './topic-title.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface InboundEvent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string; // JSON blob
    timestamp: string;
  };
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

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
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  // 1. Resolve messaging group
  let mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 3. Resolve agent groups wired to this messaging group. Structural
  //    drops record to dropped_messages for audit.
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    log.warn('MESSAGE DROPPED — no agent groups wired to this channel. Run setup register step to configure.', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    return;
  }

  const match = pickAgent(agents, event);
  if (!match) {
    log.warn('MESSAGE DROPPED — no agent matched trigger rules', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
    });
    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_trigger_match',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    return;
  }

  // 4. Access gate (if the permissions module is loaded). Otherwise
  //    allow-all.
  if (accessGate) {
    const result = accessGate(event, userId, mg, match.agent_group_id);
    if (!result.allowed) {
      log.info('MESSAGE DROPPED — access gate refused', {
        messagingGroupId: mg.id,
        agentGroupId: match.agent_group_id,
        userId,
        reason: result.reason,
      });
      return;
    }
  }

  // 5. Resolve or create session.
  //
  // Adapter thread policy overrides the wiring's session_mode: if the adapter
  // is threaded, each thread gets its own session regardless of what the
  // wiring says. Agent-shared is preserved because it expresses a
  // cross-channel intent the adapter can't know about.
  //
  // Exception: DMs (is_group=0). Sub-threads within a DM are a UX affordance,
  // not a conversation boundary — treat the whole DM as one session and let
  // threadId flow through to delivery so replies land in the right sub-thread.
  let effectiveSessionMode = match.session_mode;
  if (adapter && adapter.supportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }
  const { session, created } = resolveSession(match.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // 6. Write message to session DB
  const messageId = event.message.id || generateId();

  // Persist any base64-encoded attachments from chat-sdk-bridge onto the
  // session's workspace disk so the agent can actually Read them. This
  // mutates the JSON content to drop `data` and add `localPath`.
  const persistedContent = persistInboundAttachments(
    session.agent_group_id,
    session.id,
    messageId,
    event.message.content,
  );

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: event.platformId,
    channelType: event.channelType,
    threadId: event.threadId,
    content: persistedContent,
  });

  // 6b. Mirror chat-kind inbound into the central archive (2.9). Non-chat
  // kinds (system actions, task triggers, etc.) aren't indexed.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    try {
      const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      if (text) {
        upsertArchiveMessage({
          id: messageId,
          agentGroupId: session.agent_group_id,
          messagingGroupId: mg.id,
          channelType: event.channelType,
          channelName: mg.name ?? null,
          platformId: event.platformId,
          threadId: event.threadId,
          role: 'user',
          senderId: userId,
          senderName:
            (typeof parsed.senderName === 'string' && parsed.senderName) ||
            (typeof parsed.sender === 'string' && parsed.sender) ||
            null,
          text,
          sentAt: event.message.timestamp,
        });
      }
    } catch {
      // Skip malformed content silently — archive is best-effort.
    }
  }

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: match.agent_group_id,
    kind: event.message.kind,
    userId,
    created,
  });

  // 6c. Phase 5.11: when a new session was just created and the inbound
  // came through a thread-supporting channel (Discord today), kick off
  // async topic-title generation + thread rename. Fire-and-forget.
  if (created && event.message.kind === 'chat-sdk' && event.threadId) {
    try {
      const parsedForTitle = JSON.parse(event.message.content) as Record<string, unknown>;
      const textForTitle = typeof parsedForTitle.text === 'string' ? parsedForTitle.text : '';
      if (textForTitle) {
        maybeRenameNewThread(event.channelType, event.threadId, textForTitle);
      }
    } catch {
      // Malformed content — skip rename.
    }
  }

  // 7. Show typing indicator while the agent processes.
  startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);

  // 8. Wake container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}

/**
 * Pick the matching agent for an inbound event.
 *
 * Rules:
 *  - Agents are ordered by priority DESC from the DB.
 *  - `response_scope='all'` (default): match any message.
 *  - `response_scope='triggered'`: match only if the inbound message is an
 *    explicit mention of this bot. Lets a channel have the bot present
 *    without it replying to every message.
 *  - `response_scope='allowlisted'`: reserved — falls through to 'all'
 *    until allowlist rules are defined.
 *
 * @mention detection: chat-sdk-bridge annotates each inbound with a flat
 * `isMention` boolean (from chat-sdk's own detection) before JSON-encoding.
 */
function pickAgent(agents: MessagingGroupAgent[], event: InboundEvent): MessagingGroupAgent | null {
  const isMention = extractIsMention(event);
  log.debug('pickAgent', {
    isMention,
    agentCount: agents.length,
    scopes: agents.map((a) => a.response_scope),
    messageKind: event.message.kind,
    contentPreview: event.message.content.slice(0, 200),
  });
  for (const agent of agents) {
    if (agent.response_scope === 'triggered' && !isMention) continue;
    return agent;
  }
  return null;
}

function extractIsMention(event: InboundEvent): boolean {
  try {
    const parsed = JSON.parse(event.message.content) as { isMention?: unknown };
    return parsed.isMention === true;
  } catch {
    return false;
  }
}
