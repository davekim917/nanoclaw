/**
 * Per-thread worktree cleanup cron (Phase 2.11) — host-side GC.
 *
 * Walks both worktree layouts:
 * - data/v2-sessions/<agId>/<sessionId>/worktrees/<repo>/
 * - data/v2-threads/<threadKey>/worktrees/<repo>/
 *
 * Removes worktrees whose branch has been merged on GitHub or whose
 * remote branch has been deleted. Skips dirty, unpushed, and detached
 * HEAD worktrees — those are in-flight agent work.
 *
 * Adapted from v1's src/worktree-cleanup.ts (which iterated
 * data/worktrees/<group>/<threadId>/<repo>/). Key v2 adjustments:
 *
 * - No withGroupMutex. v2 containers are per-session, so the only
 *   concurrency concern is an active container mid-git operation on
 *   the very worktree we're about to remove. Guarded by
 *   isContainerRunning(sessionId) — if the session has a live
 *   container, we skip its worktrees this cycle.
 * - Canonical repo lives at groups/<folder>/<repo>/ (same as v1).
 *   Looked up via the session's agent_group_id.
 * - `gh pr list --head <branch>` runs on the host — uses whatever
 *   gh auth the host has (Operator's shell gh config). If the host has
 *   no gh auth, the merged-check returns false and we fall back to
 *   the "branch gone on origin" heuristic.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { isContainerRunning } from './container-runner.js';
import { getDb } from './db/connection.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { threadWorktreeDir } from './session-manager.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const STALE_WARNING_DAYS = 30;
// Detached HEAD with clean tree + everything pushed is safe to evict
// (create_worktree on resume re-checks out off origin/HEAD). Wait this many
// days idle before evicting so brief pauses don't trigger churn.
const IDLE_DETACHED_EVICT_DAYS = 7;

function execSafe(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isDirty(worktreePath: string): boolean | null {
  const out = execSafe('git status --porcelain', worktreePath);
  if (out === null) return null;
  return out.length > 0;
}

function hasUnpushedCommits(worktreePath: string): boolean | null {
  const out = execSafe('git log HEAD --not --remotes --oneline', worktreePath);
  if (out === null) return null;
  return out.length > 0;
}

function getBranchName(worktreePath: string): string | null {
  return execSafe('git rev-parse --abbrev-ref HEAD', worktreePath);
}

function isPRMerged(branch: string, worktreePath: string): boolean {
  const out = execSafe(`gh pr list --head ${branch} --state merged --json number --limit 1`, worktreePath);
  if (out === null) return false;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function isBranchDeletedOnRemote(branch: string, worktreePath: string): boolean {
  const out = execSafe(`git ls-remote --heads origin ${branch}`, worktreePath);
  return out !== null && out.length === 0;
}

function getLastModifiedDays(worktreePath: string): number {
  try {
    const stat = fs.statSync(worktreePath);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch {
    return 0;
  }
}

/** Mirror-topology checkouts are standalone clones — their .git is a directory. */
function isStandaloneClone(worktreePath: string): boolean {
  try {
    return fs.statSync(path.join(worktreePath, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function removeWorktree(canonicalRepoPath: string, worktreePath: string): void {
  if (isStandaloneClone(worktreePath)) {
    // Self-contained metadata — nothing to detach from a canonical.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    return;
  }
  execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: canonicalRepoPath,
    stdio: 'pipe',
  });
  execFileSync('git', ['worktree', 'prune'], {
    cwd: canonicalRepoPath,
    stdio: 'pipe',
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface WorktreeTarget {
  scope: 'session' | 'thread';
  agentGroupId: string;
  sessionId: string;
  sessionIds: string[];
  repo: string;
  worktreePath: string;
  canonicalRepoPath: string;
  graphifyCachePath: string;
}

export interface OrphanGraphifyCacheTarget {
  scope: 'session' | 'thread';
  agentGroupId: string;
  sessionId: string;
  sessionIds: string[];
  repo: string;
  worktreePath: string;
  graphifyCachePath: string;
}

function discoverWorktrees(): WorktreeTarget[] {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  const results: WorktreeTarget[] = [];

  if (fs.existsSync(sessionsRoot)) {
    for (const agentGroupId of safeReaddir(sessionsRoot)) {
      const ag = getAgentGroup(agentGroupId);
      if (!ag) continue;
      const canonicalBase = path.join(GROUPS_DIR, ag.folder);
      const agDir = path.join(sessionsRoot, agentGroupId);

      for (const entry of safeReaddir(agDir)) {
        // Skip overlay dirs that aren't session dirs.
        if (entry === 'agent-runner-src' || entry === '.claude-shared') continue;
        const worktreesDir = path.join(agDir, entry, 'worktrees');
        if (!fs.existsSync(worktreesDir)) continue;
        for (const repo of safeReaddir(worktreesDir)) {
          results.push({
            scope: 'session',
            agentGroupId,
            sessionId: entry,
            sessionIds: [entry],
            repo,
            worktreePath: path.join(worktreesDir, repo),
            canonicalRepoPath: path.join(canonicalBase, repo),
            graphifyCachePath: path.join(agDir, entry, 'graphify-cache', repo),
          });
        }
      }
    }
  }

  results.push(...discoverThreadWorktrees());
  return results;
}

interface ThreadParticipant {
  sessionId: string;
  agentGroupId: string;
  worktreeDir: string;
}

function discoverThreadParticipantsByDir(): Map<string, ThreadParticipant[]> {
  let rows: Array<{
    session_id: string;
    agent_group_id: string;
    thread_id: string | null;
    platform_id: string;
    wg: string;
  }>;
  try {
    rows = getDb()
      .prepare(
        `SELECT s.id AS session_id, s.agent_group_id, s.thread_id, mg.platform_id,
                COALESCE(ag.workgroup_id, ag.folder) AS wg
           FROM sessions s
           JOIN messaging_groups mg ON mg.id = s.messaging_group_id
           JOIN agent_groups ag ON ag.id = s.agent_group_id
          WHERE s.status = 'active' AND s.messaging_group_id IS NOT NULL`,
      )
      .all() as typeof rows;
  } catch (err) {
    log.warn('Worktree cleanup: failed to discover thread worktrees', { err });
    return new Map();
  }

  const participantsByDir = new Map<string, ThreadParticipant[]>();
  for (const row of rows) {
    const worktreeDir = threadWorktreeDir(row.platform_id, row.thread_id, row.wg);
    const participants = participantsByDir.get(worktreeDir) ?? [];
    participants.push({
      sessionId: row.session_id,
      agentGroupId: row.agent_group_id,
      worktreeDir,
    });
    participantsByDir.set(worktreeDir, participants);
  }

  return participantsByDir;
}

function discoverThreadWorktrees(): WorktreeTarget[] {
  const participantsByDir = discoverThreadParticipantsByDir();

  const results: WorktreeTarget[] = [];
  for (const [worktreeDir, participants] of participantsByDir) {
    if (participants.length === 0 || !fs.existsSync(worktreeDir)) continue;

    for (const repo of safeReaddir(worktreeDir)) {
      const canonicalRepoPath = resolveCanonicalRepoPath(repo, participants);
      if (!canonicalRepoPath) continue;
      const primary = participants[0]!;
      results.push({
        scope: 'thread',
        agentGroupId: primary.agentGroupId,
        sessionId: primary.sessionId,
        sessionIds: participants.map((p) => p.sessionId),
        repo,
        worktreePath: path.join(worktreeDir, repo),
        canonicalRepoPath,
        graphifyCachePath: path.join(path.dirname(worktreeDir), 'graphify-cache', repo),
      });
    }
  }
  return results;
}

function resolveCanonicalRepoPath(repo: string, participants: ThreadParticipant[]): string | null {
  let fallback: string | null = null;
  for (const participant of participants) {
    const ag = getAgentGroup(participant.agentGroupId);
    if (!ag) continue;
    const candidate = path.join(GROUPS_DIR, ag.folder, repo);
    fallback ??= candidate;
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
  }
  return fallback;
}

function discoverOrphanGraphifyCaches(): OrphanGraphifyCacheTarget[] {
  const results: OrphanGraphifyCacheTarget[] = [];
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');

  if (fs.existsSync(sessionsRoot)) {
    for (const agentGroupId of safeReaddir(sessionsRoot)) {
      const ag = getAgentGroup(agentGroupId);
      if (!ag) continue;
      const agDir = path.join(sessionsRoot, agentGroupId);
      for (const sessionId of safeReaddir(agDir)) {
        if (sessionId === 'agent-runner-src' || sessionId === '.claude-shared') continue;
        const sessionRoot = path.join(agDir, sessionId);
        const cacheRoot = path.join(sessionRoot, 'graphify-cache');
        for (const repo of safeReaddir(cacheRoot)) {
          const worktreePath = path.join(sessionRoot, 'worktrees', repo);
          if (fs.existsSync(worktreePath)) continue;
          results.push({
            scope: 'session',
            agentGroupId,
            sessionId,
            sessionIds: [sessionId],
            repo,
            worktreePath,
            graphifyCachePath: path.join(cacheRoot, repo),
          });
        }
      }
    }
  }

  for (const [worktreeDir, participants] of discoverThreadParticipantsByDir()) {
    if (participants.length === 0) continue;
    const cacheRoot = path.join(path.dirname(worktreeDir), 'graphify-cache');
    const primary = participants[0]!;
    for (const repo of safeReaddir(cacheRoot)) {
      const worktreePath = path.join(worktreeDir, repo);
      if (fs.existsSync(worktreePath)) continue;
      results.push({
        scope: 'thread',
        agentGroupId: primary.agentGroupId,
        sessionId: primary.sessionId,
        sessionIds: participants.map((participant) => participant.sessionId),
        repo,
        worktreePath,
        graphifyCachePath: path.join(cacheRoot, repo),
      });
    }
  }

  return results;
}

function preserveForParticipantGuard(
  target: Pick<WorktreeTarget, 'scope' | 'agentGroupId' | 'sessionId' | 'sessionIds' | 'repo'>,
): boolean {
  const { scope, agentGroupId, sessionId, sessionIds, repo } = target;
  const ctx = { scope, agentGroupId, sessionId, repo };
  const liveStates = sessionIds.map((id) => ({ id, running: isContainerRunning(id) }));
  if (liveStates.some(({ running }) => running)) {
    log.debug('Worktree cleanup: skipping target with live container', { ...ctx, sessionIds });
    return true;
  }

  // Preserve the existing conservative DB rule: an entirely unknown mapping
  // is never enough authority to delete worktree or cache state.
  const hasKnownSession = sessionIds.some((id) => Boolean(getSession(id)));
  if (!hasKnownSession) {
    log.debug('Worktree cleanup: no mapped session in DB, skipping', { ...ctx, sessionIds });
    return true;
  }
  return false;
}

function removeContainedGraphifyCache(
  target: Pick<WorktreeTarget, 'worktreePath' | 'graphifyCachePath' | 'repo' | 'scope' | 'sessionId'>,
): void {
  const cacheRoot = path.resolve(path.dirname(path.dirname(target.worktreePath)), 'graphify-cache');
  const expected = path.resolve(cacheRoot, target.repo);
  const actual = path.resolve(target.graphifyCachePath);
  if (actual !== expected || path.dirname(actual) !== cacheRoot) {
    log.warn('Worktree cleanup: refusing graphify cache path outside derived root', {
      scope: target.scope,
      sessionId: target.sessionId,
      repo: target.repo,
      graphifyCachePath: target.graphifyCachePath,
      cacheRoot,
    });
    return;
  }
  fs.rmSync(actual, { recursive: true, force: true });
}

export function removeGraphifyCacheAfterWorktree(target: WorktreeTarget): void {
  removeContainedGraphifyCache(target);
}

function cleanupOrphanGraphifyCache(target: OrphanGraphifyCacheTarget): void {
  if (preserveForParticipantGuard(target)) return;
  if (fs.existsSync(target.worktreePath)) {
    log.debug('Worktree cleanup: orphan cache regained matching worktree, skipping', {
      scope: target.scope,
      sessionId: target.sessionId,
      repo: target.repo,
    });
    return;
  }
  try {
    removeContainedGraphifyCache(target);
  } catch (err) {
    log.error('Worktree cleanup: error pruning orphan graphify cache', {
      scope: target.scope,
      sessionId: target.sessionId,
      repo: target.repo,
      err,
    });
  }
}

function cleanupOne(target: WorktreeTarget): void {
  const { sessionId, sessionIds, worktreePath, canonicalRepoPath, repo, agentGroupId, scope } = target;
  const ctx = { scope, agentGroupId, sessionId, repo };

  // Guard every mapped session before touching either the checkout or its
  // stable Graphify lock/cache. isContainerRunning remains the authoritative
  // liveness source; kernel close releases Graphify's fcntl lock.
  if (preserveForParticipantGuard(target)) return;

  // Standalone clones need no canonical; legacy linked worktrees do.
  if (!isStandaloneClone(worktreePath) && !fs.existsSync(path.join(canonicalRepoPath, '.git'))) {
    log.debug('Worktree cleanup: canonical repo missing, skipping', { ...ctx, canonicalRepoPath });
    return;
  }

  try {
    const dirty = isDirty(worktreePath);
    if (dirty === null) {
      log.warn('Worktree cleanup: git status failed, skipping', ctx);
      return;
    }
    if (dirty) {
      log.debug('Worktree cleanup: dirty, skipping', ctx);
      return;
    }

    // Run unpushed-commits check before branch-name check. `git log HEAD --not
    // --remotes` works on detached HEAD too, and unpushed-commits is the
    // load-bearing work-loss guard — branch state below only decides which
    // signal (PR merged / remote branch gone / age) we use to evict.
    const unpushed = hasUnpushedCommits(worktreePath);
    if (unpushed === null) {
      log.warn('Worktree cleanup: git log failed, skipping', ctx);
      return;
    }
    if (unpushed) {
      log.debug('Worktree cleanup: unpushed commits, skipping', ctx);
      return;
    }

    const branch = getBranchName(worktreePath);
    if (!branch || branch === 'HEAD') {
      // Detached HEAD with clean tree + everything pushed: no work to lose.
      // No branch ref to query a PR/remote status against, so evict on idle
      // age. Resumed sessions get a fresh worktree off origin/HEAD via
      // create_worktree.
      const ageDays = getLastModifiedDays(worktreePath);
      if (ageDays > IDLE_DETACHED_EVICT_DAYS) {
        log.info('Worktree cleanup: removing idle detached HEAD', {
          ...ctx,
          ageDays: Math.round(ageDays),
        });
        removeWorktree(canonicalRepoPath, worktreePath);
        removeGraphifyCacheAfterWorktree(target);
      } else {
        log.debug('Worktree cleanup: detached HEAD recently active, skipping', {
          ...ctx,
          ageDays: Math.round(ageDays),
        });
      }
      return;
    }

    const merged = isPRMerged(branch, worktreePath);
    const branchGone = isBranchDeletedOnRemote(branch, worktreePath);
    if (merged || branchGone) {
      log.info('Worktree cleanup: removing', { ...ctx, branch, merged, branchGone });
      removeWorktree(canonicalRepoPath, worktreePath);
      removeGraphifyCacheAfterWorktree(target);
      return;
    }

    const ageDays = getLastModifiedDays(worktreePath);
    if (ageDays > STALE_WARNING_DAYS) {
      log.warn('Worktree cleanup: stale >30d, no merged PR', {
        ...ctx,
        branch,
        ageDays: Math.round(ageDays),
      });
    }
  } catch (err) {
    log.error('Worktree cleanup: error processing worktree', { ...ctx, err });
  }
}

function runOnce(): void {
  const targets = discoverWorktrees();
  const orphanCaches = discoverOrphanGraphifyCaches();
  if (targets.length === 0 && orphanCaches.length === 0) return;
  log.info('Worktree cleanup: scanning', { count: targets.length, orphanCaches: orphanCaches.length });
  for (const t of targets) {
    cleanupOne(t);
  }
  for (const orphan of orphanCaches) {
    cleanupOrphanGraphifyCache(orphan);
  }
}

export function _discoverWorktreesForTesting(): WorktreeTarget[] {
  return discoverWorktrees();
}

export function _cleanupOneForTesting(target: WorktreeTarget): void {
  cleanupOne(target);
}

export function _discoverOrphanGraphifyCachesForTesting(): OrphanGraphifyCacheTarget[] {
  return discoverOrphanGraphifyCaches();
}

export function _cleanupOrphanGraphifyCacheForTesting(target: OrphanGraphifyCacheTarget): void {
  cleanupOrphanGraphifyCache(target);
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startWorktreeCleanup(): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    try {
      runOnce();
    } catch (err) {
      log.error('Worktree cleanup: startup run failed', { err });
    }
  }, STARTUP_DELAY_MS);
  intervalHandle = setInterval(() => {
    try {
      runOnce();
    } catch (err) {
      log.error('Worktree cleanup: periodic run failed', { err });
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopWorktreeCleanup(): void {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
