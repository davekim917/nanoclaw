/**
 * Socket Mode selection.
 *
 * The integration point is the adapter CONSTRUCTION, not the parser: an
 * app-level token has to reach `createSlackAdapter` as `mode: 'socket'`, and a
 * Socket Mode workspace (bot token + app token, no signing secret) must no
 * longer be skipped as credential-less. These tests drive the real
 * `readEnvFileMatching` seam with a fake env, import slack.ts so it
 * self-registers, and run the host's own `initChannelAdapters`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
const adapterCalls = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));

vi.mock('../env.js', () => ({
  readEnvFileMatching: () => env.values,
  readEnvFile: () => env.values,
}));

vi.mock('@chat-adapter/slack', () => ({
  createSlackAdapter: vi.fn((config: Record<string, unknown>) => {
    adapterCalls.configs.push(config);
    return { name: 'slack' };
  }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { test: async () => ({ ok: true, user_id: 'UBOT', user: 'nano', team_id: 'T1' }) };
    users = { list: async () => ({ members: [] }), info: async () => ({ ok: false }) };
    conversations = { info: async () => ({ ok: false }) };
  },
}));

// The bridge is not under test here and would stand up a real Chat instance.
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: (config: { channelType?: string }) => ({
    name: config.channelType ?? 'slack',
    channelType: config.channelType ?? 'slack',
    supportsThreads: true,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  }),
}));

async function bootWith(values: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  vi.resetModules();
  env.values = values;
  adapterCalls.configs = [];
  await import('./slack.js');
  const registry = await import('./channel-registry.js');
  await registry.initChannelAdapters(
    () =>
      ({
        onInbound: async () => {},
        onInboundEvent: async () => {},
        onMetadata: () => {},
        onAction: () => {},
      }) as never,
  );
  return adapterCalls.configs;
}

afterEach(() => {
  vi.resetModules();
});

describe('parseSlackWorkspaces — each mode needs only its own second credential', () => {
  it('keeps a Socket Mode workspace that has no signing secret', async () => {
    const { parseSlackWorkspaces } = await import('./slack.js');
    expect(parseSlackWorkspaces({ SLACK_BOT_TOKEN: 'xoxb-p', SLACK_APP_TOKEN: 'xapp-p' })).toEqual([
      { channelType: 'slack', botToken: 'xoxb-p', appToken: 'xapp-p' },
    ]);
  });

  it('still drops a workspace with a bot token and nothing else', async () => {
    const { parseSlackWorkspaces } = await import('./slack.js');
    expect(parseSlackWorkspaces({ SLACK_BOT_TOKEN: 'xoxb-p' })).toEqual([]);
  });

  it('reads the app token per suffixed instance, underscores and all', async () => {
    const { parseSlackWorkspaces } = await import('./slack.js');
    expect(
      parseSlackWorkspaces({
        SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs',
        SLACK_APP_TOKEN_EXAMPLE_LABS: 'xapp-labs',
      }),
    ).toEqual([{ channelType: 'slack-example-labs', botToken: 'xoxb-labs', appToken: 'xapp-labs' }]);
  });

  it('carries both credentials when both are configured', async () => {
    const { parseSlackWorkspaces } = await import('./slack.js');
    expect(
      parseSlackWorkspaces({ SLACK_BOT_TOKEN: 'xoxb-p', SLACK_SIGNING_SECRET: 'sig', SLACK_APP_TOKEN: 'xapp-p' }),
    ).toEqual([{ channelType: 'slack', botToken: 'xoxb-p', signingSecret: 'sig', appToken: 'xapp-p' }]);
  });
});

describe('the app token selects Socket Mode at adapter construction', () => {
  it('builds a socket adapter for a Socket Mode workspace', async () => {
    const configs = await bootWith({ SLACK_BOT_TOKEN: 'xoxb-p', SLACK_APP_TOKEN: 'xapp-p' });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ botToken: 'xoxb-p', appToken: 'xapp-p', mode: 'socket' });
  });

  it('leaves an existing webhook instance on webhook, with no app token', async () => {
    const configs = await bootWith({ SLACK_BOT_TOKEN: 'xoxb-p', SLACK_SIGNING_SECRET: 'sig' });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ botToken: 'xoxb-p', signingSecret: 'sig', mode: 'webhook' });
    expect(configs[0].appToken).toBeUndefined();
  });

  it('picks the mode per instance, so one workspace can socket while another webhooks', async () => {
    const configs = await bootWith({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig',
      SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs',
      SLACK_APP_TOKEN_EXAMPLE_LABS: 'xapp-labs',
    });
    expect(configs.map((c) => c.mode).sort()).toEqual(['socket', 'webhook']);
    expect(configs.find((c) => c.botToken === 'xoxb-labs')).toMatchObject({ mode: 'socket' });
    expect(configs.find((c) => c.botToken === 'xoxb-p')).toMatchObject({ mode: 'webhook' });
  });

  it('prefers Socket Mode when both credentials are present', async () => {
    const configs = await bootWith({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig',
      SLACK_APP_TOKEN: 'xapp-p',
    });
    expect(configs[0]).toMatchObject({ mode: 'socket', signingSecret: 'sig', appToken: 'xapp-p' });
  });
});
