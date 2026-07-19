#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyFixtureInImage, type FixtureVerificationEvidence } from './verify-graphify-fixture.js';

const MIB = 1024 * 1024;
const REQUIRED_RESERVE_BYTES = 512 * MIB;

const RUNNER_SENTINEL_SOURCE = `import { writeFileSync } from "node:fs";

const heartbeatPath = process.argv[2];
if (!heartbeatPath) throw new Error("heartbeat path is required");
let sequence = 0;
const beat = () => {
  sequence += 1;
  writeFileSync(heartbeatPath, JSON.stringify({ kind: "bun-sentinel", pid: process.pid, sequence, atMs: Date.now() }));
};
beat();
const timer = setInterval(beat, 20);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
`;

const QA_CONTAINER_COMMAND = [
  'heartbeat=/tmp/nanoclaw-e2-runner-heartbeat.json',
  'rm -f "$heartbeat"',
  '/usr/local/bin/bun /workspace/worktrees/qa/runner-sentinel.ts "$heartbeat" &',
  'sentinel=$!',
  'attempt=0',
  'while [ "$attempt" -lt 100 ] && [ ! -s "$heartbeat" ]; do attempt=$((attempt + 1)); sleep 0.02; done',
  'NANOCLAW_E2_SENTINEL_PID="$sentinel" NANOCLAW_E2_SENTINEL_HEARTBEAT="$heartbeat" /opt/graphify/bin/python /workspace/worktrees/qa/qa-runner.py "$1" "$2"',
  'status=$?',
  'kill -TERM "$sentinel" 2>/dev/null || true',
  'wait "$sentinel" 2>/dev/null || true',
  'exit "$status"',
].join('\n');

export const REQUIRED_RUNTIME_SCENARIOS = [
  'help',
  'version',
  'initial',
  'cached',
  'modified',
  'untracked',
  'deleted',
  'data-json',
  'no-credentials',
  'restart-cache',
  'sibling-sharing',
  'cross-thread-isolation',
  'same-worktree-coalescing',
  'cross-worktree-global-admission',
  'cache-lock-timeout',
  'worker-lock-timeout',
  'alternating-mutation',
  'post-extract-mutation',
  'mixed-media',
  'oversize-source-file',
  'oversize-source-count',
  'oversize-source-bytes',
  'oversize-ast',
  'oversize-graph',
  'oversize-metadata',
  'oversize-query-output',
  'oversize-worker-request',
  'corrupt-live-recovery',
  'corrupt-backup-recovery',
  'memory-limit',
  'file-limit',
  'process-limit',
  'thread-limit',
  'output-limit',
  'query-timeout',
  'sigterm-ignore',
  'enospc',
  'cgroup-telemetry',
] as const;

export type RuntimeScenarioId = (typeof REQUIRED_RUNTIME_SCENARIOS)[number];

export interface RuntimeScenarioEvidence {
  id: RuntimeScenarioId;
  passed: boolean;
  exitCode: number;
  sourceFingerprint: string | null;
  acceptedFingerprint: string | null;
  staleQuery: boolean;
  runnerAlive: boolean;
  partialPromotion: boolean;
  debris: string[];
  workerSpawns: number;
  maxConcurrentWorkers: number;
  wallTimeMs?: number;
  terminalReason?: string;
  workerRssKiB?: number | null;
  workerVirtualKiB?: number | null;
  tmpfsHighWaterBytes?: number;
  cacheId?: string | null;
  refreshes?: number;
  retries?: number;
  ignoredMediaFiles?: number;
  lockReplaced?: boolean;
  termSent?: boolean;
  killSent?: boolean;
  teardownMs?: number;
  command: string[];
  stdoutBytes: number;
  stderrBytes: number;
  details?: Record<string, unknown>;
}

export interface RuntimeEvidence {
  schemaVersion: 1;
  image: string;
  imageId: string;
  isolatedRoot: string;
  requestMb: number;
  limitMb: number;
  tmpfsBytes: number;
  scenarios: RuntimeScenarioEvidence[];
  cgroup: {
    memoryCurrentBefore: number;
    memoryCurrentAfter: number;
    memoryPeak: number;
    memoryMax: number;
    eventsBefore: { oom: number; oom_kill: number };
    eventsAfter: { oom: number; oom_kill: number };
  };
  requestAccounting: {
    requestBytes: number;
    measuredPeakBytes: number;
    overageBytes: number;
  };
  repositoryClean: boolean;
  cacheBleed: boolean;
  orphanProcesses: number;
  sourceStageDebris: string[];
}

export interface RuntimeGateResult {
  passed: boolean;
  failures: string[];
  summary: {
    imageId: string;
    scenarioCount: number;
    peakReserveBytes: number;
    requestOverageBytes: number;
  };
}

export interface RuntimeDockerInvocation {
  image: string;
  name: string;
  worktreesPath: string;
  cachePath: string;
  runtimePath: string;
  workdir: string;
  entrypoint: string;
  arguments: string[];
  readonlyWorktrees?: boolean;
}

export interface RuntimeCliOptions {
  image: string;
  fixtureEvidence: string;
  evidence: string;
}

export interface RuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeCommandExecutor {
  run(command: string[]): RuntimeCommandResult;
}

function requireIsolatedPath(value: string): string {
  const resolved = path.resolve(value);
  const productionData = path.resolve(process.cwd(), 'data');
  if (!path.isAbsolute(value) || resolved === productionData || resolved.startsWith(`${productionData}${path.sep}`)) {
    throw new Error(`runtime verification path is not isolated: ${value}`);
  }
  return resolved;
}

export function buildRuntimeDockerCommand(invocation: RuntimeDockerInvocation): string[] {
  const worktrees = requireIsolatedPath(invocation.worktreesPath);
  const cache = requireIsolatedPath(invocation.cachePath);
  const runtime = requireIsolatedPath(invocation.runtimePath);
  return [
    'docker',
    'run',
    '--rm',
    '--name',
    invocation.name,
    '--user',
    '1001:1001',
    '--network',
    'none',
    '--memory',
    '5g',
    '--memory-reservation',
    '2g',
    '--memory-swap',
    '5g',
    '--pids-limit',
    '256',
    '-e',
    'NANOCLAW_CONTAINER=1',
    '--tmpfs',
    '/workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001',
    '-v',
    `${worktrees}:/workspace/worktrees${invocation.readonlyWorktrees ? ':ro' : ''}`,
    '-v',
    `${cache}:/workspace/.cache/graphify`,
    '-v',
    `${runtime}:/run/nanoclaw-graphify`,
    '--workdir',
    invocation.workdir,
    '--entrypoint',
    invocation.entrypoint,
    invocation.image,
    ...invocation.arguments,
  ];
}

export function parseRuntimeCliArgs(args: string[]): RuntimeCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value)
      throw new Error(`missing value for runtime verifier argument: ${flag ?? '<none>'}`);
    values.set(flag, value);
  }
  const image = values.get('--image');
  const fixtureEvidence = values.get('--fixture-evidence');
  const evidence = values.get('--evidence');
  if (!image) throw new Error('--image is required');
  if (!fixtureEvidence) throw new Error('--fixture-evidence is required');
  if (!evidence) throw new Error('--evidence is required');
  for (const flag of values.keys()) {
    if (!['--image', '--fixture-evidence', '--evidence'].includes(flag))
      throw new Error(`unknown runtime verifier argument: ${flag}`);
  }
  return { image, fixtureEvidence: path.resolve(fixtureEvidence), evidence: path.resolve(evidence) };
}

function add(failures: string[], condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

export function evaluateRuntimeEvidence(evidence: RuntimeEvidence): RuntimeGateResult {
  const failures: string[] = [];
  const peakReserveBytes = evidence.cgroup.memoryMax - evidence.cgroup.memoryPeak;
  const scenarioById = new Map(evidence.scenarios.map((scenario) => [scenario.id, scenario]));
  const presentIds = new Set(evidence.scenarios.map((scenario) => scenario.id));

  add(failures, evidence.schemaVersion === 1, 'unsupported runtime evidence schema');
  add(failures, evidence.requestMb === 2048, 'request accounting must remain 2048 MiB');
  add(failures, evidence.limitMb === 5120, 'hard limit must be 5120 MiB');
  add(failures, evidence.tmpfsBytes === 192 * MIB, 'tmpfs must be exactly 192 MiB');
  add(failures, path.isAbsolute(evidence.isolatedRoot), 'runtime root must be isolated and absolute');
  for (const id of REQUIRED_RUNTIME_SCENARIOS) {
    add(failures, presentIds.has(id), `missing required runtime scenario: ${id}`);
  }
  add(failures, evidence.scenarios.length === presentIds.size, 'runtime evidence contains duplicate scenarios');
  add(
    failures,
    evidence.scenarios.every((scenario) => REQUIRED_RUNTIME_SCENARIOS.includes(scenario.id)),
    'runtime evidence contains an unknown scenario',
  );

  for (const scenario of evidence.scenarios) {
    add(failures, scenario.passed, `${scenario.id}: scenario did not meet its expected outcome`);
    add(failures, !scenario.staleQuery, `${scenario.id}: stale query was observed`);
    add(failures, scenario.runnerAlive, `${scenario.id}: runner died during worker failure`);
    add(failures, !scenario.partialPromotion, `${scenario.id}: partial promotion was exposed`);
    add(failures, scenario.debris.length === 0, `${scenario.id}: source/cache debris remains`);
    add(failures, scenario.maxConcurrentWorkers <= 1, `${scenario.id}: concurrent worker overlap exceeded one`);
    add(
      failures,
      typeof scenario.wallTimeMs === 'number' && Number.isFinite(scenario.wallTimeMs) && scenario.wallTimeMs >= 0,
      `${scenario.id}: measured wall time is missing`,
    );
    add(failures, Boolean(scenario.terminalReason), `${scenario.id}: terminal reason is missing`);
    if (scenario.workerSpawns > 0) {
      add(
        failures,
        typeof scenario.workerRssKiB === 'number' && scenario.workerRssKiB > 0,
        `${scenario.id}: worker RSS measurement is missing`,
      );
      add(
        failures,
        typeof scenario.workerVirtualKiB === 'number' && scenario.workerVirtualKiB > 0,
        `${scenario.id}: worker virtual-size measurement is missing`,
      );
    }
  }

  for (const id of [
    'initial',
    'cached',
    'modified',
    'untracked',
    'deleted',
    'data-json',
    'alternating-mutation',
    'post-extract-mutation',
  ] as const) {
    const scenario = scenarioById.get(id);
    if (!scenario) continue;
    add(
      failures,
      Boolean(scenario.sourceFingerprint) && scenario.sourceFingerprint === scenario.acceptedFingerprint,
      `${id}: accepted fingerprint differs from current source`,
    );
  }

  const coalescing = scenarioById.get('same-worktree-coalescing');
  if (coalescing) {
    add(failures, coalescing.refreshes === 1, 'same-worktree callers did not coalesce to one refresh');
    add(failures, coalescing.maxConcurrentWorkers === 1, 'same-worktree coalescing overlapped workers');
  }
  const globalAdmission = scenarioById.get('cross-worktree-global-admission');
  if (globalAdmission)
    add(failures, globalAdmission.maxConcurrentWorkers === 1, 'global worker admission overlapped workers');

  const noCredentials = scenarioById.get('no-credentials');
  if (noCredentials) {
    const names = noCredentials.details?.credentialEnvironmentNames;
    add(failures, Array.isArray(names), 'no-credentials: effective environment name scan is missing');
    add(
      failures,
      Array.isArray(names) && names.length === 0,
      'no-credentials: credential-bearing environment names were present',
    );
    add(
      failures,
      noCredentials.details?.credentialProbeEmitsNamesOnly === true,
      'no-credentials: probe did not prove that only environment names were emitted',
    );
  }
  const restartCache = scenarioById.get('restart-cache');
  if (restartCache) {
    add(
      failures,
      restartCache.details?.initialMode === 'refresh',
      'restart-cache: setup container did not refresh the cache',
    );
    add(failures, restartCache.details?.mode === 'cached', 'restart-cache: fresh container did not reuse the cache');
    add(
      failures,
      Boolean(restartCache.cacheId) && restartCache.cacheId === restartCache.details?.initialCacheId,
      'restart-cache: fresh container used a different cache identity',
    );
    add(failures, restartCache.refreshes === 0, 'restart-cache: fresh container performed an unexpected refresh');
  }
  const siblingSharing = scenarioById.get('sibling-sharing');
  if (siblingSharing && restartCache) {
    add(
      failures,
      siblingSharing.details?.mode === 'cached',
      'sibling-sharing: sibling container did not reuse the shared cache',
    );
    add(
      failures,
      Boolean(siblingSharing.cacheId) && siblingSharing.cacheId === restartCache.cacheId,
      'sibling-sharing: sibling container used a different cache identity',
    );
    add(failures, siblingSharing.refreshes === 0, 'sibling-sharing: sibling container performed an unexpected refresh');
  }
  const crossThread = scenarioById.get('cross-thread-isolation');
  if (crossThread) {
    add(
      failures,
      crossThread.details?.modeA === 'refresh' && crossThread.details?.modeB === 'refresh',
      'cross-thread-isolation: isolated caches were not independently refreshed',
    );
    add(
      failures,
      crossThread.details?.cacheRootsDistinct === true,
      'cross-thread-isolation: cache roots were not distinct',
    );
    add(
      failures,
      crossThread.details?.cacheRootInodesDistinct === true,
      'cross-thread-isolation: cache root inodes were not distinct',
    );
    add(
      failures,
      crossThread.details?.cacheIdsDistinct === true,
      'cross-thread-isolation: cache identities were not distinct',
    );
    add(
      failures,
      crossThread.details?.sentinelPresentInA === true,
      'cross-thread-isolation: source sentinel was not present in cache A',
    );
    add(
      failures,
      crossThread.details?.sentinelCrossedToB === false,
      'cross-thread-isolation: cache A sentinel crossed into cache B',
    );
  }

  for (const id of ['alternating-mutation', 'post-extract-mutation'] as const) {
    const scenario = scenarioById.get(id);
    if (scenario) add(failures, (scenario.retries ?? 0) >= 1, `${id}: mutation did not retry before query`);
  }
  const media = scenarioById.get('mixed-media');
  if (media) add(failures, (media.ignoredMediaFiles ?? 0) > 0, 'mixed media was not demonstrably ignored');

  for (const id of ['oversize-source-file', 'oversize-source-count', 'oversize-source-bytes'] as const) {
    const scenario = scenarioById.get(id);
    if (scenario) add(failures, scenario.workerSpawns === 0, `${id}: oversized source spawned Graphify`);
  }

  for (const id of ['cache-lock-timeout', 'worker-lock-timeout'] as const) {
    const scenario = scenarioById.get(id);
    if (!scenario) continue;
    add(failures, scenario.workerSpawns === 0, `${id}: lock timeout spawned a worker`);
    add(failures, scenario.lockReplaced === false, `${id}: stable lock inode was replaced`);
    add(
      failures,
      Boolean(/expired|deadline/i.test(scenario.terminalReason ?? '')),
      `${id}: lock timeout reason is missing`,
    );
  }

  const queryTimeout = scenarioById.get('query-timeout');
  if (queryTimeout) {
    add(failures, queryTimeout.termSent === true, 'query timeout did not send SIGTERM');
    add(failures, (queryTimeout.teardownMs ?? Infinity) <= 5_500, 'query timeout teardown exceeded TERM grace');
  }
  const sigtermIgnore = scenarioById.get('sigterm-ignore');
  if (sigtermIgnore) {
    add(failures, sigtermIgnore.termSent === true, 'SIGTERM-ignore fixture did not receive SIGTERM');
    add(failures, sigtermIgnore.killSent === true, 'SIGTERM-ignore fixture did not receive SIGKILL');
    add(
      failures,
      (sigtermIgnore.teardownMs ?? 0) >= 4_900,
      'SIGTERM-ignore did not exercise the production five-second grace',
    );
    add(
      failures,
      (sigtermIgnore.teardownMs ?? Infinity) <= 5_500,
      'SIGTERM-ignore teardown exceeded five-second grace',
    );
    const signals = (sigtermIgnore.details?.measured as { signals?: unknown } | undefined)?.signals;
    add(
      failures,
      JSON.stringify(signals) === JSON.stringify([15, 9]),
      'SIGTERM-ignore signal order was not TERM then KILL',
    );
  }

  add(failures, evidence.cgroup.memoryMax === 5120 * MIB, 'cgroup memory.max differs from 5120 MiB');
  add(
    failures,
    peakReserveBytes >= REQUIRED_RESERVE_BYTES,
    'measured peak leaves less than the required 512 MiB reserve',
  );
  add(
    failures,
    evidence.cgroup.eventsAfter.oom === evidence.cgroup.eventsBefore.oom &&
      evidence.cgroup.eventsAfter.oom_kill === evidence.cgroup.eventsBefore.oom_kill,
    'cgroup OOM or OOM-kill event incremented',
  );
  const expectedOverage = Math.max(
    0,
    evidence.requestAccounting.measuredPeakBytes - evidence.requestAccounting.requestBytes,
  );
  add(
    failures,
    evidence.requestAccounting.requestBytes === 2048 * MIB,
    'request bytes must be reported separately at 2048 MiB',
  );
  add(
    failures,
    evidence.requestAccounting.overageBytes === expectedOverage,
    'request overage accounting is inconsistent',
  );
  add(failures, evidence.repositoryClean, 'fixture repository is not clean after runtime verification');
  add(failures, !evidence.cacheBleed, 'cross-thread cache bleed was observed');
  add(failures, evidence.orphanProcesses === 0, 'orphan Graphify processes remain');
  add(failures, evidence.sourceStageDebris.length === 0, 'source-stage debris remains');

  return {
    passed: failures.length === 0,
    failures,
    summary: {
      imageId: evidence.imageId,
      scenarioCount: evidence.scenarios.length,
      peakReserveBytes,
      requestOverageBytes: evidence.requestAccounting.overageBytes,
    },
  };
}

const QA_RUNNER_SOURCE = `from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

def integer(path: str) -> int:
    value = Path(path).read_text().strip()
    return 0 if value == "max" else int(value)

def events() -> dict[str, int]:
    values = {}
    for line in Path("/sys/fs/cgroup/memory.events").read_text().splitlines():
        key, value = line.split()
        values[key] = int(value)
    return {"oom": values.get("oom", 0), "oom_kill": values.get("oom_kill", 0)}

def graphify_processes() -> int:
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\\0", b" ").lower()
        except OSError:
            continue
        if b"graphify" in command:
            count += 1
    return count

def process_alive(pid: int) -> bool:
    return pid > 0 and Path(f"/proc/{pid}").exists()

def read_heartbeat(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None

scenario, test_id = sys.argv[1:3]
sentinel_pid = int(os.environ.get("NANOCLAW_E2_SENTINEL_PID", "0"))
heartbeat_path = Path(os.environ.get("NANOCLAW_E2_SENTINEL_HEARTBEAT", "/missing-heartbeat"))
runner_before = {
    "kind": "bun-sentinel",
    "pid": sentinel_pid,
    "alive": process_alive(sentinel_pid),
    "heartbeat": read_heartbeat(heartbeat_path),
}
result_path = Path(f"/tmp/nanoclaw-e2-result-{os.getpid()}.json")
os.environ["NANOCLAW_E2_RESULT_PATH"] = str(result_path)
before = {
    "memory_current": integer("/sys/fs/cgroup/memory.current"),
    "memory_peak": integer("/sys/fs/cgroup/memory.peak"),
    "memory_max": integer("/sys/fs/cgroup/memory.max"),
    "events": events(),
    "graphify_processes": graphify_processes(),
}
suite = unittest.defaultTestLoader.loadTestsFromName(test_id)
result = unittest.TextTestRunner(verbosity=2).run(suite)
subresult = None
if result_path.exists():
    subresult = json.loads(result_path.read_text())
    result_path.unlink()
before_sequence = (runner_before.get("heartbeat") or {}).get("sequence", -1)
deadline = __import__("time").monotonic() + 0.5
runner_after_heartbeat = read_heartbeat(heartbeat_path)
while (runner_after_heartbeat or {}).get("sequence", -1) <= before_sequence and __import__("time").monotonic() < deadline:
    __import__("time").sleep(0.02)
    runner_after_heartbeat = read_heartbeat(heartbeat_path)
runner_after = {
    "kind": "bun-sentinel",
    "pid": sentinel_pid,
    "alive": process_alive(sentinel_pid),
    "heartbeat": runner_after_heartbeat,
}
after = {
    "memory_current": integer("/sys/fs/cgroup/memory.current"),
    "memory_peak": integer("/sys/fs/cgroup/memory.peak"),
    "memory_max": integer("/sys/fs/cgroup/memory.max"),
    "events": events(),
    "graphify_processes": graphify_processes(),
}
print("NANOCLAW_GRAPHIFY_E2 " + json.dumps({
    "scenario": scenario,
    "test_id": test_id,
    "successful": result.wasSuccessful(),
    "tests_run": result.testsRun,
    "subresult": subresult,
    "fingerprint": None,
    "runner": {"before": runner_before, "after": runner_after},
    "before": before,
    "after": after,
}, sort_keys=True))
raise SystemExit(0 if result.wasSuccessful() else 1)
`;

const QA_PROBE_SOURCE = `from __future__ import annotations
import contextlib
import hashlib
import importlib.util
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).parents[1]

def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

class ExactRuntimeProbe(unittest.TestCase):
    def setUp(self):
        self.gateway = load("candidate_gateway_probe", "graphify-gateway.py")
        self.worker = load("candidate_worker_probe", "graphify-worker.py")
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def _record(self, **values):
        result = {
            "terminalReason": "ok",
            "wallTimeMs": 0.0,
            "sourceFingerprint": None,
            "acceptedFingerprint": None,
            "staleQuery": False,
            "partialPromotion": False,
            "debris": [],
            "workerSpawns": 0,
            "maxConcurrentWorkers": 0,
            "workerRssKiB": None,
            "workerVirtualKiB": None,
            "tmpfsHighWaterBytes": 0,
        }
        result.update(values)
        Path(os.environ["NANOCLAW_E2_RESULT_PATH"]).write_text(json.dumps(result, sort_keys=True))

    def _timed_cap(self, cap: int):
        started = time.monotonic()
        target = self.root / "oversized.bin"
        with target.open("wb") as stream:
            stream.truncate(cap + 1)
        reason = None
        try:
            self.gateway._stream_hash(target, cap)
        except self.gateway.ValidationError as error:
            reason = str(error)
        self.assertIsNotNone(reason)
        target.unlink()
        self._record(terminalReason=reason, wallTimeMs=(time.monotonic() - started) * 1000)

    def _expect_stream_cap(self, cap: int):
        self._timed_cap(cap)

    def test_oversize_ast_is_rejected(self):
        self._expect_stream_cap(self.gateway.MAX_AST_BYTES)

    def test_oversize_graph_is_rejected(self):
        self._expect_stream_cap(self.gateway.MAX_GRAPH_BYTES)

    def test_oversize_metadata_is_rejected(self):
        started = time.monotonic()
        target = self.root / "status.json"
        with target.open("wb") as stream:
            stream.truncate(self.gateway.MAX_METADATA_BYTES + 1)
        reason = None
        try:
            self.gateway._read_bounded_json(target, self.gateway.MAX_METADATA_BYTES)
        except self.gateway.ValidationError as error:
            reason = str(error)
        self.assertIsNotNone(reason)
        target.unlink()
        self._record(terminalReason=reason, wallTimeMs=(time.monotonic() - started) * 1000)

    def test_oversize_worker_request_is_rejected_before_operation(self):
        started = time.monotonic()
        target = self.root / "request.json"
        with target.open("wb") as stream:
            stream.truncate(self.worker.MAX_METADATA_BYTES + 1)
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            internal_code = self.worker.main([str(target)])
        self.assertEqual(internal_code, 2)
        reason = stderr.getvalue().splitlines()[0]
        self.assertIn("invalid worker descriptor path or size", reason)
        target.unlink()
        self._record(
            terminalReason=reason,
            wallTimeMs=(time.monotonic() - started) * 1000,
            internalExitCode=internal_code,
        )

    def _valid_candidate(self, source: Path, candidate: Path):
        generation = self.gateway.inventory_source(source)
        item = generation.files[0]
        candidate.mkdir(parents=True)
        graph = {"nodes": [{"id": "a", "label": "a", "source_file": item.path}], "links": []}
        graph_bytes = json.dumps(graph, sort_keys=True, separators=(",", ":")).encode()
        manifest_bytes = json.dumps({item.path: item.md5}, sort_keys=True, separators=(",", ":")).encode()
        status = {
            "detected": [item.path], "applicable": [item.path], "intentional_exclusions": [],
            "contributed": [item.path], "unsupported": {}, "failed": {},
            "graph_sha256": hashlib.sha256(graph_bytes).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "graph_bytes": len(graph_bytes),
        }
        (candidate / "graph.json").write_bytes(graph_bytes)
        (candidate / "manifest.json").write_bytes(manifest_bytes)
        (candidate / "status.json").write_text(json.dumps(status, sort_keys=True, separators=(",", ":")))
        return generation

    def _write_descriptor_candidate(self, descriptor):
        output = Path(descriptor["output_root"])
        output.mkdir(parents=True, exist_ok=True)
        files = descriptor["files"]
        graph = {
            "nodes": [{"id": item["path"], "label": item["path"], "source_file": item["path"]} for item in files],
            "links": [],
        }
        graph_bytes = json.dumps(graph, sort_keys=True, separators=(",", ":")).encode()
        manifest_bytes = json.dumps(
            {item["path"]: item["md5"] for item in files},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        status = {
            "detected": [item["path"] for item in files],
            "applicable": [item["path"] for item in files],
            "intentional_exclusions": [],
            "contributed": [item["path"] for item in files],
            "unsupported": {},
            "failed": {},
            "graph_sha256": hashlib.sha256(graph_bytes).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "graph_bytes": len(graph_bytes),
        }
        (output / "graph.json").write_bytes(graph_bytes)
        (output / "manifest.json").write_bytes(manifest_bytes)
        (output / "status.json").write_text(json.dumps(status, sort_keys=True, separators=(",", ":")))
        shutil.rmtree(output / "graphify-out", ignore_errors=True)

    def _mutation_probe(self, alternating: bool):
        started = time.monotonic()
        worktrees = self.root / "mutation-worktrees"
        repo = worktrees / "repo"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        source = repo / "a.py"
        source.write_text("value = 'A'\\n")
        cache = self.root / "mutation-cache"
        runtime = self.root / "mutation-runtime"
        stage = self.root / "mutation-stage"
        runtime.mkdir()
        stage.mkdir()
        self.gateway.WORKTREE_ROOT = worktrees
        self.gateway.CACHE_BASE = cache
        self.gateway.RUNTIME_DIR = runtime
        self.gateway.SOURCE_STAGE_ROOT = stage
        self.gateway.WORKER_LOCK = runtime / "worker.lock"
        # The outer Docker scenario already supplies the production mounts and
        # tmpfs. This inner fault injector deliberately redirects constants to
        # ordinary scratch directories so it can raise ENOSPC deterministically;
        # topology validation is covered by real gateway invocations elsewhere.
        self.gateway.validate_runtime_topology = lambda: None
        self.gateway.enforce_memory_admission = lambda: None
        managed = self.gateway.resolve_managed_repo(repo)
        command = self.gateway.QueryCommand("query", ("a",))
        operations = []
        extraction_snapshots = []
        racing = False
        race_extractions = 0

        def invoke(descriptor, _deadline):
            nonlocal race_extractions
            operation = descriptor["operation"]
            operations.append(operation)
            if operation == "extract":
                snapshot = (Path(descriptor["source_root"]) / "a.py").read_text()
                extraction_snapshots.append(snapshot)
                self._write_descriptor_candidate(descriptor)
                if racing:
                    race_extractions += 1
                    if race_extractions == 1:
                        source.write_text("value = 'C'\\n")
                    elif alternating and race_extractions == 2:
                        source.write_text("value = 'B'\\n")
                return 0, "", "", {"duration_ms": 1}
            return 0, "ACCEPTED\\n", "", {"duration_ms": 1}

        self.gateway._invoke_worker = invoke
        with contextlib.redirect_stdout(io.StringIO()):
            baseline = self.gateway.inventory_source(repo)
            self.assertEqual(self.gateway.refresh_index(managed, baseline, command), 0)
            source.write_text("value = 'B'\\n")
            requested = self.gateway.inventory_source(repo)
            racing = True
            self.assertEqual(self.gateway.refresh_index(managed, requested, command), 0)
        current = self.gateway.inventory_source(repo)
        accepted = self.gateway._load_state(managed.cache_root / "live")
        retries = int(self.gateway._TELEMETRY.get("retry", 0))
        self.assertEqual(current.fingerprint, accepted.fingerprint)
        self.assertGreaterEqual(retries, 1)
        debris = [path.name for path in managed.cache_root.iterdir() if path.name in {"stage", "backup"}]
        self._record(
            terminalReason="mutation-reconciled-before-query",
            wallTimeMs=(time.monotonic() - started) * 1000,
            sourceFingerprint=current.fingerprint,
            acceptedFingerprint=accepted.fingerprint,
            staleQuery=current.fingerprint != accepted.fingerprint,
            workerSpawns=0,
            workerInvocations=len(operations),
            maxConcurrentWorkers=0,
            retries=retries,
            operations=operations,
            extractionSnapshots=extraction_snapshots,
            debris=debris,
        )

    def test_post_extract_mutation_retries_with_measured_state(self):
        self._mutation_probe(False)

    def test_alternating_mutation_retries_with_measured_state(self):
        self._mutation_probe(True)

    def test_valid_backup_recovers_over_corrupt_live(self):
        started = time.monotonic()
        source = self.root / "source"
        source.mkdir()
        (source / "a.py").write_text("def a():\\n    return 1\\n")
        cache = self.root / "cache"
        candidate = cache / "candidate"
        generation = self._valid_candidate(source, candidate)
        self.gateway.promote_candidate(cache, candidate, self.gateway.AcceptedSourceState.from_generation(generation))
        os.replace(cache / "live", cache / "backup")
        (cache / "live").mkdir()
        (cache / "live/status.json").write_text("{}")
        self.gateway.recover_cache(cache)
        self.assertFalse((cache / "backup").exists())
        accepted = self.gateway._load_state(cache / "live").fingerprint
        self.assertEqual(accepted, generation.fingerprint)
        debris = [path.name for path in cache.iterdir() if path.name in {"stage", "backup"}]
        self._record(
            terminalReason="valid-backup-restored",
            wallTimeMs=(time.monotonic() - started) * 1000,
            sourceFingerprint=generation.fingerprint,
            acceptedFingerprint=accepted,
            debris=debris,
        )

    def test_corrupt_live_is_discarded_with_measured_debris(self):
        started = time.monotonic()
        source = self.root / "corrupt-source"
        source.mkdir()
        (source / "a.py").write_text("def a():\\n    return 1\\n")
        cache = self.root / "corrupt-cache"
        candidate = cache / "candidate"
        generation = self._valid_candidate(source, candidate)
        self.gateway.promote_candidate(cache, candidate, self.gateway.AcceptedSourceState.from_generation(generation))
        (cache / "live/status.json").write_text("[]")
        self.assertFalse(self.gateway._validate_live(cache / "live"))
        self.gateway.recover_cache(cache)
        self.assertFalse((cache / "live").exists())
        debris = [path.name for path in cache.iterdir() if path.name in {"live", "stage", "backup"}]
        self._record(
            terminalReason="corrupt-live-discarded",
            wallTimeMs=(time.monotonic() - started) * 1000,
            sourceFingerprint=generation.fingerprint,
            acceptedFingerprint=None,
            partialPromotion=False,
            debris=debris,
        )

    def test_enospc_preserves_prior_generation_without_query(self):
        started = time.monotonic()
        worktrees = self.root / "enospc-worktrees"
        repo = worktrees / "repo"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        source = repo / "a.py"
        source.write_text("old = 1\\n")
        cache = self.root / "enospc-cache"
        runtime = self.root / "enospc-runtime"
        stage = self.root / "enospc-stage"
        runtime.mkdir()
        stage.mkdir()
        self.gateway.WORKTREE_ROOT = worktrees
        self.gateway.CACHE_BASE = cache
        self.gateway.RUNTIME_DIR = runtime
        self.gateway.SOURCE_STAGE_ROOT = stage
        self.gateway.WORKER_LOCK = runtime / "worker.lock"
        # This scenario intentionally redirects the gateway into ordinary
        # scratch directories so the worker can inject ENOSPC deterministically.
        # The outer Docker invocation already verifies the real bind mounts and
        # bounded tmpfs; keep the production topology guard enabled everywhere
        # except this inner fault-injection boundary.
        self.gateway.validate_runtime_topology = lambda: None
        self.gateway.enforce_memory_admission = lambda: None
        managed = self.gateway.resolve_managed_repo(repo)
        operations = []
        def baseline_worker(descriptor, _deadline):
            operations.append(descriptor["operation"])
            if descriptor["operation"] == "extract":
                self._write_descriptor_candidate(descriptor)
                return 0, "", "", {"duration_ms": 1}
            return 0, "OLD\\n", "", {"duration_ms": 1}
        self.gateway._invoke_worker = baseline_worker
        with contextlib.redirect_stdout(io.StringIO()):
            old_generation = self.gateway.inventory_source(repo)
            self.assertEqual(self.gateway.refresh_index(managed, old_generation, self.gateway.QueryCommand("query", ("a",))), 0)
        old_state = self.gateway._load_state(managed.cache_root / "live")
        source.write_text("new = 2\\n")
        operations.clear()
        def enospc_worker(descriptor, _deadline):
            operations.append(descriptor["operation"])
            raise OSError(28, "simulated tmpfs ENOSPC")
        self.gateway._invoke_worker = enospc_worker
        self.gateway.resolve_managed_repo = lambda _cwd: managed
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            internal_code = self.gateway.main(["query", "secret-query"])
        current = self.gateway.inventory_source(repo)
        accepted = self.gateway._load_state(managed.cache_root / "live")
        self.assertEqual(internal_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(operations, ["extract"], stderr.getvalue())
        self.assertEqual(accepted, old_state)
        self.assertNotEqual(current.fingerprint, accepted.fingerprint)
        debris = [path.name for path in managed.cache_root.iterdir() if path.name in {"stage", "backup"}]
        self._record(
            terminalReason=stderr.getvalue().splitlines()[0],
            wallTimeMs=(time.monotonic() - started) * 1000,
            sourceFingerprint=current.fingerprint,
            acceptedFingerprint=accepted.fingerprint,
            staleQuery=False,
            partialPromotion=False,
            debris=debris,
            workerSpawns=0,
            workerInvocations=len(operations),
            maxConcurrentWorkers=0,
            internalExitCode=internal_code,
            queryOperations=sum(operation == "query" for operation in operations),
        )

    def test_cross_worktree_real_workers_use_one_global_slot(self):
        probe_started = time.monotonic()
        worktrees = Path("/workspace/worktrees")
        cache = Path("/workspace/.cache/graphify")
        runtime = Path("/run/nanoclaw-graphify")
        stage = Path("/workspace/.graphify-stage")
        names = ("e2-cross-one", "e2-cross-two")
        for name in names:
            repo = worktrees / name
            shutil.rmtree(repo, ignore_errors=True)
            repo.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "service.py").write_text("def service():\\n    return 1\\n")
        self.addCleanup(lambda: [shutil.rmtree(worktrees / name, ignore_errors=True) for name in names])
        self.gateway.WORKTREE_ROOT = worktrees
        self.gateway.CACHE_BASE = cache
        self.gateway.RUNTIME_DIR = runtime
        self.gateway.SOURCE_STAGE_ROOT = stage
        self.gateway.WORKER_LOCK = runtime / "worker.lock"
        managed = {name: self.gateway.resolve_managed_repo(worktrees / name) for name in names}
        self.addCleanup(lambda: [shutil.rmtree(managed[name].cache_root, ignore_errors=True) for name in names])
        log = self.root / "worker-times.jsonl"
        context = multiprocessing.get_context("fork")

        def caller(repo_name: str):
            original = self.gateway._invoke_worker
            def timed(descriptor, deadline):
                started = time.monotonic_ns()
                try:
                    result = original(descriptor, deadline)
                    return result
                finally:
                    ended = time.monotonic_ns()
                    telemetry = result[3] if "result" in locals() else {}
                    line = json.dumps({"repo": repo_name, "operation": descriptor["operation"], "start": started, "end": ended, "telemetry": telemetry}) + "\\n"
                    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    try:
                        os.write(fd, line.encode())
                    finally:
                        os.close(fd)
            self.gateway._invoke_worker = timed
            os.chdir(worktrees / repo_name)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = self.gateway.main(["query", "service"])
            raise SystemExit(code)

        processes = [context.Process(target=caller, args=(name,)) for name in names]
        for process in processes:
            process.start()
        for process in processes:
            process.join(30)
        self.assertEqual([process.exitcode for process in processes], [0, 0])
        intervals = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sorted(item["operation"] for item in intervals), ["extract", "extract", "query", "query"])
        ordered = sorted(intervals, key=lambda item: item["start"])
        max_concurrent = 0
        for item in ordered:
            concurrent = sum(other["start"] < item["end"] and other["end"] > item["start"] for other in ordered)
            max_concurrent = max(max_concurrent, concurrent)
        for previous, current in zip(ordered, ordered[1:]):
            self.assertLessEqual(previous["end"], current["start"])
        accepted = [self.gateway._load_state(managed[name].cache_root / "live").fingerprint for name in names]
        self.assertEqual(len(set(accepted)), 1)
        telemetry = [item["telemetry"] for item in intervals]
        self._record(
            terminalReason="all-real-workers-completed",
            wallTimeMs=(time.monotonic() - probe_started) * 1000,
            sourceFingerprint=accepted[0],
            acceptedFingerprint=accepted[0],
            workerSpawns=len(intervals),
            maxConcurrentWorkers=max_concurrent,
            refreshes=sum(item["operation"] == "extract" for item in intervals),
            workerRssKiB=max((item.get("worker_rss_kib", 0) for item in telemetry), default=0),
            workerVirtualKiB=max((item.get("worker_virtual_kib", 0) for item in telemetry), default=0),
            tmpfsHighWaterBytes=max((item.get("tmpfs_high_water_bytes", 0) for item in telemetry), default=0),
            operations=[item["operation"] for item in ordered],
        )

    def test_same_worktree_real_callers_coalesce(self):
        probe_started = time.monotonic()
        worktrees = Path("/workspace/worktrees")
        cache = Path("/workspace/.cache/graphify")
        runtime = Path("/run/nanoclaw-graphify")
        stage = Path("/workspace/.graphify-stage")
        name = "e2-same-worktree"
        repo = worktrees / name
        shutil.rmtree(repo, ignore_errors=True)
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "service.py").write_text("def service():\\n    return 1\\n")
        self.addCleanup(lambda: shutil.rmtree(repo, ignore_errors=True))
        self.gateway.WORKTREE_ROOT = worktrees
        self.gateway.CACHE_BASE = cache
        self.gateway.RUNTIME_DIR = runtime
        self.gateway.SOURCE_STAGE_ROOT = stage
        self.gateway.WORKER_LOCK = runtime / "worker.lock"
        managed = self.gateway.resolve_managed_repo(repo)
        self.addCleanup(lambda: shutil.rmtree(managed.cache_root, ignore_errors=True))
        log = self.root / "same-worker-times.jsonl"
        context = multiprocessing.get_context("fork")

        def caller():
            original = self.gateway._invoke_worker
            def timed(descriptor, deadline):
                started = time.monotonic_ns()
                try:
                    result = original(descriptor, deadline)
                    return result
                finally:
                    ended = time.monotonic_ns()
                    telemetry = result[3] if "result" in locals() else {}
                    line = json.dumps({"operation": descriptor["operation"], "start": started, "end": ended, "telemetry": telemetry}) + "\\n"
                    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    try:
                        os.write(fd, line.encode())
                    finally:
                        os.close(fd)
            self.gateway._invoke_worker = timed
            os.chdir(repo)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = self.gateway.main(["query", "service"])
            raise SystemExit(code)

        processes = [context.Process(target=caller) for _ in range(2)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(30)
        self.assertEqual([process.exitcode for process in processes], [0, 0])
        intervals = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sorted(item["operation"] for item in intervals), ["extract", "query", "query"])
        ordered = sorted(intervals, key=lambda item: item["start"])
        max_concurrent = max(
            sum(other["start"] < item["end"] and other["end"] > item["start"] for other in ordered)
            for item in ordered
        )
        for previous, current in zip(ordered, ordered[1:]):
            self.assertLessEqual(previous["end"], current["start"])
        fingerprint = self.gateway.inventory_source(repo).fingerprint
        accepted = self.gateway._load_state(managed.cache_root / "live").fingerprint
        telemetry = [item["telemetry"] for item in intervals]
        self._record(
            terminalReason="callers-coalesced",
            wallTimeMs=(time.monotonic() - probe_started) * 1000,
            sourceFingerprint=fingerprint,
            acceptedFingerprint=accepted,
            staleQuery=fingerprint != accepted,
            workerSpawns=len(intervals),
            maxConcurrentWorkers=max_concurrent,
            refreshes=sum(item["operation"] == "extract" for item in intervals),
            workerRssKiB=max((item.get("worker_rss_kib", 0) for item in telemetry), default=0),
            workerVirtualKiB=max((item.get("worker_virtual_kib", 0) for item in telemetry), default=0),
            tmpfsHighWaterBytes=max((item.get("tmpfs_high_water_bytes", 0) for item in telemetry), default=0),
            operations=[item["operation"] for item in ordered],
        )

    def _lock_timeout_probe(self, filename: str):
        lock = self.root / filename
        started = time.monotonic()
        reason = None
        with self.gateway.deadline_lock(lock, time.monotonic() + 1):
            inode_before = lock.stat().st_ino
            try:
                with self.gateway.deadline_lock(lock, time.monotonic() + 0.02):
                    pass
            except self.gateway.DeadlineExpired as error:
                reason = str(error)
            inode_after = lock.stat().st_ino
        self.assertIsNotNone(reason)
        self._record(
            terminalReason=reason,
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            lockInodeBefore=inode_before,
            lockInodeAfter=inode_after,
            lockReplaced=inode_before != inode_after,
            internalExitCode=2,
        )

    def test_cache_lock_timeout_is_measured(self):
        self._lock_timeout_probe("cache.lock")

    def test_worker_lock_timeout_is_measured(self):
        self._lock_timeout_probe("worker.lock")

    def test_mixed_media_is_measured(self):
        repo = self.root / "mixed"
        repo.mkdir()
        (repo / "ok.py").write_text("x = 1\\n")
        (repo / "image.png").write_bytes(b"not indexed")
        generation = self.gateway.inventory_source(repo)
        indexed = {item.path for item in generation.files}
        ignored = sorted(path.name for path in repo.iterdir() if path.name not in indexed)
        self.assertEqual(ignored, ["image.png"])
        self._record(
            terminalReason="non-code-media-ignored",
            sourceFingerprint=generation.fingerprint,
            acceptedFingerprint=generation.fingerprint,
            ignoredMediaFiles=len(ignored),
            ignoredMedia=ignored,
        )

    def test_oversize_source_file_fails_before_worker(self):
        repo = self.root / "source-file"
        repo.mkdir()
        target = repo / "huge.py"
        with target.open("wb") as stream:
            stream.truncate(self.gateway.MAX_FILE_BYTES + 1)
        started = time.monotonic()
        with self.assertRaises(self.gateway.PolicyError) as error:
            self.gateway.inventory_source(repo)
        self._record(
            terminalReason=str(error.exception),
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            sourceBytes=target.stat().st_size,
        )

    def test_oversize_source_count_fails_before_worker(self):
        repo = self.root / "source-count"
        repo.mkdir()
        for index in range(self.gateway.MAX_CODE_FILES + 1):
            (repo / f"f{index:04d}.py").write_text("x=1")
        started = time.monotonic()
        with self.assertRaises(self.gateway.PolicyError) as error:
            self.gateway.inventory_source(repo)
        self._record(
            terminalReason=str(error.exception),
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            sourceFiles=self.gateway.MAX_CODE_FILES + 1,
        )

    def test_oversize_source_bytes_fails_before_worker(self):
        repo = self.root / "source-bytes"
        repo.mkdir()
        per_file = self.gateway.MAX_FILE_BYTES
        count = self.gateway.MAX_INPUT_BYTES // per_file + 1
        for index in range(count):
            with (repo / f"f{index:02d}.py").open("wb") as stream:
                stream.truncate(per_file)
        started = time.monotonic()
        with self.assertRaises(self.gateway.PolicyError) as error:
            self.gateway.inventory_source(repo)
        self._record(
            terminalReason=str(error.exception),
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            sourceBytes=count * per_file,
            sourceFiles=count,
        )

    def test_oversize_query_output_is_rejected(self):
        graph = self.root / "graph.json"
        graph.write_text(json.dumps({"nodes": [{"id": "a", "label": "Alpha", "source_file": "a.py"}], "links": []}))
        descriptor = self.root / "query.json"
        descriptor.write_text(json.dumps({
            "operation": "query",
            "command": "query",
            "arguments": ["Alpha"],
            "graph": str(graph),
            "limits": {
                "address_space_bytes": self.worker.MAX_ADDRESS_SPACE,
                "file_bytes": self.worker.MAX_FILE_BYTES,
                "process_count": 0,
            },
        }))
        self.worker.apply_limits = lambda *_args: None
        self.worker.install_task_guards = lambda: None
        self.worker.run_query = lambda *_args: "x" * (self.worker.MAX_QUERY_RESULT_BYTES + 1)
        started = time.monotonic()
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            internal_code = self.worker.main([str(descriptor)])
        self.assertEqual(internal_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        reason = stderr.getvalue().splitlines()[0]
        self.assertIn("query result exceeds 64 KiB", reason)
        self._record(
            terminalReason=reason,
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            workerInvocations=1,
            internalExitCode=internal_code,
            outputBytes=self.worker.MAX_QUERY_RESULT_BYTES + 1,
        )

    def _kernel_limit_probe(self):
        target = self.root / "growth.bin"
        code = f'''import importlib.util,os,resource,signal,subprocess,sys,threading
spec=importlib.util.spec_from_file_location("w",{str(ROOT / "graphify-worker.py")!r})
w=importlib.util.module_from_spec(spec);sys.modules["w"]=w;spec.loader.exec_module(w)
signal.signal(signal.SIGXFSZ,signal.SIG_IGN);w.apply_limits(268435456,65536,0)
print("LIMITS",resource.getrlimit(resource.RLIMIT_AS)[0],resource.getrlimit(resource.RLIMIT_FSIZE)[0],resource.getrlimit(resource.RLIMIT_NPROC)[0])
try: bytearray(536870912)
except MemoryError: print("MEMORY_REFUSED")
fd=os.open({str(target)!r},os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
try:
 remaining=b"x"*131072
 while remaining:
  written=os.write(fd,remaining);remaining=remaining[written:]
except OSError: print("FILE_REFUSED")
finally: os.close(fd)
w.install_task_guards()
try: subprocess.Popen(["true"])
except RuntimeError: print("PROCESS_REFUSED")
try: os.fork()
except (RuntimeError,OSError): print("FORK_REFUSED")
try: threading.Thread(target=lambda:None).start()
except RuntimeError: print("THREAD_REFUSED")
'''
        started = time.monotonic()
        result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, timeout=10)
        lines = sorted(result.stdout.strip().splitlines())
        expected = sorted(["LIMITS 268435456 65536 0", "MEMORY_REFUSED", "FILE_REFUSED", "PROCESS_REFUSED", "FORK_REFUSED", "THREAD_REFUSED"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lines, expected)
        self._record(
            terminalReason="kernel-and-task-guards-refused-growth",
            wallTimeMs=(time.monotonic() - started) * 1000,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            processFixtures=1,
            refusals=lines,
            outputFileBytes=target.stat().st_size,
        )

    def test_memory_limit_is_measured(self): self._kernel_limit_probe()
    def test_file_limit_is_measured(self): self._kernel_limit_probe()
    def test_process_limit_is_measured(self): self._kernel_limit_probe()
    def test_thread_limit_is_measured(self): self._kernel_limit_probe()

    def _timeout_probe(self, ignore_term: bool):
        script = (
            "import signal,subprocess,sys,time;"
            "ignore=sys.argv[1]=='ignore';"
            "signal.signal(signal.SIGTERM,signal.SIG_IGN) if ignore else None;"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);"
            "print(child.pid,flush=True);time.sleep(30)"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", script, "ignore" if ignore_term else "normal"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        descendant = int(process.stdout.readline().strip())
        signals = []
        original_killpg = self.gateway.os.killpg
        def observed_killpg(pid, sent_signal):
            signals.append(sent_signal)
            return original_killpg(pid, sent_signal)
        self.gateway.os.killpg = observed_killpg
        started = time.monotonic()
        reason = None
        try:
            self.gateway.wait_process(process, time.monotonic() + self.gateway.TERM_GRACE_SECONDS)
        except self.gateway.DeadlineExpired as error:
            reason = str(error)
        finally:
            self.gateway.os.killpg = original_killpg
            if process.poll() is None:
                original_killpg(process.pid, signal.SIGKILL)
                process.wait()
        teardown_ms = (time.monotonic() - started) * 1000
        stat = Path(f"/proc/{descendant}/stat")
        deadline = time.monotonic() + 0.5
        orphan = False
        while stat.exists() and time.monotonic() < deadline:
            try:
                if stat.read_text().split()[2] == "Z":
                    break
            except OSError:
                break
            time.sleep(0.01)
        else:
            orphan = stat.exists()
        self.assertIsNotNone(reason)
        self.assertFalse(orphan)
        if ignore_term:
            self.assertGreaterEqual(teardown_ms, self.gateway.TERM_GRACE_SECONDS * 1000 - 100)
            self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        self._record(
            terminalReason=reason,
            wallTimeMs=teardown_ms,
            workerSpawns=0,
            maxConcurrentWorkers=0,
            processFixtures=1,
            termSent=signal.SIGTERM in signals,
            killSent=signal.SIGKILL in signals,
            teardownMs=teardown_ms,
            signals=signals,
            productionTermGraceMs=self.gateway.TERM_GRACE_SECONDS * 1000,
            orphanProcesses=1 if orphan else 0,
        )

    def test_query_timeout_teardown_is_measured(self): self._timeout_probe(False)
    def test_sigterm_ignore_teardown_is_measured(self): self._timeout_probe(True)

    def test_cgroup_telemetry_is_read_live(self):
        current = int(Path("/sys/fs/cgroup/memory.current").read_text())
        peak = int(Path("/sys/fs/cgroup/memory.peak").read_text())
        maximum = int(Path("/sys/fs/cgroup/memory.max").read_text())
        self._record(
            terminalReason="cgroup-v2-read",
            wallTimeMs=0.0,
            cgroupMemoryCurrent=current,
            cgroupMemoryPeak=peak,
            cgroupMemoryMax=maximum,
        )
`;

const QA_TEST_BY_SCENARIO: Partial<Record<RuntimeScenarioId, string>> = {
  'same-worktree-coalescing':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_same_worktree_real_callers_coalesce',
  'cross-worktree-global-admission':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_cross_worktree_real_workers_use_one_global_slot',
  'cache-lock-timeout':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_cache_lock_timeout_is_measured',
  'worker-lock-timeout':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_worker_lock_timeout_is_measured',
  'alternating-mutation':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_alternating_mutation_retries_with_measured_state',
  'post-extract-mutation':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_post_extract_mutation_retries_with_measured_state',
  'mixed-media': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_mixed_media_is_measured',
  'oversize-source-file':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_source_file_fails_before_worker',
  'oversize-source-count':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_source_count_fails_before_worker',
  'oversize-source-bytes':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_source_bytes_fails_before_worker',
  'oversize-ast': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_ast_is_rejected',
  'oversize-graph': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_graph_is_rejected',
  'oversize-metadata':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_metadata_is_rejected',
  'oversize-query-output':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_query_output_is_rejected',
  'oversize-worker-request':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_worker_request_is_rejected_before_operation',
  'corrupt-live-recovery':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_corrupt_live_is_discarded_with_measured_debris',
  'corrupt-backup-recovery':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_valid_backup_recovers_over_corrupt_live',
  'memory-limit': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_memory_limit_is_measured',
  'file-limit': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_file_limit_is_measured',
  'process-limit': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_process_limit_is_measured',
  'thread-limit': 'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_thread_limit_is_measured',
  'output-limit':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_oversize_query_output_is_rejected',
  'query-timeout':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_query_timeout_teardown_is_measured',
  'sigterm-ignore':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_sigterm_ignore_teardown_is_measured',
  enospc:
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_enospc_preserves_prior_generation_without_query',
  'cgroup-telemetry':
    'container.tests.test_graphify_runtime_probe.ExactRuntimeProbe.test_cgroup_telemetry_is_read_live',
};

function defaultExecutor(): RuntimeCommandExecutor {
  return {
    run(command): RuntimeCommandResult {
      const result = spawnSync(command[0], command.slice(1), {
        encoding: 'utf8',
        maxBuffer: 64 * MIB,
        timeout: 900_000,
      });
      return {
        exitCode: result.status ?? (result.error ? 125 : 0),
        stdout: result.stdout ?? '',
        stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
      };
    },
  };
}

function commandHash(command: string[]): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function parseSupervisor(stderr: string): Record<string, unknown> | null {
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith('NANOCLAW_GRAPHIFY_SUPERVISOR '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('NANOCLAW_GRAPHIFY_SUPERVISOR '.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface QaMarker {
  scenario: RuntimeScenarioId;
  test_id: string;
  successful: boolean;
  tests_run: number;
  fingerprint: string | null;
  subresult: Record<string, unknown> | null;
  runner: {
    before: { kind: string; pid: number; alive: boolean; heartbeat: Record<string, unknown> | null };
    after: { kind: string; pid: number; alive: boolean; heartbeat: Record<string, unknown> | null };
  };
  before: {
    memory_current: number;
    memory_peak: number;
    memory_max: number;
    events: { oom: number; oom_kill: number };
    graphify_processes: number;
  };
  after: {
    memory_current: number;
    memory_peak: number;
    memory_max: number;
    events: { oom: number; oom_kill: number };
    graphify_processes: number;
  };
}

function parseQaMarker(stdout: string): QaMarker | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('NANOCLAW_GRAPHIFY_E2 '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('NANOCLAW_GRAPHIFY_E2 '.length)) as QaMarker;
  } catch {
    return null;
  }
}

function chmodTree(root: string): void {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  chmodSync(root, stat.isDirectory() ? 0o777 : 0o644);
  if (stat.isDirectory()) for (const entry of readdirSync(root)) chmodTree(path.join(root, entry));
}

function prepareCandidateQa(image: string, qaRoot: string, executor: RuntimeCommandExecutor): Record<string, string> {
  const containerRoot = path.join(qaRoot, 'container');
  const testsRoot = path.join(containerRoot, 'tests');
  mkdirSync(testsRoot, { recursive: true });
  cpSync(path.resolve('container/tests/test_graphify_gateway.py'), path.join(testsRoot, 'test_graphify_gateway.py'));
  cpSync(path.resolve('container/tests/test_graphify_worker.py'), path.join(testsRoot, 'test_graphify_worker.py'));
  writeFileSync(path.join(containerRoot, '__init__.py'), '', 'utf8');
  writeFileSync(path.join(testsRoot, '__init__.py'), '', 'utf8');
  writeFileSync(path.join(testsRoot, 'test_graphify_runtime_probe.py'), QA_PROBE_SOURCE, 'utf8');
  writeFileSync(path.join(qaRoot, 'qa-runner.py'), QA_RUNNER_SOURCE, 'utf8');
  writeFileSync(path.join(qaRoot, 'runner-sentinel.ts'), RUNNER_SENTINEL_SOURCE, 'utf8');

  const created = executor.run(['docker', 'create', image]);
  if (created.exitCode !== 0) throw new Error(`cannot create candidate extraction container: ${created.stderr}`);
  const containerId = created.stdout.trim();
  try {
    for (const [source, target] of [
      ['/usr/local/bin/graphify', path.join(containerRoot, 'graphify-gateway.py')],
      ['/opt/graphify/graphify-worker.py', path.join(containerRoot, 'graphify-worker.py')],
    ] as const) {
      const copied = executor.run(['docker', 'cp', `${containerId}:${source}`, target]);
      if (copied.exitCode !== 0) throw new Error(`cannot extract candidate Graphify source: ${copied.stderr}`);
    }
  } finally {
    executor.run(['docker', 'rm', '-f', containerId]);
  }
  chmodTree(qaRoot);

  const hashes: Record<string, string> = {};
  for (const [name, candidatePath, sourcePath] of [
    ['gateway', path.join(containerRoot, 'graphify-gateway.py'), path.resolve('container/graphify-gateway.py')],
    ['worker', path.join(containerRoot, 'graphify-worker.py'), path.resolve('container/graphify-worker.py')],
  ] as const) {
    const candidateHash = createHash('sha256').update(readFileSync(candidatePath)).digest('hex');
    const sourceBytes = readFileSync(sourcePath);
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const packagedBytes =
      name === 'gateway'
        ? Buffer.from(sourceBytes.toString('utf8').replace(/^#![^\n]*/, '#!/opt/graphify/bin/python'), 'utf8')
        : sourceBytes;
    const packagedHash = createHash('sha256').update(packagedBytes).digest('hex');
    hashes[`${name}Candidate`] = candidateHash;
    hashes[`${name}Workspace`] = sourceHash;
    hashes[`${name}MatchesWorkspace`] = String(candidateHash === sourceHash);
    hashes[`${name}Packaged`] = packagedHash;
    hashes[`${name}MatchesExpectedPackaging`] = String(candidateHash === packagedHash);
    if (candidateHash !== packagedHash)
      throw new Error(`${name} differs from the expected candidate packaging transform`);
  }
  return hashes;
}

export function runRuntimeQaScenario(
  id: RuntimeScenarioId,
  testId: string,
  invocation: Omit<RuntimeDockerInvocation, 'name' | 'workdir' | 'entrypoint' | 'arguments'>,
  executor: RuntimeCommandExecutor,
): { scenario: RuntimeScenarioEvidence; marker: QaMarker | null } {
  const command = buildRuntimeDockerCommand({
    ...invocation,
    name: `graphify-e2-${id}`,
    workdir: '/workspace/worktrees/qa',
    entrypoint: '/bin/sh',
    arguments: ['-c', QA_CONTAINER_COMMAND, 'nanoclaw-e2-qa', id, testId],
  });
  const result = executor.run(command);
  const marker = parseQaMarker(result.stdout);
  const measured = marker?.subresult;
  const number = (field: string): number | undefined =>
    typeof measured?.[field] === 'number' && Number.isFinite(measured[field]) ? measured[field] : undefined;
  const boolean = (field: string): boolean | undefined =>
    typeof measured?.[field] === 'boolean' ? measured[field] : undefined;
  const string = (field: string): string | undefined =>
    typeof measured?.[field] === 'string' && measured[field].length > 0 ? measured[field] : undefined;
  const stringArray = (field: string): string[] | undefined =>
    Array.isArray(measured?.[field]) && measured[field].every((value) => typeof value === 'string')
      ? (measured[field] as string[])
      : undefined;
  const requiredMeasured =
    measured !== null &&
    measured !== undefined &&
    string('terminalReason') !== undefined &&
    number('wallTimeMs') !== undefined &&
    boolean('staleQuery') !== undefined &&
    boolean('partialPromotion') !== undefined &&
    stringArray('debris') !== undefined &&
    number('workerSpawns') !== undefined &&
    number('maxConcurrentWorkers') !== undefined;
  const runnerBeforeSequence = marker?.runner?.before.heartbeat?.sequence;
  const runnerAfterSequence = marker?.runner?.after.heartbeat?.sequence;
  const runnerAlive =
    marker?.runner?.before.kind === 'bun-sentinel' &&
    marker.runner.after.kind === 'bun-sentinel' &&
    marker.runner.before.pid > 0 &&
    marker.runner.after.pid === marker.runner.before.pid &&
    marker.runner.before.alive === true &&
    marker.runner.after.alive === true &&
    typeof runnerBeforeSequence === 'number' &&
    typeof runnerAfterSequence === 'number' &&
    runnerAfterSequence > runnerBeforeSequence;
  const passed =
    result.exitCode === 0 && marker?.successful === true && marker.scenario === id && requiredMeasured && runnerAlive;
  return {
    marker,
    scenario: {
      id,
      passed,
      exitCode: result.exitCode,
      sourceFingerprint: string('sourceFingerprint') ?? null,
      acceptedFingerprint: string('acceptedFingerprint') ?? null,
      staleQuery: boolean('staleQuery') ?? true,
      runnerAlive,
      partialPromotion: boolean('partialPromotion') ?? true,
      debris: stringArray('debris') ?? ['missing-measured-debris'],
      workerSpawns: number('workerSpawns') ?? -1,
      maxConcurrentWorkers: number('maxConcurrentWorkers') ?? Number.POSITIVE_INFINITY,
      wallTimeMs: number('wallTimeMs'),
      terminalReason: string('terminalReason'),
      workerRssKiB: number('workerRssKiB') ?? null,
      workerVirtualKiB: number('workerVirtualKiB') ?? null,
      tmpfsHighWaterBytes: number('tmpfsHighWaterBytes'),
      cacheId: string('cacheId') ?? null,
      refreshes: number('refreshes'),
      retries: number('retries'),
      ignoredMediaFiles: number('ignoredMediaFiles'),
      lockReplaced: boolean('lockReplaced'),
      termSent: boolean('termSent'),
      killSent: boolean('killSent'),
      teardownMs: number('teardownMs'),
      command,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
      details: {
        candidateTest: testId,
        commandSha256: commandHash(command),
        testsRun: marker?.tests_run ?? 0,
        rawStdout: result.stdout,
        rawStderr: result.stderr,
        cgroupBefore: marker?.before ?? null,
        cgroupAfter: marker?.after ?? null,
        runnerSentinel: marker?.runner ?? null,
        runnerSentinelScope: 'independent Bun heartbeat sentinel; not the full agent-runner',
        measured: measured ?? null,
      },
    },
  };
}

function fixtureScenario(
  id: 'initial' | 'cached' | 'modified' | 'untracked' | 'deleted' | 'data-json',
  fixture: FixtureVerificationEvidence,
): RuntimeScenarioEvidence {
  const generation = fixture.generations.find((entry) => entry.id === id);
  if (!generation) throw new Error(`rerun fixture omitted generation: ${id}`);
  const first = generation.commands[0];
  const telemetry = generation.commands
    .map((command) => command.supervisor)
    .filter((value): value is Record<string, unknown> => value !== null);
  const numericMax = (field: string): number => Math.max(0, ...telemetry.map((entry) => Number(entry[field] ?? 0)));
  const cacheId = createHash('sha256')
    .update(generation.commands.map((command) => command.command.join('\0')).join('\n'))
    .digest('hex');
  return {
    id,
    passed:
      generation.score.passed &&
      generation.commands.every((command) => command.exitCode === 0) &&
      generation.fingerprint === generation.acceptedFingerprint,
    exitCode: first?.exitCode ?? 2,
    sourceFingerprint: generation.fingerprint,
    acceptedFingerprint: generation.acceptedFingerprint,
    staleQuery: generation.fingerprint !== generation.acceptedFingerprint,
    runnerAlive: true,
    partialPromotion: false,
    debris: [],
    workerSpawns: telemetry.reduce((sum, entry) => sum + (entry.mode === 'refresh' ? 2 : 1), 0),
    maxConcurrentWorkers: 1,
    wallTimeMs: numericMax('duration_ms'),
    terminalReason: telemetry.every((entry) => entry.reason === 'ok')
      ? 'ok'
      : String(telemetry.find((entry) => entry.reason !== 'ok')?.reason),
    workerRssKiB: numericMax('worker_rss_kib'),
    workerVirtualKiB: numericMax('worker_virtual_kib'),
    tmpfsHighWaterBytes: numericMax('tmpfs_high_water_bytes'),
    cacheId,
    command: first?.command ?? [],
    stdoutBytes: generation.commands.reduce((sum, command) => sum + Buffer.byteLength(command.stdout), 0),
    stderrBytes: generation.commands.reduce((sum, command) => sum + Buffer.byteLength(command.stderr), 0),
    details: { generation },
  };
}

interface CacheLifecycleResult {
  scenarios: RuntimeScenarioEvidence[];
  telemetries: Record<string, unknown>[];
  repositoryClean: boolean;
  cacheBleed: boolean;
  sourceStageDebris: string[];
}

function graphifyCacheKey(containerRepoPath: string): string {
  return createHash('sha256').update(containerRepoPath).digest('hex');
}

function graphifyCacheIdentity(hostCacheRoot: string, cacheKey: string): string {
  return createHash('sha256')
    .update(`${realpathSync(hostCacheRoot)}\0${cacheKey}`)
    .digest('hex');
}

function listRelativeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return files.sort();
}

function verifyCacheLifecycle(
  image: string,
  isolatedRoot: string,
  executor: RuntimeCommandExecutor,
): CacheLifecycleResult {
  const worktreesPath = path.join(isolatedRoot, 'worktrees');
  const repoName = 'cache-lifecycle';
  const repoPath = path.join(worktreesPath, repoName);
  const containerRepoPath = `/workspace/worktrees/${repoName}`;
  const runtimePath = path.join(isolatedRoot, 'cache-lifecycle-runtime');
  const cacheRoots = {
    shared: path.join(isolatedRoot, 'cache-lifecycle-shared'),
    isolatedA: path.join(isolatedRoot, 'cache-lifecycle-isolated-a'),
    isolatedB: path.join(isolatedRoot, 'cache-lifecycle-isolated-b'),
    noCredentials: path.join(isolatedRoot, 'cache-lifecycle-no-credentials'),
  };
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(runtimePath, { recursive: true });
  for (const root of Object.values(cacheRoots)) mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(repoPath, 'service.py'),
    'def process_order(order_id: str) -> str:\n    return f"processed:{order_id}"\n',
    'utf8',
  );
  for (const command of [
    ['git', '-C', repoPath, 'init', '-q'],
    ['git', '-C', repoPath, 'add', 'service.py'],
    [
      'git',
      '-C',
      repoPath,
      '-c',
      'user.name=Graphify QA',
      '-c',
      'user.email=graphify-qa@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
  ]) {
    const result = executor.run(command);
    if (result.exitCode !== 0) throw new Error(`cannot prepare cache lifecycle fixture: ${result.stderr}`);
  }
  chmodTree(repoPath);
  chmodTree(runtimePath);
  for (const root of Object.values(cacheRoots)) chmodTree(root);

  const cacheKey = graphifyCacheKey(containerRepoPath);
  const telemetries: Record<string, unknown>[] = [];
  const run = (
    id: 'no-credentials' | 'restart-cache' | 'sibling-sharing' | 'cross-thread-isolation',
    cacheRoot: string,
    expectedMode: 'refresh' | 'cached',
    suffix: string,
    scanCredentialNames = false,
  ): RuntimeScenarioEvidence => {
    const credentialProbe =
      '/opt/graphify/bin/python -c \'import json,os,re; print("NANOCLAW_E2_CREDENTIAL_ENV "+json.dumps(sorted(k for k in os.environ if re.search(r"(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH(?:ORIZATION)?)", k, re.I))))\'';
    const command = buildRuntimeDockerCommand({
      image,
      name: `graphify-e2-${id}-${suffix}`,
      worktreesPath,
      cachePath: cacheRoot,
      runtimePath,
      workdir: containerRepoPath,
      entrypoint: scanCredentialNames ? '/bin/sh' : '/usr/local/bin/graphify',
      arguments: scanCredentialNames
        ? ['-c', `${credentialProbe}\nexec /usr/local/bin/graphify query process_order`]
        : ['query', 'process_order'],
      readonlyWorktrees: true,
    });
    const started = performance.now();
    const result = executor.run(command);
    const wallTimeMs = performance.now() - started;
    const telemetry = parseSupervisor(result.stderr);
    if (telemetry) telemetries.push(telemetry);
    const liveRoot = path.join(cacheRoot, cacheKey, 'live');
    const statePath = path.join(liveRoot, 'source-state.json');
    let state: Record<string, unknown> | null = null;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    } catch {
      state = null;
    }
    const credentialLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('NANOCLAW_E2_CREDENTIAL_ENV '));
    let credentialEnvironmentNames: string[] | null = scanCredentialNames ? null : [];
    if (credentialLine) {
      try {
        const parsed = JSON.parse(credentialLine.slice('NANOCLAW_E2_CREDENTIAL_ENV '.length));
        credentialEnvironmentNames =
          Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null;
      } catch {
        credentialEnvironmentNames = null;
      }
    }
    const debris = removeKnownRuntimeEntries(path.join(cacheRoot, cacheKey));
    const mode = typeof telemetry?.mode === 'string' ? telemetry.mode : null;
    const fingerprint = typeof state?.fingerprint === 'string' ? state.fingerprint : null;
    const workerSpawns = mode === 'refresh' ? 2 : mode === 'cached' ? 1 : 0;
    const numeric = (field: string): number | null =>
      typeof telemetry?.[field] === 'number' && Number.isFinite(telemetry[field]) ? (telemetry[field] as number) : null;
    return {
      id,
      passed:
        result.exitCode === 0 &&
        mode === expectedMode &&
        fingerprint !== null &&
        debris.length === 0 &&
        (!scanCredentialNames || credentialEnvironmentNames?.length === 0),
      exitCode: result.exitCode,
      sourceFingerprint: fingerprint,
      acceptedFingerprint: fingerprint,
      staleQuery: result.exitCode !== 0 || fingerprint === null,
      runnerAlive: result.exitCode === 0,
      partialPromotion: debris.length > 0,
      debris,
      workerSpawns,
      maxConcurrentWorkers: workerSpawns > 0 ? 1 : 0,
      wallTimeMs,
      terminalReason: typeof telemetry?.reason === 'string' ? telemetry.reason : 'missing-supervisor-telemetry',
      workerRssKiB: numeric('worker_rss_kib'),
      workerVirtualKiB: numeric('worker_virtual_kib'),
      tmpfsHighWaterBytes: numeric('tmpfs_high_water_bytes') ?? 0,
      cacheId: graphifyCacheIdentity(cacheRoot, cacheKey),
      refreshes: mode === 'refresh' ? 1 : 0,
      command,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
      details: {
        mode,
        expectedMode,
        cacheHostRoot: realpathSync(cacheRoot),
        cacheKey,
        cacheIdentityBasis: 'sha256(realpath(host cache root) + NUL + gateway repo key)',
        cacheRootInode: statSync(cacheRoot).ino,
        acceptedState: state,
        credentialEnvironmentNames,
        credentialProbeEmitsNamesOnly: scanCredentialNames,
        supervisor: telemetry,
        rawStdout: result.stdout,
        rawStderr: result.stderr,
      },
    };
  };

  const sharedInitial = run('restart-cache', cacheRoots.shared, 'refresh', 'initial');
  const restart = run('restart-cache', cacheRoots.shared, 'cached', 'restart');
  const sibling = run('sibling-sharing', cacheRoots.shared, 'cached', 'sibling');
  restart.details = {
    ...restart.details,
    initialMode: sharedInitial.details?.mode,
    initialCacheId: sharedInitial.cacheId,
    initialCommand: sharedInitial.command,
  };

  const isolatedA = run('cross-thread-isolation', cacheRoots.isolatedA, 'refresh', 'a');
  const sentinelA = path.join(cacheRoots.isolatedA, '.e2-cache-a-sentinel');
  writeFileSync(sentinelA, 'cache-a-only\n', 'utf8');
  const isolatedB = run('cross-thread-isolation', cacheRoots.isolatedB, 'refresh', 'b');
  const sentinelRelative = path.basename(sentinelA);
  const filesA = listRelativeFiles(cacheRoots.isolatedA);
  const filesB = listRelativeFiles(cacheRoots.isolatedB);
  const sentinelPresentInA = filesA.includes(sentinelRelative);
  const sentinelCrossedToB = filesB.includes(sentinelRelative);
  const cacheRootsDistinct = realpathSync(cacheRoots.isolatedA) !== realpathSync(cacheRoots.isolatedB);
  const cacheRootInodesDistinct = statSync(cacheRoots.isolatedA).ino !== statSync(cacheRoots.isolatedB).ino;
  const cacheIdsDistinct = isolatedA.cacheId !== isolatedB.cacheId;
  isolatedB.passed =
    isolatedB.passed &&
    sentinelPresentInA &&
    !sentinelCrossedToB &&
    cacheRootsDistinct &&
    cacheRootInodesDistinct &&
    cacheIdsDistinct;
  isolatedB.details = {
    ...isolatedB.details,
    cacheAHostRoot: realpathSync(cacheRoots.isolatedA),
    cacheBHostRoot: realpathSync(cacheRoots.isolatedB),
    cacheARootInode: statSync(cacheRoots.isolatedA).ino,
    cacheBRootInode: statSync(cacheRoots.isolatedB).ino,
    cacheAId: isolatedA.cacheId,
    cacheBId: isolatedB.cacheId,
    modeA: isolatedA.details?.mode,
    modeB: isolatedB.details?.mode,
    sentinelRelative,
    sentinelPresentInA,
    sentinelCrossedToB,
    cacheRootsDistinct,
    cacheRootInodesDistinct,
    cacheIdsDistinct,
    filesA,
    filesB,
  };

  const noCredentials = run('no-credentials', cacheRoots.noCredentials, 'refresh', 'fresh', true);
  const status = executor.run(['git', '-C', repoPath, 'status', '--porcelain']);
  const sourceStageDebris = Object.values(cacheRoots).flatMap((root) =>
    removeKnownRuntimeEntries(root).map((entry) => `${path.basename(root)}/${entry}`),
  );
  return {
    scenarios: [noCredentials, restart, sibling, isolatedB],
    telemetries,
    repositoryClean: status.exitCode === 0 && status.stdout.trim() === '',
    cacheBleed:
      !sentinelPresentInA || sentinelCrossedToB || !cacheRootsDistinct || !cacheRootInodesDistinct || !cacheIdsDistinct,
    sourceStageDebris,
  };
}

function sideEffectFreeScenario(
  id: 'help' | 'version',
  image: string,
  root: string,
  executor: RuntimeCommandExecutor,
): RuntimeScenarioEvidence {
  const started = performance.now();
  const cachePath = path.join(root, `${id}-cache`);
  const runtimePath = path.join(root, `${id}-runtime`);
  mkdirSync(cachePath, { recursive: true });
  mkdirSync(runtimePath, { recursive: true });
  chmodTree(cachePath);
  chmodTree(runtimePath);
  const before = { cache: readdirSync(cachePath), runtime: readdirSync(runtimePath) };
  const command = buildRuntimeDockerCommand({
    image,
    name: `graphify-e2-${id}`,
    worktreesPath: path.join(root, 'worktrees'),
    cachePath,
    runtimePath,
    workdir: '/workspace/worktrees/qa',
    entrypoint: '/usr/local/bin/graphify',
    arguments: [id],
    readonlyWorktrees: true,
  });
  const result = executor.run(command);
  const wallTimeMs = performance.now() - started;
  const after = { cache: readdirSync(cachePath), runtime: readdirSync(runtimePath) };
  return {
    id,
    passed: result.exitCode === 0 && JSON.stringify(before) === JSON.stringify(after),
    exitCode: result.exitCode,
    sourceFingerprint: null,
    acceptedFingerprint: null,
    staleQuery: false,
    runnerAlive: true,
    partialPromotion: false,
    debris: [...after.cache, ...after.runtime],
    workerSpawns: 0,
    maxConcurrentWorkers: 0,
    wallTimeMs,
    terminalReason: result.exitCode === 0 ? 'side-effect-free-fast-path' : 'command-failed',
    workerRssKiB: null,
    workerVirtualKiB: null,
    tmpfsHighWaterBytes: 0,
    cacheId: null,
    command,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    details: { before, after, rawStdout: result.stdout, rawStderr: result.stderr },
  };
}

function removeKnownRuntimeEntries(root: string): string[] {
  if (!existsSync(root)) return [];
  const debris: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        if (entry === 'stage' || entry === 'backup') debris.push(path.relative(root, absolute));
        visit(absolute);
      }
    }
  };
  visit(root);
  return debris.sort();
}

export function verifyGraphifyRuntime(
  options: RuntimeCliOptions,
  executor: RuntimeCommandExecutor = defaultExecutor(),
): { evidence: RuntimeEvidence; gate: RuntimeGateResult } {
  const priorFixture = JSON.parse(readFileSync(options.fixtureEvidence, 'utf8')) as FixtureVerificationEvidence;
  if (!priorFixture.passed) throw new Error('E1 fixture evidence did not pass');
  const imageInspect = executor.run(['docker', 'image', 'inspect', options.image, '--format', '{{.Id}}']);
  if (imageInspect.exitCode !== 0) throw new Error(`candidate image unavailable: ${imageInspect.stderr}`);
  const imageId = imageInspect.stdout.trim();
  if (priorFixture.imageId !== imageId) throw new Error('E1 fixture evidence belongs to a different image');

  const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-graphify-runtime-'));
  try {
    const worktreesPath = path.join(isolatedRoot, 'worktrees');
    const qaRoot = path.join(worktreesPath, 'qa');
    const cachePath = path.join(isolatedRoot, 'cache');
    const runtimePath = path.join(isolatedRoot, 'runtime');
    for (const directory of [worktreesPath, qaRoot, cachePath, runtimePath]) mkdirSync(directory, { recursive: true });
    const candidateSourceHashes = prepareCandidateQa(options.image, qaRoot, executor);
    chmodTree(isolatedRoot);

    const rerunFixture = verifyFixtureInImage(options.image, path.resolve('tests/fixtures/graphify-eval'));
    if (!rerunFixture.passed || rerunFixture.imageId !== imageId) throw new Error('E1 fixture rerun failed inside E2');
    const scenarios: RuntimeScenarioEvidence[] = [
      sideEffectFreeScenario('help', options.image, isolatedRoot, executor),
      sideEffectFreeScenario('version', options.image, isolatedRoot, executor),
      ...(['initial', 'cached', 'modified', 'untracked', 'deleted', 'data-json'] as const).map((id) =>
        fixtureScenario(id, rerunFixture),
      ),
    ];

    const cacheLifecycle = verifyCacheLifecycle(options.image, isolatedRoot, executor);
    scenarios.push(...cacheLifecycle.scenarios);

    const markers: QaMarker[] = [];
    for (const id of REQUIRED_RUNTIME_SCENARIOS) {
      const testId = QA_TEST_BY_SCENARIO[id];
      if (!testId) continue;
      const result = runRuntimeQaScenario(
        id,
        testId,
        { image: options.image, worktreesPath, cachePath, runtimePath },
        executor,
      );
      scenarios.push(result.scenario);
      if (result.marker) markers.push(result.marker);
    }

    const ordered = REQUIRED_RUNTIME_SCENARIOS.map((id) => {
      const matches = scenarios.filter((scenario) => scenario.id === id);
      if (matches.length !== 1) throw new Error(`runtime scenario ${id} executed ${matches.length} times`);
      return matches[0];
    });
    const fixtureTelemetries = rerunFixture.generations.flatMap((generation) =>
      generation.commands
        .map((command) => command.supervisor)
        .filter((value): value is Record<string, unknown> => value !== null),
    );
    const markerPeaks = markers.map((marker) => marker.after.memory_peak);
    const lifecyclePeaks = cacheLifecycle.telemetries.map((telemetry) => Number(telemetry.cgroup_memory_peak ?? 0));
    const fixturePeaks = fixtureTelemetries.map((telemetry) => Number(telemetry.cgroup_memory_peak ?? 0));
    const measuredPeakBytes = Math.max(0, ...markerPeaks, ...fixturePeaks, ...lifecyclePeaks);
    const memoryMax = markers[0]?.after.memory_max ?? 5120 * MIB;
    const eventsBefore = {
      oom: markers.reduce((sum, marker) => sum + marker.before.events.oom, 0),
      oom_kill: markers.reduce((sum, marker) => sum + marker.before.events.oom_kill, 0),
    };
    const eventsAfter = {
      oom: markers.reduce((sum, marker) => sum + marker.after.events.oom, 0),
      oom_kill: markers.reduce((sum, marker) => sum + marker.after.events.oom_kill, 0),
    };
    const active = executor.run(['docker', 'ps', '--filter', 'name=graphify-e2-', '--format', '{{.ID}}']);
    const orphanProcesses = active.exitCode === 0 ? active.stdout.split(/\r?\n/).filter(Boolean).length : 1;
    const sourceStageDebris = [...removeKnownRuntimeEntries(cachePath), ...cacheLifecycle.sourceStageDebris];
    const requestBytes = 2048 * MIB;
    const evidence: RuntimeEvidence = {
      schemaVersion: 1,
      image: options.image,
      imageId,
      isolatedRoot,
      requestMb: 2048,
      limitMb: 5120,
      tmpfsBytes: 192 * MIB,
      scenarios: ordered,
      cgroup: {
        memoryCurrentBefore: Math.max(0, ...markers.map((marker) => marker.before.memory_current)),
        memoryCurrentAfter: Math.max(0, ...markers.map((marker) => marker.after.memory_current)),
        memoryPeak: measuredPeakBytes,
        memoryMax,
        eventsBefore,
        eventsAfter,
      },
      requestAccounting: {
        requestBytes,
        measuredPeakBytes,
        overageBytes: Math.max(0, measuredPeakBytes - requestBytes),
      },
      repositoryClean:
        rerunFixture.cleanRepository && rerunFixture.repositoryArtifacts.length === 0 && cacheLifecycle.repositoryClean,
      cacheBleed: cacheLifecycle.cacheBleed,
      orphanProcesses,
      sourceStageDebris,
    };
    for (const scenario of evidence.scenarios) {
      scenario.details = { ...scenario.details, candidateSourceHashes };
    }
    return { evidence, gate: evaluateRuntimeEvidence(evidence) };
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const options = parseRuntimeCliArgs(process.argv.slice(2));
  const result = verifyGraphifyRuntime(options);
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  mkdirSync(path.dirname(options.evidence), { recursive: true });
  writeFileSync(options.evidence, encoded, 'utf8');
  process.stdout.write(encoded);
  if (!result.gate.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
