#!/usr/bin/env tsx
/**
 * check-risk-coverage — the coverage ratchet docs/specs/risk-based-review/plan.md's
 * "Tests on risky paths" item calls for: coverage on the risk:high paths
 * (.github/labeler.yml) can drop only on purpose. NOT a fixed floor — plan.md's
 * Non-goals section is explicit that copying someone else's 85% number is out of
 * scope; this only ratchets against this repo's OWN prior measurement, and it is a
 * manually-raised floor, not an automatic one: a coverage GAIN never fails, and never
 * gets locked in on its own either — see "Raising the baseline" below.
 *
 * Every risk file gets classified into exactly one of three states, both when
 * measured now and when recorded in the baseline (see `Classification`/`BaselineEntry`):
 *   - a NUMBER — real, measured line-coverage percentage;
 *   - `'untested'` — has executable statements, currently 0% (or, for a container file,
 *     never appears in bun's report at all — see "The container gap" below). Recorded
 *     explicitly, not as a silent `0`, so an already-untested file at baseline time reads
 *     back as KNOWN accepted debt on every later run, not as a brand-new failure;
 *   - `'n/a'` — no executable statements at all (a barrel re-export file, a `.ts` file
 *     of only `interface`/`type`/`import`/`export` declarations — see `hasExecutableCode`).
 *     Exempt from the ratchet entirely: never fails, never shown as a percentage, and
 *     dropped from summarize()/raiseHints()'s numbers. A coverage tool reporting "0
 *     countable lines, 100% by convention" for these is true but useless — this repo
 *     tracks them as not-applicable instead.
 *
 * The container gap: bun's `--coverage` has no glob-`include` equivalent to vitest's
 * `coverage.include` — its lcov report only ever lists a file some test ACTUALLY loaded
 * (verified: running the full 122-file agent-runner suite with coverage still produced
 * no SF: entry at all for container/agent-runner/src/mcp-tools/types.ts, db/index.ts,
 * or backlog.ts, none of which any test currently imports). vitest's `coverage.include`
 * has no such gap (verified separately: it produces a 0%-via-AST-synthesis entry for
 * EVERY included file, whether any test touched it or not — see vitest.config.ts's
 * `readHostRiskGlobs` comment). So a container risk file absent from bun's report is
 * NORMAL, not a tooling bug, and `classifyFile` below resolves it with a static AST
 * check on the source itself (`hasExecutableCode`) rather than treating absence as an
 * error — the equivalent host-side absence (impossible under normal operation, since
 * `include` guarantees an entry) still hard-fails via `--allow-partial-report`'s check.
 *
 * Inputs (produced separately, never by this script):
 *   - host:      `pnpm run test:coverage:risk` → coverage/coverage-summary.json
 *                (vitest's `json-summary` reporter; `coverage.include` in
 *                vitest.config.ts scopes what gets REPORTED to the host half of
 *                risk:high via scripts/risk-globs.ts, derived at run time from
 *                .github/labeler.yml — see that file and vitest.config.ts's
 *                `readHostRiskGlobs`). `coverage.include` does NOT scope
 *                INSTRUMENTATION: coverage-v8 starts V8's precise/detailed
 *                coverage profiler for the whole worker
 *                (@vitest/coverage-v8's `Profiler.startPreciseCoverage({ callCount:
 *                true, detailed: true })`, node_modules/@vitest/coverage-v8/dist/index.js)
 *                and applies `include`/`exclude` only when building the report — so
 *                a coverage run's CPU overhead is global to the process, not confined
 *                to risk:high files. See ci.yml for what that meant for one
 *                CPU-heavy, unrelated test.
 *   - container: `bun run test -- --coverage --coverage-reporter=lcov` (from
 *                container/agent-runner) → container/agent-runner/coverage/lcov.info.
 *                Host and container numbers are kept STRICTLY separate end to end —
 *                parseVitestJsonSummary only ever runs against `hostRiskFiles`,
 *                parseLcov/containerSfToRepoPath only against `containerRiskFiles` — a
 *                container file's classification never comes from a host test that
 *                happens to import it (vitest's own `coverage.include` structurally
 *                can't name a `container/agent-runner/**` path anyway — see
 *                scripts/risk-globs.ts's `isHostCodeGlob`/`isContainerCodeGlob`).
 *
 * This script itself only reads those two reports plus `.github/labeler.yml`, computes
 * one merged per-file line-coverage table over every risk file that exists on disk, and
 * compares it against the committed baseline (default `coverage-risk-baseline.json`,
 * itself on `risk:high` — see .github/labeler.yml — so lowering it takes review).
 *
 * Fails (exit 1) when, for any risk file whose CURRENT classification is not `'n/a'`:
 *   - it was in the baseline as a NUMBER and current coverage is more than
 *     `--threshold` (default 0.5) points below that value (missing/'untested' current
 *     coverage counts as a drop to 0%, not a skipped comparison);
 *   - it is NOT in the baseline at all (a risk file introduced after the baseline was
 *     last written) and is currently `'untested'`.
 * A baseline entry of `'untested'` never fails on its own — it is accepted debt, not a
 * live threshold — and a NEW risk file with SOME measured coverage does not fail either.
 * `--write` folds the current state into the baseline either way.
 *
 * Fails closed (exit 1) BEFORE any of the above, regardless of --write, when:
 *   - the baseline file does not exist — pass `--bootstrap` for the one-time initial
 *     baseline creation only (see "Producing an honest baseline" below); every other
 *     run must find a real, committed baseline, or a PR that deleted it would silently
 *     stop being ratcheted instead of failing loudly;
 *   - a HOST risk file `discoverRiskFiles` found on disk has NO entry at all in vitest's
 *     report — pass `--allow-partial-report` for a deliberately narrow local sanity run
 *     (e.g. running coverage against two test files instead of the whole suite). NOT
 *     applied to container files — see "The container gap" above;
 *   - `container/agent-runner`'s lcov report file itself is missing (as opposed to
 *     merely lacking some files' entries — see "The container gap") while risk:high
 *     names any container path — pass `--allow-missing-container-report` for a
 *     host-only local run. Both allow-flags exist for local dev only; CI never passes
 *     either.
 *
 * Producing an honest baseline: this repo's host suite runs on a memory-constrained,
 * production-serving box that must never run the full vitest suite with coverage
 * (docs/specs/risk-based-review/plan.md). ci.yml's "Generate coverage baseline
 * candidate" step runs `--write --bootstrap` against CI's own full-suite reports and
 * uploads the result as part of the `risk-coverage-reports` artifact — download THAT
 * file and commit it directly, rather than downloading the raw reports and running
 * `--write` locally: a locally-run `--write` needs the raw reports' paths to resolve
 * against this checkout's OWN root (see parseVitestJsonSummary below), and a
 * mismatched root (this box's checkout path vs. CI's `/home/runner/work/...`) would
 * silently produce an all-zero baseline that then never fails again, since nothing can
 * measure below 0%. Letting CI both produce and evaluate the candidate removes that
 * whole class of mistake.
 *
 * Raising the baseline: a coverage GAIN is never required, and `--write` is the only
 * way to lock one in — this script does not auto-raise the baseline on a passing run
 * (a "ratchet" here means "never silently regresses," not "automatically improves").
 * The non-`--write` report prints a hint listing any file that rose more than 2 points
 * above its baseline, as a nudge to `--write` after a deliberate coverage improvement.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-risk-coverage.ts [--write] [--bootstrap]
 *     [--allow-partial-report] [--allow-missing-container-report]
 *     [--host-summary <path>] [--container-lcov <path>] [--baseline <path>]
 *     [--threshold <points>] [--json]
 *
 * Defaults: --host-summary coverage/coverage-summary.json,
 *   --container-lcov container/agent-runner/coverage/lcov.info,
 *   --baseline coverage-risk-baseline.json, --threshold 0.5.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { globsForRiskHigh } from './review-outcomes.js';
import { splitRiskGlobs } from './risk-globs.js';

// ─────────────────────────── types ─────────────────────────────────────────

export interface CoverageStat {
  covered: number;
  total: number;
  pct: number;
}

/** A single risk file's resolved state — see the file header for what each means. */
export type Classification = { kind: 'measured'; pct: number } | { kind: 'untested' } | { kind: 'n/a' };

/** Classification, flattened for storage/comparison: a real number, or the two words. */
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
/** Non-blocking: a file that rose this many points above baseline earns a hint to --write. */
const RAISE_HINT_THRESHOLD = 2;
/** Test-only support files, never a coverage TARGET regardless of extension. */
const FIXTURE_DIR_NAMES = new Set(['__fixtures__', '__test-fixtures__']);

// ─────────────────────────── pure logic ────────────────────────────────────

/** `risk:high` from a parsed `.github/labeler.yml`, split host vs container (throws on
 * an unrecognized glob — see scripts/risk-globs.ts's `assertFullyClassified`). */
export function readRiskGlobs(labelerConfig: Record<string, unknown>): { host: string[]; container: string[] } {
  return splitRiskGlobs(globsForRiskHigh(labelerConfig));
}

/**
 * `.ts` files under `repoRoot` matching any of `globs`, excluding `*.test.ts` (a test
 * file isn't a coverage TARGET; it's what exercises one) and anything under a
 * `__fixtures__`/`__test-fixtures__` directory (test-only support files picked up by a
 * `*guard*.ts`-shaped glob purely by naming coincidence, e.g.
 * `container/agent-runner/src/providers/__test-fixtures__/guard-core-stub.ts`  — not
 * production code, and never worth a baseline entry). Only walks the top-level
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

/** Mirrors `matchesAnyGlob` (scripts/review-outcomes.ts) — not imported: that one is
 * typed for PR changed-file lists; this one is typed for on-disk discovery, and both
 * are one-line wrappers over the same `path.matchesGlob`, so duplication costs nothing
 * and keeps each call site's intent legible on its own. */
function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => path.matchesGlob(filePath, glob));
}

/**
 * `coverage-summary.json` (vitest's `json-summary` coverage reporter) keys files by an
 * ABSOLUTE path rooted at wherever vitest ran (verified against a real run: every
 * non-"total" key was `<that machine's repo root>/src/...` or `.../scripts/...`). That
 * root is NOT necessarily this process's own repo root — the report may have been
 * generated on a different machine (CI) and downloaded here — so this matches by
 * SUFFIX against the known repo-relative `riskFiles` list instead of stripping a
 * literal prefix: a key ending in `/${riskFile}` (or equal to it outright) is that
 * file, regardless of what came before it. Matching against a known, finite candidate
 * list (rather than trying to infer "the repo root" from the keys themselves) also
 * means a coincidental path collision can't misattribute a file.
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

/**
 * lcov (bun's `--coverage-reporter=lcov`), one SF:/DA: block per file. `sfToRepoPath`
 * maps the lcov-relative `SF:` value (relative to wherever `bun test` ran, i.e.
 * `container/agent-runner`) to a repo-root-relative path. Unlike the vitest json-summary
 * case above, this needs no cross-machine path normalization: bun's `SF:` values are
 * already relative (to the test run's cwd), not absolute, so they resolve the same way
 * regardless of which machine produced the report.
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

/** Istanbul/lcov convention: a file with zero countable lines is 100% covered.
 * `classifyFile` never trusts this at face value for a classification decision — a
 * `total === 0` entry is never classified `'measured'`; it falls through to
 * `hasExecutableCode` like an absent one (see that function's own comment). */
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
 * True when `sourceText`'s top-level statements are ENTIRELY declarative — imports,
 * re-exports (`export {...}`, `export {...} from`, `export type {...}`), `interface`,
 * and `type` alias declarations — with nothing that produces or runs a value. Such a
 * file compiles to no runtime logic worth testing (a barrel re-export, a pure `.d.ts`
 * -shaped module), which is what `classifyFile` calls `'n/a'`. Any other top-level
 * statement (a function, a class, a `const` holding a computed value, a bare
 * expression, `export default`, ...) makes it executable, real code that a coverage
 * tool CAN and should measure.
 *
 * Deliberately conservative: this only reads the file's OWN statements, not what it
 * imports, so a re-export can never be misclassified as executable just because the
 * module it points to has logic — the coverage question is "does THIS file have
 * anything to cover", not "does importing it run code somewhere else".
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
 * Resolves one risk file's `Classification` from its measured `CoverageStat` (if the
 * report has one and shows unambiguous positive coverage) or, otherwise, a static read
 * of the file itself — see the file header's "The container gap" for why absence needs
 * a fallback at all, and `hasExecutableCode` for what the fallback actually checks.
 *
 * A report entry is trusted OUTRIGHT only when `total > 0 && pct > 0` — real,
 * unambiguous measured coverage. Anything else (absent from the report; `total === 0`,
 * which istanbul/lcov convention reports as 100% — see `pctOf` — and would otherwise be
 * misread as "measured, fully covered"; or `pct === 0`) is cross-checked against the
 * file's own source instead of taken at face value: `hasExecutableCode` is the single
 * source of truth for the n/a-vs-untested distinction, so a coverage-tool quirk that
 * reports a spuriously empty or zero block for a file with real code can't silently
 * exempt it from the ratchet forever — `evaluate()` lets a CURRENT 'n/a' override even a
 * baseline that remembers real measured coverage, by design (see its own comment), so
 * getting 'n/a' wrong here would be a real masked regression, not just a display quirk.
 *
 * `readSource` is injected (rather than calling `fs.readFileSync` directly) purely so
 * this stays unit-testable without a real file on disk.
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

export function evaluate(
  riskFiles: readonly string[],
  classifications: ReadonlyMap<string, Classification>,
  baseline: Baseline,
  threshold = DEFAULT_THRESHOLD,
): EvaluateResult {
  const riskFileSet = new Set(riskFiles);
  const rows: FileRow[] = riskFiles.map((file) => {
    const current = toBaselineEntry(classifications.get(file) ?? { kind: 'n/a' });
    const baselineEntry = Object.hasOwn(baseline.files, file) ? baseline.files[file] : null;

    // Not-applicable always wins, regardless of history: a file with no executable
    // statements is exempt from the ratchet on its own terms, not because of what it
    // used to be.
    if (current === 'n/a') {
      return { file, baseline: baselineEntry, current, delta: null, status: 'n/a' };
    }

    let status: FileStatus;
    let delta: number | null = null;
    if (baselineEntry === null || baselineEntry === 'n/a') {
      // Genuinely new to the ratchet — either never in the baseline, or the baseline
      // remembers it as having no executable statements (code has since been added).
      // Either way, there is no numeric floor to compare against: the only failure
      // mode is "nothing exercises it yet".
      status = current === 'untested' ? 'new-untested' : 'new';
    } else if (baselineEntry === 'untested') {
      // Accepted debt at baseline time — any current state (still untested, or
      // improved) is fine. Never fails; there is no lower state to regress to.
      status = 'ok';
    } else {
      // baselineEntry is a number — the normal regression-threshold comparison.
      const effectiveCurrent = typeof current === 'number' ? current : 0; // 'untested' reads as 0
      delta = effectiveCurrent - baselineEntry;
      status = delta < -threshold ? 'regressed' : 'ok';
    }
    return { file, baseline: baselineEntry, current, delta, status };
  });

  // Baseline entries for a file that no longer exists on disk (deleted or renamed) —
  // reported, not silently dropped, though they never fail the run: `--write` is what
  // actually removes them (buildBaseline only ever writes the CURRENT riskFiles).
  for (const file of Object.keys(baseline.files).sort()) {
    if (riskFileSet.has(file)) continue;
    rows.push({ file, baseline: baseline.files[file], current: 'n/a', delta: null, status: 'removed' });
  }

  const failures = rows.filter((row) => row.status === 'regressed' || row.status === 'new-untested');
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

// ─────────────────────────── table rendering ───────────────────────────────

function fmtEntry(entry: BaselineEntry | null): string {
  if (entry === null) return '—';
  return typeof entry === 'number' ? `${entry.toFixed(2)}%` : entry;
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
    fmtEntry(row.baseline),
    fmtEntry(row.current),
    fmtDelta(row.delta),
    row.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const renderRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [renderRow(header), renderRow(widths.map((w) => '-'.repeat(w))), ...lines.map(renderRow)].join('\n');
}

/** `'n/a'` rows are excluded from min/median — they carry no percentage at all, not a
 * 0% or 100% one, and would otherwise skew both toward whichever extreme they default to. */
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

/** Rows that rose more than RAISE_HINT_THRESHOLD points above their baseline — see the
 * file header's "Raising the baseline". Only meaningful for a numeric baseline, hence
 * `delta !== null` (an 'untested'/'n/a'/absent baseline never produces a delta). */
export function raiseHints(rows: readonly FileRow[]): FileRow[] {
  return rows.filter((row) => row.delta !== null && row.delta > RAISE_HINT_THRESHOLD);
}

// ─────────────────────────── CLI ───────────────────────────────────────────

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
    else if (name === '--bootstrap') options.bootstrap = true;
    else if (name === '--allow-partial-report') options.allowPartialReport = true;
    else if (name === '--allow-missing-container-report') options.allowMissingContainerReport = true;
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

/**
 * Whether to fail closed on a missing baseline, factored out of the filesystem so it's
 * directly testable: `exists`/`raw` are what `fs.existsSync`/`fs.readFileSync` would
 * have returned, not called here. `--bootstrap` is the only escape hatch — see this
 * file's "Producing an honest baseline".
 */
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

/** HOST risk files `discoverRiskFiles` found on disk with no entry at all in vitest's
 * report — see `--allow-partial-report` in this file's header. Host-only: a container
 * file absent from bun's lcov is normal (see "The container gap"), not a tooling bug,
 * so it is never part of this check. */
export function findMissingFromReport(
  hostRiskFiles: readonly string[],
  hostCoverage: ReadonlyMap<string, CoverageStat>,
): string[] {
  return hostRiskFiles.filter((file) => !hostCoverage.has(file));
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
  // Deliberately NOT checked against `discoverRiskFiles` the way hostCoverage is above:
  // a container file's absence from bun's report is the expected, normal case for an
  // untested one (see this file's header, "The container gap") — classifyAll resolves
  // it via a static read of the file, not a hard failure.

  const current = mergeCoverage(hostCoverage, containerCoverage);
  const classifications = classifyAll(repoRoot, riskFiles, current);

  const baselinePath = path.resolve(repoRoot, options.baseline);

  if (options.write) {
    const baseline = buildBaseline(riskFiles, classifications);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    const result = evaluate(riskFiles, classifications, baseline, options.threshold);
    printReport(result, options, true);
    return;
  }

  const baselineExists = fs.existsSync(baselinePath);
  const resolution = resolveBaseline(
    baselineExists,
    baselineExists ? fs.readFileSync(baselinePath, 'utf8') : null,
    options.bootstrap,
  );
  if (!resolution.ok) fail(resolution.error);
  const result = evaluate(riskFiles, classifications, resolution.baseline, options.threshold);
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
    console.log(`check-risk-coverage: FAILED — ${result.failures.length} risk file(s) regressed or have no tests:`);
    for (const row of result.failures) {
      console.log(`  - ${row.file}: ${fmtEntry(row.baseline)} -> ${fmtEntry(row.current)} (${row.status})`);
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

// ESM-safe "is this the entrypoint" check (mirrors scripts/review-outcomes.ts).
if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
