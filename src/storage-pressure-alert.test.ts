import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  roleRows: [{ user_id: 'discord:owner-1' }],
  deliver: vi.fn().mockResolvedValue(undefined),
  ensureUserDm: vi.fn(),
  getDeliveryAdapter: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => mocks.roleRows }) }),
}));
vi.mock('./modules/permissions/user-dm.js', () => ({
  ensureUserDm: (...args: unknown[]) => mocks.ensureUserDm(...args),
}));
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => mocks.getDeliveryAdapter(),
}));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: (...args: unknown[]) => mocks.warn(...args), error: vi.fn(), debug: vi.fn() },
  setLogScrubber: vi.fn(),
}));

import { _resetStoragePressureAlertForTesting, handleStoragePressureAlert } from './storage-pressure-alert.js';
import type { StorageReport } from './storage-manager.js';

function report(usagePct: number): StorageReport {
  const sizeBytes = 1_000_000;
  const usedBytes = Math.round((usagePct / 100) * sizeBytes);
  return {
    timestamp: '2026-07-19T00:00:00.000Z',
    mode: 'apply',
    policy: {
      enabled: true,
      filesystemPath: '/',
      cleanupThresholdPct: 85,
      admissionRefusePct: 90,
      idleArtifactMs: 1,
      worktreeReclaimMs: 1,
      sessionReclaimMs: 1,
      sessionReclaimPerTick: 50,
      sessionReclaimMaxMs: 120_000,
      sessionActiveCap: 0,
      regenerableSweepMs: 172_800_000,
      rescueRetentionMs: 2_592_000_000,
      scanCadenceMs: 1,
      dockerPruneCadenceMs: 21_600_000,
      dockerBuildCacheUnusedFor: '168h',
      cleanupTargetPct: 82,
      emergencyRetryMs: 60_000,
      candidateRetentionHours: 168,
      legacyImageGraceHours: 168,
    },
    filesystem: {
      before: { path: '/', sizeBytes, usedBytes, availableBytes: sizeBytes - usedBytes, usagePct },
      after: { path: '/', sizeBytes, usedBytes, availableBytes: sizeBytes - usedBytes, usagePct },
      actualReclaimedBytes: 12_345,
    },
    estimatedReclaimableBytes: 0,
    pressure: {
      level: usagePct >= 90 ? 'critical' : 'normal',
      cleanupTargetPct: 82,
      targetReached: usagePct <= 82,
      nextEmergencyRetryAt: '2026-07-19T00:01:00.000Z',
    },
    images: {
      dispositions: [
        {
          id: 'sha256:protected',
          repoTags: ['nanoclaw:stale-candidate'],
          createdAt: '2026-07-18T00:00:00.000Z',
          sizeBytes: 900_000,
          labels: {},
          disposition: 'protected',
          protectionReason: 'retention-lease',
          owner: 'stale-candidate',
          leaseExpiresAt: '2026-07-25T00:00:00.000Z',
        },
      ],
      protectedCount: 1,
      protectedBytes: 900_000,
      eligibleCount: 0,
      eligibleBytes: 0,
    },
    actions: [],
    pools: {
      'session-cache': { actions: 0, estimatedBytes: 0 },
      'thread-cache': { actions: 0, estimatedBytes: 0 },
      'topic-cache': { actions: 0, estimatedBytes: 0 },
      docker: { actions: 0, estimatedBytes: 0 },
    },
    skipped: {
      liveSessions: 0,
      liveThreads: 0,
      busySessions: 0,
      freshSessions: 0,
      freshThreads: 0,
      liveTopics: 0,
      freshTopics: 0,
      unreadableSessions: 0,
      noActivitySessions: 0,
      budgetDeferredSessions: 0,
    },
    warnings: [],
  };
}

describe('storage pressure administrator alerts', () => {
  const now = Date.parse('2026-07-19T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStoragePressureAlertForTesting();
    mocks.getDeliveryAdapter.mockReturnValue({ deliver: mocks.deliver });
    mocks.ensureUserDm.mockResolvedValue({ channel_type: 'discord', platform_id: 'dm-owner-1' });
  });

  it('sends one alert per pressure episode and repeats no sooner than six hours', async () => {
    await handleStoragePressureAlert(report(93), now);
    await handleStoragePressureAlert(report(93), now + 60_000);
    await handleStoragePressureAlert(report(93), now + 6 * 60 * 60 * 1000);

    expect(mocks.deliver).toHaveBeenCalledTimes(2);
    expect(mocks.deliver.mock.calls[0]?.[4]).toContain('Storage pressure remains critical');
    expect(mocks.deliver.mock.calls[0]?.[4]).toContain('stale-candidate');
  });

  it('resets deduplication after recovery below 90 percent', async () => {
    await handleStoragePressureAlert(report(93), now);
    await handleStoragePressureAlert(report(89), now + 60_000);
    await handleStoragePressureAlert(report(93), now + 120_000);

    expect(mocks.deliver).toHaveBeenCalledTimes(2);
  });

  it('alerts through exactly ONE bot even when the owner has identities on every platform', async () => {
    mocks.roleRows = [{ user_id: 'slack-a:owner' }, { user_id: 'slack-b:owner' }, { user_id: 'discord:owner' }];
    try {
      await handleStoragePressureAlert(report(93), now);
      expect(mocks.deliver).toHaveBeenCalledTimes(1);
      expect(mocks.ensureUserDm).toHaveBeenCalledTimes(1);
    } finally {
      mocks.roleRows = [{ user_id: 'discord:owner-1' }];
    }
  });

  it('fails over to the next identity only when the first is unreachable', async () => {
    mocks.roleRows = [{ user_id: 'slack-a:owner' }, { user_id: 'discord:owner' }];
    mocks.ensureUserDm.mockResolvedValueOnce(null).mockResolvedValueOnce({
      channel_type: 'discord',
      platform_id: 'dm-owner-1',
    });
    try {
      await handleStoragePressureAlert(report(93), now);
      expect(mocks.deliver).toHaveBeenCalledTimes(1);
      expect(mocks.ensureUserDm).toHaveBeenCalledTimes(2);
    } finally {
      mocks.roleRows = [{ user_id: 'discord:owner-1' }];
    }
  });

  it('fails safely when adapters or administrators are unreachable', async () => {
    mocks.getDeliveryAdapter.mockReturnValue(null);
    await expect(handleStoragePressureAlert(report(93), now)).resolves.toBeUndefined();

    _resetStoragePressureAlertForTesting();
    mocks.getDeliveryAdapter.mockReturnValue({ deliver: mocks.deliver });
    mocks.ensureUserDm.mockResolvedValue(null);
    await expect(handleStoragePressureAlert(report(93), now)).resolves.toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });
});
