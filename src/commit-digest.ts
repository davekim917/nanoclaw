import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR } from './config.js';
import {
  addShipLogEntry,
  createTask,
  getCommitDigestState,
  getTaskById,
  updateTask,
  upsertCommitDigestState,
} from './db.js';
import { logger } from './logger.js';
import { registerSystemTaskHandler } from './task-scheduler.js';
import { RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

// Run 10 minutes before the daily summary (default 7:50am Eastern)
const DIGEST_CRON = process.env.COMMIT_DIGEST_CRON || '50 7 * * *';
const DIGEST_TZ = process.env.COMMIT_DIGEST_TZ || process.env.DAILY_NOTIFY_TZ || 'America/New_York';

export const COMMIT_DIGEST_TASK_ID = '__commit_digest';

export interface CommitDigestDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: string;
}

function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  return path.resolve(p);
}

/** Check if a directory is a git repo. */
function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** Get the default branch for a repo (e.g. main, master, develop). */
async function getDefaultBranch(repoDir: string): Promise<string | null> {
  try {
    // Try symbolic-ref first (works for repos with an origin)
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoDir, timeout: 5000 },
    );
    const ref = stdout.trim();
    // Extract branch name from refs/remotes/origin/main
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // Fallback: check for common branch names
    for (const branch of ['main', 'master', 'develop']) {
      try {
        await execFileAsync(
          'git',
          ['rev-parse', '--verify', `refs/heads/${branch}`],
          { cwd: repoDir, timeout: 5000 },
        );
        return branch;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Get the latest commit SHA on a branch. */
async function getLatestCommitSha(
  repoDir: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', branch],
      { cwd: repoDir, timeout: 5000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseCommitLine(line: string): CommitInfo {
  const [sha, shortSha, subject, authorName, date] = line.split('\0');
  return { sha, shortSha, subject, authorName, date };
}

/**
 * Get non-merge commits on the default branch since a given commit SHA.
 * Returns commits in chronological order (oldest first).
 */
async function getDirectCommitsSince(
  repoDir: string,
  branch: string,
  sinceSha: string,
): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        '--no-merges',
        '--first-parent',
        '--format=%H%x00%h%x00%s%x00%an%x00%aI',
        `${sinceSha}..${branch}`,
      ],
      { cwd: repoDir, timeout: 10000 },
    );

    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .map(parseCommitLine)
      .reverse(); // chronological order
  } catch {
    return [];
  }
}

/** Get repo name from its path (e.g. /home/user/projects/nanoclaw -> nanoclaw). */
function getRepoName(repoDir: string): string {
  return path.basename(repoDir);
}

/**
 * Discover git repos for a group. Sources:
 * 1. additionalMounts from containerConfig (host paths)
 * 2. Top-level .git directories in the group folder
 */
function discoverRepos(
  folder: string,
  groups: Record<string, RegisteredGroup>,
): string[] {
  const repos = new Set<string>();

  // 1. Check additionalMounts
  const group = Object.values(groups).find((g) => g.folder === folder);
  if (group?.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const hostPath = expandPath(mount.hostPath);
      if (isGitRepo(hostPath)) {
        repos.add(hostPath);
      }
    }
  }

  // 2. Check group folder for cloned repos (1 level deep)
  const groupDir = path.resolve(GROUPS_DIR, folder);
  try {
    const entries = fs.readdirSync(groupDir, { withFileTypes: true });
    // Check if the group folder itself is a repo
    if (isGitRepo(groupDir)) {
      repos.add(groupDir);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(groupDir, entry.name);
        if (isGitRepo(subDir)) {
          repos.add(subDir);
        }
      }
    }
  } catch {
    // Group dir doesn't exist or unreadable — skip
  }

  return [...repos];
}

/**
 * Scan a single repo for direct commits and create ship log entries.
 * Returns the number of commits found.
 */
async function scanRepo(
  repoDir: string,
  groupFolder: string,
): Promise<number> {
  const defaultBranch = await getDefaultBranch(repoDir);
  if (!defaultBranch) {
    logger.debug({ repoDir }, 'Could not determine default branch, skipping');
    return 0;
  }

  const latestSha = await getLatestCommitSha(repoDir, defaultBranch);
  if (!latestSha) return 0;

  const state = getCommitDigestState(repoDir);

  if (state && state.last_commit_sha === latestSha) {
    // No new commits
    return 0;
  }

  let commits: CommitInfo[];

  if (state) {
    // Get commits since last scan
    commits = await getDirectCommitsSince(repoDir, defaultBranch, state.last_commit_sha);
  } else {
    // First scan — don't backfill entire history, just record current position.
    // Get last 24h of commits as initial batch (capped at 100).
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'log',
          '--no-merges',
          '--first-parent',
          '-n', '100',
          '--format=%H%x00%h%x00%s%x00%an%x00%aI',
          '--since=24 hours ago',
          defaultBranch,
        ],
        { cwd: repoDir, timeout: 10000 },
      );

      commits = stdout.trim()
        ? stdout.trim().split('\n').map(parseCommitLine).reverse()
        : [];
    } catch {
      commits = [];
    }
  }

  // Update state regardless of whether we found commits
  upsertCommitDigestState({
    repo_path: repoDir,
    group_folder: groupFolder,
    last_commit_sha: latestSha,
    last_scan: new Date().toISOString(),
  });

  if (commits.length === 0) return 0;

  // Create a single ship log entry summarizing the batch
  const repoName = getRepoName(repoDir);
  const commitCount = commits.length;
  const title =
    commitCount === 1
      ? `${repoName}: ${commits[0].subject}`
      : `${repoName}: ${commitCount} direct commits to ${defaultBranch}`;

  const description = commits
    .map((c) => `• \`${c.shortSha}\` ${c.subject} (${c.authorName})`)
    .join('\n');

  addShipLogEntry({
    id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    group_folder: groupFolder,
    title,
    description,
    pr_url: null,
    branch: defaultBranch,
    tags: JSON.stringify(['commit-digest', repoName]),
    shipped_at: new Date().toISOString(),
  });

  logger.info(
    { repoDir, groupFolder, commitCount, branch: defaultBranch },
    'Commit digest: created ship log entry',
  );

  return commitCount;
}

/**
 * Run the commit digest for all registered groups.
 * Scans each group's repos for direct commits to the default branch
 * and creates ship log entries for any found.
 */
export async function runCommitDigest(
  deps: CommitDigestDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const folders = [...new Set(Object.values(groups).map((g) => g.folder))];

  let totalCommits = 0;
  let totalRepos = 0;

  // Scan all folders in parallel, repos within each folder in parallel
  const results = await Promise.all(
    folders.map(async (folder) => {
      const repos = discoverRepos(folder, groups);
      if (repos.length === 0) return { repos: 0, commits: 0 };

      const counts = await Promise.all(
        repos.map(async (repoDir) => {
          try {
            return await scanRepo(repoDir, folder);
          } catch (err) {
            logger.warn(
              { repoDir, folder, err },
              'Failed to scan repo for commit digest',
            );
            return 0;
          }
        }),
      );

      return {
        repos: repos.length,
        commits: counts.reduce((a, b) => a + b, 0),
      };
    }),
  );

  for (const r of results) {
    totalRepos += r.repos;
    totalCommits += r.commits;
  }

  logger.info(
    { totalRepos, totalCommits },
    'Commit digest completed',
  );
}

/**
 * Run commit digest for a specific group folder only.
 * Used by the manual IPC trigger.
 */
export async function runCommitDigestForGroup(
  groupFolder: string,
  groups: Record<string, RegisteredGroup>,
): Promise<{ repos: number; commits: number }> {
  const repos = discoverRepos(groupFolder, groups);

  const counts = await Promise.all(
    repos.map(async (repoDir) => {
      try {
        return await scanRepo(repoDir, groupFolder);
      } catch (err) {
        logger.warn(
          { repoDir, groupFolder, err },
          'Failed to scan repo for commit digest',
        );
        return 0;
      }
    }),
  );

  return {
    repos: repos.length,
    commits: counts.reduce((a, b) => a + b, 0),
  };
}

function computeNextRunForCron(): string {
  const interval = CronExpressionParser.parse(DIGEST_CRON, {
    tz: DIGEST_TZ,
  });
  return interval.next().toDate().toISOString();
}

/**
 * Idempotent: ensures the commit digest task row exists in scheduled_tasks.
 */
export function ensureCommitDigestTask(): void {
  const existing = getTaskById(COMMIT_DIGEST_TASK_ID);
  if (existing) {
    const updates: Parameters<typeof updateTask>[1] = {};
    let nextRun = existing.next_run;

    if (existing.schedule_value !== DIGEST_CRON) {
      updates.schedule_value = DIGEST_CRON;
    }
    if (existing.schedule_tz !== DIGEST_TZ) {
      updates.schedule_tz = DIGEST_TZ;
    }
    if (updates.schedule_value || updates.schedule_tz) {
      nextRun = computeNextRunForCron();
      updates.next_run = nextRun;
    }
    if (existing.status !== 'active') {
      updates.status = 'active';
    }

    if (Object.keys(updates).length > 0) {
      updateTask(COMMIT_DIGEST_TASK_ID, updates);
      logger.info({ updates, nextRun }, 'Commit digest task updated');
    } else {
      logger.info(
        { nextRun, cron: DIGEST_CRON },
        'Commit digest task exists',
      );
    }
    return;
  }

  const nextRun = computeNextRunForCron();
  createTask({
    id: COMMIT_DIGEST_TASK_ID,
    group_folder: '__system',
    chat_jid: '__system',
    prompt: 'Commit digest (system task)',
    schedule_type: 'cron',
    schedule_value: DIGEST_CRON,
    context_mode: 'isolated',
    task_type: 'system',
    schedule_tz: DIGEST_TZ,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { nextRun, cron: DIGEST_CRON },
    'Commit digest task created',
  );
}

/**
 * Register the commit digest handler with the task scheduler.
 * Must be called before startSchedulerLoop().
 */
export function registerCommitDigestHandler(
  deps: CommitDigestDeps,
): void {
  registerSystemTaskHandler(COMMIT_DIGEST_TASK_ID, async () => {
    await runCommitDigest(deps);
  });
}
