/**
 * Regression cover for the 2026-09-06 incident: `--help` was not a flag this
 * script knew about, so it fell through the two `process.argv.includes()`
 * checks as "no flags" and started a full ~1,200-database fleet sweep instead
 * of printing the usage text sitting in its own header.
 *
 * The parser tests are pure. The two spawn tests are the ones that actually
 * encode the incident — they assert that neither `--help` nor a typo reaches
 * the sweep at all.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET_MS,
  EXIT_BUDGET,
  EXIT_USAGE,
  USAGE,
  UsageError,
  parseArgs,
  type Options,
} from './list-scheduled-tasks.js';
import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

enforceHermeticity();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'list-scheduled-tasks.ts');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const DEFAULTS: Options = { help: false, showAll: false, full: false, budgetMs: DEFAULT_BUDGET_MS };

describe('parseArgs', () => {
  it('defaults to a bounded, pending-only, clipped sweep', () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
    expect(DEFAULT_BUDGET_MS).toBeGreaterThan(0);
  });

  it('recognizes --help and -h instead of sweeping the fleet', () => {
    expect(parseArgs(['--help'])).toEqual({ ...DEFAULTS, help: true });
    expect(parseArgs(['-h'])).toEqual({ ...DEFAULTS, help: true });
  });

  it('still honours --all and --full, together and apart', () => {
    expect(parseArgs(['--all'])).toEqual({ ...DEFAULTS, showAll: true });
    expect(parseArgs(['--full'])).toEqual({ ...DEFAULTS, full: true });
    expect(parseArgs(['--full', '--all'])).toEqual({ ...DEFAULTS, showAll: true, full: true });
  });

  it('takes --timeout in both spellings, and 0 to opt out of the ceiling', () => {
    expect(parseArgs(['--timeout', '60']).budgetMs).toBe(60_000);
    expect(parseArgs(['--timeout=60']).budgetMs).toBe(60_000);
    expect(parseArgs(['--timeout=0']).budgetMs).toBe(0);
    expect(parseArgs(['--timeout', '1.5']).budgetMs).toBe(1_500);
  });

  it.each<[string, string[]]>([
    ['--timeout abc', ['--timeout', 'abc']],
    ['--timeout -5', ['--timeout', '-5']],
    ['--timeout <empty>', ['--timeout', '']],
    ['--timeout=abc', ['--timeout=abc']],
    ['--timeout with no value', ['--timeout']],
  ])('rejects a bad --timeout value: %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it.each<[string, string[]]>([
    ['--halp', ['--halp']],
    ['--al', ['--al']],
    ['-a', ['-a']],
    ['a bare positional', ['extra']],
    ['a typo after a good flag', ['--all', '--nope']],
  ])('rejects unknown argv rather than silently sweeping: %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it('documents every flag it accepts', () => {
    for (const flag of ['--all', '--full', '--timeout', '--help']) expect(USAGE).toContain(flag);
  });
});

describe('CLI entrypoint', () => {
  // The entrypoint is the seam under test, so it has to be a real process.
  beforeAll(() => allowSubprocess(['tsx']));

  const runCli = (args: string[]) =>
    spawnSync(TSX, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 60_000 });

  it('prints usage for --help and exits 0 without touching the fleet', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--timeout');
    // The sweep's own output shapes — a hit here means --help swept anyway.
    expect(r.stdout).not.toContain('active series total');
    expect(r.stderr).not.toContain('sweeping');
  });

  it(`rejects an unknown flag with exit ${EXIT_USAGE} and no sweep`, () => {
    const r = runCli(['--nope']);
    expect(r.status).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('unknown option');
    expect(r.stdout).not.toContain('active series total');
    expect(r.stderr).not.toContain('sweeping');
  });

  it('reserves a distinct exit code for a sweep that hits its ceiling', () => {
    expect(EXIT_BUDGET).not.toBe(EXIT_USAGE);
    expect(EXIT_BUDGET).not.toBe(0);
    expect(USAGE).toContain(String(EXIT_BUDGET));
  });
});
