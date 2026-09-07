/**
 * Pins the registry seam used by a provisioner to bring a newly registered
 * channel identity online without restarting the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

function createFakeAdapter(channelType: string, instance?: string): ChannelAdapter & { setupConfigs: ChannelSetup[] } {
  const setupConfigs: ChannelSetup[] = [];
  return {
    name: instance ?? channelType,
    channelType,
    instance,
    supportsThreads: false,
    setupConfigs,
    async setup(config: ChannelSetup) {
      setupConfigs.push(config);
    },
    async teardown() {},
    isConnected() {
      return setupConfigs.length > 0;
    },
    async deliver() {
      return undefined;
    },
  };
}

function createSetupFn() {
  const byAdapter = new Map<ChannelAdapter, ChannelSetup>();
  const setupFn = (adapter: ChannelAdapter): ChannelSetup => {
    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    byAdapter.set(adapter, setup);
    return setup;
  };
  return { setupFn, byAdapter };
}

describe('startChannelAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.resetModules();
  });

  it('requires host initialization before starting a newly registered adapter', async () => {
    const registry = await import('./channel-registry.js');
    registry.registerChannelAdapter('slack-hot', { factory: () => createFakeAdapter('slack', 'slack-hot') });

    await expect(registry.startChannelAdapter('slack-hot')).rejects.toThrow(
      'startChannelAdapter: initChannelAdapters has not run',
    );
  });

  it('rejects a requested adapter that has not been registered', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);

    await expect(registry.startChannelAdapter('slack-missing')).rejects.toThrow(
      "startChannelAdapter: no registration for 'slack-missing'",
    );
  });

  it('starts a post-init registration with the host setup callback', async () => {
    const registry = await import('./channel-registry.js');
    const { setupFn, byAdapter } = createSetupFn();
    await registry.initChannelAdapters(setupFn);

    const adapter = createFakeAdapter('slack', 'slack-hot');
    registry.registerChannelAdapter('slack-hot', { factory: () => adapter });

    await expect(registry.startChannelAdapter('slack-hot')).resolves.toBe('started');
    expect(registry.getChannelAdapterExact('slack-hot')).toBe(adapter);
    expect(adapter.setupConfigs).toEqual([byAdapter.get(adapter)]);
  });

  it('deduplicates concurrent and repeated requests for the same active identity', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);
    const adapter = createFakeAdapter('slack', 'slack-hot');
    registry.registerChannelAdapter('slack-hot', { factory: () => adapter });

    await expect(
      Promise.all([registry.startChannelAdapter('slack-hot'), registry.startChannelAdapter('slack-hot')]),
    ).resolves.toEqual(['started', 'started']);
    await expect(registry.startChannelAdapter('slack-hot')).resolves.toBe('already-active');
    expect(adapter.setupConfigs).toHaveLength(1);
  });

  it('serializes aliases after a failed start and lets only one retry the adapter identity', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);

    const first = createFakeAdapter('slack', 'slack-hot');
    let setupStarted!: () => void;
    const waitingForSetup = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    let releaseSetup!: () => void;
    const holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let firstTeardowns = 0;
    first.setup = async (config) => {
      first.setupConfigs.push(config);
      setupStarted();
      await holdSetup;
      throw new Error('first attempt failed');
    };
    first.teardown = async () => {
      firstTeardowns += 1;
    };
    const second = createFakeAdapter('slack', 'slack-hot');
    const third = createFakeAdapter('slack', 'slack-hot');
    registry.registerChannelAdapter('slack-first', { factory: () => first });
    registry.registerChannelAdapter('slack-second', { factory: () => second });
    registry.registerChannelAdapter('slack-third', { factory: () => third });

    const firstStart = registry.startChannelAdapter('slack-first');
    await waitingForSetup;
    const secondStart = registry.startChannelAdapter('slack-second');
    const thirdStart = registry.startChannelAdapter('slack-third');
    releaseSetup();

    const results = await Promise.allSettled([firstStart, secondStart, thirdStart]);
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('first attempt failed') }),
    });
    expect(results.slice(1)).toEqual([
      { status: 'fulfilled', value: 'started' },
      { status: 'fulfilled', value: 'already-active' },
    ]);
    expect(firstTeardowns).toBe(1);
    expect(second.setupConfigs).toHaveLength(1);
    expect(third.setupConfigs).toHaveLength(0);
  });

  it('waits for an admitted hot start before tearing down active adapters', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);

    const adapter = createFakeAdapter('slack', 'slack-hot');
    let setupStarted!: () => void;
    const waitingForSetup = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    let releaseSetup!: () => void;
    const holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let teardowns = 0;
    adapter.setup = async (config) => {
      adapter.setupConfigs.push(config);
      setupStarted();
      await holdSetup;
    };
    adapter.teardown = async () => {
      teardowns += 1;
    };
    registry.registerChannelAdapter('slack-hot', { factory: () => adapter });

    const start = registry.startChannelAdapter('slack-hot');
    await waitingForSetup;
    const teardown = registry.teardownChannelAdapters();
    expect(teardowns).toBe(0);
    releaseSetup();

    await expect(start).resolves.toBe('started');
    await teardown;
    expect(teardowns).toBe(1);
    expect(registry.getChannelAdapterExact('slack-hot')).toBeUndefined();
  });

  it('reports missing credentials without creating an active adapter', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);
    registry.registerChannelAdapter('slack-no-credentials', { factory: () => null });

    await expect(registry.startChannelAdapter('slack-no-credentials')).resolves.toBe('no-credentials');
    expect(registry.getChannelAdapterExact('slack-no-credentials')).toBeUndefined();
  });

  it('retries a network setup error and starts once the retry succeeds', async () => {
    vi.useFakeTimers();
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);

    const base = createFakeAdapter('slack', 'slack-flaky');
    let attempts = 0;
    const adapter: typeof base = {
      ...base,
      async setup(config: ChannelSetup) {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('transport interrupted');
          err.name = 'NetworkError';
          throw err;
        }
        base.setupConfigs.push(config);
      },
    };
    registry.registerChannelAdapter('slack-flaky', { factory: () => adapter });

    const pending = registry.startChannelAdapter('slack-flaky');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('started');
    expect(attempts).toBe(2);
    expect(registry.getChannelAdapterExact('slack-flaky')).toBe(adapter);
  });

  it('leaves a failed start retryable', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(createSetupFn().setupFn);

    const adapter = createFakeAdapter('slack', 'slack-retryable');
    let failures = 1;
    let teardownCalls = 0;
    adapter.setup = async (config) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('invalid setup');
      }
      adapter.setupConfigs.push(config);
    };
    adapter.teardown = async () => {
      teardownCalls += 1;
    };
    registry.registerChannelAdapter('slack-retryable', { factory: () => adapter });

    await expect(registry.startChannelAdapter('slack-retryable')).rejects.toThrow(
      'invalid setup. Restart fallback: bash setup/lib/restart.sh',
    );
    expect(registry.getChannelAdapterExact('slack-retryable')).toBeUndefined();
    expect(teardownCalls).toBe(1);
    await expect(registry.startChannelAdapter('slack-retryable')).resolves.toBe('started');
    expect(adapter.setupConfigs).toHaveLength(1);
  });
});
