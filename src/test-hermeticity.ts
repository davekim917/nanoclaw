/**
 * Repo-level test hermeticity tripwire, loaded from `setupFiles` so it is installed before each host test file's
 * imports. Guards subprocess (`child_process`), network (`fetch`, `undici`) and out-of-tree writes (`fs` against
 * a denylist; the temp dir is untouched). A test opts in through a named helper so the exemption is visible in
 * the diff (`allowSubprocess(['git'])`, `allowNetwork()`, `allowWritesTo(root)`); allowances are file-scoped.
 * Mode from `NANOCLAW_TEST_HERMETICITY`: `warn` (repo default), `enforce`, `off`; a clean suite calls
 * `enforceHermeticity()` to ratchet itself.
 */
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** State lives on `globalThis`: `vi.resetModules()` gives a file a fresh copy of this module, and the mocks must share one state. */
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

/** Permit real subprocess execution for these commands, by basename, for the rest of this test file. */
export function allowSubprocess(commands: string[]): void {
  for (const c of commands) state().commands.add(nodePath.basename(c));
}

/** Permit real network calls for the rest of the current test file. */
export function allowNetwork(): void {
  state().network = true;
}

/** Permit writes under `root` for the rest of this test file, overriding the denylist. */
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

/** Hold this file to the strict guard regardless of the repo default: the ratchet that keeps a clean file clean. */
export function enforceHermeticity(): void {
  const s = state();
  if (s.mode !== 'off') s.mode = 'enforce';
}

/** The active mode. Exported for the tripwire's own test. */
export function hermeticityMode(): HermeticityMode {
  return state().mode;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Run `fn` with the tripwire in `mode`, restoring the previous mode after (an async callback is awaited). */
export function withHermeticityMode<T>(mode: HermeticityMode, fn: () => T): T {
  const s = state();
  const previous = s.mode;
  s.mode = mode;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    s.mode = previous;
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  // Restoring in a `finally` would drop the mode at an async callback's first `await`.
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
    // `test-hermeticity.ts:` and not `test-hermeticity`: the latter also drops
    // this module's own test file, which is exactly the frame worth reporting.
    .filter((l) => l.startsWith('at ') && !l.includes('test-hermeticity.ts:'));
  return frames[0] ?? 'unknown call site';
}

/** Record first, then throw: callers often swallow the failure, so a throw-only tripwire can leave a test green. */
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
    // `promisify(execFile)` calls this symbol INSTEAD of the function; copying it across would bypass the check.
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

/** `fs.constants`, filled in from the real module inside the mock factory. */
const nodeFsConstants = { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024 };

/** The repository root, resolved from this file rather than the working directory. */
const CHECKOUT_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Roots a unit test must not write to (live session state in an install). Derived from this file's location,
 * not `process.cwd()`: the runner suite's cwd is container/agent-runner. A denylist on purpose; the home-relative
 * half is applied in `writeDenied` because it must yield to the temp-dir allowance.
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
  // A numeric fd: already-open file, nothing to resolve.
  return null;
}

/** Path-inspection calls captured inside the mock factory, where `importOriginal()` is still the real module. */
interface PathOps {
  lstatSync: (p: string) => { isSymbolicLink(): boolean };
  readlinkSync: (p: string) => string;
  realpathSync: (p: string) => string;
}
let PATH_OPS: PathOps | null = null;

/** A path-inspection call, or null if it fails: the lexical path is then the safe answer. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
}

/**
 * The physical path a write lands on: a temp fixture can symlink into a denied root. Walks to the nearest
 * lstat-able ancestor and follows it by hand, since the target may not exist yet.
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
  // Checkout-relative roots are denied even under the temp dir: a scratch worktree can live in /tmp.
  for (const denied of checkoutDeniedRoots()) {
    if (isUnder(resolved, denied)) return denied;
  }
  // The temp-dir allowance comes BEFORE the home rules: suites sandbox $HOME under the temp dir.
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

/** `null` when the write is fine, otherwise the reason it is not. */
function writeDenied(target: unknown): string | null {
  const s = state();
  if (s.mode === 'off') return null;
  const raw = pathOf(target);
  if (raw === null) return null;
  const resolved = nodePath.resolve(raw);
  const physical = canonicalize(resolved);
  // An explicit opt-in outranks everything else.
  for (const allowed of s.writePaths) {
    if (isUnder(resolved, allowed) || isUnder(physical, allowed)) return null;
  }
  // Both the lexical and the physical path must be clear.
  for (const candidate of physical === resolved ? [resolved] : [resolved, physical]) {
    const denied = deniedFor(candidate);
    if (denied !== null) return denied;
  }
  return null;
}

/**
 * Whether an `open` call is opening for WRITING. Omitted flags mean `'r'`.
 * Anything unrecognized is treated as a write, so the guard fails closed.
 */
function isWriteOpen(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = nodeFsConstants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return true;
}

/**
 * Which arguments a call MUTATES. `copyFile`/`cp`/`symlink`/`link` create only their second; `rename` mutates
 * both; `open` mutates its first only for write flags, but must be covered because it truncates and the
 * returned descriptor is invisible to this guard.
 */
function writeTargets(api: string, args: unknown[]): number[] {
  if (/^open/.test(api)) return isWriteOpen(args[1]) ? [0] : [];
  if (/^rename/.test(api)) return [0, 1];
  if (/^(copyFile|cp|symlink|link)/.test(api)) return [1];
  return [0];
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
          `${denied} is off limits to unit tests. Write under a uniqueTmpRoot() fixture, or opt in with allowWritesTo().`,
        );
      }
      return original(...args);
    };
  }
  return guarded;
}

function guardFsModule(real: Record<string, unknown>): Record<string, unknown> {
  PATH_OPS = {
    lstatSync: real.lstatSync as PathOps['lstatSync'],
    readlinkSync: real.readlinkSync as PathOps['readlinkSync'],
    realpathSync: real.realpathSync as PathOps['realpathSync'],
  };
  Object.assign(nodeFsConstants, real.constants as Record<string, number>);
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

  // Fail at end of file: code under test often catches the guarded throw. Acknowledge with clearHermeticityAttempts().
  const detail = unacknowledged.map((a) => `  ${a.kind} ${a.api}(${a.target}) at ${a.callSite}`).join('\n');
  throw new Error(
    `test hermeticity: ${unacknowledged.length} escape(s) were recorded but never acknowledged:\n${detail}\n` +
      'Mock the seam, opt in by name, or call clearHermeticityAttempts() after asserting on the record.',
  );
});
