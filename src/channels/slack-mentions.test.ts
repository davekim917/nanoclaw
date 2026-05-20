import { describe, expect, it, vi } from 'vitest';

import { fetchSlackBotIdentity, resolveSlackMentions, type SlackBotIdentity } from './slack-mentions.js';

const ILLY_TEAM = 'T-ILLYSIUM';
const MR_TEAM = 'T-MADISONREED';

function makeBots(): Map<string, SlackBotIdentity> {
  const bots = new Map<string, SlackBotIdentity>();
  bots.set('slack-illysium', { userId: 'U-ILLIE', username: 'illie', teamId: ILLY_TEAM });
  bots.set('slack-illysium-codex', { userId: 'U-CODEX', username: 'illie-codex', teamId: ILLY_TEAM });
  bots.set('slack-madisonreed', { userId: 'U-BO', username: 'bo', teamId: MR_TEAM });
  return bots;
}

describe('resolveSlackMentions', () => {
  it('returns text unchanged when no bots are registered', () => {
    expect(resolveSlackMentions('@illie-codex hello', 'slack-illysium', new Map())).toBe('@illie-codex hello');
  });

  it('returns text unchanged when current channel has no registered bot identity', () => {
    expect(resolveSlackMentions('@illie-codex hello', 'slack-unknown', makeBots())).toBe('@illie-codex hello');
  });

  it('rewrites @sibling → <@USER_ID> within the same workspace', () => {
    expect(resolveSlackMentions('@illie-codex take this', 'slack-illysium', makeBots())).toBe('<@U-CODEX> take this');
  });

  it('rewrites case-insensitively', () => {
    expect(resolveSlackMentions('@Illie-Codex hi', 'slack-illysium', makeBots())).toBe('<@U-CODEX> hi');
    expect(resolveSlackMentions('@ILLIE-CODEX hi', 'slack-illysium', makeBots())).toBe('<@U-CODEX> hi');
  });

  it('rewrites bracketed `<@name>` (agent emits Slack-style wrapper but with username)', () => {
    expect(resolveSlackMentions('<@illie-codex> picking up', 'slack-illysium', makeBots())).toBe(
      '<@U-CODEX> picking up',
    );
  });

  it('does NOT cross workspaces — illie can not @-mention bo (different teamId)', () => {
    // illie (Illysium workspace) writes about MR's bot. Slack tenants are
    // disjoint, so the rewrite must NOT happen — Slack would reject the
    // user ID at post time and the message would 400.
    expect(resolveSlackMentions('@bo is in another workspace', 'slack-illysium', makeBots())).toBe(
      '@bo is in another workspace',
    );
  });

  it('leaves existing `<@USER_ID>` alone — already canonical', () => {
    expect(resolveSlackMentions('<@U0AKALV5HRP> hi', 'slack-illysium', makeBots())).toBe('<@U0AKALV5HRP> hi');
  });

  it('leaves channel mentions `<#C…>` alone', () => {
    expect(resolveSlackMentions('see <#C0AJA89MN2E>', 'slack-illysium', makeBots())).toBe('see <#C0AJA89MN2E>');
  });

  it('does not parse `email@domain.com` as a mention', () => {
    expect(resolveSlackMentions('write to ops@illie-codex.example.com', 'slack-illysium', makeBots())).toBe(
      'write to ops@illie-codex.example.com',
    );
  });

  it('skips fenced code blocks', () => {
    const input = 'before\n```\n@illie-codex inside code\n```\nafter';
    expect(resolveSlackMentions(input, 'slack-illysium', makeBots())).toBe(input);
  });

  it('skips inline code', () => {
    expect(resolveSlackMentions('inline `@illie-codex` literal', 'slack-illysium', makeBots())).toBe(
      'inline `@illie-codex` literal',
    );
  });

  it('rewrites multiple mentions in one message', () => {
    expect(resolveSlackMentions('over to @illie-codex and back to @illie', 'slack-illysium', makeBots())).toBe(
      'over to <@U-CODEX> and back to <@U-ILLIE>',
    );
  });

  it('handles trailing punctuation correctly (no greedy capture)', () => {
    expect(resolveSlackMentions('your turn, @illie-codex.', 'slack-illysium', makeBots())).toBe(
      'your turn, <@U-CODEX>.',
    );
    expect(resolveSlackMentions('hey @illie-codex, ready?', 'slack-illysium', makeBots())).toBe(
      'hey <@U-CODEX>, ready?',
    );
    expect(resolveSlackMentions('@illie-codex!', 'slack-illysium', makeBots())).toBe('<@U-CODEX>!');
  });

  it('leaves unknown @-names alone (fail-soft)', () => {
    expect(resolveSlackMentions('@randomuser hi', 'slack-illysium', makeBots())).toBe('@randomuser hi');
  });

  // Operator-typed Slack handles often drop hyphens/underscores even though
  // the agent's logical name keeps them. Production case: agent_group
  // `madison-reed-codex` registered as Slack username `bocodex`. The agent
  // (per CLAUDE.md "Working with peer agents") writes `@Bo-codex`; without
  // separator-normalized fallback the lookup misses and the @-mention ships
  // as plain text — Slack fires no mention event, the peer never wakes.
  describe('separator-normalized fallback (operator-handle mismatch)', () => {
    function makeBotsWithMismatch(): Map<string, SlackBotIdentity> {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-madisonreed', { userId: 'U-BO', username: 'beau', teamId: MR_TEAM });
      bots.set('slack-madisonreed-codex', { userId: 'U-BO-CODEX', username: 'bocodex', teamId: MR_TEAM });
      return bots;
    }

    it('rewrites `@bo-codex` when Slack handle is `bocodex` (separators stripped)', () => {
      expect(resolveSlackMentions('@bo-codex pick this up', 'slack-madisonreed', makeBotsWithMismatch())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('rewrites `@Bo-Codex` case-insensitively against `bocodex`', () => {
      expect(resolveSlackMentions('@Bo-Codex pick this up', 'slack-madisonreed', makeBotsWithMismatch())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('rewrites `@bo_codex` (underscore variant) against `bocodex`', () => {
      expect(resolveSlackMentions('@bo_codex pick this up', 'slack-madisonreed', makeBotsWithMismatch())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('still rewrites the literal `@bocodex` form', () => {
      expect(resolveSlackMentions('@bocodex pick this up', 'slack-madisonreed', makeBotsWithMismatch())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('preserves literal-first priority — `bo-codex` literal beats `bocodex`-normalized collision', () => {
      // Both bots registered: one literal `bo-codex`, one literal `bocodex`.
      // The normalized form of both is `bocodex`. The literal `bocodex`
      // owns the `bocodex` slot in byName (literal-first). `@bo-codex`
      // hits its own literal; `@bocodex` hits the other literal — both
      // bots remain individually mentionable.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-mr', { userId: 'U-A', username: 'bo-codex', teamId: MR_TEAM });
      bots.set('slack-mr-codex', { userId: 'U-B', username: 'bocodex', teamId: MR_TEAM });
      bots.set('slack-mr-self', { userId: 'U-SELF', username: 'beau', teamId: MR_TEAM });
      expect(resolveSlackMentions('@bo-codex hi', 'slack-mr-self', bots)).toBe('<@U-A> hi');
      expect(resolveSlackMentions('@bocodex hi', 'slack-mr-self', bots)).toBe('<@U-B> hi');
    });

    it('does not cross workspaces via normalized form either', () => {
      // illie-codex is in Illysium; an MR agent writing `@illiecodex` (a
      // separator-collapsed normalized form) must NOT resolve to the
      // Illysium bot because they're in different teamIds.
      const bots = makeBots(); // illie-codex is ILLY_TEAM, bo is MR_TEAM
      expect(resolveSlackMentions('@illiecodex hi', 'slack-madisonreed', bots)).toBe('@illiecodex hi');
    });
  });

  // Slack's `auth.test.user` returns the legacy install-time name. For bots
  // that have been renamed via the App config (or whose `real_name` diverges
  // from `name`), operators @-mention them by the display name shown in
  // Slack's UI, which comes from `profile.real_name` (or `display_name` when
  // set). Concrete production case: Bo's `auth.test.user = "beau"` but
  // `profile.real_name = "Bo"` — operators write `@bo`.
  describe('displayName/realName aliases (auth.test name diverges from UI name)', () => {
    function makeMrBots(): Map<string, SlackBotIdentity> {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-madisonreed', {
        userId: 'U-BO',
        username: 'beau',
        realName: 'Bo',
        teamId: MR_TEAM,
      });
      bots.set('slack-madisonreed-codex', {
        userId: 'U-BO-CODEX',
        username: 'bocodex',
        realName: 'Bo-codex',
        teamId: MR_TEAM,
      });
      return bots;
    }

    it('rewrites `@bo` against realName when username is legacy `beau`', () => {
      expect(resolveSlackMentions('@bo over to you', 'slack-madisonreed-codex', makeMrBots())).toBe(
        '<@U-BO> over to you',
      );
    });

    it('rewrites `@beau` against legacy username — both names work', () => {
      expect(resolveSlackMentions('@beau over to you', 'slack-madisonreed-codex', makeMrBots())).toBe(
        '<@U-BO> over to you',
      );
    });

    it('rewrites `@Bo-codex` against realName when username is `bocodex`', () => {
      expect(resolveSlackMentions('@Bo-codex pick this up', 'slack-madisonreed', makeMrBots())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('rewrites `@bocodex` against literal username — still works', () => {
      expect(resolveSlackMentions('@bocodex pick this up', 'slack-madisonreed', makeMrBots())).toBe(
        '<@U-BO-CODEX> pick this up',
      );
    });

    it('prefers displayName over realName when both are set', () => {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-mr', {
        userId: 'U-SELF',
        username: 'self',
        teamId: MR_TEAM,
      });
      bots.set('slack-mr-bot', {
        userId: 'U-BOT',
        username: 'legacy',
        displayName: 'Friendly',
        realName: 'Real',
        teamId: MR_TEAM,
      });
      // Both display ("friendly") and real ("real") map to the same user.
      expect(resolveSlackMentions('@friendly hi', 'slack-mr', bots)).toBe('<@U-BOT> hi');
      expect(resolveSlackMentions('@real hi', 'slack-mr', bots)).toBe('<@U-BOT> hi');
      expect(resolveSlackMentions('@legacy hi', 'slack-mr', bots)).toBe('<@U-BOT> hi');
    });

    it('literal username still wins on collision with another bot realName', () => {
      // Bot A's username is `bo`. Bot B's realName lowercased is also `bo`.
      // The literal username owns the slot — bot B's realName collision
      // does not overwrite it.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-mr-self', { userId: 'U-SELF', username: 'self', teamId: MR_TEAM });
      bots.set('slack-mr-a', { userId: 'U-A', username: 'bo', teamId: MR_TEAM });
      bots.set('slack-mr-b', { userId: 'U-B', username: 'other', realName: 'Bo', teamId: MR_TEAM });
      expect(resolveSlackMentions('@bo hi', 'slack-mr-self', bots)).toBe('<@U-A> hi');
      expect(resolveSlackMentions('@other hi', 'slack-mr-self', bots)).toBe('<@U-B> hi');
    });

    it('does not cross workspaces via realName alias', () => {
      // An Illysium bot's realName lowercased could collide with an MR
      // session's expected handle, but teamId scoping must block it.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-madisonreed', { userId: 'U-BO', username: 'beau', realName: 'Bo', teamId: MR_TEAM });
      bots.set('slack-illysium-impostor', {
        userId: 'U-IMPOSTOR',
        username: 'impostor',
        realName: 'Bo', // collides on realName with MR's bot
        teamId: ILLY_TEAM,
      });
      // From MR session, @bo resolves to MR's bot, not Illysium's.
      expect(resolveSlackMentions('@bo hi', 'slack-madisonreed', bots)).toBe('<@U-BO> hi');
      // From Illysium session, @bo resolves to Illysium's bot only — MR's
      // is filtered out by teamId.
      expect(resolveSlackMentions('@bo hi', 'slack-illysium-impostor', bots)).toBe('<@U-IMPOSTOR> hi');
    });
  });

  // URL safety — `transformOutsideProtectedRegions` only shields code
  // spans, so URL guards live in the lookbehind itself. Without `/` and
  // `:` in the exclude class, an `@-after-path-slash` would get rewritten
  // and corrupt the URL.
  describe('URL safety', () => {
    it('does not rewrite inside a https URL path', () => {
      expect(
        resolveSlackMentions('Check https://example.com/@illie-codex for the diff', 'slack-illysium', makeBots()),
      ).toBe('Check https://example.com/@illie-codex for the diff');
    });

    it('does not rewrite inside a generic path (slash before @)', () => {
      expect(resolveSlackMentions('see notes/users/@illie-codex.md', 'slack-illysium', makeBots())).toBe(
        'see notes/users/@illie-codex.md',
      );
    });

    it('does not rewrite after `:` (user:pass@host URL form)', () => {
      expect(resolveSlackMentions('jdbc:postgres://user:@illie-codex.example.com', 'slack-illysium', makeBots())).toBe(
        'jdbc:postgres://user:@illie-codex.example.com',
      );
    });

    it('still rewrites a real mention right after a URL on the same line', () => {
      expect(resolveSlackMentions('https://example.com — over to @illie-codex', 'slack-illysium', makeBots())).toBe(
        'https://example.com — over to <@U-CODEX>',
      );
    });
  });
});

describe('fetchSlackBotIdentity', () => {
  it('returns identity with profile fields when auth.test + users.info succeed', async () => {
    // Production case: Bo's auth.test.user is the legacy `beau` but
    // profile.real_name is `Bo`. Both must surface so the rewriter can
    // resolve `@bo` AND `@beau` to the same user_id.
    const client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          ok: true,
          user_id: 'U-BO',
          user: 'beau',
          team_id: MR_TEAM,
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: { profile: { display_name: '', real_name: 'Bo' } },
        }),
      },
    };
    const id = await fetchSlackBotIdentity(client);
    expect(id).toEqual({
      userId: 'U-BO',
      username: 'beau',
      realName: 'Bo',
      displayName: undefined,
      teamId: MR_TEAM,
    });
  });

  it('falls back to username-only when users.info is unavailable', async () => {
    // Best-effort: a token without users:read scope or a client without
    // users.info bound (test fixtures, older WebClient mock) still yields
    // a working identity — identical to pre-fix behavior.
    const client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          ok: true,
          user_id: 'U-ILLIE',
          user: 'illie',
          team_id: ILLY_TEAM,
        }),
      },
    };
    const id = await fetchSlackBotIdentity(client);
    expect(id).toEqual({
      userId: 'U-ILLIE',
      username: 'illie',
      realName: undefined,
      displayName: undefined,
      teamId: ILLY_TEAM,
    });
  });

  it('continues with username-only when users.info throws', async () => {
    const client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          ok: true,
          user_id: 'U-BO',
          user: 'beau',
          team_id: MR_TEAM,
        }),
      },
      users: {
        info: vi.fn().mockRejectedValue(new Error('missing_scope')),
      },
    };
    const id = await fetchSlackBotIdentity(client);
    expect(id).toEqual({
      userId: 'U-BO',
      username: 'beau',
      realName: undefined,
      displayName: undefined,
      teamId: MR_TEAM,
    });
  });

  it('returns null on incomplete response', async () => {
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U-X' }) },
    };
    expect(await fetchSlackBotIdentity(client)).toBeNull();
  });

  it('returns null when auth.test rejects', async () => {
    const client = {
      auth: { test: vi.fn().mockRejectedValue(new Error('not_authed')) },
    };
    expect(await fetchSlackBotIdentity(client)).toBeNull();
  });
});
