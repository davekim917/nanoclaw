/**
 * The A2A room opener's integration point is the token-key convention it
 * shares with the Slack adapter: the script reads `SLACK_BOT_TOKEN_<SUFFIX>`
 * for an instance the operator names, and the adapter registers that same
 * suffix as channelType `slack-<suffix>`. The two derivations live in
 * different files and are inverses of each other, so a change to either one
 * silently makes the script read a key no workspace uses — it would fail with
 * "missing SLACK_BOT_TOKEN_X in .env" against a host where that bot is live.
 *
 * These tests drive the REAL parser (`parseSlackWorkspaces` in
 * src/channels/slack.ts) rather than restating the regex, so adapter drift
 * goes red here.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertDistinctBotUsers,
  assertDistinctInstances,
  assertSameWorkspace,
  channelTypeForInstance,
  main,
  normalizeInstance,
  parseArgs,
  tokenEnvKey,
} from '../scripts/open-a2a-room.js';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock('../../../../src/env.js', () => ({
  readEnvFileMatching: () => env.values,
  readEnvFile: () => env.values,
}));

/** Stub startup credentials; each parser invocation receives its fixture directly. */
async function workspacesFor(values: Record<string, string>) {
  env.values = values;
  const slack = await import('../../../../src/channels/slack.js');
  return slack.parseSlackWorkspaces(values);
}

/** Instance spellings an operator plausibly types, and the channelType each
 *  one must resolve to. */
const CASES: Array<{ instance: string; channelType: string }> = [
  { instance: 'default', channelType: 'slack' },
  { instance: 'slack', channelType: 'slack' },
  { instance: 'example-labs', channelType: 'slack-example-labs' },
  { instance: 'slack-example-labs', channelType: 'slack-example-labs' },
  { instance: 'example-labs-codex', channelType: 'slack-example-labs-codex' },
  { instance: 'slack-example-labs-codex', channelType: 'slack-example-labs-codex' },
  { instance: 'Example-Labs', channelType: 'slack-example-labs' },
  // The environment-form suffix, which is what an operator reads off the
  // `.env` line. The adapter maps `_` to `-`, so both spellings name the
  // instance the adapter actually registered.
  { instance: 'EXAMPLE_LABS_CODEX', channelType: 'slack-example-labs-codex' },
  { instance: 'SLACK_EXAMPLE_LABS_CODEX', channelType: 'slack-example-labs-codex' },
];

describe('open-a2a-room instance naming matches the Slack adapter', () => {
  it.each(CASES)(
    'test_token_key_round_trip: "$instance" reads a key the adapter registers as $channelType',
    async ({ instance, channelType }) => {
      const key = tokenEnvKey(instance);
      const workspaces = await workspacesFor({
        [key]: 'xoxb-test',
        [key.replace('BOT_TOKEN', 'APP_TOKEN')]: 'xapp-test',
      });
      expect(workspaces.map((w) => w.channelType)).toEqual([channelType]);
      expect(channelTypeForInstance(instance)).toBe(channelType);
    },
  );

  it('test_multi_underscore_suffix_survives: a three-word suffix is not truncated', async () => {
    // Regression guard for the class the adapter's own comment calls out:
    // SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX must not be dropped by a suffix
    // pattern that forbids `_`.
    expect(tokenEnvKey('example-labs-codex')).toBe('SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX');
    const workspaces = await workspacesFor({
      SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX: 'xoxb-test',
      SLACK_APP_TOKEN_EXAMPLE_LABS_CODEX: 'xapp-test',
    });
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.channelType).toBe('slack-example-labs-codex');
  });

  it('test_primary_instance_has_no_suffix: "default" reads the unsuffixed key', () => {
    expect(normalizeInstance('default')).toBe('');
    expect(tokenEnvKey('default')).toBe('SLACK_BOT_TOKEN');
    expect(tokenEnvKey('slack')).toBe('SLACK_BOT_TOKEN');
  });
});

describe('open-a2a-room refuses a roster that spans Slack workspaces', () => {
  const auth = (name: string, teamId: string | null) => ({
    name,
    envKey: `SLACK_BOT_TOKEN_${name.toUpperCase()}`,
    token: 'xoxb-test',
    userId: `U0${name.toUpperCase()}`,
    botId: null,
    teamId,
  });

  it('rejects different suffixes that authenticate as the same bot user', () => {
    const first = auth('synthetic-one', 'T000TEST');
    const second = auth('synthetic-two', 'T000TEST');
    expect(() => assertDistinctBotUsers([first, second])).not.toThrow();
    second.userId = first.userId;
    expect(() => assertDistinctBotUsers([first, second])).toThrow(
      'instances "synthetic-one" and "synthetic-two" resolve to the same Slack bot user',
    );
  });

  it('test_same_workspace_passes: every bot in one workspace is accepted', () => {
    expect(() => assertSameWorkspace([auth('dana', 'T111'), auth('eli', 'T111')])).not.toThrow();
  });

  it('test_cross_workspace_rejected: the error names the workspaces and their instances', () => {
    // conversations.open cannot build an MPIM from foreign-workspace user ids,
    // and the error it returns names neither instance — so the roster is
    // checked here, before the room is created.
    expect(() => assertSameWorkspace([auth('dana', 'T111'), auth('eli', 'T222')])).toThrow(/spans? 2 Slack workspaces/);
    expect(() => assertSameWorkspace([auth('dana', 'T111'), auth('eli', 'T222')])).toThrow(/T111: dana/);
    expect(() => assertSameWorkspace([auth('dana', 'T111'), auth('eli', 'T222')])).toThrow(/T222: eli/);
  });

  it('test_unknown_team_id_does_not_block: a response without team_id is not treated as a mismatch', () => {
    expect(() => assertSameWorkspace([auth('dana', 'T111'), auth('eli', null)])).not.toThrow();
  });
});

describe('open-a2a-room refuses two spellings of one instance', () => {
  it('test_distinct_instances_pass: different bots are accepted', () => {
    expect(() => assertDistinctInstances(['dana', 'eli'])).not.toThrow();
    expect(() => assertDistinctInstances(['slack-dana', 'eli'])).not.toThrow();
  });

  it('test_alias_duplicate_rejected: channelType and bare suffix name one bot', () => {
    // Both spellings resolve to the same token and the same bot user id, so a
    // roster like this used to satisfy the two-instance minimum and then put
    // the caller's own id into conversations.open.
    expect(() => assertDistinctInstances(['example-labs', 'slack-example-labs'])).toThrow(
      /lists the same instance twice/,
    );
    expect(() => assertDistinctInstances(['example-labs', 'slack-example-labs'])).toThrow(/example-labs/);
  });

  it('test_case_and_underscore_aliases_rejected: normalization collapses these too', () => {
    expect(() => assertDistinctInstances(['Example-Labs', 'example_labs'])).toThrow(/lists the same instance twice/);
  });

  it('test_primary_aliases_rejected: "slack" and "default" are one instance', () => {
    expect(() => assertDistinctInstances(['slack', 'default'])).toThrow(/the primary instance/);
  });

  it('test_parse_args_applies_the_check: the guard runs before the count minimums', () => {
    // The check has to be wired in, not merely present: it runs ahead of the
    // "--instances needs at least two" branch, which calls process.exit and
    // would take the test runner with it.
    expect(() => parseArgs(['--instances', 'example-labs,slack-example-labs', '--user', 'U0HUMAN'])).toThrow(
      /lists the same instance twice/,
    );
    expect(() => parseArgs(['--instances', 'dana,eli', '--user', 'U0HUMAN'])).not.toThrow();
  });

  it('test_alias_duplicate_cannot_satisfy_the_minimum: three entries, two bots', () => {
    // The bot-only path needs three real instances; three spellings of two
    // bots must not pass for them.
    expect(() => assertDistinctInstances(['dana', 'eli', 'slack-eli'])).toThrow(/lists the same instance twice/);
  });
});

it('stops duplicate resolved identities before opening a room', async () => {
  env.values = { SLACK_BOT_TOKEN_SYNTHETIC_ONE: 'xoxb-test-one', SLACK_BOT_TOKEN_SYNTHETIC_TWO: 'xoxb-test-two' };
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({ ok: true, user_id: 'U0BOT', team_id: 'T0TEST' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await expect(main(['--instances', 'synthetic-one,synthetic-two', '--user', 'U0HUMAN'])).rejects.toThrow(
      'instances "synthetic-one" and "synthetic-two" resolve to the same Slack bot user',
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://slack.com/api/auth.test',
      'https://slack.com/api/auth.test',
    ]);
  } finally {
    vi.unstubAllGlobals();
    log.mockRestore();
  }
});

describe('open-a2a-room respects the MPIM invitee limit', () => {
  it.each([false, true])('accepts eight invitees with human=%s and rejects nine', (withHuman) => {
    const instances = Array.from({ length: withHuman ? 8 : 9 }, (_, i) => `synthetic-${i}`);
    const userArgs = withHuman ? ['--user', 'U0HUMAN'] : [];
    expect(() => parseArgs(['--instances', instances.join(','), ...userArgs])).not.toThrow();
    expect(() => parseArgs(['--instances', [...instances, 'synthetic-extra'].join(','), ...userArgs])).toThrow(
      'room has 9 invitees; Slack permits at most 8, excluding the caller',
    );
  });
});
