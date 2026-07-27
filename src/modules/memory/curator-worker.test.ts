import { describe, expect, it, vi } from 'vitest';

import type { MemoryCurationArchiveRow, MemoryCurationEpisode } from '../../message-archive.js';
import type { CuratorBackendResult } from './curator-backend.js';
import type { CuratorWriteResult } from './curator-write.js';
import {
  boundEpisodeMessages,
  isMemoryCuratorEnabled,
  MemoryCuratorWorker,
  selectGeneratedMemoryForPrompt,
} from './curator-worker.js';
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
        decision: {
          action: 'noop',
          reasonCode: 'transient',
          supersedesMemoryIds: [],
          memories: [],
        },
        model: 'claude-sonnet-5',
        credentialSlot,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    ),
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
    const d = deps({
      curate: vi.fn(
        async (): Promise<CuratorBackendResult> => ({
          decision: {
            action: 'replace_generated_memory',
            reasonCode: 'durable_fact',
            supersedesMemoryIds: [],
            memories: [{ text: 'GSC data is in Snowflake.', evidenceIds: ['msg-1'] }],
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
    const content = (d.writeGenerated as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(content).toMatch(/^# Generated workgroup memory\n\n- GSC data is in Snowflake\./);
    expect(d.recordAccepted).toHaveBeenCalledWith('wg-a', Buffer.byteLength(content), 1000);
    expect(d.finishCall).toHaveBeenCalledWith(expect.any(String), 'memory_written');
  });

  it('repairs one overlong semantic candidate before advancing the cursor', async () => {
    const curate = vi
      .fn()
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'x'.repeat(1_001), evidenceIds: ['msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult)
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'GSC data is in Snowflake.', evidenceIds: ['msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult);
    const d = deps({ curate });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report?.action).toBe('replace_generated_memory');
    expect(curate).toHaveBeenCalledTimes(2);
    expect(curate.mock.calls[1]?.[0]).toContain('at most 1000 characters');
    expect(d.finishCall).toHaveBeenNthCalledWith(1, expect.any(String), 'validation_retry');
    expect(d.finishCall).toHaveBeenNthCalledWith(2, expect.any(String), 'memory_written');
    expect(d.complete).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('retains the episode when the single length-repair attempt is still invalid', async () => {
    const curate = vi.fn(
      async (): Promise<CuratorBackendResult> => ({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'x'.repeat(1_001), evidenceIds: ['msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    );
    const d = deps({ curate });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(curate).toHaveBeenCalledTimes(2);
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.fail).toHaveBeenCalledOnce();
  });

  it('does not advance on provider, validation, or write conflict failures', async () => {
    const failureCases: Array<Partial<MemoryCuratorWorkerDependencies>> = [
      { curate: vi.fn(async () => Promise.reject(new Error('structured Claude call returned 429'))) },
      {
        curate: vi.fn(
          async (): Promise<CuratorBackendResult> => ({
            decision: {
              action: 'replace_generated_memory',
              reasonCode: 'durable_fact',
              supersedesMemoryIds: [],
              memories: [{ text: 'Fact.', evidenceIds: ['unknown'] }],
            },
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
              reasonCode: 'durable_fact',
              supersedesMemoryIds: [],
              memories: [{ text: 'Fact.', evidenceIds: ['msg-1'] }],
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
        decision: {
          action: 'noop',
          reasonCode: 'transient',
          supersedesMemoryIds: [],
          memories: [],
        },
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

  it('batches up to eighty short messages without increasing the transcript character ceiling', () => {
    const raw = Array.from({ length: 81 }, (_, index) =>
      message(index + 1, `msg-${index + 1}`, `short message ${index + 1}`),
    );
    const result = boundEpisodeMessages(raw);
    expect(result.messages).toHaveLength(80);
    expect(result.handledThroughRowid).toBe(80);
    expect(result.transcriptChars).toBeLessThanOrEqual(24_000);
  });

  it('never lets a truncation marker exceed the transcript character ceiling', () => {
    const result = boundEpisodeMessages([
      message(1, 'msg-1', 'a'.repeat(30_000)),
      message(2, 'msg-2', 'second message must remain pending'),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toHaveLength(24_000);
    expect(result.messages[0]?.text.endsWith('\n[truncated:episode]')).toBe(true);
    expect(result.transcriptChars).toBe(24_000);
    expect(result.handledThroughRowid).toBe(1);
  });

  it('keeps curator input bounded while retaining the most relevant generated facts', () => {
    const lines = Array.from({ length: 400 }, (_, index) => {
      const topic = index === 0 ? 'Snowflake contains GSC data.' : `Unrelated durable fact ${index}.`;
      return `- ${topic} <!-- nanoclaw-memory:id=mem_${index.toString(16).padStart(16, '0')};evidence=msg-${index};captured=2026-07-26T00:00:00.000Z -->`;
    });
    const selected = selectGeneratedMemoryForPrompt(
      ['# Generated workgroup memory', '', ...lines, ''].join('\n'),
      'Where is GSC data stored in Snowflake?',
    );
    expect(selected.length).toBeLessThanOrEqual(32_000);
    expect(selected).toContain('Snowflake contains GSC data.');
    expect(selected).toMatch(/^# Generated workgroup memory\n\n/);
  });

  it('retires thresholded maintenance deterministically without another model-authored document', async () => {
    const current = [
      '# Generated workgroup memory',
      '',
      '- Fact. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:00.000Z -->',
      '',
    ].join('\n');
    const d = deps({
      admission: () => ({ allowed: false, hourly: 120, daily: 120, hourlyLimit: 120, dailyLimit: 3000 }),
      selectCredential: () => ({
        slot: null,
        retryAt: '2026-07-26T00:15:00.000Z',
        unavailableSlots: ['oauth:primary', 'oauth:2'],
      }),
      claim: vi.fn(() => null),
      claimMaintenance: () => ({ workgroupId: 'wg-a', acceptedUpdates: 50, leaseOwner: 'worker' }),
      readGenerated: () => ({ content: current, sha256: 'a'.repeat(64) }),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toMatchObject({ action: 'maintenance_noop' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.writeGenerated).not.toHaveBeenCalled();
    expect(d.recordCall).not.toHaveBeenCalled();
    expect(d.completeMaintenance).toHaveBeenCalledOnce();
  });
});
