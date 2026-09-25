/**
 * Outbound `#channel-name` → link, for channels this install is wired into.
 *
 * Agents refer to channels as `#name` (inbound channel mentions reach them in
 * that form). Left as text, the reader has to go find the channel; this turns
 * a name the install knows into a real link: a Slack channel permalink in
 * markdown-link form, or Discord's native `<#id>` mention. Only exact, unique
 * names become links — an unknown or ambiguous name stays plain text.
 *
 * The directory is the central DB's messaging_groups, read asynchronously and
 * cached; the outbound transforms are synchronous, so a stale cache triggers a
 * background refresh and this call uses what is loaded.
 */
import { getAllMessagingGroups } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';
import { getKnownSlackBots, slackChannelPermalink } from './slack-mentions.js';

export interface KnownChannel {
  channelType: string;
  platformId: string;
  name: string;
}

const DIRECTORY_TTL_MS = 60_000;
let directory: KnownChannel[] = [];
let loadedAt = 0;
let loading: Promise<void> | null = null;

function refreshChannelDirectory(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const groups = await getAllMessagingGroups();
      directory = groups
        .filter((g) => typeof g.name === 'string' && g.name.trim() !== '')
        .map((g) => ({
          channelType: g.channel_type,
          platformId: g.platform_id,
          name: normalizeName(g.name as string),
        }));
      loadedAt = Date.now();
    } catch (err) {
      log.warn('Channel directory refresh failed', { err: String(err) });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Load the directory as an adapter comes up, so the first outbound message
 * after a restart is linked too — the transforms are synchronous and only
 * trigger a refresh, they never wait for one.
 */
export function warmChannelDirectory(): void {
  void refreshChannelDirectory();
}

function knownChannels(): KnownChannel[] {
  if (Date.now() - loadedAt > DIRECTORY_TTL_MS) void refreshChannelDirectory();
  return directory;
}

function normalizeName(name: string): string {
  return name.trim().replace(/^#/, '').toLowerCase();
}

/**
 * Markdown links, angle-bracket entities and bare URLs are consumed whole and
 * returned untouched, so a `#` inside them is never rewritten. A channel
 * reference is `#` + a name that starts with a letter or digit and is not
 * glued to a preceding word (`APP#2135`), path or URL fragment.
 */
const TOKEN_RE =
  /\[[^\]\n]*\]\([^)\s]*\)|<[^>\n]*>|https?:\/\/[^\s)>\]]+|(?<![\w/:=?&#-])#([a-z0-9][a-z0-9_-]*)(?![\w-])/giu;

export function linkChannelNames(text: string, resolve: (name: string) => string | null): string {
  return transformOutsideProtectedRegions(text, (segment) =>
    segment.replace(TOKEN_RE, (match: string, name: string | undefined) => {
      if (name === undefined || /^\d+$/.test(name)) return match;
      return resolve(name.toLowerCase()) ?? match;
    }),
  );
}

/** One platform id for the name, or null when unknown or ambiguous. */
function uniquePlatformId(candidates: KnownChannel[], name: string): string | null {
  const ids = new Set(candidates.filter((c) => c.name === name).map((c) => c.platformId));
  return ids.size === 1 ? [...ids][0] : null;
}

/** Slack: channels in the current bot's workspace, as `[#name](permalink)`. */
export function linkSlackChannelNames(
  text: string,
  currentChannelType: string,
  channels: KnownChannel[] = knownChannels(),
): string {
  if (!text.includes('#')) return text;
  const bots = getKnownSlackBots();
  const teamId = bots.get(currentChannelType)?.teamId;
  if (!teamId) return text;
  // Public/private channels only (C…/G…) — DMs have no channel page to link.
  const inWorkspace = channels.filter(
    (c) => bots.get(c.channelType)?.teamId === teamId && /^slack:[CG][A-Z0-9]+$/.test(c.platformId),
  );
  return linkChannelNames(text, (name) => {
    const platformId = uniquePlatformId(inWorkspace, name);
    const url = platformId ? slackChannelPermalink(currentChannelType, platformId) : null;
    return url ? `[#${name}](${url})` : null;
  });
}

/**
 * Discord: channels in the destination's guild, as the native `<#id>`
 * mention. A mention only resolves inside its own guild, so without a guild
 * destination (a DM, or no destination given) nothing is linked.
 */
export function linkDiscordChannelNames(
  text: string,
  destinationPlatformId: string | undefined,
  channels: KnownChannel[] = knownChannels(),
): string {
  if (!text.includes('#')) return text;
  const guild = /^discord:(\d+):\d+$/.exec(destinationPlatformId ?? '')?.[1];
  if (!guild) return text;
  const guildChannels = channels.filter(
    (c) => c.channelType.startsWith('discord') && c.platformId.startsWith(`discord:${guild}:`),
  );
  return linkChannelNames(text, (name) => {
    const platformId = uniquePlatformId(guildChannels, name);
    return platformId ? `<#${platformId.split(':').pop()}>` : null;
  });
}
