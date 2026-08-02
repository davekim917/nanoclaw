import { describe, expect, it, vi } from 'vitest';

import {
  fetchSlackBotIdentity,
  registerSlackBot,
  resolveSlackMentions,
  upgradeSlackBotProfile,
  type SlackBotIdentity,
} from './slack-mentions.js';

const LABS_TEAM = 'T-EXAMPLE_LABS';
const RETAIL_TEAM = 'T-example-retail';

function makeBots(): Map<string, SlackBotIdentity> {
  const bots = new Map<string, SlackBotIdentity>();
  bots.set('slack-example-labs', { userId: 'U-HELPER', username: 'helper', teamId: LABS_TEAM });
  bots.set('slack-example-labs-codex', { userId: 'U-CODEX', username: 'helper-codex', teamId: LABS_TEAM });
  bots.set('slack-exampleretail', { userId: 'U-BEACON', username: 'beacon', teamId: RETAIL_TEAM });
  return bots;
}

describe('resolveSlackMentions', () => {
  it('returns text unchanged when no bots are registered', () => {
    expect(resolveSlackMentions('@helper-codex hello', 'slack-example-labs', new Map())).toBe('@helper-codex hello');
  });

  it('returns text unchanged when current channel has no registered bot identity', () => {
    expect(resolveSlackMentions('@helper-codex hello', 'slack-unknown', makeBots())).toBe('@helper-codex hello');
  });

  it('rewrites @sibling → <@USER_ID> within the same workspace', () => {
    expect(resolveSlackMentions('@helper-codex take this', 'slack-example-labs', makeBots())).toBe(
      '<@U-CODEX> take this',
    );
  });

  it('rewrites case-insensitively', () => {
    expect(resolveSlackMentions('@Helper-Codex hi', 'slack-example-labs', makeBots())).toBe('<@U-CODEX> hi');
    expect(resolveSlackMentions('@HELPER-CODEX hi', 'slack-example-labs', makeBots())).toBe('<@U-CODEX> hi');
  });

  it('rewrites bracketed `<@name>` (agent emits Slack-style wrapper but with username)', () => {
    expect(resolveSlackMentions('<@helper-codex> picking up', 'slack-example-labs', makeBots())).toBe(
      '<@U-CODEX> picking up',
    );
  });

  it('does NOT cross workspaces — helper can not @-mention beacon (different teamId)', () => {
    // helper (Example Labs workspace) writes about Example Retail's bot. Slack tenants are
    // disjoint, so the rewrite must NOT happen — Slack would reject the
    // user ID at post time and the message would 400.
    expect(resolveSlackMentions('@beacon is in another workspace', 'slack-example-labs', makeBots())).toBe(
      '@beacon is in another workspace',
    );
  });

  it('leaves existing `<@USER_ID>` alone — already canonical', () => {
    expect(resolveSlackMentions('<@UTEST00021> hi', 'slack-example-labs', makeBots())).toBe('<@UTEST00021> hi');
  });

  it('leaves channel mentions `<#C…>` alone', () => {
    expect(resolveSlackMentions('see <#CTEST00004>', 'slack-example-labs', makeBots())).toBe('see <#CTEST00004>');
  });

  it('does not parse `person14@fixture3.example.com` as a mention', () => {
    expect(resolveSlackMentions('write to person20@fixture9.example.com', 'slack-example-labs', makeBots())).toBe(
      'write to person20@fixture9.example.com',
    );
  });

  it('skips fenced code blocks', () => {
    const input = 'before\n```\n@helper-codex inside code\n```\nafter';
    expect(resolveSlackMentions(input, 'slack-example-labs', makeBots())).toBe(input);
  });

  it('skips inline code', () => {
    expect(resolveSlackMentions('inline `@helper-codex` literal', 'slack-example-labs', makeBots())).toBe(
      'inline `@helper-codex` literal',
    );
  });

  it('rewrites multiple mentions in one message', () => {
    expect(resolveSlackMentions('over to @helper-codex and back to @helper', 'slack-example-labs', makeBots())).toBe(
      'over to <@U-CODEX> and back to <@U-HELPER>',
    );
  });

  it('handles trailing punctuation correctly (no greedy capture)', () => {
    expect(resolveSlackMentions('your turn, @helper-codex.', 'slack-example-labs', makeBots())).toBe(
      'your turn, <@U-CODEX>.',
    );
    expect(resolveSlackMentions('hey @helper-codex, ready?', 'slack-example-labs', makeBots())).toBe(
      'hey <@U-CODEX>, ready?',
    );
    expect(resolveSlackMentions('@helper-codex!', 'slack-example-labs', makeBots())).toBe('<@U-CODEX>!');
  });

  it('leaves unknown @-names alone (fail-soft)', () => {
    expect(resolveSlackMentions('@randomuser hi', 'slack-example-labs', makeBots())).toBe('@randomuser hi');
  });

  // Operator-typed Slack handles often drop hyphens/underscores even though
  // the agent's logical name keeps them. Production case: agent_group
  // `example-retail-codex` registered as Slack username `beaconcodex`. The agent
  // (per CLAUDE.md "Working with peer agents") writes `@Beacon-Codex`; without
  // separator-normalized fallback the lookup misses and the @-mention ships
  // as plain text — Slack fires no mention event, the peer never wakes.
  describe('separator-normalized fallback (operator-handle mismatch)', () => {
    function makeBotsWithMismatch(): Map<string, SlackBotIdentity> {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-exampleretail', { userId: 'U-BEACON', username: 'legacybot', teamId: RETAIL_TEAM });
      bots.set('slack-exampleretail-codex', { userId: 'U-BEACON-CODEX', username: 'beaconcodex', teamId: RETAIL_TEAM });
      return bots;
    }

    it('rewrites `@beacon-codex` when Slack handle is `beaconcodex` (separators stripped)', () => {
      expect(resolveSlackMentions('@beacon-codex pick this up', 'slack-exampleretail', makeBotsWithMismatch())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('rewrites `@Beacon-Codex` case-insensitively against `beaconcodex`', () => {
      expect(resolveSlackMentions('@Beacon-Codex pick this up', 'slack-exampleretail', makeBotsWithMismatch())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('rewrites `@beacon_codex` (underscore variant) against `beaconcodex`', () => {
      expect(resolveSlackMentions('@beacon_codex pick this up', 'slack-exampleretail', makeBotsWithMismatch())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('still rewrites the literal `@beaconcodex` form', () => {
      expect(resolveSlackMentions('@beaconcodex pick this up', 'slack-exampleretail', makeBotsWithMismatch())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('preserves literal-first priority — `beacon-codex` literal beats `beaconcodex`-normalized collision', () => {
      // Both bots registered: one literal `beacon-codex`, one literal `beaconcodex`.
      // The normalized form of both is `beaconcodex`. The literal `beaconcodex`
      // owns the `beaconcodex` slot in byName (literal-first). `@beacon-codex`
      // hits its own literal; `@beaconcodex` hits the other literal — both
      // bots remain individually mentionable.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-retail', { userId: 'U-A', username: 'beacon-codex', teamId: RETAIL_TEAM });
      bots.set('slack-retail-codex', { userId: 'U-B', username: 'beaconcodex', teamId: RETAIL_TEAM });
      bots.set('slack-retail-self', { userId: 'U-SELF', username: 'legacybot', teamId: RETAIL_TEAM });
      expect(resolveSlackMentions('@beacon-codex hi', 'slack-retail-self', bots)).toBe('<@U-A> hi');
      expect(resolveSlackMentions('@beaconcodex hi', 'slack-retail-self', bots)).toBe('<@U-B> hi');
    });

    it('does not cross workspaces via normalized form either', () => {
      // helper-codex is in Example Labs; an Example Retail agent writing `@helpercodex` (a
      // separator-collapsed normalized form) must NOT resolve to the
      // Example Labs bot because they're in different teamIds.
      const bots = makeBots(); // helper-codex is LABS_TEAM, beacon is RETAIL_TEAM
      expect(resolveSlackMentions('@helpercodex hi', 'slack-exampleretail', bots)).toBe('@helpercodex hi');
    });
  });

  // Slack's `auth.test.user` returns the legacy install-time name. For bots
  // that have been renamed via the App config (or whose `real_name` diverges
  // from `name`), operators @-mention them by the display name shown in
  // Slack's UI, which comes from `profile.real_name` (or `display_name` when
  // set). Concrete production case: Beacon's `auth.test.user = "legacybot"` but
  // `profile.real_name = "Beacon"` — operators write `@beacon`.
  describe('displayName/realName aliases (auth.test name diverges from UI name)', () => {
    function makeMrBots(): Map<string, SlackBotIdentity> {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-exampleretail', {
        userId: 'U-BEACON',
        username: 'legacybot',
        realName: 'Beacon',
        teamId: RETAIL_TEAM,
      });
      bots.set('slack-exampleretail-codex', {
        userId: 'U-BEACON-CODEX',
        username: 'beaconcodex',
        realName: 'Beacon-Codex',
        teamId: RETAIL_TEAM,
      });
      return bots;
    }

    it('rewrites `@beacon` against realName when username is legacy `legacybot`', () => {
      expect(resolveSlackMentions('@beacon over to you', 'slack-exampleretail-codex', makeMrBots())).toBe(
        '<@U-BEACON> over to you',
      );
    });

    it('rewrites `@legacybot` against legacy username — both names work', () => {
      expect(resolveSlackMentions('@legacybot over to you', 'slack-exampleretail-codex', makeMrBots())).toBe(
        '<@U-BEACON> over to you',
      );
    });

    it('rewrites `@Beacon-Codex` against realName when username is `beaconcodex`', () => {
      expect(resolveSlackMentions('@Beacon-Codex pick this up', 'slack-exampleretail', makeMrBots())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('rewrites `@beaconcodex` against literal username — still works', () => {
      expect(resolveSlackMentions('@beaconcodex pick this up', 'slack-exampleretail', makeMrBots())).toBe(
        '<@U-BEACON-CODEX> pick this up',
      );
    });

    it('prefers displayName over realName when both are set', () => {
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-retail', {
        userId: 'U-SELF',
        username: 'self',
        teamId: RETAIL_TEAM,
      });
      bots.set('slack-retail-bot', {
        userId: 'U-FRIENDLY',
        username: 'legacy',
        displayName: 'Friendly',
        realName: 'Real',
        teamId: RETAIL_TEAM,
      });
      // Both display ("friendly") and real ("real") map to the same user.
      expect(resolveSlackMentions('@friendly hi', 'slack-retail', bots)).toBe('<@U-FRIENDLY> hi');
      expect(resolveSlackMentions('@real hi', 'slack-retail', bots)).toBe('<@U-FRIENDLY> hi');
      expect(resolveSlackMentions('@legacy hi', 'slack-retail', bots)).toBe('<@U-FRIENDLY> hi');
    });

    it('literal username still wins on collision with another bot realName', () => {
      // Bot A's username is `beacon`. Bot B's realName lowercased is also `beacon`.
      // The literal username owns the slot — bot B's realName collision
      // does not overwrite it.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-retail-self', { userId: 'U-SELF', username: 'self', teamId: RETAIL_TEAM });
      bots.set('slack-retail-a', { userId: 'U-A', username: 'beacon', teamId: RETAIL_TEAM });
      bots.set('slack-retail-b', { userId: 'U-B', username: 'other', realName: 'Beacon', teamId: RETAIL_TEAM });
      expect(resolveSlackMentions('@beacon hi', 'slack-retail-self', bots)).toBe('<@U-A> hi');
      expect(resolveSlackMentions('@other hi', 'slack-retail-self', bots)).toBe('<@U-B> hi');
    });

    it('does not cross workspaces via realName alias', () => {
      // An Example Labs bot's realName lowercased could collide with an Example Retail
      // session's expected handle, but teamId scoping must block it.
      const bots = new Map<string, SlackBotIdentity>();
      bots.set('slack-exampleretail', {
        userId: 'U-BEACON',
        username: 'legacybot',
        realName: 'Beacon',
        teamId: RETAIL_TEAM,
      });
      bots.set('slack-example-labs-impostor', {
        userId: 'U-IMPOSTOR',
        username: 'impostor',
        realName: 'Beacon', // collides on realName with Example Retail's bot
        teamId: LABS_TEAM,
      });
      // From Example Retail session, @beacon resolves to Example Retail's bot, not Example Labs's.
      expect(resolveSlackMentions('@beacon hi', 'slack-exampleretail', bots)).toBe('<@U-BEACON> hi');
      // From Example Labs session, @beacon resolves to Example Labs's bot only — Example Retail's
      // is filtered out by teamId.
      expect(resolveSlackMentions('@beacon hi', 'slack-example-labs-impostor', bots)).toBe('<@U-IMPOSTOR> hi');
    });
  });

  // URL safety — `transformOutsideProtectedRegions` only shields code
  // spans, so URL guards live in the lookbehind itself. Without `/` and
  // `:` in the exclude class, an `@-after-path-slash` would get rewritten
  // and corrupt the URL.
  describe('URL safety', () => {
    it('does not rewrite inside a https URL path', () => {
      expect(
        resolveSlackMentions('Check https://example.com/@helper-codex for the diff', 'slack-example-labs', makeBots()),
      ).toBe('Check https://example.com/@helper-codex for the diff');
    });

    it('does not rewrite inside a generic path (slash before @)', () => {
      expect(resolveSlackMentions('see notes/users/@helper-codex.md', 'slack-example-labs', makeBots())).toBe(
        'see notes/users/@helper-codex.md',
      );
    });

    it('does not rewrite after `:` (user:pass@host URL form)', () => {
      expect(
        resolveSlackMentions('jdbc:postgres://user:@helper-codex.example.com', 'slack-example-labs', makeBots()),
      ).toBe('jdbc:postgres://user:@helper-codex.example.com');
    });

    it('still rewrites a real mention right after a URL on the same line', () => {
      expect(
        resolveSlackMentions('https://example.com — over to @helper-codex', 'slack-example-labs', makeBots()),
      ).toBe('https://example.com — over to <@U-CODEX>');
    });
  });

  describe('workspace humans', () => {
    function makeHumans(): Map<string, SlackBotIdentity[]> {
      const humans = new Map<string, SlackBotIdentity[]>();
      humans.set(LABS_TEAM, [
        {
          userId: 'U-OPERATOR1',
          username: 'operator.one',
          displayName: 'Opal',
          realName: 'Opal Operator',
          teamId: LABS_TEAM,
        },
        { userId: 'U-OPERATOR2', username: 'jsmith', displayName: '', realName: 'Jay', teamId: LABS_TEAM },
      ]);
      humans.set(RETAIL_TEAM, [
        {
          userId: 'U-RETAILHUM',
          username: 'retail.human',
          displayName: 'Rhea',
          realName: 'Rhea R',
          teamId: RETAIL_TEAM,
        },
      ]);
      return humans;
    }

    it('rewrites a human display name → <@USER_ID>', () => {
      expect(resolveSlackMentions('cc @Opal for approval', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        'cc <@U-OPERATOR1> for approval',
      );
    });

    it('rewrites a human real name when display name is empty', () => {
      expect(resolveSlackMentions('over to @Jay', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        'over to <@U-OPERATOR2>',
      );
    });

    it('rewrites bracketed `<@username>` for a human', () => {
      expect(resolveSlackMentions('<@jsmith> please review', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        '<@U-OPERATOR2> please review',
      );
    });

    it('does NOT resolve humans from a different workspace', () => {
      expect(resolveSlackMentions('ping @Rhea', 'slack-example-labs', makeBots(), makeHumans())).toBe('ping @Rhea');
    });

    it('bot aliases win alias collisions with humans', () => {
      const humans = makeHumans();
      humans.get(LABS_TEAM)!.push({
        userId: 'U-IMPOSTER',
        username: 'humanuser',
        displayName: 'helper-codex',
        realName: 'Helper Codex',
        teamId: LABS_TEAM,
      });
      expect(resolveSlackMentions('@helper-codex take this', 'slack-example-labs', makeBots(), humans)).toBe(
        '<@U-CODEX> take this',
      );
    });

    it('leaves human mentions untouched inside code spans', () => {
      expect(resolveSlackMentions('run `@Opal` literally', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        'run `@Opal` literally',
      );
    });

    it('a human username beats another human’s display name for the same alias', () => {
      // Earlier user's free-text display name = later user's canonical
      // username. The username (unique per Slack) must own the alias
      // regardless of users.list ordering.
      const humans = new Map<string, SlackBotIdentity[]>();
      humans.set(LABS_TEAM, [
        { userId: 'U-FIRST', username: 'first.user', displayName: 'jsmith', realName: 'F', teamId: LABS_TEAM },
        { userId: 'U-REAL-JSMITH', username: 'jsmith', displayName: 'Jay S', realName: 'J', teamId: LABS_TEAM },
      ]);
      expect(resolveSlackMentions('@jsmith review this', 'slack-example-labs', makeBots(), humans)).toBe(
        '<@U-REAL-JSMITH> review this',
      );
    });

    it('drops a display-name alias shared by two humans instead of guessing', () => {
      const humans = new Map<string, SlackBotIdentity[]>();
      humans.set(LABS_TEAM, [
        { userId: 'U-ALEX1', username: 'alex.a', displayName: 'Alex', realName: 'Alex One', teamId: LABS_TEAM },
        { userId: 'U-ALEX2', username: 'alex.b', displayName: 'Alex', realName: 'Alex Two', teamId: LABS_TEAM },
      ]);
      // Ambiguous "@Alex" stays literal; unique usernames still resolve.
      expect(resolveSlackMentions('ping @Alex', 'slack-example-labs', makeBots(), humans)).toBe('ping @Alex');
      expect(resolveSlackMentions('ping @alex.a', 'slack-example-labs', makeBots(), humans)).toBe('ping <@U-ALEX1>');
      expect(resolveSlackMentions('ping @alex.b', 'slack-example-labs', makeBots(), humans)).toBe('ping <@U-ALEX2>');
    });

    it('resolves Unicode display names whole — no ASCII-prefix truncation', () => {
      const humans = new Map<string, SlackBotIdentity[]>();
      humans.set(LABS_TEAM, [
        { userId: 'U-JOSE', username: 'jose.g', displayName: 'José', realName: 'José García', teamId: LABS_TEAM },
        // "jos" is a real registered alias — the trap: ASCII \w would match
        // `@Jos` out of `@José` and ping the wrong person.
        { userId: 'U-JOS', username: 'jos', displayName: '', realName: '', teamId: LABS_TEAM },
      ]);
      expect(resolveSlackMentions('gracias @José', 'slack-example-labs', makeBots(), humans)).toBe('gracias <@U-JOSE>');
      expect(resolveSlackMentions('ping @jos', 'slack-example-labs', makeBots(), humans)).toBe('ping <@U-JOS>');
    });

    it('resolves CJK display names', () => {
      const humans = new Map<string, SlackBotIdentity[]>();
      humans.set(LABS_TEAM, [
        { userId: 'U-KIM', username: 'dkim', displayName: '김대현', realName: '', teamId: LABS_TEAM },
      ]);
      expect(resolveSlackMentions('@김대현 확인 부탁해요', 'slack-example-labs', makeBots(), humans)).toBe(
        '<@U-KIM> 확인 부탁해요',
      );
    });

    it('unknown Unicode names stay untouched', () => {
      expect(resolveSlackMentions('ping @Zoë', 'slack-example-labs', makeBots(), makeHumans())).toBe('ping @Zoë');
    });

    it('does not rewrite registered names inside URL query strings or fragments', () => {
      const urls = [
        'see https://example.com/prs?owner=@Opal for the list',
        'filter https://example.com/prs?a=1&assignee=@Opal too',
        'anchor https://example.com/board#@Opal stays',
      ];
      for (const u of urls) {
        expect(resolveSlackMentions(u, 'slack-example-labs', makeBots(), makeHumans())).toBe(u);
      }
    });

    it('punctuation-rich names degrade to unresolved, never a wrong ping', () => {
      // `@O'Brien` captures only `@O`; "o" is not a registered alias, so the
      // text stays literal — degraded but safe. (Exotic aliases with spaces/
      // apostrophes are out of scope for the rewriter; ambiguity-drop plus
      // this test guard the failure mode that matters: pinging the wrong
      // person.)
      expect(resolveSlackMentions("ask @O'Brien about it", 'slack-example-labs', makeBots(), makeHumans())).toBe(
        "ask @O'Brien about it",
      );
    });
  });
});

describe('getSlackBotDisplayName', () => {
  // Host-side accessor used by container-runner's `resolveAssistantName` to
  // compute per-spawn NANOCLAW_ASSISTANT_NAME. Precedence mirrors what
  // Slack's UI autocomplete itself uses for @-mention resolution.
  function withRegistered(channelType: string, identity: SlackBotIdentity, fn: () => void): void {
    registerSlackBot(channelType, identity);
    try {
      fn();
    } finally {
      // Channel-types are unique per test; "clear" by overwriting with a
      // disjoint teamId so cross-test bleed is impossible.
      registerSlackBot(channelType, { ...identity, teamId: '__cleared__' });
    }
  }

  it('returns null when the channel_type has no registered bot', async () => {
    const { getSlackBotDisplayName } = await import('./slack-mentions.js');
    expect(getSlackBotDisplayName('slack-unregistered')).toBeNull();
  });

  it('prefers profile.display_name over realName and username', async () => {
    const { getSlackBotDisplayName } = await import('./slack-mentions.js');
    withRegistered(
      'slack-disp',
      { userId: 'U-1', username: 'legacy', displayName: 'Friendly', realName: 'Real', teamId: RETAIL_TEAM },
      () => {
        expect(getSlackBotDisplayName('slack-disp')).toBe('Friendly');
      },
    );
  });

  it('falls back to profile.real_name when display_name is empty', async () => {
    const { getSlackBotDisplayName } = await import('./slack-mentions.js');
    withRegistered(
      'slack-real',
      { userId: 'U-2', username: 'legacybot', realName: 'Beacon', teamId: RETAIL_TEAM },
      () => {
        expect(getSlackBotDisplayName('slack-real')).toBe('Beacon');
      },
    );
  });

  it('falls back to legacy auth.test.user when neither profile field is set', async () => {
    const { getSlackBotDisplayName } = await import('./slack-mentions.js');
    withRegistered('slack-user', { userId: 'U-3', username: 'legacybot', teamId: RETAIL_TEAM }, () => {
      expect(getSlackBotDisplayName('slack-user')).toBe('legacybot');
    });
  });
});

describe('fetchSlackBotIdentity', () => {
  // fetchSlackBotIdentity is intentionally fast/non-blocking — it only does
  // auth.test, never users.info. Profile enrichment runs separately via
  // upgradeSlackBotProfile so adapter factory init stays under the auth.test
  // ceiling (5s) even when Slack's profile API is slow. See Codex P2 review
  // on PR #111.
  it('returns identity without profile fields — adapter init never awaits users.info', async () => {
    const usersInfo = vi.fn(); // present but should not be called by fetch
    const client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          ok: true,
          user_id: 'U-BEACON',
          user: 'legacybot',
          team_id: RETAIL_TEAM,
        }),
      },
      users: { info: usersInfo },
    };
    const id = await fetchSlackBotIdentity(client);
    expect(id).toEqual({ userId: 'U-BEACON', username: 'legacybot', teamId: RETAIL_TEAM });
    expect(usersInfo).not.toHaveBeenCalled();
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

describe('upgradeSlackBotProfile (fire-and-forget profile enrichment)', () => {
  // Tests mutate the module-scoped knownSlackBots map. Each test seeds
  // exactly the channelType it asserts against and clears it after, so
  // tests don't leak state.
  function withRegistered(channelType: string, identity: SlackBotIdentity, fn: () => Promise<void>): Promise<void> {
    registerSlackBot(channelType, identity);
    return fn().finally(() => {
      // The module exports no unregister; overwrite with a defunct entry to
      // avoid cross-test bleed. Other tests use disjoint channelType names.
      registerSlackBot(channelType, { ...identity, teamId: '__cleared__' });
    });
  }

  it('upgrades the registry entry with displayName + realName when users.info succeeds', async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: { profile: { display_name: '', real_name: 'Beacon' } },
        }),
      },
    };
    await withRegistered(
      'slack-test-retail',
      { userId: 'U-BEACON', username: 'legacybot', teamId: RETAIL_TEAM },
      async () => {
        await upgradeSlackBotProfile(client, 'slack-test-retail');
        const bots = new Map<string, SlackBotIdentity>();
        bots.set('slack-test-self', { userId: 'U-SELF', username: 'self', teamId: RETAIL_TEAM });
        // Pull the upgraded entry from the live registry into a snapshot
        // map and verify @beacon now resolves through it.
        const { getKnownSlackBots } = await import('./slack-mentions.js');
        for (const [ch, ident] of getKnownSlackBots()) bots.set(ch, ident);
        expect(resolveSlackMentions('@beacon over to you', 'slack-test-self', bots)).toBe('<@U-BEACON> over to you');
        expect(resolveSlackMentions('@legacybot over to you', 'slack-test-self', bots)).toBe('<@U-BEACON> over to you');
      },
    );
  });

  it('is a no-op when the channelType is not registered (defensive)', async () => {
    const usersInfo = vi.fn();
    const client = { users: { info: usersInfo } };
    await upgradeSlackBotProfile(client, 'slack-unregistered');
    expect(usersInfo).not.toHaveBeenCalled();
  });

  it('is a no-op when the client has no users.info (e.g. older mock)', async () => {
    await withRegistered('slack-test-noinfo', { userId: 'U-X', username: 'x', teamId: 'T-X' }, async () => {
      // Should resolve cleanly without throwing.
      await upgradeSlackBotProfile({}, 'slack-test-noinfo');
    });
  });

  it('swallows errors when users.info rejects — registry stays at username-only', async () => {
    const client = { users: { info: vi.fn().mockRejectedValue(new Error('missing_scope')) } };
    await withRegistered('slack-test-err', { userId: 'U-ERR', username: 'err', teamId: 'T-ERR' }, async () => {
      await expect(upgradeSlackBotProfile(client, 'slack-test-err')).resolves.toBeUndefined();
    });
  });

  it('skips the registry update when neither display_name nor real_name is set', async () => {
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: { profile: { display_name: '', real_name: '' } },
        }),
      },
    };
    await withRegistered('slack-test-empty', { userId: 'U-EMPTY', username: 'empty', teamId: 'T-EMPTY' }, async () => {
      await upgradeSlackBotProfile(client, 'slack-test-empty');
      const { getKnownSlackBots } = await import('./slack-mentions.js');
      const got = getKnownSlackBots().get('slack-test-empty');
      // Registry entry retains the username-only shape.
      expect(got?.realName).toBeUndefined();
      expect(got?.displayName).toBeUndefined();
    });
  });
});
