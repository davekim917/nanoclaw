import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, TEST_WORKGROUP } = vi.hoisted(() => ({
  TEST_ROOT: `/tmp/nanoclaw-curator-worker-test-${process.pid}`,
  TEST_WORKGROUP: 'wg-a',
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { consolidatedFactIds, markFactsConsolidated } from '../../db/memory-consolidated-facts.js';
import { log } from '../../log.js';
import type { MemoryCurationArchiveRow, MemoryCurationEpisode } from '../../message-archive.js';
import type { ConsolidationBackendResult, CuratorBackendResult } from './curator-backend.js';
import {
  CONSOLIDATION_FILE_MAX_BYTES,
  CONSOLIDATION_HEADER_PATTERN,
  CONSOLIDATION_INPUT_FILE_MAX_BYTES,
  CONSOLIDATION_MAX_FACTS,
  CURATOR_MAX_MEMORY_TEXT_CHARS,
  parseGeneratedMemoryFacts,
} from './curator-contract.js';
import {
  readGeneratedMemory,
  readMemoryTopicFile,
  writeMemoryTopicFile,
  type CuratorWriteResult,
} from './curator-write.js';
import {
  boundEpisodeMessages,
  computeConsolidationTail,
  isMemoryCuratorEnabled,
  MemoryCuratorWorker,
  scanTopicFiles,
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
    consolidationTail: () => ({ facts: [], hasMore: false }),
    scanTopicFiles: () => ({ files: [], excludedPaths: [] }),
    markConsolidated: vi.fn(),
    writeTopicFile: vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'people/x.md',
        sha256: 'a'.repeat(64),
      }),
    ),
    consolidate: vi.fn(
      async (_system, _user, credentialSlot): Promise<ConsolidationBackendResult> => ({
        decision: { files: [] },
        model: 'claude-sonnet-5',
        credentialSlot,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    ),
    uuid: vi.fn(() => '00000000-0000-0000-0000-000000000001'),
    ...overrides,
  };
}

function memoryDir(): string {
  return path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory');
}

function seedLedger(content: string): void {
  const dir = path.join(memoryDir(), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), content, 'utf8');
}

function factLine(id: string, text: string, evidence = 'msg-1', capturedAt = '2026-08-19T00:00:00.000Z'): string {
  return `- ${text} <!-- nanoclaw-memory:id=${id};evidence=${evidence};captured=${capturedAt} -->`;
}

/** Real ledger-file tail computation, backed by the temp fs (not a mock),
 *  against an in-test `memory_consolidated_facts` stand-in. */
function realConsolidationTail(consolidated: ReadonlySet<string> = new Set()) {
  return (workgroupId: string) =>
    computeConsolidationTail(
      parseGeneratedMemoryFacts(readGeneratedMemory(workgroupId).content),
      consolidated,
      CONSOLIDATION_MAX_FACTS,
    );
}

/** Same as realConsolidationTail, but reads the consolidated set from a REAL
 *  central DB (via consolidatedFactIds) instead of an in-test stand-in —
 *  matches actualDependencies() wiring minus the prune step, which has its
 *  own dedicated test. Used where the AC cares whether rows actually land in
 *  memory_consolidated_facts (F8), not just whether a mock was called. */
function dbConsolidationTail() {
  return (workgroupId: string) =>
    computeConsolidationTail(
      parseGeneratedMemoryFacts(readGeneratedMemory(workgroupId).content),
      consolidatedFactIds(workgroupId),
      CONSOLIDATION_MAX_FACTS,
    );
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(memoryDir(), 'generated'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

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

  // P0-AC8. The curator computes a reason for every decision, including each noop, and
  // the value was dropped on the floor: the run report carried `action` only, so
  // `code_derived` — the machine-readable footprint of the "recoverable from code"
  // prohibition — was uncountable. runMemoryCurationInBackground spreads the report into
  // one log.info, so surfacing it here is what makes the refusal measurable.
  it('reports the decision reason code so refusals are countable', async () => {
    const d = deps({
      curate: vi.fn(
        async (_system, _user, credentialSlot): Promise<CuratorBackendResult> => ({
          decision: { action: 'noop', reasonCode: 'code_derived', supersedesMemoryIds: [], memories: [] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'noop', reasonCode: 'code_derived' });
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
          memories: [{ text: 'x'.repeat(CURATOR_MAX_MEMORY_TEXT_CHARS + 1), evidenceIds: ['msg-1'] }],
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
    expect(curate.mock.calls[1]?.[0]).toContain(`at most ${CURATOR_MAX_MEMORY_TEXT_CHARS} characters`);
    expect(d.finishCall).toHaveBeenNthCalledWith(1, expect.any(String), 'validation_retry');
    expect(d.finishCall).toHaveBeenNthCalledWith(2, expect.any(String), 'memory_written');
    expect(d.complete).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('repairs a mislabelled reason code without dropping the supersession', async () => {
    const supersedes = ['mem_aaaaaaaaaaaaaaaa'];
    const curate = vi
      .fn()
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          // 'sensitive' explains a noop, so it cannot justify a write.
          reasonCode: 'sensitive',
          supersedesMemoryIds: supersedes,
          memories: [{ text: 'GSC access is granted.', evidenceIds: ['msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult)
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'explicit_decision',
          supersedesMemoryIds: supersedes,
          memories: [{ text: 'GSC access is granted.', evidenceIds: ['msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult);
    const current = [
      '# Generated workgroup memory',
      '',
      '- GSC access is unknown. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-07-26T00:00:00.000Z -->',
      '',
    ].join('\n');
    const d = deps({ curate, readGenerated: () => ({ content: current, sha256: 'a'.repeat(64) }) });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report?.action).toBe('replace_generated_memory');
    expect(curate).toHaveBeenCalledTimes(2);
    expect(curate.mock.calls[1]?.[0]).toContain('only relabel the reason');
    // The stale fact is gone and its replacement stands in its place.
    const written = (d.writeGenerated as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(written).toContain('GSC access is granted.');
    expect(written).not.toContain('GSC access is unknown.');
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('offers splitting as the way out of an unshortenable fact, in the prompt and the repair', async () => {
    // The retry after a failed repair starts from a clean prompt with no memory
    // of the failure, so "shorten it but lose nothing" with no third option is
    // how a stubborn candidate loops to the 24h backoff.
    const curate = vi
      .fn()
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'x'.repeat(CURATOR_MAX_MEMORY_TEXT_CHARS + 1), evidenceIds: ['msg-1'] }],
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
          memories: [
            { text: 'First half of the decision.', evidenceIds: ['msg-1'] },
            { text: 'Second half of the decision.', evidenceIds: ['msg-1'] },
          ],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult);
    const d = deps({ curate });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report?.action).toBe('replace_generated_memory');
    // Offered before the first attempt, not only after a rejection.
    expect(curate.mock.calls[0]?.[0]).toContain('Split it only when it is genuinely more than one fact');
    expect(curate.mock.calls[1]?.[0]).toContain('Split it only when it is genuinely more than one fact');
    const written = (d.writeGenerated as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(written).toContain('First half of the decision.');
    expect(written).toContain('Second half of the decision.');
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('retains the episode when the single length-repair attempt is still invalid', async () => {
    const curate = vi.fn(
      async (): Promise<CuratorBackendResult> => ({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'x'.repeat(CURATOR_MAX_MEMORY_TEXT_CHARS + 1), evidenceIds: ['msg-1'] }],
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

  // Superseded by P2-AC13 below: runMaintenance moved INSIDE the admission
  // gate (docs/specs/workgroup-cerebro/plan.md §P2.4 item 9), so an
  // admission-exhausted sweep tick must not even CLAIM a pending maintenance
  // job — the pre-P2 behavior this test used to assert (maintenance runs
  // regardless of admission) is the exact gap P2 closes.
  it('does not claim a pending maintenance job when admission is exhausted', async () => {
    const d = deps({
      admission: () => ({ allowed: false, hourly: 120, daily: 120, hourlyLimit: 120, dailyLimit: 3000 }),
      claim: vi.fn(() => null),
      claimMaintenance: vi.fn(() => ({ workgroupId: 'wg-a', acceptedUpdates: 50, leaseOwner: 'worker' })),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(d.claimMaintenance).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });
});

// Pillar-2 semantic consolidation (docs/specs/workgroup-cerebro/plan.md §P2).
// "real temp store files": the ledger and topic-file reads/writes run for
// real against a temp workgroup memory dir (DATA_DIR mocked above); only the
// model backend (`consolidate`) and the memory_consolidated_facts DB table
// (`consolidationTail`'s consolidated-id input, `markConsolidated`) are
// dependency-injected, matching how episode tests already mock the DB-backed
// lease/admission machinery while exercising real content logic.
describe('pillar-2 semantic consolidation', () => {
  // F8: AC1, AC6, and AC7(b) below assert against a REAL central DB (the
  // migration test's own pattern) rather than a markConsolidated spy, so a
  // regression that writes files but never actually inserts the
  // memory_consolidated_facts rows (or inserts the wrong ids) fails these
  // tests even though a spy would have been satisfied by any call at all.
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
  });

  it('maintenance creates topic directories on first run and consolidates the tail', async () => {
    seedLedger(
      [
        '# Generated workgroup memory',
        '',
        factLine('mem_aaaaaaaaaaaaaaaa', 'Maya Chen is the Acme liaison.'),
        factLine('mem_bbbbbbbbbbbbbbbb', 'Acme pricing is usage-based.'),
        factLine('mem_cccccccccccccccc', 'The nightly pipeline loads Acme data.'),
        '',
      ].join('\n'),
    );
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 3, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      writeTopicFile: writeMemoryTopicFile,
      markConsolidated: markFactsConsolidated,
      consolidate: vi.fn(
        async (_system, _user, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: {
            files: [
              { path: 'people/maya-chen.md', content: '# Maya Chen\n\nLiaison for Acme.\n' },
              { path: 'domain/acme-pricing.md', content: '# Acme pricing\n\nUsage-based.\n' },
            ],
          },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 2 });
    expect(fs.lstatSync(path.join(memoryDir(), 'people')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(memoryDir(), 'domain')).isDirectory()).toBe(true);
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/maya-chen.md').content.split('\n')[0]).toMatch(
      CONSOLIDATION_HEADER_PATTERN,
    );
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/acme-pricing.md').content.split('\n')[0]).toMatch(
      CONSOLIDATION_HEADER_PATTERN,
    );
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(
      new Set(['mem_aaaaaaaaaaaaaaaa', 'mem_bbbbbbbbbbbbbbbb', 'mem_cccccccccccccccc']),
    );
  });

  it('consolidation input is scoped to the unconsolidated tail, owned files as writable, human-authored files as read-only context', async () => {
    seedLedger(
      [
        '# Generated workgroup memory',
        '',
        factLine('mem_aaaaaaaaaaaaaaaa', 'Already consolidated fact.'),
        factLine('mem_bbbbbbbbbbbbbbbb', 'A fresh fact about Acme.'),
        '',
      ].join('\n'),
    );
    let capturedUser = '';
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(new Set(['mem_aaaaaaaaaaaaaaaa'])),
      scanTopicFiles: () => ({
        files: [
          {
            path: 'people/x.md',
            content: '<!-- consolidated: facts=1 -->\n# X\n\nOwned current content.\n',
            owned: true,
          },
          { path: 'people/roster.md', content: '# Roster\n\nHuman-authored roster entry.\n', owned: false },
        ],
        excludedPaths: [],
      }),
      consolidate: vi.fn(async (_system, user, credentialSlot): Promise<ConsolidationBackendResult> => {
        capturedUser = user;
        return {
          decision: { files: [] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
      }),
    });
    await new MemoryCuratorWorker(d).runOne(1000);
    expect(capturedUser).toContain('A fresh fact about Acme.');
    expect(capturedUser).not.toContain('Already consolidated fact.');
    expect(capturedUser).toContain('Owned current content.');
    expect(capturedUser).toContain('Human-authored roster entry.');
    expect(capturedUser).toContain('"owned":true');
    expect(capturedUser).toContain('"owned":false');
    // F6: capturedAt must actually reach the payload — the prompt instructs
    // dating an unresolved conflict, which is only followable if a date is
    // present to cite.
    expect(capturedUser).toContain('2026-08-19T00:00:00.000Z');
  });

  // P2-AC4. Both halves: content alone under the cap is not sufficient proof
  // (the header must push it over), and a 13-file set trips the max-count
  // cap. Nothing written in either case.
  it('oversize or over-count file sets are rejected, measured on the final serialized file', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const writeTopicFile = vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'people/x.md',
        sha256: 'a'.repeat(64),
      }),
    );

    const nearCapContent = `# X\n\n${'y'.repeat(CONSOLIDATION_FILE_MAX_BYTES - 10)}\n`;
    expect(Buffer.byteLength(nearCapContent, 'utf8')).toBeLessThan(CONSOLIDATION_FILE_MAX_BYTES);
    const oversize = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      writeTopicFile,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/big.md', content: nearCapContent }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    expect(await new MemoryCuratorWorker(oversize).runOne(1000)).toBeNull();
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(oversize.markConsolidated).not.toHaveBeenCalled();

    const manyFiles = Array.from({ length: 13 }, (_, i) => ({ path: `domain/topic-${i}.md`, content: `# T${i}\n` }));
    const overcount = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      writeTopicFile,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: manyFiles },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    expect(await new MemoryCuratorWorker(overcount).runOne(1000)).toBeNull();
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(overcount.markConsolidated).not.toHaveBeenCalled();
  });

  it('the ledger is byte-identical after a pass', async () => {
    const ledger = ['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n');
    seedLedger(ledger);
    const before = fs.readFileSync(path.join(memoryDir(), 'generated', 'memory.md'), 'utf8');
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      writeTopicFile: writeMemoryTopicFile,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/x.md', content: '# X\n\nSomething.\n' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 1 });
    const after = fs.readFileSync(path.join(memoryDir(), 'generated', 'memory.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('a mid-batch CAS conflict marks nothing consolidated and the next pass re-presents the same tail', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const writeTopicFile = vi.fn(
      async (
        workgroupId: string,
        relativePath: string,
        content: string,
        expectedSha256: string | null,
        factsCount: number,
      ): Promise<CuratorWriteResult> => {
        if (relativePath === 'domain/two.md') {
          return { status: 'conflict', relative_path: relativePath, error: 'expected_sha256 does not match' };
        }
        return writeMemoryTopicFile(workgroupId, relativePath, content, expectedSha256, factsCount);
      },
    );
    const failMaintenance = vi.fn(() => true);
    const completeMaintenance = vi.fn(() => true);
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      writeTopicFile,
      markConsolidated: markFactsConsolidated,
      failMaintenance,
      completeMaintenance,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: {
            files: [
              { path: 'people/one.md', content: '# One\n\nFirst file.\n' },
              { path: 'domain/two.md', content: '# Two\n\nSecond file.\n' },
            ],
          },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toBeNull();
    expect(failMaintenance).toHaveBeenCalledOnce();
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set());
    expect(completeMaintenance).not.toHaveBeenCalled();
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/one.md').content).toContain('First file.');

    let capturedUser = '';
    const retryDeps = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      scanTopicFiles: () => ({
        files: [
          {
            path: 'people/one.md',
            content: readMemoryTopicFile(TEST_WORKGROUP, 'people/one.md').content,
            owned: true,
          },
        ],
        excludedPaths: [],
      }),
      consolidate: vi.fn(async (_s, user, credentialSlot): Promise<ConsolidationBackendResult> => {
        capturedUser = user;
        return {
          decision: { files: [] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
      }),
    });
    await new MemoryCuratorWorker(retryDeps).runOne(1000);
    expect(capturedUser).toContain('A fact.');
    expect(capturedUser).toContain('First file.');
  });

  it('tail-emptiness and a model choosing zero files are distinct outcomes', async () => {
    seedLedger('# Generated workgroup memory\n\n');
    const consolidate = vi.fn();
    const emptyTailDeps = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 0, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      consolidate,
    });
    const noopReport = await new MemoryCuratorWorker(emptyTailDeps).runOne(1000);
    expect(noopReport).toMatchObject({ action: 'maintenance_noop' });
    expect(consolidate).not.toHaveBeenCalled();

    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const logSpy = vi.spyOn(log, 'info');
    const zeroFilesDeps = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      markConsolidated: markFactsConsolidated,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const writtenReport = await new MemoryCuratorWorker(zeroFilesDeps).runOne(1000);
    expect(writtenReport).toMatchObject({ action: 'maintenance_written', fileCount: 0 });
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
    expect(logSpy).toHaveBeenCalledWith(
      'memory-curator: consolidation pass wrote zero files for a non-empty tail',
      expect.objectContaining({ workgroupId: TEST_WORKGROUP }),
    );
    logSpy.mockRestore();
  });

  it('over-cap presented topic files are excluded, logged, and locked for that pass', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const writeTopicFile = vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'people/over.md',
        sha256: 'a'.repeat(64),
      }),
    );
    const warnSpy = vi.spyOn(log, 'warn');
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      scanTopicFiles: () => ({ files: [], excludedPaths: ['people/over.md', 'domain/also-over.md'] }),
      writeTopicFile,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/over.md', content: '# Over\n' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toBeNull();
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: over-cap topic files excluded and locked for this pass',
      expect.objectContaining({ excludedPaths: ['people/over.md', 'domain/also-over.md'] }),
    );
    warnSpy.mockRestore();
  });

  // F5. Before this fix, lockedPaths only carried over-cap excludedPaths — a
  // presented owned:false (human-authored, read-only) path that was UNDER
  // cap was never locked, so a model write targeting it fell through to
  // writeTopicFile. If that path had also vanished from disk between scan
  // and write, writeTopicFile's ownership check (which only fires against an
  // EXISTING file) would have nothing to refuse against and the write would
  // succeed as a "new file" — the exact violation this closes.
  it('refuses a model write to a path presented as human-authored, even if it vanishes from disk mid-pass', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const writeTopicFile = vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'people/roster.md',
        sha256: 'a'.repeat(64),
      }),
    );
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      writeTopicFile,
      // Presented as read-only context, and deliberately absent from disk —
      // scanTopicFiles is not re-invoked between scan and write, so this is
      // exactly what "vanished mid-pass" looks like from the write step.
      scanTopicFiles: () => ({
        files: [{ path: 'people/roster.md', content: '# Roster\n\nHuman-authored.\n', owned: false }],
        excludedPaths: [],
      }),
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/roster.md', content: '# Roster\n\nModel-proposed overwrite.\n' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toBeNull();
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(memoryDir(), 'people', 'roster.md'))).toBe(false);
  });

  // F4. Real fs, no scanner mock: an already-oversized file on disk must be
  // excluded and locked, never presented to the model as content.
  it('scanTopicFiles excludes and locks an oversized topic file instead of reading it', () => {
    const peopleDir = path.join(memoryDir(), 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    fs.writeFileSync(path.join(peopleDir, 'small.md'), '# Small\n\nUnder the cap.\n');
    fs.writeFileSync(
      path.join(peopleDir, 'huge.md'),
      `<!-- consolidated: facts=1 -->\n# Huge\n\n${'x'.repeat(CONSOLIDATION_INPUT_FILE_MAX_BYTES + 1)}\n`,
    );
    const scan = scanTopicFiles(TEST_WORKGROUP);
    expect(scan.excludedPaths).toEqual(['people/huge.md']);
    expect(scan.files.map((file) => file.path)).toEqual(['people/small.md']);
    // The oversized file's content must never have been read into memory.
    expect(scan.files.some((file) => file.content.includes('Huge'))).toBe(false);
  });

  it('the maintenance call is admission-accounted and abort-propagated', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));

    const gatedDeps = deps({
      admission: () => ({ allowed: false, hourly: 120, daily: 120, hourlyLimit: 120, dailyLimit: 3000 }),
      claimMaintenance: vi.fn(() => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' })),
    });
    expect(await new MemoryCuratorWorker(gatedDeps).runOne(1000)).toBeNull();
    expect(gatedDeps.claimMaintenance).not.toHaveBeenCalled();

    const recordCall = vi.fn(() => true);
    const finishCall = vi.fn();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const runningDeps = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      recordCall,
      finishCall,
      consolidate: vi.fn(async (_s, _u, credentialSlot, signal): Promise<ConsolidationBackendResult> => {
        capturedSignal = signal;
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return {
          decision: { files: [] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
      }),
    });
    controller.abort();
    const report = await new MemoryCuratorWorker(runningDeps).runOne(1000, controller.signal);
    expect(capturedSignal).toBe(controller.signal);
    expect(report).toBeNull();
    expect(recordCall).toHaveBeenCalledOnce();
    expect(finishCall).toHaveBeenCalledWith(expect.any(String), 'timeout');

    // F7: the signal must be re-checked past the model call, not only while
    // it is in flight — an abort that lands between two sequential writes
    // must stop the SECOND write from ever running.
    seedLedger(
      [
        '# Generated workgroup memory',
        '',
        factLine('mem_aaaaaaaaaaaaaaaa', 'Fact one.'),
        factLine('mem_bbbbbbbbbbbbbbbb', 'Fact two.'),
        '',
      ].join('\n'),
    );
    const writeController = new AbortController();
    let write2Called = false;
    const markConsolidated = vi.fn();
    const completeMaintenance = vi.fn(() => true);
    const writeTopicFile = vi.fn(async (_workgroupId: string, relativePath: string): Promise<CuratorWriteResult> => {
      if (relativePath === 'people/two.md') write2Called = true;
      else writeController.abort(); // flip mid-batch, from inside write 1
      return { status: 'success', relative_path: relativePath, sha256: 'a'.repeat(64) };
    });
    const writeAbortDeps = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 2, leaseOwner: 'worker' }),
      consolidationTail: realConsolidationTail(),
      writeTopicFile,
      markConsolidated,
      completeMaintenance,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: {
            files: [
              { path: 'people/one.md', content: '# One\n' },
              { path: 'people/two.md', content: '# Two\n' },
            ],
          },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const writeAbortReport = await new MemoryCuratorWorker(writeAbortDeps).runOne(1000, writeController.signal);
    expect(writeAbortReport).toBeNull();
    expect(writeTopicFile).toHaveBeenCalledOnce(); // write 1 ran; write 2 never did
    expect(write2Called).toBe(false);
    expect(markConsolidated).not.toHaveBeenCalled();
    expect(completeMaintenance).not.toHaveBeenCalled();
  });
});
