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

import { DATA_DIR } from './config.js';
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
import { openOutboundDb } from './session-manager.js';
import { safeGitArgs, safeGitEnv } from './safe-git.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const MINIMUM_IDLE_DAYS = 7;
const STALE_WARNING_DAYS = 30;

interface TopicParticipant {
  sessionId: string;
  agentGroupId: string;
  status: string;
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
  workgroup_id: string;
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

function participantsByTopic(
  dataDir: string,
): Map<string, { unit: RepositoryWorkUnit; participants: TopicParticipant[] }> {
  let rows: SessionRow[];
  try {
    rows = getDb()
      .prepare(
        `SELECT s.id AS session_id, s.agent_group_id, s.status, s.thread_id,
                s.messaging_group_id, mg.platform_id,
                COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
           LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
      )
      .all() as SessionRow[];
  } catch (err) {
    log.error('Worktree cleanup: session inventory failed; preserving every topic', { err });
    return new Map();
  }

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

function participantHasPersistedWork(participant: TopicParticipant): boolean {
  // Session status is not proof that persisted work has completed. A
  // continuation, processing claim, or current tool can survive a transition
  // to inactive and must independently retain the shared topic worktree.
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

function topicIsBusy(participants: TopicParticipant[]): boolean {
  if (participants.length === 0) return true;
  return participants.some(
    (participant) =>
      isContainerRunning(participant.sessionId) ||
      isContainerSpawning(participant.sessionId) ||
      participantHasPersistedWork(participant),
  );
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
  if (topicIsBusy(target.participants)) return;
  if (transferReferencesPath(target, dataDir)) return;

  await withRepositoryLifecycleClaims([target.workUnit], () =>
    withHostRepositoryLock(
      target.workUnit.workgroupId,
      target.repo,
      () => {
        if (topicIsBusy(target.participants) || transferReferencesPath(target, dataDir)) return;
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
