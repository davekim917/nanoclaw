#!/usr/bin/env tsx
/**
 * Coverage ratchet for the risk:high paths (.github/labeler.yml): coverage can drop only on
 * purpose. It ratchets against this repo's own committed baseline, and a gain is never locked in
 * automatically.
 *
 * Each risk file is classified as a measured NUMBER, `'untested'` (executable, 0% or absent;
 * recorded so known debt doesn't read as a new failure), or `'n/a'` (no executable statements,
 * see `hasExecutableCode`; exempt).
 *
 * The container gap: bun's lcov lists only files some test actually loaded, unlike vitest's
 * `coverage.include`, which emits an entry for every included file. A container file absent from
 * bun's report is normal and is resolved by a static read; a host file absent from vitest's
 * report hard-fails unless `--allow-partial-report`.
 *
 * Inputs (produced separately): host `pnpm run test:coverage:risk` → coverage/coverage-summary.json;
 * container `bun run test -- --coverage --coverage-reporter=lcov` → container/agent-runner/coverage/lcov.info.
 * Host and container numbers stay strictly separate. `coverage.include` scopes only the REPORT:
 * coverage-v8 profiles the whole worker, so a coverage run's CPU overhead is global.
 *
 * Fails when a non-'n/a' file with a numeric baseline drops more than `--threshold` points
 * (untested counts as 0%), or a file absent from the baseline is `'new-untested'` or `'new'`
 * (`--write`/`--bootstrap` suspend `'new'`). A baseline `'untested'` never fails. Fails closed
 * before that on a missing baseline (unless `--bootstrap`), a partial host report, or a missing
 * container lcov (unless `--allow-missing-container-report`); CI passes neither allow-flag.
 *
 * Producing an honest baseline: never run full-suite coverage on the production host. Commit the
 * candidate ci-full.yml's "Generate coverage baseline candidate" step uploads; a local `--write`
 * against CI's raw reports resolves paths against the wrong root and silently writes an all-zero
 * baseline that can never fail again.
 *
 * Raising the baseline: only `--write` locks in a gain; a normal run prints a hint for files more
 * than 2 points above baseline.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-risk-coverage.ts [--write] [--bootstrap]
 *     [--allow-partial-report] [--allow-missing-container-report]
 *     [--host-summary <path>] [--container-lcov <path>] [--baseline <path>]
 *     [--threshold <points>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { globsForRiskHigh } from './review-outcomes.js';
import { splitRiskGlobs } from './risk-globs.js';
import { walkArgs } from './lib/cli-args.js';

export interface CoverageStat {
  covered: number;
  total: number;
  pct: number;
}

export type Classification = { kind: 'measured'; pct: number } | { kind: 'untested' } | { kind: 'n/a' };

export type BaselineEntry = number | 'untested' | 'n/a';

export type FileStatus = 'ok' | 'regressed' | 'new-untested' | 'new' | 'removed' | 'n/a';

export interface FileRow {
  file: string;
  baseline: BaselineEntry | null;
  current: BaselineEntry;
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
  files: Record<string, BaselineEntry>;
}

const DEFAULT_THRESHOLD = 0.5;
const RAISE_HINT_THRESHOLD = 2;
const FIXTURE_DIR_NAMES = new Set(['__fixtures__', '__test-fixtures__']);

/** Throws on an unrecognized glob. */
export function readRiskGlobs(labelerConfig: Record<string, unknown>): { host: string[]; container: string[] } {
  return splitRiskGlobs(globsForRiskHigh(labelerConfig));
}

/**
 * Excludes tests and `__fixtures__`/`__test-fixtures__` dirs, which a `*guard*.ts`-shaped glob
 * can match by naming coincidence. Walks only each glob's top-level directory.
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
    if (entry.name === 'node_modules' || entry.name === '.git' || FIXTURE_DIR_NAMES.has(entry.name)) continue;
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(path.join(absDir, entry.name), relPath));
    } else if (entry.isFile() && relPath.endsWith('.ts') && !relPath.endsWith('.test.ts')) {
      out.push(relPath);
    }
  }
  return out;
}

function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => path.matchesGlob(filePath, glob));
}

/**
 * Keys are ABSOLUTE paths rooted wherever vitest ran, possibly another machine (CI), so this
 * matches by suffix against the known `riskFiles` rather than stripping a prefix.
 */
export function parseVitestJsonSummary(
  summary: Record<string, unknown>,
  riskFiles: readonly string[],
): Map<string, CoverageStat> {
  const out = new Map<string, CoverageStat>();
  const keys = Object.keys(summary).filter((k) => k !== 'total');
  for (const relFile of riskFiles) {
    const key = keys.find((k) => k === relFile || k.endsWith('/' + relFile));
    if (!key) continue;
    const value = summary[key];
    const lines = (value as { lines?: { covered?: number; total?: number } }).lines;
    if (!lines || typeof lines.total !== 'number' || typeof lines.covered !== 'number') continue;
    out.set(relFile, { covered: lines.covered, total: lines.total, pct: pctOf(lines.covered, lines.total) });
  }
  return out;
}

/** `sfToRepoPath` maps bun's cwd-relative `SF:` value to a repo-root-relative path. */
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

/** Istanbul/lcov convention: zero countable lines is 100%. `classifyFile` never trusts that as
 * 'measured'. */
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

/**
 * False when every top-level statement is an import, re-export, interface or type alias (the
 * `'n/a'` case). Reads only this file's own statements, never what it imports.
 */
export function hasExecutableCode(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile('risk-file.ts', sourceText, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * A report entry is trusted only when `total > 0 && pct > 0`; anything else is decided by the
 * file's source, because a current 'n/a' overrides even a measured baseline and a spurious empty
 * block would otherwise exempt real code from the ratchet forever.
 */
export function classifyFile(stat: CoverageStat | undefined, readSource: () => string): Classification {
  if (stat && stat.total > 0 && stat.pct > 0) return { kind: 'measured', pct: stat.pct };
  return hasExecutableCode(readSource()) ? { kind: 'untested' } : { kind: 'n/a' };
}

export function classifyAll(
  repoRoot: string,
  riskFiles: readonly string[],
  current: ReadonlyMap<string, CoverageStat>,
): Map<string, Classification> {
  const out = new Map<string, Classification>();
  for (const file of riskFiles) {
    out.set(
      file,
      classifyFile(current.get(file), () => fs.readFileSync(path.join(repoRoot, file), 'utf8')),
    );
  }
  return out;
}

function toBaselineEntry(classification: Classification): BaselineEntry {
  return classification.kind === 'measured' ? round2(classification.pct) : classification.kind;
}

export interface EvaluateOptions {
  /** Suspends the `'new'` failure only, never `'new-untested'`. */
  allowNew?: boolean;
}

/**
 * `--bootstrap` against an already-existing baseline is deliberately false: it is a one-time
 * initial-baseline flag, not a standing way to silence the check.
 */
export function allowNewFor(opts: { write: boolean; bootstrap: boolean; baselineExists: boolean }): boolean {
  return opts.write || (opts.bootstrap && !opts.baselineExists);
}

export function evaluate(
  riskFiles: readonly string[],
  classifications: ReadonlyMap<string, Classification>,
  baseline: Baseline,
  threshold = DEFAULT_THRESHOLD,
  options: EvaluateOptions = {},
): EvaluateResult {
  const { allowNew = false } = options;
  const riskFileSet = new Set(riskFiles);
  const rows: FileRow[] = riskFiles.map((file) => {
    const current = toBaselineEntry(classifications.get(file) ?? { kind: 'n/a' });
    const baselineEntry = Object.hasOwn(baseline.files, file) ? baseline.files[file] : null;

    // Not-applicable always wins, regardless of history.
    if (current === 'n/a') {
      return { file, baseline: baselineEntry, current, delta: null, status: 'n/a' };
    }

    let status: FileStatus;
    let delta: number | null = null;
    if (baselineEntry === null || baselineEntry === 'n/a') {
      status = current === 'untested' ? 'new-untested' : 'new';
    } else if (baselineEntry === 'untested') {
      status = 'ok';
    } else {
      const effectiveCurrent = typeof current === 'number' ? current : 0; // 'untested' reads as 0
      delta = effectiveCurrent - baselineEntry;
      // Integer hundredths, not the raw float delta: 63.51 - 64.01 lands a hair past -0.5 and
      // would fail a drop of exactly the threshold.
      const currentHundredths = Math.round(effectiveCurrent * 100);
      const baselineHundredths = Math.round(baselineEntry * 100);
      const thresholdHundredths = Math.round(threshold * 100);
      status = currentHundredths - baselineHundredths < -thresholdHundredths ? 'regressed' : 'ok';
    }
    return { file, baseline: baselineEntry, current, delta, status };
  });

  // Reported, never failed; only `--write` removes them.
  for (const file of Object.keys(baseline.files).sort()) {
    if (riskFileSet.has(file)) continue;
    rows.push({ file, baseline: baseline.files[file], current: 'n/a', delta: null, status: 'removed' });
  }

  const failures = rows.filter(
    (row) => row.status === 'regressed' || row.status === 'new-untested' || (row.status === 'new' && !allowNew),
  );
  return { rows, failures, passed: failures.length === 0 };
}

export function buildBaseline(
  riskFiles: readonly string[],
  classifications: ReadonlyMap<string, Classification>,
): Baseline {
  const files: Record<string, BaselineEntry> = {};
  for (const file of [...riskFiles].sort()) {
    files[file] = toBaselineEntry(classifications.get(file) ?? { kind: 'n/a' });
  }
  return { generatedAt: new Date().toISOString(), files };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rounds DOWN (a suggested floor must never be stricter than measured), after round2 so a float
 * artifact like 92.30000000000001 can't floor to the wrong decile. */
function floorTo1Decimal(n: number): number {
  return Math.floor(round2(n) * 10) / 10;
}

function fmtEntry(entry: BaselineEntry | null): string {
  if (entry === null) return '—';
  return typeof entry === 'number' ? `${entry.toFixed(2)}%` : entry;
}

function fmtDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}`;
}

/**
 * A `'new'` row gets the exact JSON line to paste, without a trailing comma (one after the last
 * entry breaks the file). `row.current` is always a number for a `'new'` row.
 */
export function formatFailureLine(row: FileRow, baselinePath: string): string {
  if (row.status === 'new') {
    const floor = floorTo1Decimal(row.current as number);
    return (
      `${row.file}: measured ${fmtEntry(row.current)} but has no coverage floor in ${baselinePath} (new) — ` +
      `add "${row.file}": ${floor} (append a comma if it is not the last entry in ${baselinePath})`
    );
  }
  return `${row.file}: ${fmtEntry(row.baseline)} -> ${fmtEntry(row.current)} (${row.status})`;
}

export function renderTable(rows: readonly FileRow[]): string {
  const header = ['file', 'baseline', 'current', 'delta', 'status'];
  const lines = rows.map((row) => [
    row.file,
    fmtEntry(row.baseline),
    fmtEntry(row.current),
    fmtDelta(row.delta),
    row.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const renderRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [renderRow(header), renderRow(widths.map((w) => '-'.repeat(w))), ...lines.map(renderRow)].join('\n');
}

/** `'n/a'` rows carry no percentage and are excluded from min/median. */
export function summarize(rows: readonly FileRow[]): { count: number; min: number | null; median: number | null } {
  const pcts = rows
    .map((r) => (typeof r.current === 'number' ? r.current : null))
    .filter((p): p is number => p !== null);
  if (pcts.length === 0) return { count: rows.length, min: null, median: null };
  const sorted = [...pcts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { count: rows.length, min: sorted[0], median };
}

export function raiseHints(rows: readonly FileRow[]): FileRow[] {
  return rows.filter((row) => row.delta !== null && row.delta > RAISE_HINT_THRESHOLD);
}

interface Options {
  write: boolean;
  bootstrap: boolean;
  allowPartialReport: boolean;
  allowMissingContainerReport: boolean;
  hostSummary: string;
  containerLcov: string;
  baseline: string;
  threshold: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    write: false,
    bootstrap: false,
    allowPartialReport: false,
    allowMissingContainerReport: false,
    hostSummary: 'coverage/coverage-summary.json',
    containerLcov: 'container/agent-runner/coverage/lcov.info',
    baseline: 'coverage-risk-baseline.json',
    threshold: DEFAULT_THRESHOLD,
    json: false,
  };
  walkArgs(argv, fail, (name, arg, value) => {
    if (name === '--write') options.write = true;
    else if (name === '--bootstrap') options.bootstrap = true;
    else if (name === '--allow-partial-report') options.allowPartialReport = true;
    else if (name === '--allow-missing-container-report') options.allowMissingContainerReport = true;
    else if (name === '--host-summary') options.hostSummary = value();
    else if (name === '--container-lcov') options.containerLcov = value();
    else if (name === '--baseline') options.baseline = value();
    else if (name === '--threshold') options.threshold = Number(value());
    else if (name === '--json') options.json = true;
    else if (name === '--help' || name === '-h') usage();
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  });
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
      'Usage: tsx scripts/check-risk-coverage.ts [--write] [--bootstrap]',
      '         [--allow-partial-report] [--allow-missing-container-report]',
      '         [--host-summary <path>] [--container-lcov <path>] [--baseline <path>]',
      '         [--threshold <points>] [--json]',
      '',
      'Ratchets per-file line coverage on the risk:high paths (.github/labeler.yml)',
      'against a committed baseline. Run `pnpm run test:coverage:risk` (host) and',
      '`bun run test -- --coverage --coverage-reporter=lcov` (container/agent-runner)',
      'first. See docs/specs/risk-based-review/plan.md, "Tests on risky paths", and',
      "this script's own file header for the classification model and the fail-closed",
      'behaviors and their opt-outs.',
    ].join('\n'),
  );
  process.exit(0);
}

export type BaselineResolution = { ok: true; baseline: Baseline } | { ok: false; error: string };

/** `--bootstrap` is the only escape hatch from failing closed on a missing baseline. */
export function resolveBaseline(exists: boolean, raw: string | null, bootstrap: boolean): BaselineResolution {
  if (!exists) {
    if (bootstrap) return { ok: true, baseline: { generatedAt: new Date(0).toISOString(), files: {} } };
    return {
      ok: false,
      error:
        'no baseline file — this ratchet fails closed on a missing baseline so a deleted or never-committed ' +
        'baseline cannot silently stop being enforced. Pass --bootstrap only for the one-time initial baseline ' +
        'creation (see this file\'s "Producing an honest baseline").',
    };
  }
  return { ok: true, baseline: JSON.parse(raw as string) as Baseline };
}

/** Host-only: a container file absent from bun's lcov is normal ("The container gap"). */
export function findMissingFromReport(
  hostRiskFiles: readonly string[],
  hostCoverage: ReadonlyMap<string, CoverageStat>,
): string[] {
  return hostRiskFiles.filter((file) => !hostCoverage.has(file));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  // path.resolve, not path.join, below: the option paths may be absolute.
  const repoRoot = path.resolve(import.meta.dirname, '..');

  const labelerConfig = parseYaml(fs.readFileSync(path.join(repoRoot, '.github', 'labeler.yml'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { host: hostGlobs, container: containerGlobs } = readRiskGlobs(labelerConfig);
  const hostRiskFiles = discoverRiskFiles(repoRoot, hostGlobs);
  const containerRiskFiles = discoverRiskFiles(repoRoot, containerGlobs);
  const riskFiles = [...hostRiskFiles, ...containerRiskFiles].sort();

  const hostSummaryPath = path.resolve(repoRoot, options.hostSummary);
  if (!fs.existsSync(hostSummaryPath)) {
    fail(`no host coverage report at ${options.hostSummary} — run \`pnpm run test:coverage:risk\` first`);
  }
  const hostSummary = JSON.parse(fs.readFileSync(hostSummaryPath, 'utf8')) as Record<string, unknown>;
  const hostCoverage = parseVitestJsonSummary(hostSummary, hostRiskFiles);

  if (!options.allowPartialReport) {
    const missing = findMissingFromReport(hostRiskFiles, hostCoverage);
    if (missing.length > 0) {
      fail(
        `${missing.length} host risk file(s) discovered on disk have no entry at all in vitest's coverage ` +
          `report — vitest's own coverage.include normally guarantees an entry for every included file, so this ` +
          `usually means the report was generated against fewer test files than the full suite, or a tooling ` +
          `bug, not a real 0%: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}. Pass ` +
          '--allow-partial-report for a deliberately narrow local sanity run.',
      );
    }
  }

  const containerLcovPath = path.resolve(repoRoot, options.containerLcov);
  const containerReportExists = fs.existsSync(containerLcovPath);
  if (!containerReportExists && containerGlobs.length > 0 && !options.allowMissingContainerReport) {
    fail(
      `no container coverage report at ${options.containerLcov} — run ` +
        '`bun run test -- --coverage --coverage-reporter=lcov` from container/agent-runner first, or pass ' +
        '--allow-missing-container-report for a deliberate host-only local run.',
    );
  }
  const containerCoverage = containerReportExists
    ? parseLcov(fs.readFileSync(containerLcovPath, 'utf8'), containerSfToRepoPath)
    : new Map<string, CoverageStat>();
  // Not checked for missing entries like the host report: see "The container gap".

  const current = mergeCoverage(hostCoverage, containerCoverage);
  const classifications = classifyAll(repoRoot, riskFiles, current);

  const baselinePath = path.resolve(repoRoot, options.baseline);
  // Read BEFORE --write's writeFileSync: it means "existed when this run started".
  const baselineExists = fs.existsSync(baselinePath);
  const allowNew = allowNewFor({ write: options.write, bootstrap: options.bootstrap, baselineExists });

  if (options.write) {
    const baseline = buildBaseline(riskFiles, classifications);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    const result = evaluate(riskFiles, classifications, baseline, options.threshold, { allowNew });
    printReport(result, options, true);
    return;
  }

  const resolution = resolveBaseline(
    baselineExists,
    baselineExists ? fs.readFileSync(baselinePath, 'utf8') : null,
    options.bootstrap,
  );
  if (!resolution.ok) fail(resolution.error);
  const result = evaluate(riskFiles, classifications, resolution.baseline, options.threshold, { allowNew });
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
    return;
  }
  if (!result.passed) {
    console.log('');
    console.log(
      `check-risk-coverage: FAILED — ${result.failures.length} risk file(s) regressed, have no tests, or have no ` +
        'coverage floor recorded:',
    );
    for (const row of result.failures) {
      console.log(`  - ${formatFailureLine(row, options.baseline)}`);
    }
  } else {
    console.log('check-risk-coverage: OK — no risk file dropped below its baseline');
  }
  const hints = raiseHints(result.rows);
  if (hints.length > 0) {
    console.log('');
    console.log(
      `check-risk-coverage: ${hints.length} risk file(s) rose more than ${RAISE_HINT_THRESHOLD} points above ` +
        `their baseline — this is a floor, not an auto-raising ratchet, so the gain is NOT locked in. Run with ` +
        '--write to raise the baseline if this was a deliberate improvement:',
    );
    for (const row of hints) {
      console.log(`  - ${row.file}: ${fmtEntry(row.baseline)} -> ${fmtEntry(row.current)} (${fmtDelta(row.delta)})`);
    }
  }
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
