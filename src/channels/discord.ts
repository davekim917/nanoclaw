/**
 * Discord channel adapter over the Chat SDK bridge; self-registers on import.
 * Multi-bot env convention mirrors slack.ts: `DISCORD_BOT_TOKEN` → channelType "discord";
 * `DISCORD_BOT_TOKEN_<SUFFIX>` → "discord-<suffix>" (lowercased, `_` → `-`, the round-trip channel-auto-wire
 * reverses), with optional `DISCORD_PUBLIC_KEY[_<SUFFIX>]` and `DISCORD_APPLICATION_ID[_<SUFFIX>]`. Slash commands
 * stay bound to the primary token.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Constants, MessageType, REST, RESTJSONErrorCodes, Routes } from 'discord.js';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { getOwners } from '../modules/permissions/db/user-roles.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { linkDiscordChannelNames, warmChannelDirectory } from './channel-links.js';
import type { ChannelRecoveryRequest, ChannelRecoveryTarget } from './adapter.js';

interface DiscordRecoveryThread {
  id: string;
  parent_id?: string | null;
  guild_id?: string | null;
  last_message_id?: string | null;
  thread_metadata?: { archive_timestamp?: string };
}

const DISCORD_EPOCH_MS = 1420070400000n;

function snowflakeMs(id: string | null | undefined): number | null {
  if (!id) return null;
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

/**
 * Keeps only threads active at or after the gap start (`last_message_id`, already in the list payload); without this
 * every pass re-scans every thread ever created. `since` is already floored to the durable gap floor. Fails OPEN: a
 * thread with no parseable marker is kept.
 */
function threadTouchedSince(thread: DiscordRecoveryThread, sinceMs: number): boolean {
  if (!Number.isFinite(sinceMs)) return true;
  const lastMs = snowflakeMs(thread.last_message_id) ?? snowflakeMs(thread.id);
  return lastMs === null || lastMs >= sinceMs;
}

interface DiscordThreadList {
  threads?: DiscordRecoveryThread[];
  has_more?: boolean;
}

function discordThreadTarget(root: ChannelRecoveryTarget, guildId: string, threadId: string): ChannelRecoveryTarget {
  const channelId = root.platformId.split(':')[2];
  return {
    platformId: root.platformId,
    threadId: `discord:${guildId}:${channelId}:${threadId}`,
    isDM: false,
  };
}

/** Discovers threads that received messages during a gap before a session existed. */
/**
 * Errors meaning a recovery target is unreachable by wiring (channel or guild gone, access lost); the bridge parks
 * these targets instead of failing the pass.
 */
const PERMANENT_DISCORD_RECOVERY_CODES = new Set([10003, 10004, 50001]); // Unknown Channel, Unknown Guild, Missing Access

function classifyDiscordRecoveryError(err: unknown): 'permanent' | 'transient' {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number' && PERMANENT_DISCORD_RECOVERY_CODES.has(code)) return 'permanent';
  const message = err instanceof Error ? err.message : '';
  return message.includes('Unknown Channel') || message.includes('Unknown Guild') || message.includes('Missing Access')
    ? 'permanent'
    : 'transient';
}

export async function discoverDiscordRecoveryTargets(
  rest: Pick<REST, 'get'>,
  request: ChannelRecoveryRequest,
): Promise<{
  targets: ChannelRecoveryTarget[];
  complete: boolean;
  failed: Array<{ target: ChannelRecoveryTarget; error: unknown }>;
}> {
  const roots = request.targets.filter((target) => !target.isDM && target.threadId === null);
  const sinceMs = Date.parse(request.since);
  const targets: ChannelRecoveryTarget[] = [];
  const failed: Array<{ target: ChannelRecoveryTarget; error: unknown }> = [];
  const failedRootKeys = new Set<string>();
  const rootsByGuild = new Map<string, ChannelRecoveryTarget[]>();
  for (const root of roots) {
    const [, guildId, channelId] = root.platformId.split(':');
    if (!guildId || !channelId) continue;
    const guildRoots = rootsByGuild.get(guildId) ?? [];
    guildRoots.push(root);
    rootsByGuild.set(guildId, guildRoots);
  }

  // Per-guild fault isolation: one dead channel or guild must not abort discovery for the rest.
  for (const [guildId, guildRoots] of rootsByGuild) {
    try {
      const active = (await rest.get(Routes.guildActiveThreads(guildId))) as DiscordThreadList;
      const rootByChannel = new Map(guildRoots.map((root) => [root.platformId.split(':')[2], root]));
      for (const thread of active.threads ?? []) {
        const root = thread.parent_id ? rootByChannel.get(thread.parent_id) : undefined;
        if (root && threadTouchedSince(thread, sinceMs)) targets.push(discordThreadTarget(root, guildId, thread.id));
      }
    } catch (err) {
      for (const root of guildRoots) {
        failed.push({ target: root, error: err });
        failedRootKeys.add(root.platformId);
      }
    }
  }

  let complete = true;
  for (const root of roots) {
    if (failedRootKeys.has(root.platformId)) continue;
    const [, guildId, channelId] = root.platformId.split(':');
    if (!guildId || !channelId) continue;
    try {
      for (const archive of [
        { route: Routes.channelThreads(channelId, 'public'), cursor: 'timestamp' as const },
        { route: Routes.channelJoinedArchivedThreads(channelId), cursor: 'snowflake' as const },
      ]) {
        let before: string | undefined;
        let coveredBoundary = false;
        const seenCursors = new Set<string>();
        for (;;) {
          const query = new URLSearchParams({ limit: '100' });
          if (before) query.set('before', before);
          const archived = (await rest.get(archive.route, { query })) as DiscordThreadList;
          const threads = archived.threads ?? [];
          let oldestArchiveMs = Number.POSITIVE_INFINITY;
          for (const thread of threads) {
            if (threadTouchedSince(thread, sinceMs)) targets.push(discordThreadTarget(root, guildId, thread.id));
            // Boundary detection covers EVERY thread on the page, filtered or not; it drives pagination termination.
            const archivedMs = Date.parse(thread.thread_metadata?.archive_timestamp ?? '');
            if (Number.isFinite(archivedMs)) oldestArchiveMs = Math.min(oldestArchiveMs, archivedMs);
          }
          // Public archives are ordered by archive_timestamp, so reaching the gap boundary ends the scan. Joined
          // private archives are ordered by snowflake and an old private thread can be reactivated in the gap, so
          // that endpoint must be exhausted.
          const reachedTimeBoundary = archive.cursor === 'timestamp' && oldestArchiveMs <= sinceMs;
          if (reachedTimeBoundary || archived.has_more !== true) {
            coveredBoundary = true;
            break;
          }
          before =
            archive.cursor === 'timestamp' ? threads.at(-1)?.thread_metadata?.archive_timestamp : threads.at(-1)?.id;
          if (!before) break;
          if (seenCursors.has(before)) break;
          seenCursors.add(before);
        }
        if (!coveredBoundary) complete = false;
      }
    } catch (err) {
      failed.push({ target: root, error: err });
    }
  }

  return { targets, complete, failed };
}

/**
 * Discord FORWARDS (`message_reference.type === 1`) carry text and attachments in `message_snapshots` with an empty
 * top-level `content`, which the chat-adapter would deliver as an empty message; unwrap the snapshot into the payload
 * before the adapter builds its Message. Snapshots carry no author, so the content is labeled `[Forwarded message]`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((snapshot: any) => snapshot?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  const text = snaps
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((message: any) => message.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forwardedAttachments = snaps.flatMap((message: any) => message.attachments ?? []);
  if (forwardedAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...forwardedAttachments];
  }
}

/**
 * `handleForwardedMessage` is the live inbound seam: the Gateway listener runs in webhook-forwarding mode, so every
 * MESSAGE_CREATE arrives through it as raw JSON.
 */
export function installForwardUnwrap(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const target = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const original = target.handleForwardedMessage.bind(adapter);
  target.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return original(data, options);
  };
}

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

    // The chat-adapter anchors an auto-created thread on the @mention message (`thread.id == mention.id`), so on the
    // first wake the trigger IS the anchor; prepending it would duplicate the current turn.
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

    // M0, the message M1 replied to: inlined as `referenced_message` when recent (~2 weeks). The anchor alone is
    // often a bare "fix this" that is meaningless without it.
    const out: Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> = [];
    const m0 = m1.referenced_message ? parseAnchorMessage(m1.referenced_message) : null;
    if (m0) out.push(m0);
    const m1Parsed = parseAnchorMessage(m1);
    if (m1Parsed) out.push(m1Parsed);
    return out.length > 0 ? out : null;
  };
}

/**
 * Mirrors discord.js's `message.system`: THREAD_STARTER_MESSAGE is filtered even though it carries user text, or the
 * parent's content would route twice.
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
 * The Discord adapter renders every link as `[label](url)`, and for a bare URL (`label === url`) Discord's
 * anti-phishing filter leaves the literal text visible, so such links are rewritten. Code regions stay literal.
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

// Sibling-bot mention registry. A Discord @-mention only fires as real `<@SNOWFLAKE>` syntax (plain `@Name` wakes
// nothing), and unlike Slack the adapter does not rewrite it. Every Discord bot this host loads registers its
// identity via `GET /users/@me`, and outbound text rewrites `@bot-username` to `<@id>`. Bots whose token we do not
// hold stay plain text: never invent a snowflake.

export interface DiscordBotIdentity {
  userId: string;
  username: string;
}

const knownDiscordBots = new Map<string, DiscordBotIdentity>();

/**
 * Null when the bot is not registered (e.g. a spawn racing adapter init); the caller falls back to the next resolver.
 */
export function getDiscordBotDisplayName(channelType: string): string | null {
  return knownDiscordBots.get(channelType)?.username ?? null;
}

/** Read-only view of the registry, mirroring `getKnownSlackBots`. */
export function getKnownDiscordBots(): ReadonlyMap<string, DiscordBotIdentity> {
  return knownDiscordBots;
}

// Read by the patched @chat-adapter/discord at message-arrival time to admit sibling NanoClaw bots while dropping
// unrelated bots; keep the property name in sync with the patch.
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
 * One REST call at adapter init, cached for the process; null on any failure (mention rewriting then no-ops). Hard
 * timeout because channel-registry awaits factories serially, so a stalled call at boot would block every later
 * adapter.
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
 * Rewrites `@bot-username` to `<@USER_ID>` (case-insensitive), skipping code regions. `bots` is injectable for tests.
 */
export function resolveDiscordMentions(text: string, bots: Map<string, DiscordBotIdentity> = knownDiscordBots): string {
  if (bots.size === 0) return text;

  // Each bot also gets a separator-stripped alias; an exact literal owns its slot and aliases fill only unowned slots
  // (mirrors slack-mentions.ts).
  const byName = new Map<string, string>();
  const literalKeys = new Set<string>();
  for (const { userId, username } of bots.values()) {
    const literal = username.toLowerCase();
    byName.set(literal, userId);
    literalKeys.add(literal);
  }
  for (const { userId, username } of bots.values()) {
    const literal = username.toLowerCase();
    const normalized = normalizeHandle(literal);
    if (normalized === literal) continue;
    if (literalKeys.has(normalized)) continue;
    if (byName.has(normalized)) continue;
    byName.set(normalized, userId);
  }

  // `(?<![\w/:])` anchors `@` to a boundary so emails and URL paths (`https://x/@user`) are never rewritten;
  // transformOutsideProtectedRegions only shields code. The username allows optional `.suffix` segments so a
  // sentence-ending period is not captured (it would miss the lookup and leave the adapter's own `@(\w+)` pass to
  // mangle the name).
  // Two passes: bracketed `<@Name>` (agents misapplying Slack's template) then bare `@Name`. Real `<@SNOWFLAKE>` and
  // `<@&ROLE>` never match a username key.
  const USERNAME = String.raw`[\w-]+(?:\.[\w-]+)*`;
  const BRACKETED_MENTION_RE = new RegExp(String.raw`(?<![\w/:])<@(${USERNAME})>`, 'g');
  const BARE_MENTION_RE = new RegExp(String.raw`(?<![\w/:])@(${USERNAME})`, 'g');

  return transformOutsideProtectedRegions(text, (segment) => {
    const rewriteByName = (match: string, name: string): string => {
      const literal = name.toLowerCase();
      const id = byName.get(literal) ?? byName.get(normalizeHandle(literal));
      return id ? `<@${id}>` : match;
    };

    const afterBracketed = segment.replace(BRACKETED_MENTION_RE, rewriteByName);
    return afterBracketed.replace(BARE_MENTION_RE, (match, name: string, offset: number) => {
      // Pass 1 already handled bracketed forms.
      if (offset > 0 && afterBracketed[offset - 1] === '<') return match;
      return rewriteByName(match, name);
    });
  });
}

/** Strips `-`, `_`, `.` for fuzzy matching, used only after a literal lookup misses. Mirrors slack-mentions.ts. */
function normalizeHandle(handle: string): string {
  return handle.replace(/[-_.]/g, '');
}

/**
 * Inbound counterpart: rewrites `<@SNOWFLAKE>`/`<@!SNOWFLAKE>` to `@bot_username` for registered NanoClaw bots only,
 * so an agent learns its peer's name; unknown ids pass through. Role and channel mentions are untouched. Code regions
 * are skipped so pasted raw text stays verbatim.
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
  // `<@!123>` is the legacy nickname-mention form.
  return transformOutsideProtectedRegions(text, (segment) =>
    segment.replace(/<@!?(\d+)>/g, (match, id: string) => {
      const username = byId.get(id);
      return username ? `@${username}` : match;
    }),
  );
}

export interface DiscordRestClient {
  post(route: `/${string}`, options?: { body?: unknown }): Promise<unknown>;
}

/**
 * Strips `discord:` and the guild segment, leaving the raw channel id the REST API expects. Callers outside the
 * bridge (orchestrator-dispatch) must normalize here or the call hits `/channels/discord:...` and 404s.
 */
export function extractDiscordChannelId(platformId: string): string {
  if (!platformId.startsWith('discord:')) return platformId;
  const parts = platformId.split(':');
  // `discord:{guildId}:{channelId}[:{threadId}]`: the channel id is index 2.
  return parts[2] ?? platformId;
}

const SNOWFLAKE = /^\d+$/;

/**
 * A Discord thread is itself a channel, so `https://discord.com/channels/{guildId}/{threadId}` opens it. Anything
 * that is not a four-part snowflake thread id returns null rather than a guessed link.
 */
export function discordPermalink(threadId: string | null): string | null {
  const parts = threadId?.split(':') ?? [];
  if (parts.length !== 4 || parts[0] !== 'discord') return null;
  const [, guildId, , thread] = parts;
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(thread)) return null;
  return `https://discord.com/channels/${guildId}/${thread}`;
}

export function discordChannelPermalink(platformId: string): string | null {
  const [scheme, guildId, channelId] = platformId.split(':');
  if (scheme !== 'discord' || !SNOWFLAKE.test(guildId ?? '') || !SNOWFLAKE.test(channelId ?? '')) return null;
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

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

const DISCORD_THREAD_NAME_MAX = 100;

/** The post's first non-empty line, Markdown punctuation stripped, capped at Discord's limit. */
export function discordThreadNameFrom(content: string | undefined): string {
  const line =
    (content ?? '')
      .split('\n')
      .map((l) =>
        l
          .replace(/[*_~`#>|]/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .find((l) => l.length > 0) ?? '';
  const points = Array.from(line);
  if (points.length === 0) return 'Continued';
  if (points.length <= DISCORD_THREAD_NAME_MAX) return line;
  return (
    points
      .slice(0, DISCORD_THREAD_NAME_MAX - 1)
      .join('')
      .trimEnd() + '…'
  );
}

export interface DiscordThreadRestClient {
  get(route: `/${string}`): Promise<unknown>;
  post(route: `/${string}`, options?: { body?: unknown }): Promise<unknown>;
  put(route: `/${string}`): Promise<unknown>;
}

/**
 * One owner user row exists per Discord bot (`discord:`, `discord-codex:`, ...) for the same human, so dedupe on the
 * snowflake.
 */
async function discordOwnerUserIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const owner of await getOwners()) {
    const [channelType, userId] = owner.user_id.split(':');
    if (channelType?.startsWith('discord') && userId && /^\d+$/.test(userId)) ids.add(userId);
  }
  return [...ids];
}

/**
 * Adds the install's owners to a thread a bot opened: Discord's sidebar only lists threads you are a member of, so a
 * bot-opened thread stays hidden until the owner replies. Best-effort.
 */
export async function addDiscordThreadMembers(
  rest: Pick<DiscordThreadRestClient, 'put'>,
  threadId: string,
  userIds: () => Promise<string[]> = discordOwnerUserIds,
): Promise<void> {
  let ids: string[];
  try {
    ids = await userIds();
  } catch (err) {
    log.warn('Discord thread member lookup failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // Per user, so one owner outside this guild (10007) does not skip the rest.
  for (const userId of ids) {
    try {
      await rest.put(Routes.threadMembers(threadId, userId));
    } catch (err) {
      log.warn('Discord thread member add failed', {
        threadId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Opens the thread the live Gateway path would have opened for a channel-root @mention that only recovery saw;
 * otherwise the recovered mention routes to the thread-less session and the reply lands at channel root. 160004 means
 * the thread already exists; any other failure returns null, matching the adapter's root-reply fallback.
 */
export async function openRecoveredMentionThread(
  rest: Pick<DiscordThreadRestClient, 'post'>,
  platformId: string,
  message: { id: string; text?: string },
): Promise<string | null> {
  const [scheme, guildId, channelId, threadId] = platformId.split(':');
  if (scheme !== 'discord' || !guildId || guildId === '@me' || !channelId || threadId) return null;
  try {
    await rest.post(Routes.threads(channelId, message.id), {
      // Provisional: maybeRenameNewThread retitles it.
      body: { name: discordThreadNameFrom(message.text?.replace(/<@!?\d+>/g, '')), auto_archive_duration: 1440 },
    });
    log.info('Discord thread opened for recovered mention', { channelId, messageId: message.id });
    // eslint-disable-next-line no-catch-all/no-catch-all -- every failure degrades to a root reply, as the adapter's does
  } catch (err) {
    if ((err as { code?: unknown }).code !== RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) {
      log.warn('Discord thread create for recovered mention failed — answering at channel root', {
        channelId,
        messageId: message.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return `${platformId}:${message.id}`;
}

function isDiscordUnknownChannelError(err: unknown): boolean {
  // @chat-adapter/discord serialises HTTP failures into the message text, not a code field; pinned by the "real
  // @chat-adapter/discord" test in discord.test.ts.
  const message = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(message) && new RegExp(`"code":\\s*${RESTJSONErrorCodes.UnknownChannel}\\b`).test(message);
}

/**
 * Makes `discord:<guild>:<channel>:<messageId>` postable when no thread exists on that message yet. NanoClaw anchors
 * multi-message output as `<platformId>:<parentMessageId>` (natural on Slack), but a Discord thread must be created
 * from the message first; until then the post 404s (10003). On exactly that 404, open a thread on the message and
 * retry once (160004 means a concurrent creator won; retry anyway). Any other failure rethrows the ORIGINAL error so
 * callers keep their root-post fallbacks.
 */
export function installMessageThreadAutoCreate(
  adapter: ReturnType<typeof createDiscordAdapter>,
  rest: DiscordThreadRestClient,
  addThreadMembers: (rest: DiscordThreadRestClient, threadId: string) => Promise<void> = addDiscordThreadMembers,
): void {
  const target = adapter as unknown as {
    postMessage: (threadId: string, message: unknown) => Promise<unknown>;
  };
  const original = target.postMessage.bind(adapter);
  target.postMessage = async (threadId, message) => {
    try {
      return await original(threadId, message);
    } catch (err) {
      const [scheme, guildId, channelId, messageId] = threadId.split(':');
      if (scheme !== 'discord' || guildId === '@me' || !channelId || !messageId) throw err;
      if (!isDiscordUnknownChannelError(err)) throw err;
      try {
        let name = 'Continued';
        try {
          const parent = (await rest.get(Routes.channelMessage(channelId, messageId))) as { content?: string };
          name = discordThreadNameFrom(parent.content);
        } catch {
          // Unreadable parent: the thread-create call below decides whether the id is usable.
        }
        await rest.post(Routes.threads(channelId, messageId), { body: { name } });
        log.info('Discord thread opened under anchor message', { channelId, messageId });
        // Best-effort; the retried post does not wait on it.
        void addThreadMembers(rest, messageId);
      } catch (createErr) {
        if ((createErr as { code?: unknown }).code !== RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) {
          log.warn('Discord thread auto-create failed', {
            channelId,
            messageId,
            err: createErr instanceof Error ? createErr.message : String(createErr),
          });
          throw err;
        }
      }
      return original(threadId, message);
    }
  };
}

export interface DiscordWorkspace {
  channelType: string;
  botToken: string;
  publicKey?: string;
  applicationId?: string;
}

/**
 * Only DISCORD_BOT_TOKEN is required; publicKey and applicationId are only needed for slash-command interactions.
 * Mirrors parseSlackWorkspaces.
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

// The pre-filter must allow `_` in the suffix so every suffixed var reaches the parser.
const workspaces = parseDiscordWorkspaces(
  readEnvFileMatching(/^DISCORD_(BOT_TOKEN|PUBLIC_KEY|APPLICATION_ID)(_[A-Za-z0-9_]+)?$/),
);

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    factory: async () => {
      // Registers this bot's identity so siblings can resolve `@username` → `<@id>`.
      const identity = await fetchDiscordBotIdentity(ws.botToken);
      if (identity) {
        knownDiscordBots.set(ws.channelType, identity);
        warmChannelDirectory();
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
      installForwardUnwrap(discordAdapter);
      // Multi-bot dedup isolation: the dedup key is `dedupe:${adapter.name}:${message.id}` and every Discord adapter
      // defaults to name "discord", so two bots seeing the same message would collide in the shared state and the
      // second would silently drop it. Name it after the channelType (as slack.ts does).
      (discordAdapter as unknown as { name: string }).name = ws.channelType;
      const rest = new REST({ version: '10' }).setToken(ws.botToken);
      installMessageThreadAutoCreate(discordAdapter, rest);
      const bridge = createChatSdkBridge({
        adapter: discordAdapter,
        concurrency: 'concurrent',
        botToken: ws.botToken,
        extractReplyContext,
        supportsThreads: true,
        maxTextLength: 1900,
        // Continuation chunks of an oversize channel post reply in a thread on the first chunk instead of landing as
        // more channel parents.
        threadContinuationChunks: true,
        channelType: ws.channelType,
        // Markdown (not raw) keeps tableToAscii in play. Mentions are resolved before the link rewriter, which never
        // touches mention syntax.
        transformOutboundMarkdown: (text, destination) =>
          linkDiscordChannelNames(rewriteDiscordLinks(resolveDiscordMentions(text)), destination?.platformId),
        // Discord subtext is plain `-# ` at the start of a line, so the footer rides in the body. The explicit
        // newline is required, and the outbound transform above must not run over the footer.
        renderSubtext: (body, subtext) =>
          'markdown' in body ? { ...body, markdown: `${body.markdown}\n-# ${subtext}` } : body,
        // Rewrites raw `<@snowflake>` to `@bot_username` for sibling bots.
        transformInboundText: (text) => resolveIncomingDiscordMentions(text),
        inboundFilter: isUserMessage,
        detectRecoveredMention: (message) => {
          if (!identity) return false;
          const raw = message.raw as { mentions?: Array<{ id?: string }> } | undefined;
          return raw?.mentions?.some((mention) => mention.id === identity.userId) === true;
        },
        threadRecoveredRootMention: (platformId, message) => openRecoveredMentionThread(rest, platformId, message),
        // Matches the live Gateway patch: self echoes are removed by the bridge; among other bots only known NanoClaw
        // siblings are admitted.
        allowRecoveredBotMessage: (message) => {
          const authorId = message.author.userId;
          return authorId !== identity?.userId && [...knownDiscordBots.values()].some((bot) => bot.userId === authorId);
        },
        discoverRecoveryTargets: (request) => discoverDiscordRecoveryTargets(rest, request),
        classifyRecoveryError: classifyDiscordRecoveryError,
        fetchThreadAnchor: makeFetchThreadAnchor(ws.botToken),
      });
      bridge.permalink = (_platformId, threadId) => discordPermalink(threadId);
      bridge.channelPermalink = (platformId) => discordChannelPermalink(platformId);
      bridge.postParent = (platformId, text) => discordPostParent(rest, platformId, text);
      bridge.createThread = async (platformId, parentMessageId, title, firstMessage) => {
        const created = await discordCreateThread(rest, platformId, parentMessageId, title, firstMessage);
        void addDiscordThreadMembers(rest, created.threadId);
        return created;
      };
      return bridge;
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Discord bots registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
