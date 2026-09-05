#!/usr/bin/env tsx
/**
 * Prebuild guard: dist/ is compiled from the WORKING TREE, not from HEAD. In
 * a checkout shared by several concurrent agents, `pnpm run build` would
 * otherwise silently capture whoever's half-finished work happens to be on
 * disk. This refuses to build on a dirty tree; BUILD_ALLOW_DIRTY=1 overrides
 * (loudly) for a deliberate local build.
 *
 * Docs-only dirt is exempted: `dist/` never contains docs/** or root-level
 * markdown, so a peer session's staged docs/specs/**\/*.md can't leak into a
 * build the way a src/ or scripts/ change could. The whitelist below is
 * intentionally narrow — anything under src/, container/, scripts/,
 * dashboard/, setup/, .github/, or a build-relevant manifest still blocks.
 *
 * Second guard, same failure family: a build must also start from a HEAD
 * that matches origin/main — a peer committing then resetting local main
 * mid-build must not have its stale dist/ mistaken for current. BUILD_ALLOW_LOCAL=1
 * overrides (loudly) for a deliberate local/unpushed build. The HEAD sha this
 * check settles on is written to dist/.build-start-sha so the postbuild step
 * (scripts/write-build-info.ts) can detect HEAD moving *during* the build.
 *
 * A content fingerprint of whatever blocking dirt BUILD_ALLOW_DIRTY=1 let
 * through is written alongside it (dist/.build-allowed-dirt-fingerprint), so
 * BUILD_ALLOW_DIRTY waives the check for exactly the dirt that was present
 * at prebuild time — not for a peer's mid-build edit to an already-dirty (or
 * newly dirty) file, which would otherwise slip through unnoticed just
 * because *some* dirt was already permitted.
 *
 * Third guard, unrelated failure family: `pnpm run lint` must be green
 * before tsc runs (seam 3 — no-floating-promises / no-misused-promises /
 * projectService only gate anything if the pre-existing backlog can't just
 * sit there red forever). Runs throttled (ionice + nice), same as the manual
 * invocations this mirrors, so a build kicked off on a shared host doesn't
 * starve co-resident agent containers; falls back to an unthrottled run if
 * ionice isn't installed rather than blocking on a missing OS utility.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path prefixes that never affect dist/ output, wherever they appear in the tree. */
const IGNORABLE_DIRT_PREFIXES = ['docs/'];

/**
 * A dirty path that cannot affect dist/ and is safe to build through
 * without the BUILD_ALLOW_DIRTY escape hatch. Root-level markdown
 * (README*, CHANGELOG.md, any other *.md directly at repo root) is
 * documentation by convention in this repo; everything nested elsewhere
 * (including dashboard/README.md, say) still blocks.
 */
export function isIgnorableDirtPath(filePath: string): boolean {
  if (IGNORABLE_DIRT_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  if (!filePath.includes('/')) {
    if (filePath.startsWith('README')) return true;
    if (filePath.endsWith('.md')) return true;
  }
  return false;
}

function stripQuotes(p: string): string {
  // git quotes paths containing unusual characters; docs-only dirt never
  // needs that, so a plain strip (no C-style unescape) is sufficient here.
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
  return p;
}

/** Extracts the path(s) a `git status --porcelain` line refers to. Rename entries yield both sides. */
function pathsForLine(line: string): string[] {
  const rest = line.slice(3); // "XY " prefix
  const arrow = rest.indexOf(' -> ');
  if (arrow === -1) return [stripQuotes(rest)];
  return [stripQuotes(rest.slice(0, arrow)), stripQuotes(rest.slice(arrow + 4))];
}

export interface DirtPartition {
  /** Porcelain lines that block the build. */
  blocking: string[];
  /** Porcelain lines that are docs-only and safe to build through. */
  ignored: string[];
}

/** Splits `git status --porcelain` lines into build-blocking and safely-ignorable dirt. */
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

/** The distinct paths referenced by a set of `git status --porcelain` lines, sorted for determinism. */
export function pathsForLines(lines: string[]): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    for (const p of pathsForLine(line)) paths.add(p);
  }
  return [...paths].sort();
}

/**
 * Content fingerprint of a set of blocking dirty paths, read relative to the
 * current working directory. Order-independent and stable across separate
 * processes (prebuild writes it, postbuild recomputes it) so a BUILD_ALLOW_DIRTY
 * build can detect its allowed dirt changing content mid-build, not just a
 * change in *which* paths are dirty.
 */
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
  /** Printed via console.warn when ok+overridden, console.error when refused. Null when HEAD already matches. */
  message: string | null;
}

/** Decides whether HEAD is fresh enough to build from: it must match origin/main unless BUILD_ALLOW_LOCAL=1 overrides. */
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

/**
 * Runs a command and returns its stdout whether it exited 0 or not — eslint
 * exits 1 the moment it finds a single lint error, which is the normal,
 * expected outcome here (not a tooling failure), and its JSON report is on
 * stdout either way. A genuine spawn failure (bad path, ENOENT) has no
 * `.stdout` on the thrown error, so that case still throws.
 */
function execCaptureStdout(cmd: string, args: string[], options: { cwd: string }): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: options.cwd });
  } catch (err) {
    const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout;
    if (typeof stdout === 'string') return stdout;
    throw err;
  }
}

/**
 * Absolute path to this script's own directory's parent — the repo root
 * where `node_modules/`, `src/`, and `scripts/` actually live. Resolving via
 * `import.meta.url` (not `process.cwd()`) matters here specifically:
 * check-build-clean.test.ts spawns this script with `cwd` pointed at a
 * throwaway fixture git repo that has none of those — a relative
 * `node_modules/.bin/eslint` (or relative `src/`/`scripts/` lint targets)
 * would silently resolve against the fixture instead of the real checkout.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface GuardStepResult {
  ok: boolean;
  /** Printed when the guard refuses the step. */
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
  /** Override individual I/O-heavy steps for decision-logic tests. */
  steps?: Partial<CheckBuildCleanSteps>;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'BUILD_ALLOW_DIRTY' | 'BUILD_ALLOW_LOCAL'>>;
  log?: Pick<Console, 'error' | 'warn'>;
}

function failure(message: string): GuardStepResult {
  return { ok: false, message };
}

/** Prebuild lint gate: refuses to build if `pnpm run lint`'s eslint invocation finds errors. */
function runLintGate(): GuardStepResult {
  const eslintBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'eslint');
  const eslintArgs = ['src/', 'scripts/', '--quiet', '-f', 'json'];
  let stdout: string;
  try {
    stdout = execCaptureStdout('ionice', ['-c3', 'nice', '-n', '10', eslintBin, ...eslintArgs], { cwd: REPO_ROOT });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure(`BUILD REFUSED: lint gate could not run.\n${err instanceof Error ? err.message : String(err)}`);
    }
    // ionice isn't installed on this host — throttling is a courtesy to
    // co-resident builders, not a build-correctness requirement.
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

/** Typecheck host, scripts, and setup before accepting a build. */
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
  // NOTE: don't .trim() the raw output before splitting — porcelain status
  // codes can start with a leading space (e.g. " M path" for an unstaged
  // modification), and trimming the whole multi-line string strips that
  // leading space off the FIRST line only, shifting `pathsForLine`'s 3-char
  // prefix slice by one and corrupting the path. Split first, then drop the
  // empty trailing element from the output's final newline.
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

/**
 * Runs the prebuild decision flow and returns an exit code. The direct CLI
 * entry point below is intentionally the only place that calls process.exit;
 * tests inject the expensive steps and assert this return value in process.
 */
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

// tsx runs this file directly; vitest imports it for the pure helpers above,
// so guard the side-effecting entry point behind a direct-execution check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCheckBuildClean());
}
