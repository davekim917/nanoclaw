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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * A minimal install root: `process.cwd()` is what `src/config.ts` resolves
 * DATA_DIR from, so pointing a spawned run at a temp directory gives a real
 * end-to-end sweep over data this test owns.
 */
function makeInstall(sessions: Array<{ group: string; session: string; recurrence?: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lst-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'v2-sessions'), { recursive: true });

  const central = new Database(path.join(dataDir, 'v2.db'));
  central.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT, folder TEXT, agent_provider TEXT);
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, name TEXT, channel_type TEXT, platform_id TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT);
    CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, timezone TEXT);
  `);
  central.close();

  for (const { group, session, recurrence } of sessions) {
    const dir = path.join(dataDir, 'v2-sessions', group, session);
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT, status TEXT, process_after TEXT,
      recurrence TEXT, series_id TEXT, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT
    )`);
    if (recurrence) {
      db.prepare(
        `INSERT INTO messages_in (id, seq, kind, status, process_after, recurrence, series_id, content)
         VALUES (?, 1, 'task', 'pending', '2026-09-08T00:00:00.000Z', ?, ?, ?)`,
      ).run(`${session}-row`, recurrence, `${session}-series`, JSON.stringify({ prompt: 'fixture prompt' }));
    }
    db.close();
  }
  return root;
}

const DEFAULTS: Options = { help: false, showAll: false, full: false, budgetMs: DEFAULT_BUDGET_MS };

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

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

/**
 * Both cases here were found by review on the first cut of this change, and
 * both are the difference between a ceiling that reports honestly and one that
 * lies. They run the real CLI against a fixture install.
 */
describe('sweep ceiling and progress', () => {
  beforeAll(() => allowSubprocess(['tsx']));

  const sweep = (root: string, args: string[]) =>
    spawnSync(TSX, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8', timeout: 60_000 });

  it('names every database on stderr BEFORE opening it, not after the query returns', () => {
    const root = makeInstall([
      { group: 'g1', session: 's1', recurrence: '0 9 * * *' },
      { group: 'g1', session: 's2' },
    ]);
    const r = sweep(root, []);
    expect(r.status).toBe(0);
    // One eager line per session DB, whether or not it held a series.
    expect(r.stderr).toMatch(/> g1\/s1\n/);
    expect(r.stderr).toMatch(/> g1\/s2\n/);
    expect(r.stdout).toContain('1 active series total');
    expect(r.stdout).not.toContain('ceiling');
  });

  it('reports PARTIAL and exits 3 when the ceiling stops the sweep early', () => {
    const root = makeInstall([{ group: 'g1', session: 's1', recurrence: '0 9 * * *' }]);
    const r = sweep(root, ['--timeout=0.001']);
    expect(r.status).toBe(EXIT_BUDGET);
    expect(r.stdout).toContain('PARTIAL, sweep hit the --timeout ceiling');
    expect(r.stderr).toContain('ABORT: --timeout ceiling');
  });

  it('still exits 3 when the ceiling is breached with no database left to stop at', () => {
    // No session DBs at all, so the pre-open check never runs — the sweep
    // "completes" past its ceiling. It used to exit 0 claiming a clean run.
    const root = makeInstall([]);
    const r = sweep(root, ['--timeout=0.001']);
    expect(r.status).toBe(EXIT_BUDGET);
    expect(r.stdout).toContain('complete, but the sweep ran past the --timeout ceiling');
    expect(r.stdout).not.toContain('PARTIAL');
    expect(r.stderr).toContain('OVER BUDGET');
  });

  it('--timeout 0 opts out of the ceiling entirely', () => {
    const root = makeInstall([{ group: 'g1', session: 's1', recurrence: '0 9 * * *' }]);
    const r = sweep(root, ['--timeout', '0']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 active series total');
    expect(r.stdout).not.toContain('ceiling');
    expect(r.stderr).not.toContain('OVER BUDGET');
  });
});
