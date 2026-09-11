import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

import {
  buildBaseline,
  containerSfToRepoPath,
  discoverRiskFiles,
  evaluate,
  mergeCoverage,
  parseLcov,
  parseVitestJsonSummary,
  readRiskGlobs,
  renderTable,
  summarize,
  type Baseline,
  type CoverageStat,
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
});

describe('parseVitestJsonSummary', () => {
  it('strips the repo root prefix and reads lines.covered/lines.total', () => {
    const repoRoot = '/repo';
    const summary = {
      total: { lines: { covered: 1, total: 2, pct: 50 } },
      '/repo/src/router.ts': { lines: { covered: 8, total: 10, pct: 80 } },
      '/other/src/router.ts': { lines: { covered: 1, total: 1, pct: 100 } },
    };
    const result = parseVitestJsonSummary(summary, repoRoot);
    expect(result.size).toBe(1);
    expect(result.get('src/router.ts')).toEqual({ covered: 8, total: 10, pct: 80 });
  });

  it('ignores entries with no usable lines block', () => {
    const result = parseVitestJsonSummary({ '/repo/src/x.ts': {} }, '/repo');
    expect(result.size).toBe(0);
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

describe('evaluate', () => {
  const stat = (pct: number): CoverageStat => ({ covered: pct, total: 100, pct });
  const baseline = (files: Record<string, number>): Baseline => ({ generatedAt: '2026-01-01T00:00:00Z', files });

  it('passes a file that held or improved on its baseline', () => {
    const current = new Map([['src/a.ts', stat(90)]]);
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }));
    expect(result.passed).toBe(true);
    expect(result.rows[0]).toMatchObject({ status: 'ok', delta: 0 });
  });

  it('passes a drop within the threshold', () => {
    const current = new Map([['src/a.ts', stat(89.6)]]);
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }), 0.5);
    expect(result.passed).toBe(true);
  });

  it('fails a drop past the threshold', () => {
    const current = new Map([['src/a.ts', stat(89)]]);
    const result = evaluate(['src/a.ts'], current, baseline({ 'src/a.ts': 90 }), 0.5);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.rows[0].status).toBe('regressed');
  });

  it('treats a baseline file missing from the current report as a drop to 0%', () => {
    const result = evaluate(['src/a.ts'], new Map(), baseline({ 'src/a.ts': 10 }));
    expect(result.passed).toBe(false);
    expect(result.rows[0]).toMatchObject({ status: 'regressed', currentPct: null, delta: -10 });
  });

  it('does not fail a new file (not in baseline) that has some coverage', () => {
    const current = new Map([['src/new.ts', stat(40)]]);
    const result = evaluate(['src/new.ts'], current, baseline({}));
    expect(result.passed).toBe(true);
    expect(result.rows[0].status).toBe('new');
  });

  it('fails a new file (not in baseline) with 0% coverage', () => {
    const current = new Map([['src/new.ts', stat(0)]]);
    const result = evaluate(['src/new.ts'], current, baseline({}));
    expect(result.passed).toBe(false);
    expect(result.rows[0].status).toBe('new-untested');
  });

  it('fails a new file (not in baseline) entirely absent from the coverage report', () => {
    const result = evaluate(['src/new.ts'], new Map(), baseline({}));
    expect(result.passed).toBe(false);
    expect(result.rows[0].status).toBe('new-untested');
  });
});

describe('buildBaseline', () => {
  it('records current pct for every risk file, defaulting to 0 when uncovered', () => {
    const current = new Map<string, CoverageStat>([['src/a.ts', { covered: 3, total: 4, pct: 75 }]]);
    const result = buildBaseline(['src/a.ts', 'src/b.ts'], current);
    expect(result.files).toEqual({ 'src/a.ts': 75, 'src/b.ts': 0 });
    expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
  });

  it('rounds to 2 decimal places', () => {
    const current = new Map<string, CoverageStat>([['src/a.ts', { covered: 1, total: 3, pct: (1 / 3) * 100 }]]);
    expect(buildBaseline(['src/a.ts'], current).files['src/a.ts']).toBe(33.33);
  });
});

describe('renderTable / summarize', () => {
  it('renders one aligned row per file and computes min/median', () => {
    const result = evaluate(
      ['src/a.ts', 'src/b.ts'],
      new Map<string, CoverageStat>([
        ['src/a.ts', { covered: 90, total: 100, pct: 90 }],
        ['src/b.ts', { covered: 70, total: 100, pct: 70 }],
      ]),
      { generatedAt: '2026-01-01T00:00:00Z', files: { 'src/a.ts': 90, 'src/b.ts': 70 } },
    );
    const table = renderTable(result.rows);
    expect(table).toContain('src/a.ts');
    expect(table).toContain('src/b.ts');
    expect(table.split('\n')).toHaveLength(4); // header + separator + 2 rows

    expect(summarize(result.rows)).toEqual({ count: 2, min: 70, median: 80 });
  });

  it('summarize handles no coverage data at all', () => {
    expect(
      summarize([{ file: 'src/a.ts', baselinePct: null, currentPct: null, delta: null, status: 'new-untested' }]),
    ).toEqual({ count: 1, min: null, median: null });
  });
});
