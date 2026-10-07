/**
 * Slack channel adapter, a FORK DEVIATION from upstream /add-slack: multiple concurrent Slack workspaces in one host.
 * `SLACK_BOT_TOKEN` (+ `SLACK_SIGNING_SECRET` or `SLACK_APP_TOKEN`) → channelType "slack"; `SLACK_BOT_TOKEN_<SUFFIX>`
 * → "slack-<suffix>". Each workspace is its own Slack app. Suffix is [A-Za-z0-9_]+, lowercased for the channelType.
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import { WebClient } from '@slack/web-api';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { markdownHeadingsToBold } from '../text-styles.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { createAdapterLogger } from './post-deploy-inbound.js';
import { conversationDisplayName } from './adapter.js';
import type { ChannelConversation, ChannelDefaults, ChannelRecoveryRequest, ChannelRecoveryTarget } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { extractSlackRawText } from './slack-raw-text.js';
import { slackApiUrl } from './slack-lib.js';
import { installSlackSubtextBlocks } from './slack-subtext.js';
import { linkSlackChannelNames, warmChannelDirectory } from './channel-links.js';
import { createSlackHopGovernor, type SlackHopGovernor } from './slack-hop-limit.js';
import {
  fetchSlackBotIdentity,
  getSlackBotSenderName,
  getKnownSlackBots,
  getKnownSlackHumans,
  registerSlackBot,
  registerSlackWorkspaceHumans,
  slackMentionOutsideCode,
  slackPermalink,
  slackChannelPermalink,
  normalizeSlackOrderedListContinuations,
  resolveInboundSlackIds,
  resolveSlackMentions,
  unregisterSlackBot,
  upgradeSlackBotProfile,
  type SlackBotIdentity,
} from './slack-mentions.js';

// Block Kit section text caps at 3,000 characters; headroom for adapter serialization, and the bridge splits longer
// messages.
export const SLACK_MESSAGE_MAX_TEXT_LENGTH = 2800;

/**
 * Declared wiring-time defaults for every Slack instance. Without a declaration, `ncl`-created wirings got static
 * schema defaults while auto-created ones used the fallback, splitting live policy. The values are this fork's: group
 * engageMode 'mention' (not 'mention-sticky': sibling agents share channels), group unknownSenderPolicy 'public'
 * (inviting the bot is the access decision), dm unknownSenderPolicy 'request_approval'.
 * engageMode, engagePattern and unknownSenderPolicy are read only when a row is CREATED. `threads` is re-read on
 * every routed message (NULL = inherit), so it MUST stay true in both contexts, matching the fallback
 * (`supportsThreads`); changing it would silently re-thread every existing Slack wiring, including DM sub-threads.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    unknownSenderPolicy: 'request_approval',
  },
  group: {
    engageMode: 'mention',
    threads: true,
    unknownSenderPolicy: 'public',
  },
  mentions: 'platform',
};

/**
 * Bridge `inboundFilter` for the sibling-bot loop governor. Sibling detection is registry-based and team-scoped, and
 * fails CLOSED without our own identity (nothing counts as a sibling, the governor never drops). "Human" is anything
 * not ours and not flagged a bot; an `isBot: 'unknown'` author resets the counter, because failing the other way can
 * mute a channel forever.
 */
/**
 * A bot's live task-list post, recognized by the runner's "todos as of" context footer
 * (container/agent-runner/src/task-list.ts). Bot-authored only, so a human quoting the phrase still reaches the
 * agent.
 */
export function isSlackTaskListPost(message: { author?: { isBot?: boolean | 'unknown' }; raw?: unknown }): boolean {
  if (message.author?.isBot !== true) return false;
  const blocks = (message.raw as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (block) =>
      (block as { type?: unknown }).type === 'context' &&
      Array.isArray((block as { elements?: unknown }).elements) &&
      (block as { elements: Array<{ text?: unknown }> }).elements.some(
        (el) => typeof el.text === 'string' && /^(stopped · )?todos as of /.test(el.text),
      ),
  );
}

export function slackHopInboundFilter(
  governor: SlackHopGovernor,
  identity: SlackBotIdentity | null,
  message: { threadId: string; author?: { userId?: string; isBot?: boolean | 'unknown' } },
): boolean {
  const authorId = message.author?.userId;
  const isSiblingBot =
    identity !== null &&
    authorId !== undefined &&
    [...getKnownSlackBots().values()].some((bot) => bot.teamId === identity.teamId && bot.userId === authorId);
  return governor.admit({
    threadId: message.threadId,
    isSiblingBot,
    isHuman: !isSiblingBot && message.author?.isBot !== true,
  });
}

/**
 * Slack stamps `bot_id` on every app-posted message, including a human's own post through a user token, and the SDK
 * turns that into `isBot`. A registered workspace human is a human however the post was made.
 */
export function isSlackWorkspaceHuman(identity: SlackBotIdentity | null, userId: string): boolean {
  if (!identity) return false;
  return (getKnownSlackHumans().get(identity.teamId) ?? []).some((human) => human.userId === userId);
}

/**
 * Bots, app users (`is_app_user` without `is_bot` is real), Slackbot and deactivated accounts are not. Shared by the
 * mention directory and the group-DM roster so the two cannot drift.
 */
export function isSlackHumanMember(
  userId: string,
  member: { is_bot?: boolean; is_app_user?: boolean; deleted?: boolean },
): boolean {
  return !member.is_bot && !member.is_app_user && !member.deleted && userId !== 'USLACKBOT';
}

/**
 * Registers the workspace's human members for outbound mention resolution. Fail-soft: without `users:read`, human
 * mentions stay unresolved and bot mentions still work.
 */
async function syncSlackWorkspaceHumans(client: WebClient, teamId: string, channelType: string): Promise<void> {
  try {
    const humans: SlackBotIdentity[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const m of res.members ?? []) {
        if (!m.id || !isSlackHumanMember(m.id, m)) continue;
        humans.push({
          userId: m.id,
          username: m.name ?? '',
          displayName: m.profile?.display_name || undefined,
          realName: m.profile?.real_name || undefined,
          teamId,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    registerSlackWorkspaceHumans(teamId, humans);
    log.info('Slack workspace humans registered for mention resolution', {
      channelType,
      teamId,
      count: humans.length,
    });
  } catch (err) {
    log.warn('Slack users.list failed — human @-mentions will not resolve for this workspace', {
      channelType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SlackWorkspace {
  channelType: string;
  botToken: string;
  /** Webhook-mode credential; absent under Socket Mode. */
  signingSecret?: string;
  /** App-level token (`xapp-…`); its presence IS the Socket Mode switch. */
  appToken?: string;
}

interface SlackRecoveryMessage {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

type SlackRecoveryAdapter = ReturnType<typeof createSlackAdapter> & {
  parseSlackMessage(raw: unknown, encodedThreadId: string): Promise<import('chat').Message>;
};

export function makeSlackRecoveryPageFetcher(slackAdapter: ReturnType<typeof createSlackAdapter>, client: WebClient) {
  return async (
    threadId: string,
    options: { limit: number; direction: 'backward'; cursor?: string; since: string },
  ) => {
    const parts = threadId.split(':');
    const channel = parts[1];
    const threadTs = parts[2] ?? '';
    const oldest = String(Date.parse(options.since) / 1000);
    const response = threadTs
      ? await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: options.limit,
          cursor: options.cursor,
          oldest,
        })
      : await client.conversations.history({
          channel,
          limit: options.limit,
          cursor: options.cursor,
          oldest,
        });
    const parseSlackMessage = (slackAdapter as SlackRecoveryAdapter).parseSlackMessage;
    const messages = await Promise.all(
      (response.messages ?? []).map((raw) => {
        const slackMessage = raw as SlackRecoveryMessage;
        const nativeThreadTs = threadTs
          ? threadTs
          : channel.startsWith('D')
            ? (slackMessage.thread_ts ?? '')
            : (slackMessage.thread_ts ?? slackMessage.ts ?? '');
        return parseSlackMessage.call(slackAdapter, raw, `slack:${channel}:${nativeThreadTs}`);
      }),
    );
    messages.sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
    return { messages, nextCursor: response.response_metadata?.next_cursor || undefined };
  };
}

/**
 * Errors meaning a recovery target is unreachable by wiring, not outage; the bridge parks the target instead of
 * failing the pass.
 */
const PERMANENT_SLACK_RECOVERY_ERRORS = ['channel_not_found', 'is_archived', 'not_in_channel', 'missing_scope'];

export function classifySlackRecoveryError(err: unknown): 'permanent' | 'transient' {
  const code = (err as { data?: { error?: string } })?.data?.error;
  if (code && PERMANENT_SLACK_RECOVERY_ERRORS.includes(code)) return 'permanent';
  // WebClient sometimes surfaces only "An API error occurred: <code>".
  const message = err instanceof Error ? err.message : '';
  return PERMANENT_SLACK_RECOVERY_ERRORS.some((c) => message.includes(c)) ? 'permanent' : 'transient';
}

/** Finds threads created or updated during the gap before they have a session. */
export async function discoverSlackRecoveryTargets(
  client: WebClient,
  request: ChannelRecoveryRequest,
): Promise<{
  targets: ChannelRecoveryTarget[];
  complete: boolean;
  failed: Array<{ target: ChannelRecoveryTarget; error: unknown }>;
}> {
  const sinceMs = Date.parse(request.since);
  const targets: ChannelRecoveryTarget[] = [];
  const failed: Array<{ target: ChannelRecoveryTarget; error: unknown }> = [];
  let complete = true;

  // Per-root fault isolation: one unreachable channel must not abort discovery for the rest.
  for (const root of request.targets) {
    if (root.threadId !== null) continue;
    const channel = root.platformId.split(':')[1];
    if (!channel) continue;
    let cursor: string | undefined;
    let coveredBoundary = false;
    const seenCursors = new Set<string>();
    try {
      for (;;) {
        const response = await client.conversations.history({ channel, limit: 100, cursor });
        const messages = (response.messages ?? []) as SlackRecoveryMessage[];
        for (const message of messages) {
          const rootTs = message.ts ?? '';
          const rootMs = Number(rootTs) * 1000;
          const latestReplyMs = Number(message.latest_reply) * 1000;
          const hasGapReply =
            (message.reply_count ?? 0) > 0 && Number.isFinite(latestReplyMs) && latestReplyMs > sinceMs;
          const createdInGap = Number.isFinite(rootMs) && rootMs > sinceMs;
          if ((hasGapReply || createdInGap) && rootTs) {
            targets.push({ platformId: root.platformId, threadId: `slack:${channel}:${rootTs}`, isDM: root.isDM });
          }
        }
        const nextCursor = response.response_metadata?.next_cursor || undefined;
        // Slack has no thread-activity index: an old root can get its first reply during the gap, so the full root
        // history is covered, not just roots newer than `since`.
        if (!nextCursor) {
          coveredBoundary = true;
          break;
        }
        if (seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!coveredBoundary) complete = false;
    } catch (err) {
      failed.push({ target: root, error: err });
    }
  }

  return { targets, complete, failed };
}

/** Suffix → channelType: lowercase, `_` → `-`; channel-auto-wire maps `-` → `_` back, so the round-trip is stable. */

/** Structural so tests can pass a two-method stub. */
export interface SlackConversationClient {
  conversations: {
    info(args: { channel: string }): Promise<{
      ok?: boolean;
      channel?: { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string };
    }>;
    members?(args: { channel: string; limit?: number }): Promise<{ ok?: boolean; members?: string[] }>;
  };
  users?: {
    info(args: { user: string }): Promise<{
      ok?: boolean;
      user?: {
        name?: string;
        real_name?: string;
        is_bot?: boolean;
        deleted?: boolean;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

function slackUserDisplayName(u: {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}): string | null {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || null;
}

/**
 * Classifies a conversation as a 1:1 DM, group DM or channel. Fork deviations from upstream: a 1:1 DM resolves the
 * counterpart's profile name (`resolveChannelName` relies on it), and it runs on `WebClient`. Null when the API
 * cannot classify; never throws.
 */
export async function resolveSlackConversation(
  client: SlackConversationClient,
  platformId: string,
): Promise<ChannelConversation | null> {
  try {
    const id = extractSlackChannelId(platformId);
    const info = await client.conversations.info({ channel: id });
    if (!info.ok || !info.channel) return null;
    const ch = info.channel;

    if (ch.is_im) {
      if (!ch.user || !client.users) return { type: 'direct', name: null };
      const res = await client.users.info({ user: ch.user });
      return { type: 'direct', name: res.ok && res.user ? slackUserDisplayName(res.user) : null };
    }

    // Only an MPDM pays for the roster lookup.
    if (!ch.is_mpim) return { type: 'channel', name: ch.name ? `#${ch.name}` : null };

    const participantNames = await resolveMpdmParticipants(client, id);
    return participantNames
      ? { type: 'group_dm', name: null, participantNames }
      : // The roster is unresolvable (no members scope, no users.info) but the
        // conversation IS a group DM — say so rather than falling back to the
        // `mpdm-a--b--c-1` slug Slack puts in `name`.
        { type: 'group_dm', name: null };
  } catch {
    return null;
  }
}

/** Null when the roster cannot be resolved. Bots and deactivated accounts are excluded. */
async function resolveMpdmParticipants(client: SlackConversationClient, channelId: string): Promise<string[] | null> {
  if (!client.conversations.members || !client.users) return null;
  // A transient roster failure must degrade to "group DM, no names", not escape to the caller's catch, which would
  // lose the fact that this IS a group DM.
  const { ok, members } = await client.conversations
    .members({ channel: channelId, limit: 100 })
    .catch(() => ({ ok: false }) as { ok?: boolean; members?: string[] });
  if (ok === false || !members || members.length === 0) return null;
  const users = await Promise.all(
    members.map((userId) => client.users!.info({ user: userId }).catch(() => ({ ok: false }) as { ok?: boolean })),
  );
  const names: string[] = [];
  for (const [index, res] of users.entries()) {
    const u = (
      res as {
        ok?: boolean;
        user?: Parameters<typeof slackUserDisplayName>[0] & {
          is_bot?: boolean;
          is_app_user?: boolean;
          deleted?: boolean;
        };
      }
    ).user;
    // A LOOKUP FAILURE is not a filtered member: skipping it would persist a truncated roster as the group's name.
    // All or nothing.
    if (!res.ok || !u) return null;
    if (!isSlackHumanMember(members[index]!, u)) continue;
    const name = slackUserDisplayName(u);
    // Naming the rest would claim a completeness we do not have.
    if (!name) return null;
    names.push(name);
  }
  return names.length > 0 ? names : null;
}

/**
 * The name for `messaging_groups.name`: `#name` for channels, the counterpart's name for a 1:1 DM, the participants
 * for a group DM; null when the API cannot say. The fleet's only `resolveChannelName` implementation (the router
 * names every auto-wired conversation through it), projected from `resolveSlackConversation` so the two cannot
 * disagree.
 */
export async function slackChannelDisplayName(
  client: SlackConversationClient,
  platformId: string,
): Promise<string | null> {
  const conversation = await resolveSlackConversation(client, platformId);
  return conversation ? conversationDisplayName(conversation) : null;
}

export function parseSlackWorkspaces(env: Record<string, string>): SlackWorkspace[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string; appToken?: string }>();

  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET|APP_TOKEN)(?:_([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase().replace(/_/g, '-') : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else if (kind === 'APP_TOKEN') entry.appToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const workspaces: SlackWorkspace[] = [];
  for (const [suffix, pair] of bySuffix) {
    if (!pair.botToken) continue;
    // Socket Mode needs no signing secret (no public URL); webhook delivery needs it to authenticate Slack's POSTs.
    if (!pair.signingSecret && !pair.appToken) {
      log.warn('Slack workspace has no signing secret and no app token, skipping', {
        suffix: suffix || '(primary)',
      });
      continue;
    }
    const workspace: SlackWorkspace = {
      channelType: suffix ? `slack-${suffix}` : 'slack',
      botToken: pair.botToken,
    };
    if (pair.signingSecret) workspace.signingSecret = pair.signingSecret;
    if (pair.appToken) workspace.appToken = pair.appToken;
    workspaces.push(workspace);
  }
  return workspaces;
}

/**
 * ChannelTypes that must carry the declaration but cannot serve traffic. `getChannelDefaults` falls back to the
 * registry when no adapter is live; without an entry, `ncl`/setup stamp the legacy `strict` default on a new
 * messaging_groups row, and it outlives the credentials being completed.
 * Covers suffixes with an incomplete credential pair, and the default `slack` instance only when nothing is
 * configured (so a host with real workspaces does not advertise a phantom one). Deliberately separate from
 * parseSlackWorkspaces, whose contract is "workspaces that can serve traffic".
 */
export function declarationOnlySlackTypes(env: Record<string, string>): string[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string }>();
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(?:_([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase().replace(/_/g, '-') : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const types: string[] = [];
  let anyComplete = false;
  for (const [suffix, pair] of bySuffix) {
    if (pair.botToken && pair.signingSecret) {
      anyComplete = true;
      continue;
    }
    types.push(suffix ? `slack-${suffix}` : 'slack');
  }
  if (!anyComplete && types.length === 0) types.push('slack');
  return types;
}

const SLACK_ENV_PATTERN = /^SLACK_(BOT_TOKEN|SIGNING_SECRET|APP_TOKEN)(_[A-Za-z0-9_]+)?$/;

/** The one entry point; callers outside this module must not re-derive the env pattern. */
export function loadSlackWorkspaces(): SlackWorkspace[] {
  return parseSlackWorkspaces(readEnvFileMatching(SLACK_ENV_PATTERN));
}

export interface SlackPostMessageClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string | null }>;
  };
}

/**
 * Strips `slack:`, leaving the raw channel id the Web API expects. Callers outside the bridge (orchestrator-dispatch)
 * must normalize here or Slack returns `channel_not_found`.
 */
export function extractSlackChannelId(platformId: string): string {
  return platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
}

export async function slackPostParent(
  client: SlackPostMessageClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const response = await client.chat.postMessage({ channel, text });
  return { messageId: response.ts as string };
}

/** threadId IS the parent message's ts (Slack's thread_ts), not reply.ts. */
export async function slackCreateThread(
  client: SlackPostMessageClient,
  platformId: string,
  parentMessageId: string,
  _title: string,
  firstMessage: string,
): Promise<{ threadId: string; messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const reply = await client.chat.postMessage({
    channel,
    thread_ts: parentMessageId,
    text: firstMessage,
  });
  return { threadId: parentMessageId, messageId: reply.ts as string };
}

// Read once here so the raw env is also available to declarationOnlySlackTypes.
const slackEnv = readEnvFileMatching(SLACK_ENV_PATTERN);
const workspaces = parseSlackWorkspaces(slackEnv);

// Declaration-only registrations run BEFORE the live ones so a complete workspace's real factory wins the key, while
// a half-configured Slack still gets its declaration.
for (const channelType of declarationOnlySlackTypes(slackEnv)) {
  registerChannelAdapter(channelType, { defaults: SLACK_DEFAULTS, factory: () => null });
}

/** Provisioning calls this after adding a token pair so the adapter starts without a host restart. */
export function registerSlackWorkspace(ws: SlackWorkspace): void {
  registerChannelAdapter(ws.channelType, {
    // Also on the registration so offline creation paths resolve the same declaration without instantiating the
    // adapter.
    defaults: SLACK_DEFAULTS,
    factory: async () => {
      // Socket Mode when an app-level token is configured, webhook otherwise.
      const slackAdapter = createSlackAdapter({
        botToken: ws.botToken,
        signingSecret: ws.signingSecret,
        appToken: ws.appToken,
        mode: ws.appToken ? 'socket' : 'webhook',
        logger: createAdapterLogger(ws.channelType, 'slack'),
      });
      log.info('Slack workspace connecting', {
        channelType: ws.channelType,
        mode: ws.appToken ? 'socket' : 'webhook',
      });
      // Multi-workspace dedup isolation: the dedup key is `dedupe:${adapter.name}:${message.id}`, every SlackAdapter
      // defaults to "slack", and the state store is shared, so two bots in one workspace seeing the same event would
      // collide and the second would silently drop it. The name also keys `chat.webhooks[...]`, so the webhook lookup
      // matches.
      (slackAdapter as unknown as { name: string }).name = ws.channelType;
      // Installed beside the adapter because it wraps the adapter's own Web client; see slack-subtext.ts.
      installSlackSubtextBlocks(slackAdapter);
      const client = new WebClient(ws.botToken, { slackApiUrl: slackApiUrl() });

      // Setup publishes the identity provisionally before Socket Mode can deliver inbound events, and rolls it back
      // if setup fails.
      const identity = await fetchSlackBotIdentity(client);

      // One governor per bridge instance: each is one bot identity.
      const hopGovernor = createSlackHopGovernor(ws.channelType);

      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        // A pasted table arrives as attachments[].blocks[], in neither the text nor the file list.
        extractRawText: extractSlackRawText,
        concurrency: 'concurrent',
        supportsThreads: true,
        defaults: SLACK_DEFAULTS,
        maxTextLength: SLACK_MESSAGE_MAX_TEXT_LENGTH,
        // Continuation chunks reply in the first chunk's thread rather than landing as sibling parents.
        threadContinuationChunks: true,
        channelType: ws.channelType,
        // Headings become bold so tables stay on the `markdown` path (table-block conversion only fires for markdown
        // input). The subtext rides on the body until installSlackSubtextBlocks rewrites the payload.
        renderSubtext: (body, subtext) => ({ ...body, subtext }),
        transformOutboundMarkdown: (text) => {
          // A bot echoing a raw bot `<@id>` (the inbound wire form) would reach humans as literal text, so known bot
          // ids become plain @name BEFORE mention resolution: literal inside code spans, a proper mention in prose.
          // Human raw ids pass through; re-resolving by alias could drop an ambiguous one.
          const self = getKnownSlackBots().get(ws.channelType);
          let named = text;
          if (self && named.includes('<@')) {
            for (const bot of getKnownSlackBots().values()) {
              if (bot.teamId !== self.teamId) continue;
              named = named.replaceAll(`<@${bot.userId}>`, `@${bot.displayName || bot.realName || bot.username}`);
            }
          }
          const structured = normalizeSlackOrderedListContinuations(named);
          return linkSlackChannelNames(
            markdownHeadingsToBold(resolveSlackMentions(structured, ws.channelType)),
            ws.channelType,
          );
        },
        // Resolving inbound raw `<@U…>` to @name is what stops agents from learning the raw form; the outbound
        // rewrite is the backstop.
        transformInboundText: (text) => resolveInboundSlackIds(text, ws.channelType),
        // Chat SDK can keep a bot's install-time username in author.fullName after a rename; resolve sibling authors
        // through the live registry so agents never learn a deprecated codename.
        transformInboundSender: (author) =>
          author.userId ? getSlackBotSenderName(ws.channelType, author.userId) : null,
        // Slack fires app_mention even for `@name` inside backticks; demote the mention when it appears only in code.
        // Keep the platform verdict when identity is unavailable.
        refineInboundMention: (text) => {
          const self = getKnownSlackBots().get(ws.channelType);
          return self ? slackMentionOutsideCode(text, self) : true;
        },
        // Loop governor for sibling-bot ping-pong with no human in it, on live dispatch only: recovery pages arrive
        // newest-first and were already judged live. A sibling's task-list post is never a turn for this bot.
        inboundFilter: (message, ctx) =>
          isSlackTaskListPost(message)
            ? false
            : ctx.recovered
              ? true
              : slackHopInboundFilter(hopGovernor, identity, message),
        detectRecoveredMention: (message) => {
          if (!identity) return false;
          const raw = message.raw as Record<string, unknown> | undefined;
          if (!raw) return false;
          const mention = `<@${identity.userId}>`;
          if (typeof raw.text === 'string' && raw.text.includes(mention)) return true;
          // A pasted table can be the only place the bot is addressed, and a recovered row carries no isMention; see
          // slack-raw-text.ts.
          return extractSlackRawText(raw)?.includes(mention) === true;
        },
        isHumanAuthor: (userId) => isSlackWorkspaceHuman(identity, userId),
        // Sibling-bot messages are admissible in recovery, or a sibling's @-mention that arrived during a stall is
        // silently lost.
        allowRecoveredBotMessage: (message) => {
          const authorId = message.author.userId;
          return authorId !== identity?.userId && [...getKnownSlackBots().values()].some((b) => b.userId === authorId);
        },
        fetchRecoveryPage: makeSlackRecoveryPageFetcher(slackAdapter, client),
        discoverRecoveryTargets: (request) => discoverSlackRecoveryTargets(client, request),
        classifyRecoveryError: classifySlackRecoveryError,
      });
      bridge.resolveChannelName = (platformId) => slackChannelDisplayName(client, platformId);
      bridge.resolveConversation = (platformId) => resolveSlackConversation(client, platformId);
      bridge.permalink = (platformId, threadId) => slackPermalink(ws.channelType, platformId, threadId);
      bridge.channelPermalink = (platformId) => slackChannelPermalink(ws.channelType, platformId);
      bridge.postParent = (platformId, text) => slackPostParent(client, platformId, text);
      bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
        slackCreateThread(client, platformId, parentMessageId, title, firstMessage);

      let startedPostSetup = false;
      let workspaceHumansRefresh: ReturnType<typeof setInterval> | undefined;
      const setupBridge = bridge.setup.bind(bridge);
      bridge.setup = async (setup) => {
        if (!identity) {
          await setupBridge(setup);
          if (startedPostSetup) return;
          startedPostSetup = true;
          log.warn('Slack bot identity unavailable — outbound @-mentions for this bot will not resolve', {
            channelType: ws.channelType,
          });
          return;
        }

        // Socket Mode can deliver inbound events before setup resolves, so the identity is published first.
        const previousIdentity = getKnownSlackBots().get(ws.channelType);
        registerSlackBot(ws.channelType, identity);
        warmChannelDirectory();
        try {
          await setupBridge(setup);
        } catch (err) {
          // A concurrently registered adapter may have replaced this entry; restore only our own.
          if (getKnownSlackBots().get(ws.channelType) === identity) {
            if (previousIdentity) registerSlackBot(ws.channelType, previousIdentity);
            else unregisterSlackBot(ws.channelType, identity);
          }
          throw err;
        }

        if (startedPostSetup) return;
        startedPostSetup = true;
        void upgradeSlackBotProfile(client, ws.channelType);
        // Workspace humans → mention registry, refreshed hourly while this bridge is live.
        void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType);
        workspaceHumansRefresh = setInterval(
          () => void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType),
          60 * 60 * 1000,
        );
        workspaceHumansRefresh.unref();
      };

      const teardownBridge = bridge.teardown.bind(bridge);
      bridge.teardown = async () => {
        if (workspaceHumansRefresh) {
          clearInterval(workspaceHumansRefresh);
          workspaceHumansRefresh = undefined;
        }
        await teardownBridge();
      };
      return bridge;
    },
  });
}

for (const ws of workspaces) {
  registerSlackWorkspace(ws);
}

if (workspaces.length > 1) {
  log.info('Multiple Slack workspaces registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
