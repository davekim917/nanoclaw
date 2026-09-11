#!/usr/bin/env tsx
/**
 * check-risk-coverage — the coverage ratchet docs/specs/risk-based-review/plan.md's
 * "Tests on risky paths" item calls for: coverage on the risk:high paths
 * (.github/labeler.yml) can go up, but it can never quietly drop. NOT a fixed floor —
 * plan.md's Non-goals section is explicit that copying someone else's 85% number is out
 * of scope; this only ratchets against this repo's OWN prior measurement.
 *
 * Inputs (produced separately, never by this script):
 *   - host:      `pnpm run test:coverage:risk` → coverage/coverage-summary.json
 *                (vitest's `json-summary` reporter; `coverage.include` in
 *                vitest.config.ts already scopes instrumentation to the host half of
 *                risk:high via scripts/risk-globs.ts, derived at run time — see that
 *                file and vitest.config.ts's `readHostRiskGlobs`).
 *   - container: `bun run test -- --coverage --coverage-reporter=lcov` (from
 *                container/agent-runner) → container/agent-runner/coverage/lcov.info.
 *                Optional: a run with host coverage only still produces a valid,
 *                host-scoped report (see `--container-lcov`).
 *
 * This script itself only reads those two reports plus `.github/labeler.yml`, computes
 * one merged per-file line-coverage table over every risk file that exists on disk, and
 * compares it against the committed baseline (default `coverage-risk-baseline.json`).
 *
 * Fails (exit 1) when, for any risk file:
 *   - it was in the baseline and current coverage is more than `--threshold` (default
 *     0.5) points below the baseline value, or
 *   - it is NOT in the baseline (a risk file the baseline predates) and has no coverage
 *     at all (0%, or entirely absent from both reports).
 * A new risk file WITH some coverage does not fail — `--write` folds it into the
 * baseline for the next run to ratchet against.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-risk-coverage.ts [--write]
 *     [--host-summary <path>] [--container-lcov <path>] [--baseline <path>]
 *     [--threshold <points>] [--json]
 *
 * Defaults: --host-summary coverage/coverage-summary.json,
 *   --container-lcov container/agent-runner/coverage/lcov.info (skipped with a warning
 *   if absent), --baseline coverage-risk-baseline.json, --threshold 0.5.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { globsForRiskHigh } from './review-outcomes.js';
import { containerRiskGlobs, hostRiskGlobs } from './risk-globs.js';

// ─────────────────────────── types ─────────────────────────────────────────

export interface CoverageStat {
  covered: number;
  total: number;
  pct: number;
}

export type FileStatus = 'ok' | 'regressed' | 'new-untested' | 'new';

export interface FileRow {
  file: string;
  baselinePct: number | null;
  currentPct: number | null;
  delta: number | null;
  status: FileStatus;
}

export interface EvaluateResult {
  rows: FileRow[];
  failures: FileRow[];
  passed: boolean;
}

export interface Baseline {
  generatedAt: string;
  files: Record<string, number>;
}

const DEFAULT_THRESHOLD = 0.5;

// ─────────────────────────── pure logic ────────────────────────────────────

/** `risk:high` from a parsed `.github/labeler.yml`, split host vs container. */
export function readRiskGlobs(labelerConfig: Record<string, unknown>): { host: string[]; container: string[] } {
  const all = globsForRiskHigh(labelerConfig);
  return { host: hostRiskGlobs(all), container: containerRiskGlobs(all) };
}

/**
 * `.ts` files under `repoRoot` matching any of `globs`, excluding `*.test.ts` (a test
 * file isn't a coverage TARGET; it's what exercises one). Only walks the top-level
 * directory each glob starts with (`src`, `scripts`, or `container`) rather than the
 * whole repo, since every risk:high host/container glob is rooted at one of those three
 * — bounded and fast rather than a full-repo walk.
 */
export function discoverRiskFiles(repoRoot: string, globs: readonly string[]): string[] {
  const roots = new Set(globs.map((glob) => glob.split('/')[0]));
  const found: string[] = [];
  for (const root of roots) {
    found.push(...walkTsFiles(path.join(repoRoot, root), root));
  }
  return found.filter((file) => matchesAnyGlob(file, globs)).sort();
}

function walkTsFiles(absDir: string, relDir: string): string[] {
  if (!fs.existsSync(absDir)) return [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(path.join(absDir, entry.name), relPath));
    } else if (entry.isFile() && relPath.endsWith('.ts') && !relPath.endsWith('.test.ts')) {
      out.push(relPath);
    }
  }
  return out;
}

/** Mirrors `matchesAnyGlob` (scripts/review-outcomes.ts) — not imported: that one is
 * typed for PR changed-file lists; this one is typed for on-disk discovery, and both
 * are one-line wrappers over the same `path.matchesGlob`, so duplication costs nothing
 * and keeps each call site's intent legible on its own. */
function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => path.matchesGlob(filePath, glob));
}

/**
 * `coverage-summary.json` (vitest's `json-summary` coverage reporter) keys files by
 * ABSOLUTE path (verified against a real run: every non-"total" key was
 * `<repoRoot>/src/...` or `<repoRoot>/scripts/...`). Strips `repoRoot` to get the
 * repo-relative path every other part of this script keys on.
 */
export function parseVitestJsonSummary(summary: Record<string, unknown>, repoRoot: string): Map<string, CoverageStat> {
  const out = new Map<string, CoverageStat>();
  const prefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue;
    if (!key.startsWith(prefix)) continue;
    const lines = (value as { lines?: { covered?: number; total?: number; pct?: number } }).lines;
    if (!lines || typeof lines.total !== 'number' || typeof lines.covered !== 'number') continue;
    const relPath = key.slice(prefix.length).split(path.sep).join('/');
    out.set(relPath, { covered: lines.covered, total: lines.total, pct: pctOf(lines.covered, lines.total) });
  }
  return out;
}

/**
 * lcov (bun's `--coverage-reporter=lcov`), one SF:/DA: block per file. `sfToRepoPath`
 * maps the lcov-relative `SF:` value (relative to wherever `bun test` ran, i.e.
 * `container/agent-runner`) to a repo-root-relative path.
 */
export function parseLcov(lcov: string, sfToRepoPath: (sf: string) => string): Map<string, CoverageStat> {
  const out = new Map<string, CoverageStat>();
  let currentFile: string | null = null;
  let covered = 0;
  let total = 0;
  const flush = (): void => {
    if (currentFile !== null) out.set(currentFile, { covered, total, pct: pctOf(covered, total) });
  };
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      flush();
      currentFile = sfToRepoPath(line.slice('SF:'.length).trim());
      covered = 0;
      total = 0;
    } else if (line.startsWith('DA:')) {
      const [, hitsStr] = line.slice('DA:'.length).split(',');
      total += 1;
      if (Number(hitsStr) > 0) covered += 1;
    } else if (line.startsWith('end_of_record')) {
      flush();
      currentFile = null;
    }
  }
  return out;
}

/** Istanbul/lcov convention: a file with zero countable lines is 100% covered. */
function pctOf(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

/** `container/agent-runner/<sf>`, normalized (lcov SF: values may start with `../`). */
export function containerSfToRepoPath(sf: string): string {
  return path.posix.normalize(path.posix.join('container/agent-runner', sf));
}

export function mergeCoverage(...maps: ReadonlyArray<Map<string, CoverageStat>>): Map<string, CoverageStat> {
  const out = new Map<string, CoverageStat>();
  for (const map of maps) for (const [file, stat] of map) out.set(file, stat);
  return out;
}

export function evaluate(
  riskFiles: readonly string[],
  current: ReadonlyMap<string, CoverageStat>,
  baseline: Baseline,
  threshold = DEFAULT_THRESHOLD,
): EvaluateResult {
  const rows: FileRow[] = riskFiles.map((file) => {
    const currentPct = current.get(file)?.pct ?? null;
    const baselinePct = Object.hasOwn(baseline.files, file) ? baseline.files[file] : null;

    let status: FileStatus;
    let delta: number | null;
    if (baselinePct === null) {
      // No prior measurement to ratchet against — the only failure mode for a new
      // risk file is "nothing at all exercises it yet".
      delta = null;
      status = currentPct === null || currentPct === 0 ? 'new-untested' : 'new';
    } else {
      // A file present in the baseline but absent from the current report (e.g. it
      // stopped being imported by anything) is a total regression, same as a drop
      // to 0% — treat missing as 0 rather than silently skipping the comparison.
      const effectiveCurrent = currentPct ?? 0;
      delta = effectiveCurrent - baselinePct;
      status = delta < -threshold ? 'regressed' : 'ok';
    }
    return { file, baselinePct, currentPct, delta, status };
  });

  const failures = rows.filter((row) => row.status === 'regressed' || row.status === 'new-untested');
  return { rows, failures, passed: failures.length === 0 };
}

export function buildBaseline(riskFiles: readonly string[], current: ReadonlyMap<string, CoverageStat>): Baseline {
  const files: Record<string, number> = {};
  for (const file of [...riskFiles].sort()) {
    files[file] = round2(current.get(file)?.pct ?? 0);
  }
  return { generatedAt: new Date().toISOString(), files };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────── table rendering ───────────────────────────────

function fmtPct(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(2)}%`;
}

function fmtDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}`;
}

export function renderTable(rows: readonly FileRow[]): string {
  const header = ['file', 'baseline', 'current', 'delta', 'status'];
  const lines = rows.map((row) => [
    row.file,
    fmtPct(row.baselinePct),
    fmtPct(row.currentPct),
    fmtDelta(row.delta),
    row.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const renderRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [renderRow(header), renderRow(widths.map((w) => '-'.repeat(w))), ...lines.map(renderRow)].join('\n');
}

export function summarize(rows: readonly FileRow[]): { count: number; min: number | null; median: number | null } {
  const pcts = rows.map((r) => r.currentPct).filter((p): p is number => p !== null);
  if (pcts.length === 0) return { count: rows.length, min: null, median: null };
  const sorted = [...pcts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { count: rows.length, min: sorted[0], median };
}

// ─────────────────────────── CLI ───────────────────────────────────────────

interface Options {
  write: boolean;
  hostSummary: string;
  containerLcov: string;
  baseline: string;
  threshold: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    write: false,
    hostSummary: 'coverage/coverage-summary.json',
    containerLcov: 'container/agent-runner/coverage/lcov.info',
    baseline: 'coverage-risk-baseline.json',
    threshold: DEFAULT_THRESHOLD,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    if (name === '--write') options.write = true;
    else if (name === '--host-summary') options.hostSummary = inline ?? next();
    else if (name === '--container-lcov') options.containerLcov = inline ?? next();
    else if (name === '--baseline') options.baseline = inline ?? next();
    else if (name === '--threshold') options.threshold = Number(inline ?? next());
    else if (name === '--json') options.json = true;
    else if (name === '--help' || name === '-h') usage();
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.threshold) || options.threshold < 0) fail('--threshold must be a non-negative number');
  return options;
}

function fail(message: string): never {
  console.error(`check-risk-coverage: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      'Usage: tsx scripts/check-risk-coverage.ts [--write] [--host-summary <path>]',
      '         [--container-lcov <path>] [--baseline <path>] [--threshold <points>] [--json]',
      '',
      'Ratchets per-file line coverage on the risk:high paths (.github/labeler.yml)',
      'against a committed baseline. Run `pnpm run test:coverage:risk` (host) and',
      '`bun run test -- --coverage --coverage-reporter=lcov` (container/agent-runner)',
      'first. See docs/specs/risk-based-review/plan.md, "Tests on risky paths".',
    ].join('\n'),
  );
  process.exit(0);
}

function loadBaseline(baselinePath: string): Baseline {
  if (!fs.existsSync(baselinePath)) return { generatedAt: new Date(0).toISOString(), files: {} };
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  // path.resolve, not path.join: options.hostSummary/.containerLcov/.baseline may be
  // absolute (path.join would concatenate literally instead of anchoring on them).
  const repoRoot = path.resolve(import.meta.dirname, '..');

  const labelerConfig = parseYaml(fs.readFileSync(path.join(repoRoot, '.github', 'labeler.yml'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { host: hostGlobs, container: containerGlobs } = readRiskGlobs(labelerConfig);
  const riskFiles = [...discoverRiskFiles(repoRoot, hostGlobs), ...discoverRiskFiles(repoRoot, containerGlobs)].sort();

  const hostSummaryPath = path.resolve(repoRoot, options.hostSummary);
  if (!fs.existsSync(hostSummaryPath)) {
    fail(`no host coverage report at ${options.hostSummary} — run \`pnpm run test:coverage:risk\` first`);
  }
  const hostSummary = JSON.parse(fs.readFileSync(hostSummaryPath, 'utf8')) as Record<string, unknown>;
  const hostCoverage = parseVitestJsonSummary(hostSummary, repoRoot);

  const containerLcovPath = path.resolve(repoRoot, options.containerLcov);
  let containerCoverage = new Map<string, CoverageStat>();
  if (fs.existsSync(containerLcovPath)) {
    containerCoverage = parseLcov(fs.readFileSync(containerLcovPath, 'utf8'), containerSfToRepoPath);
  } else if (containerGlobs.length > 0) {
    console.warn(
      `check-risk-coverage: no container coverage report at ${options.containerLcov} — container risk files ` +
        `will show as untested. Run \`bun run test -- --coverage --coverage-reporter=lcov\` from ` +
        `container/agent-runner first for a complete report.`,
    );
  }

  const current = mergeCoverage(hostCoverage, containerCoverage);
  const baselinePath = path.resolve(repoRoot, options.baseline);

  if (options.write) {
    const baseline = buildBaseline(riskFiles, current);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    const result = evaluate(riskFiles, current, baseline, options.threshold);
    printReport(result, options, true);
    return;
  }

  const baseline = loadBaseline(baselinePath);
  const result = evaluate(riskFiles, current, baseline, options.threshold);
  printReport(result, options, false);
  process.exit(result.passed ? 0 : 1);
}

function printReport(result: EvaluateResult, options: Options, wrote: boolean): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderTable(result.rows));
  const { count, min, median } = summarize(result.rows);
  console.log('');
  console.log(
    `check-risk-coverage: ${count} risk file(s), min ${min === null ? '—' : min.toFixed(2) + '%'}, ` +
      `median ${median === null ? '—' : median.toFixed(2) + '%'}`,
  );
  if (wrote) {
    console.log(`check-risk-coverage: wrote ${options.baseline}`);
  } else if (!result.passed) {
    console.log('');
    console.log(`check-risk-coverage: FAILED — ${result.failures.length} risk file(s) regressed or have no tests:`);
    for (const row of result.failures) {
      console.log(`  - ${row.file}: ${fmtPct(row.baselinePct)} -> ${fmtPct(row.currentPct)} (${row.status})`);
    }
  } else {
    console.log('check-risk-coverage: OK — no risk file dropped below its baseline');
  }
}

// ESM-safe "is this the entrypoint" check (mirrors scripts/review-outcomes.ts).
if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
