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
  it('returns identity when auth.test succeeds', async () => {
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
    expect(id).toEqual({ userId: 'U-ILLIE', username: 'illie', teamId: ILLY_TEAM });
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
