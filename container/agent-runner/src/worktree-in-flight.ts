/**
 * What this container has left in its topic checkouts that is neither committed nor pushed. A baseline taken
 * before the first turn is subtracted at every turn end, so dirt an earlier container left is never reported and
 * deletions need no timestamps. The host's chat idle reap reads the record to decide on an accountability wake.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  clearWorktreeInFlight,
  setWorktreeInFlight,
  type WorktreeInFlight,
  type WorktreeInFlightCheckout,
} from './modules/mailbox/session-state.js';

const WORKTREES_ROOT = '/workspace/worktrees';
const MAX_CHECKOUTS = 32;
const MAX_PATHS_PER_CHECKOUT = 5_000;
const MAX_COMMITS = 500;
const MAX_FILES_RECORDED = 20;
/** The host drops a longer or multi-line string, so every recorded string is cut to fit it. */
const MAX_RECORDED_CHARS = 200;
const COMMAND_TIMEOUT_MS = 5_000;
/** Far past 32 names; the listing child is killed here and the listing counts as truncated. */
const LISTING_MAX_BYTES = 64 * 1024;
const BUDGET_MS = 20_000;

interface CheckoutBaseline {
  /** Path → identity of every changed path at startup. */
  dirty: Map<string, string>;
  /** Commits on no remote at startup, across every local branch; null when there were more than the cap. */
  unpushed: Set<string> | null;
}

export interface WorktreeBaseline {
  root: string;
  /** null for a checkout that existed at startup but could not be read: nothing in it is attributable. */
  checkouts: Map<string, CheckoutBaseline | null>;
  /** The startup listing hit MAX_CHECKOUTS, so a checkout missing from `checkouts` may predate this container. */
  truncated: boolean;
}

export interface InFlightOptions {
  commandTimeoutMs?: number;
  budgetMs?: number;
  log?: (msg: string) => void;
  /** Test seams. */
  lstat?: (file: string) => Promise<fs.Stats>;
  listCommand?: (root: string) => string[];
  now?: () => number;
}

interface StatusEntry {
  path: string;
  /** Stable while nobody touches the path: status code, staged mode and blob, and the worktree file's stat tuple. */
  identity: string;
}

interface CheckoutStatus {
  /** False on an unborn branch. */
  hasHead: boolean;
  branch: string | null;
  upstream: string | null;
  /** False when there is no upstream or its ref is gone. */
  upstreamTracked: boolean;
  entries: StatusEntry[];
}

/** Never swallowed anywhere: running out of time voids the whole result (no record, no baseline), never shrinks it. */
class BudgetExhausted extends Error {
  constructor() {
    super('worktree in-flight budget exhausted');
  }
}

/** One time budget for a whole snapshot or turn-end pass. */
class Budget {
  private readonly end: number;

  constructor(
    budgetMs: number,
    private readonly now: () => number,
  ) {
    this.end = now() + budgetMs;
  }

  /** Throws once the budget is spent. */
  check(): void {
    if (this.now() >= this.end) throw new BudgetExhausted();
  }

  /**
   * Settles with `work` unless the budget runs out first, in which case it rejects at the deadline — a stalled
   * filesystem call cannot hold the caller past it — and calls `onExpire` to stop the work where that is possible.
   * A failure that lands after the deadline is reported as the budget, so it cannot be mistaken for one checkout's.
   */
  race<T>(work: () => Promise<T>, onExpire?: () => void): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          onExpire?.();
          reject(new BudgetExhausted());
        },
        Math.max(this.end - this.now(), 0),
      );
      work().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(this.now() >= this.end ? new BudgetExhausted() : err);
        },
      );
    });
  }
}

function budgetFrom(opts: InFlightOptions): Budget {
  return new Budget(opts.budgetMs ?? BUDGET_MS, opts.now ?? Date.now);
}

function recordedText(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being replaced
  return value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, MAX_RECORDED_CHARS);
}

function git(
  cwd: string,
  args: string[],
  budget: Budget,
  opts: InFlightOptions,
  okStatus: readonly number[] = [0],
): Promise<string> {
  const timeoutMs = opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const abort = new AbortController();
  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['--no-optional-locks', '-c', 'protocol.allow=never', ...args],
        {
          cwd,
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf8',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          signal: abort.signal,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const code = (error as { code?: unknown }).code;
          if (typeof code === 'number' && okStatus.includes(code)) return resolve(stdout);
          const detail = (error as { killed?: boolean }).killed
            ? `killed after ${timeoutMs}ms`
            : stderr.trim().split('\n').pop() || error.message;
          reject(new Error(`git ${args[0]} in ${cwd}: ${detail}`));
        },
      );
      child.stdin?.end();
    });
  return budget.race(run, () => abort.abort());
}

function findDirectories(root: string): string[] {
  return ['find', root, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '!', '-name', '.*', '-print0'];
}

/**
 * The root's subdirectory names, read in a child process: Bun's `Dir.read()` buffers the whole directory on its
 * first call and cannot be cancelled, while a child can be killed at the byte cap or the deadline.
 */
function listDirectoryNames(
  root: string,
  budget: Budget,
  opts: InFlightOptions,
): Promise<{ names: string[]; complete: boolean }> {
  const [command, ...args] = (opts.listCommand ?? findDirectories)(root);
  const abort = new AbortController();
  const run = (): Promise<{ names: string[]; complete: boolean }> =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let stderr = '';
      const finish = (complete: boolean): void => {
        if (settled) return;
        settled = true;
        const entries = Buffer.concat(chunks).toString('utf8').split('\0');
        // Complete output ends with a NUL, leaving an empty last element; capped output may end mid-name.
        entries.pop();
        resolve({ names: entries.filter(Boolean).map((entry) => path.basename(entry)), complete });
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = LISTING_MAX_BYTES - bytes;
        chunks.push(chunk.subarray(0, room));
        bytes += Math.min(chunk.length, room);
        if (chunk.length >= room) {
          // Settled here, not on 'close': a grandchild holding the pipe open would delay 'close' indefinitely.
          child.kill('SIGKILL');
          child.stdout.destroy();
          finish(false);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 2_000) stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          settled = true;
          reject(new Error(`listing ${root}: exit ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
          return;
        }
        finish(true);
      });
    });
  return budget.race(run, () => abort.abort());
}

/** Stops at the first checkout past the cap; a listing cut short at the byte cap also counts as truncated. */
async function listCheckouts(
  root: string,
  budget: Budget,
  opts: InFlightOptions,
): Promise<{ names: string[]; truncated: boolean }> {
  let rootStat: fs.Stats;
  try {
    rootStat = await budget.race(() => fs.promises.stat(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], truncated: false };
    throw err;
  }
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);
  const listing = await listDirectoryNames(root, budget, opts);
  const names: string[] = [];
  for (const name of listing.names) {
    const isCheckout = await budget.race(() =>
      fs.promises.lstat(path.join(root, name, '.git')).then(
        () => true,
        () => false,
      ),
    );
    if (!isCheckout) continue;
    if (names.length === MAX_CHECKOUTS) return { names: names.sort(), truncated: true };
    names.push(name);
  }
  return { names: names.sort(), truncated: !listing.complete };
}

async function worktreeStat(checkout: string, rel: string, budget: Budget, opts: InFlightOptions): Promise<string> {
  const lstat = opts.lstat ?? ((file: string) => fs.promises.lstat(file));
  try {
    const stat = await budget.race(() => lstat(path.join(checkout, rel)));
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}:${stat.mode}`;
  } catch (err) {
    if (err instanceof BudgetExhausted) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return 'absent';
    }
    throw err;
  }
}

/** `--porcelain=v2 -z` fields before the path, by entry type; the path is the remainder and may hold spaces. */
const PATH_FIELD_OFFSET: Readonly<Record<string, number>> = { '1': 8, '2': 9, u: 10, '?': 1 };

async function readStatus(checkout: string, budget: Budget, opts: InFlightOptions): Promise<CheckoutStatus> {
  const raw = await git(
    checkout,
    ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    budget,
    opts,
  );
  const status: CheckoutStatus = { hasHead: true, branch: null, upstream: null, upstreamTracked: false, entries: [] };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '') continue;
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.hasHead = value !== '(initial)';
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') status.upstreamTracked = true;
      continue;
    }
    const offset = PATH_FIELD_OFFSET[token[0]];
    if (offset === undefined) continue;
    const fields = token.split(' ');
    if (fields.length <= offset) throw new Error(`unparseable status entry in ${checkout}`);
    const rel = fields.slice(offset).join(' ');
    // A rename or copy carries its source path as the next NUL-terminated field.
    if (token[0] === '2') i++;
    if (status.entries.length >= MAX_PATHS_PER_CHECKOUT) {
      throw new Error(`more than ${MAX_PATHS_PER_CHECKOUT} changed paths in ${checkout}`);
    }
    const code = token[0] === '?' ? '??' : fields[1];
    const staged = token[0] === '1' || token[0] === '2' ? `${fields[4]}:${fields[7]}` : '';
    status.entries.push({ path: rel, identity: `${code}:${staged}:` });
  }
  for (const entry of status.entries) entry.identity += await worktreeStat(checkout, entry.path, budget, opts);
  return status;
}

/**
 * Commits on no remote, across every local branch, so a branch switch neither surfaces old commits nor hides new
 * ones. The same set at startup and turn end, independent of the checked-out branch: excluding its upstream would
 * drop a local upstream's unpushed commits from the baseline and resurface them after a switch.
 */
async function unpushedCommits(
  checkout: string,
  status: CheckoutStatus,
  budget: Budget,
  opts: InFlightOptions,
): Promise<string[]> {
  const tips = status.hasHead ? ['--branches', 'HEAD'] : ['--branches'];
  // One past the cap, so a full list reads as "more than the cap", never as exact.
  const out = await git(
    checkout,
    ['rev-list', `--max-count=${MAX_COMMITS + 1}`, ...tips, '--not', '--remotes'],
    budget,
    opts,
  );
  return out.split('\n').filter(Boolean);
}

async function snapshotCheckout(checkout: string, budget: Budget, opts: InFlightOptions): Promise<CheckoutBaseline> {
  const status = await readStatus(checkout, budget, opts);
  const commits = await unpushedCommits(checkout, status, budget, opts);
  return {
    dirty: new Map(status.entries.map((entry) => [entry.path, entry.identity])),
    unpushed: commits.length > MAX_COMMITS ? null : new Set(commits),
  };
}

/**
 * Taken before the first turn. Never throws. An unreadable checkout is recorded as unattributable; running out of
 * budget yields no baseline at all, since checkouts it never reached would otherwise read as created later.
 */
export async function snapshotWorktrees(
  root: string = WORKTREES_ROOT,
  opts: InFlightOptions = {},
): Promise<WorktreeBaseline | null> {
  const log = opts.log ?? (() => {});
  const budget = budgetFrom(opts);
  try {
    const { names, truncated } = await listCheckouts(root, budget, opts);
    if (truncated) log(`worktree baseline: more than ${MAX_CHECKOUTS} checkouts; later ones are never attributed`);
    const baseline: WorktreeBaseline = { root, checkouts: new Map(), truncated };
    for (const name of names) {
      try {
        baseline.checkouts.set(name, await snapshotCheckout(path.join(root, name), budget, opts));
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        baseline.checkouts.set(name, null);
        log(`worktree baseline: ${name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    budget.check();
    return baseline;
  } catch (err) {
    log(`worktree baseline skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function checkoutInFlight(
  checkout: string,
  name: string,
  before: CheckoutBaseline | undefined,
  budget: Budget,
  opts: InFlightOptions,
): Promise<WorktreeInFlightCheckout | null> {
  const status = await readStatus(checkout, budget, opts);
  // A checkout absent at startup was created by this container, so all of it is new.
  const files = status.entries
    .filter((entry) => before?.dirty.get(entry.path) !== entry.identity)
    .map((entry) => entry.path);

  let unpushed = 0;
  if (!before || before.unpushed !== null) {
    const commits = await unpushedCommits(checkout, status, budget, opts);
    unpushed = commits.filter((sha) => !before?.unpushed?.has(sha)).length;
  }
  if (files.length === 0 && unpushed === 0) return null;

  let upstreamHead: string | null = null;
  if (status.upstreamTracked) {
    upstreamHead =
      (await git(checkout, ['rev-parse', '--verify', '--quiet', '@{upstream}'], budget, opts, [0, 1])).trim() || null;
  }
  return {
    name: recordedText(name),
    branch: status.branch === null ? null : recordedText(status.branch),
    upstream: status.upstream === null ? null : recordedText(status.upstream),
    upstream_head: upstreamHead === null ? null : recordedText(upstreamHead),
    files: files.slice(0, MAX_FILES_RECORDED).map(recordedText),
    file_count: files.length,
    unpushed: Math.min(unpushed, MAX_COMMITS),
  };
}

export async function computeWorktreeInFlight(
  baseline: WorktreeBaseline,
  opts: InFlightOptions = {},
): Promise<WorktreeInFlight> {
  const log = opts.log ?? (() => {});
  const budget = budgetFrom(opts);
  const record: WorktreeInFlight = { at: new Date().toISOString(), checkouts: [] };
  let filesLeft = MAX_FILES_RECORDED;
  for (const name of (await listCheckouts(baseline.root, budget, opts)).names) {
    const before = baseline.checkouts.get(name);
    if (before === null || (before === undefined && baseline.truncated)) continue;
    try {
      const found = await checkoutInFlight(path.join(baseline.root, name), name, before, budget, opts);
      if (!found) continue;
      found.files = found.files.slice(0, filesLeft);
      filesLeft -= found.files.length;
      record.checkouts.push(found);
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      log(`worktree in-flight: ${name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Evidence gathered past the deadline is not published, even when every step succeeded.
  budget.check();
  return record;
}

/**
 * Called at every turn end; never throws. On failure the record is cleared rather than left in place: a stale
 * non-empty record from an earlier turn would otherwise wake the session for work it may since have pushed.
 */
export async function recordWorktreeInFlight(
  baseline: WorktreeBaseline | null,
  opts: InFlightOptions = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  try {
    if (baseline === null) {
      clearWorktreeInFlight();
      return;
    }
    setWorktreeInFlight(await computeWorktreeInFlight(baseline, opts));
  } catch (err) {
    log(`worktree in-flight record skipped: ${err instanceof Error ? err.message : String(err)}`);
    try {
      clearWorktreeInFlight();
    } catch (clearErr) {
      log(`worktree in-flight record clear failed: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
    }
  }
}
