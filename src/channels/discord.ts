/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Multi-bot env-var convention (mirrors slack.ts):
 *   DISCORD_BOT_TOKEN=…                   → channelType "discord"
 *   DISCORD_PUBLIC_KEY=…                  (optional — slash-cmd interactions)
 *   DISCORD_APPLICATION_ID=…              (optional — same)
 *   DISCORD_BOT_TOKEN_<SUFFIX>=…          → channelType "discord-<suffix>"
 *   DISCORD_PUBLIC_KEY_<SUFFIX>=…
 *   DISCORD_APPLICATION_ID_<SUFFIX>=…
 *
 * Each suffix is a separate Discord application (created per-bot at
 * discord.com/developers). Suffix is any [A-Za-z0-9_]+, lowercased and
 * `_` → `-` for the channelType — same round-trip as slack.ts so the
 * channel-auto-wire resolver's `-` → `_` reverse mapping works.
 *
 * Slash commands (discord-slash-commands.ts) stay bound to the primary
 * DISCORD_BOT_TOKEN — secondary bots receive @mentions but don't expose
 * /deploy etc.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Constants, MessageType, REST, Routes } from 'discord.js';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Fetch the parent/anchor message that seeded a Discord thread.
 *
 * The Chat SDK encodes thread ids as `discord:{guildId}:{channelId}:{threadId}`
 * where `channelId` is the parent channel and `threadId` (when present) is the
 * Discord thread id. For threads created from a message (the common case for
 * "Reply" auto-thread or right-click → Create Thread), the thread id equals
 * the parent message id, and that message lives in the parent channel — not
 * inside the thread. So `GET /channels/{thread_id}/messages` (what
 * `fetchMessages` calls) skips the anchor entirely.
 *
 * Without this lookup the agent's first wake inside an auto-thread sees only
 * the user's reply, with no idea what they're replying to.
 *
 * Returns null for channel-root messages (no thread part), forum-style
 * threads where the anchor is already the first in-thread message (404), or
 * any error — callers fall through to the normal in-thread history.
 */
interface DiscordRawMessage {
  content?: string;
  timestamp?: string;
  author?: { global_name?: string; username?: string };
  referenced_message?: DiscordRawMessage | null;
}

function parseAnchorMessage(
  msg: DiscordRawMessage,
): { sender: string; text: string; timestamp: string; isAnchor: true } | null {
  const text = msg.content ?? '';
  if (!text) return null;
  const sender = msg.author?.global_name || msg.author?.username || 'unknown';
  const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  return { sender, text, timestamp, isAnchor: true };
}

function makeFetchThreadAnchor(
  botToken: string,
): (
  encodedThreadId: string,
  opts?: { excludeMessageId?: string },
) => Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> | null> {
  return async (encodedThreadId, opts) => {
    const parts = encodedThreadId.split(':');
    if (parts.length < 4 || parts[0] !== 'discord') return null;
    const channelId = parts[2];
    const threadId = parts[3];
    if (!channelId || !threadId) return null;

    // Discord's chat-adapter auto-creates a thread anchored on the user's
    // @mention message — `thread.id == mention.id`. On the first wake the
    // trigger IS the anchor, so the hook bails out: prepending it would
    // duplicate the current turn into the prepended thread context.
    if (opts?.excludeMessageId && opts.excludeMessageId === threadId) return null;

    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${threadId}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    } catch (err) {
      log.debug('Discord anchor fetch network error', {
        encodedThreadId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      log.debug('Discord anchor fetch non-OK', { encodedThreadId, status: response.status });
      return null;
    }
    const m1 = (await response.json()) as DiscordRawMessage;

    // M0: the message M1 was Reply-ing to. Discord inlines `referenced_message`
    // on the GET response when the parent is recent enough (~2 weeks), so no
    // second round-trip is needed. This is the message the user actually
    // wants the agent to act on — the anchor (M1) by itself is often a bare
    // imperative like "fix this" that's meaningless without M0.
    const out: Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> = [];
    const m0 = m1.referenced_message ? parseAnchorMessage(m1.referenced_message) : null;
    if (m0) out.push(m0);
    const m1Parsed = parseAnchorMessage(m1);
    if (m1Parsed) out.push(m1Parsed);
    return out.length > 0 ? out : null;
  };
}

/**
 * Mirror discord.js's `message.system` semantics: keep DEFAULT, REPLY,
 * CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND; drop everything else.
 *
 * THREAD_STARTER_MESSAGE (the synthetic echo Discord inserts inside an
 * auto-thread) would otherwise route the parent's content twice — once at
 * the parent and again when the bridge sees the starter — so it stays
 * filtered even though it carries user-authored text.
 */
const NON_SYSTEM_TYPES = new Set<number>(Constants.NonSystemMessageTypes);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isUserMessage(message: { raw?: any }): boolean {
  const type = message.raw?.type as MessageType | undefined;
  if (type === undefined) return true;
  return NON_SYSTEM_TYPES.has(type);
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const BARE_URL_PATTERN = new RegExp(String.raw`https?:\/\/[^\s<>()\[\]]+`, 'g');
const URL_SHAPED_TEXT_PATTERN = /https?:\/\//;

function discordSafeLinkLabel(url: string): string {
  if (!URL.canParse(url)) return 'Open link';

  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'docs.google.com') {
    if (parsed.pathname.startsWith('/document/')) return 'Open Google Doc';
    if (parsed.pathname.startsWith('/presentation/')) return 'Open Google Slides';
    if (parsed.pathname.startsWith('/spreadsheets/')) return 'Open Google Sheet';
    return 'Open Google file';
  }
  return 'Open link';
}

function safeDiscordLink(url: string): string {
  return `[${discordSafeLinkLabel(url)}](${url})`;
}

function rewriteBareDiscordUrl(urlWithPossiblePunctuation: string): string {
  const trailing = /[.,!?;:]+$/.exec(urlWithPossiblePunctuation)?.[0] ?? '';
  const url = trailing ? urlWithPossiblePunctuation.slice(0, -trailing.length) : urlWithPossiblePunctuation;
  return `${safeDiscordLink(url)}${trailing}`;
}

/**
 * Rewrite URL-shaped links into labels Discord will render.
 *
 * The Discord Chat SDK adapter parses GFM autolinks, then renders every link
 * node as `[label](url)`. For bare URLs, that makes `label === url`, and
 * Discord's anti-phishing filter leaves the literal `[url](url)` text visible.
 * Descriptive masked links render correctly and are left alone.
 *
 * Code regions are protected so URLs inside fenced/inline code stay literal.
 */
export function rewriteDiscordLinks(text: string): string {
  return transformOutsideProtectedRegions(text, (segment) => {
    const protectedLinks: string[] = [];
    const withoutMarkdownLinks = segment.replace(MARKDOWN_LINK_PATTERN, (match, linkText: string, url: string) => {
      const replacement = URL_SHAPED_TEXT_PATTERN.test(linkText) ? safeDiscordLink(url) : match;
      const token = `DISCORD_LINK_PLACEHOLDER_${protectedLinks.length}`;
      protectedLinks.push(replacement);
      return token;
    });

    const withoutBareUrls = withoutMarkdownLinks.replace(BARE_URL_PATTERN, rewriteBareDiscordUrl);
    return withoutBareUrls.replace(
      /DISCORD_LINK_PLACEHOLDER_(\d+)/g,
      (match, index: string) => protectedLinks[Number(index)] ?? match,
    );
  });
}

// ── Sibling-bot mention registry ─────────────────────────────────────────
//
// Discord requires real `<@USER_SNOWFLAKE>` syntax for an @-mention to fire
// the receiving bot's `engage_mode='mention'` wiring. Plain text like
// `@Axie-codex` ships as literal characters — no Discord mention event
// fires, no peer wake. Slack's chat-adapter rewrites bare `@username` to
// `<@U…>` server-side via a cached lookup; the Discord adapter doesn't.
//
// We close the gap by maintaining a process-wide registry of every Discord
// bot this host has loaded — keyed by channelType, populated by a one-shot
// `GET /users/@me` call when each adapter factory runs. The outbound text
// transform then rewrites `@bot-username` to `<@id>` so sibling handoffs
// actually wake the peer.
//
// Limited to bots running in this process: a third-party bot in the same
// guild whose token we don't carry will not be in the registry, and its
// `@name` references will be left as plain text. That's the correct
// fail-soft — we never invent a snowflake we can't verify.

export interface DiscordBotIdentity {
  userId: string;
  username: string;
}

const knownDiscordBots = new Map<string, DiscordBotIdentity>();

// Cross-package channel for the patched chat-adapter. The patched
// MessageCreate / reaction handlers in @chat-adapter/discord need to know
// which bot ids belong to sibling NanoClaw bots in this process so they
// can let those messages through while still dropping unrelated third-
// party bots (webhooks, music bots, MEE6, etc.). The patch reads this Set
// off globalThis at message-arrival time so adapter init order doesn't
// matter. Keep the property name in sync with the patch.
const NANOCLAW_DISCORD_SIBLINGS = '__nanoclawDiscordSiblings';

interface GlobalWithSiblings {
  [NANOCLAW_DISCORD_SIBLINGS]?: Set<string>;
}

function publishSiblingId(userId: string): void {
  const g = globalThis as unknown as GlobalWithSiblings;
  if (!g[NANOCLAW_DISCORD_SIBLINGS]) g[NANOCLAW_DISCORD_SIBLINGS] = new Set();
  g[NANOCLAW_DISCORD_SIBLINGS].add(userId);
}

/**
 * Look up a bot's identity from Discord via REST. Single round-trip on
 * adapter init; the result is cached in `knownDiscordBots` for the lifetime
 * of the process. Returns null on any failure — outbound mention rewriting
 * gracefully no-ops if the registry is empty or the username can't be
 * resolved.
 *
 * Hard timeout: channel-registry awaits factories serially, so a stalled
 * Discord CDN connection at host boot would block every adapter that
 * registers after Discord. 5s is well above Discord's typical p99 for this
 * endpoint and short enough that a hung connection doesn't visibly delay
 * startup.
 */
const DISCORD_REST_TIMEOUT_MS = 5000;

async function fetchDiscordBotIdentity(botToken: string): Promise<DiscordBotIdentity | null> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(DISCORD_REST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('Discord bot identity fetch non-OK', { status: res.status });
      return null;
    }
    const user = (await res.json()) as { id?: string; username?: string };
    if (!user.id || !user.username) return null;
    return { userId: user.id, username: user.username };
  } catch (err) {
    log.warn('Discord bot identity fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Rewrite `@bot-username` (plain text) to a real Discord mention
 * `<@USER_ID>` for every bot in `bots`. Case-insensitive on the username.
 * Code regions are passed through unchanged.
 *
 * Exported with the registry as an injectable parameter so tests can supply
 * a synthetic bot set without touching the module-level Map.
 */
export function resolveDiscordMentions(text: string, bots: Map<string, DiscordBotIdentity> = knownDiscordBots): string {
  if (bots.size === 0) return text;

  // Username → id, lowercased for case-insensitive matching.
  const byName = new Map<string, string>();
  for (const { userId, username } of bots.values()) {
    byName.set(username.toLowerCase(), userId);
  }

  // Discord usernames allow `[a-z0-9_.]` post-2023; we additionally accept
  // `-` so legacy usernames like "Axie-Codex" still resolve.
  //
  // The `(?<!\w)` lookbehind anchors the `@` to a word boundary — without
  // it, `user@domain.com` would parse as `@domain.com` and look up a bot
  // named "domain.com". In practice that fail-softs (no match), but the
  // boundary check makes intent explicit and avoids surprise if a bot's
  // username ever collides with the right-hand side of an email or path.
  //
  // Username body: word chars and dashes, with OPTIONAL `.suffix` segments
  // so `user.name` still resolves but a trailing sentence-ending period
  // ("Your turn, @Axie-Codex.") doesn't gobble into the capture and miss
  // the lookup. A naïve `[\w.-]+` swallows the trailing period, which then
  // misses `byName.get("axie-codex.")` and falls through to the
  // chat-sdk-adapter's own `/@(\w+)/g` pass — which captures only `@Axie`
  // (no dash support) and brackets it to `<@Axie>`, leaving `-Codex.` as
  // dangling text. That double-failure was the live Discord bug.
  //
  // Two passes by design, agent-mistake-tolerant:
  //   1. `<@Name>` — the bracketed form agents sometimes emit when they
  //      remember the Slack `<@U123>` template but substitute the username
  //      instead of the snowflake. Discord would render this as literal
  //      text. We catch it here and rewrite to `<@id>`.
  //   2. `@Name` — the canonical bare form per container/CLAUDE.md
  //      guidance.
  // Real `<@SNOWFLAKE>` mentions and `<@&ROLE>` role mentions are
  // unaffected: byName keys are usernames, so digits-only or `&`-prefixed
  // captures don't match the lookup. The bare-form pass skips text
  // preceded by `<` so it never re-touches what pass 1 just emitted.
  // Boundary: `(?<![\w/:])` — the `/` and `:` exclusions keep
  // `https://example.com/@user` from getting its path corrupted into
  // `https://example.com/<@SNOWFLAKE>`. transformOutsideProtectedRegions
  // only shields code spans, not URL regions. Mirrors slack-mentions.ts.
  const USERNAME = String.raw`[\w-]+(?:\.[\w-]+)*`;
  const BRACKETED_MENTION_RE = new RegExp(String.raw`(?<![\w/:])<@(${USERNAME})>`, 'g');
  const BARE_MENTION_RE = new RegExp(String.raw`(?<![\w/:])@(${USERNAME})`, 'g');

  return transformOutsideProtectedRegions(text, (segment) => {
    const rewriteByName = (match: string, name: string): string => {
      const id = byName.get(name.toLowerCase());
      return id ? `<@${id}>` : match;
    };

    const afterBracketed = segment.replace(BRACKETED_MENTION_RE, rewriteByName);
    return afterBracketed.replace(BARE_MENTION_RE, (match, name: string, offset: number) => {
      // Skip if `@` is preceded by `<` — pass 1 already handled bracketed
      // forms, and `<@SNOWFLAKE>` / `<@&ROLE>` syntax stays untouched.
      if (offset > 0 && afterBracketed[offset - 1] === '<') return match;
      return rewriteByName(match, name);
    });
  });
}

/**
 * Inbound counterpart to `resolveDiscordMentions`. Rewrites Discord's raw
 * `<@SNOWFLAKE>` / `<@!SNOWFLAKE>` user-mention syntax to `@bot_username`
 * for any registered NanoClaw bot. Unknown snowflakes (human users, bots
 * outside this process) pass through unchanged so the host can still log
 * the raw form for debugging.
 *
 * Why bots only: this exists to fix sibling handoff. The agent needs to
 * know its peer is called `Axie-Codex` (not just snowflake 1505...). It
 * doesn't need human display names — the chat-sdk Message envelope
 * already carries `author.fullName` for the sender, and humans aren't
 * routing targets.
 *
 * Role mentions (`<@&ROLE>`) and channel mentions (`<#CHAN>`) are not
 * touched — the regex demands a digit-only capture so `&` and `#`
 * prefixes fall through.
 *
 * Code regions are skipped via `transformOutsideProtectedRegions`,
 * mirroring the outbound rewriter. A pasted log line like
 * `` `payload: <@123>` `` stays verbatim — the user put it in code on
 * purpose, and the agent reading the inbound is better served by the
 * exact text the user typed than by a "helpful" name substitution
 * inside what is meant to be raw content.
 */
export function resolveIncomingDiscordMentions(
  text: string,
  bots: Map<string, DiscordBotIdentity> = knownDiscordBots,
): string {
  if (bots.size === 0) return text;
  const byId = new Map<string, string>();
  for (const { userId, username } of bots.values()) {
    byId.set(userId, username);
  }
  // `<@123>` is a normal mention; `<@!123>` is the legacy "nickname mention"
  // form some older Discord clients still emit. Both resolve to the same user.
  return transformOutsideProtectedRegions(text, (segment) =>
    segment.replace(/<@!?(\d+)>/g, (match, id: string) => {
      const username = byId.get(id);
      return username ? `@${username}` : match;
    }),
  );
}

/** Minimal REST interface for Discord operations — narrow surface for testing. */
export interface DiscordRestClient {
  post(route: `/${string}`, options?: { body?: unknown }): Promise<unknown>;
}

/**
 * Strip the `discord:` scheme prefix and leading `guildId:` segment from a
 * NanoClaw platform_id, leaving the raw Discord channel ID that the REST API
 * expects. Tolerates `discord:guildId:channelId`, `discord:guildId:channelId:threadId`,
 * and bare `channelId` (test inputs). The host's regular delivery path
 * normalizes via the chat-sdk bridge — these helpers are called from
 * orchestrator-dispatch directly and need to do their own normalization or
 * the REST call hits `/channels/discord:.../messages` and returns 404.
 */
export function extractDiscordChannelId(platformId: string): string {
  if (!platformId.startsWith('discord:')) return platformId;
  const parts = platformId.split(':');
  // discord:{guildId}:{channelId}[:{threadId}] — the channel id we want is index 2
  return parts[2] ?? platformId;
}

/**
 * Post a message to the top level of a Discord channel.
 * Exported for unit testing.
 */
export async function discordPostParent(
  rest: DiscordRestClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channelId = extractDiscordChannelId(platformId);
  const msg = (await rest.post(Routes.channelMessages(channelId), {
    body: { content: text },
  })) as { id: string };
  return { messageId: msg.id };
}

/**
 * Create a Discord thread from a parent message and post the first message.
 * Exported for unit testing.
 */
export async function discordCreateThread(
  rest: DiscordRestClient,
  platformId: string,
  parentMessageId: string,
  title: string,
  firstMessage: string,
): Promise<{ threadId: string; messageId: string }> {
  const channelId = extractDiscordChannelId(platformId);
  const thread = (await rest.post(Routes.threads(channelId, parentMessageId), {
    body: { name: title },
  })) as { id: string };
  const firstMsg = (await rest.post(Routes.channelMessages(thread.id), {
    body: { content: firstMessage },
  })) as { id: string };
  return { threadId: thread.id, messageId: firstMsg.id };
}

export interface DiscordWorkspace {
  channelType: string;
  botToken: string;
  publicKey?: string;
  applicationId?: string;
}

/**
 * Pure helper — parse Discord workspace configs from an env key/value map.
 * Exported for testing. Mirrors parseSlackWorkspaces in `slack.ts`.
 *
 * Only DISCORD_BOT_TOKEN is required to register a workspace. publicKey
 * and applicationId are optional (only consumed when slash-command
 * interactions are configured for that app), so a token-only entry still
 * yields a working chat adapter.
 */
export function parseDiscordWorkspaces(env: Record<string, string>): DiscordWorkspace[] {
  const bySuffix = new Map<string, { botToken?: string; publicKey?: string; applicationId?: string }>();

  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^DISCORD_(BOT_TOKEN|PUBLIC_KEY|APPLICATION_ID)(?:_([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase().replace(/_/g, '-') : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else if (kind === 'PUBLIC_KEY') entry.publicKey = value;
    else entry.applicationId = value;
    bySuffix.set(suffix, entry);
  }

  const workspaces: DiscordWorkspace[] = [];
  for (const [suffix, parts] of bySuffix) {
    if (!parts.botToken) continue;
    workspaces.push({
      channelType: suffix ? `discord-${suffix}` : 'discord',
      botToken: parts.botToken,
      publicKey: parts.publicKey,
      applicationId: parts.applicationId,
    });
  }
  return workspaces;
}

// Pre-filter regex must allow `_` in the suffix so env vars like
// DISCORD_BOT_TOKEN_AXIE_CODEX reach the parser intact.
const workspaces = parseDiscordWorkspaces(
  readEnvFileMatching(/^DISCORD_(BOT_TOKEN|PUBLIC_KEY|APPLICATION_ID)(_[A-Za-z0-9_]+)?$/),
);

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    factory: async () => {
      // Discover this bot's user id + username so sibling bots in the same
      // process can resolve `@username` → `<@id>` on outbound. One REST call
      // at adapter init; cached for the lifetime of the process.
      const identity = await fetchDiscordBotIdentity(ws.botToken);
      if (identity) {
        knownDiscordBots.set(ws.channelType, identity);
        publishSiblingId(identity.userId);
      } else {
        log.warn('Discord bot identity unavailable — outbound @-mentions for this bot will not resolve', {
          channelType: ws.channelType,
        });
      }

      const discordAdapter = createDiscordAdapter({
        botToken: ws.botToken,
        publicKey: ws.publicKey,
        applicationId: ws.applicationId,
      });
      // Multi-bot dedup isolation. The chat-adapter's message-dedup key is
      // `dedupe:${adapter.name}:${message.id}`. createDiscordAdapter defaults
      // `name = "discord"` for every instance (verified at
      // @chat-adapter/discord dist:364); combined with a shared SqliteState
      // adapter, two Discord adapters processing the same Discord message
      // (same id) would collide on the dedup key and the second silently
      // drops the message. This bites the two-bots-in-same-guild case (e.g.
      // axie + axie-codex both observing user messages in #chat).
      //
      // Override adapter.name to the channelType so each workspace has its
      // own dedup keyspace. The name also keys `chat.webhooks[...]` — but
      // Discord is a gateway adapter (not webhook), so that path doesn't
      // fire here. Mirrors the equivalent override in slack.ts.
      (discordAdapter as unknown as { name: string }).name = ws.channelType;
      const rest = new REST({ version: '10' }).setToken(ws.botToken);
      const bridge = createChatSdkBridge({
        adapter: discordAdapter,
        concurrency: 'concurrent',
        botToken: ws.botToken,
        extractReplyContext,
        supportsThreads: true,
        maxTextLength: 1900,
        channelType: ws.channelType,
        // Markdown delivery (not raw) keeps the chat-adapter's tableToAscii
        // conversion in play; without it, Markdown tables would render as raw
        // `|`-pipe text in Discord (no native table block).
        //
        // resolveDiscordMentions runs first so any `@bot-username` it rewrites
        // to `<@id>` is then passed through rewriteDiscordLinks unchanged
        // (the link rewriter only touches markdown links and bare URLs, never
        // mention syntax).
        transformOutboundMarkdown: (text) => rewriteDiscordLinks(resolveDiscordMentions(text)),
        // Inbound counterpart: turn the raw `<@snowflake>` form Discord
        // delivers into `@bot_username` for any sibling bot, so the agent
        // can address its peer by name instead of guessing.
        transformInboundText: (text) => resolveIncomingDiscordMentions(text),
        inboundFilter: isUserMessage,
        fetchThreadAnchor: makeFetchThreadAnchor(ws.botToken),
      });
      bridge.postParent = (platformId, text) => discordPostParent(rest, platformId, text);
      bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
        discordCreateThread(rest, platformId, parentMessageId, title, firstMessage);
      return bridge;
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Discord bots registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
