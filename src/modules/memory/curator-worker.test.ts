import { describe, expect, it, vi } from 'vitest';

import type { MemoryCurationArchiveRow, MemoryCurationEpisode } from '../../message-archive.js';
import type { CuratorBackendResult } from './curator-backend.js';
import type { CuratorWriteResult } from './curator-write.js';
import { boundEpisodeMessages, isMemoryCuratorEnabled, MemoryCuratorWorker } from './curator-worker.js';
import type { MemoryCuratorWorkerDependencies } from './curator-worker.js';

const episode: MemoryCurationEpisode = {
  episodeKey: 'episode',
  workgroupId: 'wg-a',
  messagingGroupId: 'mg-a',
  threadId: 'thread-a',
  pendingRowid: 2,
  handledRowid: 0,
  claimedThroughRowid: 2,
  leaseOwner: 'worker',
  attemptCount: 0,
};

function message(rowid: number, id: string, text: string): MemoryCurationArchiveRow {
  return {
    rowid,
    id,
    agentGroupId: 'ag-a',
    messagingGroupId: 'mg-a',
    channelType: 'discord',
    channelName: 'ops',
    platformId: 'discord:g:c',
    threadId: 'thread-a',
    role: rowid % 2 ? 'user' : 'assistant',
    senderId: rowid % 2 ? 'discord:u' : 'ag-a',
    senderName: rowid % 2 ? 'Operator' : 'assistant',
    text,
    sentAt: `2026-07-26T00:00:0${rowid}.000Z`,
    rank: 'current-thread',
  };
}

function deps(overrides: Partial<MemoryCuratorWorkerDependencies> = {}): MemoryCuratorWorkerDependencies {
  return {
    admission: () => ({ allowed: true, hourly: 0, daily: 0, hourlyLimit: 120, dailyLimit: 3000 }),
    credentials: () => ['oauth:primary', 'oauth:2'],
    selectCredential: (slots) => ({
      slot: slots[0] ?? null,
      retryAt: null,
      unavailableSlots: [],
    }),
    markCredentialUnavailable: vi.fn(() => '2026-07-26T00:15:00.000Z'),
    markCredentialAvailable: vi.fn(),
    claim: () => episode,
    claimMaintenance: () => null,
    members: () => ['ag-a', 'ag-a-codex', 'ag-a-opencode'],
    messages: () => [message(1, 'msg-1', 'Remember GSC is in Snowflake.')],
    complete: vi.fn(() => true),
    fail: vi.fn(() => true),
    completeMaintenance: vi.fn(() => true),
    failMaintenance: vi.fn(() => true),
    recordCall: vi.fn(() => true),
    finishCall: vi.fn(),
    readGenerated: () => ({ content: '', sha256: null }),
    writeGenerated: vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'generated/memory.md',
        sha256: 'a'.repeat(64),
      }),
    ),
    recordAccepted: vi.fn(),
    manualMemory: () => [],
    curate: vi.fn(
      async (_system, _user, credentialSlot): Promise<CuratorBackendResult> => ({
        decision: { action: 'noop', evidenceIds: ['msg-1'], reasonCode: 'transient' },
        model: 'claude-sonnet-5',
        credentialSlot,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    ),
    maintain: vi.fn(async (_system, _user, credentialSlot) => ({
      decision: { action: 'noop' as const },
      model: 'claude-sonnet-5',
      credentialSlot,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    })),
    uuid: vi.fn(() => '00000000-0000-0000-0000-000000000001'),
    ...overrides,
  };
}

describe('memory curator worker', () => {
  it('defaults disabled and accepts explicit activation values only', () => {
    expect(isMemoryCuratorEnabled({})).toBe(false);
    expect(isMemoryCuratorEnabled({ NANOCLAW_MEMORY_CURATOR_ENABLED: 'true' })).toBe(true);
    expect(isMemoryCuratorEnabled({ NANOCLAW_MEMORY_CURATOR_ENABLED: '0' })).toBe(false);
  });

  it('completes validated noop without writing and records one model call', async () => {
    const d = deps();
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'noop', workgroupId: 'wg-a', messageCount: 1 });
    expect(d.writeGenerated).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({ claimedThroughRowid: 1 }), 1000);
    expect(d.fail).not.toHaveBeenCalled();
    expect(d.finishCall).toHaveBeenCalledWith(expect.any(String), 'noop');
  });

  it('writes a validated replacement before advancing the cursor', async () => {
    const content = [
      '# Generated workgroup memory',
      '',
      '- GSC data is in Snowflake. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:01.000Z -->',
      '',
    ].join('\n');
    const d = deps({
      curate: vi.fn(
        async (): Promise<CuratorBackendResult> => ({
          decision: {
            action: 'replace_generated_memory',
            evidenceIds: ['msg-1'],
            reasonCode: 'durable_fact',
            supersedesMemoryIds: [],
            content,
          },
          model: 'claude-sonnet-5',
          credentialSlot: 'oauth:2',
          usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report?.action).toBe('replace_generated_memory');
    expect(d.writeGenerated).toHaveBeenCalledBefore(d.complete as ReturnType<typeof vi.fn>);
    expect(d.recordAccepted).toHaveBeenCalledWith('wg-a', Buffer.byteLength(content), 1000);
    expect(d.finishCall).toHaveBeenCalledWith(expect.any(String), 'memory_written');
  });

  it('does not advance on provider, validation, or write conflict failures', async () => {
    const failureCases: Array<Partial<MemoryCuratorWorkerDependencies>> = [
      { curate: vi.fn(async () => Promise.reject(new Error('structured Claude call returned 429'))) },
      {
        curate: vi.fn(
          async (): Promise<CuratorBackendResult> => ({
            decision: { action: 'noop', evidenceIds: ['unknown'], reasonCode: 'transient' },
            model: 'claude-sonnet-5',
            credentialSlot: 'oauth:2',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      },
      {
        curate: vi.fn(
          async (): Promise<CuratorBackendResult> => ({
            decision: {
              action: 'replace_generated_memory',
              evidenceIds: ['msg-1'],
              reasonCode: 'durable_fact',
              supersedesMemoryIds: [],
              content:
                '# Generated workgroup memory\n\n- Fact. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:01.000Z -->\n',
            },
            model: 'claude-sonnet-5',
            credentialSlot: 'oauth:2',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
        writeGenerated: vi.fn(
          async (): Promise<CuratorWriteResult> => ({
            status: 'conflict' as const,
            relative_path: 'generated/memory.md',
            error: 'stale',
          }),
        ),
      },
    ];
    for (const overrides of failureCases) {
      const d = deps(overrides);
      expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
      expect(d.complete).not.toHaveBeenCalled();
      expect(d.fail).toHaveBeenCalledOnce();
    }
  });

  it('does not claim work when the durable admission budget is exhausted', async () => {
    const claim = vi.fn(() => episode);
    const d = deps({
      admission: () => ({ allowed: false, hourly: 120, daily: 120, hourlyLimit: 120, dailyLimit: 3000 }),
      claim,
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it('fails over immediately when one OAuth slot is out of usage', async () => {
    const curate = vi.fn(async (_system, _user, credentialSlot): Promise<CuratorBackendResult> => {
      if (credentialSlot === 'oauth:primary') {
        const error = new Error('structured Claude call returned 429') as Error & {
          status: number;
          retryAfterMs: number;
        };
        error.status = 429;
        error.retryAfterMs = 60_000;
        throw error;
      }
      return {
        decision: { action: 'noop', evidenceIds: ['msg-1'], reasonCode: 'transient' },
        model: 'claude-sonnet-5',
        credentialSlot,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      };
    });
    const d = deps({ curate });
    await expect(new MemoryCuratorWorker(d).runOne(1000)).resolves.toMatchObject({
      action: 'noop',
      credentialSlot: 'oauth:2',
    });
    expect(curate.mock.calls.map((call) => call[2])).toEqual(['oauth:primary', 'oauth:2']);
    expect(d.markCredentialUnavailable).toHaveBeenCalledWith('oauth:primary', 'quota', 1000, 60_000);
    expect(d.complete).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('retains the episode when both OAuth slots are unavailable', async () => {
    const curate = vi.fn(async (_system, _user, credentialSlot) => {
      const error = new Error(`structured Claude call returned 429 on ${credentialSlot}`) as Error & {
        status: number;
      };
      error.status = 429;
      throw error;
    });
    const d = deps({ curate });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(curate.mock.calls.map((call) => call[2])).toEqual(['oauth:primary', 'oauth:2']);
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.writeGenerated).not.toHaveBeenCalled();
    expect(d.fail).toHaveBeenCalledWith(episode, 'quota', 1000);
  });

  it('does not claim an episode while every credential is cooling down', async () => {
    const claim = vi.fn(() => episode);
    const d = deps({
      claim,
      selectCredential: () => ({
        slot: null,
        retryAt: '2026-07-26T00:15:00.000Z',
        unavailableSlots: ['oauth:primary', 'oauth:2'],
      }),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it('deduplicates sibling mirrors and advances only through the bounded raw slice', () => {
    const duplicate = { ...message(2, 'msg-2', 'same'), role: 'user', sentAt: '2026-07-26T00:00:01.000Z' };
    const result = boundEpisodeMessages([
      { ...message(1, 'msg-1', 'same'), role: 'user', sentAt: '2026-07-26T00:00:01.000Z' },
      duplicate,
      message(3, 'msg-3', 'different'),
    ]);
    expect(result.messages.map((item) => item.id)).toEqual(['msg-1', 'msg-3']);
    expect(result.handledThroughRowid).toBe(3);
  });

  it('prioritizes thresholded shadow-validated maintenance so it cannot starve behind episodes', async () => {
    const current = [
      '# Generated workgroup memory',
      '',
      '- Fact. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:00.000Z -->',
      '',
    ].join('\n');
    const reorganized = current.replace('- Fact.', '- Reorganized fact.');
    const d = deps({
      claim: vi.fn(() => null),
      claimMaintenance: () => ({ workgroupId: 'wg-a', acceptedUpdates: 50, leaseOwner: 'worker' }),
      readGenerated: () => ({ content: current, sha256: 'a'.repeat(64) }),
      maintain: vi.fn(async () => ({
        decision: { action: 'replace_generated_memory' as const, content: reorganized },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2' as const,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      })),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toMatchObject({ action: 'maintenance_written' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.writeGenerated).toHaveBeenCalledWith('wg-a', reorganized, 'a'.repeat(64), 1000);
    expect(d.completeMaintenance).toHaveBeenCalledOnce();
  });
});
