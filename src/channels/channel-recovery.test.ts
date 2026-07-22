import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[],
  groups: [] as unknown[],
  sessions: [] as unknown[],
}));

vi.mock('./channel-registry.js', () => ({ getActiveAdapters: () => mocks.adapters }));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupsByChannel: (channelType: string) =>
    mocks.groups.filter((group) => (group as { channel_type: string }).channel_type === channelType),
}));
vi.mock('../db/sessions.js', () => ({ getActiveSessions: () => mocks.sessions }));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getChannelRecoveryTargets,
  recoverAllChannelsAfterStall,
  recoverAllChannelsAfterStartup,
  recoverChannelAdapter,
  StartupChannelIngressGate,
} from './channel-recovery.js';
import type { ChannelAdapter } from './adapter.js';

function adapter(
  channelType: string,
  recover = vi.fn().mockResolvedValue({
    scannedTargets: 1,
    recoveredMessages: 0,
    failedTargets: 0,
  }),
): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    supportsThreads: true,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(),
    recoverMissedMessages: recover,
  } as unknown as ChannelAdapter;
}

beforeEach(() => {
  mocks.adapters = [];
  mocks.groups = [];
  mocks.sessions = [];
});

describe('channel recovery coordinator', () => {
  it('builds roots plus active threads and keeps adapter instances isolated', () => {
    mocks.groups = [
      { id: 'mg-1', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
      { id: 'mg-2', channel_type: 'discord', instance: 'discord-codex', platform_id: 'discord:g:c', is_group: 1 },
    ];
    mocks.sessions = [
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:t1' },
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:t1' },
      { messaging_group_id: 'mg-2', thread_id: 'discord:g:c:t2' },
    ];

    expect(getChannelRecoveryTargets(adapter('discord'))).toEqual([
      { platformId: 'discord:g:c', threadId: null, isDM: false },
      { platformId: 'discord:g:c', threadId: 'discord:g:c:t1', isDM: false },
    ]);
  });

  it('invokes the same recovery contract for every active channel type after a host stall', async () => {
    const discordRecover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
    const slackRecover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
    mocks.adapters = [adapter('discord', discordRecover), adapter('slack', slackRecover)];
    mocks.groups = [
      { id: 'mg-d', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
      { id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 },
    ];

    recoverAllChannelsAfterStall(Date.parse('2026-07-21T18:16:00Z'));
    await vi.waitFor(() => {
      expect(discordRecover).toHaveBeenCalledOnce();
      expect(slackRecover).toHaveBeenCalledOnce();
    });
    expect(discordRecover.mock.calls[0][0]).toMatchObject({ reason: 'event-loop-stall' });
    expect(slackRecover.mock.calls[0][0]).toMatchObject({ reason: 'event-loop-stall' });
  });

  it('initiates catch-up for webhook adapters after host startup too', async () => {
    const slackRecover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
    mocks.adapters = [adapter('slack', slackRecover)];
    mocks.groups = [{ id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 }];

    await recoverAllChannelsAfterStartup(Date.parse('2026-07-21T18:16:00Z'));
    expect(slackRecover).toHaveBeenCalledOnce();
    expect(slackRecover.mock.calls[0][0]).toMatchObject({ reason: 'host-startup' });
  });

  it('holds live startup ingress in order while allowing recovery events to route immediately', async () => {
    const gate = new StartupChannelIngressGate();
    const order: string[] = [];

    gate.run(false, async () => {
      order.push('live-1');
    });
    await gate.run(true, async () => {
      order.push('recovery');
    });
    gate.run(false, async () => {
      order.push('live-2');
    });

    expect(order).toEqual(['recovery']);
    await gate.open();
    expect(order).toEqual(['recovery', 'live-1', 'live-2']);
  });

  it('queues a follow-up pass when another recovery trigger arrives in flight', async () => {
    const releases: Array<() => void> = [];
    const recover = vi.fn(
      () =>
        new Promise<{ scannedTargets: number; recoveredMessages: number; failedTargets: number }>((resolve) => {
          releases.push(() => resolve({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 0 }));
        }),
    );
    const live = adapter('discord', recover);
    mocks.groups = [
      { id: 'mg-d', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
    ];
    const first = recoverChannelAdapter(live, { since: '2026-07-21T18:16:00Z', reason: 'transport-ready' });
    const second = recoverChannelAdapter(live, { since: '2026-07-21T18:16:01Z', reason: 'transport-resumed' });
    expect(recover).toHaveBeenCalledOnce();
    releases[0]();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    releases[1]();
    await Promise.all([first, second]);
  });

  it('retries an incomplete pass without waiting for another platform event', async () => {
    vi.useFakeTimers();
    try {
      const recover = vi
        .fn()
        .mockResolvedValueOnce({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 })
        .mockResolvedValueOnce({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
      const live = adapter('slack', recover);
      mocks.groups = [{ id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 }];

      await recoverChannelAdapter(live, { since: '2026-07-21T18:16:00Z', reason: 'host-startup' });
      expect(recover).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a newer reconnect cancel an older scheduled recovery window', async () => {
    vi.useFakeTimers();
    try {
      const recover = vi
        .fn()
        .mockResolvedValueOnce({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 })
        .mockResolvedValueOnce({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
      const live = adapter('slack', recover);
      mocks.groups = [{ id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 }];

      await recoverChannelAdapter(live, { since: '2026-07-21T18:10:00Z', reason: 'host-startup' });
      await recoverChannelAdapter(live, { since: '2026-07-21T18:20:00Z', reason: 'transport-resumed' });

      expect(recover).toHaveBeenCalledTimes(2);
      expect(recover.mock.calls[1][0]).toMatchObject({ since: '2026-07-21T18:10:00.000Z' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
