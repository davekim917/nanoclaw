/**
 * Per-thread worktree cleanup cron (Phase 2.11) — host-side GC.
 *
 * Walks data/v2-sessions/<agId>/<sessionId>/worktrees/<repo>/ and
 * removes worktrees whose branch has been merged on GitHub or whose
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
 *   gh auth the host has (Dave's shell gh config). If the host has
 *   no gh auth, the merged-check returns false and we fall back to
 *   the "branch gone on origin" heuristic.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { isContainerRunning } from './container-runner.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const STALE_WARNING_DAYS = 30;

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

function removeWorktree(canonicalRepoPath: string, worktreePath: string): void {
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
  agentGroupId: string;
  sessionId: string;
  repo: string;
  worktreePath: string;
  canonicalRepoPath: string;
}

function discoverWorktrees(): WorktreeTarget[] {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsRoot)) return [];

  const results: WorktreeTarget[] = [];
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
          agentGroupId,
          sessionId: entry,
          repo,
          worktreePath: path.join(worktreesDir, repo),
          canonicalRepoPath: path.join(canonicalBase, repo),
        });
      }
    }
  }
  return results;
}

function cleanupOne(target: WorktreeTarget): void {
  const { sessionId, worktreePath, canonicalRepoPath, repo, agentGroupId } = target;
  const ctx = { agentGroupId, sessionId, repo };

  // Guard: skip if the session's container is live — it may be mid-git.
  if (isContainerRunning(sessionId)) {
    log.debug('Worktree cleanup: skipping session with live container', ctx);
    return;
  }

  // Skip if session is gone from the DB — but keep the worktree for now
  // in case it was an unexpected DB prune. Deletion-by-DB-absence is not
  // safe without a separate sweep.
  const sess = getSession(sessionId);
  if (!sess) {
    log.debug('Worktree cleanup: session not in DB, skipping', ctx);
    return;
  }

  if (!fs.existsSync(path.join(canonicalRepoPath, '.git'))) {
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

    const branch = getBranchName(worktreePath);
    if (!branch || branch === 'HEAD') {
      log.debug('Worktree cleanup: detached HEAD, skipping', ctx);
      return;
    }

    const unpushed = hasUnpushedCommits(worktreePath);
    if (unpushed === null) {
      log.warn('Worktree cleanup: git log failed, skipping', ctx);
      return;
    }
    if (unpushed) {
      log.debug('Worktree cleanup: unpushed commits, skipping', ctx);
      return;
    }

    const merged = isPRMerged(branch, worktreePath);
    const branchGone = isBranchDeletedOnRemote(branch, worktreePath);
    if (merged || branchGone) {
      log.info('Worktree cleanup: removing', { ...ctx, branch, merged, branchGone });
      removeWorktree(canonicalRepoPath, worktreePath);
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
  if (targets.length === 0) return;
  log.info('Worktree cleanup: scanning', { count: targets.length });
  for (const t of targets) {
    cleanupOne(t);
  }
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
