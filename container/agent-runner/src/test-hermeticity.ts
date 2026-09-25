/**
 * Test hermeticity tripwire for the agent-runner suite.
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
import { afterAll, mock } from 'bun:test';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Run `fn` with the tripwire in `mode`, restoring the previous mode after. An
 * async callback is awaited, so the mode survives past the first suspension.
 */
export function withHermeticityMode<T>(mode: HermeticityMode, fn: () => T): T {
  const previous = state.mode;
  state.mode = mode;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    state.mode = previous;
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  // An async callback returns at its first `await` with the rest of its body
  // still to run. Restoring in a `finally` would drop the requested mode right
  // there, so everything past the first suspension would execute under the
  // repo default and, in `warn`, actually reach out.
  if (isThenable(result)) {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (error: unknown) => {
        restore();
        throw error;
      },
    ) as T;
  }
  restore();
  return result;
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

/**
 * True while a guarded `child_process` call is running. Bun implements Node's
 * `child_process` on top of `Bun.spawn`, so without this a single
 * `execFileSync` records twice — once at each layer — and doubles the tally the
 * end-of-run message reports.
 */
let insideGuardedSubprocess = false;

/** The guard body shared by the direct call and its promisified twin. */
function checkSubprocess(api: string, args: unknown[]): void {
  const command = commandOf(api, args);
  if (state.mode === 'off' || state.commands.has(nodePath.basename(command))) return;
  trip('subprocess', api, command, `Mock the seam, or opt in with allowSubprocess(['${nodePath.basename(command)}']).`);
}

function guardChildProcess(real: Record<string, unknown>): Record<string, unknown> {
  const guarded: Record<string, unknown> = { ...real };
  for (const api of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    const original = real[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    const wrapper = (...args: unknown[]): unknown => {
      checkSubprocess(api, args);
      insideGuardedSubprocess = true;
      try {
        return original(...args);
      } finally {
        insideGuardedSubprocess = false;
      }
    };
    // `promisify(execFile)` reads this symbol off the function it is handed and
    // calls it INSTEAD of the function itself, so copying the original's
    // implementation across would hand every promisified caller a straight line
    // to the real binary, past the check above. Wrap it instead.
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

/**
 * Bun's own subprocess APIs, which `child_process` does not cover.
 *
 * The runner reaches for these directly — `src/mcp-tools/self-mod.ts` shells out
 * to `opencode` through `Bun.spawn`, and several suites spawn helper processes
 * the same way — so a guard that only wraps Node's exports would report a clean
 * strict run while real child processes came and went. `Bun.spawn` takes either
 * an argv array or `{ cmd: [...] }`; `Bun.$` is a tagged template, and its
 * command text is not reliably recoverable, so it is reported by name.
 */
function guardBunSubprocess(): void {
  const bun = globalThis.Bun as unknown as Record<string, unknown> | undefined;
  if (bun === undefined) return;
  for (const api of ['spawn', 'spawnSync']) {
    const original = bun[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    bun[api] = (...args: unknown[]): unknown => {
      const first = args[0];
      const argv = Array.isArray(first)
        ? first
        : first && typeof first === 'object' && Array.isArray((first as { cmd?: unknown[] }).cmd)
          ? (first as { cmd: unknown[] }).cmd
          : [];
      if (!insideGuardedSubprocess) checkSubprocess(`Bun.${api}`, [String(argv[0] ?? first)]);
      return original(...args);
    };
  }
}

guardBunSubprocess();

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

/** The repository root, resolved from this file rather than the working directory. */
const CHECKOUT_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Roots inside the checkout that a unit test has no business writing to. In a
 * live install these hold production session state, so a test that lands here
 * is writing over the running system.
 *
 * The roots are derived from this file's own location, not from
 * `process.cwd()`. The runner suite runs with `container/agent-runner` as its
 * working directory, so a cwd-derived list protects
 * `container/agent-runner/data` — a path that does not exist — and leaves the
 * real `<checkout>/data` open to `path.resolve(cwd, '../../data/v2.db')`. The
 * cwd is still included, so a suite launched from somewhere else is covered too.
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
  const names = ['data', 'groups', 'dist', 'logs', 'node_modules'];
  const roots = new Set<string>();
  for (const base of [CHECKOUT_ROOT, process.cwd()]) {
    for (const name of names) roots.add(nodePath.join(base, name));
  }
  return [...roots];
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

/**
 * The unguarded path-inspection calls. None of them is a write API, so none is
 * wrapped; `realFs` is the module captured before the mocks were installed.
 */
interface PathOps {
  lstatSync: (p: string) => { isSymbolicLink(): boolean };
  readlinkSync: (p: string) => string;
  realpathSync: (p: string) => string;
}
let PATH_OPS: PathOps | null = null;

/**
 * Run a path-inspection call, or `null` if it fails.
 *
 * Every caller below is inspecting a path that may not exist yet, may dangle,
 * or may not be readable. Any failure means "cannot resolve further", and the
 * lexical path is then the safe answer — so there is nothing to rethrow.
 */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
}

/**
 * The physical path a write lands on, following symlinks.
 *
 * A lexical check is not enough: a fixture under the temp dir can hold a
 * symlink into a denied root, and a write through it would sail past the
 * temp-directory allowance and mutate live state. Neither the target nor the
 * link's destination is guaranteed to exist yet, so this walks to the nearest
 * lstat-able ancestor, follows it by hand when it is a symlink — a dangling one
 * throws out of `realpathSync`, which is exactly what a not-yet-created fixture
 * produces — and re-appends the rest.
 */
function canonicalize(p: string): string {
  const ops = PATH_OPS;
  if (ops === null) return p;
  let current = p;
  const tail: string[] = [];
  // Bounded so a symlink cycle cannot spin here.
  for (let hop = 0; hop < 40; hop += 1) {
    const below: string[] = [];
    let dir = current;
    let stat = attempt(() => ops.lstatSync(dir));
    while (stat === null) {
      const parent = nodePath.dirname(dir);
      if (parent === dir) return p;
      below.unshift(nodePath.basename(dir));
      dir = parent;
      stat = attempt(() => ops.lstatSync(dir));
    }
    if (!stat.isSymbolicLink()) {
      const real = attempt(() => ops.realpathSync(dir));
      return nodePath.join(real ?? dir, ...below, ...tail);
    }
    const target = attempt(() => ops.readlinkSync(dir));
    if (target === null) return p;
    current = nodePath.resolve(nodePath.dirname(dir), target);
    tail.unshift(...below);
  }
  return p;
}

/** The denylist verdict for one already-resolved path. */
function deniedFor(resolved: string): string | null {
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

function writeDenied(target: unknown): string | null {
  if (state.mode === 'off') return null;
  const raw = pathOf(target);
  if (raw === null) return null;
  const resolved = nodePath.resolve(raw);
  const physical = canonicalize(resolved);
  for (const allowed of state.writePaths) {
    if (isUnder(resolved, allowed) || isUnder(physical, allowed)) return null;
  }
  // Both the lexical and the physical path have to be clear. The lexical one
  // catches `<checkout>/data` even when it is itself a symlink elsewhere; the
  // physical one catches a temp path that points into a denied root.
  for (const candidate of physical === resolved ? [resolved] : [resolved, physical]) {
    const denied = deniedFor(candidate);
    if (denied !== null) return denied;
  }
  return null;
}

const WRITE_APIS = [
  'open',
  'openSync',
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
 * Whether an `open` call is opening for WRITING. Omitted flags mean `'r'`.
 * Anything unrecognized is treated as a write, so the guard fails closed.
 */
function isWriteOpen(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags === 'number') {
    const c = realFs.constants as Record<string, number>;
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0;
  }
  return true;
}

/**
 * Which arguments hold a path this call MUTATES.
 *
 * Most of the API mutates its first. `copyFile`, `cp`, `symlink` and `link`
 * only create their second — checking the first there flags the source, which
 * is how this guard first "caught" a container mount copying a real Snowflake
 * key it was only reading. `rename` mutates both: it removes the source as well
 * as creating the destination, so `renameSync('<checkout>/data/v2.db', '/tmp/x')`
 * would move live central state out of the checkout past a destination-only
 * check. `open` mutates its first only when the flags say so, but it has to be
 * covered: `openSync(p, 'w')` truncates before a single byte is written, and
 * the descriptor it hands back is a number, which this guard deliberately
 * ignores — so an unguarded `open` makes every subsequent write invisible.
 */
function writeTargets(api: string, args: unknown[]): number[] {
  if (/^open/.test(api)) return isWriteOpen(args[1]) ? [0] : [];
  if (/^rename/.test(api)) return [0, 1];
  if (/^(copyFile|cp|symlink|link)/.test(api)) return [1];
  return [0];
}

function guardWrites(module: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const guarded: Record<string, unknown> = { ...module };
  for (const api of WRITE_APIS) {
    const original = module[api] as AnyFn | undefined;
    if (typeof original !== 'function') continue;
    guarded[api] = (...args: unknown[]): unknown => {
      const offending = writeTargets(api, args)
        .map((i) => [i, writeDenied(args[i])] as const)
        .find(([, denied]) => denied !== null);
      if (offending !== undefined) {
        const [index, denied] = offending;
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
PATH_OPS = {
  lstatSync: realFs.lstatSync as PathOps['lstatSync'],
  readlinkSync: realFs.readlinkSync as PathOps['readlinkSync'],
  realpathSync: realFs.realpathSync as PathOps['realpathSync'],
};
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

// ── end-of-scope accounting ──────────────────────────────────────────────────

/**
 * Throwing from the guarded call is not enough on its own. Much of the runner
 * wraps its real work in try/catch precisely so a flaky host never takes the
 * session down, so an escape can be caught by the code under test and leave the
 * run green even under `enforce`. Failing here closes that gap: anything that
 * reached out has to say so, by calling clearHermeticityAttempts() once it has
 * asserted on the record.
 */
afterAll(() => {
  const unacknowledged = state.attempts.slice();
  state.attempts.length = 0;
  state.warned.clear();
  if (unacknowledged.length === 0 || state.mode !== 'enforce') return;
  const detail = unacknowledged.map((a) => `  ${a.kind} ${a.api}(${a.target}) at ${a.callSite}`).join('\n');
  throw new Error(
    `test hermeticity: ${unacknowledged.length} escape(s) were recorded but never acknowledged:\n${detail}\n` +
      'Mock the seam, opt in by name, or call clearHermeticityAttempts() after asserting on the record.',
  );
});
