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

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
export function hasLiveProcess(dir: string, procRoot = '/proc'): boolean {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {
    return true;
  }
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
    } catch {
      continue; // process exited, or not ours to read — neither is evidence of use
    }
    if (cwd === dir || cwd.startsWith(prefix)) return true;
  }
  return false;
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
  } = {},
): Assessment {
  const mainRef = opts.mainRef ?? 'origin/main';

  if (path.resolve(row.path) === path.resolve(repoRoot)) {
    return { row, verdict: 'main', detail: 'the primary checkout' };
  }
  if (OUT_OF_SCOPE.test(row.path)) {
    return { row, verdict: 'out-of-scope', detail: 'codex-owned worktree' };
  }

  // A registration whose directory is gone has nothing to protect and nothing
  // to lose: no process can be inside it and no edits can survive in it.
  if (row.missing) {
    return { row, verdict: 'eligible', detail: 'registration orphaned — directory no longer exists' };
  }

  if (hasLiveProcess(row.path, opts.procRoot)) {
    return { row, verdict: 'live-process', detail: 'a process has its cwd inside this worktree' };
  }

  // Absence of a lock proves nothing (see the header), but its presence is a
  // deliberate "do not remove" and is honoured as one.
  if (row.locked) {
    return { row, verdict: 'locked', detail: 'git worktree lock is set — deliberate do-not-remove' };
  }

  const status = git(row.path, ['status', '--porcelain']) ?? '';
  if (hasTrackedChanges(status)) {
    return { row, verdict: 'dirty', detail: 'uncommitted tracked changes' };
  }

  const contained = git(repoRoot, ['merge-base', '--is-ancestor', row.head, mainRef]) !== null;
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
  prunedRegistrations: number;
}

export function gcMode(env: NodeJS.ProcessEnv = process.env): 'dry-run' | 'apply' {
  return env[GC_APPLY_ENV] === 'apply' ? 'apply' : 'dry-run';
}

/** Branches with an open PR, or null when GitHub cannot be reached. */
export function openPrBranches(repoRoot: string): Set<string> | null {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set((JSON.parse(out) as { headRefName: string }[]).map((r) => r.headRefName));
  } catch {
    return null;
  }
}

export function listWorktrees(repoRoot: string): WorktreeRow[] {
  const porcelain = git(repoRoot, ['worktree', 'list', '--porcelain']) ?? '';
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
  const assessments = rows.map((row) =>
    assess(row, repoRoot, {
      mainRef: opts.mainRef,
      procRoot: opts.procRoot,
      // null (GitHub unreachable) => treat every branch as PR-bearing.
      openPrBranches: prs ?? new Set<string>(),
      prStateUnknown: prs === null,
    }),
  );

  const removed: string[] = [];
  const failed: { path: string; err: string }[] = [];
  let prunedRegistrations = 0;

  if (mode === 'apply') {
    for (const a of assessments) {
      if (a.verdict !== 'eligible') continue;
      if (a.row.missing) {
        prunedRegistrations += 1;
        continue; // reclaimed by the single `worktree prune` below
      }
      // --force overrides only the untracked-node_modules objection; the
      // eligibility check above already proved there are no tracked edits.
      const out = git(repoRoot, ['worktree', 'remove', '--force', a.row.path]);
      if (out === null) failed.push({ path: a.row.path, err: 'git worktree remove failed' });
      else removed.push(a.row.path);
    }
    if (prunedRegistrations > 0) git(repoRoot, ['worktree', 'prune']);
  } else {
    prunedRegistrations = assessments.filter((a) => a.verdict === 'eligible' && a.row.missing).length;
  }

  return { mode, assessments, removed, failed, prunedRegistrations };
}
