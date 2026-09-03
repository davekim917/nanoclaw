/**
 * Repo-level test hermeticity tripwire (issue #305).
 *
 * Unit tests must not reach the world. Two escapes happened on 2026-09-03: a
 * fake-timer test advanced past the plugin updater's startup delay and ran a
 * real `git pull` across every repo under `~/plugins` (a live, fail-closed
 * mount into every agent container — a mid-pull tree denies every tool
 * fleet-wide), and `host-sweep-reschedule.test.ts` was found to have been doing
 * a real disk walk plus a GitHub and an Anthropic API call since before seam 2.
 * Both were caught by hand. Per the same-mistake-twice rule the guard is
 * structural, not per-suite discipline.
 *
 * This module is loaded from `setupFiles`, so it is installed in every host
 * test file's module graph before that file's own imports run. It guards three
 * seams:
 *
 *   - **subprocess** — `child_process` / `node:child_process` are mocked so
 *     every spawning export records the attempt and throws with the call site.
 *   - **network** — `globalThis.fetch` and `undici`'s `fetch`/`request` are
 *     wrapped the same way.
 *   - **out-of-tree writes** — `fs`, `node:fs`, `fs/promises` and
 *     `node:fs/promises` write calls are checked against a denylist of paths a
 *     unit test has no business touching (`~/plugins`, the repo's `data/`,
 *     `groups/`, `dist/`, `$HOME` dotfiles). Writes under the temp dir — where
 *     `uniqueTmpRoot` puts every fixture — are untouched.
 *
 * A test that legitimately needs one of these opts in through a named helper,
 * so the exemption is visible in the diff:
 *
 * ```ts
 * import { allowSubprocess, allowNetwork, allowWritesTo } from './test-hermeticity.js';
 * beforeAll(() => allowSubprocess(['git']));
 * ```
 *
 * Allowances are file-scoped and cleared after the file finishes, so one
 * suite's opt-in never widens another's.
 *
 * Mode is set by `NANOCLAW_TEST_HERMETICITY`:
 *   - `warn` (default) — record and log the call site, let the call through.
 *   - `enforce` — record and throw.
 *   - `off` — no guard at all.
 *
 * The repo default is `warn` because the suite is not yet clean: the first full
 * run under this guard failed 40 of 313 files, mostly suites that shell out to
 * real `git` on a scratch checkout. Flipping the whole repo to `enforce` in one
 * commit would have blocked the tripwire from landing at all. The ratchet is
 * per file instead — a suite that is hermetic calls `enforceHermeticity()` in
 * its own body and can never regress, and `NANOCLAW_TEST_HERMETICITY=enforce`
 * runs the whole repo strictly once the backlog is worked off (issue #305).
 */
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { afterAll, vi } from 'vitest';

export type HermeticityMode = 'enforce' | 'warn' | 'off';

export interface HermeticityAttempt {
  kind: 'subprocess' | 'network' | 'fs-write';
  /** The API that was called, e.g. `execFileSync` or `fs.writeFileSync`. */
  api: string;
  /** The command, URL or path the call was aimed at. */
  target: string;
  /** Where in the tree the call came from, best effort. */
  callSite: string;
}

function readMode(): HermeticityMode {
  const raw = (process.env.NANOCLAW_TEST_HERMETICITY ?? '').trim().toLowerCase();
  if (raw === 'warn' || raw === 'off' || raw === 'enforce') return raw;
  return 'warn';
}

/**
 * State lives on `globalThis` rather than in module scope: `vi.resetModules()`
 * (used by a number of suites) gives the test file a fresh copy of this module,
 * and the mock factories below must keep talking to the same allowlists and
 * attempt log the helpers write to.
 */
interface HermeticityState {
  mode: HermeticityMode;
  attempts: HermeticityAttempt[];
  commands: Set<string>;
  network: boolean;
  writePaths: string[];
  /** Warn output is deduped by `kind|api|target|callSite`; one git loop in a
   *  test would otherwise print a hundred identical lines. */
  warned: Set<string>;
}

declare global {
  var __nanoclawHermeticity: HermeticityState | undefined;
}

function state(): HermeticityState {
  let s = globalThis.__nanoclawHermeticity;
  if (!s) {
    s = { mode: readMode(), attempts: [], commands: new Set(), network: false, writePaths: [], warned: new Set() };
    globalThis.__nanoclawHermeticity = s;
  }
  return s;
}

// ── opt-in helpers (their use is deliberately visible in a diff) ─────────────

/**
 * Permit real subprocess execution for these commands, by basename, for the
 * rest of the current test file. `allowSubprocess(['git'])` lets `git`,
 * `/usr/bin/git` and `exec('git rev-parse …')` through; everything else still
 * throws.
 */
export function allowSubprocess(commands: string[]): void {
  for (const c of commands) state().commands.add(nodePath.basename(c));
}

/** Permit real network calls for the rest of the current test file. */
export function allowNetwork(): void {
  state().network = true;
}

/**
 * Permit writes under `root` for the rest of the current test file, overriding
 * the out-of-tree denylist.
 */
export function allowWritesTo(root: string): void {
  state().writePaths.push(nodePath.resolve(root));
}

/** Every guarded call that was recorded, whether it threw or only warned. */
export function hermeticityAttempts(): readonly HermeticityAttempt[] {
  return state().attempts;
}

/** Drop the recorded attempts. Used by the tripwire's own test. */
export function clearHermeticityAttempts(): void {
  state().attempts.length = 0;
}

/**
 * Hold this file to the strict guard regardless of the repo default. A suite
 * that mocks its own I/O seams should call this at the top of its body: it is
 * the ratchet that keeps a clean file clean while the repo as a whole is still
 * on `warn`. Cleared with the rest of the file-scoped state after the file
 * finishes.
 */
export function enforceHermeticity(): void {
  const s = state();
  if (s.mode !== 'off') s.mode = 'enforce';
}

/** The active mode. Exported for the tripwire's own test. */
export function hermeticityMode(): HermeticityMode {
  return state().mode;
}

/**
 * Run `fn` with the tripwire in `mode`, restoring the previous mode after.
 * This is how the tripwire proves it bites: the test disables enforcement and
 * asserts the attempt log still filled up.
 */
export function withHermeticityMode<T>(mode: HermeticityMode, fn: () => T): T {
  const s = state();
  const previous = s.mode;
  s.mode = mode;
  try {
    return fn();
  } finally {
    s.mode = previous;
  }
}

// ── the guard itself ─────────────────────────────────────────────────────────

function callSite(): string {
  const stack = new Error('hermeticity').stack ?? '';
  const frames = stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    // `test-hermeticity.ts:` and not `test-hermeticity`: the latter also drops
    // this module's own test file, which is exactly the frame worth reporting.
    .filter((l) => l.startsWith('at ') && !l.includes('test-hermeticity.ts:'));
  return frames[0] ?? 'unknown call site';
}

/**
 * Record the attempt, then throw (or warn). Recording matters independently of
 * throwing: most host callers already wrap their real work in try/catch or
 * `.catch` precisely so a git or network failure never crashes the host, so a
 * throw-only tripwire can fire and still leave a test green.
 */
function trip(kind: HermeticityAttempt['kind'], api: string, target: string, hint: string): void {
  const s = state();
  const attempt: HermeticityAttempt = { kind, api, target, callSite: callSite() };
  s.attempts.push(attempt);
  const message =
    `test hermeticity: ${kind} escape — ${api}(${target}) from ${attempt.callSite}. ` +
    `Unit tests must not reach outside the process. ${hint}`;
  if (s.mode === 'warn') {
    const key = `${kind}|${api}|${target}|${attempt.callSite}`;
    if (!s.warned.has(key)) {
      s.warned.add(key);
      console.warn(`[hermeticity] ${message}`);
    }
    return;
  }
  throw new Error(message);
}

// ── subprocess ───────────────────────────────────────────────────────────────

/** The command a `child_process` call is aimed at, for allowlist matching. */
function commandOf(api: string, args: unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string') return String(first);
  // exec/execSync take a shell string; the rest take a file path.
  if (api === 'exec' || api === 'execSync') return first.trim().split(/\s+/)[0] ?? first;
  return first;
}

function subprocessAllowed(command: string): boolean {
  const s = state();
  if (s.mode === 'off') return true;
  return s.commands.has(nodePath.basename(command));
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * The guard body shared by the direct call and its promisified twin.
 */
function checkSubprocess(api: string, args: unknown[]): void {
  const command = commandOf(api, args);
  if (subprocessAllowed(command)) return;
  trip('subprocess', api, command, `Mock the seam, or opt in with allowSubprocess(['${nodePath.basename(command)}']).`);
}

function guardChildProcess(real: Record<string, unknown>): Record<string, unknown> {
  const spawning = ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const guarded: Record<string, unknown> = { ...real };
  for (const api of spawning) {
    const original = real[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    const wrapper = (...args: unknown[]): unknown => {
      checkSubprocess(api, args);
      return original(...args);
    };
    // `promisify(execFile)` reads this symbol off the function it is handed and
    // calls it INSTEAD of the function itself. Copying the original's
    // implementation across would therefore hand every promisified caller —
    // `src/container-updates.ts` among them — a straight line to the real
    // binary, past the check above. Wrap it instead.
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    const custom = (original as unknown as Record<symbol, unknown>)[promisifyCustom];
    if (typeof custom === 'function') {
      (wrapper as unknown as Record<symbol, unknown>)[promisifyCustom] = (...args: unknown[]): unknown => {
        checkSubprocess(api, args);
        return (custom as AnyFn)(...args);
      };
    }
    guarded[api] = wrapper;
  }
  guarded.default = guarded;
  return guarded;
}

vi.mock('child_process', async (importOriginal) =>
  guardChildProcess((await importOriginal()) as Record<string, unknown>),
);
vi.mock('node:child_process', async (importOriginal) =>
  guardChildProcess((await importOriginal()) as Record<string, unknown>),
);

// ── network ──────────────────────────────────────────────────────────────────

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

function guardFetch(api: string, original: AnyFn): AnyFn {
  return (...args: unknown[]): unknown => {
    if (state().mode !== 'off' && !state().network) {
      trip('network', api, urlOf(args[0]), 'Mock the client module, or opt in with allowNetwork().');
    }
    return original(...args);
  };
}

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch.bind(globalThis) as unknown as AnyFn;
  globalThis.fetch = guardFetch('fetch', realFetch) as unknown as typeof fetch;
}

vi.mock('undici', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const guarded: Record<string, unknown> = { ...real };
  for (const api of ['fetch', 'request', 'stream', 'upgrade', 'connect']) {
    const original = real[api];
    if (typeof original === 'function') guarded[api] = guardFetch(`undici.${api}`, original as AnyFn);
  }
  guarded.default = guarded;
  return guarded;
});

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
  // A numeric fd: already-open file, nothing to resolve.
  return null;
}

/** `null` when the write is fine, otherwise the reason it is not. */
function writeDenied(target: unknown): string | null {
  const s = state();
  if (s.mode === 'off') return null;
  const raw = pathOf(target);
  if (raw === null) return null;
  const resolved = nodePath.resolve(raw);
  // An explicit opt-in outranks everything else.
  for (const allowed of s.writePaths) {
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

/**
 * Which arguments hold a path this call MUTATES.
 *
 * Most of the API mutates its first. `copyFile`, `cp`, `symlink` and `link`
 * only create their second — checking the first there flags the source, which
 * is how this guard first "caught" a container mount copying a real Snowflake
 * key it was only reading. `rename` is the one that mutates both: it removes
 * the source as well as creating the destination, so
 * `renameSync('<checkout>/data/v2.db', '/tmp/x')` would move live central state
 * out of the checkout while passing a destination-only check.
 */
function writeArgIndices(api: string): number[] {
  if (/^rename/.test(api)) return [0, 1];
  if (/^(copyFile|cp|symlink|link)/.test(api)) return [1];
  return [0];
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

function guardWrites(module: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const guarded: Record<string, unknown> = { ...module };
  for (const api of WRITE_APIS) {
    const original = module[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    const targets = writeArgIndices(api);
    guarded[api] = (...args: unknown[]): unknown => {
      const offending = targets.map((i) => [i, writeDenied(args[i])] as const).find(([, denied]) => denied !== null);
      if (offending !== undefined) {
        const [index, denied] = offending;
        trip(
          'fs-write',
          `${prefix}${api}`,
          String(pathOf(args[index])),
          `${denied} is off limits to unit tests. Write under a uniqueTmpRoot() fixture, or opt in with allowWritesTo().`,
        );
      }
      return original(...args);
    };
  }
  return guarded;
}

function guardFsModule(real: Record<string, unknown>): Record<string, unknown> {
  const guarded = guardWrites(real, 'fs.');
  if (real.promises && typeof real.promises === 'object') {
    guarded.promises = guardWrites(real.promises as Record<string, unknown>, 'fs.promises.');
  }
  guarded.default = guarded;
  return guarded;
}

vi.mock('fs', async (importOriginal) => guardFsModule((await importOriginal()) as Record<string, unknown>));
vi.mock('node:fs', async (importOriginal) => guardFsModule((await importOriginal()) as Record<string, unknown>));
vi.mock('fs/promises', async (importOriginal) => {
  const guarded = guardWrites((await importOriginal()) as Record<string, unknown>, 'fs/promises.');
  guarded.default = guarded;
  return guarded;
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const guarded = guardWrites((await importOriginal()) as Record<string, unknown>, 'fs/promises.');
  guarded.default = guarded;
  return guarded;
});

// ── per-file lifecycle ───────────────────────────────────────────────────────

afterAll(() => {
  const s = state();
  const unacknowledged = s.attempts.slice();
  const mode = s.mode;
  // `enforceHermeticity()` mutates the mode for the file that called it; put
  // the repo default back so a reused worker context cannot inherit it.
  s.mode = readMode();
  s.warned.clear();
  s.commands.clear();
  s.network = false;
  s.writePaths.length = 0;
  s.attempts.length = 0;

  if (unacknowledged.length === 0) return;

  if (mode !== 'enforce') {
    const byKind = unacknowledged.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    }, {});
    const tally = Object.entries(byKind)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    console.warn(
      `[hermeticity] ${unacknowledged.length} escape(s) in this file (${tally}); run with NANOCLAW_TEST_HERMETICITY=enforce to fail on them.`,
    );
    return;
  }

  // Throwing from the guarded call is not enough on its own. Much of the host
  // wraps its real work in try/catch precisely so a git or network failure
  // never crashes the daemon, so an escape can be caught by the code under test
  // and leave the file green in `enforce` mode. Failing here closes that gap: a
  // file that reached out has to say so, by calling clearHermeticityAttempts()
  // once it has asserted on the record.
  const detail = unacknowledged.map((a) => `  ${a.kind} ${a.api}(${a.target}) at ${a.callSite}`).join('\n');
  throw new Error(
    `test hermeticity: ${unacknowledged.length} escape(s) were recorded but never acknowledged:\n${detail}\n` +
      'Mock the seam, opt in by name, or call clearHermeticityAttempts() after asserting on the record.',
  );
});
