import { describe, expect, it, vi } from 'vitest';

import {
  isUserMessage,
  parseDiscordWorkspaces,
  resolveDiscordMentions,
  rewriteDiscordLinks,
  discordPostParent,
  discordCreateThread,
  extractDiscordChannelId,
  type DiscordBotIdentity,
  type DiscordRestClient,
} from './discord.js';

describe('resolveDiscordMentions', () => {
  const bots = new Map<string, DiscordBotIdentity>([
    ['discord', { userId: '1111111111', username: 'Axie' }],
    ['discord-axie-codex', { userId: '2222222222', username: 'Axie-Codex' }],
  ]);

  it('returns text unchanged when no bots are registered', () => {
    expect(resolveDiscordMentions('@Axie hello', new Map())).toBe('@Axie hello');
  });

  it('rewrites a known username to a real mention', () => {
    expect(resolveDiscordMentions('@Axie hello', bots)).toBe('<@1111111111> hello');
  });

  it('rewrites case-insensitively', () => {
    expect(resolveDiscordMentions('@AXIE hello', bots)).toBe('<@1111111111> hello');
    expect(resolveDiscordMentions('@axie hello', bots)).toBe('<@1111111111> hello');
  });

  it('handles usernames with dashes', () => {
    // The bug we are fixing — Axie-Codex would not resolve in the screenshot.
    expect(resolveDiscordMentions('@Axie-Codex take the next verse', bots)).toBe('<@2222222222> take the next verse');
  });

  it('leaves unknown usernames as plain text', () => {
    // Fail-soft: never invent a snowflake for a name we cannot verify.
    expect(resolveDiscordMentions('@RandomUser hello', bots)).toBe('@RandomUser hello');
  });

  it('does not double-wrap an existing `<@id>` mention', () => {
    expect(resolveDiscordMentions('<@1111111111> hi', bots)).toBe('<@1111111111> hi');
  });

  it('does not touch role mentions `<@&…>`', () => {
    expect(resolveDiscordMentions('<@&999999999> hi', bots)).toBe('<@&999999999> hi');
  });

  it('preserves code regions verbatim', () => {
    // Mentions inside fenced or inline code must not be rewritten — a
    // documentation example like "use `@Axie hello`" would otherwise rewrite
    // mid-code.
    expect(resolveDiscordMentions('Inline: `@Axie hello`', bots)).toBe('Inline: `@Axie hello`');
    expect(resolveDiscordMentions('```\n@Axie hello\n```', bots)).toBe('```\n@Axie hello\n```');
  });

  it('rewrites multiple distinct mentions in one message', () => {
    expect(resolveDiscordMentions('@Axie and @Axie-Codex collab', bots)).toBe('<@1111111111> and <@2222222222> collab');
  });

  it('handles `@username` at end-of-string with no trailing whitespace', () => {
    expect(resolveDiscordMentions('over to @Axie-Codex', bots)).toBe('over to <@2222222222>');
  });

  it('does not match `@` preceded by a word character (email-like text)', () => {
    // Codex review finding B: `user@domain.com` previously matched as
    // `@domain.com`. Fail-soft today (no bot named "domain.com"), but the
    // word-boundary guard makes intent explicit. Confirms the lookbehind
    // anchors the `@` so the right-hand side of an email or path is never
    // treated as a mention target.
    const bots2 = new Map<string, DiscordBotIdentity>([['discord', { userId: '9', username: 'domain.com' }]]);
    expect(resolveDiscordMentions('contact user@domain.com today', bots2)).toBe('contact user@domain.com today');
    expect(resolveDiscordMentions('@domain.com hi', bots2)).toBe('<@9> hi');
  });
});

describe('parseDiscordWorkspaces', () => {
  it('returns an empty list when no credentials present', () => {
    expect(parseDiscordWorkspaces({})).toEqual([]);
  });

  it('registers the primary workspace as channelType "discord"', () => {
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN: 'tok-primary',
      DISCORD_PUBLIC_KEY: 'pk-primary',
      DISCORD_APPLICATION_ID: 'app-primary',
    });
    expect(ws).toEqual([
      {
        channelType: 'discord',
        botToken: 'tok-primary',
        publicKey: 'pk-primary',
        applicationId: 'app-primary',
      },
    ]);
  });

  it('accepts token-only entries (public key and app id are optional)', () => {
    // Slash-command interactions need public key + application id, but the
    // chat adapter itself works with just the bot token. Token-only entries
    // must still register so a chat-only secondary bot is usable.
    const ws = parseDiscordWorkspaces({ DISCORD_BOT_TOKEN: 'tok-only' });
    expect(ws).toEqual([
      { channelType: 'discord', botToken: 'tok-only', publicKey: undefined, applicationId: undefined },
    ]);
  });

  it('registers suffixed workspaces as channelType "discord-<suffix>" (lowercased)', () => {
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN_AXIE: 'tok-axie',
      DISCORD_BOT_TOKEN_CODEX: 'tok-codex',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['discord-axie', 'discord-codex']);
  });

  it('registers primary and suffixed workspaces together', () => {
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN: 'tok-p',
      DISCORD_BOT_TOKEN_SECOND: 'tok-s',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['discord', 'discord-second']);
  });

  it('skips workspaces missing a bot token', () => {
    // An orphan public-key / application-id without a bot token can't be
    // used — drop it rather than registering a broken adapter.
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN: 'tok-p',
      DISCORD_PUBLIC_KEY_ORPHAN: 'pk-orphan',
      DISCORD_APPLICATION_ID_ORPHAN: 'app-orphan',
    });
    expect(ws.map((w) => w.channelType)).toEqual(['discord']);
  });

  it('accepts underscores in the suffix and maps them to dashes in channelType', () => {
    // Same convention as slack.ts: env var keeps `_` for readability, but
    // channelType uses `-` to match the existing dash-separated convention.
    // channel-auto-wire's `-` → `_` reverse mapping makes this round-trip safe.
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN_AXIE_CODEX: 'tok-codex',
      DISCORD_PUBLIC_KEY_AXIE_CODEX: 'pk-codex',
      DISCORD_APPLICATION_ID_AXIE_CODEX: 'app-codex',
    });
    expect(ws).toEqual([
      {
        channelType: 'discord-axie-codex',
        botToken: 'tok-codex',
        publicKey: 'pk-codex',
        applicationId: 'app-codex',
      },
    ]);
  });

  it('groups bot token + public key + application id by suffix', () => {
    const ws = parseDiscordWorkspaces({
      DISCORD_BOT_TOKEN_A: 'tok-a',
      DISCORD_PUBLIC_KEY_A: 'pk-a',
      DISCORD_APPLICATION_ID_A: 'app-a',
      DISCORD_BOT_TOKEN_B: 'tok-b',
    });
    const byType = new Map(ws.map((w) => [w.channelType, w]));
    expect(byType.get('discord-a')).toEqual({
      channelType: 'discord-a',
      botToken: 'tok-a',
      publicKey: 'pk-a',
      applicationId: 'app-a',
    });
    expect(byType.get('discord-b')).toEqual({
      channelType: 'discord-b',
      botToken: 'tok-b',
      publicKey: undefined,
      applicationId: undefined,
    });
  });
});

describe('rewriteDiscordLinks', () => {
  it('rewrites bare Google document and slide URLs to safe labeled links', () => {
    const docUrl = 'https://docs.google.com/document/d/doc-id/edit';
    const slidesUrl = 'https://docs.google.com/presentation/d/slides-id/edit';

    expect(rewriteDiscordLinks(`Doc:\n${docUrl}\n\nSlides:\n${slidesUrl}`)).toBe(
      `Doc:\n[Open Google Doc](${docUrl})\n\nSlides:\n[Open Google Slides](${slidesUrl})`,
    );
  });

  it('rewrites masked links whose visible text is also a URL', () => {
    const url = 'https://docs.google.com/document/d/doc-id/edit';

    expect(rewriteDiscordLinks(`[${url}](${url})`)).toBe(`[Open Google Doc](${url})`);
  });

  it('preserves descriptive masked links', () => {
    const input =
      '[Chase Sapphire Reserve official page](https://creditcards.chase.com/rewards-credit-cards/sapphire/reserve)';

    expect(rewriteDiscordLinks(input)).toBe(input);
  });

  it('does not rewrite URLs inside code', () => {
    const url = 'https://example.com/path';
    const input = `Run \`curl ${url}\`\n\n\`\`\`\n${url}\n\`\`\``;

    expect(rewriteDiscordLinks(input)).toBe(input);
  });
});

describe('isUserMessage (Discord inbound filter)', () => {
  it('keeps default text messages (type 0)', () => {
    expect(isUserMessage({ raw: { type: 0 } })).toBe(true);
  });

  it('keeps Reply messages (type 19)', () => {
    expect(isUserMessage({ raw: { type: 19 } })).toBe(true);
  });

  it('keeps slash-command and context-menu invocations (types 20, 23)', () => {
    expect(isUserMessage({ raw: { type: 20 } })).toBe(true);
    expect(isUserMessage({ raw: { type: 23 } })).toBe(true);
  });

  it('drops THREAD_CREATED (type 18)', () => {
    expect(isUserMessage({ raw: { type: 18 } })).toBe(false);
  });

  // THREAD_STARTER_MESSAGE is a synthetic echo of the parent; routing it would duplicate content.
  it('drops THREAD_STARTER_MESSAGE (type 21)', () => {
    expect(isUserMessage({ raw: { type: 21 } })).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 22, 24])('drops system message type %i', (type) => {
    expect(isUserMessage({ raw: { type } })).toBe(false);
  });

  it('keeps messages with no raw payload', () => {
    expect(isUserMessage({})).toBe(true);
    expect(isUserMessage({ raw: {} })).toBe(true);
  });
});

describe('extractDiscordChannelId', () => {
  it('test_extract_channel_id_from_canonical_platform_id', () => {
    expect(extractDiscordChannelId('discord:1148697867268497441:1149005423567294624')).toBe('1149005423567294624');
  });

  it('test_extract_channel_id_when_thread_segment_present', () => {
    // discord:guildId:channelId:threadId — channelId is still index 2
    expect(extractDiscordChannelId('discord:guildA:channelB:threadC')).toBe('channelB');
  });

  it('test_returns_raw_id_when_no_prefix', () => {
    expect(extractDiscordChannelId('channel-id-X')).toBe('channel-id-X');
  });
});

describe('discordPostParent', () => {
  it('test_post_parent_returns_message_id: returns {messageId} from REST response', async () => {
    const mockRest: DiscordRestClient = {
      post: vi.fn().mockResolvedValue({ id: 'msg-abc' }),
    };
    const result = await discordPostParent(mockRest, 'channel-id-X', 'launched');
    expect(result).toEqual({ messageId: 'msg-abc' });
  });

  it('test_post_parent_strips_discord_prefix_before_routes_call', async () => {
    // Regression: orchestrator-dispatch's threaded path passes raw
    // messaging_groups.platform_id (`discord:guildId:channelId`); Discord's
    // REST API needs the bare channel id or it 404s.
    const post = vi.fn().mockResolvedValue({ id: 'msg-1' });
    const mockRest: DiscordRestClient = { post };
    await discordPostParent(mockRest, 'discord:guildA:1149005423567294624', 'spawned');
    const route = post.mock.calls[0][0] as string;
    expect(route).toContain('/channels/1149005423567294624/messages');
    expect(route).not.toContain('discord:');
  });
});

describe('discordCreateThread', () => {
  it('test_create_thread_returns_thread_id: returns {threadId, messageId} from REST responses', async () => {
    const mockRest: DiscordRestClient = {
      post: vi.fn().mockResolvedValueOnce({ id: 'thread-y' }).mockResolvedValueOnce({ id: 'first-msg-z' }),
    };
    const result = await discordCreateThread(mockRest, 'channel-X', 'parent-msg-A', 'Task Y', 'first message');
    expect(result).toEqual({ threadId: 'thread-y', messageId: 'first-msg-z' });
  });

  it('test_thread_name_used: creates thread with correct name and startMessage', async () => {
    const postSpy = vi.fn().mockResolvedValueOnce({ id: 'thread-z' }).mockResolvedValueOnce({ id: 'first-msg-id' });
    const mockRest: DiscordRestClient = { post: postSpy };
    await discordCreateThread(mockRest, 'channel', 'parent', 'My Task Name', 'first');
    // First call: thread creation with name and startMessage (via Routes.threads)
    expect(postSpy.mock.calls[0][1]).toEqual({ body: { name: 'My Task Name' } });
    expect(postSpy.mock.calls[0][0]).toContain('/channels/channel/messages/parent/threads');
  });

  it('test_create_thread_strips_discord_prefix_before_routes_call', async () => {
    const postSpy = vi.fn().mockResolvedValueOnce({ id: 'thread-id' }).mockResolvedValueOnce({ id: 'first-msg' });
    const mockRest: DiscordRestClient = { post: postSpy };
    await discordCreateThread(mockRest, 'discord:guildA:1149005423567294624', 'parent-msg', 'T', 'first');
    const route = postSpy.mock.calls[0][0] as string;
    expect(route).toContain('/channels/1149005423567294624/messages/parent-msg/threads');
    expect(route).not.toContain('discord:');
  });
});
