import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MEMORY_CURATOR_EFFORT, MEMORY_CURATOR_MODEL } from '../src/modules/memory/curator-backend.js';
import {
  curatorCorpusSha256,
  loadCuratorEvalFixture,
  runMemoryCuratorModelEvaluation,
  scoreCuratorTrial,
  type CuratorEvalCandidate,
  type CuratorEvalExecution,
  type CuratorEvalExecutor,
  type CuratorEvalOutput,
  type CuratorEvalPreflight,
} from './run-memory-curator-model-eval.js';

const FIXTURE_PATH = path.resolve('tests/fixtures/workgroup-memory-curator.json');

function perfectOutput(candidateCases: ReturnType<typeof loadCuratorEvalFixture>['cases']): CuratorEvalOutput {
  return {
    decisions: candidateCases.map((testCase) => ({
      caseId: testCase.id,
      action: testCase.expectedAction,
      reasonCode: testCase.acceptedReasons[0]!,
      memoryText:
        testCase.expectedAction === 'capture'
          ? `Durable memory: ${testCase.mustInclude.join(' ')}`
          : '',
    })),
  };
}

class FakeExecutor implements CuratorEvalExecutor {
  readonly calls: Array<{ candidateId: string; trial: number }> = [];

  async inspect(candidate: CuratorEvalCandidate): Promise<CuratorEvalPreflight> {
    return { candidateId: candidate.id, available: true, provenance: 'fake-runtime 1.0.0' };
  }

  async execute(candidate: CuratorEvalCandidate, trial: number): Promise<CuratorEvalExecution> {
    this.calls.push({ candidateId: candidate.id, trial });
    const fixture = loadCuratorEvalFixture(FIXTURE_PATH);
    return {
      candidateId: candidate.id,
      trial,
      requestedModel: candidate.model,
      returnedModel: candidate.model,
      effort: candidate.effort,
      provenance: 'fake-runtime 1.0.0',
      output: perfectOutput(fixture.cases),
      wallMs: 10,
      usage: { inputTokens: 100, outputTokens: 20 },
      toolAttempts: 0,
    };
  }
}

describe('memory curator model evaluation', () => {
  it('binds the production model and effort to the hash-verified selected fixture result', () => {
    const fixture = loadCuratorEvalFixture(FIXTURE_PATH);
    expect(fixture.corpusSha256).toBe(curatorCorpusSha256(fixture));
    expect(fixture.recordedSelection.corpusSha256).toBe(fixture.corpusSha256);
    const selected = fixture.candidates.find((candidate) => candidate.id === fixture.recordedSelection.selectedCandidateId);
    expect(selected).toMatchObject({ model: MEMORY_CURATOR_MODEL, effort: MEMORY_CURATOR_EFFORT });
    expect(fixture.recordedSelection.results.find((result) => result.candidateId === selected?.id)).toMatchObject({
      perfectTrials: 6,
      totalTrials: 6,
    });
  });

  it('weights a false-positive capture more heavily than an ordinary missed memory', () => {
    const fixture = loadCuratorEvalFixture(FIXTURE_PATH);
    const noopCase = fixture.cases.find((item) => item.expectedAction === 'noop')!;
    const captureCase = fixture.cases.find((item) => item.expectedAction === 'capture')!;
    const base = {
      candidateId: 'fake',
      trial: 1,
      requestedModel: 'fake-1',
      returnedModel: 'fake-1',
      effort: 'medium' as const,
      provenance: 'fake',
      wallMs: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolAttempts: 0,
    };
    const falsePositive = scoreCuratorTrial(fixture, [noopCase], {
      ...base,
      output: {
        decisions: [{ caseId: noopCase.id, action: 'capture', reasonCode: 'durable_fact', memoryText: 'noise' }],
      },
    });
    const falseNegative = scoreCuratorTrial(fixture, [captureCase], {
      ...base,
      output: {
        decisions: [{ caseId: captureCase.id, action: 'noop', reasonCode: 'transient', memoryText: '' }],
      },
    });
    expect(falsePositive.penalty).toBeGreaterThan(falseNegative.penalty);
  });

  it('runs three fresh trials for every exact candidate without fallback', async () => {
    const fixture = loadCuratorEvalFixture(FIXTURE_PATH);
    const executor = new FakeExecutor();
    const candidateIds = fixture.candidates.map((candidate) => candidate.id);
    const result = await runMemoryCuratorModelEvaluation(fixture, candidateIds, 3, 'all', executor);
    expect(result.status).toBe('COMPLETE');
    expect(result.pass).toBe(true);
    expect(executor.calls).toHaveLength(candidateIds.length * 3);
    expect(new Set(executor.calls.map((call) => call.candidateId))).toEqual(new Set(candidateIds));
  });

  it('blocks a dirty corpus before model execution', async () => {
    const fixture = loadCuratorEvalFixture(FIXTURE_PATH);
    fixture.cases[0]!.transcript += ' changed';
    const executor = new FakeExecutor();
    const result = await runMemoryCuratorModelEvaluation(
      fixture,
      [fixture.candidates[0]!.id],
      3,
      'all',
      executor,
    );
    expect(result.status).toBe('BLOCKED');
    expect(executor.calls).toEqual([]);
    expect(result.errors).toContain('fixture corpus hash is dirty');
  });
});
