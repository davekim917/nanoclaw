/**
 * Conservative cleanup for host-owned per-topic linked worktrees.
 *
 * Cleanup never talks to a remote. It removes the exact generated topic branch
 * only after proving the linked checkout clean and remote-contained; explicit
 * user branch names and all reachable objects remain preserved. A
 * checkout is eligible only when every DB participant is inactive, Git can
 * prove the tree is clean and has no commits absent from local remote refs,
 * the branch is merged into origin/HEAD or gone from the already-fetched
 * origin namespace, and the topic has been idle for at least seven days.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { runningContainerMounts } from './container-mounts.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { getDb } from './db/connection.js';
import { getContainerState, getProcessingClaims } from './db/session-db.js';
import { log } from './log.js';
import {
  canonicalRepoDir,
  defaultTopicBranch,
  isRepositoryName,
  resolveRepositoryWorkUnit,
  topicStateDir,
  topicWorktreesDir,
  transferTombstonesDir,
  withHostRepositoryLock,
  withRepositoryLifecycleClaims,
  type RepositoryWorkUnit,
} from './repository-workspaces.js';
import { inboundDbPath, openOutboundDb } from './session-manager.js';
import { safeGitArgs, safeGitEnv } from './safe-git.js';
import { dirSizeBytes, sessionWasReclaimed } from './storage-manager.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const MINIMUM_IDLE_DAYS = 7;
const STALE_WARNING_DAYS = 30;
const DEFAULT_TOPIC_IDLE_RECLAIM_DAYS = 14;
/**
 * #190, owner-approved: a scratch clone is only a candidate after two weeks
 * untouched — twice the topic floor, because nothing upstream ever closes a
 * clone the way a session close retires a topic, so idleness is the only
 * signal that the agent which made it has moved on.
 *
 * Directory mtime, not a deep walk: the git proof below is what establishes
 * that the contents are recoverable, and it sees deep edits (dirty, unpushed,
 * stashed) that a mtime sweep would only be able to date, not classify.
 */
const CLONE_IDLE_RECLAIM_DAYS = 14;

let warnedBadIdleReclaimDays = false;

/**
 * Owner-approved widening (2026-08-29): a topic whose open participants have
 * been idle this long is treated as side-(a) evidence too, on top of "every
 * participant closed". 0 disables it (pre-existing behavior).
 *
 * UNSET (the var isn't in the environment at all) -> the deliberate default
 * (14). Set to anything that isn't a plain non-negative integer — "" included
 * (negative, decimal, exponent notation, "abc", "NaN", empty, …) -> DISABLED
 * (0), not the default — a typo meant to turn this off (or a nonsense value)
 * must never silently turn it on at 14. Warns once per process on the bad path.
 */
function topicIdleReclaimDays(): number {
  const raw = process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS;
  if (raw === undefined) return DEFAULT_TOPIC_IDLE_RECLAIM_DAYS;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!warnedBadIdleReclaimDays) {
    warnedBadIdleReclaimDays = true;
    log.warn('Worktree cleanup: invalid NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS, disabling idle reclaim', { value: raw });
  }
  return 0;
}

/** Days since an ISO timestamp. An unparseable timestamp fails closed (treated as just-now). */
function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (Date.now() - ms) / 86_400_000 : 0;
}

interface TopicParticipant {
  sessionId: string;
  agentGroupId: string;
  status: string;
  /** COALESCE(last_active, created_at) — ISO-8601 UTC. */
  idleSince: string;
  /** mtime of inbound.db, or null if unstatable. The durable admission write
   *  itself — last_active is a separate, later write off the same event. */
  inboundMtimeMs: number | null;
}

export interface TopicWorktreeTarget {
  workUnit: RepositoryWorkUnit;
  participants: TopicParticipant[];
  repo: string;
  worktreePath: string;
  canonicalRepoPath: string;
}

interface SessionRow {
  session_id: string;
  agent_group_id: string;
  status: string;
  thread_id: string | null;
  messaging_group_id: string | null;
  platform_id: string | null;
  folder: string;
  workgroup_id: string;
  idle_since: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', safeGitArgs(args), {
      cwd,
      env: safeGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Directory names under a topic's worktrees root, or `null` when the directory
 * could not be read.
 *
 * ENOENT is the ordinary "this topic has no worktrees" answer and returns an
 * empty list. Anything else — EACCES, EIO, ENOTDIR — is a real fault, and
 * collapsing it into an empty list is what makes an unreadable fleet
 * indistinguishable from a collected one. The caller counts and reports it.
 */
function safeDirectories(directory: string): string[] | null {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('Worktree cleanup: worktrees root unreadable; preserving its topic', { directory, err });
    return null;
  }
}

function statMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function sessionInventory(): SessionRow[] | null {
  try {
    return getDb()
      .prepare(
        `SELECT s.id AS session_id, s.agent_group_id, s.status, s.thread_id,
                s.messaging_group_id, mg.platform_id, ag.folder,
                COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id,
                COALESCE(s.last_active, s.created_at) AS idle_since
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
           LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
      )
      .all() as SessionRow[];
  } catch (error) {
    log.error('Worktree cleanup: session inventory failed; preserving every topic', { error });
    return null;
  }
}

function participantsByTopic(
  dataDir: string,
): Map<string, { unit: RepositoryWorkUnit; participants: TopicParticipant[] }> {
  const rows = sessionInventory();
  // A failed inventory is not evidence that nothing is live: preserve everything.
  if (rows === null) return new Map();

  const result = new Map<string, { unit: RepositoryWorkUnit; participants: TopicParticipant[] }>();
  for (const row of rows) {
    try {
      const unit = resolveRepositoryWorkUnit({
        workgroupId: row.workgroup_id,
        sessionId: row.session_id,
        platformId: row.platform_id,
        messagingGroupId: row.messaging_group_id,
        threadId: row.thread_id,
      });
      const key = topicStateDir(unit, dataDir);
      const current = result.get(key) ?? { unit, participants: [] };
      current.participants.push({
        sessionId: row.session_id,
        agentGroupId: row.agent_group_id,
        status: row.status,
        idleSince: row.idle_since,
        inboundMtimeMs: statMtimeMs(inboundDbPath(row.agent_group_id, row.session_id)),
      });
      result.set(key, current);
    } catch (err) {
      log.warn('Worktree cleanup: invalid session repository identity; preserving it', {
        sessionId: row.session_id,
        err,
      });
    }
  }
  return result;
}

export interface DiscoveryResult {
  targets: TopicWorktreeTarget[];
  /**
   * Entries whose names are not valid repository segments, as
   * `workgroup/work-unit/name`. Located, not just named: a bare name deduped
   * across every topic reports one `.github` when there are forty, and gives
   * an operator nowhere to look.
   */
  filteredNames: string[];
  /** Worktrees roots that could not be read at all. */
  unreadableRoots: number;
}

function discover(dataDir: string = DATA_DIR): DiscoveryResult {
  const mapping = participantsByTopic(dataDir);
  const targets: TopicWorktreeTarget[] = [];
  const filteredNames = new Set<string>();
  let unreadableRoots = 0;

  // Only DB-resolvable topics are deletion candidates. Unknown directories are
  // deliberately left intact: missing metadata is never deletion authority.
  for (const [statePath, { unit, participants }] of mapping) {
    if (!fs.existsSync(statePath)) continue;
    const worktreeRoot = topicWorktreesDir(unit, dataDir);
    const names = safeDirectories(worktreeRoot);
    if (names === null) {
      unreadableRoots += 1;
      continue;
    }
    for (const repo of names) {
      // The worktrees root is not a pure repository namespace: the storage
      // activity lease (`.nanoclaw-storage-active`) and the shared pnpm cache
      // (`.pnpm-store`) live here too. Their names are not valid repository
      // segments, so canonicalRepoDir() throws on them — and before this
      // guard, one such directory aborted the entire cleanup pass at
      // discovery, fleet-wide, forever.
      //
      // The filter is deliberately NOT widened to admit them. `SAFE_SEGMENT`
      // is a path-traversal boundary, and a checkout that it rejects is
      // preserved, never deleted. But some rejected names are legitimate
      // repositories — `.github` and `.github-private` are real GitHub repos —
      // so every filtered name is reported rather than dropped silently. A
      // repository name in that report is an operator signal, not noise.
      if (!isRepositoryName(repo)) {
        filteredNames.add(`${unit.workgroupId}/${unit.kind}-${unit.id}/${repo}`);
        continue;
      }
      const worktreePath = path.join(worktreeRoot, repo);
      if (!fs.existsSync(worktreePath)) continue;
      targets.push({
        workUnit: unit,
        participants,
        repo,
        worktreePath,
        canonicalRepoPath: canonicalRepoDir(unit.workgroupId, repo, dataDir),
      });
    }
  }
  return { targets, filteredNames: [...filteredNames].sort(), unreadableRoots };
}

function participantHasPersistedWork(participant: TopicParticipant, dataDir: string): boolean {
  // Session status is not proof that persisted work has completed. A
  // continuation, processing claim, or current tool can survive a transition
  // to inactive and must independently retain the shared topic worktree.
  //
  // Two-signal reclaim check, mirroring writeSessionMessageLocked exactly
  // (session-manager.ts:857: sessionWasReclaimed && !existsSync(inboundDbPath)).
  // Neither signal alone is proof. The journal line is written BEFORE the
  // archiving->closed CAS (storage-manager.ts:1259 vs :1266-1269); on CAS loss
  // the directory is deliberately kept, so journaled-but-CAS-lost is still
  // live. And the session ROOT can be recreated by a late inbound write that
  // loses the reclaim race — it acquires the storage lease (which mkdirs the
  // root) and then writeSessionMessageLocked itself rejects it, leaving a
  // real, non-empty root with no inbound.db inside. inbound.db absence is the
  // answer that survives both: the reclaim removes the whole directory, and
  // nothing recreates that specific file.
  if (
    sessionWasReclaimed(participant.sessionId, path.join(dataDir, 'v2-sessions')) &&
    !fs.existsSync(inboundDbPath(participant.agentGroupId, participant.sessionId))
  ) {
    return false;
  }
  try {
    const db = openOutboundDb(participant.agentGroupId, participant.sessionId);
    try {
      return (
        getProcessingClaims(db).length > 0 ||
        Boolean(getContainerState(db)?.current_tool) ||
        Boolean(db.prepare("SELECT 1 FROM session_state WHERE key = 'work_continuation'").get())
      );
    } finally {
      db.close();
    }
  } catch {
    // Unknown state fails closed.
    return true;
  }
}

function topicIsBusy(participants: TopicParticipant[], dataDir: string): boolean {
  if (participants.length === 0) return true;
  return participants.some(
    (participant) =>
      isContainerRunning(participant.sessionId) ||
      isContainerSpawning(participant.sessionId) ||
      participantHasPersistedWork(participant, dataDir),
  );
}

/**
 * Side (a): is topic ownership clear enough to consider collecting?
 *
 * Every owning row CLOSED, or no row at all, is the original predicate —
 * byte-identical behavior. Otherwise (owner-approved 2026-08-29 widening):
 * EVERY row, closed ones included, must be idle at least idleReclaimDays by
 * coalesce(last_active, created_at). Closure alone no longer exempts a row
 * once any sibling is open — a session closed only yesterday is evidence of
 * recent topic activity, not proof the topic is quiet.
 */
function sideAClear(
  participants: TopicParticipant[] | undefined,
  idleReclaimDays: number,
): { pass: boolean; viaIdle: boolean } {
  if (!participants || participants.length === 0) return { pass: true, viaIdle: false };
  if (participants.every((p) => p.status === 'closed')) return { pass: true, viaIdle: false };
  // The idle path only ever reasons about steady states. `archiving` (mid
  // reclaim CAS) or any other/NULL status is a transitional or unrecognized
  // state the idle floor was never evaluated against — refuse outright
  // rather than let it ride through on a sibling's idle time.
  if (
    idleReclaimDays > 0 &&
    participants.every((p) => p.status === 'closed' || p.status === 'active') &&
    participants.every((p) => daysSince(p.idleSince) >= idleReclaimDays)
  ) {
    return { pass: true, viaIdle: true };
  }
  return { pass: false, viaIdle: false };
}

function transferReferencesPath(
  target: Pick<TopicWorktreeTarget, 'workUnit' | 'repo' | 'worktreePath'>,
  dataDir: string,
): boolean {
  const directory = transferTombstonesDir(target.workUnit.workgroupId, target.repo, dataDir);
  let files: fs.Dirent[];
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    files = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const resolvedTarget = path.resolve(target.worktreePath);
  for (const entry of files) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')) as {
        sourcePath?: unknown;
        destinationPath?: unknown;
      };
      if (
        (typeof parsed.sourcePath === 'string' && path.resolve(parsed.sourcePath) === resolvedTarget) ||
        (typeof parsed.destinationPath === 'string' && path.resolve(parsed.destinationPath) === resolvedTarget)
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function idleDays(directory: string): number {
  try {
    return (Date.now() - fs.statSync(directory).mtimeMs) / 86_400_000;
  } catch {
    return 0;
  }
}

function isLinkedToCanonical(target: TopicWorktreeTarget): boolean {
  try {
    const pointer = fs.lstatSync(path.join(target.worktreePath, '.git'));
    if (!pointer.isFile() || pointer.isSymbolicLink()) return false;
    const common = git(target.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return Boolean(common) && fs.realpathSync(common!) === fs.realpathSync(path.join(target.canonicalRepoPath, '.git'));
  } catch {
    return false;
  }
}

function branchMayBeRemoved(target: TopicWorktreeTarget): { eligible: boolean; reason: string } {
  const status = git(target.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null || status !== '') return { eligible: false, reason: status === null ? 'status-failed' : 'dirty' };
  const unpushed = git(target.worktreePath, ['log', 'HEAD', '--not', '--remotes', '--oneline']);
  if (unpushed === null || unpushed !== '') {
    return { eligible: false, reason: unpushed === null ? 'log-failed' : 'unpushed' };
  }
  const age = idleDays(target.worktreePath);
  if (age < MINIMUM_IDLE_DAYS) return { eligible: false, reason: 'recent' };

  const branch = git(target.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return { eligible: age >= STALE_WARNING_DAYS, reason: 'detached-remote-contained' };
  const remoteHead = git(target.worktreePath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const merged =
    Boolean(remoteHead) && git(target.worktreePath, ['merge-base', '--is-ancestor', 'HEAD', remoteHead!]) === '';
  const remoteBranch = git(target.worktreePath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const gone = remoteBranch === null;
  return { eligible: merged || gone, reason: merged ? 'merged' : gone ? 'remote-branch-gone' : 'unmerged' };
}

async function cleanupOne(target: TopicWorktreeTarget, dataDir: string = DATA_DIR): Promise<void> {
  const context = { workgroupId: target.workUnit.workgroupId, workUnit: target.workUnit.key, repo: target.repo };
  if (topicIsBusy(target.participants, dataDir)) return;
  if (transferReferencesPath(target, dataDir)) return;

  await withRepositoryLifecycleClaims([target.workUnit], () =>
    withHostRepositoryLock(
      target.workUnit.workgroupId,
      target.repo,
      () => {
        if (topicIsBusy(target.participants, dataDir) || transferReferencesPath(target, dataDir)) return;
        if (!isLinkedToCanonical(target)) {
          log.warn('Worktree cleanup: refusing non-linked or mismatched checkout', context);
          return;
        }
        const decision = branchMayBeRemoved(target);
        if (!decision.eligible) {
          if (idleDays(target.worktreePath) >= STALE_WARNING_DAYS) {
            log.warn('Worktree cleanup: preserving stale topic worktree', { ...context, reason: decision.reason });
          }
          return;
        }
        const branch = git(target.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const head = branch ? git(target.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']) : null;
        execFileSync('git', safeGitArgs(['worktree', 'remove', target.worktreePath]), {
          cwd: target.canonicalRepoPath,
          env: safeGitEnv(),
          stdio: 'pipe',
          timeout: 120_000,
        });
        if (branch === defaultTopicBranch(target.workUnit, target.repo)) {
          if (!head) throw new Error('generated topic branch had no verifiable HEAD during cleanup');
          // Expected-old-value makes deletion fail closed if the ref changed
          // between eligibility proof and removal, even though the repository
          // lock should already exclude cooperating writers.
          execFileSync('git', safeGitArgs(['update-ref', '-d', `refs/heads/${branch}`, head]), {
            cwd: target.canonicalRepoPath,
            env: safeGitEnv(),
            stdio: 'pipe',
            timeout: 30_000,
          });
        }
        log.info('Worktree cleanup: removed inactive clean linked checkout', { ...context, reason: decision.reason });
      },
      dataDir,
    ),
  );
}

export async function runWorktreeCleanupOnce(dataDir: string = DATA_DIR): Promise<void> {
  const { targets, filteredNames, unreadableRoots } = discover(dataDir);
  // One pathological topic must not cost the fleet its collection pass: a
  // failing target is skipped and counted, never allowed to abort the rest.
  let skipped = 0;
  for (const target of targets) {
    try {
      await cleanupOne(target, dataDir);
    } catch (err) {
      skipped += 1;
      log.warn('Worktree cleanup: target failed; continuing pass', {
        workgroupId: target.workUnit.workgroupId,
        workUnit: target.workUnit.key,
        repo: target.repo,
        err,
      });
    }
  }
  // A pass that collected nothing — because every target failed, because every
  // name was filtered, or because every root was unreadable — must not read
  // like a pass that had nothing to do. That indistinguishability is exactly
  // what let the discovery throw survive unnoticed for months.
  log.info('Worktree cleanup: pass complete', {
    examined: targets.length,
    skipped,
    filtered: filteredNames.length,
    filteredNames,
    unreadableRoots,
  });
}

// ---------------------------------------------------------------------------
// Storage GC: orphaned topic directories and source clones.
//
// The linked-checkout path above only ever considers topics that a CURRENT
// session row resolves to, so a topic whose rows are gone is never a candidate,
// and source clones were never candidates at all. Both leak.
//
// Removal demands BOTH-SIDES-POSITIVE evidence: the owning topic is absent from
// a SUCCESSFUL database inventory, AND git proves the tree clean with nothing
// unpushed. Anything unprovable — a pruned worktree admin directory, a
// container-absolute gitdir, a failed query — is skipped and logged. Absence of
// a signal is never authority to delete.
//
// Dry-run is the default. Acting requires NANOCLAW_STORAGE_GC=apply.
// ---------------------------------------------------------------------------

const GC_APPLY_ENV = 'NANOCLAW_STORAGE_GC';
const TRASH_BIN = '/usr/bin/trash';
/** Written into a quarantined topic so an interrupted pass can find its way home. */
const QUARANTINE_META_FILE = '.gc-quarantine-meta.json';
/** Scan depth below groups/<folder> for agent-created scratch clones. */
const CLONE_SCAN_DEPTH = 4;
/** Workgroup-root entries that are the repo store itself, never a clone. */
const RESERVED_WORKGROUP_DIRS = new Set(['.repos', '.worktrees', '.rescues']);

export type GcCategory = 'orphan-topic' | 'clone';

export interface GcCandidate {
  category: GcCategory;
  path: string;
  collect: boolean;
  reason: string;
  bytes: number;
  /**
   * Set only for an orphan-topic collected via the idle-threshold path
   * (reason 'idle-and-clean'). Scan-time (sessionId, status, idleSince) for
   * every owning participant — re-verified after the move, before the
   * topic is handed to the real trash. See finalizeIdleCollection.
   */
  idleSnapshot?: Array<{ sessionId: string; status: string; idleSince: string; inboundMtimeMs: number | null }>;
}

export interface GcReport {
  /** false means the inventory failed and NOTHING was evaluated. */
  ran: boolean;
  mode: 'dry-run' | 'apply';
  examined: number;
  collected: number;
  reclaimableBytes: Record<GcCategory, number>;
  skips: Record<string, number>;
  candidates: GcCandidate[];
}

function emptyReport(mode: 'dry-run' | 'apply', ran: boolean): GcReport {
  return {
    ran,
    mode,
    examined: 0,
    collected: 0,
    reclaimableBytes: { 'orphan-topic': 0, clone: 0 },
    skips: {},
    candidates: [],
  };
}

function gcMode(): 'dry-run' | 'apply' {
  return process.env[GC_APPLY_ENV] === 'apply' ? 'apply' : 'dry-run';
}

/**
 * A `git worktree lock` marker on this checkout's admin dir. Codex review
 * (PR #182, round 6, verified against Git 2.43): `worktree prune` exits 0 but
 * leaves a locked entry's registration in place even once its path is gone —
 * recreating it afterward fails with "missing but locked worktree". A lock is
 * an agent explicitly saying "don't touch this", so it makes the checkout
 * non-disposable regardless of git cleanliness — refuse at evaluation time,
 * not buried in the later prune step. No-op for a plain clone (scope 'all'):
 * only a linked worktree's git-dir has a `locked` file to find.
 */
function isWorktreeLocked(dir: string): boolean {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  return gitDir !== null && fs.existsSync(path.join(gitDir, 'locked'));
}

/**
 * Positive proof that a checkout holds nothing worth keeping.
 *
 * `scope` is 'head' for a linked worktree (its branch is the only one it owns)
 * and 'all' for a clone, which owns every local branch in it. A git invocation
 * that fails — the usual cause is a pruned worktree admin directory or a gitdir
 * only resolvable inside a container — returns unprovable, never clean.
 */
function provenDisposable(dir: string, scope: 'head' | 'all'): { ok: boolean; reason: string } {
  if (isWorktreeLocked(dir)) return { ok: false, reason: 'worktree-locked' };

  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null) return { ok: false, reason: 'status-unprovable' };
  if (status !== '') return { ok: false, reason: 'dirty' };

  const unpushedArgs =
    scope === 'all'
      ? ['log', '--branches', '--not', '--remotes', '--oneline']
      : ['log', 'HEAD', '--not', '--remotes', '--oneline'];
  const unpushed = git(dir, unpushedArgs);
  if (unpushed === null) return { ok: false, reason: 'log-unprovable' };
  if (unpushed !== '') return { ok: false, reason: 'unpushed' };

  const stash = git(dir, ['stash', 'list']);
  if (stash === null) return { ok: false, reason: 'stash-unprovable' };
  if (stash !== '') return { ok: false, reason: 'stashed' };

  // A repository that backs linked worktrees owns an object store those
  // checkouts share; trashing it destroys their history, and nothing above
  // would notice because every check so far looks only at THIS tree.
  //
  // Codex review of #190: collectClones already asks cloneHasBoundWorktrees,
  // but only once, during the scan. That was survivable while any live
  // container in the group refused every clone under it; with that gate gone
  // a clone in a busy group is an ordinary candidate, and an agent running
  // `git worktree add` against it between the scan and the trash would not be
  // caught. Ask git's own registry instead of the filesystem sweep: every
  // linked worktree of a repo has an entry under <gitdir>/worktrees, so this
  // is one readdir, it is authoritative, and putting it HERE means it is
  // re-answered by the post-move re-proof rather than only at scan time.
  //
  // Only for scope 'all' (a clone). A linked worktree is itself an entry in
  // some other repo's registry and legitimately has none of its own.
  if (scope === 'all') {
    const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
    if (gitDir === null) return { ok: false, reason: 'gitdir-unprovable' };
    const registered = safeDirectories(path.join(gitDir, 'worktrees'));
    // null is "the directory exists but could not be read" — unprovable, not
    // empty. A repo with no linked worktrees simply has no such directory.
    if (registered === null && fs.existsSync(path.join(gitDir, 'worktrees'))) {
      return { ok: false, reason: 'worktree-registry-unprovable' };
    }
    if (registered !== null && registered.length > 0) return { ok: false, reason: 'backs-worktrees' };
  }

  return { ok: true, reason: 'clean-and-pushed' };
}

/** Directories with a real .git DIRECTORY. Symlinks are never candidates: a
 *  bedroom link such as agent/<name> -> workgroup/<name> is not a clone, and a
 *  container-absolute link dangles on the host. */
function isPrivateClone(dir: string): boolean {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    return fs.lstatSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A checkout whose `.git` is a FILE pointing somewhere this host cannot follow
 * — in practice `gitdir: /workspace/...`, a path that only resolves inside the
 * container that made it.
 *
 * #190 constraint 3: roughly 42 of these exist and they are permanently
 * unprovable from the host, so they must never be removed. They already are
 * never removed, because isPrivateClone demands a real `.git` DIRECTORY — but
 * they were also silently invisible, which in the middle of a storage squeeze
 * reads as "nothing here" rather than "mass no host-side pass can ever
 * reclaim". Report them so the gap is legible, and stop walking their working
 * trees looking for nested repositories.
 */
function isUnprovableCheckout(dir: string): boolean {
  let pointer: string;
  try {
    const marker = fs.lstatSync(path.join(dir, '.git'));
    if (!marker.isFile() || marker.isSymbolicLink()) return false;
    pointer = fs.readFileSync(path.join(dir, '.git'), 'utf8').trim();
  } catch {
    return false;
  }
  if (!pointer.startsWith('gitdir:')) return false;
  const target = pointer.slice('gitdir:'.length).trim();
  const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
  return !fs.existsSync(resolved);
}

interface CloneScan {
  clones: string[];
  /** Checkouts bound to a git-dir this host cannot resolve. Never removable. */
  unprovable: string[];
}

function findClonesUnder(root: string, depth: number, found: CloneScan = { clones: [], unprovable: [] }): CloneScan {
  if (depth < 0) return found;
  for (const name of safeDirectories(root) ?? []) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = path.join(root, name);
    if (isPrivateClone(dir)) {
      found.clones.push(dir);
      continue; // Never descend into a repository looking for more repositories.
    }
    if (isUnprovableCheckout(dir)) {
      found.unprovable.push(dir);
      continue;
    }
    findClonesUnder(dir, depth - 1, found);
  }
  return found;
}

/**
 * Every host path a linked worktree is currently bound to, as an index of
 * gitdir prefixes. Removing a clone that still backs one of these orphans the
 * worktree, so a clone appearing here is not collectable. `unreadable` records
 * that at least one pointer could not be read at all, which makes every clone
 * unprovable rather than silently collectable.
 */
function boundGitDirs(dataDir: string): { pointers: string[]; unreadable: boolean } {
  const bases = ['v2-topics', 'v2-threads', 'v2-sessions', 'workgroups'].map((name) => path.join(dataDir, name));
  const pointers: string[] = [];
  let unreadable = false;
  const walk = (dir: string, depth: number): void => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((entry) => entry.name === '.git' && !entry.isSymbolicLink());
    if (dotGit?.isFile()) {
      try {
        const line = fs.readFileSync(path.join(dir, '.git'), 'utf8').trim();
        if (line.startsWith('gitdir:')) pointers.push(line.slice('gitdir:'.length).trim());
      } catch {
        unreadable = true;
      }
    }
    // A checkout's own contents hold no further bindings worth indexing, and
    // descending into one means walking its whole working tree on every pass.
    if (dotGit) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const base of bases) walk(base, 5);
  return { pointers, unreadable };
}

function cloneHasBoundWorktrees(cloneDir: string, index: { pointers: string[]; unreadable: boolean }): boolean {
  if (index.unreadable) return true;
  let canonical: string;
  try {
    canonical = fs.realpathSync(path.join(cloneDir, '.git'));
  } catch {
    return true; // Cannot prove nothing is bound.
  }
  return index.pointers.some((pointer) => {
    if (!path.isAbsolute(pointer)) return true;
    let resolved = pointer;
    try {
      resolved = fs.realpathSync(pointer);
    } catch {
      // A pointer that does not resolve on the host cannot be matched by
      // realpath; fall back to a textual prefix test on the raw value.
    }
    return resolved === canonical || resolved.startsWith(`${canonical}${path.sep}`);
  });
}

function record(report: GcReport, candidate: GcCandidate): void {
  report.examined += 1;
  report.candidates.push(candidate);
  if (candidate.collect) {
    report.collected += 1;
    report.reclaimableBytes[candidate.category] += candidate.bytes;
  } else {
    report.skips[candidate.reason] = (report.skips[candidate.reason] ?? 0) + 1;
  }
}

function collectOrphanTopics(report: GcReport, dataDir: string, owners: Map<string, TopicParticipant[]>): void {
  const topicsRoot = path.join(dataDir, 'v2-topics');
  const idleReclaimDays = topicIdleReclaimDays();
  for (const workgroupId of safeDirectories(topicsRoot) ?? []) {
    const workgroupDir = path.join(topicsRoot, workgroupId);
    for (const topic of safeDirectories(workgroupDir) ?? []) {
      const topicDir = path.join(workgroupDir, topic);
      const skip = (reason: string): void =>
        record(report, { category: 'orphan-topic', path: topicDir, collect: false, reason, bytes: 0 });

      const participants = owners.get(topicDir);
      // Side (a) — see sideAClear. Status alone is not enough even once it
      // passes: a closed session can still hold a processing claim or a
      // continuation, and `topicIsBusy` fails closed on anything unreadable.
      const { pass, viaIdle: collectedViaIdle } = sideAClear(participants, idleReclaimDays);
      if (!pass) {
        skip('topic-open');
        continue;
      }
      if (participants && topicIsBusy(participants, dataDir)) {
        skip('topic-busy');
        continue;
      }
      const worktreeRoot = path.join(topicDir, 'worktrees');
      // #203: topicDir's own mtime is not a signal of activity — any bulk
      // metadata touch on the parent (data/v2-topics/<workgroup>) bumps every
      // topic dir at once regardless of what's inside. Production evidence:
      // 360 topic dirs shared one 2-second mtime window from an unidentified
      // bulk op, which silently disabled this gate fleet-wide for 7 days.
      // `worktrees/` is the deeper, real-activity signal — branchMayBeRemoved
      // above already keys off this same depth rather than the topic dir.
      // Read idleDays from worktrees/ exclusively rather than
      // max(topicDir, worktrees): taking the max would still let a poisoned
      // (freshest) topicDir value win on the next bulk touch, reproducing
      // this exact bug. A missing/unstat-able worktrees/ hits idleDays'
      // stat-failure fallback (returns 0 = "brand new"), which still fails
      // closed here — it refuses collection, it does not grant a free pass.
      if (idleDays(worktreeRoot) < MINIMUM_IDLE_DAYS) {
        skip('recent');
        continue;
      }

      // The ONE safeDirectories call here that must not fall back to []. The
      // loop below is what proves every checkout under this topic disposable;
      // reading an unreadable root as empty leaves `refused` null and records
      // the whole topic as collectable on the strength of a directory nobody
      // could read. The discovery-side calls in this file may use `?? []`
      // because a missed candidate is a missed deletion; this one authorizes
      // one.
      const repos = safeDirectories(worktreeRoot);
      if (repos === null) {
        skip('worktrees-unreadable');
        continue;
      }
      let refused: string | null = null;
      for (const repo of repos) {
        const decision = provenDisposable(path.join(worktreeRoot, repo), 'head');
        if (!decision.ok) {
          refused = decision.reason;
          break;
        }
      }
      if (refused) {
        skip(refused);
        continue;
      }
      record(report, {
        category: 'orphan-topic',
        path: topicDir,
        collect: true,
        reason: collectedViaIdle ? 'idle-and-clean' : participants ? 'closed-and-clean' : 'orphaned-and-clean',
        bytes: dirSizeBytes(topicDir),
        idleSnapshot: collectedViaIdle
          ? participants!.map((p) => ({
              sessionId: p.sessionId,
              status: p.status,
              idleSince: p.idleSince,
              inboundMtimeMs: p.inboundMtimeMs,
            }))
          : undefined,
      });
    }
  }
}

function collectClones(
  report: GcReport,
  dataDir: string,
  groupsDir: string,
  bound: { pointers: string[]; unreadable: boolean },
): void {
  const candidates: Array<{ dir: string; folder: string | null; workgroupId: string | null }> = [];

  for (const folder of safeDirectories(groupsDir) ?? []) {
    const folderDir = path.join(groupsDir, folder);
    const scan = findClonesUnder(folderDir, CLONE_SCAN_DEPTH);
    for (const dir of scan.clones) candidates.push({ dir, folder, workgroupId: null });
    for (const dir of scan.unprovable) {
      record(report, { category: 'clone', path: dir, collect: false, reason: 'keep-unprovable', bytes: 0 });
    }
  }

  const workgroupsRoot = path.join(dataDir, 'workgroups');
  for (const workgroupId of safeDirectories(workgroupsRoot) ?? []) {
    const workgroupDir = path.join(workgroupsRoot, workgroupId);
    for (const name of safeDirectories(workgroupDir) ?? []) {
      if (RESERVED_WORKGROUP_DIRS.has(name) || name.startsWith('.')) continue;
      const dir = path.join(workgroupDir, name);
      if (isPrivateClone(dir)) candidates.push({ dir, folder: null, workgroupId });
    }
  }

  for (const candidate of candidates) {
    const skip = (reason: string): void =>
      record(report, { category: 'clone', path: candidate.dir, collect: false, reason, bytes: 0 });

    // #190: agent-group and workgroup liveness were the gates that made clone
    // reclaim unreachable. `groups/<folder>` is bind-mounted into every
    // container of that group, so a group with any running container refused
    // EVERY clone under it — and a QA group with a continuous cadence never
    // has a quiet moment. Neither gate says anything about THIS directory.
    // Apply mode decides that per path instead: mount relation plus a process
    // scan, re-verified after the quarantine rename. See stillDisposable.
    if (idleDays(candidate.dir) < CLONE_IDLE_RECLAIM_DAYS) {
      skip('recent');
      continue;
    }
    if (cloneHasBoundWorktrees(candidate.dir, bound)) {
      skip('bound-worktrees');
      continue;
    }
    const decision = provenDisposable(candidate.dir, 'all');
    if (!decision.ok) {
      skip(decision.reason);
      continue;
    }
    record(report, {
      category: 'clone',
      path: candidate.dir,
      collect: true,
      reason: 'clean-and-pushed',
      bytes: dirSizeBytes(candidate.dir),
    });
  }
}

/** Recoverable removal. `trash` is capped at 30 days by tmpfiles.d; `rm` is
 *  blocked by the deployed destructive guard and is never used here. */
function trashPath(target: string): void {
  execFileSync(TRASH_BIN, [target], { stdio: 'pipe', timeout: 120_000 });
}

/**
 * Translate a path as a process sees it into the host path it maps to.
 *
 * A containerized process's cwd resolves inside that container's mount
 * namespace: measured on this host, an agent container's runner reads
 * `/workspace/agent`, never the host directory it is bound from. A raw
 * readlink scan compared against host paths is therefore blind to exactly the
 * processes it exists to catch — 51 live container processes read as zero.
 * /proc/<pid>/mountinfo carries the mapping, one line per mount, whose fourth
 * field is the path WITHIN the source filesystem and whose fifth is the
 * mountpoint as that namespace sees it. Resolve through the longest matching
 * mountpoint.
 *
 * A mount whose root is unrelated to the host tree (a container's own
 * overlayfs, rooted at `/`) can translate into a host-looking path that is not
 * really one. That direction is safe: a spurious match refuses a candidate, it
 * never authorizes removing one. `null` means the mapping could not be read at
 * all, which is a visible process we failed to place — the caller refuses the
 * whole pass on it.
 */
/** Pure half of hostPathForProcessCwd, factored out so tests can drive it with
 *  a synthetic mountinfo body instead of real /proc access. */
/**
 * PRECONDITION, stated because it is an assumption and not a guarantee: the
 * fourth mountinfo field is a path within the SOURCE filesystem, so treating
 * it as host-absolute is only correct while the bind-mount sources live on the
 * filesystem mounted at `/`. That holds on this install (every mount resolves
 * to the same device), and is what makes `groups/<folder> -> /workspace/agent`
 * translate exactly.
 *
 * Where it does not hold — DATA_DIR or GROUPS_DIR on their own volume, a
 * common enough cloud layout — a translated path comes out relative to that
 * volume's root and simply fails to match any candidate. Codex review of #190
 * flagged this: the consequence is a MISS, not a spurious match, so the /proc
 * check quietly degrades to nothing rather than misfiring. It is defence in
 * depth either way — the git re-proof on the moved copy is what actually
 * stands between this and deleting live work — but a reader should not
 * mistake this function for a guarantee on an arbitrary host.
 */
function resolveHostPathFromMountinfo(raw: string, cwd: string): string | null {
  let best: { mountpoint: string; root: string } | null = null;
  for (const line of raw.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 5) continue;
    const root = fields[3];
    const mountpoint = fields[4];
    if (cwd !== mountpoint && !cwd.startsWith(`${mountpoint === '/' ? '' : mountpoint}${path.sep}`)) continue;
    if (!best || mountpoint.length > best.mountpoint.length) best = { mountpoint, root };
  }
  if (!best) return null;
  const suffix = cwd.slice(best.mountpoint === '/' ? 0 : best.mountpoint.length);
  return path.posix.join(best.root, suffix);
}

/**
 * `undefined` means the process is simply gone — it exited between the cwd
 * readlink and this read, so it holds nothing and the scan continues. `null`
 * is a real read failure on a process that still exists: a live process we
 * cannot place, which makes the caller refuse the whole pass.
 *
 * The distinction is load-bearing, not pedantry. Processes come and go
 * constantly on this host, so collapsing an exit into "unreadable" would let
 * any short-lived command abort an entire GC pass — intermittently, and
 * looking exactly like "the GC mysteriously reclaims nothing".
 */
function hostPathForProcessCwd(pid: string, cwd: string, procRoot: string): string | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(procRoot, pid, 'mountinfo'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    return null;
  }
  return resolveHostPathFromMountinfo(raw, cwd);
}

/**
 * Host paths that some currently running process is rooted in.
 *
 * #190 constraint 2: a git lock is not a liveness signal for these directories
 * (measured: 3 live sessions, 0 locks), so ask the process table directly.
 *
 * Boundary, stated because absence of a signal must never be read as absence
 * of a process: 282 of 390 pids on this host have an unreadable cwd — they are
 * root- and system-owned processes, which never hold an agent scratch clone as
 * their working directory. Every process that CAN hold one (container agents,
 * host shells running as the install user) is readable, and was observed to be
 * during the #190 audit. An unreadable pid contributes nothing rather than
 * failing the pass; a pid we can see but cannot place fails it.
 */
function liveProcessCwds(procRoot = '/proc'): string[] | null {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return null; // Cannot enumerate the process table at all.
  }
  const roots: string[] = [];
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
    } catch {
      continue; // Unreadable or exited between readdir and readlink.
    }
    if (!path.isAbsolute(cwd)) continue;
    const host = hostPathForProcessCwd(pid, cwd, procRoot);
    if (host === undefined) continue; // Exited mid-scan; it holds nothing.
    if (host === null) return null;
    // Both, not just the translation. A host process's cwd IS already a host
    // path, and for a mount on a separate device the fourth mountinfo field is
    // that filesystem's own root rather than a host-absolute path, which would
    // translate `/tmp/x` to `/x`. Keeping the raw value too means such a mount
    // can only ever add a spurious entry, never drop a real one — and a
    // spurious entry refuses a candidate rather than authorizing one.
    roots.push(cwd);
    if (host !== cwd) roots.push(host);
  }
  return roots;
}

/** True when a live process sits inside `target` (or on it). */
function processRootedIn(target: string, cwds: string[]): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return true; // A path we cannot resolve is a path we cannot clear.
  }
  return cwds.some((cwd) => cwd === resolved || cwd.startsWith(`${resolved}${path.sep}`));
}

/**
 * How a target relates to the bind mounts of running containers.
 *
 * - 'is-mount-source' — the target IS a mount source, or CONTAINS one.
 *   Removing it pulls the floor out from under a live container's mount.
 *   Never removable, on any evidence.
 * - 'inside-mount-source' — the target merely lives underneath a mount
 *   source. `groups/<folder>` is itself mounted into every container of that
 *   group, so EVERY scratch clone in an active group is permanently in this
 *   state; treating it as equivalent to the case above is what made clone
 *   reclaim unreachable in practice (#190). A container could touch such a
 *   path, but the idle + git proof is the evidence that it has not, and the
 *   quarantine rename plus post-move recheck is what closes the race.
 * - 'clear' — no overlap at all.
 */
type MountRelation = 'is-mount-source' | 'inside-mount-source' | 'clear';

function mountRelation(resolvedTarget: string, mounts: string[]): MountRelation {
  let relation: MountRelation = 'clear';
  for (const mount of mounts) {
    let source = mount;
    try {
      source = fs.realpathSync(mount);
    } catch {
      // Keep the raw value: a mount source that is gone from the host still
      // names the tree the container was given.
    }
    if (source === resolvedTarget || source.startsWith(`${resolvedTarget}${path.sep}`)) {
      return 'is-mount-source';
    }
    if (resolvedTarget.startsWith(`${source}${path.sep}`)) relation = 'inside-mount-source';
  }
  return relation;
}

function relationToMounts(target: string, mounts: string[]): MountRelation {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return 'is-mount-source'; // A path we cannot resolve is a path we cannot clear.
  }
  return mountRelation(resolved, mounts);
}

function overlapsAny(target: string, mounts: string[]): boolean {
  return relationToMounts(target, mounts) !== 'clear';
}

/**
 * Codex review finding on PR #182: a message can land, or a container spawn
 * can land its bind mount, in the window between stillDisposable's pre-move
 * recheck and the topic being fully trashed. Closed-path topics can't be
 * re-routed to (the router only ever opens a NEW session for a new thread
 * key), so this only matters for the idle-threshold path — an idle but
 * ACTIVE session still receives inbound.
 *
 * inbound admission bumps last_active BEFORE any spawn ever mounts anything
 * (session-manager.ts:911), so admission-before-the-move is always caught by
 * the recheck below, and admission-after-the-move finds the directory gone
 * and re-materializes a fresh checkout for the new message — nothing lost
 * either way. The move (renaming the directory out of its live path) is the
 * serialization point this relies on.
 *
 * `trash-cli`'s own restore (`trash-restore`) is interactive-only — it
 * prompts on stdin and picks by a list index, not scriptable for "restore
 * this exact item" (confirmed via `man trash-restore`). So the actual delete
 * is staged: rename into a same-filesystem quarantine dir first (an ordinary,
 * instantly-reversible rename), recheck, and only THEN hand the quarantined
 * copy to the real `trash` for its 30-day retention.
 */
/**
 * Roll a quarantined topic back toward its original path, repo by repo.
 *
 * Precondition: every topic reaching finalizeIdleCollection already passed
 * provenDisposable (clean, pushed, no stash) at scan time. So no interleaving
 * here can ever lose unrecoverable work — the only harms left are STUCK
 * STATES (a dangling canonical-repo registration, or a wedged create_worktree
 * on an empty root). Every branch below is designed to end in a state the
 * next spawn can build from.
 *
 * Naive whole-topic rename-back isn't safe: the spawn path does
 * `mkdirSync(<topic>/worktrees, {recursive:true})` (container-runner.ts:1746)
 * on its own, so a live container can already have recreated the destination
 * by the time we get here, and a bare rename would EEXIST. Reconcile per repo
 * instead: if the destination slot is absent, rename that repo back in place
 * (its registration is still valid there, so the checkout works immediately).
 * If the destination is already occupied (the agent beat us to it), keep the
 * live copy and trash the quarantined one — safe per the precondition above.
 * If anything couldn't be put back valid, prune every repo's canonical
 * registration afterward so nothing dangles against a missing path (pruning
 * a repo that WAS restored cleanly is a harmless no-op — its path exists).
 */
function reconcileQuarantine(candidate: GcCandidate, quarantinePath: string, dataDir: string): void {
  // Never let the recovery marker itself land back inside a restored topic.
  try {
    fs.rmSync(path.join(quarantinePath, QUARANTINE_META_FILE), { force: true });
  } catch {
    // Best-effort — a leftover marker is a leak, not a correctness issue.
  }
  const repos = (safeDirectories(path.join(quarantinePath, 'worktrees')) ?? []).filter(isRepositoryName);
  let stranded = repos.length === 0 && fs.existsSync(quarantinePath); // no per-repo split known — see fallback below

  if (repos.length > 0) {
    const destWorktrees = path.join(candidate.path, 'worktrees');
    fs.mkdirSync(destWorktrees, { recursive: true });
    for (const repo of repos) {
      const from = path.join(quarantinePath, 'worktrees', repo);
      const to = path.join(destWorktrees, repo);
      if (fs.existsSync(to)) {
        log.warn('Storage GC: idle-topic rollback found the destination already recreated; keeping the live copy', {
          repo,
          to,
        });
        stranded = true;
        // A locked copy restores, never trashes — leave it in quarantine
        // rather than destroy something explicitly marked "don't touch".
        if (isWorktreeLocked(from)) {
          log.warn('Storage GC: superseded quarantine repo copy is locked; leaving it in quarantine, not trashing', {
            repo,
            from,
          });
        } else {
          try {
            trashPath(from);
          } catch (err) {
            log.error('Storage GC: could not trash a superseded quarantine repo copy', { repo, from, err });
          }
        }
        continue;
      }
      try {
        fs.renameSync(from, to);
      } catch (err) {
        log.error('Storage GC: idle-topic rollback rename failed for one repo; trashing that copy instead', {
          repo,
          from,
          to,
          err,
        });
        stranded = true;
        try {
          trashPath(from);
        } catch (trashErr) {
          log.error('Storage GC: could not even trash the stranded quarantine repo copy', {
            repo,
            from,
            err: trashErr,
          });
        }
      }
    }
    // Best-effort tidy of the now-empty quarantine entry; a leftover here is
    // harmless (next reclaim pass or tmpfiles.d cleans it up regardless).
    try {
      fs.rmdirSync(path.join(quarantinePath, 'worktrees'));
      fs.rmdirSync(quarantinePath);
    } catch {
      // Non-empty (a repo copy got stranded above) or already gone — fine.
    }
  } else if (fs.existsSync(quarantinePath)) {
    // No repo split to reconcile — fall back to a whole-topic restore.
    try {
      fs.renameSync(quarantinePath, candidate.path);
      stranded = false;
    } catch (err) {
      log.error('Storage GC: idle-topic rollback rename failed; trashing the quarantined copy instead', {
        quarantinePath,
        original: candidate.path,
        err,
      });
      try {
        trashPath(quarantinePath);
      } catch (trashErr) {
        log.error('Storage GC: could not even trash the stranded quarantine copy', { quarantinePath, err: trashErr });
      }
    }
  }

  if (stranded) {
    const workgroupId = path.basename(path.dirname(candidate.path));
    for (const repo of safeDirectories(path.join(candidate.path, 'worktrees')) ?? []) {
      if (!isRepositoryName(repo)) continue;
      if (git(canonicalRepoDir(workgroupId, repo, dataDir), ['worktree', 'prune']) === null) {
        log.warn('Storage GC: git worktree prune failed after idle-topic rollback; may need a manual prune', {
          workgroupId,
          repo,
        });
      }
    }
  }
}

/** True if b is later than a — null on either side is never "later" than a real time. */
function laterThan(a: number | null, b: number | null): boolean {
  if (b === null) return false;
  if (a === null) return true;
  return b > a;
}

/** Durable record of canonical-repo prunes a trash is (or was) about to require.
 *  See #185: a crash between a successful trash and the prune loop that
 *  follows it would otherwise leave a dangling `.git/worktrees/<name>`
 *  registration with nothing to find it. */
const PENDING_PRUNE_FILE = '.gc-pending-prunes.json';

interface PendingPrune {
  workgroupId: string;
  repo: string;
}

function pendingPrunePath(dataDir: string): string {
  return path.join(dataDir, PENDING_PRUNE_FILE);
}

/** Best-effort — a journal read failure only costs the crash-recovery safety
 *  net for this pass; the prune loop that follows still runs regardless. */
function readPendingPrunes(dataDir: string): PendingPrune[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pendingPrunePath(dataDir), 'utf8'));
    return Array.isArray(raw) ? (raw as PendingPrune[]) : [];
  } catch {
    return [];
  }
}

/** Returns whether the write actually landed — callers that are about to
 *  trash something the journal is meant to protect must abort on `false`
 *  rather than proceed without a durable record (Codex P2). */
function writePendingPrunes(dataDir: string, entries: PendingPrune[]): boolean {
  const target = pendingPrunePath(dataDir);
  try {
    if (entries.length === 0) {
      fs.rmSync(target, { force: true });
    } else {
      // Codex P2: write-then-rename, not in-place — a failure partway
      // through (ENOSPC/EIO/kill) never touches `target`, so the existing
      // journal survives untouched instead of being left empty/truncated.
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, target);
    }
    return true;
  } catch (err) {
    log.warn('Storage GC: could not update the pending-prune journal', { err });
    return false;
  }
}

/**
 * Finish any per-repo prune left pending by a crash between a successful
 * trash and the deregistration loop that follows it (#185). Run once at the
 * start of every apply pass, same shape as recoverOrphanedQuarantine: retry,
 * and only clear an entry once `git worktree prune` actually succeeds — a
 * repeat failure just stays journaled for the next pass, exactly the
 * "may need a manual prune" state a non-crash prune failure already leaves.
 */
function runPendingPrunes(dataDir: string): void {
  const pending = readPendingPrunes(dataDir);
  if (pending.length === 0) return;
  const remaining = pending.filter(({ workgroupId, repo }) => {
    if (git(canonicalRepoDir(workgroupId, repo, dataDir), ['worktree', 'prune']) === null) {
      log.warn('Storage GC: pending prune still failing; retrying next pass', { workgroupId, repo });
      return true;
    }
    log.warn('Storage GC: completed a prune left pending by an interrupted pass', { workgroupId, repo });
    return false;
  });
  writePendingPrunes(dataDir, remaining);
}

/**
 * Put a quarantined clone back where it came from.
 *
 * Deliberately not reconcileQuarantine: that one reasons about a topic's
 * `worktrees/<repo>` split and prunes canonical registrations, none of which a
 * clone has. A clone is one directory, so its rollback is one rename. If the
 * destination reappeared while we held the copy, keep BOTH — leave the copy in
 * quarantine for a human. Trashing it would destroy the one thing we could not
 * prove disposable.
 */
/**
 * A clone's recovery marker lives BESIDE its quarantine entry, not inside it.
 *
 * Topics put the marker in the directory so it travels in the same atomic
 * rename (#184). A clone cannot: the post-move check is a git re-proof, and an
 * untracked marker file inside the tree would read as a dirty worktree and
 * abort every single collection. Deleting the marker after the rename instead
 * would strand any entry whose process died in the gap — a markerless entry is
 * exactly what recoverOrphanedQuarantine cannot identify.
 *
 * A sidecar keeps the ordering invariant by writing FIRST: a crash can leave a
 * marker with no entry, which is a stray file the next pass overwrites, but
 * never an entry with no marker. `safeDirectories` lists only directories, so
 * the sidecar is skipped by the recovery scan that walks the quarantine root.
 */
function cloneSidecarPath(quarantinePath: string): string {
  return `${quarantinePath}.meta.json`;
}

function restoreQuarantinedClone(originalPath: string, quarantinePath: string): void {
  // The sidecar is dropped LAST, and only once the entry it describes is gone
  // from quarantine. Deleting it up front looks harmless — the restore is
  // about to happen anyway — but both exits below can leave the entry on
  // disk, and an entry whose marker was already removed is precisely the
  // (entry, no marker) state cloneSidecarPath promises cannot occur:
  // recoverOrphanedQuarantine finds neither marker, logs "no readable
  // recovery metadata", and skips it on every future pass, forever.
  if (fs.existsSync(originalPath)) {
    log.warn('Storage GC: clone rollback found the destination recreated; leaving the copy in quarantine', {
      originalPath,
      quarantinePath,
    });
    return;
  }
  try {
    fs.renameSync(quarantinePath, originalPath);
  } catch (err) {
    log.error('Storage GC: clone rollback rename failed; the copy stays in quarantine', {
      originalPath,
      quarantinePath,
      err,
    });
    return; // Marker stays, so the next pass can still find its way home.
  }
  fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
}

/**
 * Quarantine-then-verify removal for a scratch clone.
 *
 * Clones previously went straight to `trashPath` while topics got the
 * quarantine treatment (#190 constraint 7). That gap matters more now, not
 * less: dropping the coarse agent-group-live gate means a clone can be
 * collected while its group has a live container, so the window between
 * deciding and deleting has to be closed by evidence rather than by refusing
 * the whole class.
 *
 * The rename is atomic and instant. Anything an agent writes afterwards lands
 * in the quarantined copy, where re-running the SAME git proof sees it: a new
 * file makes the tree dirty, a commit makes it unpushed. That is a stronger
 * post-move check than a timestamp, because it re-answers the actual question
 * ("is everything in here recoverable?") rather than a proxy for it.
 */
function finalizeCloneCollection(candidate: GcCandidate, dataDir: string): { ok: boolean; reason?: string } {
  const resolvedOriginal = fs.realpathSync(candidate.path);
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  const quarantinePath = path.join(quarantineRoot, `${path.basename(candidate.path)}-${Date.now()}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });

  // Sidecar BEFORE the rename — see cloneSidecarPath. Ordering is the whole
  // point: a crash here leaves a marker with no entry (harmless), never an
  // entry with no marker (unrecoverable).
  try {
    fs.writeFileSync(
      cloneSidecarPath(quarantinePath),
      JSON.stringify({ originalPath: candidate.path, category: 'clone' }),
    );
  } catch (err) {
    log.error('Storage GC: could not write clone quarantine metadata; leaving the clone in place', {
      path: candidate.path,
      err,
    });
    return { ok: false, reason: 'quarantine-meta-write-failed' };
  }
  try {
    fs.renameSync(candidate.path, quarantinePath);
  } catch (err) {
    // No entry was created, so drop the now-meaningless sidecar rather than
    // leaving the next recovery pass a marker pointing at a live directory.
    fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
    throw err;
  }

  const restore = (reason: string): { ok: boolean; reason: string } => {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    return { ok: false, reason };
  };

  const freshMounts = runningContainerMounts();
  if (freshMounts === null || mountRelation(resolvedOriginal, freshMounts) === 'is-mount-source') {
    return restore('aborted-late-mount');
  }
  const freshCwds = liveProcessCwds();
  if (freshCwds === null || processRootedIn(quarantinePath, freshCwds)) {
    return restore('aborted-late-activity');
  }
  // Re-prove the moved copy, not the original path: this is the check that
  // catches a write landing in the gap between the scan and now.
  const decision = provenDisposable(quarantinePath, 'all');
  if (!decision.ok) return restore(`aborted-${decision.reason}`);

  try {
    trashPath(quarantinePath);
  } catch (err) {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    throw err;
  }
  // Only once the entry is genuinely gone. A sidecar outliving its entry is
  // tidied by the next recovery pass, so dropping it here is housekeeping, not
  // a correctness step — and doing it BEFORE the trash would be the stranding
  // bug this sidecar exists to avoid.
  fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
  return { ok: true };
}

function finalizeIdleCollection(candidate: GcCandidate, dataDir: string): { ok: boolean; reason?: string } {
  const snapshot = candidate.idleSnapshot!;
  const resolvedOriginal = fs.realpathSync(candidate.path);
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  const quarantinePath = path.join(quarantineRoot, `${path.basename(candidate.path)}-${Date.now()}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });

  // #184: write the recovery marker INTO the topic dir BEFORE the rename that
  // creates the quarantine entry, so the marker travels with the directory in
  // the SAME renameSync — one atomic move, not two separate writes with a
  // crash window between them. A markerless quarantine entry is now
  // impossible: either the marker-bearing directory got renamed, or nothing
  // moved at all.
  try {
    fs.writeFileSync(path.join(candidate.path, QUARANTINE_META_FILE), JSON.stringify({ originalPath: candidate.path }));
  } catch (err) {
    log.error('Storage GC: could not write quarantine recovery metadata; leaving the topic in place', {
      path: candidate.path,
      err,
    });
    return { ok: false, reason: 'quarantine-meta-write-failed' };
  }
  fs.renameSync(candidate.path, quarantinePath);

  const freshMounts = runningContainerMounts();
  if (freshMounts === null || mountRelation(resolvedOriginal, freshMounts) !== 'clear') {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-late-activity' };
  }

  // Capture the repo list before trashing (quarantinePath won't exist to list
  // afterward).
  const repoListing = safeDirectories(path.join(quarantinePath, 'worktrees'));
  if (repoListing === null) {
    // A real read failure (EACCES/EIO), not "no worktrees" — treating it as
    // empty would prune nothing yet still trash the topic. Leave the entry in
    // quarantine untouched: recoverOrphanedQuarantine retries it next pass,
    // which is the safe default the quarantine design already gives for free.
    log.error('Storage GC: could not read the quarantined topic worktrees; leaving it in quarantine to retry', {
      quarantinePath,
    });
    return { ok: false, reason: 'quarantine-unreadable' };
  }
  const repos = repoListing.filter(isRepositoryName);
  const workgroupId = path.basename(path.dirname(candidate.path));

  // #183: the durable-write fence runs LAST, immediately before the
  // irreversible trash — not before freshMounts/repoListing above, which
  // themselves cost real wall-clock time (a docker inspect, a readdir). A
  // fence checked earlier leaves that whole span unguarded; checked here it
  // shrinks the residual admission-race window down to roughly the width of
  // the trashPath call itself. Codex P1 (round 5): sessionInventory failing
  // here is not evidence the topic is quiet — participantsByTopic collapses a
  // DB failure into an empty map, indistinguishable from "genuinely no
  // participants" unless checked directly first.
  if (sessionInventory() === null) {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-recheck-unavailable' };
  }
  const before = new Map(snapshot.map((p) => [p.sessionId, p]));
  const owner = participantsByTopic(dataDir).get(candidate.path);
  const activityAdvanced = (owner?.participants ?? []).some((p) => {
    const prior = before.get(p.sessionId);
    // Codex P1 (round 4): status/idleSince lag the real admission event —
    // writeSessionMessageLocked inserts into inbound.db and closes it BEFORE
    // it updates last_active (session-manager.ts:892-911), two separate
    // writes. Fence on the durable write itself instead of its lagging
    // index: inbound.db's mtime moves at the insert, not after. A file that
    // appeared, or whose mtime moved forward, or that stopped being statable
    // where it previously was — all count as new activity.
    const inboundMoved = laterThan(prior?.inboundMtimeMs ?? null, p.inboundMtimeMs);
    return !prior || prior.status !== p.status || Date.parse(p.idleSince) > Date.parse(prior.idleSince) || inboundMoved;
  });
  if (activityAdvanced) {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-late-activity' };
  }

  // #185: journal the prunes this trash is about to require BEFORE trashing,
  // so a crash between the trash succeeding and the loop below finishing
  // leaves a durable record instead of a silently dangling registration.
  // runPendingPrunes sweeps this at the start of the next apply pass.
  const priorPending = readPendingPrunes(dataDir);
  const journaled = writePendingPrunes(dataDir, [...priorPending, ...repos.map((repo) => ({ workgroupId, repo }))]);
  if (!journaled) {
    // Codex P2: a read-only dataDir or ENOSPC here must not fall through to
    // trashing anyway — that's exactly the crash-without-a-record window
    // this journal exists to close. Abort and leave the topic recoverable.
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-prune-journal-unwritable' };
  }

  // Genuinely clear — commit the delete FIRST. Prune runs only once that
  // succeeds (Codex P2): a trash failure below leaves every canonical
  // registration untouched, so the restored checkout stays usable.
  try {
    trashPath(quarantinePath);
  } catch (err) {
    // Restore the EXACT pre-attempt contents rather than filtering by
    // workgroupId/repo (Codex P2): a filter would also strip an unrelated
    // OLDER entry for the same workgroupId/repo left by a previous
    // interrupted pass, losing its retry record permanently. Nothing else
    // touches this file mid-pass, so priorPending is still accurate.
    writePendingPrunes(dataDir, priorPending);
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    throw err;
  }

  // Deregister each repo's linked worktree from its CANONICAL repo, so a
  // resumed thread's later create_worktree doesn't hit git's "already
  // checked out at <missing-path>" error against a stale registration. Safe
  // unconditionally: container-runner.ts's mount comment documents that
  // topic worktree registrations always use exact host paths on both sides
  // (no container-relative back-pointer can land in them), so `worktree
  // prune` only ever removes entries whose path is genuinely gone — which,
  // for this repo, is now true.
  for (const repo of repos) {
    if (git(canonicalRepoDir(workgroupId, repo, dataDir), ['worktree', 'prune']) === null) {
      log.warn('Storage GC: git worktree prune failed after idle collection; may need a manual prune', {
        workgroupId,
        repo,
      });
    } else {
      writePendingPrunes(
        dataDir,
        readPendingPrunes(dataDir).filter((e) => !(e.workgroupId === workgroupId && e.repo === repo)),
      );
    }
  }
  return { ok: true };
}

/**
 * Re-prove side (a) against live state immediately before removal.
 *
 * The scan snapshotted the inventory; a session can be created, or a container
 * started, while the pass is still walking. Anything unreadable at this point
 * refuses, exactly as it does during the scan.
 */
function stillDisposable(
  candidate: GcCandidate,
  dataDir: string,
  mounts: string[],
  cwds: string[],
): { ok: boolean; reason: string } {
  if (candidate.category === 'clone') {
    // A clone under an active group is ALWAYS inside a mount source, so only
    // the strong relation can refuse here (#190). What stands in for the
    // coarse gate: no process is actually rooted in this directory, and the
    // git proof from the scan is re-run below after the quarantine rename.
    if (relationToMounts(candidate.path, mounts) === 'is-mount-source') {
      return { ok: false, reason: 'container-mounted' };
    }
    if (processRootedIn(candidate.path, cwds)) return { ok: false, reason: 'process-rooted' };
    if (sessionInventory() === null) return { ok: false, reason: 'recheck-failed' };
    return { ok: true, reason: 'recheck-clear' };
  }
  if (overlapsAny(candidate.path, mounts)) return { ok: false, reason: 'container-mounted' };
  const rows = sessionInventory();
  if (rows === null) return { ok: false, reason: 'recheck-failed' };
  const owner = participantsByTopic(dataDir).get(candidate.path);
  if (!sideAClear(owner?.participants, topicIdleReclaimDays()).pass) {
    return { ok: false, reason: 'recheck-topic-open' };
  }
  if (owner && topicIsBusy(owner.participants, dataDir)) return { ok: false, reason: 'recheck-topic-busy' };
  return { ok: true, reason: 'recheck-clear' };
}

/**
 * Codex P2 (round 5): if the process dies between the quarantine rename and
 * either restore or trash, the topic is stuck under .gc-quarantine forever —
 * collectOrphanTopics only ever walks v2-topics. Run once at the start of
 * every apply pass. prune only ever runs post-trash now, so any entry found
 * here is still in the pre-trash state: either restorable outright, or (if a
 * spawn recreated the destination while we were down) reconcilable exactly
 * like a live rollback.
 */
function recoverOrphanedQuarantine(dataDir: string, report: GcReport): void {
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  for (const entry of safeDirectories(quarantineRoot) ?? []) {
    const quarantinePath = path.join(quarantineRoot, entry);
    let originalPath: string;
    let category: GcCategory;
    try {
      // A clone's marker sits beside the entry (see cloneSidecarPath); a
      // topic's travels inside it. Prefer the sidecar so a clone is never
      // misread as a topic and put through the per-repo prune path.
      const sidecar = cloneSidecarPath(quarantinePath);
      const metaFile = fs.existsSync(sidecar) ? sidecar : path.join(quarantinePath, QUARANTINE_META_FILE);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
        originalPath: string;
        category?: GcCategory;
      };
      originalPath = meta.originalPath;
      // Entries written before clones used quarantine carry no category, and
      // every one of those is a topic.
      category = meta.category ?? 'orphan-topic';
    } catch (err) {
      log.error('Storage GC: orphaned quarantine entry has no readable recovery metadata; leaving it as-is', {
        quarantinePath,
        err,
      });
      continue;
    }
    if (category === 'clone') {
      // A clone's rollback is a plain rename; reconcileQuarantine's per-repo
      // split and canonical prune would be meaningless here and its
      // `isRepositoryName` filter could misread a coincidental `worktrees`
      // directory inside the clone's own tree.
      restoreQuarantinedClone(originalPath, quarantinePath);
      log.warn('Storage GC: restored an orphaned clone quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'clone',
        path: originalPath,
        collect: false,
        reason: 'quarantine-restored',
        bytes: 0,
      });
      continue;
    }
    const placeholder: GcCandidate = {
      category: 'orphan-topic',
      path: originalPath,
      collect: false,
      reason: '',
      bytes: 0,
    };
    if (fs.existsSync(originalPath)) {
      // A spawn recreated the destination while the process was down —
      // reconcile exactly like a live rollback (per-repo, conditional prune).
      reconcileQuarantine(placeholder, quarantinePath, dataDir);
      log.warn('Storage GC: reconciled an orphaned quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'orphan-topic',
        path: originalPath,
        collect: false,
        reason: 'quarantine-reconciled',
        bytes: 0,
      });
      continue;
    }
    try {
      fs.rmSync(path.join(quarantinePath, QUARANTINE_META_FILE), { force: true });
      fs.renameSync(quarantinePath, originalPath);
      log.warn('Storage GC: restored an orphaned quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'orphan-topic',
        path: originalPath,
        collect: false,
        reason: 'quarantine-recovered',
        bytes: 0,
      });
    } catch (err) {
      log.error('Storage GC: could not restore an orphaned quarantine entry; leaving it in quarantine', {
        originalPath,
        quarantinePath,
        err,
      });
    }
  }
  try {
    fs.rmdirSync(quarantineRoot); // only succeeds once genuinely empty
  } catch {
    // Non-empty (something is still stranded, already logged above) or
    // never existed — either way, nothing further to do here.
  }
}

export function runStorageGcOnce(dataDir: string = DATA_DIR, groupsDir: string = GROUPS_DIR): GcReport {
  const mode = gcMode();
  const rows = sessionInventory();
  if (rows === null) {
    const report = emptyReport(mode, false);
    log.error('Storage GC: did not run — session inventory unavailable, nothing evaluated', {
      mode,
    });
    return report;
  }

  const report = emptyReport(mode, true);
  if (mode === 'apply') {
    recoverOrphanedQuarantine(dataDir, report);
    runPendingPrunes(dataDir);
  }
  const owners = new Map([...participantsByTopic(dataDir)].map(([key, value]) => [key, value.participants] as const));
  collectOrphanTopics(report, dataDir, owners);
  collectClones(report, dataDir, groupsDir, boundGitDirs(dataDir));

  if (mode === 'apply') {
    const demote = (candidate: GcCandidate, reason: string): void => {
      candidate.collect = false;
      candidate.reason = reason;
      report.collected -= 1;
      report.reclaimableBytes[candidate.category] -= candidate.bytes;
      report.skips[reason] = (report.skips[reason] ?? 0) + 1;
    };
    const mounts = runningContainerMounts();
    const cwds = liveProcessCwds();
    if (mounts === null || cwds === null) {
      log.error('Storage GC: liveness unreadable — removing nothing this pass', {
        mode,
        runtimeUnreadable: mounts === null,
        processTableUnreadable: cwds === null,
      });
      for (const candidate of report.candidates.filter((c) => c.collect)) {
        demote(candidate, mounts === null ? 'runtime-unreadable' : 'process-table-unreadable');
      }
    } else {
      for (const candidate of report.candidates) {
        if (!candidate.collect) continue;
        const recheck = stillDisposable(candidate, dataDir, mounts, cwds);
        if (!recheck.ok) {
          demote(candidate, recheck.reason);
          continue;
        }
        try {
          if (candidate.category === 'clone') {
            const finalized = finalizeCloneCollection(candidate, dataDir);
            if (!finalized.ok) {
              demote(candidate, finalized.reason!);
              continue;
            }
          } else if (candidate.idleSnapshot) {
            const finalized = finalizeIdleCollection(candidate, dataDir);
            if (!finalized.ok) {
              demote(candidate, finalized.reason!);
              continue;
            }
          } else {
            trashPath(candidate.path);
          }
          log.info('Storage GC: collected', { path: candidate.path, category: candidate.category });
        } catch (error) {
          demote(candidate, 'trash-failed');
          log.error('Storage GC: removal failed', { path: candidate.path, error });
        }
      }
    }
  }

  log.info('Storage GC: ran', {
    mode,
    examined: report.examined,
    collected: report.collected,
    reclaimableBytes: report.reclaimableBytes,
    skips: report.skips,
  });
  return report;
}

export function _discoverWorktreesForTesting(dataDir: string = DATA_DIR): TopicWorktreeTarget[] {
  return discover(dataDir).targets;
}

export function _discoveryStatsForTesting(dataDir: string = DATA_DIR): DiscoveryResult {
  return discover(dataDir);
}

export async function _cleanupOneForTesting(target: TopicWorktreeTarget, dataDir: string = DATA_DIR): Promise<void> {
  await cleanupOne(target, dataDir);
}

export function _hostPathForProcessCwdForTesting(mountinfoText: string, cwd: string): string | null {
  return resolveHostPathFromMountinfo(mountinfoText, cwd);
}

/** Scan a fake /proc tree, so the exit-vs-unreadable split can be exercised. */
export function _liveProcessCwdsForTesting(procRoot: string): string[] | null {
  return liveProcessCwds(procRoot);
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startWorktreeCleanup(): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    void runWorktreeCleanupOnce().catch((err) => log.error('Worktree cleanup: startup run failed', { err }));
  }, STARTUP_DELAY_MS);
  intervalHandle = setInterval(() => {
    void runWorktreeCleanupOnce().catch((err) => log.error('Worktree cleanup: periodic run failed', { err }));
  }, CLEANUP_INTERVAL_MS);
}

export function stopWorktreeCleanup(): void {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
}
