/**
 * Garbage collection for AGENT-SESSION worktrees.
 *
 * Distinct from `worktree-cleanup.ts`, which collects host-owned per-topic
 * worktrees in the repo store. That collector proves a topic idle by reading DB
 * participants (`isContainerRunning`, `getProcessingClaims`); agent-session
 * worktrees have no such rows, so none of its logic ports. Populations here:
 *
 *   /tmp/claude-1001/<session-id>/scratchpad/...   session scratch
 *   /tmp/nanoclaw-*, /tmp/observatory-*            ad-hoc topic worktrees
 *   ~/nanoclaw-worktrees/*, ~/nanoclaw-wt-*        ad-hoc topic worktrees
 *   <repo>/.claude/worktrees/*                     Claude Code EnterWorktree
 *
 * `.codex/worktrees/` is deliberately out of scope — Codex owns its own
 * lifecycle and this collector has no way to reason about it.
 *
 * ── Why the lock is not consulted ──
 *
 * Measured 2026-09-07: `git worktree list --porcelain` reported ZERO locked
 * worktrees while THREE had live sessions running inside them. Two had already
 * passed a merged-and-clean check and were on a removal list; removing them
 * would have killed working agents mid-task. Claude Code releases the lock when
 * a session exits the worktree, but that session's processes keep running with
 * their cwd inside the directory. So liveness is proven from /proc.
 *
 * The lock is therefore a ONE-WAY signal: its absence proves nothing, but its
 * presence is a deliberate "do not remove" that this collector honours. Those
 * are different claims and the measurement above only falsifies the first.
 *
 * ── Why /tmp is not treated as disposable ──
 *
 * Sessions deliberately use /tmp worktrees as the working pattern: create in
 * /tmp, work, push a PR, move on. Location says nothing about staleness. What
 * /tmp does change is which half leaks: the directory disappears on reboot
 * while the .git/worktrees registration survives, so that group is the reason
 * `pruneOrphanedRegistrations` exists.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Acting requires NANOCLAW_WORKTREE_GC=apply. A bare run never deletes. */
const GC_APPLY_ENV = 'NANOCLAW_WORKTREE_GC';

/** Codex owns its own worktree lifecycle; never touch it. */
const OUT_OF_SCOPE = /\/\.codex\/worktrees\//;

export type Verdict =
  | 'eligible'
  | 'live-process'
  /** `git worktree lock` is set — a deliberate do-not-remove, honoured as one. */
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
  /** Directory is registered but gone — prunable registration, not a directory. */
  missing: boolean;
  /** `git worktree lock` was set deliberately; honoured as a refusal. */
  locked: boolean;
}

export interface Assessment {
  row: WorktreeRow;
  verdict: Verdict;
  /** Human-readable reason, always populated for a non-eligible verdict. */
  detail: string;
}

/** A git invocation that failed. Caught in exactly one place, in `assess`. */
export class ProbeError extends Error {
  constructor(readonly args: string[]) {
    super(`git ${args.join(' ')} failed`);
    this.name = 'ProbeError';
  }
}

/**
 * Run git, or THROW.
 *
 * This is the seam. It used to return `string | null`, and every call site
 * independently decided what null meant — four of them decided wrong, in four
 * separate review rounds, each time by letting a default stand in for a result
 * that was never obtained (`?? ''` twice, a swallowed prune failure, a capped
 * listing). Returning a value that can be quietly defaulted is what made that
 * class of bug writable, so it no longer returns one.
 *
 * `assess` catches ProbeError once and turns it into `probe-failed`. Callers
 * outside `assess` that genuinely tolerate failure use `gitTolerant`, and there
 * are two of them, both of which report the failure rather than absorb it.
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

/**
 * Parse `git worktree list --porcelain`.
 *
 * Parsed line-by-line on the `worktree ` key rather than by splitting on blank
 * lines. A blank-line parse silently dropped ~75% of entries when this was
 * first inventoried and reported 22 where there were 85 — an undercount that
 * reads as a clean result.
 */
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

/**
 * True when any process has its cwd inside `dir`.
 *
 * This is the liveness signal, replacing the DB-participant check that the
 * repo-store collector uses. The lock is a separate, one-way signal handled in
 * `assess`; it cannot stand in for this one. Fails CLOSED:
 * if /proc cannot be read at all, every worktree reports live, because an
 * unreadable instrument must never read as "nothing is running".
 */
export interface LivenessProbe {
  /** A process was positively observed with its cwd inside the directory. */
  live: boolean;
  /**
   * PIDs whose cwd could not be read. NOT the same as "exited": hidepid, a
   * different UID, or a non-dumpable process all land here, and any of them
   * could be sitting in this worktree. Non-zero means the probe is INCOMPLETE
   * and idleness was not established.
   */
  uninspectable: number;
}

/**
 * Look for a process whose cwd is inside `dir`.
 *
 * Measured on this host as a non-root user: 306 of 5242 PIDs have an
 * unreadable cwd, nearly all root-owned daemons. So a non-root run can never
 * prove a worktree idle, and `assess` refuses on `uninspectable > 0` rather
 * than guessing. That makes the collector effectively root-only, which matches
 * how it is meant to run (unattended, from a systemd timer) and matches the
 * sibling fd-watchdog, which needs root for the same reason.
 */
export function hasLiveProcess(dir: string, procRoot = '/proc'): LivenessProbe {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {
    // Cannot enumerate at all: maximally uninformative, so maximally cautious.
    return { live: true, uninspectable: Number.POSITIVE_INFINITY };
  }
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  let uninspectable = 0;
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
    } catch (err) {
      // ENOENT means the process exited between readdir and readlink — that is
      // genuinely not evidence of use. Anything else (EACCES, EPERM) means we
      // were not allowed to look, which is a hole, not an absence.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uninspectable += 1;
      continue;
    }
    if (cwd === dir || cwd.startsWith(prefix)) return { live: true, uninspectable };
  }
  return { live: false, uninspectable };
}

/**
 * Tracked modifications, ignoring node_modules.
 *
 * node_modules in these worktrees is a symlink into the live checkout, so it
 * shows as untracked in every one of them and would veto every candidate.
 * Removing the worktree drops the link, never the target.
 *
 * Matched as a PATH COMPONENT, not as a substring of the status line. A
 * substring test silently ignores a real tracked file whose path merely
 * contains the string — `docs/node_modules-policy.md` — and losing that edit
 * is unrecoverable, because the next step is deleting the worktree.
 */
export function hasTrackedChanges(status: string): boolean {
  return status
    .split('\n')
    .filter((l) => l.trim() !== '')
    .some((l) => {
      // Porcelain v1: 2 status chars, a space, then the path. A rename shows
      // `old -> new`; the destination is what would be lost.
      const raw = l.slice(3);
      const pathPart = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
      const segments = pathPart.replace(/^"|"$/g, '').split('/');
      return !segments.includes('node_modules');
    });
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
    /** Git's primary worktree, i.e. the first `worktree list` entry. */
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

  // The primary worktree is whichever git lists FIRST, not whichever directory
  // this script happens to run from. Comparing against repoRoot misclassifies
  // the real checkout as an ordinary worktree whenever the collector is invoked
  // from inside one — which is exactly how it gets developed and tested.
  if (opts.mainWorktreePath && path.resolve(row.path) === path.resolve(opts.mainWorktreePath)) {
    return { row, verdict: 'main', detail: 'the primary checkout' };
  }
  if (!opts.mainWorktreePath && path.resolve(row.path) === path.resolve(repoRoot)) {
    return { row, verdict: 'main', detail: 'the primary checkout' };
  }
  if (OUT_OF_SCOPE.test(row.path)) {
    return { row, verdict: 'out-of-scope', detail: 'codex-owned worktree' };
  }

  // Checked before `missing`: a lock is a deliberate "do not remove" and an
  // operator who set one on a worktree whose directory has since gone still
  // said not to touch the registration.
  if (row.locked) {
    return { row, verdict: 'locked', detail: 'git worktree lock is set — deliberate do-not-remove' };
  }

  // A registration whose directory is gone has nothing to protect and nothing
  // to lose: no process can be inside it and no edits can survive in it.
  if (row.missing) {
    return { row, verdict: 'eligible', detail: 'registration orphaned — directory no longer exists' };
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

  // `--ignored` is part of the proof: a build directory is regenerable, but a
  // local `.env` or a stray patch file is not, and both are ignored. Measured
  // on this host, only 18 worktrees carry non-node_modules ignored files —
  // `data`, `dist`, `logs`, and one hand-written patch — so protecting them
  // costs almost nothing and saves exactly the file worth saving.
  // A failure here throws and is caught above; it can no longer read as clean.
  const status = git(row.path, ['status', '--porcelain', '--ignored']);
  if (hasTrackedChanges(status)) {
    return { row, verdict: 'dirty', detail: 'uncommitted tracked changes' };
  }

  // `--is-ancestor` exits non-zero for "not an ancestor", which is an ANSWER,
  // not a probe failure — so it is asked tolerantly and the null read as false.
  const contained = gitTolerant(repoRoot, ['merge-base', '--is-ancestor', row.head, mainRef]) !== null;
  if (!contained) {
    return { row, verdict: 'unmerged', detail: `HEAD ${row.head.slice(0, 8)} is not an ancestor of ${mainRef}` };
  }

  // /tmp worktrees are the working pattern — created, worked, PR'd. A branch
  // with an open PR is live work even when its commits already reached main
  // (a PR can be open against a branch that fast-forwarded).
  if (opts.prStateUnknown && row.branch) {
    return { row, verdict: 'pr-unknown', detail: 'could not reach GitHub to check for an open PR' };
  }
  if (row.branch && opts.openPrBranches?.has(row.branch)) {
    return { row, verdict: 'open-pr', detail: `branch ${row.branch} has an open PR` };
  }

  return { row, verdict: 'eligible', detail: 'merged, clean, idle' };
}

export interface GcReport {
  mode: 'dry-run' | 'apply';
  assessments: Assessment[];
  removed: string[];
  failed: { path: string; err: string }[];
  /** Eligible in the survey, refused by the re-check taken just before deletion. */
  skippedOnRecheck: { path: string; verdict: Verdict; detail: string }[];
  prunedRegistrations: number;
}

export function gcMode(env: NodeJS.ProcessEnv = process.env): 'dry-run' | 'apply' {
  return env[GC_APPLY_ENV] === 'apply' ? 'apply' : 'dry-run';
}

const PR_LIST_LIMIT = 1000;

/**
 * Branches with an open PR, or null when the listing cannot be TRUSTED.
 *
 * Null covers two cases that must not be distinguished by the caller: GitHub
 * was unreachable, and the listing came back exactly at the limit, meaning it
 * may have been truncated and a branch with an open PR could be missing from
 * it. A partial list read as complete would delete a worktree whose review is
 * still in flight.
 */
export function openPrBranches(repoRoot: string): Set<string> | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'headRefName'],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const rows = JSON.parse(out) as { headRefName: string }[];
    if (rows.length >= PR_LIST_LIMIT) return null; // possibly truncated — untrustworthy
    return new Set(rows.map((r) => r.headRefName));
  } catch {
    return null;
  }
}

/** Null when the inventory could not be taken — NOT an empty inventory. */
export function listWorktrees(repoRoot: string): WorktreeRow[] | null {
  const porcelain = gitTolerant(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;
  return parseWorktreeList(porcelain).map((row) => ({ ...row, missing: !fs.existsSync(row.path) }));
}

/**
 * Assess every worktree and, in apply mode, remove the eligible ones.
 *
 * The PR lookup fails CLOSED: when GitHub is unreachable we cannot tell an
 * abandoned branch from one with review in flight, so every branch-carrying
 * worktree is refused. Losing a cleanup pass is free; deleting a worktree whose
 * PR is still open is not.
 *
 * It is refused as `pr-unknown`, never relabelled `open-pr`. Reporting a PR we
 * never confirmed would be the same unverified-success claim this collector
 * exists to avoid making about worktrees.
 */
export function runAgentWorktreeGcOnce(
  repoRoot: string,
  opts: { mode?: 'dry-run' | 'apply'; mainRef?: string; procRoot?: string } = {},
): GcReport {
  const mode = opts.mode ?? gcMode();
  const prs = openPrBranches(repoRoot);
  const rows = listWorktrees(repoRoot);
  if (rows === null) {
    // Reporting zero worktrees as a clean sweep would look identical to a
    // successful run that found nothing to do.
    return {
      mode,
      assessments: [],
      removed: [],
      failed: [{ path: '(git worktree list)', err: 'could not read the worktree inventory — nothing was assessed' }],
      skippedOnRecheck: [],
      prunedRegistrations: 0,
    };
  }
  // One options object, used for both the survey and the pre-delete re-check,
  // so the two can never drift into judging by different criteria.
  const assessOpts = {
    mainRef: opts.mainRef,
    procRoot: opts.procRoot,
    openPrBranches: prs ?? new Set<string>(),
    prStateUnknown: prs === null,
    mainWorktreePath: rows[0]?.path,
  };
  const assessments = rows.map((row) => assess(row, repoRoot, assessOpts));

  const removed: string[] = [];
  const failed: { path: string; err: string }[] = [];
  const skippedOnRecheck: { path: string; verdict: Verdict; detail: string }[] = [];
  let prunedRegistrations = 0;

  if (mode === 'apply') {
    for (const a of assessments) {
      if (a.verdict !== 'eligible') continue;
      if (a.row.missing) {
        prunedRegistrations += 1;
        continue; // reclaimed by the single `worktree prune` below
      }

      // Re-assess immediately before deleting. Every assessment above was made
      // before any deletion began, so by now an agent may have entered this
      // worktree or written to it — and the whole pass is the window. Acting on
      // a stored verdict is acting on stale evidence; re-running the probes
      // narrows the window to the gap between this check and the unlink.
      // Re-read HEAD too. Trusting the surveyed value would validate a commit
      // that may no longer be current: an agent can commit into this worktree
      // between the survey and now, and the merged-into-main proof would then
      // be about a commit that is no longer checked out.
      const currentHead = gitTolerant(a.row.path, ['rev-parse', 'HEAD']);
      if (currentHead === null) {
        skippedOnRecheck.push({ path: a.row.path, verdict: 'probe-failed', detail: 'HEAD unreadable at removal time' });
        continue;
      }
      const fresh = assess({ ...a.row, head: currentHead }, repoRoot, assessOpts);
      if (fresh.verdict !== 'eligible') {
        skippedOnRecheck.push({ path: a.row.path, verdict: fresh.verdict, detail: fresh.detail });
        continue;
      }

      // --force overrides only the untracked-node_modules objection; the
      // re-check above already proved there are no tracked edits.
      const out = gitTolerant(repoRoot, ['worktree', 'remove', '--force', a.row.path]);
      if (out === null) failed.push({ path: a.row.path, err: 'git worktree remove failed' });
      else removed.push(a.row.path);
    }
    if (prunedRegistrations > 0 && gitTolerant(repoRoot, ['worktree', 'prune']) === null) {
      // Silently swallowing this would report registrations as reclaimed when
      // they are all still there on the next run.
      failed.push({ path: '(git worktree prune)', err: 'prune failed — orphaned registrations remain' });
    }
  } else {
    prunedRegistrations = assessments.filter((a) => a.verdict === 'eligible' && a.row.missing).length;
  }

  return { mode, assessments, removed, failed, skippedOnRecheck, prunedRegistrations };
}
