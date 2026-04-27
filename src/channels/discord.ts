/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
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

/**
 * Strip masked-link syntax `[text](url)` to a bare URL when the link text
 * itself contains a URL. Discord's anti-phishing filter blocks masked links
 * with URL-shaped text, leaving the user to see literal `[url](url)`. Bare
 * URLs auto-link cleanly. Masked links whose text is not a URL (e.g.
 * `[Districts Day 1](...)`) render correctly and are left alone.
 *
 * Code regions are protected so URLs inside fenced/inline code stay literal.
 */
function rewriteDiscordLinks(text: string): string {
  if (!text) return text;
  return splitProtectedAndTransform(text, (segment) =>
    segment.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText: string, url: string) => {
      return /https?:\/\//.test(linkText) ? url : match;
    }),
  );
}

function splitProtectedAndTransform(text: string, transform: (s: string) => string): string {
  const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;
  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(transform(text.slice(lastIndex, match.index)));
    out.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) out.push(transform(text.slice(lastIndex)));
  return out.join('');
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
      transformOutboundText: rewriteDiscordLinks,
      inboundFilter: isUserMessage,
    });
  },
});
