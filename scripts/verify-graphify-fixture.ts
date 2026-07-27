#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export interface FixtureFileState {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FixtureCase {
  id: string;
  command: 'query' | 'path' | 'explain' | 'affected';
  arguments: string[];
  requiredFacts: string[];
  forbiddenFacts: string[];
  expectEmpty?: boolean;
}

export interface FixtureGeneration {
  id: string;
  fingerprint: string;
  files: FixtureFileState[];
  intentionalExclusions: string[];
  cases: FixtureCase[];
  mutations?: FixtureMutation[];
}

export type FixtureMutation =
  | { operation: 'write'; path: string; content: string }
  | { operation: 'delete'; path: string };

export interface FixtureGroundTruth {
  version: 1;
  generations: FixtureGeneration[];
}

export type FixtureOutputs = Record<string, string>;

export interface FixtureCaseScore {
  id: string;
  passed: boolean;
  requiredMissing: string[];
  forbiddenPresent: string[];
  outputBytes: number;
}

export interface FixtureGenerationScore {
  generation: string;
  fingerprint: string;
  generationError?: string;
  passed: boolean;
  score: number;
  cases: FixtureCaseScore[];
}

export interface FixtureDockerInvocation {
  image: string;
  worktreesPath: string;
  cachePath: string;
  runtimePath: string;
  repositoryName: string;
  command: FixtureCase['command'];
  arguments: string[];
}

export interface FixtureCommandEvidence {
  caseId: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  supervisor: Record<string, unknown> | null;
}

export interface FixtureVerificationEvidence {
  schemaVersion: 1;
  image: string;
  imageId: string;
  fixtureFingerprint: string;
  cleanRepository: boolean;
  repositoryArtifacts: string[];
  generations: Array<{
    id: string;
    fingerprint: string;
    acceptedFingerprint: string | null;
    intentionalExclusions: string[];
    score: FixtureGenerationScore;
    commands: FixtureCommandEvidence[];
  }>;
  passed: boolean;
}

export interface FixtureCliOptions {
  image: string;
  fixture: string;
  evidence?: string;
}

const EMPTY_RESULTS = new Set(['', 'No path.', 'No matching node.']);
const FILE_PATTERN = /(?:^|[\s"'=:])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|mts|cts|js|jsx|py|json))/g;
const SYMBOL_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export function computeFixtureFingerprint(files: FixtureFileState[]): string {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(file.path);
    digest.update('\0');
    digest.update(file.sha256);
    digest.update('\0');
    digest.update(String(file.bytes));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function fixturePath(root: URL | string): string {
  return typeof root === 'string' ? path.resolve(root) : fileURLToPath(root);
}

function fixtureSourceContents(root: URL | string): Map<string, Buffer> {
  const sourceRoot = path.join(fixturePath(root), 'src');
  const contents = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile())
        contents.set(path.relative(fixturePath(root), absolute).replaceAll(path.sep, '/'), readFileSync(absolute));
    }
  };
  visit(sourceRoot);
  contents.set('dataset.json', readFileSync(path.join(fixturePath(root), 'dataset.json')));
  return contents;
}

export function fixtureFilesForGeneration(root: URL | string, generation: FixtureGeneration): FixtureFileState[] {
  const contents = fixtureSourceContents(root);
  for (const mutation of generation.mutations ?? []) {
    if (!(mutation.path === 'dataset.json' || mutation.path.startsWith('src/')) || mutation.path.includes('..')) {
      throw new Error(`unsafe fixture mutation path: ${mutation.path}`);
    }
    if (mutation.operation === 'delete') contents.delete(mutation.path);
    else contents.set(mutation.path, Buffer.from(mutation.content, 'utf8'));
  }
  return [...contents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => ({
      path: filePath,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    }));
}

export function loadFixtureGroundTruth(root: URL | string): FixtureGroundTruth {
  const parsed: unknown = JSON.parse(readFileSync(path.join(fixturePath(root), 'ground-truth.json'), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { generations?: unknown }).generations)
  ) {
    throw new Error('invalid Graphify fixture ground-truth schema');
  }
  return parsed as FixtureGroundTruth;
}

export function buildFixtureDockerArgs(invocation: FixtureDockerInvocation): string[] {
  const workdir = `/workspace/worktrees/${invocation.repositoryName}`;
  return [
    'run',
    '--rm',
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
    `${invocation.worktreesPath}:/workspace/worktrees`,
    '-v',
    `${invocation.cachePath}:/workspace/.cache/graphify`,
    '-v',
    `${invocation.runtimePath}:/run/nanoclaw-graphify`,
    '--workdir',
    workdir,
    '--entrypoint',
    '/usr/local/bin/graphify',
    invocation.image,
    invocation.command,
    ...invocation.arguments,
  ];
}

export function parseFixtureCliArgs(args: string[]): FixtureCliOptions {
  let image = '';
  let fixture = fileURLToPath(new URL('../tests/fixtures/graphify-eval/', import.meta.url));
  let evidence: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? 'argument'}`);
    if (flag === '--image') image = value;
    else if (flag === '--fixture') fixture = path.resolve(value);
    else if (flag === '--evidence') evidence = path.resolve(value);
    else throw new Error(`unsupported fixture verifier option: ${flag}`);
  }
  if (!image) throw new Error('--image is required');
  return evidence ? { image, fixture, evidence } : { image, fixture };
}

function run(command: string, args: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function materializeGeneration(fixtureRoot: string, repositoryRoot: string, generation: FixtureGeneration): void {
  const targetSource = path.join(repositoryRoot, 'src');
  rmSync(targetSource, { recursive: true, force: true });
  cpSync(path.join(fixtureRoot, 'src'), targetSource, { recursive: true });
  cpSync(path.join(fixtureRoot, 'dataset.json'), path.join(repositoryRoot, 'dataset.json'));
  for (const mutation of generation.mutations ?? []) {
    const target = path.join(repositoryRoot, mutation.path);
    if (!target.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error(`unsafe mutation: ${mutation.path}`);
    if (mutation.operation === 'delete') rmSync(target, { force: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, mutation.content, 'utf8');
    }
  }
}

function filesBelowSource(repositoryRoot: string): FixtureFileState[] {
  const sourceRoot = path.join(repositoryRoot, 'src');
  const states: FixtureFileState[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        const content = readFileSync(absolute);
        states.push({
          path: path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'),
          bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
    }
  };
  visit(sourceRoot);
  const dataset = readFileSync(path.join(repositoryRoot, 'dataset.json'));
  states.push({
    path: 'dataset.json',
    bytes: dataset.byteLength,
    sha256: createHash('sha256').update(dataset).digest('hex'),
  });
  return states.sort((left, right) => left.path.localeCompare(right.path));
}

function supervisorTelemetry(stderr: string): Record<string, unknown> | null {
  const prefix = 'NANOCLAW_GRAPHIFY_SUPERVISOR ';
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(prefix.length));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function graphifyCacheKey(repositoryName: string): string {
  return createHash('sha256').update(`/workspace/worktrees/${repositoryName}`).digest('hex');
}

export function verifyFixtureInImage(image: string, fixtureRootInput: URL | string): FixtureVerificationEvidence {
  const fixtureRoot = fixturePath(fixtureRootInput);
  const groundTruth = loadFixtureGroundTruth(fixtureRoot);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-graphify-fixture-'));
  const worktreesPath = path.join(temporaryRoot, 'worktrees');
  const cachePath = path.join(temporaryRoot, 'cache');
  const runtimePath = path.join(temporaryRoot, 'runtime');
  const repositoryName = 'graphify-eval';
  const repositoryRoot = path.join(worktreesPath, repositoryName);
  for (const directory of [worktreesPath, cachePath, runtimePath, repositoryRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  try {
    materializeGeneration(fixtureRoot, repositoryRoot, groundTruth.generations[0]);
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'person16@fixture13.example.com'],
      ['config', 'user.name', 'NanoClaw Graphify Fixture'],
      ['add', 'src', 'dataset.json'],
      ['commit', '-qm', 'graphify evaluation fixture'],
    ]) {
      const result = run('git', args, repositoryRoot);
      if (result.exitCode !== 0) throw new Error(`fixture git setup failed: ${result.stderr}`);
    }

    const imageInspect = run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (imageInspect.exitCode !== 0) throw new Error(`candidate image is unavailable: ${imageInspect.stderr}`);
    const generations: FixtureVerificationEvidence['generations'] = [];

    for (const generation of groundTruth.generations) {
      materializeGeneration(fixtureRoot, repositoryRoot, generation);
      const actualFiles = filesBelowSource(repositoryRoot);
      const outputs: FixtureOutputs = {};
      const commands: FixtureCommandEvidence[] = [];
      for (const fixtureCase of generation.cases) {
        const args = buildFixtureDockerArgs({
          image,
          worktreesPath,
          cachePath,
          runtimePath,
          repositoryName,
          command: fixtureCase.command,
          arguments: fixtureCase.arguments,
        });
        const result = run('docker', args);
        outputs[fixtureCase.id] = result.stdout;
        commands.push({
          caseId: fixtureCase.id,
          command: ['docker', ...args],
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          supervisor: supervisorTelemetry(result.stderr),
        });
      }
      const live = path.join(cachePath, graphifyCacheKey(repositoryName), 'live');
      const acceptedState = existsSync(path.join(live, 'source-state.json'))
        ? (JSON.parse(readFileSync(path.join(live, 'source-state.json'), 'utf8')) as { fingerprint?: string })
        : null;
      const status = existsSync(path.join(live, 'status.json'))
        ? (JSON.parse(readFileSync(path.join(live, 'status.json'), 'utf8')) as { intentional_exclusions?: string[] })
        : null;
      generations.push({
        id: generation.id,
        fingerprint: computeFixtureFingerprint(actualFiles),
        acceptedFingerprint: acceptedState?.fingerprint ?? null,
        intentionalExclusions: status?.intentional_exclusions ?? [],
        score: scoreFixtureGeneration(groundTruth, generation.id, actualFiles, outputs),
        commands,
      });
    }

    materializeGeneration(fixtureRoot, repositoryRoot, groundTruth.generations[0]);
    const clean = run('git', ['status', '--porcelain'], repositoryRoot).stdout.trim() === '';
    const repositoryArtifacts: string[] = [];
    const findArtifacts = (directory: string): void => {
      for (const entry of readdirSync(directory).sort()) {
        if (entry === '.git') continue;
        const absolute = path.join(directory, entry);
        const stat = statSync(absolute);
        if (stat.isDirectory()) findArtifacts(absolute);
        else if (['graph.json', 'manifest.json', 'source-state.json', 'status.json'].includes(entry)) {
          repositoryArtifacts.push(path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'));
        }
      }
    };
    findArtifacts(repositoryRoot);
    const passed =
      clean &&
      repositoryArtifacts.length === 0 &&
      generations.every(
        (entry) =>
          entry.score.passed &&
          entry.commands.every((command) => command.exitCode === 0) &&
          entry.acceptedFingerprint === entry.fingerprint &&
          entry.intentionalExclusions.length === 1 &&
          entry.intentionalExclusions[0] === 'dataset.json',
      );
    return {
      schemaVersion: 1,
      image,
      imageId: imageInspect.stdout.trim(),
      fixtureFingerprint: groundTruth.generations[0].fingerprint,
      cleanRepository: clean,
      repositoryArtifacts,
      generations,
      passed,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const options = parseFixtureCliArgs(process.argv.slice(2));
  const evidence = verifyFixtureInImage(options.image, options.fixture);
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.evidence) {
    mkdirSync(path.dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, encoded, 'utf8');
  }
  process.stdout.write(encoded);
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

function normalizedFacts(output: string): Set<string> {
  const facts = new Set<string>();
  for (const match of output.matchAll(FILE_PATTERN)) facts.add(`file:${match[1].replaceAll('\\', '/')}`);
  for (const match of output.matchAll(SYMBOL_PATTERN)) facts.add(`symbol:${match[0]}`);

  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('->')) continue;
    const path = line
      .split('->')
      .map((part) => part.trim().match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0])
      .filter((value): value is string => Boolean(value));
    for (let index = 0; index + 1 < path.length; index += 1) {
      facts.add(`edge:${path[index]}->${path[index + 1]}`);
    }
  }
  return facts;
}

export function scoreFixtureGeneration(
  groundTruth: FixtureGroundTruth,
  generationId: string,
  actualFiles: FixtureFileState[],
  outputs: FixtureOutputs,
): FixtureGenerationScore {
  const generation = groundTruth.generations.find((entry) => entry.id === generationId);
  if (!generation) {
    return {
      generation: generationId,
      fingerprint: computeFixtureFingerprint(actualFiles),
      generationError: `unknown fixture generation: ${generationId}`,
      passed: false,
      score: 0,
      cases: [],
    };
  }

  const actualFingerprint = computeFixtureFingerprint(actualFiles);
  if (actualFingerprint !== generation.fingerprint) {
    return {
      generation: generationId,
      fingerprint: actualFingerprint,
      generationError: `fixture fingerprint mismatch: expected ${generation.fingerprint}, got ${actualFingerprint}`,
      passed: false,
      score: 0,
      cases: [],
    };
  }

  const cases = generation.cases.map((fixtureCase): FixtureCaseScore => {
    const output = outputs[fixtureCase.id] ?? '';
    const facts = normalizedFacts(output);
    const requiredMissing = fixtureCase.requiredFacts.filter((fact) => !facts.has(fact)).sort();
    const forbiddenPresent = fixtureCase.forbiddenFacts.filter((fact) => facts.has(fact)).sort();
    const emptyPass = fixtureCase.expectEmpty !== true || EMPTY_RESULTS.has(output.trim());
    return {
      id: fixtureCase.id,
      passed: requiredMissing.length === 0 && forbiddenPresent.length === 0 && emptyPass,
      requiredMissing,
      forbiddenPresent,
      outputBytes: Buffer.byteLength(output, 'utf8'),
    };
  });
  const passedCases = cases.filter((entry) => entry.passed).length;
  const score = cases.length === 0 ? 0 : passedCases / cases.length;
  return {
    generation: generationId,
    fingerprint: actualFingerprint,
    passed: score === 1,
    score,
    cases,
  };
}
