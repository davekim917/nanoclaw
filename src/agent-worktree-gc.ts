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
 * ── Why this REPORTS and does not delete ──
 *
 * It used to force-remove. Seven review rounds produced seventeen findings and
 * every one was another way `--force` loses work: an unreadable index, a
 * vanished HEAD that was a commit's only reference, a tracked file under a
 * node_modules path, a session entering between the survey and the unlink.
 * That is not a run of bad luck — proving a worktree safe to delete means
 * reproducing the checks `git worktree remove` already performs, and each
 * reproduction is a fresh way to be wrong.
 *
 * So the destructive half is gone. This classifies, and prints the commands.
 * `git worktree remove` WITHOUT `--force` is the last gate, and it refuses a
 * worktree with modifications or untracked files on its own — correctly, which
 * is more than the code here managed in seven attempts.
 *
 * The scarce thing was never the deletion; it was knowing WHICH of a hundred
 * worktrees are safe to touch. That is what this answers.
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

/**
 * Worktrees this collector never reasons about.
 *
 * `.codex/worktrees/` — Codex owns its own lifecycle.
 *
 * Any `nanoclaw-pre-push.XXXXXX` directory — snapshots created by
 * `.husky/pre-push`, which
 * lints a pushed SHA against a throwaway checkout and removes it afterwards.
 * They are excluded rather than probed because the liveness signal cannot see
 * them: the hook creates the snapshot and then runs lint from a DIFFERENT
 * working directory, so no process has its cwd inside one even while it is
 * being actively used. That produced a false "safe to reclaim" on the first
 * real run (#570), on a snapshot whose push was in flight.
 *
 * Detecting the owning push instead would work, but the trade does not pay:
 * measured 6 snapshots at 39 MB each, 234 MB total, against the ~10.5 GB this
 * collector exists for. That is roughly 2% of the target in exchange for a
 * race in a tool whose entire design premise is to refuse when unsure. The
 * hook cleans these up itself; a crashed hook leaving 39 MB behind is a
 * smaller problem than deleting a live one.
 *
 * Matched on the directory NAME rather than a `/tmp` prefix: the hook creates
 * it with `mktemp -d "${TMPDIR:-/tmp}/nanoclaw-pre-push.XXXXXX"`
 * (`.husky/pre-push:111`), so a push run with TMPDIR set puts it under
 * `/var/tmp` or a private runtime dir and a `/tmp`-anchored pattern would miss
 * it entirely. The literal dot is load-bearing — it is what keeps a lookalike
 * like `nanoclaw-prepush-notahook` out.
 */
const OUT_OF_SCOPE = /\/\.codex\/worktrees\/|(?:^|\/)nanoclaw-pre-push\.[^/]*(?:\/|$)/;

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
      // Porcelain v1: two status columns, a space, then the path.
      const xy = l.slice(0, 2);
      const raw = l.slice(3);
      // A rename shows `old -> new`; the destination is what would be lost.
      const pathPart = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
      const segments = pathPart.replace(/^"|"$/g, '').split('/');

      // What makes the node_modules entry disposable is its STATUS, not its
      // name: it is an untracked (`??`) or ignored (`!!`) symlink into the live
      // checkout. Exempting by path alone also swallowed `A `, `R ` and ` M`
      // entries under a node_modules path — `git mv tracked node_modules/x`
      // would have been force-removed as if it were the link. Any tracked
      // status is real work wherever it lives.
      const isUntrackedOrIgnored = xy === '??' || xy === '!!';
      return !(isUntrackedOrIgnored && segments.includes('node_modules'));
    });
}

/**
 * Is `head` already contained in `mainRef`?
 *
 * `--is-ancestor` exits non-zero for "not an ancestor", which is an ANSWER and
 * not a probe failure, so it is asked tolerantly. Both the missing-directory
 * branch and the normal path go through here, so the two can never disagree
 * about what "already merged" means.
 */
function isAncestorOf(repoRoot: string, head: string, mainRef: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, mainRef], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (err) {
    // Exit 1 is the ANSWER "not an ancestor". Anything else — an unknown
    // object, a corrupt repo, git missing — is a failed probe, and reporting
    // that as `unmerged` would put a confident wrong label on it. Both refuse,
    // so nothing unsafe follows either way; the difference is whether the
    // report tells the truth about why.
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
    const why = /(?:^|\/)nanoclaw-pre-push\.[^/]*(?:\/|$)/.test(row.path)
      ? 'pre-push snapshot — owned by .husky/pre-push, which cleans up after itself'
      : 'codex-owned worktree';
    return { row, verdict: 'out-of-scope', detail: why };
  }

  // Checked before `missing`: a lock is a deliberate "do not remove" and an
  // operator who set one on a worktree whose directory has since gone still
  // said not to touch the registration.
  if (row.locked) {
    return { row, verdict: 'locked', detail: 'git worktree lock is set — deliberate do-not-remove' };
  }

  // A registration whose directory is gone has no files left to protect — but
  // it can still hold the only REFERENCE to a commit. For a detached worktree
  // the administrative HEAD may be the sole thing keeping an unmerged commit
  // reachable, and `git worktree prune` drops that entry, after which the
  // commit is unreachable and gc-able. So the ancestor proof applies here too;
  // only the file-level checks are skipped, because there are no files.
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

  // `--ignored` is part of the proof: a build directory is regenerable, but a
  // local `.env` or a stray patch file is not, and both are ignored. Measured
  // on this host, only 18 worktrees carry non-node_modules ignored files —
  // `data`, `dist`, `logs`, and one hand-written patch — so protecting them
  // costs almost nothing and saves exactly the file worth saving.
  // A failure here throws and is caught above; it can no longer read as clean.
  // `-uall` matters: by default git collapses an untracked directory to a
  // single entry, and with `--ignored` an untracked dir containing only
  // ignored files can be summarised in a way that hides real untracked files
  // underneath. Listing every path is the only version of this probe that
  // cannot under-report.
  const status = git(row.path, ['status', '--porcelain', '--ignored', '-uall']);
  if (hasTrackedChanges(status)) {
    return { row, verdict: 'dirty', detail: 'uncommitted tracked changes' };
  }

  const contained = isAncestorOf(repoRoot, row.head, mainRef);
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

export interface GcReport {
  /** The primary checkout — where the reported commands should be run. */
  mainWorktreePath: string;
  assessments: Assessment[];
  /** Worktrees whose directory is gone; their registrations are prunable. */
  orphanedRegistrations: string[];
}

/**
 * Classify every registered worktree. Reports; never deletes.
 *
 * Returns the inventory and the verdicts. Acting on them is the operator's
 * step, and `git worktree remove` without `--force` performs the file-level safety
 * check itself.
 */
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
