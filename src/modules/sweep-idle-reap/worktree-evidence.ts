/**
 * What a chat-idle-reaped session left on disk: topic checkouts holding uncommitted files or commits not on their
 * upstream, written during the killed container's lifetime. Read only at a reap, never per sweep.
 *
 * The checkouts are container-writable, so git runs through the safe-git overrides with every configured filter
 * neutralized, no transport, and a hard timeout. Asynchronous because it runs inside the host process: the
 * disposability proof in worktree-cleanup.ts is synchronous and answers only "disposable or not".
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { listTopicCheckouts } from '../../repository-workspaces.js';
import {
  FILTER_DISCOVERY_ARGS,
  FILTER_DISCOVERY_ENV,
  parseFilterKeys,
  safeGitArgs,
  safeGitEnv,
} from '../../safe-git.js';

const REAP_GIT_COMMAND_TIMEOUT_MS = 10_000;
const REAP_GIT_BUDGET_MS = 60_000;
/** Past this many changed paths with none recent, the checkout is unreadable rather than stat-walked forever. */
const MAX_PATHS_STATTED = 5_000;
const MAX_COMMITS_READ = 50;

interface InFlightCheckout {
  name: string;
  branch: string | null;
  upstream: string | null;
  upstreamHead: string | null;
  /** Capped at MAX_COMMITS_READ. */
  unpushedCommits: number;
  dirtyFiles: string[];
}

interface UnreadableCheckout {
  name: string;
  reason: string;
}

export interface WorktreeEvidence {
  inFlight: InFlightCheckout[];
  unreadable: UnreadableCheckout[];
}

const HOST_GIT_OVERRIDES = ['-c', 'protocol.allow=never', '-c', 'core.untrackedCache=false'];

function runGit(
  checkout: string,
  args: readonly string[],
  opts: { filters?: readonly string[]; timeoutMs: number; env?: NodeJS.ProcessEnv; okStatus?: readonly number[] },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      safeGitArgs([...HOST_GIT_OVERRIDES, ...args], undefined, opts.filters ?? []),
      {
        cwd: checkout,
        env: safeGitEnv({
          GIT_NO_LAZY_FETCH: '1',
          GIT_ALLOW_PROTOCOL: 'none',
          // A missing or corrupt `.git` must not let discovery walk up into the install's own checkout.
          GIT_CEILING_DIRECTORIES: path.dirname(checkout),
          ...opts.env,
        }),
        encoding: 'buffer',
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === 'number' && (opts.okStatus ?? [0]).includes(code)) return resolve(stdout);
        const detail = (error as { killed?: boolean }).killed
          ? `killed after ${opts.timeoutMs}ms`
          : (stderr.toString('utf8').trim().split('\n').pop() ?? '') || error.message;
        reject(new Error(`git ${args[0]}: ${detail}`));
      },
    );
    child.stdin?.end();
  });
}

interface StatusSummary {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  /** null when there is no upstream or its ref is gone. */
  ahead: number | null;
  paths: string[];
}

/** `--porcelain=v2 -z`: a path is everything after a fixed number of space-separated fields, so it may hold spaces. */
function afterFields(entry: string, count: number): string {
  let at = -1;
  for (let i = 0; i < count; i++) {
    at = entry.indexOf(' ', at + 1);
    if (at === -1) throw new Error(`unparseable status entry: ${JSON.stringify(entry)}`);
  }
  return entry.slice(at + 1);
}

const PATH_FIELD_OFFSET: Readonly<Record<string, number>> = { '1': 8, '2': 9, u: 10, '?': 1 };

function parseStatus(raw: Buffer): StatusSummary {
  const summary: StatusSummary = { head: null, branch: null, upstream: null, ahead: null, paths: [] };
  const entries = raw.toString('utf8').split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === '') continue;
    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') summary.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') summary.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') summary.upstream = value;
      else if (key === 'branch.ab') summary.ahead = Number.parseInt(value.split(' ')[0] ?? '', 10);
      continue;
    }
    const offset = PATH_FIELD_OFFSET[entry[0]];
    if (offset === undefined) continue;
    summary.paths.push(afterFields(entry, offset));
    // A rename or copy carries its source path as the next NUL-terminated field.
    if (entry[0] === '2') i++;
  }
  if (summary.ahead !== null && !Number.isFinite(summary.ahead)) summary.ahead = null;
  return summary;
}

/** Newest write to `rel`, or to its nearest surviving ancestor inside the checkout when it was deleted. */
async function lastWriteMs(checkout: string, rel: string): Promise<number | null> {
  let candidate = path.join(checkout, rel);
  for (;;) {
    const fromRoot = path.relative(checkout, candidate);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return null;
    try {
      return (await fs.promises.lstat(candidate)).mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || fromRoot === '') throw err;
      candidate = path.dirname(candidate);
    }
  }
}

async function hasRecentWrite(checkout: string, paths: readonly string[], sinceMs: number): Promise<boolean> {
  for (const rel of paths.slice(0, MAX_PATHS_STATTED)) {
    const written = await lastWriteMs(checkout, rel);
    if (written !== null && written >= sinceMs) return true;
  }
  if (paths.length > MAX_PATHS_STATTED) {
    throw new Error(`${paths.length} changed paths, none recent in the first ${MAX_PATHS_STATTED}`);
  }
  return false;
}

async function inspectCheckout(
  checkout: string,
  name: string,
  sinceMs: number,
  timeoutMs: () => number,
): Promise<InFlightCheckout | null> {
  const filters = parseFilterKeys(
    await runGit(checkout, ['config', '--includes', ...FILTER_DISCOVERY_ARGS], {
      timeoutMs: timeoutMs(),
      env: FILTER_DISCOVERY_ENV,
      okStatus: [0, 1],
    }),
  );
  const status = parseStatus(
    await runGit(
      checkout,
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all'],
      { filters, timeoutMs: timeoutMs() },
    ),
  );

  // Committer time, not author time: a commit, amend, rebase or cherry-pick made now all carry it.
  let commitTimesMs: number[] = [];
  const hasTrackedUpstream = status.upstream !== null && status.ahead !== null;
  if (status.head !== null && (!hasTrackedUpstream || status.ahead! > 0)) {
    const exclude = hasTrackedUpstream ? ['@{upstream}'] : ['--remotes'];
    const log = await runGit(
      checkout,
      ['log', `-n${MAX_COMMITS_READ}`, '--format=%ct', 'HEAD', '--not', ...exclude, '--'],
      { timeoutMs: timeoutMs() },
    );
    commitTimesMs = log
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => Number.parseInt(line, 10) * 1000);
  }

  const recentCommit = commitTimesMs.some((ms) => ms >= sinceMs);
  if (!recentCommit && !(await hasRecentWrite(checkout, status.paths, sinceMs))) return null;

  let upstreamHead: string | null = null;
  if (hasTrackedUpstream) {
    const resolved = await runGit(checkout, ['rev-parse', '--verify', '--quiet', '@{upstream}'], {
      timeoutMs: timeoutMs(),
      okStatus: [0, 1],
    });
    upstreamHead = resolved.toString('utf8').trim() || null;
  }
  return {
    name,
    branch: status.branch,
    upstream: status.upstream,
    upstreamHead,
    unpushedCommits: commitTimesMs.length,
    dirtyFiles: status.paths,
  };
}

/**
 * Checkouts under `worktreesDir` holding work written at or after `sinceMs`. A checkout git cannot read, or that
 * the time budget does not reach, is reported as unreadable — never as clean and never as in flight.
 */
export async function inspectWorktreesForReap(
  worktreesDir: string,
  sinceMs: number,
  opts: { commandTimeoutMs?: number; budgetMs?: number } = {},
): Promise<WorktreeEvidence> {
  const commandTimeoutMs = opts.commandTimeoutMs ?? REAP_GIT_COMMAND_TIMEOUT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? REAP_GIT_BUDGET_MS);
  const evidence: WorktreeEvidence = { inFlight: [], unreadable: [] };
  const timeoutMs = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('inspection budget exhausted');
    return Math.min(commandTimeoutMs, remaining);
  };

  for (const checkout of listTopicCheckouts(worktreesDir)) {
    if (checkout.shape === 'unknown') {
      evidence.unreadable.push({ name: checkout.name, reason: 'no .git directory or file' });
      continue;
    }
    try {
      const inFlight = await inspectCheckout(checkout.path, checkout.name, sinceMs, timeoutMs);
      if (inFlight) evidence.inFlight.push(inFlight);
      // eslint-disable-next-line no-catch-all/no-catch-all -- any failure makes this one checkout unreadable, reported to the caller, never clean
    } catch (err) {
      evidence.unreadable.push({ name: checkout.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return evidence;
}
