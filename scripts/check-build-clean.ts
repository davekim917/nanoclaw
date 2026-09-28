#!/usr/bin/env tsx
/**
 * Prebuild guard: dist/ is compiled from the WORKING TREE, not HEAD, so in a shared checkout a
 * build would capture whoever's half-finished work is on disk. Refuses a dirty tree (docs-only
 * dirt excepted; BUILD_ALLOW_DIRTY=1 overrides) and a HEAD other than origin/main
 * (BUILD_ALLOW_LOCAL=1 overrides).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IGNORABLE_DIRT_PREFIXES = ['docs/'];

export function isIgnorableDirtPath(filePath: string): boolean {
  if (IGNORABLE_DIRT_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  if (!filePath.includes('/')) {
    if (filePath.startsWith('README')) return true;
    if (filePath.endsWith('.md')) return true;
  }
  return false;
}

function stripQuotes(p: string): string {
  // git quotes unusual paths; docs-only dirt never needs that, so a plain strip is enough.
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
  return p;
}

/** Rename entries yield both sides. */
function pathsForLine(line: string): string[] {
  const rest = line.slice(3); // "XY " prefix
  const arrow = rest.indexOf(' -> ');
  if (arrow === -1) return [stripQuotes(rest)];
  return [stripQuotes(rest.slice(0, arrow)), stripQuotes(rest.slice(arrow + 4))];
}

/**
 * Stray `dist.*`/`node_modules.*` snapshot directories a hand-run deploy left beside `dist/`.
 * Decided by a real `isDirectory` check: a root file like `dist.config.ts` has the same shape.
 */
export function strayBuildArtifactDirs(paths: string[], isDirectory: (relPath: string) => boolean): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const head = p.split('/').filter((seg) => seg !== '')[0];
    if (head === undefined) continue;
    if (!/^(?:dist|node_modules)\./.test(head)) continue;
    if (!isDirectory(head)) continue;
    dirs.add(head);
  }
  return [...dirs].sort();
}

export interface DirtPartition {
  blocking: string[];
  ignored: string[];
}

export function partitionDirt(lines: string[]): DirtPartition {
  const blocking: string[] = [];
  const ignored: string[] = [];
  for (const line of lines) {
    const paths = pathsForLine(line);
    if (paths.every(isIgnorableDirtPath)) {
      ignored.push(line);
    } else {
      blocking.push(line);
    }
  }
  return { blocking, ignored };
}

export function pathsForLines(lines: string[]): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    for (const p of pathsForLine(line)) paths.add(p);
  }
  return [...paths].sort();
}

/** Must stay order-independent and stable across processes: postbuild recomputes it. */
export function fingerprintDirt(blockingLines: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const p of pathsForLines(blockingLines)) {
    hash.update(p);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(p));
    } catch {
      hash.update('<missing>'); // deleted/renamed-away path
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface FreshnessCheck {
  ok: boolean;
  /** Null when HEAD already matches. */
  message: string | null;
}

export function checkFreshness(head: string, originMain: string, allowLocal: boolean): FreshnessCheck {
  if (head === originMain) return { ok: true, message: null };
  if (allowLocal) {
    return {
      ok: true,
      message: `WARNING: BUILD_ALLOW_LOCAL=1 — HEAD (${head}) does not match origin/main (${originMain}). Building a local/unpushed tree.`,
    };
  }
  return {
    ok: false,
    message: [
      `BUILD REFUSED: HEAD (${head}) does not match origin/main (${originMain}).`,
      '',
      'A build must start from a tree matching origin/main so a build compiled from a',
      "stale local HEAD can't be mistaken for current after a reset or rebase.",
      '',
      'To proceed, either:',
      '  1. Fetch and fast-forward/rebase onto origin/main, then rebuild.',
      '  2. Set BUILD_ALLOW_LOCAL=1 to build the local tree anyway (prints a warning).',
    ].join('\n'),
  };
}

interface EslintMessage {
  ruleId: string | null;
  line: number;
  message: string;
  severity: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

/** eslint exits 1 on any lint error; its JSON report is on stdout either way. */
function execCaptureStdout(cmd: string, args: string[], options: { cwd: string }): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: options.cwd });
  } catch (err) {
    const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout;
    if (typeof stdout === 'string') return stdout;
    throw err;
  }
}

/** From `import.meta.url`, not `process.cwd()`: the test runs with `cwd` in a bare fixture repo. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface GuardStepResult {
  ok: boolean;
  message?: string;
}

export interface CheckBuildCleanSteps {
  typecheck(): GuardStepResult;
  lint(): GuardStepResult;
  status(): string[];
  freshness(): { head: string; originMain: string };
  fingerprint(blockingLines: string[]): string;
  recordBuildStart(head: string, dirtFingerprint: string): void;
}

export interface CheckBuildCleanOptions {
  steps?: Partial<CheckBuildCleanSteps>;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'BUILD_ALLOW_DIRTY' | 'BUILD_ALLOW_LOCAL'>>;
  log?: Pick<Console, 'error' | 'warn'>;
}

function failure(message: string): GuardStepResult {
  return { ok: false, message };
}

function runLintGate(): GuardStepResult {
  const eslintBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'eslint');
  const eslintArgs = ['src/', 'scripts/', 'setup/', '--quiet', '-f', 'json'];
  let stdout: string;
  try {
    stdout = execCaptureStdout('ionice', ['-c3', 'nice', '-n', '10', eslintBin, ...eslintArgs], { cwd: REPO_ROOT });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure(`BUILD REFUSED: lint gate could not run.\n${err instanceof Error ? err.message : String(err)}`);
    }
    // ionice missing: throttling is a courtesy, not a correctness requirement.
    try {
      stdout = execCaptureStdout(eslintBin, eslintArgs, { cwd: REPO_ROOT });
    } catch (fallbackError) {
      return failure(
        `BUILD REFUSED: lint gate could not run.\n${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }

  let results: EslintFileResult[];
  try {
    results = JSON.parse(stdout) as EslintFileResult[];
  } catch (err) {
    return failure(
      `BUILD REFUSED: lint gate produced invalid JSON.\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const errors: Array<{ filePath: string; line: number; ruleId: string | null; message: string }> = [];
  for (const result of results) {
    for (const m of result.messages) {
      if (m.severity === 2) {
        errors.push({ filePath: result.filePath, line: m.line, ruleId: m.ruleId, message: m.message });
      }
    }
  }
  if (errors.length === 0) return { ok: true };

  const lines = [`BUILD REFUSED: \`pnpm run lint\` found ${errors.length} error(s).`, ''];
  for (const e of errors.slice(0, 20)) {
    lines.push(`  ${e.filePath}:${e.line}  ${e.ruleId ?? '(parse error)'}  ${e.message}`);
  }
  if (errors.length > 20) lines.push(`  ... and ${errors.length - 20} more`);
  lines.push('', 'Run `pnpm run lint` to see the full list, fix, then rebuild.');
  return failure(lines.join('\n'));
}

function runTypecheckGate(): GuardStepResult {
  try {
    try {
      execFileSync('ionice', ['-c3', 'nice', '-n', '10', 'pnpm', 'run', 'typecheck'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      execFileSync('nice', ['-n', '10', 'pnpm', 'run', 'typecheck'], { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  } catch (err) {
    return failure(`BUILD REFUSED: typecheck gate failed.\n${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true };
}

function readStatus(): string[] {
  // Don't .trim() before splitting: a porcelain line can start with a space (" M path").
  const raw = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return raw.trim() ? raw.split('\n').filter((line) => line.length > 0) : [];
}

function readFreshness(): { head: string; originMain: string } {
  execFileSync('git', ['fetch', '-q', 'origin', 'main']);
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    originMain: execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim(),
  };
}

function recordBuildStart(head: string, dirtFingerprint: string): void {
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync(path.join('dist', '.build-start-sha'), `${head}\n`);
  fs.writeFileSync(path.join('dist', '.build-allowed-dirt-fingerprint'), dirtFingerprint);
}

const realSteps: CheckBuildCleanSteps = {
  typecheck: runTypecheckGate,
  lint: runLintGate,
  status: readStatus,
  freshness: readFreshness,
  fingerprint: fingerprintDirt,
  recordBuildStart,
};

export function runCheckBuildClean(options: CheckBuildCleanOptions = {}): number {
  const steps = { ...realSteps, ...options.steps };
  const env = options.env ?? process.env;
  const log = options.log ?? console;

  for (const step of [steps.typecheck, steps.lint]) {
    const result = step();
    if (!result.ok) {
      log.error(result.message ?? 'BUILD REFUSED: build gate failed.');
      return 1;
    }
  }

  let files: string[];
  try {
    files = steps.status();
  } catch (err) {
    log.error('BUILD REFUSED: could not read working tree status.');
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let blocking: string[] = [];
  if (files.length > 0) {
    const partition = partitionDirt(files);
    blocking = partition.blocking;

    if (env.BUILD_ALLOW_DIRTY === '1') {
      log.warn('WARNING: BUILD_ALLOW_DIRTY=1 — building a dirty working tree. dist/ will not match HEAD:');
      for (const f of files) log.warn(`  ${f}`);
    } else {
      if (partition.ignored.length > 0) {
        log.warn(`ignoring docs-only dirt: ${partition.ignored.map((line) => line.slice(3)).join(', ')}`);
      }

      if (blocking.length > 0) {
        log.error('BUILD REFUSED: working tree is dirty.\n');
        log.error('dist/ is compiled from the working tree, not from HEAD. Building now would bake');
        log.error('these uncommitted changes into dist/, which a restart could then run.\n');
        log.error('Dirty paths (git status --porcelain):');
        for (const f of blocking) log.error(`  ${f}`);

        const strays = strayBuildArtifactDirs(pathsForLines(blocking), (rel) => {
          try {
            return fs.statSync(path.join(REPO_ROOT, rel)).isDirectory();
          } catch {
            return false; // vanished between status and here — not our business
          }
        });
        if (strays.length > 0) {
          log.error('\nStray build snapshots (left by a hand-run deploy, NOT by scripts/deploy.sh):');
          for (const f of strays) log.error(`  ${f}`);
          log.error('\nDo not commit, stash, or BUILD_ALLOW_DIRTY these — move them out of the repo');
          log.error('or delete them. scripts/deploy.sh snapshots rollback state as dist.pre-deploy/');
          log.error('and node_modules.pre-deploy/, which are gitignored and hardlinked; prefer it over');
          log.error('a hand-run pull/build/restart so no snapshot lands here in the first place.');
          return 1;
        }

        log.error('\nTo proceed, either:');
        log.error('  1. Commit or stash the changes above, then rebuild.');
        log.error('  2. Set BUILD_ALLOW_DIRTY=1 to build anyway (prints a warning, stamps dirty:true).');
        return 1;
      }
    }
  }

  let freshnessInputs: { head: string; originMain: string };
  try {
    freshnessInputs = steps.freshness();
  } catch (err) {
    log.error('BUILD REFUSED: could not verify HEAD against origin/main.');
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const freshness = checkFreshness(freshnessInputs.head, freshnessInputs.originMain, env.BUILD_ALLOW_LOCAL === '1');
  if (freshness.message) {
    if (freshness.ok) log.warn(freshness.message);
    else log.error(freshness.message);
  }
  if (!freshness.ok) return 1;

  try {
    steps.recordBuildStart(freshnessInputs.head, steps.fingerprint(blocking));
  } catch (err) {
    log.error('BUILD REFUSED: could not record build start.');
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCheckBuildClean());
}
