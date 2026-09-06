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

import type { ChannelSetup } from './adapter.js';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
const adapterCalls = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));
const bridgeLifecycle = vi.hoisted(() => ({
  failedSetups: 0,
  setups: 0,
  teardowns: 0,
  setupHook: undefined as (() => void | Promise<void>) | undefined,
}));
const webApiCalls = vi.hoisted(() => ({ auth: 0, usersList: 0, usersInfo: 0 }));

vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
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
    auth = {
      test: async () => {
        webApiCalls.auth += 1;
        return { ok: true, user_id: 'UBOT', user: 'nano', team_id: 'T1' };
      },
    };
    users = {
      list: async () => {
        webApiCalls.usersList += 1;
        return { members: [] };
      },
      info: async () => {
        webApiCalls.usersInfo += 1;
        return { ok: false };
      },
    };
    conversations = { info: async () => ({ ok: false }) };
  },
}));

// The bridge is not under test here and would stand up a real Chat instance.
vi.mock('./chat-sdk-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chat-sdk-bridge.js')>()),
  createChatSdkBridge: (config: { channelType?: string }) => ({
    name: config.channelType ?? 'slack',
    channelType: config.channelType ?? 'slack',
    supportsThreads: true,
    setup: async () => {
      bridgeLifecycle.setups += 1;
      await bridgeLifecycle.setupHook?.();
      if (bridgeLifecycle.failedSetups > 0) {
        bridgeLifecycle.failedSetups -= 1;
        throw new Error('bridge setup failed');
      }
    },
    teardown: async () => {
      bridgeLifecycle.teardowns += 1;
    },
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
  vi.restoreAllMocks();
  vi.resetModules();
  bridgeLifecycle.failedSetups = 0;
  bridgeLifecycle.setups = 0;
  bridgeLifecycle.teardowns = 0;
  bridgeLifecycle.setupHook = undefined;
  webApiCalls.auth = 0;
  webApiCalls.usersList = 0;
  webApiCalls.usersInfo = 0;
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

describe('one env load, so no second reader can miss a mode', () => {
  /**
   * backlog-canvas had its own copy of the env regex; the copy predated
   * APP_TOKEN, so a Socket Mode workspace looked credential-less to it while
   * working fine for the adapter. Both now go through loadSlackWorkspaces.
   */
  it('exposes a Socket Mode workspace to every caller of loadSlackWorkspaces', async () => {
    vi.resetModules();
    env.values = { SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs', SLACK_APP_TOKEN_EXAMPLE_LABS: 'xapp-labs' };
    const { loadSlackWorkspaces } = await import('./slack.js');
    expect(loadSlackWorkspaces()).toEqual([
      { channelType: 'slack-example-labs', botToken: 'xoxb-labs', appToken: 'xapp-labs' },
    ]);
  });

  it('is the only place the Slack env pattern is written down', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (full.endsWith('channels/slack.ts')) continue;
          if (/SLACK_\(BOT_TOKEN\|SIGNING_SECRET/.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
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

describe('registerSlackWorkspace hot start', () => {
  it('registers and starts a newly provisioned workspace through the normal Slack factory', async () => {
    vi.resetModules();
    env.values = {};
    adapterCalls.configs = [];

    const slack = await import('./slack.js');
    const registry = await import('./channel-registry.js');
    const setup: ChannelSetup = {
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: async () => {},
      onAction: () => {},
    };
    await registry.initChannelAdapters(() => setup);

    slack.registerSlackWorkspace({
      channelType: 'slack-hot',
      botToken: 'xoxb-hot',
      appToken: 'xapp-hot',
    });

    await expect(registry.startChannelAdapter('slack-hot')).resolves.toBe('started');
    expect(registry.getChannelAdapterExact('slack-hot')).toBeDefined();
    expect(adapterCalls.configs).toEqual([
      expect.objectContaining({ botToken: 'xoxb-hot', appToken: 'xapp-hot', mode: 'socket' }),
    ]);
    const { getKnownSlackBots } = await import('./slack-mentions.js');
    expect(getKnownSlackBots().get('slack-hot')).toMatchObject({ userId: 'UBOT', teamId: 'T1' });

    await registry.teardownChannelAdapters();
  });

  it('publishes identity during bridge setup, rolls it back on failure, and starts the refresh after retry', async () => {
    vi.resetModules();
    env.values = {};
    adapterCalls.configs = [];
    bridgeLifecycle.failedSetups = 1;
    webApiCalls.auth = 0;
    webApiCalls.usersList = 0;
    webApiCalls.usersInfo = 0;
    const interval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

    let bridgeSetupEntered!: () => void;
    const bridgeSetupPending = new Promise<void>((resolve) => {
      bridgeSetupEntered = resolve;
    });
    let releaseBridgeSetup!: () => void;
    const holdBridgeSetup = new Promise<void>((resolve) => {
      releaseBridgeSetup = resolve;
    });
    bridgeLifecycle.setupHook = async () => {
      bridgeSetupEntered();
      await holdBridgeSetup;
    };

    const slack = await import('./slack.js');
    const registry = await import('./channel-registry.js');
    const setup: ChannelSetup = {
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: async () => {},
      onAction: () => {},
    };
    await registry.initChannelAdapters(() => setup);
    slack.registerSlackWorkspace({ channelType: 'slack-hot', botToken: 'xoxb-hot', appToken: 'xapp-hot' });

    const { getKnownSlackBots } = await import('./slack-mentions.js');
    const failedStart = registry.startChannelAdapter('slack-hot');
    await bridgeSetupPending;
    expect(getKnownSlackBots().get('slack-hot')).toMatchObject({ userId: 'UBOT', teamId: 'T1' });
    expect(webApiCalls.usersList).toBe(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    releaseBridgeSetup();
    await expect(failedStart).rejects.toThrow('Restart fallback: bash setup/lib/restart.sh');
    expect(getKnownSlackBots().get('slack-hot')).toBeUndefined();
    expect(webApiCalls.usersList).toBe(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    bridgeLifecycle.setupHook = undefined;
    await expect(registry.startChannelAdapter('slack-hot')).resolves.toBe('started');
    expect(getKnownSlackBots().get('slack-hot')).toMatchObject({ userId: 'UBOT', teamId: 'T1' });
    expect(webApiCalls.usersList).toBe(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(interval.unref).toHaveBeenCalledOnce();

    await registry.teardownChannelAdapters();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
