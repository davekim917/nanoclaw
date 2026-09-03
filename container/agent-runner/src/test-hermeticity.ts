/**
 * Test hermeticity tripwire for the agent-runner suite (issue #305).
 *
 * The host counterpart lives at `src/test-hermeticity.ts` and carries the full
 * rationale. Short version: unit tests must not shell out, hit the network, or
 * write outside a temp fixture, and on 2026-09-03 two suites did all three
 * before anyone noticed. This module is a `bunfig.toml` preload, so it is in
 * place before any test file's imports resolve.
 *
 * Mode comes from `NANOCLAW_TEST_HERMETICITY`: `warn` (default) records and
 * logs, `enforce` records and throws, `off` disables the guard.
 *
 * One difference from the host guard worth knowing: `bun test` runs every file
 * in a single process and its preload runs once, so `allowSubprocess` and
 * friends are scoped to the whole run, not to one file. Call
 * `resetHermeticityAllowances()` in a suite's teardown if that matters to you.
 * For the same reason there is no per-file `enforceHermeticity()` here as there
 * is on the host: flipping the mode would silently enforce every file that ran
 * afterwards. A suite that wants the strict guard wraps the call in
 * `withHermeticityMode('enforce', ...)`, which restores the previous mode.
 */
import { mock } from 'bun:test';
import nodeOs from 'node:os';
import nodePath from 'node:path';

export type HermeticityMode = 'enforce' | 'warn' | 'off';

export interface HermeticityAttempt {
  kind: 'subprocess' | 'network' | 'fs-write';
  api: string;
  target: string;
  callSite: string;
}

function readMode(): HermeticityMode {
  const raw = (process.env.NANOCLAW_TEST_HERMETICITY ?? '').trim().toLowerCase();
  if (raw === 'warn' || raw === 'off' || raw === 'enforce') return raw;
  return 'warn';
}

const state = {
  mode: readMode(),
  attempts: [] as HermeticityAttempt[],
  commands: new Set<string>(),
  network: false,
  writePaths: [] as string[],
  warned: new Set<string>(),
};

/** Permit real subprocess execution for these commands, matched by basename. */
export function allowSubprocess(commands: string[]): void {
  for (const c of commands) state.commands.add(nodePath.basename(c));
}

/** Permit real network calls. */
export function allowNetwork(): void {
  state.network = true;
}

/** Permit writes under `root`, overriding the out-of-tree denylist. */
export function allowWritesTo(root: string): void {
  state.writePaths.push(nodePath.resolve(root));
}

/** Every guarded call recorded so far, whether it threw or only warned. */
export function hermeticityAttempts(): readonly HermeticityAttempt[] {
  return state.attempts;
}

/** Drop the recorded attempts. */
export function clearHermeticityAttempts(): void {
  state.attempts.length = 0;
}

/** Drop every opt-in granted so far. */
export function resetHermeticityAllowances(): void {
  state.commands.clear();
  state.network = false;
  state.writePaths.length = 0;
  state.warned.clear();
}

export function hermeticityMode(): HermeticityMode {
  return state.mode;
}

/** Run `fn` with the tripwire in `mode`, restoring the previous mode after. */
export function withHermeticityMode<T>(mode: HermeticityMode, fn: () => T): T {
  const previous = state.mode;
  state.mode = mode;
  try {
    return fn();
  } finally {
    state.mode = previous;
  }
}

function callSite(): string {
  const stack = new Error('hermeticity').stack ?? '';
  const frames = stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('test-hermeticity.ts:'));
  return frames[0] ?? 'unknown call site';
}

/**
 * Record first, then throw. Recording is the load-bearing half: most callers
 * here already swallow subprocess and network failures so the runner survives a
 * flaky host, which means a throw-only tripwire can fire and leave a test green.
 */
function trip(kind: HermeticityAttempt['kind'], api: string, target: string, hint: string): void {
  const attempt: HermeticityAttempt = { kind, api, target, callSite: callSite() };
  state.attempts.push(attempt);
  const message =
    `test hermeticity: ${kind} escape — ${api}(${target}) from ${attempt.callSite}. ` +
    `Unit tests must not reach outside the process. ${hint}`;
  if (state.mode === 'warn') {
    const key = `${kind}|${api}|${target}|${attempt.callSite}`;
    if (!state.warned.has(key)) {
      state.warned.add(key);
      console.warn(`[hermeticity] ${message}`);
    }
    return;
  }
  throw new Error(message);
}

type AnyFn = (...args: unknown[]) => unknown;

// ── subprocess ───────────────────────────────────────────────────────────────

function commandOf(api: string, args: unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string') return String(first);
  if (api === 'exec' || api === 'execSync') return first.trim().split(/\s+/)[0] ?? first;
  return first;
}

function guardChildProcess(real: Record<string, unknown>): Record<string, unknown> {
  const guarded: Record<string, unknown> = { ...real };
  for (const api of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    const original = real[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    const wrapper = (...args: unknown[]): unknown => {
      const command = commandOf(api, args);
      if (state.mode !== 'off' && !state.commands.has(nodePath.basename(command))) {
        trip(
          'subprocess',
          api,
          command,
          `Mock the seam, or opt in with allowSubprocess(['${nodePath.basename(command)}']).`,
        );
      }
      return original(...args);
    };
    const promisified = (original as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')];
    if (promisified !== undefined) {
      (wrapper as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = promisified;
    }
    guarded[api] = wrapper;
  }
  guarded.default = guarded;
  return guarded;
}

const realChildProcess = (await import('node:child_process')) as unknown as Record<string, unknown>;
const guardedChildProcess = guardChildProcess(realChildProcess);
mock.module('child_process', () => guardedChildProcess);
mock.module('node:child_process', () => guardedChildProcess);

// ── network ──────────────────────────────────────────────────────────────────

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch.bind(globalThis) as unknown as AnyFn;
  globalThis.fetch = ((...args: unknown[]): unknown => {
    if (state.mode !== 'off' && !state.network) {
      trip('network', 'fetch', urlOf(args[0]), 'Mock the client module, or opt in with allowNetwork().');
    }
    return realFetch(...args);
  }) as unknown as typeof fetch;
}

// ── out-of-tree writes ───────────────────────────────────────────────────────

/**
 * Roots inside the checkout that a unit test has no business writing to. In a
 * live install these hold production session state, so a test that lands here
 * is writing over the running system.
 *
 * Deliberately a denylist, not an allowlist: fixtures live all over the temp
 * dir and a few suites build their own scratch checkouts, so an allowlist would
 * be a wall of exemptions while the escapes worth catching are a short, known
 * list. The home-relative half of the denylist — `~/plugins`, a live
 * fail-closed mount into every agent container, and `$HOME` dotfiles — is
 * applied in `writeDenied` rather than here, because it must yield to the
 * temp-dir allowance.
 */
function checkoutDeniedRoots(): string[] {
  const cwd = process.cwd();
  return [
    nodePath.join(cwd, 'data'),
    nodePath.join(cwd, 'groups'),
    nodePath.join(cwd, 'dist'),
    nodePath.join(cwd, 'logs'),
    nodePath.join(cwd, 'node_modules'),
  ];
}

function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(nodePath.sep) ? parent : parent + nodePath.sep);
}

function pathOf(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.pathname;
  if (Buffer.isBuffer(arg)) return arg.toString();
  return null;
}

function writeDenied(target: unknown): string | null {
  if (state.mode === 'off') return null;
  const raw = pathOf(target);
  if (raw === null) return null;
  const resolved = nodePath.resolve(raw);
  for (const allowed of state.writePaths) {
    if (isUnder(resolved, allowed)) return null;
  }
  // Checkout-relative roots are denied even under the temp dir: a scratch
  // worktree can itself live in /tmp, and `<worktree>/data` is exactly the
  // escape worth catching.
  for (const denied of checkoutDeniedRoots()) {
    if (isUnder(resolved, denied)) return denied;
  }
  // Fixtures live under the temp dir; that is the normal case. This allowance
  // comes BEFORE the home-relative rules on purpose. `homedir()` reads $HOME at
  // call time, and a suite that sandboxes itself by pointing $HOME at a temp
  // directory — codex-sync builds a whole fake `~/plugins` that way — would
  // otherwise be flagged for doing exactly the right thing. A real home
  // directory is never under the temp dir, so nothing worth catching is lost.
  for (const tmp of [nodeOs.tmpdir(), '/tmp', '/private/tmp', '/var/tmp']) {
    if (isUnder(resolved, nodePath.resolve(tmp))) return null;
  }
  const home = nodeOs.homedir();
  // `~/plugins` is a live, fail-closed mount into every agent container.
  const plugins = nodePath.join(home, 'plugins');
  if (isUnder(resolved, plugins)) return plugins;
  if (isUnder(resolved, home) && nodePath.relative(home, resolved).startsWith('.')) return home;
  return null;
}

const WRITE_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'createWriteStream',
  'truncate',
  'truncateSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'chmod',
  'chmodSync',
  'cp',
  'cpSync',
];

/**
 * Which argument holds the path that gets WRITTEN. Two-path calls write the
 * second; reading the first there flags the source, which on the host produced
 * a false positive against a credential file the code was only reading.
 */
function writeArgIndex(api: string): number {
  return /^(copyFile|rename|cp|symlink|link)/.test(api) ? 1 : 0;
}

function guardWrites(module: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const guarded: Record<string, unknown> = { ...module };
  for (const api of WRITE_APIS) {
    const original = module[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    const index = writeArgIndex(api);
    guarded[api] = (...args: unknown[]): unknown => {
      const denied = writeDenied(args[index]);
      if (denied !== null) {
        trip(
          'fs-write',
          `${prefix}${api}`,
          String(pathOf(args[index])),
          `${denied} is off limits to unit tests. Write under a temp fixture, or opt in with allowWritesTo().`,
        );
      }
      return original(...args);
    };
  }
  return guarded;
}

const realFs = (await import('node:fs')) as unknown as Record<string, unknown>;
const guardedFs = guardWrites(realFs, 'fs.');
if (realFs.promises && typeof realFs.promises === 'object') {
  guardedFs.promises = guardWrites(realFs.promises as Record<string, unknown>, 'fs.promises.');
}
guardedFs.default = guardedFs;
mock.module('fs', () => guardedFs);
mock.module('node:fs', () => guardedFs);

const realFsPromises = (await import('node:fs/promises')) as unknown as Record<string, unknown>;
const guardedFsPromises = guardWrites(realFsPromises, 'fs/promises.');
guardedFsPromises.default = guardedFsPromises;
mock.module('fs/promises', () => guardedFsPromises);
mock.module('node:fs/promises', () => guardedFsPromises);
