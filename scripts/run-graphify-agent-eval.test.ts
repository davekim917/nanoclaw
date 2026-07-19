import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCandidateCliVersionCommand,
  buildCodexExecCommand,
  buildCodexEvalDockerCommand,
  buildEvaluationSnapshotBytes,
  buildPinnedCodexEvalDockerCommand,
  buildPublicClaimContract,
  commandAccessesForbiddenInstructions,
  commandInvokesGraphify,
  commandInvokesGraphifyRead,
  commandViolatesAuditableSourceContract,
  computeClaimContractSha256,
  computeEvaluatorSourceSha256,
  computePrivateProtocolSha256,
  filterEvaluationSourcePaths,
  findClaimIdLeaks,
  fingerprintSourceSnapshot,
  isNonFatalAuditableSearchMiss,
  isGraphifyTreatmentAdherent,
  parseCodexJsonlTrace,
  runAgentEvaluation,
  scoreEvalActivationGate,
  validateEvalRuns,
  validateEvalTaskFile,
  type EvalClaim,
  type EvalRun,
  type EvalSystemPrompts,
  type EvalTaskFile,
} from './run-graphify-agent-eval.js';

const TASKS = JSON.parse(
  readFileSync(new URL('../docs/specs/graphify-container-code-intelligence/eval/tasks.json', import.meta.url), 'utf8'),
) as EvalTaskFile;

const SYSTEMS: EvalSystemPrompts = {
  graphify: readFileSync(
    new URL('../docs/specs/graphify-container-code-intelligence/eval/v4/system-graphify.md', import.meta.url),
    'utf8',
  ),
  'source-only': readFileSync(
    new URL('../docs/specs/graphify-container-code-intelligence/eval/v4/system-source-only.md', import.meta.url),
    'utf8',
  ),
};

const EXPECTED_CLAIM_IDS: Record<string, string[]> = {
  'container-resource-resolution': [
    'install_default_memory_limit',
    'request_default_source',
    'omitted_request_with_explicit_limit',
    'request_may_exceed_limit',
    'swap_may_be_below_limit',
    'omitted_swap_without_explicit_limit',
    'omitted_swap_with_explicit_limit',
    'install_default_cpu_limit',
    'install_default_pids_limit',
  ],
  'graphify-container-contract': [
    'container_marker_value',
    'stage_mount_path',
    'stage_tmpfs_bytes',
    'stage_tmpfs_uid',
    'stage_tmpfs_gid',
    'memory_reservation_distinct_from_limit',
    'docker_memory_source',
    'docker_memory_reservation_source',
    'docker_memory_swap_source',
    'docker_memory_swap_semantics',
  ],
  'graphify-cache-identity': [
    'ordinary_cache_helper',
    'thread_sibling_cache_helper',
    'thread_worktrees_marker_value',
    'cache_container_mount',
    'worker_lock_container_mount',
  ],
  'memory-admission-priority': [
    'interactive_before_scheduled',
    'fifo_within_priority',
    'oversize_request_result',
    'release_drains_newly_admissible',
    'already_reserved_duplicate_status',
    'queued_scheduled_retry_promotes_interactive',
  ],
  'command-gate-routing': [
    'final_latest_message_selects_text',
    'leading_mentions_stripped',
    'dashboard_before_fanout',
    'unknown_slash_disposition',
    'admin_authorization_location',
    'filtered_command_action',
    'authorized_admin_command_action',
    'unauthorized_admin_command_action',
  ],
  'timezone-conversion-contract': [
    'invalid_timezone_result',
    'offset_timestamp_path',
    'naive_timestamp_path',
    'local_stamp_locale',
    'local_time_locale',
    'local_time_invalid_zone_behavior',
  ],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectedClaims(taskId: string): Record<string, unknown> {
  const task = TASKS.tasks.find((candidate) => candidate.id === taskId)!;
  return Object.fromEntries(task.claims.map((claim) => [claim.id, claim.expected]));
}

function oppositeValue(claim: EvalClaim): unknown {
  if (claim.type === 'boolean') return !claim.expected;
  if (claim.type === 'number') return Number(claim.expected) + 1;
  if (claim.type === 'string') return `${claim.expected}-wrong`;
  return claim.options!.find((option) => option !== claim.expected)!;
}

function validRuns(): EvalRun[] {
  const runs: EvalRun[] = [];
  for (const task of TASKS.tasks) {
    for (const arm of ['graphify', 'source-only'] as const) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        const sourceOutput = `${task.id}-${arm}-${repetition}-✓`;
        const toolCalls =
          arm === 'graphify'
            ? [
                { name: 'shell', arguments: 'cd repo && graphify query target', output: 'target\n' },
                { name: 'shell', arguments: `sed -n '1,200p' repo/${task.expectedFiles[0]}`, output: sourceOutput },
              ]
            : [
                {
                  name: 'shell',
                  arguments: `sed -n '1,200p' repo/${task.expectedFiles.join(' repo/')}`,
                  output: sourceOutput,
                },
              ];
        runs.push({
          runId: `${task.id}:${arm}:${repetition}`,
          taskId: task.id,
          arm,
          repetition,
          protocolVersion: 'v4',
          model: 'gpt-5.6-sol',
          modelVersion: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
          candidateImageId: 'sha256:' + 'd'.repeat(64),
          codexCliVersion: 'codex-cli 0.144.3',
          sourceSnapshotFingerprint: 'e'.repeat(64),
          sourceSnapshotFingerprintAfter: 'e'.repeat(64),
          sourceSnapshotFileCount: 1_400,
          repositoryCommit: 'a'.repeat(40),
          taskPrompt: task.prompt,
          systemPromptSha256: sha256(SYSTEMS[arm]),
          claimContractSha256: computeClaimContractSha256(task),
          privateProtocolSha256: computePrivateProtocolSha256(TASKS, SYSTEMS),
          evaluatorSourceSha256: computeEvaluatorSourceSha256(),
          toolIdentityAllowlist: ['shell'],
          maxToolCalls: 12,
          toolCallCount: toolCalls.length,
          toolCalls,
          toolOutputBytes: toolCalls.reduce((total, call) => total + Buffer.byteLength(call.output, 'utf8'), 0),
          filesOpened: [...task.expectedFiles],
          sourceBytes: 100,
          wallTimeMs: 1_000,
          peakCgroupMemoryBytes: 512 * 1024 * 1024,
          errors: [],
          answerClaims: expectedClaims(task.id),
          rawTrace: '{}\n',
          runtimeStderr: '',
          threadId: `thread-${task.id}-${arm}-${repetition}`,
          instructionIsolation: 'instruction-free-eval-root-with-nested-repo',
          filesOpenedMeasurementMethod: 'trace-command-and-path-prefixed-output',
          readonly: true,
          freshSession: true,
          byteCountingMethod: 'utf8-buffer-byte-length',
          cgroupMeasurementMethod: 'cgroup-v2-memory-peak',
        });
      }
    }
  }
  return withV4CommandEvidence(runs);
}

function withV4CommandEvidence(runs: EvalRun[]): EvalRun[] {
  for (const run of runs) {
    run.toolCalls.forEach((call, index) => {
      Object.assign(call, {
        exitCode: 0,
        exitClassification: 'success',
        startedSequence: index * 2 + 1,
        completedSequence: index * 2 + 2,
      });
    });
  }
  return runs;
}

function setGraphifyTreatmentAdherence(runs: EvalRun[], adherentCount: number): void {
  const graphifyRuns = runs.filter((run) => run.arm === 'graphify');
  graphifyRuns.forEach((run, index) => {
    const graphifyCall = run.toolCalls.find((call) => commandInvokesGraphifyRead(call.arguments))!;
    const sourceCall = run.toolCalls.find((call) => !commandInvokesGraphifyRead(call.arguments))!;
    Object.assign(graphifyCall, { startedSequence: index < adherentCount ? 1 : 3, completedSequence: 4 });
    Object.assign(sourceCall, { startedSequence: index < adherentCount ? 2 : 1, completedSequence: 2 });
  });
}

function parseCommandTrace(command: string, output: string, exitCode: number, repositoryFiles: string[]) {
  const trace = [
    { type: 'thread.started', thread_id: `${exitCode}:${command}` },
    { type: 'item.started', item: { id: 'command-1', type: 'command_execution', command } },
    {
      type: 'item.completed',
      item: { id: 'command-1', type: 'command_execution', command, aggregated_output: output, exit_code: exitCode },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  return parseCodexJsonlTrace(trace, repositoryFiles);
}

describe('Graphify versus source-only agent evaluation', () => {
  it('test_eval_v4_correctness_is_claim_only_and_execution_is_separate', () => {
    const runs = validRuns();
    const run = runs[0];
    run.filesOpened = [];
    run.errors.push('command exited 127');

    const validation = validateEvalRuns(TASKS, runs, SYSTEMS);
    const scored = validation.summary?.runs.find((candidate) => candidate.runId === run.runId);
    expect(scored?.correct).toBe(true);
    expect(scored?.executionGrounded).toBe(false);
    expect(validation.passed).toBe(false);
    expect(validation.failures.join('\n')).toMatch(/expected source file|execution error/i);
  });

  it('test_eval_v4_treatment_adherence_17_of_18_passes_16_fails', () => {
    const score = (adherentRuns: number) =>
      scoreEvalActivationGate({
        graphifyCorrectness: 1,
        sourceOnlyCorrectness: 1,
        graphifyMedianFilesOpened: 10,
        sourceOnlyMedianFilesOpened: 10,
        graphifyMedianToolOutputBytes: 80,
        sourceOnlyMedianToolOutputBytes: 100,
        graphifyRunCount: 18,
        sourceOnlyRunCount: 18,
        graphifyTreatmentAdherentRuns: adherentRuns,
        graphifyTreatmentAdherence: adherentRuns / 18,
      } as Parameters<typeof scoreEvalActivationGate>[0]);

    expect(score(17).passed).toBe(true);
    expect(score(16).passed).toBe(false);
    expect(score(16).failures.join('\n')).toMatch(/treatment adherence/i);
  });

  it('test_eval_v4_nonadherent_rows_remain_in_all_denominators', () => {
    const runs = validRuns();
    setGraphifyTreatmentAdherence(runs, 17);
    const nonadherent = runs.filter((run) => run.arm === 'graphify')[17];
    const task = TASKS.tasks.find((candidate) => candidate.id === nonadherent.taskId)!;
    nonadherent.answerClaims[task.claims[0].id] = oppositeValue(task.claims[0]);

    const metrics = validateEvalRuns(TASKS, runs, SYSTEMS).summary!.metrics;
    expect(metrics.graphifyRunCount).toBe(18);
    expect(metrics.sourceOnlyRunCount).toBe(18);
    expect(metrics.graphifyTreatmentAdherentRuns).toBe(17);
    expect(metrics.graphifyTreatmentAdherence).toBe(17 / 18);
    expect(metrics.graphifyCorrectness).toBe(17 / 18);
  });

  it('test_eval_v4_treatment_requires_graphify_start_before_source_start_even_if_completion_overlaps', () => {
    const run = validRuns().find((candidate) => candidate.arm === 'graphify')!;
    const graphifyCall = run.toolCalls.find((call) => commandInvokesGraphifyRead(call.arguments))!;
    const sourceCall = run.toolCalls.find((call) => !commandInvokesGraphifyRead(call.arguments))!;
    Object.assign(graphifyCall, { startedSequence: 1, completedSequence: 4 });
    Object.assign(sourceCall, { startedSequence: 2, completedSequence: 3 });
    run.toolCalls = [sourceCall, graphifyCall];
    expect(isGraphifyTreatmentAdherent(run)).toBe(true);

    Object.assign(graphifyCall, { startedSequence: 3 });
    Object.assign(sourceCall, { startedSequence: 1 });
    expect(isGraphifyTreatmentAdherent(run)).toBe(false);
  });

  it('test_eval_v4_help_does_not_count_as_treatment', () => {
    const run = validRuns().find((candidate) => candidate.arm === 'graphify')!;
    run.toolCalls[0].arguments = "/bin/bash -lc 'graphify query --help'";
    expect(isGraphifyTreatmentAdherent(run)).toBe(false);
    expect(commandInvokesGraphify(run.toolCalls[0].arguments)).toBe(true);
    expect(commandInvokesGraphifyRead(run.toolCalls[0].arguments)).toBe(false);
  });

  it('test_eval_v4_source_only_graphify_is_zero_tolerance', () => {
    const runs = validRuns();
    const sourceOnly = runs.find((run) => run.arm === 'source-only')!;
    sourceOnly.toolCalls.push({
      name: 'shell',
      arguments: "/bin/bash -lc 'cd repo && graphify query target'",
      output: 'target\n',
      exitCode: 0,
      exitClassification: 'success',
      startedSequence: 3,
      completedSequence: 4,
    });
    sourceOnly.toolCallCount = sourceOnly.toolCalls.length;
    sourceOnly.toolOutputBytes += Buffer.byteLength('target\n', 'utf8');

    const validation = validateEvalRuns(TASKS, runs, SYSTEMS);
    expect(validation.passed).toBe(false);
    expect(validation.failures.join('\n')).toMatch(/source-only arm invoked Graphify/i);
  });

  it('test_eval_v4_partial_rg_exit_2_with_attributed_match_is_nonfatal', () => {
    const command = "/bin/bash -lc 'cd repo && rg -n resolveTimezone src test'";
    const output = 'repo/src/timezone.ts:95:export function resolveTimezone() {}\n';
    expect(isNonFatalAuditableSearchMiss(command, 2, output, ['src/timezone.ts'])).toBe(true);
    const parsed = parseCommandTrace(command, output, 2, ['src/timezone.ts']);
    expect(parsed.errors).toEqual([]);
    expect(parsed.toolCalls[0]).toMatchObject({ exitCode: 2, exitClassification: 'nonfatal-partial-rg' });
  });

  it('test_eval_v4_partial_rg_exit_2_without_match_is_fatal', () => {
    const command = "/bin/bash -lc 'cd repo && rg -n resolveTimezone src test'";
    expect(isNonFatalAuditableSearchMiss(command, 2, '', ['src/timezone.ts'])).toBe(false);
    const parsed = parseCommandTrace(command, '', 2, ['src/timezone.ts']);
    expect(parsed.errors).toContain('command exited 2');
    expect(parsed.toolCalls[0]).toMatchObject({ exitCode: 2, exitClassification: 'fatal' });
  });

  it('test_eval_v4_non_rg_or_unauditable_exit_2_is_fatal', () => {
    const attributed = 'repo/src/timezone.ts:95:export function resolveTimezone() {}\n';
    for (const command of [
      "/bin/bash -lc 'cd repo && grep resolveTimezone src/timezone.ts'",
      "/bin/bash -lc 'cd repo && rg --no-filename resolveTimezone src'",
      "/bin/bash -lc 'cd repo && rg --files src'",
    ]) {
      expect(isNonFatalAuditableSearchMiss(command, 2, attributed, ['src/timezone.ts']), command).toBe(false);
      const parsed = parseCommandTrace(command, attributed, 2, ['src/timezone.ts']);
      expect(parsed.errors, command).toContain('command exited 2');
      expect(parsed.toolCalls[0], command).toMatchObject({ exitCode: 2, exitClassification: 'fatal' });
    }
  });

  it('test_eval_v4_mixed_or_pipelined_rg_exit_2_is_fatal', () => {
    const attributed = 'repo/src/timezone.ts:95:export function resolveTimezone() {}\n';
    for (const command of [
      "/bin/bash -lc 'cd repo && rg -n resolveTimezone src test; grep resolveTimezone src/timezone.ts'",
      "/bin/bash -lc 'cd repo && rg -n resolveTimezone src test | head -n 1'",
    ]) {
      expect(isNonFatalAuditableSearchMiss(command, 2, attributed, ['src/timezone.ts']), command).toBe(false);
      const parsed = parseCommandTrace(command, attributed, 2, ['src/timezone.ts']);
      expect(parsed.errors, command).toContain('command exited 2');
      expect(parsed.toolCalls[0], command).toMatchObject({ exitCode: 2, exitClassification: 'fatal' });
    }
  });

  it('test_eval_v4_paths_hashes_and_retained_evidence_refusal', () => {
    const evalRoot = new URL('../docs/specs/graphify-container-code-intelligence/eval/', import.meta.url);
    const immutablePaths = {
      tasks: new URL('tasks.json', evalRoot),
      v3Graphify: new URL('v3/system-graphify.md', evalRoot),
      v3SourceOnly: new URL('v3/system-source-only.md', evalRoot),
      v4Graphify: new URL('v4/system-graphify.md', evalRoot),
      v4SourceOnly: new URL('v4/system-source-only.md', evalRoot),
    };
    expect(sha256(readFileSync(immutablePaths.tasks, 'utf8'))).toBe(
      'a127246560e621fb8a02fdba6b2467e0c0a1b5f26cd292f10c973ecece1bd133',
    );
    expect(sha256(readFileSync(immutablePaths.v3Graphify, 'utf8'))).toBe(
      'a2883c7352e39ce7a74dec3e6cee2f47f775e2f47ed713df262d4410976b10a2',
    );
    expect(sha256(readFileSync(immutablePaths.v3SourceOnly, 'utf8'))).toBe(
      '3ae7c8abb9a13bba65a3e3f3285ce5a9208022b5d131362809ceabf3a08a9a7c',
    );
    expect(sha256(readFileSync(immutablePaths.v4Graphify, 'utf8'))).toBe(
      '706708927cfb5b99a8502bbe387844beaad0fdbc2cb6d0422746544dc427b541',
    );
    expect(sha256(readFileSync(immutablePaths.v4SourceOnly, 'utf8'))).toBe(
      'e0f4274f11a14a6dbeb43431b48f8aff782a95ccf9815fa015eb1fa19832a944',
    );

    const root = mkdtempSync(path.join(os.tmpdir(), 'graphify-v4-retained-eval-'));
    try {
      const outputDirectory = path.join(root, 'qa-evidence', 'v4');
      mkdirSync(outputDirectory, { recursive: true });
      const rawPath = path.join(outputDirectory, 'agent-eval-runs.jsonl');
      writeFileSync(rawPath, '{"retained":true}\n');
      const result = runAgentEvaluation({
        tasksPath: immutablePaths.tasks.pathname,
        graphifySystemPath: immutablePaths.v4Graphify.pathname,
        sourceOnlySystemPath: immutablePaths.v4SourceOnly.pathname,
        outputDirectory,
        repositoryRoot: '/must/not/be-read',
        image: 'must-not-be-inspected',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        codexAuthPath: '/must/not-be-read',
      });
      expect(result.status).toBe('BLOCKED');
      expect(result.reason).toMatch(/refusing to replace or selectively rerun/i);
      expect(readFileSync(rawPath, 'utf8')).toBe('{"retained":true}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('test_eval_schema_enforces_six_by_three_by_two_balanced_runs', () => {
    expect(validateEvalTaskFile(TASKS)).toEqual({ passed: true, failures: [] });
    expect(Object.fromEntries(TASKS.tasks.map((task) => [task.id, task.claims.map((claim) => claim.id)]))).toEqual(
      EXPECTED_CLAIM_IDS,
    );
    expect(validateEvalRuns(TASKS, validRuns(), SYSTEMS).passed).toBe(true);

    const missing = validRuns().slice(1);
    expect(validateEvalRuns(TASKS, missing, SYSTEMS).failures.join('\n')).toMatch(/36|missing/i);

    const duplicate = validRuns();
    duplicate[1] = { ...duplicate[0] };
    expect(validateEvalRuns(TASKS, duplicate, SYSTEMS).failures.join('\n')).toMatch(/duplicate|missing/i);

    for (const task of TASKS.tasks) {
      const publicContract = JSON.stringify(buildPublicClaimContract(task));
      expect(publicContract).not.toContain('"expected"');
      expect(publicContract).not.toContain('expectedFiles');
    }
  });

  it('test_eval_scorer_enforces_correctness_and_efficiency_thresholds', () => {
    expect(
      scoreEvalActivationGate({
        graphifyCorrectness: 0.9,
        sourceOnlyCorrectness: 0.9,
        graphifyMedianFilesOpened: 11,
        sourceOnlyMedianFilesOpened: 10,
        graphifyMedianToolOutputBytes: 80,
        sourceOnlyMedianToolOutputBytes: 100,
        graphifyRunCount: 18,
        sourceOnlyRunCount: 18,
        graphifyTreatmentAdherentRuns: 18,
        graphifyTreatmentAdherence: 1,
      }).passed,
    ).toBe(true);
    expect(
      scoreEvalActivationGate({
        graphifyCorrectness: 1,
        sourceOnlyCorrectness: 1,
        graphifyMedianFilesOpened: 8,
        sourceOnlyMedianFilesOpened: 10,
        graphifyMedianToolOutputBytes: 110,
        sourceOnlyMedianToolOutputBytes: 100,
        graphifyRunCount: 18,
        sourceOnlyRunCount: 18,
        graphifyTreatmentAdherentRuns: 18,
        graphifyTreatmentAdherence: 1,
      }).passed,
    ).toBe(true);
    for (const metrics of [
      [0.899, 0.8, 10, 10, 80, 100],
      [0.9, 0.91, 10, 10, 80, 100],
      [1, 1, 8.01, 10, 110, 100],
      [1, 1, 8, 10, 110.01, 100],
      [1, 1, 11.01, 10, 80, 100],
      [1, 1, 10, 10, 0, 0],
    ]) {
      expect(
        scoreEvalActivationGate({
          graphifyCorrectness: metrics[0],
          sourceOnlyCorrectness: metrics[1],
          graphifyMedianFilesOpened: metrics[2],
          sourceOnlyMedianFilesOpened: metrics[3],
          graphifyMedianToolOutputBytes: metrics[4],
          sourceOnlyMedianToolOutputBytes: metrics[5],
          graphifyRunCount: 18,
          sourceOnlyRunCount: 18,
          graphifyTreatmentAdherentRuns: 18,
          graphifyTreatmentAdherence: 1,
        }).passed,
      ).toBe(false);
    }
  });

  it('test_eval_rejects_prompt_model_tool_commit_claim_or_reasoning_drift', () => {
    const variants: Array<[string, (run: EvalRun) => void]> = [
      ['prompt', (run) => (run.taskPrompt += ' arm hint')],
      ['model', (run) => (run.modelVersion = 'different')],
      ['reasoning', (run) => (run.reasoningEffort = 'high')],
      ['protocol', (run) => (run.protocolVersion = 'v1')],
      ['tools', (run) => run.toolIdentityAllowlist.push('read_file')],
      ['commit', (run) => (run.repositoryCommit = 'd'.repeat(40))],
      ['claims', (run) => (run.claimContractSha256 = '0'.repeat(64))],
      ['private-protocol', (run) => (run.privateProtocolSha256 = '0'.repeat(64))],
      ['evaluator-source', (run) => (run.evaluatorSourceSha256 = '0'.repeat(64))],
      ['system', (run) => (run.systemPromptSha256 = '0'.repeat(64))],
      ['calls', (run) => (run.toolCalls = Array.from({ length: 13 }, () => run.toolCalls[0]))],
      ['bytes', (run) => (run.toolOutputBytes += 1)],
      ['image', (run) => (run.candidateImageId = 'sha256:' + 'f'.repeat(64))],
      ['cli', (run) => (run.codexCliVersion = 'codex-cli 0.999.0')],
      ['snapshot', (run) => (run.sourceSnapshotFingerprint = 'f'.repeat(64))],
    ];
    for (const [name, mutate] of variants) {
      const runs = validRuns();
      mutate(runs[0]);
      expect(validateEvalRuns(TASKS, runs, SYSTEMS).passed, name).toBe(false);
    }
  });

  it('independently rejects tampered stored runs with unauditable shell commands', () => {
    const runs = validRuns();
    const run = runs.find(
      (candidate) => candidate.taskId === 'timezone-conversion-contract' && candidate.arm === 'source-only',
    )!;
    run.toolCalls[0].arguments = "/bin/bash -lc 'cd repo && jq . src/timezone.ts'";
    const validation = validateEvalRuns(TASKS, runs, SYSTEMS);
    expect(validation.passed).toBe(false);
    expect(validation.failures.join('\n')).toMatch(/auditable source-navigation contract/i);
  });

  it('recognizes shell-quoted public Graphify invocations in either arm', () => {
    const graphifyRuns = validRuns();
    const graphifyRun = graphifyRuns.find((candidate) => candidate.arm === 'graphify')!;
    graphifyRun.toolCalls[0].arguments = "/bin/bash -lc 'graphify query target'";
    expect(validateEvalRuns(TASKS, graphifyRuns, SYSTEMS).passed).toBe(true);

    const sourceOnlyRuns = validRuns();
    const sourceOnlyRun = sourceOnlyRuns.find((candidate) => candidate.arm === 'source-only')!;
    sourceOnlyRun.toolCalls.push({
      name: 'shell',
      arguments: '/bin/bash -lc "graphify query target"',
      output: 'target\n',
      exitCode: 0,
      exitClassification: 'success',
      startedSequence: 3,
      completedSequence: 4,
    });
    sourceOnlyRun.toolCallCount = sourceOnlyRun.toolCalls.length;
    sourceOnlyRun.toolOutputBytes += Buffer.byteLength('target\n', 'utf8');
    const validation = validateEvalRuns(TASKS, sourceOnlyRuns, SYSTEMS);
    expect(validation.passed).toBe(false);
    expect(validation.failures.join('\n')).toMatch(/source-only arm invoked Graphify/i);
  });

  it('requires a real Graphify read and does not count side-effect-free help', () => {
    expect(SYSTEMS.graphify).toContain('must start before any ordinary source search or source-content read');
    expect(SYSTEMS.graphify).toContain('Do not run `graphify --help`');
    for (const command of [
      "/bin/bash -lc 'graphify query target'",
      '/bin/bash -lc "cd repo && /usr/local/bin/graphify path from to"',
      "/bin/bash -lc 'graphify explain target; graphify affected target'",
    ]) {
      expect(commandInvokesGraphifyRead(command), command).toBe(true);
    }
    for (const command of [
      "/bin/bash -lc 'graphify query --help'",
      '/bin/bash -lc "graphify path -h"',
      "/bin/bash -lc 'echo graphify query target'",
      "/bin/bash -lc 'mygraphify query target'",
    ]) {
      expect(commandInvokesGraphifyRead(command), command).toBe(false);
    }

    for (const command of [
      "/bin/bash -lc 'graphify --help'",
      '/bin/bash -lc "cd repo && /usr/local/bin/graphify version"',
      "/bin/bash -lc 'rg target repo | graphify query target'",
    ]) {
      expect(commandInvokesGraphify(command), command).toBe(true);
    }
    for (const command of [
      '/bin/bash -lc \'rg -n "sessionGraphifyCacheDir|worker-lock|graphify" repo/src repo/container\'',
      "/bin/bash -lc 'echo graphify query target'",
      `/bin/bash -lc 'rg -n ";graphify query target" repo/src'`,
    ]) {
      expect(commandInvokesGraphify(command), command).toBe(false);
    }

    const runs = validRuns();
    for (const graphifyRun of runs.filter((candidate) => candidate.arm === 'graphify').slice(0, 2)) {
      graphifyRun.toolCalls[0].arguments = "/bin/bash -lc 'graphify query --help'";
    }
    const validation = validateEvalRuns(TASKS, runs, SYSTEMS);
    expect(validation.passed).toBe(true);
    expect(validation.summary?.metrics.graphifyTreatmentAdherentRuns).toBe(16);
    expect(validation.summary?.activation.failures.join('\n')).toMatch(/treatment adherence/i);
  });

  it('scores exact typed structured claims for all six tasks', () => {
    const validation = validateEvalRuns(TASKS, validRuns(), SYSTEMS);
    expect(validation.summary?.runs.every((run) => run.correct)).toBe(true);

    for (const task of TASKS.tasks) {
      const base = validRuns();
      const run = base.find((candidate) => candidate.taskId === task.id)!;
      const first = task.claims[0];

      run.answerClaims[first.id] = oppositeValue(first);
      let scored = validateEvalRuns(TASKS, base, SYSTEMS).summary?.runs.find(
        (candidate) => candidate.runId === run.runId,
      )!;
      expect(scored.correct, `${task.id}: opposite`).toBe(false);
      expect(scored.invalidClaims).toContain(first.id);

      const missing = validRuns();
      const missingRun = missing.find((candidate) => candidate.taskId === task.id)!;
      delete missingRun.answerClaims[first.id];
      scored = validateEvalRuns(TASKS, missing, SYSTEMS).summary?.runs.find(
        (candidate) => candidate.runId === missingRun.runId,
      )!;
      expect(scored.correct, `${task.id}: missing`).toBe(false);
      expect(scored.missingClaims).toContain(first.id);

      const extra = validRuns();
      const extraRun = extra.find((candidate) => candidate.taskId === task.id)!;
      extraRun.answerClaims.unexpected = true;
      scored = validateEvalRuns(TASKS, extra, SYSTEMS).summary?.runs.find(
        (candidate) => candidate.runId === extraRun.runId,
      )!;
      expect(scored.correct, `${task.id}: extra`).toBe(false);
      expect(scored.extraClaims).toContain('unexpected');

      const wrongType = validRuns();
      const wrongTypeRun = wrongType.find((candidate) => candidate.taskId === task.id)!;
      wrongTypeRun.answerClaims[first.id] = { value: first.expected };
      scored = validateEvalRuns(TASKS, wrongType, SYSTEMS).summary?.runs.find(
        (candidate) => candidate.runId === wrongTypeRun.runId,
      )!;
      expect(scored.correct, `${task.id}: wrong type`).toBe(false);
      expect(scored.invalidClaims).toContain(first.id);
    }
  });

  it('maps the retained probe semantics to exact task-one values and counts files/errors independently', () => {
    const runs = validRuns();
    runs[0].answerClaims = {
      install_default_memory_limit: '3g',
      request_default_source: 'memoryReservation',
      omitted_request_with_explicit_limit: 'limitMb',
      request_may_exceed_limit: false,
      swap_may_be_below_limit: false,
      omitted_swap_without_explicit_limit: 'memorySwapLimit',
      omitted_swap_with_explicit_limit: 'limitMb',
      install_default_cpu_limit: 'unset',
      install_default_pids_limit: 512,
    };
    expect(validateEvalRuns(TASKS, runs, SYSTEMS).summary?.runs[0].correct).toBe(true);

    const missingFile = validRuns();
    missingFile[0].filesOpened = [];
    const missingValidation = validateEvalRuns(TASKS, missingFile, SYSTEMS);
    expect(missingValidation.summary?.runs[0].correct).toBe(true);
    expect(missingValidation.passed).toBe(false);
    const runtimeError = validRuns();
    runtimeError[0].errors.push('timeout');
    const runtimeValidation = validateEvalRuns(TASKS, runtimeError, SYSTEMS);
    expect(runtimeValidation.summary?.runs[0].correct).toBe(true);
    expect(runtimeValidation.passed).toBe(false);
  });

  it('validates structured task schemas before creating raw evidence', () => {
    const invalid = structuredClone(TASKS);
    invalid.tasks[0].claims[0].expected = true;
    expect(validateEvalTaskFile(invalid).failures.join('\n')).toMatch(/wrong type/i);
    const missingClaims = structuredClone(TASKS) as unknown as { tasks: Array<{ claims?: unknown }> };
    delete missingClaims.tasks[0].claims;
    expect(validateEvalTaskFile(missingClaims as unknown as EvalTaskFile).failures.join('\n')).toMatch(/claims/i);

    const root = mkdtempSync(path.join(os.tmpdir(), 'graphify-invalid-eval-'));
    try {
      const tasksPath = path.join(root, 'tasks.json');
      const outputDirectory = path.join(root, 'output');
      writeFileSync(tasksPath, JSON.stringify(invalid));
      const result = runAgentEvaluation({
        tasksPath,
        graphifySystemPath: '/does/not/exist',
        sourceOnlySystemPath: '/does/not/exist',
        outputDirectory,
        repositoryRoot: '/does/not/exist',
        image: 'candidate:latest',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        codexAuthPath: '/does/not/exist',
      });
      expect(result.status).toBe('BLOCKED');
      expect(existsSync(path.join(outputDirectory, 'agent-eval-runs.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins private ground truth, expected files, both prompt byte streams, and protocol constants', () => {
    const baseline = computePrivateProtocolSha256(TASKS, SYSTEMS);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);

    const changedTruth = structuredClone(TASKS);
    changedTruth.tasks[0].claims[0].expected = 'memoryLimit';
    expect(computePrivateProtocolSha256(changedTruth, SYSTEMS)).not.toBe(baseline);

    const changedFiles = structuredClone(TASKS);
    changedFiles.tasks[0].expectedFiles.push('src/extra.ts');
    expect(computePrivateProtocolSha256(changedFiles, SYSTEMS)).not.toBe(baseline);

    expect(computePrivateProtocolSha256(TASKS, { ...SYSTEMS, graphify: `${SYSTEMS.graphify}\nchanged` })).not.toBe(
      baseline,
    );
    expect(
      computePrivateProtocolSha256(TASKS, {
        ...SYSTEMS,
        'source-only': `${SYSTEMS['source-only']}\nchanged`,
      }),
    ).not.toBe(baseline);
    expect(computePrivateProtocolSha256(TASKS, SYSTEMS, '0'.repeat(64))).not.toBe(
      computePrivateProtocolSha256(TASKS, SYSTEMS, '1'.repeat(64)),
    );
  });

  it('builds immutable, fresh, read-only candidate Codex commands', () => {
    const base = {
      containerName: 'graphify-eval-task-1',
      worktreesPath: '/tmp/eval/worktrees',
      cachePath: '/tmp/eval/cache',
      runtimePath: '/tmp/eval/runtime',
      codexHomePath: '/tmp/eval/codex-home',
    };
    const rendered = buildCodexEvalDockerCommand({ ...base, image: 'candidate:latest' }).join(' ');
    expect(rendered).toContain('--memory 5g --memory-reservation 2g --memory-swap 5g');
    expect(rendered).toContain('/tmp/eval/worktrees:/workspace/worktrees:ro');
    expect(rendered).toContain('-e CODEX_HOME=/home/node/.codex');
    expect(rendered).toContain('--workdir /workspace/worktrees/eval-root');

    expect(buildCodexExecCommand('graphify-eval-task-1', 'gpt-5.6-sol', 'xhigh')).toContain('--skip-git-repo-check');
    const immutable = 'sha256:' + 'd'.repeat(64);
    expect(buildCandidateCliVersionCommand(immutable)).toContain(immutable);
    expect(buildPinnedCodexEvalDockerCommand(immutable, base)).toContain(immutable);
    expect(() => buildCandidateCliVersionCommand('candidate:latest')).toThrow(/immutable sha256/i);
    expect(() => buildPinnedCodexEvalDockerCommand('candidate:latest', base)).toThrow(/immutable sha256/i);
  });

  it('fingerprints exact source paths and content independent of enumeration order', () => {
    const files = new Map([
      ['src/b.ts', Buffer.from('export const b = 2;\n')],
      ['src/a.ts', Buffer.from('export const a = 1;\n')],
    ]);
    const first = fingerprintSourceSnapshot(files);
    expect(fingerprintSourceSnapshot(new Map([...files].reverse()))).toBe(first);
    expect(fingerprintSourceSnapshot(new Map([...files, ['src/a.ts', Buffer.from('export const a = 3;\n')]]))).not.toBe(
      first,
    );
  });

  it('materializes deterministic zero-byte ownership markers only for exact included pairing sources', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'graphify-eval-marker-'));
    try {
      const pairing = path.join(root, 'setup/pair-chat.ts');
      const marker = path.join(root, '.claude/skills/add-chat/SKILL.md');
      mkdirSync(path.dirname(pairing), { recursive: true });
      mkdirSync(path.dirname(marker), { recursive: true });
      writeFileSync(pairing, "import '../src/channels/chat-pairing.js';\n");
      writeFileSync(marker, '# secret instructions\nrequest_default_source: memoryReservation\n');

      const first = buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']);
      expect([...first.keys()].sort()).toEqual(['.claude/skills/add-chat/SKILL.md', 'setup/pair-chat.ts']);
      expect(first.get('.claude/skills/add-chat/SKILL.md')).toEqual(Buffer.alloc(0));
      expect(Buffer.concat([...first.values()]).toString('utf8')).not.toContain('secret instructions');
      expect(Buffer.concat([...first.values()]).toString('utf8')).not.toContain('memoryReservation');
      expect(first.size).toBe(2);
      const fingerprint = fingerprintSourceSnapshot(first);
      const tampered = new Map(first);
      tampered.set('.claude/skills/add-chat/SKILL.md', Buffer.from('tampered'));
      expect(fingerprintSourceSnapshot(tampered)).not.toBe(fingerprint);

      writeFileSync(marker, '# entirely different private skill content\n');
      expect(fingerprintSourceSnapshot(buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']))).toBe(fingerprint);
      const nonSetupPairing = path.join(root, 'scripts/pair-chat.ts');
      mkdirSync(path.dirname(nonSetupPairing), { recursive: true });
      writeFileSync(nonSetupPairing, "import '../src/channels/chat-pairing.js';\n");
      expect(buildEvaluationSnapshotBytes(root, ['scripts/pair-chat.ts']).has('.claude/skills/add-chat/SKILL.md')).toBe(
        false,
      );
      expect(() => buildEvaluationSnapshotBytes(root, ['.claude/skills/add-chat/SKILL.md'])).toThrow(
        /forbidden authoritative \.claude content/i,
      );

      rmSync(marker);
      const absent = buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']);
      expect(absent.size).toBe(1);
      expect(fingerprintSourceSnapshot(absent)).not.toBe(fingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an included pairing source has an absent or wrong ownership marker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'graphify-eval-marker-negative-'));
    try {
      const pairing = path.join(root, 'setup/pair-chat.ts');
      mkdirSync(path.dirname(pairing), { recursive: true });
      writeFileSync(pairing, "import '../src/channels/chat-pairing.js';\n");
      expect(buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']).has('.claude/skills/add-chat/SKILL.md')).toBe(
        false,
      );

      const wrongMarker = path.join(root, '.claude/skills/add-other/SKILL.md');
      mkdirSync(path.dirname(wrongMarker), { recursive: true });
      writeFileSync(wrongMarker, '# wrong owner\n');
      expect(buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']).has('.claude/skills/add-chat/SKILL.md')).toBe(
        false,
      );
      expect(buildEvaluationSnapshotBytes(root, ['setup/pair-chat.ts']).has('.claude/skills/add-other/SKILL.md')).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses shell-only traces, exact bytes, thread identity, and structured claims', () => {
    const output = '95 repo/src/timezone.ts\n✓\n';
    const claims = expectedClaims('timezone-conversion-contract');
    const trace = [
      { type: 'thread.started', thread_id: 'fresh' },
      {
        type: 'item.started',
        item: { id: 'command-1', type: 'command_execution', command: "/bin/bash -lc 'wc -l repo/src/timezone.ts'" },
      },
      {
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: "/bin/bash -lc 'wc -l repo/src/timezone.ts'",
          aggregated_output: output,
          exit_code: 0,
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ claims }) },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const parsed = parseCodexJsonlTrace(trace, ['src/timezone.ts']);
    expect(parsed.toolCalls[0].name).toBe('shell');
    expect(parsed.toolOutputBytes).toBe(Buffer.byteLength(output, 'utf8'));
    expect(parsed.filesOpened).toEqual(['src/timezone.ts']);
    expect(parsed.answerClaims).toEqual(claims);
    expect(parsed.threadId).toBe('fresh');
    expect(parsed.errors).toEqual([]);
  });

  it('rejects free prose or extra top-level response properties and actionable non-shell items', () => {
    const badFinals = [
      { answer: 'prose', claims: {} },
      { claims: {}, filesOpened: [] },
      { claims: {}, facts: [] },
    ];
    for (const final of badFinals) {
      const trace = [
        { type: 'thread.started', thread_id: JSON.stringify(final) },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(final) } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
      expect(parseCodexJsonlTrace(trace, []).errors.join('\n')).toMatch(/schema-valid/i);
    }
    const fenced = [
      { type: 'thread.started', thread_id: 'fenced' },
      { type: 'item.completed', item: { type: 'agent_message', text: '```json\n{"claims":{}}\n```' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseCodexJsonlTrace(fenced, []).errors.join('\n')).toMatch(/schema-valid/i);
    const actionable = [
      { type: 'thread.started', thread_id: 'fresh' },
      { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/timezone.ts' }] } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseCodexJsonlTrace(actionable, []).toolCalls[0]?.name).toBe('file_change');
  });

  it('physically excludes instructions and all private eval surfaces, then rejects any residual claim-id leak', () => {
    expect(
      filterEvaluationSourcePaths([
        'src/timezone.ts',
        'AGENTS.md',
        'CLAUDE.md',
        '.claude/settings.json',
        '.codex/config.toml',
        'container/CLAUDE.md',
        'docs/specs/graphify-container-code-intelligence/eval/tasks.json',
        'docs/specs/graphify-container-code-intelligence/eval/system-graphify.md',
        'docs/specs/graphify-container-code-intelligence/qa-evidence/agent-eval-probe.json',
        'docs/specs/graphify-container-code-intelligence/qa-evidence/agent-eval-runs.jsonl',
        'docs/specs/graphify-container-code-intelligence/qa-evidence/v2/agent-eval-runs.jsonl',
        'scripts/run-graphify-agent-eval.ts',
        'scripts/run-graphify-agent-eval.test.ts',
      ]),
    ).toEqual(['container/CLAUDE.md', 'src/timezone.ts']);
    expect(findClaimIdLeaks(TASKS, new Map([['src/clean.ts', Buffer.from('export const clean = true;')]]))).toEqual([]);
    expect(
      findClaimIdLeaks(TASKS, new Map([['src/leak.ts', Buffer.from('const answer = "request_default_source";')]])),
    ).toEqual(['src/leak.ts: leaked claim id request_default_source']);
    for (const command of [
      "sed -n '1,80p' repo/AGENTS.md",
      'cat repo/CLAUDE.md',
      'find repo/.claude -type f',
      'rg token repo/.codex/config.toml',
    ]) {
      expect(commandAccessesForbiddenInstructions(command), command).toBe(true);
    }
    expect(commandAccessesForbiddenInstructions('cat repo/container/CLAUDE.md')).toBe(false);
  });

  it('counts explicit and recursive attributed reads identically while ignoring prose-only filenames', () => {
    const traces = [
      ["/bin/bash -lc 'sed -n 1,80p repo/src/timezone.ts'", 'export function resolveTimezone() {}\n'],
      ["/bin/bash -lc 'rg resolveTimezone repo/src'", 'repo/src/timezone.ts:export function resolveTimezone() {}\n'],
    ];
    for (const [command, output] of traces) {
      const trace = [
        { type: 'thread.started', thread_id: command },
        {
          type: 'item.completed',
          item: { type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
      for (const arm of ['graphify', 'source-only']) {
        expect(parseCodexJsonlTrace(trace, ['src/timezone.ts']).filesOpened, arm).toEqual(['src/timezone.ts']);
      }
    }
    const prose = [
      { type: 'thread.started', thread_id: 'prose' },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: "/bin/bash -lc 'printf guidance'",
          aggregated_output: 'Please inspect src/timezone.ts for details.\n',
          exit_code: 0,
        },
      },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseCodexJsonlTrace(prose, ['src/timezone.ts']).filesOpened).toEqual([]);
  });

  it('fails closed on unattributable bulk or glob source reads', () => {
    for (const command of ["/bin/bash -lc 'cat repo/src/*.ts'", "/bin/bash -lc 'rg --no-filename timezone repo/src'"]) {
      const trace = [
        { type: 'thread.started', thread_id: command },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command,
            aggregated_output: 'unattributed source content\n',
            exit_code: 0,
          },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
      expect(parseCodexJsonlTrace(trace, ['src/timezone.ts']).errors.join('\n'), command).toMatch(/unobservable bulk/i);
    }
  });

  it('rejects interpreter, Git-content, find-exec, xargs, redirect, and other unauditable read bypasses', () => {
    for (const command of [
      ...['python', 'python3', 'node', 'bun', 'ruby', 'deno', 'php', 'perl'].map(
        (runtime) => `/bin/bash -lc '${runtime} -e "read repo/src/timezone.ts"'`,
      ),
      "/bin/bash -lc 'git -C repo show HEAD:src/timezone.ts'",
      "/bin/bash -lc 'git -C repo grep resolveTimezone'",
      "/bin/bash -lc 'find repo/src -type f -exec cat {} +'",
      "/bin/bash -lc 'find repo/src -type f -print0 | xargs -0 cat'",
      "/bin/bash -lc 'wc -c < repo/src/timezone.ts'",
      "/bin/bash -lc 'jq . repo/package.json'",
      "/bin/bash -lc 'cd repo && jq . package.json'",
      "/bin/bash -lc 'cd repo && dd if=src/timezone.ts'",
      "/bin/bash -lc 'cd repo && wc -c < src/timezone.ts'",
      "/bin/bash -lc 'cd repo && cat src/*.ts'",
      "/bin/bash -lc 'cd repo && rg --no-filename timezone src'",
      "/bin/bash -lc 'cat repo/src/*.ts'",
    ]) {
      expect(commandViolatesAuditableSourceContract(command), command).toBe(true);
    }
    for (const command of [
      "/bin/bash -lc 'cd repo && cat src/timezone.ts'",
      "/bin/bash -lc 'sed -n 1,80p repo/src/timezone.ts'",
      "/bin/bash -lc 'cd repo && grep resolveTimezone src/timezone.ts'",
      "/bin/bash -lc 'rg resolveTimezone repo/src'",
      "/bin/bash -lc 'cd repo && head -n 20 src/timezone.ts'",
      "/bin/bash -lc 'cd repo && tail -n 20 src/timezone.ts'",
      '/bin/bash -lc \'cd repo && awk "NR <= 20" src/timezone.ts\'',
      "/bin/bash -lc 'cd repo && wc -l src/timezone.ts'",
      '/bin/bash -lc \'find repo/src -type f -name "*.ts" -print\'',
      '/bin/bash -lc \'rg -n "python|node|graphify" repo/src repo/container\'',
      "/bin/bash -lc 'pwd && ls repo/src'",
    ]) {
      expect(commandViolatesAuditableSourceContract(command), command).toBe(false);
    }
  });

  it('treats only auditable grep/rg exit 1 as a non-fatal search miss', () => {
    const parsedErrors = (command: string, exitCode: number): string[] => {
      const trace = [
        { type: 'thread.started', thread_id: `${exitCode}:${command}` },
        { type: 'item.started', item: { id: 'command-1', type: 'command_execution', command } },
        {
          type: 'item.completed',
          item: { id: 'command-1', type: 'command_execution', command, aggregated_output: '', exit_code: exitCode },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"claims":{}}' } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
      return parseCodexJsonlTrace(trace, ['src/timezone.ts']).errors;
    };

    const grep = "/bin/bash -lc 'grep missing repo/src/timezone.ts'";
    const rg = "/bin/bash -lc 'cd repo && rg missing src/timezone.ts'";
    expect(isNonFatalAuditableSearchMiss(grep, 1)).toBe(true);
    expect(isNonFatalAuditableSearchMiss(rg, 1)).toBe(true);
    expect(parsedErrors(grep, 1)).toEqual([]);
    expect(parsedErrors(rg, 1)).toEqual([]);
    expect(parsedErrors(grep, 2)).toContain('command exited 2');
    expect(parsedErrors(rg, 127)).toContain('command exited 127');
    expect(parsedErrors("/bin/bash -lc 'cd repo && graphify query missing'", 1)).toContain('command exited 1');
  });
});
