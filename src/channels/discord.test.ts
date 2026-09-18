import { describe, expect, it, vi } from 'vitest';

import { createDiscordAdapter, DiscordFormatConverter } from '@chat-adapter/discord';

import {
  installForwardUnwrap,
  isUserMessage,
  parseDiscordWorkspaces,
  resolveDiscordMentions,
  resolveIncomingDiscordMentions,
  rewriteDiscordLinks,
  discordPostParent,
  addDiscordThreadMembers,
  discordCreateThread,
  discordThreadNameFrom,
  installMessageThreadAutoCreate,
  type DiscordThreadRestClient,
  discoverDiscordRecoveryTargets,
  extractDiscordChannelId,
  discordChannelPermalink,
  discordPermalink,
  unwrapForwardedSnapshot,
  type DiscordBotIdentity,
  type DiscordRestClient,
} from './discord.js';

/** Build a Discord snowflake whose embedded timestamp is `iso`. */
const snowflakeFor = (iso: string): string => String((BigInt(Date.parse(iso)) - 1420070400000n) << 22n);

describe('Discord recovery target discovery', () => {
  it('adds a newly-created active thread even when no session exists yet', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ threads: [{ id: 'thread-new', parent_id: 'channel-1' }] })
      .mockResolvedValueOnce({ threads: [], has_more: false })
      .mockResolvedValueOnce({ threads: [], has_more: false });

    const result = await discoverDiscordRecoveryTargets({ get } as never, {
      since: '2026-07-21T18:16:00Z',
      reason: 'transport-ready',
      targets: [{ platformId: 'discord:guild-1:channel-1', threadId: null, isDM: false }],
    });

    expect(result).toEqual({
      targets: [
        {
          platformId: 'discord:guild-1:channel-1',
          threadId: 'discord:guild-1:channel-1:thread-new',
          isDM: false,
        },
      ],
      complete: true,
      failed: [],
    });
  });

  it('paginates joined private archives with thread snowflakes and exhausts the id-ordered endpoint', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ threads: [] })
      .mockResolvedValueOnce({ threads: [] })
      .mockResolvedValueOnce({
        threads: [
          {
            id: '900',
            parent_id: 'channel-1',
            // Written inside the gap, so the activity filter keeps it; this
            // case is about pagination order, not about the filter.
            last_message_id: snowflakeFor('2026-07-22T00:00:00Z'),
            thread_metadata: { archive_timestamp: '2020-01-01T00:00:00Z' },
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        threads: [{ id: '800', parent_id: 'channel-1', last_message_id: snowflakeFor('2026-07-22T00:00:00Z') }],
        has_more: false,
      });

    const result = await discoverDiscordRecoveryTargets({ get } as never, {
      since: '2026-07-21T18:16:00Z',
      reason: 'host-startup',
      targets: [{ platformId: 'discord:guild-1:channel-1', threadId: null, isDM: false }],
    });

    expect(get).toHaveBeenNthCalledWith(
      4,
      expect.any(String),
      expect.objectContaining({ query: new URLSearchParams({ limit: '100', before: '900' }) }),
    );
    expect(result.complete).toBe(true);
    expect(result.targets.map((target) => target.threadId)).toEqual([
      'discord:guild-1:channel-1:900',
      'discord:guild-1:channel-1:800',
    ]);
  });

  // The recovery storm: every pass re-scanned every thread ever created (406
  // observed live), so stall-triggered passes took 4-8 min and ran back-to-back.
  describe('last-activity bound', () => {
    const since = '2026-07-21T18:16:00Z';

    const discover = (threads: unknown[]) =>
      discoverDiscordRecoveryTargets(
        {
          get: vi
            .fn()
            .mockResolvedValueOnce({ threads })
            .mockResolvedValueOnce({ threads: [], has_more: false })
            .mockResolvedValueOnce({ threads: [], has_more: false }),
        } as never,
        {
          since,
          reason: 'event-loop-stall',
          targets: [{ platformId: 'discord:g:channel-1', threadId: null, isDM: false }],
        },
      );

    it('drops an active thread whose last message predates the gap', async () => {
      const result = await discover([
        { id: 'quiet', parent_id: 'channel-1', last_message_id: snowflakeFor('2026-06-01T00:00:00Z') },
      ]);
      expect(result.targets).toEqual([]);
    });

    it('keeps an active thread written inside the gap', async () => {
      const result = await discover([
        { id: 'busy', parent_id: 'channel-1', last_message_id: snowflakeFor('2026-07-22T00:00:00Z') },
      ]);
      expect(result.targets.map((t) => t.threadId)).toEqual(['discord:g:channel-1:busy']);
    });

    // Fail-open: a payload without the marker must never silently lose coverage.
    it('keeps a thread whose last_message_id is missing or unparseable', async () => {
      const result = await discover([
        { id: 'no-marker', parent_id: 'channel-1' },
        { id: 'junk', parent_id: 'channel-1', last_message_id: 'not-a-snowflake' },
      ]);
      expect(result.targets.map((t) => t.threadId)).toEqual([
        'discord:g:channel-1:no-marker',
        'discord:g:channel-1:junk',
      ]);
    });

    // An old private thread reactivated during the gap gets a fresh
    // last_message_id, so the bound still catches it despite an old id.
    it('keeps a long-dormant thread that was reactivated inside the gap', async () => {
      const result = await discover([
        {
          id: snowflakeFor('2026-01-01T00:00:00Z'),
          parent_id: 'channel-1',
          last_message_id: snowflakeFor('2026-07-22T00:00:00Z'),
        },
      ]);
      expect(result.targets).toHaveLength(1);
    });

    it('keeps everything when since is unparseable', async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({
          threads: [{ id: 'old', parent_id: 'channel-1', last_message_id: snowflakeFor('2020-01-01T00:00:00Z') }],
        })
        .mockResolvedValueOnce({ threads: [], has_more: false })
        .mockResolvedValueOnce({ threads: [], has_more: false });
      const result = await discoverDiscordRecoveryTargets({ get } as never, {
        since: 'not-a-date',
        reason: 'host-startup',
        targets: [{ platformId: 'discord:g:channel-1', threadId: null, isDM: false }],
      });
      expect(result.targets).toHaveLength(1);
    });
  });
});

describe('resolveDiscordMentions', () => {
  const bots = new Map<string, DiscordBotIdentity>([
    ['discord', { userId: '1111111111', username: 'Atlas' }],
    ['discord-atlas-codex', { userId: '2222222222', username: 'Atlas-Codex' }],
  ]);

  it('returns text unchanged when no bots are registered', () => {
    expect(resolveDiscordMentions('@Atlas hello', new Map())).toBe('@Atlas hello');
  });

  it('rewrites a known username to a real mention', () => {
    expect(resolveDiscordMentions('@Atlas hello', bots)).toBe('<@1111111111> hello');
  });

  it('rewrites case-insensitively', () => {
    expect(resolveDiscordMentions('@ATLAS hello', bots)).toBe('<@1111111111> hello');
    expect(resolveDiscordMentions('@atlas hello', bots)).toBe('<@1111111111> hello');
  });

  it('handles usernames with dashes', () => {
    // The bug we are fixing — Atlas-Codex would not resolve in the screenshot.
    expect(resolveDiscordMentions('@Atlas-Codex take the next verse', bots)).toBe('<@2222222222> take the next verse');
  });

  it('leaves unknown usernames as plain text', () => {
    // Fail-soft: never invent a snowflake for a name we cannot verify.
    expect(resolveDiscordMentions('@RandomUser hello', bots)).toBe('@RandomUser hello');
  });

  // Operator-typed Discord handles often drop hyphens/underscores even
  // though the agent's logical name keeps them. Mirrors slack-mentions.ts's
  // normalized-fallback behavior so cross-platform users get consistent
  // peer-handoff behavior.
  describe('separator-normalized fallback', () => {
    const mismatchBots = new Map<string, DiscordBotIdentity>([
      ['discord', { userId: '1111', username: 'atlas' }],
      ['discord-atlas-codex', { userId: '2222', username: 'atlascodex' }],
    ]);

    it('rewrites `@Atlas-Codex` when Discord handle is `atlascodex` (separators stripped)', () => {
      expect(resolveDiscordMentions('@Atlas-Codex hello', mismatchBots)).toBe('<@2222> hello');
    });

    it('rewrites `@atlas_codex` (underscore variant) against `atlascodex`', () => {
      expect(resolveDiscordMentions('@atlas_codex hello', mismatchBots)).toBe('<@2222> hello');
    });

    it('preserves literal-first priority on normalized collision', () => {
      // `atlas-codex` and `atlascodex` both registered — literal owns its
      // own slot; the normalized form of `atlas-codex` (= `atlascodex`)
      // does NOT clobber `atlascodex`'s literal entry.
      const collisionBots = new Map<string, DiscordBotIdentity>([
        ['discord-a', { userId: '1', username: 'atlas-codex' }],
        ['discord-b', { userId: '2', username: 'atlascodex' }],
      ]);
      expect(resolveDiscordMentions('@atlas-codex hi', collisionBots)).toBe('<@1> hi');
      expect(resolveDiscordMentions('@atlascodex hi', collisionBots)).toBe('<@2> hi');
    });
  });

  it('does not double-wrap an existing `<@id>` mention', () => {
    expect(resolveDiscordMentions('<@1111111111> hi', bots)).toBe('<@1111111111> hi');
  });

  it('does not touch role mentions `<@&…>`', () => {
    expect(resolveDiscordMentions('<@&999999999> hi', bots)).toBe('<@&999999999> hi');
  });

  it('preserves code regions verbatim', () => {
    // Mentions inside fenced or inline code must not be rewritten — a
    // documentation example like "use `@Atlas hello`" would otherwise rewrite
    // mid-code.
    expect(resolveDiscordMentions('Inline: `@Atlas hello`', bots)).toBe('Inline: `@Atlas hello`');
    expect(resolveDiscordMentions('```\n@Atlas hello\n```', bots)).toBe('```\n@Atlas hello\n```');
  });

  it('rewrites multiple distinct mentions in one message', () => {
    expect(resolveDiscordMentions('@Atlas and @Atlas-Codex collab', bots)).toBe(
      '<@1111111111> and <@2222222222> collab',
    );
  });

  it('handles `@username` at end-of-string with no trailing whitespace', () => {
    expect(resolveDiscordMentions('over to @Atlas-Codex', bots)).toBe('over to <@2222222222>');
  });

  it('handles trailing sentence punctuation without gobbling it into the capture', () => {
    // This was the bug from the 5/17 roasting thread: the original `[\w.-]+`
    // greedily included the trailing period, so `@Atlas-Codex.` looked up
    // `atlas-codex.` and missed. The downstream chat-sdk adapter then split
    // on the dash via its `/@(\w+)/g` pass and rendered `<@Atlas>-Codex.`.
    // The new `[\w-]+(?:\.[\w-]+)*` pattern stops at sentence punctuation.
    expect(resolveDiscordMentions('Your turn, @Atlas-Codex.', bots)).toBe('Your turn, <@2222222222>.');
    expect(resolveDiscordMentions('hey @Atlas-Codex, ready?', bots)).toBe('hey <@2222222222>, ready?');
    expect(resolveDiscordMentions('@Atlas-Codex!', bots)).toBe('<@2222222222>!');
    expect(resolveDiscordMentions('@Atlas-Codex?', bots)).toBe('<@2222222222>?');
    expect(resolveDiscordMentions('(over to @Atlas-Codex)', bots)).toBe('(over to <@2222222222>)');
    expect(resolveDiscordMentions('@Atlas-Codex: take it', bots)).toBe('<@2222222222>: take it');
    expect(resolveDiscordMentions('@Atlas-Codex; next', bots)).toBe('<@2222222222>; next');
  });

  it('still resolves dotted usernames (Discord post-2023 `user.name` form)', () => {
    // The new regex permits `.suffix` segments so `@user.name` still resolves.
    // Verifies the trailing-punctuation fix didn't regress legal dot-in-username.
    const dotBots = new Map<string, DiscordBotIdentity>([['discord', { userId: '3333333333', username: 'atlas.bot' }]]);
    expect(resolveDiscordMentions('@atlas.bot hi', dotBots)).toBe('<@3333333333> hi');
    expect(resolveDiscordMentions('@atlas.bot.', dotBots)).toBe('<@3333333333>.');
    expect(resolveDiscordMentions('hi @atlas.bot, ready?', dotBots)).toBe('hi <@3333333333>, ready?');
  });

  it('rewrites the bracketed-by-name form `<@Name>` agents sometimes emit', () => {
    // Field-observed bug: agents wrote `<@Atlas-Codex>` literally (they
    // generalize the Slack `<@U123>` template but substitute the username
    // instead of the snowflake). Discord renders this as text since the
    // body isn't a valid id. The rewriter has to be tolerant of this form
    // or sibling handoffs silently break in chat even with the bot filter
    // and outbound rewriter both shipping.
    expect(resolveDiscordMentions('<@Atlas-Codex> your turn.', bots)).toBe('<@2222222222> your turn.');
    expect(resolveDiscordMentions('Your turn, <@Atlas-Codex> — take it.', bots)).toBe(
      'Your turn, <@2222222222> — take it.',
    );
  });

  it('does not touch a real `<@SNOWFLAKE>` mention even with the bracketed-form pass', () => {
    // The bracketed-form rewriter matches `<@([\w.-]+)>`, which would also
    // catch numeric snowflakes. The byName lookup keys on usernames only,
    // so a digits-only capture has no match and falls through unchanged.
    expect(resolveDiscordMentions('<@1111111111> hi', bots)).toBe('<@1111111111> hi');
    expect(resolveDiscordMentions('<@9999999999999999999> from another bot', bots)).toBe(
      '<@9999999999999999999> from another bot',
    );
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

  it('does not corrupt URLs containing a sibling bot name in the path', () => {
    // Lookbehind tightening: `(?<![\w/:])`. The bare-mention pass used to
    // see `@Atlas-Codex` after a path `/` and rewrite the URL into
    // `https://example.com/<@SNOWFLAKE>`, breaking link rendering. The
    // tightened lookbehind keeps URL paths intact.
    const bots = new Map<string, DiscordBotIdentity>([['discord', { userId: '2222222222', username: 'Atlas-Codex' }]]);
    expect(resolveDiscordMentions('https://example.com/@Atlas-Codex/diff', bots)).toBe(
      'https://example.com/@Atlas-Codex/diff',
    );
    expect(resolveDiscordMentions('see notes/users/@Atlas-Codex.md', bots)).toBe('see notes/users/@Atlas-Codex.md');
    // Real mention right after a URL still works.
    expect(resolveDiscordMentions('https://example.com — over to @Atlas-Codex', bots)).toBe(
      'https://example.com — over to <@2222222222>',
    );
  });
});

describe('end-to-end: resolveDiscordMentions → installed chat-sdk adapter render', () => {
  // This is the test that should have existed all along. It exercises the
  // ACTUAL pipeline that runs on the wire to Discord — our outbound rewriter
  // followed by the installed `@chat-adapter/discord`'s `renderPostable` —
  // and asserts on the exact bytes Discord receives.
  //
  // Without this test, five PRs shipped while the rendered chip in
  // screenshots was actually `<` literal + chip + `>` literal (a side-effect
  // of the adapter double-wrapping our resolved `<@SNOWFLAKE>` mentions). The
  // chip looked correct but the wire was `<<@SNOWFLAKE>>`, breaking the
  // wire-level mention contract (no entry in `message.mentions[]`, no
  // notification, no peer-bot wake on the platform side — only the chat-sdk
  // dispatch wakes the sibling, which still worked, so the bug was hard to
  // spot from logs alone).
  //
  // Both halves of the fix are exercised:
  //   (a) the new `[\w-]+(?:\.[\w-]+)*` regex stops at trailing punctuation,
  //       so `@Atlas-Codex.` is resolved instead of slipping through.
  //   (b) the patched `convertMentionsToDiscord` / `nodeToDiscordMarkdown`
  //       use `(?<!<)@(\w+)` so the already-resolved `<@SNOWFLAKE>` is not
  //       double-wrapped.
  const bots = new Map<string, DiscordBotIdentity>([
    ['discord', { userId: '123456789000000001', username: 'Atlas' }],
    ['discord-atlas-codex', { userId: '123456789000000015', username: 'Atlas-Codex' }],
  ]);

  function deliver(agentRawText: string): string {
    const afterMyRewriter = resolveDiscordMentions(agentRawText, bots);
    const converter = new DiscordFormatConverter();
    return converter.renderPostable({ markdown: afterMyRewriter });
  }

  it('produces a clean `<@SNOWFLAKE>` on the wire for `@bot-name.` (sentence-ending)', () => {
    // The exact text from the failed 5/17 thread.
    expect(deliver('Your turn, @Atlas-Codex. Try to keep up.')).toBe(
      'Your turn, <@123456789000000015>. Try to keep up.',
    );
  });

  it('produces a clean `<@SNOWFLAKE>` for `@bot-name` followed by space', () => {
    expect(deliver('I’ll hold my fire. @Atlas has first swing.')).toBe(
      'I’ll hold my fire. <@123456789000000001> has first swing.',
    );
  });

  it('handles the bracketed-by-name form agents sometimes emit (`<@Name>`)', () => {
    expect(deliver('<@Atlas-Codex> your turn.')).toBe('<@123456789000000015> your turn.');
  });

  it('does NOT double-wrap a pre-resolved `<@SNOWFLAKE>` (the bug the patch fixes)', () => {
    // Sanity: even if our rewriter produces `<@id>` on its first pass, the
    // installed adapter must not re-wrap to `<<@id>>` on its way to Discord.
    // Without the lookbehind patch, this assertion fails.
    expect(deliver('hey <@123456789000000001>')).toBe('hey <@123456789000000001>');
  });

  it('passes through messages with no mention untouched', () => {
    expect(deliver('Just a regular message, no mentions here.')).toBe('Just a regular message, no mentions here.');
  });

  it('handles multiple mentions in one message with mixed punctuation', () => {
    expect(deliver('OK @Atlas, you go first; @Atlas-Codex, you follow.')).toBe(
      'OK <@123456789000000001>, you go first; <@123456789000000015>, you follow.',
    );
  });
});

describe('getDiscordBotDisplayName', () => {
  // Host-side accessor used by container-runner's `resolveAssistantName` to
  // compute per-spawn NANOCLAW_ASSISTANT_NAME for Discord-rooted sessions.
  // Discord post-2023 uses a single `username` field — no display_name /
  // discriminator split to navigate.
  //
  // The Discord registry isn't exposed for test seeding (would require an
  // intrusive export), so we cover only the null fall-through here. The
  // happy path is covered via the integration of `resolveAssistantName`
  // when the host wires both Slack + Discord adapters.
  it('returns null for an unregistered channel_type — caller falls through to next resolver', async () => {
    const { getDiscordBotDisplayName } = await import('./discord.js');
    expect(getDiscordBotDisplayName('discord-not-here')).toBeNull();
  });
});

describe('resolveIncomingDiscordMentions', () => {
  const bots = new Map<string, DiscordBotIdentity>([
    ['discord', { userId: '123456789000000001', username: 'Atlas' }],
    ['discord-atlas-codex', { userId: '123456789000000015', username: 'Atlas-Codex' }],
  ]);

  it('returns text unchanged when no bots are registered', () => {
    // Without a bot registry the resolver has nothing to look up. Don't
    // mangle the message — the agent will see raw IDs which is no worse
    // than today.
    expect(resolveIncomingDiscordMentions('<@123456789000000001> hi', new Map())).toBe('<@123456789000000001> hi');
  });

  it('rewrites a known bot snowflake to `@username`', () => {
    expect(resolveIncomingDiscordMentions('<@123456789000000001> take this', bots)).toBe('@Atlas take this');
  });

  it('rewrites the nickname-mention form `<@!id>`', () => {
    // Some Discord clients still emit the legacy nickname-mention form when
    // the mentioned user has a server-specific nickname. Same target user,
    // same resolution.
    expect(resolveIncomingDiscordMentions('<@!123456789000000001> take this', bots)).toBe('@Atlas take this');
  });

  it('rewrites multiple bot mentions in one message', () => {
    // The exact wire form from the field bug: Operator wrote
    // `@Atlas-Codex @Atlas take turns roasting me. @Atlas go first`
    // which Discord delivered as raw snowflakes. Without this resolver
    // Atlas had no way to know its peer was called "Atlas-Codex" and
    // resorted to `<@sibling>`.
    const raw = '<@123456789000000015> <@123456789000000001> take turns roasting me. <@123456789000000001> go first';
    expect(resolveIncomingDiscordMentions(raw, bots)).toBe(
      '@Atlas-Codex @Atlas take turns roasting me. @Atlas go first',
    );
  });

  it('leaves unknown snowflakes unchanged', () => {
    // Human users and out-of-process bots aren't in the registry. Fail
    // soft — the agent reads sender info from author metadata, not from
    // inline mentions of humans.
    expect(resolveIncomingDiscordMentions('<@123456789000000019> hello bots', bots)).toBe(
      '<@123456789000000019> hello bots',
    );
  });

  it('does not touch role mentions `<@&id>`', () => {
    // The regex demands `\d+` so the `&` prefix can't match and roles
    // pass through unchanged. Same for channel mentions.
    expect(resolveIncomingDiscordMentions('<@&999999999> hi', bots)).toBe('<@&999999999> hi');
    expect(resolveIncomingDiscordMentions('<#123456789> see here', bots)).toBe('<#123456789> see here');
  });

  it('round-trips with the outbound rewriter', () => {
    // The whole point: inbound `<@id>` → `@username`, agent writes
    // `@username`, outbound `@username` → `<@id>`. End-to-end the wire
    // form is preserved while the agent only ever handles names.
    const inboundRaw = '<@123456789000000015> please review';
    const agentSees = resolveIncomingDiscordMentions(inboundRaw, bots);
    expect(agentSees).toBe('@Atlas-Codex please review');
    const agentReplies = `Sure, ${agentSees.split(' ').slice(0, 1)[0]} — on it`;
    expect(resolveDiscordMentions(agentReplies, bots)).toBe('Sure, <@123456789000000015> — on it');
  });

  it('preserves code regions verbatim (mirrors outbound)', () => {
    // Codex review #97: when a user pastes a raw log line into a code
    // fence or inline code, the resolver must not "helpfully" rewrite
    // the snowflake — the user put it in code on purpose. The exact
    // string they typed is what the agent should see.
    expect(resolveIncomingDiscordMentions('Inline: `payload: <@123456789000000001>`', bots)).toBe(
      'Inline: `payload: <@123456789000000001>`',
    );
    expect(resolveIncomingDiscordMentions('```\nlog: <@123456789000000001> arrived\n```', bots)).toBe(
      '```\nlog: <@123456789000000001> arrived\n```',
    );
  });

  it('rewrites prose mentions but leaves code-region copies alone in the same message', () => {
    // Mixed prose + code: prose mention should still resolve, code mention
    // should not. Confirms code-region protection is scoped to the protected
    // regions and not a blanket pass-through.
    const input =
      'Hey <@123456789000000015>, here is the raw event:\n```\nevent: { user: "<@123456789000000001>" }\n```';
    expect(resolveIncomingDiscordMentions(input, bots)).toBe(
      'Hey @Atlas-Codex, here is the raw event:\n```\nevent: { user: "<@123456789000000001>" }\n```',
    );
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
      DISCORD_BOT_TOKEN_ATLAS: 'tok-atlas',
      DISCORD_BOT_TOKEN_CODEX: 'tok-codex',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['discord-atlas', 'discord-codex']);
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
      DISCORD_BOT_TOKEN_ATLAS_CODEX: 'tok-codex',
      DISCORD_PUBLIC_KEY_ATLAS_CODEX: 'pk-codex',
      DISCORD_APPLICATION_ID_ATLAS_CODEX: 'app-codex',
    });
    expect(ws).toEqual([
      {
        channelType: 'discord-atlas-codex',
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
    expect(extractDiscordChannelId('discord:123456789000000001:123456789000000002')).toBe('123456789000000002');
  });

  it('test_extract_channel_id_when_thread_segment_present', () => {
    // discord:guildId:channelId:threadId — channelId is still index 2
    expect(extractDiscordChannelId('discord:guildA:channelB:threadC')).toBe('channelB');
  });

  it('test_returns_raw_id_when_no_prefix', () => {
    expect(extractDiscordChannelId('channel-id-X')).toBe('channel-id-X');
  });
});

describe('discordPermalink', () => {
  it('links a thread by guild and thread id — a Discord thread is itself a channel', () => {
    expect(discordPermalink('discord:123456789000000001:123456789000000002:123456789000000003')).toBe(
      'https://discord.com/channels/123456789000000001/123456789000000003',
    );
  });

  it('declines anything it cannot link exactly', () => {
    expect(discordPermalink(null)).toBeNull();
    expect(discordPermalink('discord:123456789000000001:123456789000000002')).toBeNull(); // channel, not thread
    expect(discordPermalink('discord:@me:123456789000000002:123456789000000003')).toBeNull();
    expect(discordPermalink('slack:C0AAA:1786621514.008659')).toBeNull();
  });

  it('links a channel separately', () => {
    expect(discordChannelPermalink('discord:123456789000000001:123456789000000002')).toBe(
      'https://discord.com/channels/123456789000000001/123456789000000002',
    );
    expect(discordChannelPermalink('slack:C0AAA')).toBeNull();
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
    await discordPostParent(mockRest, 'discord:guildA:123456789000000002', 'spawned');
    const route = post.mock.calls[0][0] as string;
    expect(route).toContain('/channels/123456789000000002/messages');
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
    await discordCreateThread(mockRest, 'discord:guildA:123456789000000002', 'parent-msg', 'T', 'first');
    const route = postSpy.mock.calls[0][0] as string;
    expect(route).toContain('/channels/123456789000000002/messages/parent-msg/threads');
    expect(route).not.toContain('discord:');
  });
});

describe('addDiscordThreadMembers', () => {
  it('PUTs each user onto the thread', async () => {
    const rest = { put: vi.fn().mockResolvedValue(undefined) };
    await addDiscordThreadMembers(rest, 'thread1', async () => ['111', '222']);
    expect(rest.put.mock.calls.map((c) => c[0])).toEqual([
      '/channels/thread1/thread-members/111',
      '/channels/thread1/thread-members/222',
    ]);
  });

  it('keeps adding later users after one fails', async () => {
    const rest = { put: vi.fn().mockRejectedValueOnce(new Error('Unknown Member')).mockResolvedValue(undefined) };
    await addDiscordThreadMembers(rest, 'thread1', async () => ['111', '222']);
    expect(rest.put).toHaveBeenCalledTimes(2);
    expect(rest.put.mock.calls[1][0]).toBe('/channels/thread1/thread-members/222');
  });

  it('swallows a failure so the thread still works', async () => {
    const rest = { put: vi.fn().mockRejectedValue(new Error('Missing Access')) };
    await expect(addDiscordThreadMembers(rest, 'thread1', async () => ['111'])).resolves.toBeUndefined();
  });
});

describe('discordThreadNameFrom', () => {
  it('uses the first non-empty line with Markdown punctuation stripped', () => {
    expect(discordThreadNameFrom('\n🔴 **High — not transient.** One prod job down\nmore')).toBe(
      '🔴 High — not transient. One prod job down',
    );
  });

  it('caps at 100 characters and falls back when empty', () => {
    const name = discordThreadNameFrom('x'.repeat(150));
    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith('…')).toBe(true);
    expect(discordThreadNameFrom('**  **')).toBe('Continued');
    expect(discordThreadNameFrom(undefined)).toBe('Continued');
  });
});

describe('installMessageThreadAutoCreate', () => {
  const unknownChannel = () => new Error('Discord API error: 404 {"message": "Unknown Channel", "code": 10003}');
  const anchor = 'discord:guild1:chan1:msg1';

  let addMembers: ReturnType<typeof vi.fn<(rest: DiscordThreadRestClient, threadId: string) => Promise<void>>>;

  function setup(
    postMessage: ReturnType<typeof vi.fn>,
    rest: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> },
  ) {
    const adapter = { postMessage } as unknown as Parameters<typeof installMessageThreadAutoCreate>[0];
    addMembers = vi
      .fn<(rest: DiscordThreadRestClient, threadId: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    installMessageThreadAutoCreate(adapter, rest as unknown as DiscordThreadRestClient, addMembers);
    return adapter as unknown as { postMessage: (t: string, m: unknown) => Promise<unknown> };
  }

  it('opens a thread on the anchor message after 404 Unknown Channel and retries the post once', async () => {
    const postMessage = vi.fn().mockRejectedValueOnce(unknownChannel()).mockResolvedValueOnce({ id: 'reply-1' });
    const rest = {
      get: vi.fn().mockResolvedValue({ content: '**Daily dbt failure**\nbody' }),
      post: vi.fn().mockResolvedValue({ id: 'msg1' }),
    };
    const adapter = setup(postMessage, rest);

    await expect(adapter.postMessage(anchor, { markdown: 'part 2' })).resolves.toEqual({ id: 'reply-1' });
    expect(rest.get.mock.calls[0][0]).toBe('/channels/chan1/messages/msg1');
    expect(rest.post).toHaveBeenCalledWith('/channels/chan1/messages/msg1/threads', {
      body: { name: 'Daily dbt failure' },
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toBe(anchor);
    // The thread shares the anchor message's snowflake; its opener adds the owners.
    expect(addMembers).toHaveBeenCalledWith(rest, 'msg1');
  });

  it('treats 160004 (thread already created by a racing sender) as success', async () => {
    const postMessage = vi.fn().mockRejectedValueOnce(unknownChannel()).mockResolvedValueOnce({ id: 'reply-1' });
    const raced = Object.assign(new Error('A thread has already been created for this message'), { code: 160004 });
    const rest = { get: vi.fn().mockResolvedValue({ content: 'x' }), post: vi.fn().mockRejectedValue(raced) };
    const adapter = setup(postMessage, rest);

    await expect(adapter.postMessage(anchor, {})).resolves.toEqual({ id: 'reply-1' });
    expect(postMessage).toHaveBeenCalledTimes(2);
    // The racing sender opened it, so it adds the members.
    expect(addMembers).not.toHaveBeenCalled();
  });

  it('rethrows the ORIGINAL error when the thread cannot be created, so callers keep their root fallback', async () => {
    const original = unknownChannel();
    const postMessage = vi.fn().mockRejectedValue(original);
    const denied = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const rest = { get: vi.fn().mockResolvedValue({ content: 'x' }), post: vi.fn().mockRejectedValue(denied) };
    const adapter = setup(postMessage, rest);

    await expect(adapter.postMessage(anchor, {})).rejects.toBe(original);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('matches the error the real @chat-adapter/discord throws on 404 Unknown Channel', async () => {
    const realAdapter = createDiscordAdapter({
      botToken: 'test-token',
      publicKey: 'a'.repeat(64),
      applicationId: 'app',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"message": "Unknown Channel", "code": 10003}', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'reply-1', channel_id: 'msg1', content: 'x', author: { id: 'b' } }), {
          status: 200,
        }),
      );
    try {
      const rest = {
        get: vi.fn().mockResolvedValue({ content: 'Parent' }),
        post: vi.fn().mockResolvedValue({ id: 'msg1' }),
      };
      installMessageThreadAutoCreate(realAdapter, rest as unknown as DiscordThreadRestClient);
      await realAdapter.postMessage(anchor, { markdown: 'part 2' });
      expect(rest.post).toHaveBeenCalledWith('/channels/chan1/messages/msg1/threads', { body: { name: 'Parent' } });
      expect(String(fetchSpy.mock.calls[1][0])).toContain('/channels/msg1/messages');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('leaves channel-root posts, DMs and unrelated errors untouched', async () => {
    const rest = { get: vi.fn(), post: vi.fn() };
    for (const [target, err] of [
      ['discord:guild1:chan1', unknownChannel()],
      ['discord:@me:dm1:msg1', unknownChannel()],
      [anchor, new Error('Discord API error: 403 {"message": "Missing Access", "code": 50001}')],
    ] as const) {
      const adapter = setup(vi.fn().mockRejectedValue(err), rest);
      await expect(adapter.postMessage(target, {})).rejects.toBe(err);
    }
    expect(rest.get).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
  });
});

// Ported from upstream 437a5f064 (fix(discord): unwrap forwarded-message
// snapshots so agents see forwarded content).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardPayload(snapshotMessage: Record<string, any> | null, overrides: Record<string, any> = {}) {
  return {
    id: '123',
    content: '',
    attachments: [] as unknown[],
    message_reference: { type: 1, channel_id: 'c1', message_id: 'm1' },
    ...(snapshotMessage ? { message_snapshots: [{ message: snapshotMessage }] } : {}),
    ...overrides,
  };
}

describe('unwrapForwardedSnapshot', () => {
  it('unwraps forwarded text into content with a label', () => {
    const data = forwardPayload({ content: 'hello from the past', attachments: [] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\nhello from the past');
  });

  it('unwraps attachment-only forwards: label + merged attachments', () => {
    const att = { filename: 'photo.png', content_type: 'image/png', size: 1234, url: 'https://cdn.example/photo.png' };
    const data = forwardPayload({ content: '', attachments: [att] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]');
    expect(data.attachments).toEqual([att]);
  });

  it('merges snapshot attachments after existing ones', () => {
    const existing = { filename: 'own.txt', content_type: 'text/plain', size: 1, url: 'https://cdn.example/own.txt' };
    const fwd = { filename: 'fwd.jpg', content_type: 'image/jpeg', size: 2, url: 'https://cdn.example/fwd.jpg' };
    const data = forwardPayload({ content: 'look', attachments: [fwd] }, { attachments: [existing] });
    unwrapForwardedSnapshot(data);
    expect(data.attachments).toEqual([existing, fwd]);
    expect(data.content).toBe('[Forwarded message]\nlook');
  });

  it('leaves plain messages untouched', () => {
    const data = { id: '1', content: 'hi', attachments: [] };
    unwrapForwardedSnapshot(data);
    expect(data).toEqual({ id: '1', content: 'hi', attachments: [] });
  });

  it('leaves normal replies (type 0) untouched — those ride referenced_message', () => {
    const data = {
      id: '1',
      content: 'a reply',
      attachments: [],
      message_reference: { type: 0, message_id: 'm0' },
      referenced_message: { content: 'original', author: { username: 'alice' } },
    };
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('a reply');
  });

  it('is a no-op when a forward has no snapshots', () => {
    const data = forwardPayload(null);
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('');
    expect(data.attachments).toEqual([]);
  });

  it('joins multiple snapshots', () => {
    const data = forwardPayload(null, {
      message_snapshots: [
        { message: { content: 'one', attachments: [] } },
        { message: { content: 'two', attachments: [] } },
      ],
    });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\none\ntwo');
  });
});

describe('installForwardUnwrap', () => {
  it('unwraps before the adapter handler runs, on the live webhook-forwarded seam', async () => {
    // This install runs the Gateway listener in webhook-forwarding mode, so
    // every MESSAGE_CREATE lands on handleForwardedMessage as raw Discord JSON.
    const seen: Array<Record<string, unknown>> = [];
    const adapter = {
      handleForwardedMessage: async (data: Record<string, unknown>) => {
        seen.push({ content: data.content, attachments: data.attachments });
      },
    };

    installForwardUnwrap(adapter as never);
    await (adapter as unknown as { handleForwardedMessage: (d: unknown) => Promise<void> }).handleForwardedMessage(
      forwardPayload({ content: 'forwarded body', attachments: [] }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].content).toBe('[Forwarded message]\nforwarded body');
  });

  it('passes a plain message through unchanged', async () => {
    const seen: string[] = [];
    const adapter = {
      handleForwardedMessage: async (data: Record<string, unknown>) => {
        seen.push(data.content as string);
      },
    };
    installForwardUnwrap(adapter as never);
    await (adapter as unknown as { handleForwardedMessage: (d: unknown) => Promise<void> }).handleForwardedMessage({
      id: '9',
      content: 'plain',
      attachments: [],
    });
    expect(seen).toEqual(['plain']);
  });
});
