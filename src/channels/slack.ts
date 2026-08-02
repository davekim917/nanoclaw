/**
 * Slack channel adapter — FORK DEVIATION from upstream /add-slack.
 *
 * Upstream ships a single-workspace adapter (one SLACK_BOT_TOKEN +
 * SLACK_SIGNING_SECRET, channelType "slack"). Our fork needs multiple
 * concurrent Slack workspaces in one host process because we run a
 * primary Slack + the Example Labs Slack side-by-side.
 *
 * Multi-workspace env-var convention:
 *   SLACK_BOT_TOKEN=xoxb-…                    → channelType "slack"
 *   SLACK_SIGNING_SECRET=…
 *   SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…           → channelType "slack-<suffix>"
 *   SLACK_SIGNING_SECRET_<SUFFIX>=…
 *
 * Each workspace is a separate Slack app (created per-workspace at
 * api.slack.com/apps, "Not distributed"). Suffix is any [A-Za-z0-9_]+
 * (alphanumerics + underscore — matches the convention used by other
 * scoped env vars in this fork like GITHUB_TOKEN_EXAMPLE_RETAIL) and is
 * lowercased for the channelType.
 *
 * This file is re-applied on top of the upstream /add-slack output so
 * `/add-slack` remains an idempotent install that preserves the
 * channels-via-skills model, and the deviation is a single clearly-
 * commented overlay. Revisit upstreaming after cutover — the only piece
 * of the NanoClaw core this requires is the optional `channelType`
 * override on createChatSdkBridge (already merged upstream-compatible).
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import { WebClient } from '@slack/web-api';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { markdownHeadingsToBold } from '../text-styles.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { ChannelRecoveryRequest, ChannelRecoveryTarget } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  fetchSlackBotIdentity,
  registerSlackBot,
  registerSlackWorkspaceHumans,
  resolveSlackMentions,
  upgradeSlackBotProfile,
  type SlackBotIdentity,
} from './slack-mentions.js';

/**
 * Fetch the workspace's human members and register them for outbound
 * mention resolution. Bots/apps/deleted users are excluded — bot mentions
 * resolve through the sibling-bot registry, and Slackbot is never a target.
 * Fail-soft: a missing `users:read` scope logs a warning and leaves human
 * mentions unresolved (bot mentions keep working).
 */
async function syncSlackWorkspaceHumans(client: WebClient, teamId: string, channelType: string): Promise<void> {
  try {
    const humans: SlackBotIdentity[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const m of res.members ?? []) {
        if (!m.id || m.deleted || m.is_bot || m.is_app_user || m.id === 'USLACKBOT') continue;
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
  signingSecret: string;
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

/** Find threads created or updated during the gap before they have a session. */
export async function discoverSlackRecoveryTargets(
  client: WebClient,
  request: ChannelRecoveryRequest,
): Promise<{ targets: ChannelRecoveryTarget[]; complete: boolean }> {
  const sinceMs = Date.parse(request.since);
  const targets: ChannelRecoveryTarget[] = [];
  let complete = true;

  for (const root of request.targets) {
    if (root.threadId !== null) continue;
    const channel = root.platformId.split(':')[1];
    if (!channel) continue;
    let cursor: string | undefined;
    let coveredBoundary = false;
    const seenCursors = new Set<string>();
    for (;;) {
      const response = await client.conversations.history({ channel, limit: 100, cursor });
      const messages = (response.messages ?? []) as SlackRecoveryMessage[];
      for (const message of messages) {
        const rootTs = message.ts ?? '';
        const rootMs = Number(rootTs) * 1000;
        const latestReplyMs = Number(message.latest_reply) * 1000;
        const hasGapReply = (message.reply_count ?? 0) > 0 && Number.isFinite(latestReplyMs) && latestReplyMs > sinceMs;
        const createdInGap = Number.isFinite(rootMs) && rootMs > sinceMs;
        if ((hasGapReply || createdInGap) && rootTs) {
          targets.push({ platformId: root.platformId, threadId: `slack:${channel}:${rootTs}`, isDM: root.isDM });
        }
      }
      const nextCursor = response.response_metadata?.next_cursor || undefined;
      // Slack has no thread-activity index: an old channel or DM root can
      // receive its first reply during the gap. Cover the conversation's full
      // root history so those threads are discoverable, not just roots newer
      // than `since`.
      if (!nextCursor) {
        coveredBoundary = true;
        break;
      }
      if (seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!coveredBoundary) complete = false;
  }

  return { targets, complete };
}

/**
 * Pure helper — parse workspace configs from an env key/value map.
 * Exported for testing.
 *
 * Suffix-to-channelType derivation: lowercase, then map `_` → `-`. This
 * keeps env-var names readable when an underscore appears (e.g.
 * SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX) while producing a channelType that
 * matches the existing dash-separated convention (slack-example-labs-codex).
 * The reverse direction at channel-auto-wire/index.ts:67 already maps
 * `-` → `_` when building env-var lookups, so the round-trip is stable.
 */
export function parseSlackWorkspaces(env: Record<string, string>): SlackWorkspace[] {
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

  const workspaces: SlackWorkspace[] = [];
  for (const [suffix, pair] of bySuffix) {
    if (!pair.botToken) continue;
    if (!pair.signingSecret) {
      log.warn('Slack workspace missing signing secret, skipping', {
        suffix: suffix || '(primary)',
      });
      continue;
    }
    workspaces.push({
      channelType: suffix ? `slack-${suffix}` : 'slack',
      botToken: pair.botToken,
      signingSecret: pair.signingSecret,
    });
  }
  return workspaces;
}

/** Minimal interface for the Slack chat.postMessage client — narrow surface for testing. */
export interface SlackPostMessageClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string | null }>;
  };
}

/**
 * Strip the `slack:` scheme prefix from a NanoClaw platform_id, leaving the
 * raw Slack channel ID the Web API expects. Tolerates both prefixed
 * (`slack:CTEST00004`, the canonical messaging_groups.platform_id form) and
 * raw (`CTEST00004`, used in unit tests) inputs. The host's regular delivery
 * path normalizes via the chat-sdk bridge — these helpers are called from
 * orchestrator-dispatch directly and need to do their own normalization or
 * Slack returns `channel_not_found`.
 */
export function extractSlackChannelId(platformId: string): string {
  return platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
}

/**
 * Post a message to the top level of a Slack channel.
 * Exported for unit testing.
 */
export async function slackPostParent(
  client: SlackPostMessageClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const response = await client.chat.postMessage({ channel, text });
  return { messageId: response.ts as string };
}

/**
 * Create a Slack thread by posting a reply to an existing parent message.
 * threadId IS the parent message's ts (Slack thread_ts semantic) — NOT reply.ts.
 * Exported for unit testing.
 */
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

// Keep the pre-filter regex in sync with the suffix regex inside
// parseSlackWorkspaces — both must allow `_` in the suffix, otherwise
// env vars like SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX get dropped here before
// they ever reach the parser.
const workspaces = parseSlackWorkspaces(readEnvFileMatching(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(_[A-Za-z0-9_]+)?$/));

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    factory: async () => {
      const slackAdapter = createSlackAdapter({
        botToken: ws.botToken,
        signingSecret: ws.signingSecret,
      });
      // Multi-workspace dedup isolation. The @chat library's message dedup
      // key is `dedupe:${adapter.name}:${message.id}`. SlackAdapter defaults
      // `name = "slack"` for all instances; combined with a shared SqliteState
      // adapter (state-sqlite.ts uses getDb()), two slack adapters processing
      // the same Slack event (same `ts`) collide on the dedup key and the
      // second one silently drops the message. This bites the two-bots-in-
      // same-workspace case (e.g. helper + helper-codex both seeing user
      // messages in #agents-example). Across-workspace it doesn't bite because
      // each Slack workspace's `ts` values are disjoint.
      //
      // Override the adapter name to the channelType so each workspace has
      // its own dedup keyspace. The name also keys `chat.webhooks[...]` so
      // the webhook-server lookup matches.
      (slackAdapter as unknown as { name: string }).name = ws.channelType;
      const client = new WebClient(ws.botToken);

      // Discover this bot's user_id + username + team_id so sibling bots in
      // the same Slack workspace can resolve `@username` → `<@USER_ID>` on
      // outbound. One auth.test call at adapter init; cached for the
      // lifetime of the process. Mirrors discord.ts's fetchDiscordBotIdentity.
      //
      // Profile alias enrichment (displayName/realName from users.info)
      // runs as fire-and-forget AFTER registration so it doesn't extend
      // serial channel-factory startup. The registry has username
      // resolution working immediately; the additional aliases appear
      // once the (typically sub-second) users.info call completes.
      const identity = await fetchSlackBotIdentity(client);
      if (identity) {
        registerSlackBot(ws.channelType, identity);
        void upgradeSlackBotProfile(client, ws.channelType);
        // Workspace humans → mention registry, so agent-emitted `@Alice` /
        // `<@bob>` resolve without a hand-maintained roster. Fire-and-forget
        // at init (same pattern as profile enrichment) + hourly refresh so
        // new teammates resolve without a restart. Degrades gracefully when
        // the token lacks users:read.
        void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType);
        setInterval(
          () => void syncSlackWorkspaceHumans(client, identity.teamId, ws.channelType),
          60 * 60 * 1000,
        ).unref();
      } else {
        log.warn('Slack bot identity unavailable — outbound @-mentions for this bot will not resolve', {
          channelType: ws.channelType,
        });
      }

      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        concurrency: 'concurrent',
        supportsThreads: true,
        channelType: ws.channelType,
        // ATX headings → bold so Block Kit table delivery stays on the
        // `markdown` path (table-block conversion only fires for markdown/ast
        // input). The adapter handles bold/italic/links/lists/tables natively.
        //
        // resolveSlackMentions runs first so `@bot-username` becomes
        // `<@USER_ID>` (Slack's required mention syntax) BEFORE Markdown
        // heading conversion — the rewriter only touches `@…` tokens, and
        // markdownHeadingsToBold only touches line-anchored `#` prefixes,
        // so order is independent for correctness but consistent for
        // intent.
        transformOutboundMarkdown: (text) => markdownHeadingsToBold(resolveSlackMentions(text, ws.channelType)),
        detectRecoveredMention: (message) => {
          if (!identity) return false;
          const raw = message.raw as { text?: string } | undefined;
          return raw?.text?.includes(`<@${identity.userId}>`) === true;
        },
        fetchRecoveryPage: makeSlackRecoveryPageFetcher(slackAdapter, client),
        discoverRecoveryTargets: (request) => discoverSlackRecoveryTargets(client, request),
      });
      bridge.postParent = (platformId, text) => slackPostParent(client, platformId, text);
      bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
        slackCreateThread(client, platformId, parentMessageId, title, firstMessage);
      return bridge;
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Slack workspaces registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
