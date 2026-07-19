import { describe, expect, it } from 'vitest';

import {
  buildRuntimeDockerCommand,
  evaluateRuntimeEvidence,
  parseRuntimeCliArgs,
  REQUIRED_RUNTIME_SCENARIOS,
  runRuntimeQaScenario,
  type RuntimeCommandExecutor,
  type RuntimeEvidence,
} from './verify-graphify-runtime.js';

const MIB = 1024 * 1024;

function validEvidence(): RuntimeEvidence {
  return {
    schemaVersion: 1,
    image: 'candidate:latest',
    imageId: 'sha256:' + 'a'.repeat(64),
    isolatedRoot: '/tmp/nanoclaw-graphify-runtime-fixed',
    requestMb: 2048,
    limitMb: 5120,
    tmpfsBytes: 192 * MIB,
    scenarios: REQUIRED_RUNTIME_SCENARIOS.map((id) => ({
      id,
      passed: true,
      exitCode:
        id.endsWith('-timeout') || id.startsWith('oversize-') || id.endsWith('-limit') || id === 'enospc' ? 2 : 0,
      sourceFingerprint:
        id.includes('mutation') || ['initial', 'cached', 'modified', 'untracked', 'deleted', 'data-json'].includes(id)
          ? `fingerprint-${id}`
          : null,
      acceptedFingerprint:
        id.includes('mutation') || ['initial', 'cached', 'modified', 'untracked', 'deleted', 'data-json'].includes(id)
          ? `fingerprint-${id}`
          : null,
      staleQuery: false,
      runnerAlive: true,
      partialPromotion: false,
      debris: [],
      workerSpawns:
        id === 'cache-lock-timeout' || id === 'worker-lock-timeout' || id.startsWith('oversize-source-') ? 0 : 1,
      maxConcurrentWorkers: 1,
      wallTimeMs: 100,
      terminalReason: id.includes('lock-timeout') ? 'lock deadline expired' : 'ok',
      workerRssKiB: 20_000,
      workerVirtualKiB: 30_000,
      tmpfsHighWaterBytes: 1_024,
      cacheId:
        id === 'restart-cache' || id === 'sibling-sharing'
          ? 'shared-cache-id'
          : id === 'cross-thread-isolation'
            ? 'cache-b-id'
            : undefined,
      refreshes:
        id === 'same-worktree-coalescing' ? 1 : id === 'restart-cache' || id === 'sibling-sharing' ? 0 : undefined,
      retries: id.includes('mutation') ? 1 : undefined,
      ignoredMediaFiles: id === 'mixed-media' ? 3 : undefined,
      lockReplaced: id.includes('lock-timeout') ? false : undefined,
      termSent: id === 'query-timeout' || id === 'sigterm-ignore' ? true : undefined,
      killSent: id === 'sigterm-ignore' ? true : undefined,
      teardownMs: id === 'query-timeout' ? 100 : id === 'sigterm-ignore' ? 5_100 : undefined,
      command: ['docker', 'run', '--rm', 'candidate:latest'],
      stdoutBytes: 0,
      stderrBytes: 0,
      details:
        id === 'sigterm-ignore'
          ? { measured: { signals: [15, 9] } }
          : id === 'no-credentials'
            ? { credentialEnvironmentNames: [], credentialProbeEmitsNamesOnly: true }
            : id === 'restart-cache'
              ? { initialMode: 'refresh', mode: 'cached', initialCacheId: 'shared-cache-id' }
              : id === 'sibling-sharing'
                ? { mode: 'cached' }
                : id === 'cross-thread-isolation'
                  ? {
                      modeA: 'refresh',
                      modeB: 'refresh',
                      cacheRootsDistinct: true,
                      cacheRootInodesDistinct: true,
                      cacheIdsDistinct: true,
                      sentinelPresentInA: true,
                      sentinelCrossedToB: false,
                    }
                  : undefined,
    })),
    cgroup: {
      memoryCurrentBefore: 64 * MIB,
      memoryCurrentAfter: 64 * MIB,
      memoryPeak: 4_300 * MIB,
      memoryMax: 5_120 * MIB,
      eventsBefore: { oom: 0, oom_kill: 0 },
      eventsAfter: { oom: 0, oom_kill: 0 },
    },
    requestAccounting: {
      requestBytes: 2_048 * MIB,
      measuredPeakBytes: 4_300 * MIB,
      overageBytes: 2_252 * MIB,
    },
    repositoryClean: true,
    cacheBleed: false,
    orphanProcesses: 0,
    sourceStageDebris: [],
  };
}

describe('production-style Graphify runtime verifier', () => {
  it('test_runtime_verifier_parses_candidate_fixture_and_evidence_paths', () => {
    expect(
      parseRuntimeCliArgs([
        '--image',
        'candidate:latest',
        '--fixture-evidence',
        '/tmp/fixture-evidence.json',
        '--evidence',
        '/tmp/runtime-evidence.json',
      ]),
    ).toEqual({
      image: 'candidate:latest',
      fixtureEvidence: '/tmp/fixture-evidence.json',
      evidence: '/tmp/runtime-evidence.json',
    });
    expect(() => parseRuntimeCliArgs(['--image', 'candidate:latest'])).toThrow(/fixture-evidence/);
  });

  it('test_runtime_orchestrator_executes_scenario_in_production_container_and_parses_raw_marker', () => {
    const commands: string[][] = [];
    const marker = {
      scenario: 'same-worktree-coalescing',
      test_id: 'qa.ExactTest.test_coalesces',
      successful: true,
      tests_run: 1,
      fingerprint: null,
      subresult: {
        terminalReason: 'callers-coalesced',
        wallTimeMs: 100,
        sourceFingerprint: 'f'.repeat(64),
        acceptedFingerprint: 'f'.repeat(64),
        staleQuery: false,
        runnerAlive: true,
        partialPromotion: false,
        debris: [],
        workerSpawns: 3,
        maxConcurrentWorkers: 1,
        workerRssKiB: 20_000,
        workerVirtualKiB: 30_000,
        tmpfsHighWaterBytes: 1_024,
        refreshes: 1,
      },
      runner: {
        before: {
          kind: 'bun-sentinel',
          pid: 42,
          alive: true,
          heartbeat: { kind: 'bun-sentinel', pid: 42, sequence: 1, atMs: 100 },
        },
        after: {
          kind: 'bun-sentinel',
          pid: 42,
          alive: true,
          heartbeat: { kind: 'bun-sentinel', pid: 42, sequence: 2, atMs: 120 },
        },
      },
      before: {
        memory_current: 64 * MIB,
        memory_peak: 64 * MIB,
        memory_max: 5_120 * MIB,
        events: { oom: 0, oom_kill: 0 },
        graphify_processes: 1,
      },
      after: {
        memory_current: 65 * MIB,
        memory_peak: 80 * MIB,
        memory_max: 5_120 * MIB,
        events: { oom: 0, oom_kill: 0 },
        graphify_processes: 1,
      },
    };
    const executor: RuntimeCommandExecutor = {
      run(command) {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: `NANOCLAW_GRAPHIFY_E2 ${JSON.stringify(marker)}\n`,
          stderr: 'qa.ExactTest.test_coalesces ... ok\n',
        };
      },
    };
    const result = runRuntimeQaScenario(
      'same-worktree-coalescing',
      marker.test_id,
      {
        image: 'candidate:latest',
        worktreesPath: '/tmp/e2-fake/worktrees',
        cachePath: '/tmp/e2-fake/cache',
        runtimePath: '/tmp/e2-fake/runtime',
      },
      executor,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0].join(' ')).toContain('--network none --memory 5g --memory-reservation 2g');
    expect(commands[0].join(' ')).toContain('/usr/local/bin/bun /workspace/worktrees/qa/runner-sentinel.ts');
    expect(result.scenario.passed).toBe(true);
    expect(result.scenario.refreshes).toBe(1);
    expect(result.scenario.runnerAlive).toBe(true);
    expect(result.scenario.details?.cgroupAfter).toEqual(marker.after);
  });

  it('test_runtime_orchestrator_fails_closed_without_a_measured_subresult', () => {
    const executor: RuntimeCommandExecutor = {
      run() {
        return {
          exitCode: 0,
          stdout: `NANOCLAW_GRAPHIFY_E2 ${JSON.stringify({
            scenario: 'mixed-media',
            test_id: 'qa.ExactTest.test_media',
            successful: true,
            tests_run: 1,
            fingerprint: null,
            subresult: null,
            runner: {
              before: {
                kind: 'bun-sentinel',
                pid: 43,
                alive: true,
                heartbeat: { kind: 'bun-sentinel', pid: 43, sequence: 1, atMs: 100 },
              },
              after: {
                kind: 'bun-sentinel',
                pid: 43,
                alive: true,
                heartbeat: { kind: 'bun-sentinel', pid: 43, sequence: 2, atMs: 120 },
              },
            },
            before: {
              memory_current: 1,
              memory_peak: 1,
              memory_max: 5_120 * MIB,
              events: { oom: 0, oom_kill: 0 },
              graphify_processes: 1,
            },
            after: {
              memory_current: 1,
              memory_peak: 1,
              memory_max: 5_120 * MIB,
              events: { oom: 0, oom_kill: 0 },
              graphify_processes: 1,
            },
          })}\n`,
          stderr: '',
        };
      },
    };
    const result = runRuntimeQaScenario(
      'mixed-media',
      'qa.ExactTest.test_media',
      {
        image: 'candidate:latest',
        worktreesPath: '/tmp/e2-missing/worktrees',
        cachePath: '/tmp/e2-missing/cache',
        runtimePath: '/tmp/e2-missing/runtime',
      },
      executor,
    );

    expect(result.scenario.passed).toBe(false);
    expect(result.scenario.debris).toEqual(['missing-measured-debris']);
  });

  it('test_runtime_verifier_builds_exact_production_mount_contract', () => {
    const command = buildRuntimeDockerCommand({
      image: 'candidate:latest',
      name: 'graphify-e2-isolated',
      worktreesPath: '/tmp/graphify-e2/worktrees',
      cachePath: '/tmp/graphify-e2/cache',
      runtimePath: '/tmp/graphify-e2/runtime',
      workdir: '/workspace/worktrees/fixture',
      entrypoint: '/bin/sh',
      arguments: ['-lc', 'true'],
    });
    const rendered = command.join(' ');

    expect(command.slice(0, 3)).toEqual(['docker', 'run', '--rm']);
    expect(rendered).toContain('--user 1001:1001');
    expect(rendered).toContain('-e NANOCLAW_CONTAINER=1');
    expect(rendered).toContain('--memory 5g --memory-reservation 2g --memory-swap 5g');
    expect(rendered).toContain('--tmpfs /workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001');
    expect(rendered).toContain('/tmp/graphify-e2/cache:/workspace/.cache/graphify');
    expect(rendered).toContain('/tmp/graphify-e2/runtime:/run/nanoclaw-graphify');
    expect(rendered).not.toContain('/home/ubuntu/nanoclaw-v2/data/');
  });

  it('test_runtime_verifier_rejects_stale_content_and_uncontained_failures', () => {
    for (const [field, mutate, reason] of [
      ['stale', (e: RuntimeEvidence) => (e.scenarios[0].staleQuery = true), 'stale query'],
      ['overlap', (e: RuntimeEvidence) => (e.scenarios[0].maxConcurrentWorkers = 2), 'concurrent worker'],
      ['oom', (e: RuntimeEvidence) => (e.cgroup.eventsAfter.oom = 1), 'cgroup oom'],
      ['runner', (e: RuntimeEvidence) => (e.scenarios[0].runnerAlive = false), 'runner died'],
      ['partial', (e: RuntimeEvidence) => (e.scenarios[0].partialPromotion = true), 'partial promotion'],
    ] as const) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(evaluateRuntimeEvidence(evidence).failures.join('\n'), field).toMatch(new RegExp(reason, 'i'));
    }
  });

  it('test_runtime_verifier_accepts_isolated_bounded_end_to_end_evidence', () => {
    const result = evaluateRuntimeEvidence(validEvidence());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary).toEqual({
      imageId: 'sha256:' + 'a'.repeat(64),
      scenarioCount: REQUIRED_RUNTIME_SCENARIOS.length,
      peakReserveBytes: 820 * MIB,
      requestOverageBytes: 2_252 * MIB,
    });
  });

  it('test_runtime_verifier_requires_coalescing_mutation_media_and_oversize_matrix', () => {
    const missing = validEvidence();
    missing.scenarios = missing.scenarios.filter((entry) => entry.id !== 'oversize-source-count');
    expect(evaluateRuntimeEvidence(missing).failures.join('\n')).toMatch(/oversize-source-count/);

    const coalescing = validEvidence();
    coalescing.scenarios.find((entry) => entry.id === 'same-worktree-coalescing')!.refreshes = 2;
    expect(evaluateRuntimeEvidence(coalescing).failures.join('\n')).toMatch(/coalesc/i);

    const mutation = validEvidence();
    mutation.scenarios.find((entry) => entry.id === 'post-extract-mutation')!.retries = 0;
    expect(evaluateRuntimeEvidence(mutation).failures.join('\n')).toMatch(/mutation.*retry/i);

    const media = validEvidence();
    media.scenarios.find((entry) => entry.id === 'mixed-media')!.ignoredMediaFiles = 0;
    expect(evaluateRuntimeEvidence(media).failures.join('\n')).toMatch(/media/i);
  });

  it('test_runtime_verifier_requires_timeout_teardown_and_peak_reserve', () => {
    const noKill = validEvidence();
    noKill.scenarios.find((entry) => entry.id === 'sigterm-ignore')!.killSent = false;
    expect(evaluateRuntimeEvidence(noKill).failures.join('\n')).toMatch(/sigkill/i);

    const lowReserve = validEvidence();
    lowReserve.cgroup.memoryPeak = 4_700 * MIB;
    lowReserve.requestAccounting.measuredPeakBytes = 4_700 * MIB;
    lowReserve.requestAccounting.overageBytes = 2_652 * MIB;
    expect(evaluateRuntimeEvidence(lowReserve).failures.join('\n')).toMatch(/512 MiB reserve/i);
  });

  it('test_runtime_verifier_requires_cache_and_worker_lock_timeout_paths', () => {
    for (const id of ['cache-lock-timeout', 'worker-lock-timeout']) {
      const spawned = validEvidence();
      spawned.scenarios.find((entry) => entry.id === id)!.workerSpawns = 1;
      expect(evaluateRuntimeEvidence(spawned).failures.join('\n'), id).toMatch(/lock timeout.*worker/i);

      const replaced = validEvidence();
      replaced.scenarios.find((entry) => entry.id === id)!.lockReplaced = true;
      expect(evaluateRuntimeEvidence(replaced).failures.join('\n'), id).toMatch(/lock.*replaced/i);
    }
  });
});
