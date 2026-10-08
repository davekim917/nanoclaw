/**
 * Garbage collection for AGENT-SESSION worktrees (session scratch, ad-hoc /tmp and ~ worktrees, Claude Code
 * `.claude/worktrees/`); host-owned topic worktrees are `worktree-cleanup.ts`'s.
 *
 * REPORTS, never deletes: proving a worktree safe for `--force` means re-implementing `git worktree remove`'s own
 * checks, so the printed `git worktree remove` WITHOUT `--force` is the last gate.
 *
 * Liveness comes from /proc cwds, not the worktree lock: Claude Code releases the lock when a session exits the
 * worktree while its processes keep running there. A lock is still honoured as a deliberate do-not-remove.
 * /tmp location says nothing about staleness; a reboot there leaves orphaned registrations.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Never reasoned about: `.codex/worktrees/` (Codex owns its lifecycle) and `.husky/pre-push` snapshots, whose
 * hook never runs with its cwd inside them, so the liveness probe always sees them idle mid-push. Matched by NAME,
 * not a /tmp prefix (the hook honours TMPDIR); the literal dot keeps lookalikes out.
 */
const OUT_OF_SCOPE = /\/\.codex\/worktrees\/|(?:^|\/)nanoclaw-pre-push\.[^/]*(?:\/|$)/;

export type Verdict =
  | 'eligible'
  | 'live-process'
  | 'locked'
  | 'unmerged'
  | 'dirty'
  | 'open-pr'
  /** GitHub was unreachable, so PR state is unknown — refused, never asserted. */
  | 'pr-unknown'
  /** A probe did not run (unreadable index, git failure) — refused, not assumed clean. */
  | 'probe-failed'
  | 'out-of-scope'
  | 'main';

export interface WorktreeRow {
  path: string;
  head: string;
  branch: string | null;
  missing: boolean;
  locked: boolean;
}

export interface Assessment {
  row: WorktreeRow;
  verdict: Verdict;
  /** Always populated for a non-eligible verdict. */
  detail: string;
}

/** Caught in exactly one place, `assess`. */
class ProbeError extends Error {
  constructor(readonly args: string[]) {
    super(`git ${args.join(' ')} failed`);
    this.name = 'ProbeError';
  }
}

/**
 * Run git, or THROW: a nullable result invited callers to default a result never obtained. `assess` turns
 * ProbeError into `probe-failed`; the only tolerant callers use `gitTolerant`.
 */
function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new ProbeError(args);
  }
}

/** For the two callers outside `assess`; null MUST be reported, never defaulted. */
function gitTolerant(repoRoot: string, args: string[]): string | null {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/** Parsed on the `worktree ` key: splitting on blank lines silently dropped most entries. */
export function parseWorktreeList(porcelain: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let cur: Partial<WorktreeRow> | null = null;
  const flush = () => {
    if (cur?.path) {
      rows.push({
        path: cur.path,
        head: cur.head ?? '',
        branch: cur.branch ?? null,
        missing: false,
        locked: cur.locked ?? false,
      });
    }
    cur = null;
  };
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if ((line === 'locked' || line.startsWith('locked ')) && cur) {
      // Porcelain emits a bare `locked` or `locked <reason>`.
      cur.locked = true;
    }
  }
  flush();
  return rows;
}

export interface LivenessProbe {
  /** A process was positively observed with its cwd inside the directory. */
  live: boolean;
  /**
   * PIDs whose cwd could not be read (hidepid, other UID, non-dumpable), not "exited". Non-zero means idleness was
   * not established.
   */
  uninspectable: number;
}

/**
 * Look for a process whose cwd is inside `dir`. Fails CLOSED: unreadable /proc reports live. A non-root run
 * always has uninspectable PIDs, so `assess` refusing on them makes this effectively root-only.
 */
export function hasLiveProcess(dir: string, procRoot = '/proc'): LivenessProbe {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {
    return { live: true, uninspectable: Number.POSITIVE_INFINITY };
  }
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  let uninspectable = 0;
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
    } catch (err) {
      // ENOENT: exited mid-scan, not evidence of use. EACCES/EPERM: a hole, not an absence.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uninspectable += 1;
      continue;
    }
    if (cwd === dir || cwd.startsWith(prefix)) return { live: true, uninspectable };
  }
  return { live: false, uninspectable };
}

/**
 * Tracked modifications, ignoring an untracked node_modules (a worktree's own install would veto every candidate).
 * Matched as a PATH COMPONENT, never a substring, since a missed edit is lost when the worktree is deleted.
 */
export function hasTrackedChanges(status: string): boolean {
  return status
    .split('\n')
    .filter((l) => l.trim() !== '')
    .some((l) => {
      const xy = l.slice(0, 2);
      const raw = l.slice(3);
      const pathPart = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
      const segments = pathPart.replace(/^"|"$/g, '').split('/');

      // Only an untracked/ignored node_modules entry is the disposable link; any tracked status is real work.
      const isUntrackedOrIgnored = xy === '??' || xy === '!!';
      return !(isUntrackedOrIgnored && segments.includes('node_modules'));
    });
}

/** "Not an ancestor" (exit 1) is an answer, not a probe failure. */
function isAncestorOf(repoRoot: string, head: string, mainRef: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, mainRef], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (err) {
    // Anything but exit 1 is a failed probe, reported as such rather than as `unmerged`.
    if ((err as { status?: number }).status === 1) return false;
    throw new ProbeError(['merge-base', '--is-ancestor', head, mainRef]);
  }
}

export function assess(
  row: WorktreeRow,
  repoRoot: string,
  opts: {
    mainRef?: string;
    procRoot?: string;
    openPrBranches?: ReadonlySet<string>;
    /** GitHub unreachable: refuse branch-carrying worktrees, and say why. */
    prStateUnknown?: boolean;
    mainWorktreePath?: string;
  } = {},
): Assessment {
  try {
    return assessOrThrow(row, repoRoot, opts);
  } catch (err) {
    if (err instanceof ProbeError) {
      return { row, verdict: 'probe-failed', detail: `${err.message} — eligibility could not be established` };
    }
    throw err;
  }
}

function assessOrThrow(row: WorktreeRow, repoRoot: string, opts: Parameters<typeof assess>[2] = {}): Assessment {
  const mainRef = opts.mainRef ?? 'origin/main';

  // The primary worktree is git's FIRST listed one, not the cwd (which may itself be a worktree).
  if (opts.mainWorktreePath && path.resolve(row.path) === path.resolve(opts.mainWorktreePath)) {
    return { row, verdict: 'main', detail: 'the primary checkout' };
  }
  if (!opts.mainWorktreePath && path.resolve(row.path) === path.resolve(repoRoot)) {
    return { row, verdict: 'main', detail: 'the primary checkout' };
  }
  if (OUT_OF_SCOPE.test(row.path)) {
    const why = /(?:^|\/)nanoclaw-pre-push\.[^/]*(?:\/|$)/.test(row.path)
      ? 'pre-push snapshot — owned by .husky/pre-push, which cleans up after itself'
      : 'codex-owned worktree';
    return { row, verdict: 'out-of-scope', detail: why };
  }

  // Before `missing`: a lock on a vanished directory still says not to touch the registration.
  if (row.locked) {
    return { row, verdict: 'locked', detail: 'git worktree lock is set — deliberate do-not-remove' };
  }

  // A vanished directory can still hold a commit's only reference (a detached HEAD that prune would drop), so the
  // ancestor proof still applies; only file-level checks are skipped.
  if (row.missing) {
    if (!isAncestorOf(repoRoot, row.head, mainRef)) {
      return {
        row,
        verdict: 'unmerged',
        detail: `directory gone, but HEAD ${row.head.slice(0, 8)} is not in ${mainRef} — its registration may be the only reference`,
      };
    }
    return { row, verdict: 'eligible', detail: 'registration orphaned — directory gone and HEAD is merged' };
  }

  const liveness = hasLiveProcess(row.path, opts.procRoot);
  if (liveness.live) {
    return { row, verdict: 'live-process', detail: 'a process has its cwd inside this worktree' };
  }
  if (liveness.uninspectable > 0) {
    return {
      row,
      verdict: 'probe-failed',
      detail: `${liveness.uninspectable} process(es) could not be inspected — idleness not established (run as root)`,
    };
  }

  // `--ignored` protects ignored-but-irreplaceable files (`.env`, a patch); `-uall` keeps git from collapsing an
  // untracked directory and hiding files under it.
  const status = git(row.path, ['status', '--porcelain', '--ignored', '-uall']);
  if (hasTrackedChanges(status)) {
    return { row, verdict: 'dirty', detail: 'uncommitted tracked changes' };
  }

  const contained = isAncestorOf(repoRoot, row.head, mainRef);
  if (!contained) {
    return { row, verdict: 'unmerged', detail: `HEAD ${row.head.slice(0, 8)} is not an ancestor of ${mainRef}` };
  }

  // A branch with an open PR is live work even if its commits already reached main.
  if (opts.prStateUnknown && row.branch) {
    return { row, verdict: 'pr-unknown', detail: 'could not reach GitHub to check for an open PR' };
  }
  if (row.branch && opts.openPrBranches?.has(row.branch)) {
    return { row, verdict: 'open-pr', detail: `branch ${row.branch} has an open PR` };
  }

  return { row, verdict: 'eligible', detail: 'merged, clean, idle' };
}

const PR_LIST_LIMIT = 1000;

/**
 * Branches with an open PR, or null when untrustworthy: GitHub unreachable, or a listing at the limit (possibly
 * truncated). A partial list read as complete would delete a worktree still under review.
 */
function openPrBranches(repoRoot: string): Set<string> | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'headRefName'],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = JSON.parse(out) as { headRefName: string }[];
    if (rows.length >= PR_LIST_LIMIT) return null;
    return new Set(rows.map((r) => r.headRefName));
  } catch {
    return null;
  }
}

/** Null when the inventory could not be taken, which is NOT an empty inventory. */
function listWorktrees(repoRoot: string): WorktreeRow[] | null {
  const porcelain = gitTolerant(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;
  return parseWorktreeList(porcelain).map((row) => ({ ...row, missing: !fs.existsSync(row.path) }));
}

export interface GcReport {
  mainWorktreePath: string;
  assessments: Assessment[];
  orphanedRegistrations: string[];
}

export function runAgentWorktreeGcOnce(
  repoRoot: string,
  opts: { mainRef?: string; procRoot?: string } = {},
): GcReport | null {
  const prs = openPrBranches(repoRoot);
  const rows = listWorktrees(repoRoot);
  if (rows === null) return null;

  const assessOpts = {
    mainRef: opts.mainRef,
    procRoot: opts.procRoot,
    openPrBranches: prs ?? new Set<string>(),
    prStateUnknown: prs === null,
    mainWorktreePath: rows[0]?.path,
  };
  const assessments = rows.map((row) => assess(row, repoRoot, assessOpts));
  const orphanedRegistrations = assessments
    .filter((a) => a.verdict === 'eligible' && a.row.missing)
    .map((a) => a.row.path);

  return { mainWorktreePath: rows[0]?.path ?? repoRoot, assessments, orphanedRegistrations };
}
