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
    syncIndexes: vi.fn(async () => ({ updated: [] })),
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

  it('skips the model call for a solo Slack bot message the agent never answered', async () => {
    const botMessage: MemoryCurationArchiveRow = {
      ...message(1, 'msg-1', 'Snowflake alert: query failed'),
      channelType: 'slack',
      senderId: 'B0EXAMPLE001',
    };
    const d = deps({ messages: () => [botMessage] });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({
      action: 'noop',
      reasonCode: 'insufficient_evidence',
      messageCount: 1,
      workgroupId: 'wg-a',
    });
    expect(d.curate).not.toHaveBeenCalled();
    expect(d.writeGenerated).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({ claimedThroughRowid: 1 }), 1000);
  });

  it('skips the model call for a workspace-suffixed Slack channel type + prefixed sender id', async () => {
    // channelType carries a per-workspace/per-sibling-bot suffix in production
    // (`slack-acme`, `slack-acme-codex`, ...) — bare 'slack' alone
    // would miss every real fleet row. senderId is also stored as
    // `${channelType}:${platformUserId}` in production (verified against
    // data/archive.db), not the bare platform id.
    const botMessage: MemoryCurationArchiveRow = {
      ...message(1, 'msg-1', 'Snowflake alert: query failed'),
      channelType: 'slack-acme',
      senderId: 'slack-acme:B0EXAMPLE001',
    };
    const d = deps({ messages: () => [botMessage] });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'noop', reasonCode: 'insufficient_evidence', messageCount: 1 });
    expect(d.curate).not.toHaveBeenCalled();
  });

  it('does NOT skip a solo Slack message from a human sender (U-prefixed id)', async () => {
    const humanMessage: MemoryCurationArchiveRow = {
      ...message(1, 'msg-1', 'Remember GSC is in Snowflake.'),
      channelType: 'slack',
      senderId: 'U0EXAMPLE002',
    };
    const d = deps({ messages: () => [humanMessage] });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(d.curate).toHaveBeenCalled();
    expect(report).toMatchObject({ action: 'noop', workgroupId: 'wg-a', messageCount: 1 });
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

  // Production bug (147 failures, one workgroup): 86% of platform timestamps
  // are archived under 2+ agent groups, so the bare-timestamp prefix rescue in
  // resolveEvidenceIds finds two matches, not one, and throws. Two messages
  // sharing the raw timestamp '170000' under different agent groups reproduces
  // that ambiguity exactly.
  it('repairs an evidence id shortened past its agent-group suffix, without dropping the fact', async () => {
    const evidenceMessages: MemoryCurationArchiveRow[] = [
      message(1, '170000:ag-1', 'Alice owns the pipeline.'),
      message(2, '170000:ag-2', 'Bob owns billing.'),
    ];
    const curate = vi
      .fn()
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          // The model shortened the id to the bare timestamp, dropping the
          // ":<agent_group_id>" suffix — the exact fidelity failure diagnosed.
          memories: [{ text: 'Alice owns the pipeline.', evidenceIds: ['170000'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult)
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'Alice owns the pipeline.', evidenceIds: ['170000:ag-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult);
    const d = deps({ curate, messages: () => evidenceMessages });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report?.action).toBe('replace_generated_memory');
    expect(curate).toHaveBeenCalledTimes(2);
    // The corrective instruction names the exact failure mode: copy verbatim,
    // suffix included, never shorten to the timestamp.
    expect(curate.mock.calls[1]?.[0]).toContain('copied verbatim');
    expect(curate.mock.calls[1]?.[0]).toContain(':<agent_group_id>');
    expect(curate.mock.calls[1]?.[0]).toContain('never shorten an id to just its timestamp');
    const written = (d.writeGenerated as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(written).toContain('Alice owns the pipeline.');
    expect(written).toContain('evidence=170000:ag-1');
    expect(d.finishCall).toHaveBeenNthCalledWith(1, expect.any(String), 'validation_retry');
    expect(d.finishCall).toHaveBeenNthCalledWith(2, expect.any(String), 'memory_written');
    expect(d.complete).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('surfaces the offending evidence id out of band when the repair retry still fails', async () => {
    const evidenceMessages: MemoryCurationArchiveRow[] = [
      message(1, '170000:ag-1', 'Alice owns the pipeline.'),
      message(2, '170000:ag-2', 'Bob owns billing.'),
    ];
    // Same bad id on every call — the retry starts from a clean prompt, and a
    // model that keeps shortening the id fails again the same way.
    const curate = vi.fn(
      async (): Promise<CuratorBackendResult> => ({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'Alice owns the pipeline.', evidenceIds: ['170000'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    );
    const warnSpy = vi.spyOn(log, 'warn');
    const d = deps({ curate, messages: () => evidenceMessages });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report).toBeNull();
    expect(curate).toHaveBeenCalledTimes(2);
    expect(d.complete).not.toHaveBeenCalled();
    // classifyError still classifies this the same way it did before the
    // fix — 'validation', unperturbed by the id now riding along on the error.
    expect(d.fail).toHaveBeenCalledWith(episode, 'validation', 1000);
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: episode failed',
      expect.objectContaining({
        errorClass: 'validation',
        // The thrown message stays byte-identical — REPAIRABLE_VIOLATIONS and
        // classifyError both key off this exact string.
        error: 'curator returned an unknown evidence id',
        offendingEvidenceId: '170000',
        submittedEvidenceIds: ['170000'],
      }),
    );
    warnSpy.mockRestore();
  });

  // Production bug (~1/day, steady 19 days): selectGeneratedMemoryForPrompt
  // shows full prior fact lines including their own evidence=...:agent-group
  // markers, so the model can copy a prior id verbatim without citing
  // anything from the current episode.
  it('repairs a candidate whose evidence cites only a prior fact, without dropping it', async () => {
    const priorContent = [
      '# Generated workgroup memory',
      '',
      '- GSC access is unknown. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=old-1;captured=2026-07-20T00:00:00.000Z -->',
      '',
    ].join('\n');
    const curate = vi
      .fn()
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          // Copied straight from the prior fact's own evidence marker — no id
          // from this episode at all.
          memories: [{ text: 'GSC access is granted now.', evidenceIds: ['old-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult)
      .mockResolvedValueOnce({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'GSC access is granted now.', evidenceIds: ['old-1', 'msg-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      } satisfies CuratorBackendResult);
    const d = deps({ curate, readGenerated: () => ({ content: priorContent, sha256: 'a'.repeat(64) }) });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report?.action).toBe('replace_generated_memory');
    expect(curate).toHaveBeenCalledTimes(2);
    // The corrective instruction names the current-episode requirement.
    expect(curate.mock.calls[1]?.[0]).toContain('CURRENT episode');
    const written = (d.writeGenerated as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(written).toContain('GSC access is granted now.');
    expect(d.finishCall).toHaveBeenNthCalledWith(1, expect.any(String), 'validation_retry');
    expect(d.finishCall).toHaveBeenNthCalledWith(2, expect.any(String), 'memory_written');
    expect(d.complete).toHaveBeenCalledOnce();
    expect(d.fail).not.toHaveBeenCalled();
  });

  it('surfaces the submitted evidence ids out of band when the current-episode repair retry still fails', async () => {
    const priorContent = [
      '# Generated workgroup memory',
      '',
      '- GSC access is unknown. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=old-1;captured=2026-07-20T00:00:00.000Z -->',
      '',
    ].join('\n');
    // Same prior-only id on every call — the retry starts from a clean
    // prompt, and a model that keeps citing only prior evidence fails again
    // the same way.
    const curate = vi.fn(
      async (): Promise<CuratorBackendResult> => ({
        decision: {
          action: 'replace_generated_memory',
          reasonCode: 'durable_fact',
          supersedesMemoryIds: [],
          memories: [{ text: 'GSC access is granted now.', evidenceIds: ['old-1'] }],
        },
        model: 'claude-sonnet-5',
        credentialSlot: 'oauth:2',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    );
    const warnSpy = vi.spyOn(log, 'warn');
    const d = deps({ curate, readGenerated: () => ({ content: priorContent, sha256: 'a'.repeat(64) }) });
    const report = await new MemoryCuratorWorker(d).runOne(1000);

    expect(report).toBeNull();
    expect(curate).toHaveBeenCalledTimes(2);
    expect(d.complete).not.toHaveBeenCalled();
    // classifyError still classifies this the same way it did before the
    // fix — 'validation', unperturbed by the ids now riding along on the error.
    expect(d.fail).toHaveBeenCalledWith(episode, 'validation', 1000);
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: episode failed',
      expect.objectContaining({
        errorClass: 'validation',
        // The thrown message stays byte-identical — REPAIRABLE_VIOLATIONS and
        // classifyError both key off this exact string.
        error: 'new generated fact has no current-episode evidence',
        submittedEvidenceIds: ['old-1'],
      }),
    );
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('offendingEvidenceId');
    warnSpy.mockRestore();
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
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/maya-chen.md').content).toMatch(
      /^---\ntype: person\nconsolidated_facts: 3\n---\n\n/,
    );
    expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/acme-pricing.md').content).toMatch(
      /^---\ntype: domain\nconsolidated_facts: 3\n---\n\n/,
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
            content: '# X\n\nOwned current content.\n',
            owned: true,
            sha256: '0'.repeat(64),
          },
          {
            path: 'people/roster.md',
            content: '# Roster\n\nHuman-authored roster entry.\n',
            owned: false,
            sha256: '1'.repeat(64),
          },
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

  // P2-AC4, CONVERTED for the deadlock fix (was: "oversize or over-count file
  // sets are rejected, measured on the final serialized file" — both halves
  // asserted the whole pass THROWS and nothing is written or marked). A
  // per-file violation is now a REJECTION, not a throw: retrying an
  // oversized/over-count violation against the SAME model reproduces the
  // identical output forever, so failing the whole pass made zero progress
  // on every trigger. The measurement itself (header pushes content over the
  // cap) is unchanged — only the outcome of tripping it changed, from "whole
  // pass fails" to "that file is dropped, the rest of the batch still
  // lands, and the tail is marked either way."
  it('oversize or over-count file sets are rejected per-file, measured on the final serialized file', async () => {
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
    // CHANGED: was `toBeNull()` (whole pass failed). Now a single all-rejected
    // file behaves like the model returning `files: []` — the pass succeeds,
    // writes nothing, and still marks the tail so the next trigger doesn't
    // re-present the identical fact forever.
    const oversizeReport = await new MemoryCuratorWorker(oversize).runOne(1000);
    expect(oversizeReport).toMatchObject({ action: 'maintenance_written', fileCount: 0, rejectedCount: 1 });
    expect(writeTopicFile).not.toHaveBeenCalled();
    // CHANGED: was `not.toHaveBeenCalled()`. markConsolidated now fires even
    // when everything proposed was rejected — that's the whole point of the
    // fix (see curator-worker.test.ts "a batch of entirely invalid files..."
    // and curator-worker.ts runMaintenanceJob).
    expect(oversize.markConsolidated).toHaveBeenCalledWith(TEST_WORKGROUP, ['mem_aaaaaaaaaaaaaaaa']);
    expect(oversize.failMaintenance).not.toHaveBeenCalled();

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
    // CHANGED: was `toBeNull()` with `writeTopicFile` never called. Now the
    // first CONSOLIDATION_MAX_FILES (12) of the 13 are accepted and written;
    // only the 13th is rejected as `too-many-files`.
    const overcountReport = await new MemoryCuratorWorker(overcount).runOne(1000);
    expect(overcountReport).toMatchObject({ action: 'maintenance_written', fileCount: 12, rejectedCount: 1 });
    expect(writeTopicFile).toHaveBeenCalledTimes(12);
    expect(overcount.markConsolidated).toHaveBeenCalledWith(TEST_WORKGROUP, ['mem_aaaaaaaaaaaaaaaa']);
    expect(overcount.failMaintenance).not.toHaveBeenCalled();
  });

  // New dedicated coverage for the deadlock fix (docs/specs/workgroup-cerebro
  // plan.md §P2.4 item 7, corrected): a per-file violation must not deadlock
  // consolidation for the entities behind it. All four cases below use the
  // REAL central DB (dbConsolidationTail / consolidatedFactIds), matching the
  // established F8 pattern, so a regression that writes files without
  // actually inserting memory_consolidated_facts rows fails these even
  // though a markConsolidated spy would have been satisfied by any call.
  describe('per-file rejection makes progress instead of deadlocking (curator-contract throw -> partition fix)', () => {
    it('an oversized topic file is dropped while the rest of the pass still lands', async () => {
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
      const oversizeContent = `# Huge\n\n${'z'.repeat(CONSOLIDATION_FILE_MAX_BYTES)}\n`;
      const warnSpy = vi.spyOn(log, 'warn');
      const d = deps({
        claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 3, leaseOwner: 'worker' }),
        consolidationTail: dbConsolidationTail(),
        writeTopicFile: writeMemoryTopicFile,
        markConsolidated: markFactsConsolidated,
        consolidate: vi.fn(
          async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
            decision: {
              files: [
                { path: 'people/maya-chen.md', content: '# Maya Chen\n\nLiaison for Acme.\n' },
                { path: 'domain/acme-pricing.md', content: '# Acme pricing\n\nUsage-based.\n' },
                { path: 'domain/huge.md', content: oversizeContent },
              ],
            },
            model: 'claude-sonnet-5',
            credentialSlot,
            usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      });
      const report = await new MemoryCuratorWorker(d).runOne(1000);
      // The pass did NOT fail: the two valid files exist on disk.
      expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 2, rejectedCount: 1 });
      expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/maya-chen.md').content).toContain('Liaison for Acme.');
      expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/acme-pricing.md').content).toContain('Usage-based.');
      // The oversized path does NOT exist (readMemoryTopicFile returns a
      // null sha256 for a missing file rather than throwing).
      expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/huge.md').sha256).toBeNull();
      // The tail's fact ids ARE in memory_consolidated_facts — progress was
      // made even though one entity's view was dropped this pass.
      expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(
        new Set(['mem_aaaaaaaaaaaaaaaa', 'mem_bbbbbbbbbbbbbbbb', 'mem_cccccccccccccccc']),
      );
      expect(d.failMaintenance).not.toHaveBeenCalled();
      // A WARN fired naming the rejected path.
      expect(warnSpy).toHaveBeenCalledWith(
        'memory-curator: consolidation dropped invalid topic files this pass',
        expect.objectContaining({
          workgroupId: TEST_WORKGROUP,
          rejected: [expect.objectContaining({ path: 'domain/huge.md', reason: 'too-large' })],
        }),
      );
      warnSpy.mockRestore();
    });

    // Production poison loop (2026-08-20): a locked-path write used to throw
    // and fail the WHOLE pass. The locked set (over-cap + human-authored
    // files) is deterministic per pass, so the retry re-presented the
    // identical tail to the same model, which proposed the same locked path
    // again — failing identically forever behind a 6h backoff. This is now a
    // per-file rejection, same shape as an oversized or bad-path file above.
    it('a write to a locked topic path is dropped while the rest of the pass still lands', async () => {
      seedLedger(
        [
          '# Generated workgroup memory',
          '',
          factLine('mem_aaaaaaaaaaaaaaaa', 'Maya Chen is the Acme liaison.'),
          factLine('mem_bbbbbbbbbbbbbbbb', 'Acme pricing is usage-based.'),
          factLine('mem_cccccccccccccccc', 'The on-call roster is hand-maintained.'),
          '',
        ].join('\n'),
      );
      const peopleDir = path.join(memoryDir(), 'people');
      fs.mkdirSync(peopleDir, { recursive: true });
      const humanContent = '# Roster\n\nHuman-authored, do not touch.\n';
      fs.writeFileSync(path.join(peopleDir, 'roster.md'), humanContent, 'utf8');
      const warnSpy = vi.spyOn(log, 'warn');
      const d = deps({
        claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 3, leaseOwner: 'worker' }),
        consolidationTail: dbConsolidationTail(),
        scanTopicFiles, // real scan: picks up roster.md from disk as owned:false
        writeTopicFile: writeMemoryTopicFile,
        markConsolidated: markFactsConsolidated,
        consolidate: vi.fn(
          async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
            decision: {
              files: [
                { path: 'people/maya-chen.md', content: '# Maya Chen\n\nLiaison for Acme.\n' },
                { path: 'domain/acme-pricing.md', content: '# Acme pricing\n\nUsage-based.\n' },
                { path: 'people/roster.md', content: '# Roster\n\nModel-proposed overwrite.\n' },
              ],
            },
            model: 'claude-sonnet-5',
            credentialSlot,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      });
      const report = await new MemoryCuratorWorker(d).runOne(1000);
      // The pass did NOT fail: the two valid files exist on disk.
      expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 2, rejectedCount: 1 });
      expect(readMemoryTopicFile(TEST_WORKGROUP, 'people/maya-chen.md').content).toContain('Liaison for Acme.');
      expect(readMemoryTopicFile(TEST_WORKGROUP, 'domain/acme-pricing.md').content).toContain('Usage-based.');
      // The human-authored file is byte-identical: the model's proposed
      // overwrite never reached writeTopicFile.
      expect(fs.readFileSync(path.join(peopleDir, 'roster.md'), 'utf8')).toBe(humanContent);
      // The tail's fact ids ARE marked consolidated even though one entity's
      // proposed write was refused this pass.
      expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(
        new Set(['mem_aaaaaaaaaaaaaaaa', 'mem_bbbbbbbbbbbbbbbb', 'mem_cccccccccccccccc']),
      );
      expect(d.failMaintenance).not.toHaveBeenCalled();
      // A WARN fired naming the locked path and its distinct reason.
      expect(warnSpy).toHaveBeenCalledWith(
        'memory-curator: consolidation dropped invalid topic files this pass',
        expect.objectContaining({
          workgroupId: TEST_WORKGROUP,
          rejected: [expect.objectContaining({ path: 'people/roster.md', reason: 'locked-path' })],
        }),
      );
      warnSpy.mockRestore();
    });

    it('a batch of entirely invalid files still consolidates the tail and writes nothing', async () => {
      seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
      const writeTopicFile = vi.fn();
      const d = deps({
        claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
        consolidationTail: dbConsolidationTail(),
        writeTopicFile,
        markConsolidated: markFactsConsolidated,
        consolidate: vi.fn(
          async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
            decision: {
              files: [
                { path: 'not/a/topic/dir.md', content: '# Bad path\n' },
                { path: 'people/also-bad.md', content: `# Y\n\n${'y'.repeat(CONSOLIDATION_FILE_MAX_BYTES)}\n` },
              ],
            },
            model: 'claude-sonnet-5',
            credentialSlot,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      });
      const report = await new MemoryCuratorWorker(d).runOne(1000);
      expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 0, rejectedCount: 2 });
      expect(writeTopicFile).not.toHaveBeenCalled();
      expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
      expect(d.failMaintenance).not.toHaveBeenCalled();
    });

    it('a malformed model payload still fails the whole pass', async () => {
      seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
      const writeTopicFile = vi.fn();
      const failMaintenance = vi.fn(() => true);
      const d = deps({
        claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
        consolidationTail: dbConsolidationTail(),
        writeTopicFile,
        markConsolidated: markFactsConsolidated,
        failMaintenance,
        consolidate: vi.fn(
          async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
            // `files` is a string, not an array — a structural/protocol
            // violation, distinct from a per-file content violation.
            decision: { files: 'not-an-array' } as unknown as ConsolidationBackendResult['decision'],
            model: 'claude-sonnet-5',
            credentialSlot,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      });
      const report = await new MemoryCuratorWorker(d).runOne(1000);
      expect(report).toBeNull();
      expect(failMaintenance).toHaveBeenCalledOnce();
      expect(writeTopicFile).not.toHaveBeenCalled();
      expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set());
    });

    it('over-count batches accept the first twelve and reject the remainder', async () => {
      seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
      const writtenPaths: string[] = [];
      const writeTopicFile = vi.fn(
        async (
          workgroupId: string,
          relativePath: string,
          content: string,
          expectedSha256: string | null,
          factsCount: number,
        ): Promise<CuratorWriteResult> => {
          writtenPaths.push(relativePath);
          return writeMemoryTopicFile(workgroupId, relativePath, content, expectedSha256, factsCount);
        },
      );
      const manyFiles = Array.from({ length: 14 }, (_, i) => ({ path: `domain/topic-${i}.md`, content: `# T${i}\n` }));
      const d = deps({
        claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
        consolidationTail: dbConsolidationTail(),
        writeTopicFile,
        markConsolidated: markFactsConsolidated,
        consolidate: vi.fn(
          async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
            decision: { files: manyFiles },
            model: 'claude-sonnet-5',
            credentialSlot,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          }),
        ),
      });
      const report = await new MemoryCuratorWorker(d).runOne(1000);
      expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 12, rejectedCount: 2 });
      expect(writtenPaths).toEqual(manyFiles.slice(0, 12).map((file) => file.path));
      expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
      expect(d.failMaintenance).not.toHaveBeenCalled();
    });
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
            sha256: readMemoryTopicFile(TEST_WORKGROUP, 'people/one.md').sha256!,
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

  // CONVERTED (production poison loop, 2026-08-20): this used to assert the
  // whole pass THROWS when the model proposes a write to an over-cap locked
  // path (`report` was `toBeNull()`). The over-cap exclusion warn itself is
  // unchanged (still fires exactly as before); what changed is what happens
  // to the model's write attempt against it — now a per-file rejection that
  // still lets the pass complete and mark the tail, instead of a throw that
  // deterministically fails the same way every retry.
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
      consolidationTail: dbConsolidationTail(),
      scanTopicFiles: () => ({ files: [], excludedPaths: ['people/over.md', 'domain/also-over.md'] }),
      writeTopicFile,
      markConsolidated: markFactsConsolidated,
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
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 0, rejectedCount: 1 });
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: over-cap topic files excluded and locked for this pass',
      expect.objectContaining({ excludedPaths: ['people/over.md', 'domain/also-over.md'] }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: consolidation dropped invalid topic files this pass',
      expect.objectContaining({
        workgroupId: TEST_WORKGROUP,
        rejected: [expect.objectContaining({ path: 'people/over.md', reason: 'locked-path' })],
      }),
    );
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
    expect(d.failMaintenance).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // F5. Before this fix, lockedPaths only carried over-cap excludedPaths — a
  // presented owned:false (human-authored, read-only) path that was UNDER
  // cap was never locked, so a model write targeting it fell through to
  // writeTopicFile. If that path had also vanished from disk between scan
  // and write, writeTopicFile's ownership check (which only fires against an
  // EXISTING file) would have nothing to refuse against and the write would
  // succeed as a "new file" — the exact violation this closes.
  //
  // CONVERTED (production poison loop, 2026-08-20): this used to assert the
  // whole pass THROWS on a locked-path write (`report` was `toBeNull()`,
  // `markConsolidated`/`completeMaintenance` were implicitly never reached).
  // A single all-locked file is now the same shape as "a batch of entirely
  // invalid files" below — the pass succeeds, writes nothing, and marks the
  // tail — because the locked set is deterministic per pass and a throw here
  // could never make the retry succeed; it only reproduced the identical
  // failure every 6h forever. The locked-write refusal itself (writeTopicFile
  // never called, file absent from disk) is unchanged and still asserted.
  it('a batch consisting only of locked paths still consolidates the tail', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const writeTopicFile = vi.fn(
      async (): Promise<CuratorWriteResult> => ({
        status: 'success',
        relative_path: 'people/roster.md',
        sha256: 'a'.repeat(64),
      }),
    );
    const warnSpy = vi.spyOn(log, 'warn');
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      writeTopicFile,
      markConsolidated: markFactsConsolidated,
      // Presented as read-only context, and deliberately absent from disk —
      // scanTopicFiles is not re-invoked between scan and write, so this is
      // exactly what "vanished mid-pass" looks like from the write step.
      scanTopicFiles: () => ({
        files: [
          { path: 'people/roster.md', content: '# Roster\n\nHuman-authored.\n', owned: false, sha256: '0'.repeat(64) },
        ],
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
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 0, rejectedCount: 1 });
    expect(writeTopicFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(memoryDir(), 'people', 'roster.md'))).toBe(false);
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
    expect(d.failMaintenance).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: consolidation dropped invalid topic files this pass',
      expect.objectContaining({
        workgroupId: TEST_WORKGROUP,
        rejected: [expect.objectContaining({ path: 'people/roster.md', reason: 'locked-path' })],
      }),
    );
    warnSpy.mockRestore();
  });

  // F6. The poison loop: a writer `error` is deterministic, so throwing on it
  // re-presented byte-identical input to the same model forever. It must
  // partition out like every other per-file rejection; a `conflict` still
  // throws, because a retry genuinely sees different bytes.
  it('drops a topic file the writer refuses instead of retrying it forever', async () => {
    seedLedger(
      ['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact about Maya.'), ''].join('\n'),
    );
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const writeTopicFile = vi.fn(async (_wg: string, relativePath: string): Promise<CuratorWriteResult> => {
      if (relativePath === 'people/oversized.md') {
        return { status: 'error', relative_path: relativePath, error: 'topic file exceeds 8192 bytes' };
      }
      return { status: 'success', relative_path: relativePath, sha256: 'a'.repeat(64) };
    });
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      markConsolidated: markFactsConsolidated,
      writeTopicFile,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: {
            files: [
              { path: 'people/oversized.md', content: 'Too big once frontmatter is carried forward.' },
              { path: 'people/maya-chen.md', content: 'Maya Chen is the Acme liaison.' },
            ],
          },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    // The pass SUCCEEDS: the good file lands, the bad one is reported, and the
    // tail is marked so the identical input is never re-presented.
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 1, rejectedCount: 1 });
    expect(d.failMaintenance).not.toHaveBeenCalled();
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: consolidation dropped topic files the writer refused',
      expect.objectContaining({
        rejected: [expect.objectContaining({ path: 'people/oversized.md' })],
      }),
    );
    warnSpy.mockRestore();
  });

  it('still fails the pass on a write conflict, which a retry can win', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      markConsolidated: markFactsConsolidated,
      writeTopicFile: vi.fn(
        async (_wg, relativePath): Promise<CuratorWriteResult> => ({
          status: 'conflict',
          relative_path: relativePath,
          error: 'expected_sha256 does not match the current file',
        }),
      ),
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/maya-chen.md', content: 'Maya Chen is the Acme liaison.' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toBeNull();
    expect(d.failMaintenance).toHaveBeenCalledOnce();
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set());
  });

  // F7. A failed index sync used to clear maintenance_pending, so a quiet
  // workgroup waited for 50 more accepted updates before anything retried.
  it('leaves maintenance pending when the index sync fails', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const completeMaintenance = vi.fn(() => true);
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      markConsolidated: markFactsConsolidated,
      completeMaintenance,
      syncIndexes: vi.fn(async () => {
        throw new Error('index CAS race lost');
      }),
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/maya-chen.md', content: 'Maya Chen is the Acme liaison.' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toMatchObject({ action: 'maintenance_written' });
    expect(completeMaintenance).toHaveBeenCalledWith(expect.anything(), 1000, true);
  });

  it('leaves maintenance pending when the index sync fails on an empty tail', async () => {
    const completeMaintenance = vi.fn(() => true);
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 0, leaseOwner: 'worker' }),
      consolidationTail: () => ({ facts: [], hasMore: false }),
      completeMaintenance,
      syncIndexes: vi.fn(async () => {
        throw new Error('index unreadable');
      }),
    });
    expect(await new MemoryCuratorWorker(d).runOne(1000)).toMatchObject({ action: 'maintenance_noop' });
    expect(completeMaintenance).toHaveBeenCalledWith(expect.anything(), 1000, true);
  });

  // An empty tail still gets the index pass: a workgroup whose whole topic
  // backlog predates index maintenance has nothing to consolidate and an
  // entirely unmapped set of files.
  it('syncs the memory index even when the tail is empty', async () => {
    const syncIndexes = vi.fn(async () => ({ updated: ['people/index.md'] }));
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 0, leaseOwner: 'worker' }),
      consolidationTail: () => ({ facts: [], hasMore: false }),
      syncIndexes,
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'maintenance_noop' });
    expect(syncIndexes).toHaveBeenCalledWith(TEST_WORKGROUP);
    expect(d.consolidate).not.toHaveBeenCalled();
  });

  // The index is the map upstream's memory system navigates by, so a
  // consolidation pass that writes files without touching it is the drift
  // this whole change exists to close.
  it('syncs the memory index after a consolidation pass', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const syncIndexes = vi.fn(async () => ({ updated: ['people/index.md', 'index.md'] }));
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      writeTopicFile: writeMemoryTopicFile,
      markConsolidated: markFactsConsolidated,
      syncIndexes,
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/maya-chen.md', content: 'Maya Chen is the Acme liaison.' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 1 });
    expect(syncIndexes).toHaveBeenCalledWith(TEST_WORKGROUP);
  });

  // Index maintenance is derived from disk and self-heals next pass, so it
  // must never roll a completed consolidation back into a retry loop.
  it('a failing index sync is logged and does not fail the pass', async () => {
    seedLedger(['# Generated workgroup memory', '', factLine('mem_aaaaaaaaaaaaaaaa', 'A fact.'), ''].join('\n'));
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const d = deps({
      claimMaintenance: () => ({ workgroupId: TEST_WORKGROUP, acceptedUpdates: 1, leaseOwner: 'worker' }),
      consolidationTail: dbConsolidationTail(),
      writeTopicFile: writeMemoryTopicFile,
      markConsolidated: markFactsConsolidated,
      syncIndexes: vi.fn(async () => {
        throw new Error('index CAS race lost');
      }),
      consolidate: vi.fn(
        async (_s, _u, credentialSlot): Promise<ConsolidationBackendResult> => ({
          decision: { files: [{ path: 'people/maya-chen.md', content: 'Maya Chen is the Acme liaison.' }] },
          model: 'claude-sonnet-5',
          credentialSlot,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }),
      ),
    });
    const report = await new MemoryCuratorWorker(d).runOne(1000);
    expect(report).toMatchObject({ action: 'maintenance_written', fileCount: 1 });
    expect(d.failMaintenance).not.toHaveBeenCalled();
    expect(consolidatedFactIds(TEST_WORKGROUP)).toEqual(new Set(['mem_aaaaaaaaaaaaaaaa']));
    expect(warnSpy).toHaveBeenCalledWith(
      'memory-curator: memory index sync failed',
      expect.objectContaining({ workgroupId: TEST_WORKGROUP }),
    );
    warnSpy.mockRestore();
  });

  // scanTopicFiles is the OTHER end of the stacked-header fix: the model can
  // only echo a marker it was shown.
  it('scanTopicFiles hides curator metadata and the folder index from the model', () => {
    const peopleDir = path.join(memoryDir(), 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    fs.writeFileSync(path.join(peopleDir, 'legacy.md'), '<!-- consolidated: facts=4 -->\nLegacy body.\n');
    fs.writeFileSync(
      path.join(peopleDir, 'modern.md'),
      '---\ntype: person\nconsolidated_facts: 2\n---\n\nModern body.\n',
    );
    fs.writeFileSync(path.join(peopleDir, 'index.md'), '# People\n\n- [Legacy](legacy.md) - Legacy body.\n');
    const scan = scanTopicFiles(TEST_WORKGROUP);
    expect(scan.files.map((file) => file.path)).toEqual(['people/legacy.md', 'people/modern.md']);
    expect(scan.files.every((file) => file.owned)).toBe(true);
    expect(scan.files.map((file) => file.content)).toEqual(['Legacy body.\n', 'Modern body.\n']);
    // The CAS hash is the RAW file's, not the stripped view's.
    expect(scan.files[0]!.sha256).toBe(readMemoryTopicFile(TEST_WORKGROUP, 'people/legacy.md').sha256);
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
