import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

import {
  buildBaseline,
  classifyAll,
  classifyFile,
  containerSfToRepoPath,
  discoverRiskFiles,
  evaluate,
  findMissingFromReport,
  hasExecutableCode,
  mergeCoverage,
  parseLcov,
  parseVitestJsonSummary,
  raiseHints,
  readRiskGlobs,
  renderTable,
  resolveBaseline,
  summarize,
  type Baseline,
  type Classification,
  type CoverageStat,
  type FileRow,
} from './check-risk-coverage.js';

// This suite never shells out or touches the network — every case here exercises the
// pure functions check-risk-coverage.ts factors out for exactly that reason.
enforceHermeticity();

function labelerConfig(riskHighGlobs: string[]): Record<string, unknown> {
  return { 'risk:high': [{ 'changed-files': [{ 'any-glob-to-any-file': riskHighGlobs }] }] };
}

describe('readRiskGlobs', () => {
  it('splits risk:high into host (src/, scripts/ .ts) and container (container/agent-runner/) globs', () => {
    const config = labelerConfig([
      'src/guard/**',
      'src/router.ts',
      'scripts/check-public-boundary.ts',
      'scripts/deploy.sh',
      'container/agent-runner/src/poll-loop.ts',
      '.github/**',
      'pnpm-workspace.yaml',
    ]);
    expect(readRiskGlobs(config)).toEqual({
      host: ['src/guard/**', 'src/router.ts', 'scripts/check-public-boundary.ts'],
      container: ['container/agent-runner/src/poll-loop.ts'],
    });
  });
});

describe('discoverRiskFiles', () => {
  it('finds .ts files matching a glob and excludes .test.ts', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-discover');
    fs.mkdirSync(path.join(root, 'src', 'guard'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'guard', 'guard.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'guard', 'guard.test.ts'), '');
    fs.mkdirSync(path.join(root, 'src', 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'unrelated', 'other.ts'), '');

    expect(discoverRiskFiles(root, ['src/guard/**'])).toEqual(['src/guard/guard.ts']);
  });

  it('only walks the top-level directory each glob is rooted at', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-discover-scope');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'router.ts'), '');
    fs.mkdirSync(path.join(root, 'container', 'agent-runner', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'container', 'agent-runner', 'src', 'poll-loop.ts'), '');

    expect(discoverRiskFiles(root, ['src/router.ts'])).toEqual(['src/router.ts']);
  });

  it('returns nothing for a glob whose root directory does not exist', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-discover-missing');
    expect(discoverRiskFiles(root, ['src/router.ts'])).toEqual([]);
  });

  it('excludes node_modules', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-discover-node-modules');
    fs.mkdirSync(path.join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'node_modules', 'pkg', 'index.ts'), '');
    expect(discoverRiskFiles(root, ['src/**'])).toEqual([]);
  });

  it('excludes __fixtures__ and __test-fixtures__ directories', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-discover-fixtures');
    fs.mkdirSync(path.join(root, 'src', 'db', 'migrations', '__fixtures__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'db', 'migrations', '__fixtures__', 'seed.ts'), '');
    fs.mkdirSync(path.join(root, 'src', 'providers', '__test-fixtures__'), { recursive: true });
    // A fixture named like a risk glob (*guard*.ts) should still be excluded — the
    // directory name is what matters, not whether the filename happens to match.
    fs.writeFileSync(path.join(root, 'src', 'providers', '__test-fixtures__', 'guard-core-stub.ts'), '');
    fs.mkdirSync(path.join(root, 'src', 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'db', 'migrations', 'index.ts'), '');

    expect(discoverRiskFiles(root, ['src/db/migrations/**', 'src/**/*guard*.ts'])).toEqual([
      'src/db/migrations/index.ts',
    ]);
  });
});

describe('parseVitestJsonSummary', () => {
  it('matches a report key by suffix against the known risk-file list, regardless of what root produced it', () => {
    const summary = {
      total: { lines: { covered: 1, total: 2, pct: 50 } },
      '/home/runner/work/nanoclaw/nanoclaw/src/router.ts': { lines: { covered: 8, total: 10, pct: 80 } },
      // A different file that merely ends the same way must not be misattributed.
      '/home/runner/work/nanoclaw/nanoclaw/src/other/router.ts': { lines: { covered: 1, total: 1, pct: 100 } },
    };
    const result = parseVitestJsonSummary(summary, ['src/router.ts']);
    expect(result.size).toBe(1);
    expect(result.get('src/router.ts')).toEqual({ covered: 8, total: 10, pct: 80 });
  });

  it('matches regardless of which machine produced the absolute root (this box vs. CI)', () => {
    const ciSummary = { '/home/runner/work/nanoclaw/nanoclaw/src/guard/guard.ts': { lines: { covered: 5, total: 5 } } };
    const localSummary = { '/home/ubuntu/nanoclaw-v2/src/guard/guard.ts': { lines: { covered: 5, total: 5 } } };
    for (const summary of [ciSummary, localSummary]) {
      expect(parseVitestJsonSummary(summary, ['src/guard/guard.ts']).get('src/guard/guard.ts')).toEqual({
        covered: 5,
        total: 5,
        pct: 100,
      });
    }
  });

  it('ignores entries with no usable lines block', () => {
    const result = parseVitestJsonSummary({ '/repo/src/x.ts': {} }, ['src/x.ts']);
    expect(result.size).toBe(0);
  });

  it('finds nothing for a risk file the report never mentions', () => {
    expect(parseVitestJsonSummary({}, ['src/never-touched.ts']).size).toBe(0);
  });
});

describe('parseLcov', () => {
  const identity = (sf: string): string => sf;

  it('computes line pct from DA: hit counts per SF: block', () => {
    const lcov = [
      'SF:src/a.ts',
      'DA:1,1',
      'DA:2,0',
      'DA:3,5',
      'end_of_record',
      'SF:src/b.ts',
      'DA:1,0',
      'end_of_record',
    ].join('\n');
    const result = parseLcov(lcov, identity);
    expect(result.get('src/a.ts')).toEqual({ covered: 2, total: 3, pct: (2 / 3) * 100 });
    expect(result.get('src/b.ts')).toEqual({ covered: 0, total: 1, pct: 0 });
  });

  it('reports 100% for a file with zero DA: lines (istanbul/lcov convention)', () => {
    const lcov = ['SF:src/empty.ts', 'end_of_record'].join('\n');
    expect(parseLcov(lcov, identity).get('src/empty.ts')).toEqual({ covered: 0, total: 0, pct: 100 });
  });

  it('applies sfToRepoPath to each SF: value', () => {
    const lcov = ['SF:src/x.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const result = parseLcov(lcov, (sf) => `container/agent-runner/${sf}`);
    expect([...result.keys()]).toEqual(['container/agent-runner/src/x.ts']);
  });
});

describe('containerSfToRepoPath', () => {
  it('prefixes an SF: value relative to container/agent-runner', () => {
    expect(containerSfToRepoPath('src/poll-loop.ts')).toBe('container/agent-runner/src/poll-loop.ts');
  });

  it('resolves a ../.. SF: value that escapes container/agent-runner', () => {
    expect(containerSfToRepoPath('../../setup/lib/dockerfile-version.ts')).toBe('setup/lib/dockerfile-version.ts');
  });
});

describe('mergeCoverage', () => {
  it('merges maps, later maps winning on key collision', () => {
    const a = new Map<string, CoverageStat>([['x', { covered: 1, total: 2, pct: 50 }]]);
    const b = new Map<string, CoverageStat>([['x', { covered: 2, total: 2, pct: 100 }]]);
    expect(mergeCoverage(a, b).get('x')).toEqual({ covered: 2, total: 2, pct: 100 });
  });
});

describe('hasExecutableCode', () => {
  it('is false for a file of only imports, re-exports, interfaces, and type aliases', () => {
    const source = [
      "import type { Tool } from '@modelcontextprotocol/sdk/types.js';",
      "export { touchHeartbeat } from '../heartbeat.js';",
      "export type { MessageInRow } from './messages-in.js';",
      'export interface McpToolDefinition {',
      '  tool: Tool;',
      '}',
      'type Alias = string;',
    ].join('\n');
    expect(hasExecutableCode(source)).toBe(false);
  });

  it('is true for a file with a real function body', () => {
    expect(hasExecutableCode('export function add(a: number, b: number): number {\n  return a + b;\n}')).toBe(true);
  });

  it('is true for a bare const with a computed value', () => {
    expect(hasExecutableCode('export const now = Date.now();')).toBe(true);
  });

  it('is true for export default', () => {
    expect(hasExecutableCode('export default 42;')).toBe(true);
  });

  it('does not look past the first executable statement into re-exported modules it cannot see', () => {
    // The point of the check is "does THIS file have anything to cover" — a re-export
    // is never executable on its own terms regardless of what it points at.
    expect(hasExecutableCode("export { anything } from './somewhere-with-lots-of-logic.js';")).toBe(false);
  });

  it('is false for an empty file', () => {
    expect(hasExecutableCode('')).toBe(false);
  });
});

describe('classifyFile', () => {
  const nonEmptySource = (): string => 'export function f() { return 1; }';
  const emptySource = (): string => "export type { X } from './x.js';";

  it('classifies a measured file with total > 0 and pct > 0 as measured', () => {
    expect(classifyFile({ covered: 8, total: 10, pct: 80 }, nonEmptySource)).toEqual({
      kind: 'measured',
      pct: 80,
    });
  });

  it('classifies a reported file with total === 0 as n/a only when the source agrees there is nothing to cover', () => {
    expect(classifyFile({ covered: 0, total: 0, pct: 100 }, emptySource)).toEqual({ kind: 'n/a' });
  });

  // Regression guard: total === 0 (istanbul/lcov convention reports that as 100%) must
  // NOT be trusted at face value as "no executable code" — a coverage-tool quirk that
  // reports a spuriously empty block for a file that genuinely has real, substantially
  // covered code (50%+ in a real run) would otherwise silently reclassify it 'n/a' and
  // exempt it from the ratchet forever, masking a real regression (evaluate() lets a
  // CURRENT 'n/a' override even a baseline that remembers real measured coverage).
  it('classifies a reported file with total === 0 as untested, not n/a, when the source has real code', () => {
    expect(classifyFile({ covered: 0, total: 0, pct: 100 }, nonEmptySource)).toEqual({ kind: 'untested' });
  });

  it('classifies a reported file with total > 0 and 0 covered as untested when the source has real code', () => {
    expect(classifyFile({ covered: 0, total: 10, pct: 0 }, nonEmptySource)).toEqual({ kind: 'untested' });
  });

  it('classifies a reported file with total > 0 and 0 covered as n/a when the source has no executable code', () => {
    expect(classifyFile({ covered: 0, total: 10, pct: 0 }, emptySource)).toEqual({ kind: 'n/a' });
  });

  it('falls back to a static read when the file has no report entry at all: real code -> untested', () => {
    expect(classifyFile(undefined, nonEmptySource)).toEqual({ kind: 'untested' });
  });

  it('falls back to a static read when the file has no report entry at all: no executable code -> n/a', () => {
    expect(classifyFile(undefined, emptySource)).toEqual({ kind: 'n/a' });
  });

  it('never reads the source when a report entry already exists', () => {
    let called = false;
    classifyFile({ covered: 1, total: 1, pct: 100 }, () => {
      called = true;
      return '';
    });
    expect(called).toBe(false);
  });
});

describe('classifyAll', () => {
  it('classifies every risk file, reading real source only for ones absent from the report', () => {
    const root = globalThis.uniqueTmpRoot('check-risk-coverage-classify-all');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'untested.ts'), 'export function f() { return 1; }');
    fs.writeFileSync(path.join(root, 'src', 'barrel.ts'), "export type { X } from './x.js';");

    const current = new Map<string, CoverageStat>([['src/measured.ts', { covered: 5, total: 10, pct: 50 }]]);
    const result = classifyAll(root, ['src/measured.ts', 'src/untested.ts', 'src/barrel.ts'], current);

    expect(result.get('src/measured.ts')).toEqual({ kind: 'measured', pct: 50 });
    expect(result.get('src/untested.ts')).toEqual({ kind: 'untested' });
    expect(result.get('src/barrel.ts')).toEqual({ kind: 'n/a' });
  });
});

describe('evaluate', () => {
  const classify = (entries: Record<string, Classification>): Map<string, Classification> =>
    new Map(Object.entries(entries));
  const baseline = (files: Record<string, Baseline['files'][string]>): Baseline => ({
    generatedAt: '2026-01-01T00:00:00Z',
    files,
  });

  it('passes a file that held or improved on its baseline', () => {
    const current = classify({ 'src/a.ts': { kind: 'measured', pct: 90 } });
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }));
    expect(result.passed).toBe(true);
    expect(result.rows[0]).toMatchObject({ status: 'ok', delta: 0 });
  });

  it('passes a drop within the threshold', () => {
    const current = classify({ 'src/a.ts': { kind: 'measured', pct: 89.6 } });
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }), 0.5);
    expect(result.passed).toBe(true);
  });

  it('fails a drop past the threshold', () => {
    const current = classify({ 'src/a.ts': { kind: 'measured', pct: 89 } });
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }), 0.5);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.rows[0].status).toBe('regressed');
  });

  // Floating-point boundary (#686, first half): current/baseline are round2()-ed to 2
  // decimal places, but a raw `current - baseline` float subtraction isn't guaranteed to
  // land exactly on a 2-decimal value at the threshold boundary — e.g. 63.51 - 64.01
  // comes out about 7e-15 more negative than -0.5 in IEEE 754, not exactly -0.5, which
  // would fail a drop of precisely the threshold when it should pass. The fix compares
  // in integer hundredths instead of raw floats.
  describe('threshold boundary is exact despite floating-point drift', () => {
    it('passes an exact 0.50-point drop (66.67 -> 66.17)', () => {
      const current = classify({ 'src/a.ts': { kind: 'measured', pct: 66.17 } });
      const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 66.67 }));
      expect(result.passed).toBe(true);
      expect(result.rows[0].status).toBe('ok');
    });

    it('fails a 0.51-point drop (66.67 -> 66.16)', () => {
      const current = classify({ 'src/a.ts': { kind: 'measured', pct: 66.16 } });
      const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 66.67 }));
      expect(result.passed).toBe(false);
      expect(result.rows[0].status).toBe('regressed');
    });

    it('passes a 0.49-point drop (66.67 -> 66.18)', () => {
      const current = classify({ 'src/a.ts': { kind: 'measured', pct: 66.18 } });
      const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 66.67 }));
      expect(result.passed).toBe(true);
      expect(result.rows[0].status).toBe('ok');
    });

    // These two pairs are exact 0.50-point drops that DO trip the raw-float comparison
    // in this repo's actual runtime (verified: `63.51 - 64.01` and `0.57 - 1.07` each
    // land a hair below -0.5) — the ones the mutation below actually catches.
    it('passes an exact 0.50-point drop that raw float subtraction misrounds (64.01 -> 63.51)', () => {
      const current = classify({ 'src/a.ts': { kind: 'measured', pct: 63.51 } });
      const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 64.01 }));
      expect(result.passed).toBe(true);
      expect(result.rows[0].status).toBe('ok');
    });

    it('passes an exact 0.50-point drop that raw float subtraction misrounds (1.07 -> 0.57)', () => {
      const current = classify({ 'src/a.ts': { kind: 'measured', pct: 0.57 } });
      const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 1.07 }));
      expect(result.passed).toBe(true);
      expect(result.rows[0].status).toBe('ok');
    });
  });

  it('treats a baseline file that is now untested as a drop to 0%', () => {
    const current = classify({ 'src/a.ts': { kind: 'untested' } });
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 10 }));
    expect(result.passed).toBe(false);
    expect(result.rows[0]).toMatchObject({ status: 'regressed', current: 'untested', delta: -10 });
  });

  it('does not fail a new file (not in baseline) that has some coverage', () => {
    const current = classify({ 'src/new.ts': { kind: 'measured', pct: 40 } });
    const result = evaluate(['src/new.ts'], current, baseline({}));
    expect(result.passed).toBe(true);
    expect(result.rows[0].status).toBe('new');
  });

  it('fails a new file (not in baseline) that is untested', () => {
    const current = classify({ 'src/new.ts': { kind: 'untested' } });
    const result = evaluate(['src/new.ts'], current, baseline({}));
    expect(result.passed).toBe(false);
    expect(result.rows[0].status).toBe('new-untested');
  });

  it('never fails a file currently classified n/a, regardless of baseline history', () => {
    const baselineVariants: Record<string, Baseline['files'][string]>[] = [
      {},
      { 'src/a.ts': 40 },
      { 'src/a.ts': 'untested' },
    ];
    for (const files of baselineVariants) {
      const current = classify({ 'src/a.ts': { kind: 'n/a' } });
      const result = evaluate(['src/a.ts'], current, baseline(files));
      expect(result.passed).toBe(true);
      expect(result.rows[0].status).toBe('n/a');
    }
  });

  it('does not fail a baseline "untested" file that is still untested — accepted debt, not a new failure', () => {
    // This is the seeding scenario: a file untested at baseline time reads back as
    // KNOWN debt, not as a brand-new "new-untested" failure.
    const current = classify({ 'src/debt.ts': { kind: 'untested' } });
    const result = evaluate(['src/debt.ts'], current, baseline({ 'src/debt.ts': 'untested' }));
    expect(result.passed).toBe(true);
    expect(result.rows[0].status).toBe('ok');
  });

  it('does not fail a baseline "untested" file that gained coverage', () => {
    const current = classify({ 'src/debt.ts': { kind: 'measured', pct: 30 } });
    const result = evaluate(['src/debt.ts'], current, baseline({ 'src/debt.ts': 'untested' }));
    expect(result.passed).toBe(true);
    expect(result.rows[0].status).toBe('ok');
  });

  it('reports a baseline entry for a deleted/renamed file as removed, without failing', () => {
    const result = evaluate([], new Map(), baseline({ 'src/gone.ts': 80 }));
    expect(result.passed).toBe(true);
    expect(result.rows).toEqual([
      { file: 'src/gone.ts', baseline: 80, current: 'n/a', delta: null, status: 'removed' },
    ]);
  });
});

describe('buildBaseline', () => {
  it('records the classification for every risk file: number, untested, or n/a', () => {
    const current = new Map<string, Classification>([
      ['src/a.ts', { kind: 'measured', pct: 75 }],
      ['src/b.ts', { kind: 'untested' }],
      ['src/c.ts', { kind: 'n/a' }],
    ]);
    const result = buildBaseline(['src/a.ts', 'src/b.ts', 'src/c.ts'], current);
    expect(result.files).toEqual({ 'src/a.ts': 75, 'src/b.ts': 'untested', 'src/c.ts': 'n/a' });
    expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
  });

  it('defaults an unclassified risk file to n/a', () => {
    expect(buildBaseline(['src/a.ts'], new Map()).files).toEqual({ 'src/a.ts': 'n/a' });
  });

  it('rounds a measured pct to 2 decimal places', () => {
    const current = new Map<string, Classification>([['src/a.ts', { kind: 'measured', pct: (1 / 3) * 100 }]]);
    expect(buildBaseline(['src/a.ts'], current).files['src/a.ts']).toBe(33.33);
  });

  it('seeding scenario: a currently-untested file goes in as accepted debt, not silently 0', () => {
    const current = new Map<string, Classification>([['src/legacy.ts', { kind: 'untested' }]]);
    const seeded = buildBaseline(['src/legacy.ts'], current);
    expect(seeded.files['src/legacy.ts']).toBe('untested');

    // And the seeded baseline passes on itself — the whole point of requirement 1.
    const result = evaluate(['src/legacy.ts'], current, seeded);
    expect(result.passed).toBe(true);

    // But a DIFFERENT, genuinely new untested risk file introduced after seeding still
    // fails — seeding only forgives debt that already existed at seed time.
    const withNewFile = new Map<string, Classification>(current).set('src/brand-new.ts', { kind: 'untested' });
    const afterNewFile = evaluate(['src/legacy.ts', 'src/brand-new.ts'], withNewFile, seeded);
    expect(afterNewFile.passed).toBe(false);
    expect(afterNewFile.failures.map((f) => f.file)).toEqual(['src/brand-new.ts']);
  });
});

describe('renderTable / summarize', () => {
  it('renders one aligned row per file and computes min/median, excluding n/a rows', () => {
    const current = new Map<string, Classification>([
      ['src/a.ts', { kind: 'measured', pct: 90 }],
      ['src/b.ts', { kind: 'measured', pct: 70 }],
      ['src/c.ts', { kind: 'n/a' }],
    ]);
    const result = evaluate(['src/a.ts', 'src/b.ts', 'src/c.ts'], current, {
      generatedAt: '2026-01-01T00:00:00Z',
      files: { 'src/a.ts': 90, 'src/b.ts': 70, 'src/c.ts': 'n/a' },
    });
    const table = renderTable(result.rows);
    expect(table).toContain('src/a.ts');
    expect(table).toContain('src/b.ts');
    expect(table).toContain('src/c.ts');
    expect(table.split('\n')).toHaveLength(5); // header + separator + 3 rows

    expect(summarize(result.rows)).toEqual({ count: 3, min: 70, median: 80 });
  });

  it('summarize handles no coverage data at all', () => {
    const rows: FileRow[] = [
      { file: 'src/a.ts', baseline: null, current: 'untested', delta: null, status: 'new-untested' },
    ];
    expect(summarize(rows)).toEqual({ count: 1, min: null, median: null });
  });
});

describe('findMissingFromReport', () => {
  it('lists host risk files absent from the coverage map', () => {
    const current = new Map<string, CoverageStat>([['src/a.ts', { covered: 1, total: 1, pct: 100 }]]);
    expect(findMissingFromReport(['src/a.ts', 'src/b.ts'], current)).toEqual(['src/b.ts']);
  });

  it('is empty when every host risk file has an entry', () => {
    const current = new Map<string, CoverageStat>([['src/a.ts', { covered: 0, total: 0, pct: 100 }]]);
    expect(findMissingFromReport(['src/a.ts'], current)).toEqual([]);
  });
});

describe('resolveBaseline', () => {
  it('fails closed when the baseline is missing and --bootstrap was not passed', () => {
    const result = resolveBaseline(false, null, false);
    expect(result.ok).toBe(false);
  });

  it('bootstraps an empty baseline when --bootstrap was passed and none exists', () => {
    const result = resolveBaseline(false, null, true);
    expect(result).toMatchObject({ ok: true, baseline: { files: {} } });
  });

  it('parses the committed baseline when it exists, regardless of --bootstrap', () => {
    const raw = JSON.stringify({
      generatedAt: '2026-01-01T00:00:00Z',
      files: { 'src/a.ts': 80, 'src/b.ts': 'untested' },
    });
    for (const bootstrap of [true, false]) {
      expect(resolveBaseline(true, raw, bootstrap)).toEqual({
        ok: true,
        baseline: { generatedAt: '2026-01-01T00:00:00Z', files: { 'src/a.ts': 80, 'src/b.ts': 'untested' } },
      });
    }
  });
});

describe('raiseHints', () => {
  it('flags a file that rose more than 2 points above its baseline', () => {
    const rows: FileRow[] = [
      { file: 'src/up.ts', baseline: 50, current: 60, delta: 10, status: 'ok' },
      { file: 'src/flat.ts', baseline: 50, current: 51, delta: 1, status: 'ok' },
      { file: 'src/new.ts', baseline: null, current: 40, delta: null, status: 'new' },
    ];
    expect(raiseHints(rows).map((r) => r.file)).toEqual(['src/up.ts']);
  });

  it('is empty when nothing rose past the hint threshold', () => {
    const rows: FileRow[] = [{ file: 'src/a.ts', baseline: 50, current: 50, delta: 0, status: 'ok' }];
    expect(raiseHints(rows)).toEqual([]);
  });
});
