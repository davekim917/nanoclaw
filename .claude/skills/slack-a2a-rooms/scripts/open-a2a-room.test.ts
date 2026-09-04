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

import { channelTypeForInstance, normalizeInstance, tokenEnvKey } from './open-a2a-room.js';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  readEnvFileMatching: () => env.values,
  readEnvFile: () => env.values,
}));

/** Load the real Slack adapter against a fake env; module-level registration
 *  means each arm needs a fresh graph. */
async function workspacesFor(values: Record<string, string>) {
  vi.resetModules();
  env.values = values;
  const slack = await import('../src/channels/slack.js');
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
