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
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
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
 * Positive proof that a checkout holds nothing worth keeping.
 *
 * `scope` is 'head' for a linked worktree (its branch is the only one it owns)
 * and 'all' for a clone, which owns every local branch in it. A git invocation
 * that fails — the usual cause is a pruned worktree admin directory or a gitdir
 * only resolvable inside a container — returns unprovable, never clean.
 */
function provenDisposable(dir: string, scope: 'head' | 'all'): { ok: boolean; reason: string } {
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

function findClonesUnder(root: string, depth: number, found: string[] = []): string[] {
  if (depth < 0) return found;
  for (const name of safeDirectories(root) ?? []) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = path.join(root, name);
    if (isPrivateClone(dir)) {
      found.push(dir);
      continue; // Never descend into a repository looking for more repositories.
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

interface LiveScopes {
  folders: Set<string>;
  workgroups: Set<string>;
}

function liveScopes(rows: SessionRow[]): LiveScopes {
  const folders = new Set<string>();
  const workgroups = new Set<string>();
  for (const row of rows) {
    if (!isContainerRunning(row.session_id) && !isContainerSpawning(row.session_id)) continue;
    folders.add(row.folder);
    workgroups.add(row.workgroup_id);
  }
  return { folders, workgroups };
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
      if (idleDays(topicDir) < MINIMUM_IDLE_DAYS) {
        skip('recent');
        continue;
      }

      const worktreeRoot = path.join(topicDir, 'worktrees');
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
  live: LiveScopes,
  bound: { pointers: string[]; unreadable: boolean },
): void {
  const candidates: Array<{ dir: string; folder: string | null; workgroupId: string | null }> = [];

  for (const folder of safeDirectories(groupsDir) ?? []) {
    const folderDir = path.join(groupsDir, folder);
    for (const dir of findClonesUnder(folderDir, CLONE_SCAN_DEPTH)) {
      candidates.push({ dir, folder, workgroupId: null });
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

    if (candidate.folder && live.folders.has(candidate.folder)) {
      skip('agent-group-live');
      continue;
    }
    if (candidate.workgroupId && live.workgroups.has(candidate.workgroupId)) {
      skip('workgroup-live');
      continue;
    }
    if (idleDays(candidate.dir) < MINIMUM_IDLE_DAYS) {
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
 * Every host path bind-mounted into a currently running container.
 *
 * `isContainerRunning` reads this process's own bookkeeping, which is empty in
 * any out-of-process caller and says nothing about a container started by
 * someone else. Before removing anything, apply mode asks the runtime directly.
 * `null` means the runtime could not be listed, and a container we cannot see
 * is a container we must assume owns the path.
 */
function runningContainerMounts(): string[] | null {
  try {
    const ids = execFileSync(CONTAINER_RUNTIME_BIN, ['ps', '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{range .Mounts}}{{.Source}}\n{{end}}', ...ids],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return inspected
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function pathOverlapsResolvedMounts(resolvedTarget: string, mounts: string[]): boolean {
  return mounts.some((mount) => {
    let source = mount;
    try {
      source = fs.realpathSync(mount);
    } catch {
      // Keep the raw value: a mount source that is gone from the host still
      // names the tree the container was given.
    }
    return (
      source === resolvedTarget ||
      source.startsWith(`${resolvedTarget}${path.sep}`) ||
      resolvedTarget.startsWith(`${source}${path.sep}`)
    );
  });
}

function overlapsAny(target: string, mounts: string[]): boolean {
  let resolved = target;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return true; // A path we cannot resolve is a path we cannot clear.
  }
  return pathOverlapsResolvedMounts(resolved, mounts);
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
        try {
          trashPath(from);
        } catch (err) {
          log.error('Storage GC: could not trash a superseded quarantine repo copy', { repo, from, err });
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

function finalizeIdleCollection(candidate: GcCandidate, dataDir: string): { ok: boolean; reason?: string } {
  const snapshot = candidate.idleSnapshot!;
  const resolvedOriginal = fs.realpathSync(candidate.path);
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  const quarantinePath = path.join(quarantineRoot, `${path.basename(candidate.path)}-${Date.now()}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });
  fs.renameSync(candidate.path, quarantinePath);
  // Crash recovery (Codex P2, round 5): if the process dies before this
  // function reaches restore or trash, this is the only record of where the
  // topic came from. recoverOrphanedQuarantine reads it at the next pass.
  try {
    fs.writeFileSync(path.join(quarantinePath, QUARANTINE_META_FILE), JSON.stringify({ originalPath: candidate.path }));
  } catch (err) {
    log.warn('Storage GC: could not write quarantine recovery metadata', { quarantinePath, err });
  }

  // Codex P1 (round 5): sessionInventory failing here is not evidence the
  // topic is quiet — participantsByTopic collapses a DB failure into an empty
  // map, indistinguishable from "genuinely no participants" unless checked
  // directly first. Same principle participantsByTopic's own doc comment
  // already states: a failed inventory preserves, never deletes.
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
    // where it previously was — all count as new activity. Nothing durable
    // happens after this file changes, so there is no remaining window.
    const inboundMoved = laterThan(prior?.inboundMtimeMs ?? null, p.inboundMtimeMs);
    return !prior || prior.status !== p.status || Date.parse(p.idleSince) > Date.parse(prior.idleSince) || inboundMoved;
  });
  if (activityAdvanced) {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-late-activity' };
  }

  const freshMounts = runningContainerMounts();
  if (freshMounts === null || pathOverlapsResolvedMounts(resolvedOriginal, freshMounts)) {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-late-activity' };
  }

  // Genuinely clear — capture the repo list before trashing (quarantinePath
  // won't exist to list afterward), then commit the delete FIRST. Prune runs
  // only once that succeeds (Codex P2): a trash failure below leaves every
  // canonical registration untouched, so the restored checkout stays usable.
  const repos = (safeDirectories(path.join(quarantinePath, 'worktrees')) ?? []).filter(isRepositoryName);
  try {
    trashPath(quarantinePath);
  } catch (err) {
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
  const workgroupId = path.basename(path.dirname(candidate.path));
  for (const repo of repos) {
    if (git(canonicalRepoDir(workgroupId, repo, dataDir), ['worktree', 'prune']) === null) {
      log.warn('Storage GC: git worktree prune failed after idle collection; may need a manual prune', {
        workgroupId,
        repo,
      });
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
function stillDisposable(candidate: GcCandidate, dataDir: string, mounts: string[]): { ok: boolean; reason: string } {
  if (overlapsAny(candidate.path, mounts)) return { ok: false, reason: 'container-mounted' };
  const rows = sessionInventory();
  if (rows === null) return { ok: false, reason: 'recheck-failed' };
  if (candidate.category === 'clone') {
    const live = liveScopes(rows);
    const relative = path.relative(GROUPS_DIR, candidate.path);
    const folder = relative.startsWith('..') ? null : relative.split(path.sep)[0];
    if (folder && live.folders.has(folder)) return { ok: false, reason: 'recheck-agent-group-live' };
    const workgroupRelative = path.relative(path.join(dataDir, 'workgroups'), candidate.path);
    const workgroupId = workgroupRelative.startsWith('..') ? null : workgroupRelative.split(path.sep)[0];
    if (workgroupId && live.workgroups.has(workgroupId)) return { ok: false, reason: 'recheck-workgroup-live' };
    return { ok: true, reason: 'recheck-clear' };
  }
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
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(quarantinePath, QUARANTINE_META_FILE), 'utf8')) as {
        originalPath: string;
      };
      originalPath = meta.originalPath;
    } catch (err) {
      log.error('Storage GC: orphaned quarantine entry has no readable recovery metadata; leaving it as-is', {
        quarantinePath,
        err,
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
  if (mode === 'apply') recoverOrphanedQuarantine(dataDir, report);
  const owners = new Map([...participantsByTopic(dataDir)].map(([key, value]) => [key, value.participants] as const));
  collectOrphanTopics(report, dataDir, owners);
  collectClones(report, dataDir, groupsDir, liveScopes(rows), boundGitDirs(dataDir));

  if (mode === 'apply') {
    const demote = (candidate: GcCandidate, reason: string): void => {
      candidate.collect = false;
      candidate.reason = reason;
      report.collected -= 1;
      report.reclaimableBytes[candidate.category] -= candidate.bytes;
      report.skips[reason] = (report.skips[reason] ?? 0) + 1;
    };
    const mounts = runningContainerMounts();
    if (mounts === null) {
      log.error('Storage GC: container runtime unreadable — removing nothing this pass', { mode });
      for (const candidate of report.candidates.filter((c) => c.collect)) {
        demote(candidate, 'runtime-unreadable');
      }
    } else {
      for (const candidate of report.candidates) {
        if (!candidate.collect) continue;
        const recheck = stillDisposable(candidate, dataDir, mounts);
        if (!recheck.ok) {
          demote(candidate, recheck.reason);
          continue;
        }
        try {
          if (candidate.idleSnapshot) {
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
