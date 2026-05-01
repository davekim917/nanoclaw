/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
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
 * Drop Discord system messages (thread renames, member joins, pins, etc.).
 * Discord MESSAGE_CREATE payloads carry a `type` field — 0 is a normal user
 * message; anything else is system-generated. The Chat SDK adapter doesn't
 * filter these, so without this they reach the agent as ordinary chat input
 * and trigger replies. v1 filtered via discord.js `message.system`; restoring
 * the equivalent here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUserMessage(message: { raw?: any }): boolean {
  const type = message.raw?.type;
  return type === undefined || type === 0;
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

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: 1900,
      // Markdown delivery (not raw) keeps the chat-adapter's tableToAscii
      // conversion in play; without it, Markdown tables would render as raw
      // `|`-pipe text in Discord (no native table block).
      transformOutboundMarkdown: rewriteDiscordLinks,
      inboundFilter: isUserMessage,
    });
  },
});
