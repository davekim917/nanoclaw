import { describe, expect, it, vi } from 'vitest';

import {
  fetchSlackBotIdentity,
  getSlackBotSenderName,
  normalizeSlackOrderedListContinuations,
  registerSlackBot,
  registerSlackWorkspaceHumans,
  resolveInboundSlackIds,
  resolveSlackMentions,
  slackMentionOutsideCode,
  slackPermalink,
  slackChannelPermalink,
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

    it('turns unprefixed names in a structured Who field into real mentions', () => {
      const humans = makeHumans();
      humans.get(LABS_TEAM)!.push({
        userId: 'U-BOSUN',
        username: 'bosun',
        displayName: 'Bosun',
        realName: 'Bosun Operator',
        teamId: LABS_TEAM,
      });
      expect(
        resolveSlackMentions('◦ Who: Opal or Bosun\n◦ Why: decision needed', 'slack-example-labs', makeBots(), humans),
      ).toBe('◦ Who: <@U-OPERATOR1> or <@U-BOSUN>\n◦ Why: decision needed');
    });

    it('does not infer mentions from the same names in ordinary prose', () => {
      expect(resolveSlackMentions('Opal or Jay can decide', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        'Opal or Jay can decide',
      );
    });

    it('preserves an explicit mention already present in a Who field', () => {
      expect(resolveSlackMentions('• **Who:** @Opal', 'slack-example-labs', makeBots(), makeHumans())).toBe(
        '• **Who:** <@U-OPERATOR1>',
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

    it('normalizes a known bot ID inside inline code to the plain name (gate syntax)', () => {
      expect(
        resolveSlackMentions(
          'reply `<@U-CODEX> ship 302 300 295` in the channel',
          'slack-example-labs',
          makeBots(),
          makeHumans(),
        ),
      ).toBe('reply `@helper-codex ship 302 300 295` in the channel');
    });

    it('leaves unknown and human IDs inside inline code untouched', () => {
      const input = 'the raw id was `<@U-OPERATOR1>` and `<@UTEST99ZZZ>` — investigate';
      expect(resolveSlackMentions(input, 'slack-example-labs', makeBots(), makeHumans())).toBe(input);
    });

    it('does not normalize bot IDs inside fenced code blocks', () => {
      const input = 'log:\n```\nsender=<@U-CODEX> action=ship\n```\ndone';
      expect(resolveSlackMentions(input, 'slack-example-labs', makeBots(), makeHumans())).toBe(input);
    });

    it('does not normalize a cross-workspace bot ID in inline code', () => {
      const input = 'try `<@U-BEACON> ship 1`';
      expect(resolveSlackMentions(input, 'slack-example-labs', makeBots(), makeHumans())).toBe(input);
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

describe('resolveInboundSlackIds', () => {
  it('resolves bracketed and flattened bot/human ids to @name; unknown ids pass through', () => {
    registerSlackBot('slack-test-inbound', {
      userId: 'U-GATEBOT',
      username: 'testbot',
      displayName: 'skipper',
      teamId: 'T-INBOUND',
    });
    registerSlackWorkspaceHumans('T-INBOUND', [
      { userId: 'U-HUMAN1', username: 'alice.w', realName: 'Alice Woods', teamId: 'T-INBOUND' },
    ]);
    try {
      expect(resolveInboundSlackIds('<@U-GATEBOT> hold 304 before <@U-HUMAN1> replies', 'slack-test-inbound')).toBe(
        '@skipper hold 304 before @Alice Woods replies',
      );
      // Label form and unknown id
      expect(resolveInboundSlackIds('<@U-GATEBOT|skipper> vs <@U-UNKNOWN9>', 'slack-test-inbound')).toBe(
        '@skipper vs <@U-UNKNOWN9>',
      );
      expect(resolveInboundSlackIds('@U-GATEBOT ship 100 before @U-HUMAN1 replies', 'slack-test-inbound')).toBe(
        '@skipper ship 100 before @Alice Woods replies',
      );
      expect(resolveInboundSlackIds('@U-UNKNOWN9 ship 100', 'slack-test-inbound')).toBe('@U-UNKNOWN9 ship 100');
      expect(resolveInboundSlackIds('no mentions here', 'slack-test-inbound')).toBe('no mentions here');
    } finally {
      registerSlackBot('slack-test-inbound', {
        userId: 'U-GATEBOT',
        username: 'testbot',
        teamId: '__cleared__',
      });
      registerSlackWorkspaceHumans('T-INBOUND', []);
    }
  });

  it('prefers a bot real name over its deprecated install-time username', () => {
    registerSlackBot('slack-test-inbound-real-name', {
      userId: 'U-CLAW',
      username: 'claw',
      realName: 'Beacon',
      teamId: 'T-INBOUND-REAL-NAME',
    });
    try {
      expect(resolveInboundSlackIds('<@U-CLAW> please take this', 'slack-test-inbound-real-name')).toBe(
        '@Beacon please take this',
      );
    } finally {
      registerSlackBot('slack-test-inbound-real-name', {
        userId: 'U-CLAW',
        username: 'claw',
        teamId: '__cleared__',
      });
    }
  });
});

describe('getSlackBotSenderName', () => {
  it('uses the current profile name for sibling authors in the same workspace', () => {
    registerSlackBot('slack-sender-self', {
      userId: 'U-SELF-SENDER',
      username: 'self-old',
      realName: 'Beacon',
      teamId: 'T-SENDER',
    });
    registerSlackBot('slack-sender-peer', {
      userId: 'U-PEER-SENDER',
      username: 'peer-old',
      realName: 'Dinesh',
      teamId: 'T-SENDER',
    });
    registerSlackBot('slack-sender-foreign', {
      userId: 'U-FOREIGN-SENDER',
      username: 'foreign',
      realName: 'Foreign',
      teamId: 'T-OTHER-SENDER',
    });
    try {
      expect(getSlackBotSenderName('slack-sender-self', 'U-PEER-SENDER')).toBe('Dinesh');
      expect(getSlackBotSenderName('slack-sender-self', 'U-FOREIGN-SENDER')).toBeNull();
      expect(getSlackBotSenderName('slack-sender-self', 'U-HUMAN-SENDER')).toBeNull();
    } finally {
      for (const channelType of ['slack-sender-self', 'slack-sender-peer', 'slack-sender-foreign']) {
        registerSlackBot(channelType, {
          userId: `cleared-${channelType}`,
          username: 'cleared',
          teamId: '__cleared__',
        });
      }
    }
  });
});

describe('normalizeSlackOrderedListContinuations', () => {
  it('indents digest detail bullets so explicit item numbers stay in one Slack list', () => {
    const input = [
      '1. First ask',
      '◦ Who: Skipper',
      '◦ Reply: ship 1',
      '',
      '2. Second ask',
      '• Who: Bosun',
      '• Reply: ship 2',
      '',
      ':gear: AUTO',
    ].join('\n');
    expect(normalizeSlackOrderedListContinuations(input)).toBe(
      [
        '1. First ask',
        '   ◦ Who: Skipper',
        '   ◦ Reply: ship 1',
        '2. Second ask',
        '   • Who: Bosun',
        '   • Reply: ship 2',
        '',
        ':gear: AUTO',
      ].join('\n'),
    );
  });

  it('leaves an already-indented ordered list unchanged', () => {
    const input = '1. First\n   • detail\n2. Second';
    expect(normalizeSlackOrderedListContinuations(input)).toBe(input);
  });
});

// Wire-level contract with the PATCHED @chat-adapter/slack (mirrors the
// discord.test.ts patched-adapter suite). The vendor `finalize()` rewrote
// bare `@name` to `<@name>` across the WHOLE markdown string — code spans
// included — so the documented gate syntax the agent correctly wrote as
// `` `@skipper hold 281` `` reached Slack as `<@skipper>`, was resolved
// server-side to the raw `<@USERID>` form, and rendered as unreadable
// literal text inside the code span. The patch scopes the rewrite to
// non-code segments only.
describe('patched @chat-adapter/slack finalize (code spans stay literal)', async () => {
  const { SlackFormatConverter } = await import('@chat-adapter/slack');

  function payload(markdown: string): string {
    const converter = new SlackFormatConverter();
    return (converter as unknown as { toSlackPayload(m: object): { markdown_text: string } }).toSlackPayload({
      markdown,
    }).markdown_text;
  }

  it('keeps gate syntax inside inline code as plain @name', () => {
    expect(payload('confirm here, or `@skipper hold 281`')).toBe('confirm here, or `@skipper hold 281`');
  });

  it('keeps fenced blocks untouched', () => {
    expect(payload('```\n@skipper ship 297\n```')).toBe('```\n@skipper ship 297\n```');
  });

  it('still rewrites bare mentions in prose', () => {
    expect(payload('mixed `@skipper hold 1` and prose @skipper here')).toBe(
      'mixed `@skipper hold 1` and prose <@skipper> here',
    );
  });
});

// Hardening cases from codex review: double-backtick spans and 4+-backtick
// fences must also shield their contents from the bare-mention rewrite.
describe('patched finalize — extended code-boundary cases', async () => {
  const { SlackFormatConverter } = await import('@chat-adapter/slack');
  const payload = (markdown: string): string =>
    (new SlackFormatConverter() as unknown as { toSlackPayload(m: object): { markdown_text: string } }).toSlackPayload({
      markdown,
    }).markdown_text;

  it('shields ``double-backtick`` spans', () => {
    expect(payload('use ``lit`@skipper`` here')).toBe('use ``lit`@skipper`` here');
  });

  it('shields four-backtick fences', () => {
    expect(payload('````\n@skipper ship 1\n````')).toBe('````\n@skipper ship 1\n````');
  });

  it('unpaired single backtick does not swallow the rest of the message', () => {
    expect(payload('stray ` then @skipper prose')).toBe('stray ` then <@skipper> prose');
  });
});

describe('patched @chat-adapter/slack outgoing mention resolver', async () => {
  const { SlackAdapter } = await import('@chat-adapter/slack');

  async function resolve(markdown: string): Promise<string> {
    const adapter = new SlackAdapter({ botToken: 'xoxb-test', signingSecret: 'test-secret' });
    const state = {
      getList: vi.fn(async (key: string) => (key === 'slack:user-by-name:flotilla' ? ['UTESTADM1'] : [])),
    };
    (adapter as unknown as { chat: unknown }).chat = { getState: () => state };
    return (
      adapter as unknown as { resolveOutgoingMentions(text: string, threadId: string): Promise<string> }
    ).resolveOutgoingMentions(markdown, 'slack:C-TEST:123.456');
  }

  it('keeps semantic gate syntax in inline code while resolving prose mentions', async () => {
    await expect(resolve('Reply: `@flotilla ship 100`; prose @flotilla owns it.')).resolves.toBe(
      'Reply: `@flotilla ship 100`; prose <@UTESTADM1> owns it.',
    );
  });

  it('keeps semantic gate syntax in fenced code', async () => {
    await expect(resolve('```\n@flotilla ship 100\n```')).resolves.toBe('```\n@flotilla ship 100\n```');
  });
});

describe('release digest incident regression', async () => {
  const { SlackAdapter, SlackFormatConverter } = await import('@chat-adapter/slack');

  it('ships numbered items, real Who pings, and semantic reply syntax in one wire payload', async () => {
    const bots = new Map<string, SlackBotIdentity>([
      ['slack-wg-acme-flotilla', { userId: 'UTESTADM1', username: 'flotilla', teamId: 'TTESTTEAM1' }],
    ]);
    const humans = new Map<string, SlackBotIdentity[]>([
      [
        'TTESTTEAM1',
        [
          { userId: 'UTESTSKIP1', username: 'skipper', displayName: 'Skipper', teamId: 'TTESTTEAM1' },
          { userId: 'UTESTBOSUN1', username: 'bosun', displayName: 'Bosun', teamId: 'TTESTTEAM1' },
        ],
      ],
    ]);
    const source = [
      '1. **#100 — release gate**',
      '   • **Who:** Skipper or Bosun',
      '   • **Reply:** `@flotilla ship 100`',
      '',
      '2. **#56 — second gate**',
      '   • **Who:** Skipper',
      '   • **Reply:** `@flotilla ship 56`',
      '',
      '⚙️ **AUTO**',
    ].join('\n');
    const transformed = resolveSlackMentions(
      normalizeSlackOrderedListContinuations(source),
      'slack-wg-acme-flotilla',
      bots,
      humans,
    );

    const adapter = new SlackAdapter({ botToken: 'xoxb-test', signingSecret: 'test-secret' });
    const state = { getList: vi.fn(async () => []) };
    (adapter as unknown as { chat: unknown }).chat = { getState: () => state };
    const resolved = await (
      adapter as unknown as { resolveOutgoingMentions(text: string, threadId: string): Promise<string> }
    ).resolveOutgoingMentions(transformed, 'slack:CTESTCHAN1:1785755345.439779');
    const payload = new SlackFormatConverter().toSlackPayload({ markdown: resolved });

    expect(payload).toEqual({
      markdown_text: [
        '1. **#100 — release gate**',
        '   • **Who:** <@UTESTSKIP1> or <@UTESTBOSUN1>',
        '   • **Reply:** `@flotilla ship 100`',
        '2. **#56 — second gate**',
        '   • **Who:** <@UTESTSKIP1>',
        '   • **Reply:** `@flotilla ship 56`',
        '',
        '⚙️ **AUTO**',
      ].join('\n'),
    });
  });
});

// Slack fires app_mention for a literal `@name` inside backticks (observed
// live: a sibling's report documenting the gate syntax `@skipper ship 356`
// woke the gate bot, which replied "Nothing needs you" to its own docs).
// The refine hook demotes a platform mention whose only occurrence is
// inside code regions.
describe('slackMentionOutsideCode', () => {
  const identity = { userId: 'U-GATEBOT', username: 'gatebot', displayName: 'skipper', teamId: 'T-X' };

  it('demotes when the mention is only inside inline code', () => {
    expect(slackMentionOutsideCode('ready for the gate. Reply `@skipper ship 356` to merge.', identity)).toBe(false);
  });

  it('demotes when the mention is only inside a fenced block', () => {
    expect(slackMentionOutsideCode('usage:\n```\n@skipper hold 42\n```\ndone', identity)).toBe(false);
  });

  it('keeps a prose mention', () => {
    expect(slackMentionOutsideCode('@skipper you are up', identity)).toBe(true);
  });

  it('keeps a prose mention even when code spans also reference it', () => {
    expect(slackMentionOutsideCode('@skipper see `@skipper ship 1` syntax', identity)).toBe(true);
  });

  it('keeps a raw-id mention outside code', () => {
    expect(slackMentionOutsideCode('<@U-GATEBOT> status?', identity)).toBe(true);
  });

  it('matches username and realName aliases case-insensitively', () => {
    expect(slackMentionOutsideCode('@GateBot please', identity)).toBe(true);
    expect(
      slackMentionOutsideCode('@The Gate Bot please', {
        ...identity,
        displayName: undefined,
        realName: 'The Gate Bot',
      }),
    ).toBe(true);
  });
});

// #256 — the regex this scanner replaced accepted ANY run of 3+ backticks
// as a fence closer, so a longer fence wrapping content that itself
// contained a shorter 3+ run closed early and leaked a mention as prose.
describe('slackMentionOutsideCode fence scanning (#256)', () => {
  const identity = { userId: 'UBOT', username: 'gatebot', teamId: 'T-X' };

  it('wakes on a mention in plain text', () => {
    expect(slackMentionOutsideCode('<@UBOT> ship it', identity)).toBe(true);
  });

  it('demotes a mention inside a plain ``` fence', () => {
    expect(slackMentionOutsideCode('```\n<@UBOT> ship\n```', identity)).toBe(false);
  });

  it('demotes a mention inside a ```` fence whose content contains a ``` line (the #256 repro)', () => {
    expect(slackMentionOutsideCode('```` ```<@UBOT> ship ````', identity)).toBe(false);
    // The exact form from the issue body and from PR #243's regression test.
    expect(slackMentionOutsideCode('usage:\n````\n```\n<@UBOT> ship\n```\n````\ndone', identity)).toBe(false);
  });

  it('demotes a mention inside an inline `code` span', () => {
    expect(slackMentionOutsideCode('see `<@UBOT> ship` above', identity)).toBe(false);
  });

  it('wakes on a mention after a properly closed fence', () => {
    expect(slackMentionOutsideCode('```usage```\n<@UBOT> ship', identity)).toBe(true);
  });

  it('treats an unterminated fence as code through the end of the text', () => {
    // No closing run at all — the mention is swallowed as code, not prose.
    expect(slackMentionOutsideCode('```\n<@UBOT> ship', identity)).toBe(false);
    // A closer that's too short to match the (longer) opener doesn't count
    // as a close either, so the fence is still open at end of text.
    expect(slackMentionOutsideCode('````\n<@UBOT> ship\n```', identity)).toBe(false);
  });

  it('tildes are not a Slack fence delimiter, so a mention "inside" ~~~ still wakes', () => {
    // Slack's renderer has no ~~~ code-fence syntax — only backticks — so
    // this still renders as a live, pinging mention in Slack.
    expect(slackMentionOutsideCode('~~~\n<@UBOT> ship\n~~~', identity)).toBe(true);
  });
});

describe('slackPermalink', () => {
  const CHANNEL_TYPE = 'slack-permalink-test';

  function register(workspaceUrl: string | undefined): void {
    registerSlackBot(CHANNEL_TYPE, {
      userId: 'U1',
      username: 'bot',
      teamId: 'T1',
      ...(workspaceUrl === undefined ? {} : { workspaceUrl }),
    });
  }

  it('builds a Slack thread link from the routing thread id', () => {
    register('https://acme.slack.com/');

    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', 'slack:C0AAA:1786621514.008659')).toBe(
      'https://acme.slack.com/archives/C0AAA/p1786621514008659?thread_ts=1786621514.008659&cid=C0AAA',
    );
  });

  // The whole point of the link. Without `thread_ts` Slack treats it as a plain
  // message address and opens the CHANNEL at that message; operators clicking
  // "open thread" landed in the room. The query must name the top-level ts and
  // the channel, which is the shape chat.getPermalink returns for a thread.
  it('names the thread in the query, not just the message in the path', () => {
    register('https://acme.slack.com/');

    const url = new URL(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', 'slack:C0AAA:1786621514.008659')!);
    expect(url.pathname).toBe('/archives/C0AAA/p1786621514008659');
    expect(url.searchParams.get('thread_ts')).toBe('1786621514.008659');
    expect(url.searchParams.get('cid')).toBe('C0AAA');
  });

  it('tolerates a workspace url with no trailing slash', () => {
    register('https://acme.slack.com');

    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', 'slack:C0AAA:1786621514.008659')).toBe(
      'https://acme.slack.com/archives/C0AAA/p1786621514008659?thread_ts=1786621514.008659&cid=C0AAA',
    );
  });

  it('falls back to the platform id when the thread id is a bare ts', () => {
    register('https://acme.slack.com/');

    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', '1786621514.008659')).toBe(
      'https://acme.slack.com/archives/C0AAA/p1786621514008659?thread_ts=1786621514.008659&cid=C0AAA',
    );
  });

  it('declines rather than guessing when the workspace url is unknown', () => {
    register(undefined);

    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', 'slack:C0AAA:1786621514.008659')).toBeNull();
  });

  it('declines for an unregistered channel type, a null thread, and a non-ts thread id', () => {
    register('https://acme.slack.com/');

    expect(slackPermalink('slack-unregistered', 'slack:C0AAA', 'slack:C0AAA:1786621514.008659')).toBeNull();
    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', null)).toBeNull();
    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', 'slack:C0AAA:not-a-timestamp')).toBeNull();
  });
});

describe('slackChannelPermalink', () => {
  const CHANNEL_TYPE = 'slack-channel-permalink-test';

  it('links the ROOM, which the thread builder is contractually unable to do', () => {
    registerSlackBot(CHANNEL_TYPE, {
      userId: 'U1',
      username: 'bot',
      teamId: 'T1',
      workspaceUrl: 'https://acme.slack.com/',
    });

    expect(slackChannelPermalink(CHANNEL_TYPE, 'slack:C0AAA')).toBe('https://acme.slack.com/archives/C0AAA');
    // The reason this function exists: asking for a room link through the
    // thread builder returns null on every room, forever.
    expect(slackPermalink(CHANNEL_TYPE, 'slack:C0AAA', null)).toBeNull();
  });

  it('declines rather than guessing when the workspace is unknown', () => {
    expect(slackChannelPermalink('slack-never-registered', 'slack:C0AAA')).toBeNull();
  });
});
