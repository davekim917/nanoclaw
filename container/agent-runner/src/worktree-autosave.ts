/**
 * Auto-commit dirty worktrees (fork-local safety net).
 *
 * Iterates `/workspace/worktrees/<name>` directories and commits any
 * uncommitted changes with a marker message identifying the trigger.
 * Two callers:
 *   - poll-loop post-query: fires at the end of every turn, success or
 *     failure. If the agent forgot to commit edits during the turn, the
 *     host checkpoints them so the work survives a later compaction or
 *     container kill. Mirrors v1's `cleanupThreadWorkspace` auto-commit
 *     (src/container-runner.ts) but without v1's "then delete the
 *     scratch dir" half — v2 worktrees are per-session and resumable, so
 *     they stay put.
 *   - claude provider PreCompact hook: Claude Code fires this right
 *     before wiping older transcript from context. A commit here pins the
 *     state to git BEFORE the agent loses its memory of having made the
 *     edits, so the next turn (operating from the compacted baseline)
 *     reads the committed state instead of re-doing / undoing work.
 *
 * Scope: only commits worktrees under `/workspace/worktrees/`. The
 * canonical group workspace at `/workspace/agent/*` is intentionally
 * skipped — that's the persistent group state where uncommitted changes
 * are the agent's own working copy, not per-turn diffs. Agents manage
 * that repo explicitly.
 *
 * Never throws. All failures are logged; the caller flow continues.
 * The auto-commit uses `--no-verify` to bypass any repo-local commit
 * hooks, same as v1.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_WORKTREES_DIR = '/workspace/worktrees';

export interface AutoSaveResult {
  committed: string[];
  skipped: string[];
  failed: string[];
}

function log(msg: string): void {
  console.error(`[worktree-autosave] ${msg}`);
}

function isGitWorktree(dir: string): boolean {
  // A git worktree has a `.git` FILE (not a dir) pointing at the canonical
  // repo's .git/worktrees/<name>. Standalone clones have a `.git` DIR.
  // Either counts — both can receive commits.
  try {
    const st = fs.lstatSync(path.join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function hasDirtyChanges(repoPath: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return out.trim().length > 0;
  } catch (err) {
    log(`git status failed in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function clearStaleIndexLock(repoPath: string): void {
  // Worktree index.lock may live in the canonical repo at
  // .git/worktrees/<name>/index.lock when `.git` is a file pointing there;
  // standalone repos put it at .git/index.lock. Resolve by asking git.
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const lockPath = path.isAbsolute(gitDir) ? path.join(gitDir, 'index.lock') : path.join(repoPath, gitDir, 'index.lock');
    try {
      fs.unlinkSync(lockPath);
      log(`Removed stale index.lock at ${lockPath}`);
    } catch {
      // not present — fine
    }
  } catch {
    // git-dir lookup failed; fall through to the commit which will fail
    // descriptively if the repo is truly broken.
  }
}

function commitAll(repoPath: string, reason: string): boolean {
  try {
    execFileSync('git', ['add', '-A'], { cwd: repoPath, timeout: 30_000 });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=agent@nanoclaw.local',
        '-c',
        'user.name=agent',
        'commit',
        '--no-verify',
        '-m',
        `auto-save: ${reason}`,
      ],
      { cwd: repoPath, timeout: 30_000 },
    );
    return true;
  } catch (err) {
    log(`commit failed in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Scan /workspace/worktrees/* and commit any dirty repo. Returns a
 * breakdown of committed / skipped-clean / failed paths so callers can
 * log a concise summary.
 */
export async function autoCommitDirtyWorktrees(
  reason: string,
  rootDir: string = DEFAULT_WORKTREES_DIR,
): Promise<AutoSaveResult> {
  const result: AutoSaveResult = { committed: [], skipped: [], failed: [] };

  if (!fs.existsSync(rootDir)) return result;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rootDir);
  } catch (err) {
    log(`readdir ${rootDir} failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const name of entries) {
    const repoPath = path.join(rootDir, name);
    try {
      if (!fs.statSync(repoPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isGitWorktree(repoPath)) continue;

    if (!hasDirtyChanges(repoPath)) {
      result.skipped.push(name);
      continue;
    }

    clearStaleIndexLock(repoPath);
    const ok = commitAll(repoPath, reason);
    if (ok) {
      result.committed.push(name);
      log(`auto-committed ${name} (reason: ${reason})`);
    } else {
      result.failed.push(name);
    }
  }

  return result;
}
