/**
 * What this container has left in its topic checkouts that is neither committed nor pushed. A baseline taken
 * before the first turn is subtracted at every turn end, so dirt an earlier container left is never reported and
 * deletions need no timestamps. The host's chat idle reap reads the record to decide on an accountability wake.
 */
import { execFile } from 'node:child_process';
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
  /** Test seam for the per-path stat. */
  lstat?: (file: string) => Promise<fs.Stats>;
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

/** Never caught per checkout: running out of time must void the whole result, not shrink it. */
class BudgetExhausted extends Error {
  constructor() {
    super('worktree in-flight budget exhausted');
  }
}

/** Returns the timeout for the next step, or throws once the budget is spent. */
type Deadline = () => number;

function deadlineFrom(opts: InFlightOptions): Deadline {
  const commandTimeoutMs = opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const end = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  return () => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new BudgetExhausted();
    return Math.min(commandTimeoutMs, remaining);
  };
}

function recordedText(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being replaced
  return value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, MAX_RECORDED_CHARS);
}

function git(cwd: string, args: string[], timeoutMs: number, okStatus: readonly number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', '-c', 'protocol.allow=never', ...args],
      {
        cwd,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
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
}

async function listCheckouts(root: string, deadline: Deadline): Promise<{ names: string[]; truncated: boolean }> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], truncated: false };
    throw err;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const names: string[] = [];
  for (const name of candidates) {
    deadline();
    try {
      await fs.promises.lstat(path.join(root, name, '.git'));
    } catch {
      continue;
    }
    if (names.length === MAX_CHECKOUTS) return { names, truncated: true };
    names.push(name);
  }
  return { names, truncated: false };
}

async function worktreeStat(checkout: string, rel: string, opts: InFlightOptions): Promise<string> {
  try {
    const stat = await (opts.lstat ?? fs.promises.lstat)(path.join(checkout, rel));
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}:${stat.mode}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return 'absent';
    }
    throw err;
  }
}

/** `--porcelain=v2 -z` fields before the path, by entry type; the path is the remainder and may hold spaces. */
const PATH_FIELD_OFFSET: Readonly<Record<string, number>> = { '1': 8, '2': 9, u: 10, '?': 1 };

async function readStatus(checkout: string, deadline: Deadline, opts: InFlightOptions): Promise<CheckoutStatus> {
  const raw = await git(
    checkout,
    ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    deadline(),
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
  for (const entry of status.entries) {
    deadline();
    entry.identity += await worktreeStat(checkout, entry.path, opts);
  }
  return status;
}

async function unpushedCommits(checkout: string, revs: string[], deadline: Deadline): Promise<string[]> {
  // One past the cap, so a full list reads as "more than the cap", never as exact.
  const out = await git(checkout, ['rev-list', `--max-count=${MAX_COMMITS + 1}`, ...revs], deadline());
  return out.split('\n').filter(Boolean);
}

/** Every local branch, so a branch switch neither surfaces old commits nor hides new ones. */
function unpushedRevs(status: CheckoutStatus): string[] {
  const tips = status.hasHead ? ['--branches', 'HEAD'] : ['--branches'];
  return [...tips, '--not', '--remotes', ...(status.upstreamTracked ? ['@{upstream}'] : [])];
}

async function snapshotCheckout(
  checkout: string,
  deadline: Deadline,
  opts: InFlightOptions,
): Promise<CheckoutBaseline> {
  const status = await readStatus(checkout, deadline, opts);
  const commits = await unpushedCommits(checkout, unpushedRevs(status), deadline);
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
  const deadline = deadlineFrom(opts);
  try {
    const { names, truncated } = await listCheckouts(root, deadline);
    if (truncated) log(`worktree baseline: more than ${MAX_CHECKOUTS} checkouts; later ones are never attributed`);
    const baseline: WorktreeBaseline = { root, checkouts: new Map(), truncated };
    for (const name of names) {
      try {
        baseline.checkouts.set(name, await snapshotCheckout(path.join(root, name), deadline, opts));
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        baseline.checkouts.set(name, null);
        log(`worktree baseline: ${name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
  deadline: Deadline,
  opts: InFlightOptions,
): Promise<WorktreeInFlightCheckout | null> {
  const status = await readStatus(checkout, deadline, opts);
  // A checkout absent at startup was created by this container, so all of it is new.
  const files = status.entries
    .filter((entry) => before?.dirty.get(entry.path) !== entry.identity)
    .map((entry) => entry.path);

  let unpushed = 0;
  if (!before || before.unpushed !== null) {
    const commits = await unpushedCommits(checkout, unpushedRevs(status), deadline);
    unpushed = commits.filter((sha) => !before?.unpushed?.has(sha)).length;
  }
  if (files.length === 0 && unpushed === 0) return null;

  let upstreamHead: string | null = null;
  if (status.upstreamTracked) {
    upstreamHead =
      (await git(checkout, ['rev-parse', '--verify', '--quiet', '@{upstream}'], deadline(), [0, 1])).trim() || null;
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
  const deadline = deadlineFrom(opts);
  const record: WorktreeInFlight = { at: new Date().toISOString(), checkouts: [] };
  let filesLeft = MAX_FILES_RECORDED;
  for (const name of (await listCheckouts(baseline.root, deadline)).names) {
    const before = baseline.checkouts.get(name);
    if (before === null || (before === undefined && baseline.truncated)) continue;
    try {
      const found = await checkoutInFlight(path.join(baseline.root, name), name, before, deadline, opts);
      if (!found) continue;
      found.files = found.files.slice(0, filesLeft);
      filesLeft -= found.files.length;
      record.checkouts.push(found);
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      log(`worktree in-flight: ${name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
