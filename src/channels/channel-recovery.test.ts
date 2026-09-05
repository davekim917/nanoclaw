import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[],
  groups: [] as unknown[],
  sessions: [] as unknown[],
}));

vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  getActiveAdapters: () => mocks.adapters,
}));
vi.mock('../db/messaging-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/messaging-groups.js')>()),
  getMessagingGroupsByChannel: (channelType: string) =>
    mocks.groups.filter((group) => (group as { channel_type: string }).channel_type === channelType),
}));
vi.mock('../db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/sessions.js')>()),
  getActiveSessions: () => mocks.sessions,
}));
// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  getChannelRecoveryTargets,
  recoverAllChannelsAfterStall,
  recoverAllChannelsAfterStartup,
  recoverChannelAdapter,
  STALL_RECOVERY_COOLDOWN_MS,
  STALL_TARGET_ACTIVITY_HORIZON_MS,
  _resetStallRecoveryCooldownForTesting,
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
  _resetStallRecoveryCooldownForTesting();
});

describe('channel recovery coordinator', () => {
  it('builds roots plus active threads and keeps adapter instances isolated', async () => {
    mocks.groups = [
      { id: 'mg-1', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
      { id: 'mg-2', channel_type: 'discord', instance: 'discord-codex', platform_id: 'discord:g:c', is_group: 1 },
    ];
    mocks.sessions = [
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:t1' },
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:t1' },
      { messaging_group_id: 'mg-2', thread_id: 'discord:g:c:t2' },
    ];

    expect(await getChannelRecoveryTargets(adapter('discord'))).toEqual([
      { platformId: 'discord:g:c', threadId: null, isDM: false },
      { platformId: 'discord:g:c', threadId: 'discord:g:c:t1', isDM: false },
    ]);
  });

  it('supplies roots only when the adapter discovers changed threads itself', async () => {
    mocks.groups = [{ id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 }];
    mocks.sessions = [{ messaging_group_id: 'mg-s', thread_id: 'slack:C1:old-thread' }];
    const slack = adapter('slack');
    slack.recoveryDiscoversThreads = true;

    expect(await getChannelRecoveryTargets(slack)).toEqual([{ platformId: 'slack:C1', threadId: null, isDM: false }]);
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

  it('bounds stall-pass thread expansion to recently-active sessions, fail-open on missing timestamps', async () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - STALL_TARGET_ACTIVITY_HORIZON_MS - 60_000).toISOString();
    mocks.groups = [
      { id: 'mg-1', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
    ];
    mocks.sessions = [
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:fresh', last_active: fresh },
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:stale', last_active: stale },
      { messaging_group_id: 'mg-1', thread_id: 'discord:g:c:untimed', last_active: null },
    ];

    const bounded = getChannelRecoveryTargets(adapter('discord'), {
      activeSinceMs: now - STALL_TARGET_ACTIVITY_HORIZON_MS,
    });
    expect((await bounded).map((t) => t.threadId)).toEqual([null, 'discord:g:c:fresh', 'discord:g:c:untimed']);

    // Unbounded (transport/startup) passes keep the stale thread.
    const full = getChannelRecoveryTargets(adapter('discord'));
    expect((await full).map((t) => t.threadId)).toContain('discord:g:c:stale');
  });

  it('coalesces stalls inside the cooldown into one deferred pass with the earliest since', async () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 0 });
      mocks.adapters = [adapter('discord', recover)];
      mocks.groups = [
        { id: 'mg-d', channel_type: 'discord', instance: 'discord', platform_id: 'discord:g:c', is_group: 1 },
      ];

      const t0 = Date.now();
      recoverAllChannelsAfterStall(t0 - 10_000);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());

      // Two more stalls inside the cooldown: neither fires a pass now.
      recoverAllChannelsAfterStall(t0 + 20_000);
      recoverAllChannelsAfterStall(t0 + 5_000);
      expect(recover).toHaveBeenCalledOnce();

      // Cooldown expiry fires ONE deferred pass carrying the earliest since.
      await vi.advanceTimersByTimeAsync(STALL_RECOVERY_COOLDOWN_MS);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
      expect(recover.mock.calls[1][0]).toMatchObject({
        reason: 'event-loop-stall',
        since: new Date(t0 + 5_000).toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('initiates catch-up for webhook adapters after host startup too', async () => {
    const slackRecover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
    mocks.adapters = [adapter('slack', slackRecover)];
    mocks.groups = [{ id: 'mg-s', channel_type: 'slack', instance: 'slack', platform_id: 'slack:C1', is_group: 1 }];

    await recoverAllChannelsAfterStartup(Date.parse('2026-07-21T18:16:00Z'));
    expect(slackRecover).toHaveBeenCalledOnce();
    expect(slackRecover.mock.calls[0][0]).toMatchObject({ reason: 'host-startup' });
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
    // The target read is async now (seam 3), so the first pass starts a
    // microtask later than the call.
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
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

  it('backs off an incomplete pass instead of immediately draining a queued trigger', async () => {
    vi.useFakeTimers();
    try {
      let finishFirst!: (result: { scannedTargets: number; recoveredMessages: number; failedTargets: number }) => void;
      const recover = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ scannedTargets: number; recoveredMessages: number; failedTargets: number }>((resolve) => {
              finishFirst = resolve;
            }),
        )
        .mockResolvedValue({ scannedTargets: 1, recoveredMessages: 1, failedTargets: 0 });
      const live = adapter('slack', recover);

      const first = recoverChannelAdapter(live, {
        since: '2026-07-21T18:16:00Z',
        reason: 'host-startup',
      });
      void recoverChannelAdapter(live, {
        since: '2026-07-21T18:16:01Z',
        reason: 'event-loop-stall',
      });
      // Let the first pass reach `recover` (its target read is async now).
      await vi.advanceTimersByTimeAsync(0);
      finishFirst({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 });
      await first;

      expect(recover).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(recover).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
      expect(recover.mock.calls[1][0]).toMatchObject({
        since: '2026-07-21T18:16:00.000Z',
      });
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

describe('recovery retry circuit-breaker', () => {
  it('parks after repeated failures; stall triggers stay parked, transport triggers resume', async () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn().mockResolvedValue({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 });
      const live = adapter('slack-park', recover);

      await recoverChannelAdapter(live, { since: '2026-07-21T18:16:00Z', reason: 'host-startup' });
      expect(recover).toHaveBeenCalledOnce();
      // Drive the retry ladder: attempts 1..8 run, the 9th schedule parks.
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(130_000);
      }
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(9));
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(recover).toHaveBeenCalledTimes(9);

      // Parked: a stall-triggered recovery is a no-op — the storm cannot un-park itself.
      await recoverChannelAdapter(live, { since: '2026-07-21T19:00:00Z', reason: 'event-loop-stall' });
      expect(recover).toHaveBeenCalledTimes(9);

      // A transport-level trigger clears the breaker and runs with ITS window —
      // the durable gap floor re-applies the old window inside the bridge.
      await recoverChannelAdapter(live, { since: '2026-07-21T19:30:00Z', reason: 'transport-ready' });
      expect(recover).toHaveBeenCalledTimes(10);
      expect(recover.mock.calls[9][0]).toMatchObject({ since: '2026-07-21T19:30:00Z' });
    } finally {
      vi.useRealTimers();
    }
  });
});
