/**
 * Host-side commit-digest scanner.
 *
 * Walks every agent group's workspace, finds git repos at the workspace
 * root and immediate subdirectories, and records new direct commits to
 * the default branch as ship_log entries (tagged `commit-digest,<repo>`).
 *
 * Why host-side: ship_log is a fact about what shipped, not a user-facing
 * flow. The container-side `scan_commits` MCP tool only fires when an
 * agent calls it — direct commits and external PRs made from outside the
 * agent silently went unrecorded. v1 had the same shape via a system task
 * `__commit_digest`; this is the v2 port, hooked into the host's existing
 * periodic-job infrastructure (sibling of host-sweep, plugin-updater,
 * worktree-cleanup) instead of a scheduled task.
 *
 * Same logic + state table as the container-side tool — they coexist
 * idempotently because both gate on commit_digest_state.last_commit_sha.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { addShipLogEntry, getCommitDigestState, upsertCommitDigestState } from './db/backlog.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';

const SCAN_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 90_000;
const FIRST_SCAN_WINDOW_HOURS = 24;
const FIRST_SCAN_COMMIT_CAP = 100;
// Prevents one ship_log row from carrying a wall-of-text description when
// a repo has been quiet for weeks and the scanner finds dozens of merged
// commits at once. The agent's morning briefing reads description fields
// verbatim — without a cap, a 100-commit burst becomes a 100-line chat
// message. Title still reports the true count.
const DESCRIPTION_COMMIT_CAP = 20;

let timer: NodeJS.Timeout | null = null;

export function startCommitScan(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    runScan().catch((err) => log.error('Commit scan failed', { err }));
    timer = setTimeout(tick, SCAN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopCommitScan(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function runScan(): Promise<void> {
  const groups = getAllAgentGroups();
  let totalRepos = 0;
  let totalCommits = 0;
  for (const group of groups) {
    const groupDir = path.join(GROUPS_DIR, group.folder);
    if (!fs.existsSync(groupDir)) continue;
    const repos = discoverRepos(groupDir);
    for (const repoDir of repos) {
      const commits = scanRepo(repoDir, group.id);
      if (commits > 0) totalCommits += commits;
      totalRepos += 1;
    }
  }
  if (totalCommits > 0) {
    log.info('Commit scan recorded direct commits', { totalCommits, totalRepos });
  }
}

function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function discoverRepos(root: string): string[] {
  const repos: string[] = [];
  if (isGitRepo(root)) repos.push(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(root, entry.name);
    if (isGitRepo(subDir)) repos.push(subDir);
  }
  return repos;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: string;
}

function parseCommitLine(line: string): CommitInfo {
  const [sha, shortSha, subject, authorName, date] = line.split('\0');
  return { sha, shortSha, subject, authorName, date };
}

function getDefaultBranch(repoDir: string): string | null {
  try {
    const stdout = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).toString();
    const ref = stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    for (const branch of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
          cwd: repoDir,
          encoding: 'utf-8',
          timeout: 5000,
        });
        return branch;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function fetchOrigin(repoDir: string): void {
  try {
    execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Network failure, auth missing, repo without origin — fall through and
    // scan whatever the local refs already have. Loud failure here would
    // suppress every repo's data on a transient blip.
  }
}

function getLatestCommitSha(repoDir: string, branch: string): string | null {
  try {
    const stdout = execFileSync('git', ['rev-parse', branch], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).toString();
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function getDirectCommitsSince(repoDir: string, branch: string, sinceSha: string): CommitInfo[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--no-merges', '--first-parent', '--format=%H%x00%h%x00%s%x00%an%x00%aI', `${sinceSha}..${branch}`],
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000 },
    ).toString();
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').map(parseCommitLine).reverse();
  } catch {
    return [];
  }
}

function getRecentCommits(repoDir: string, branch: string, limit: number): CommitInfo[] {
  try {
    const stdout = execFileSync(
      'git',
      [
        'log',
        '--no-merges',
        '--first-parent',
        '-n',
        String(limit),
        '--format=%H%x00%h%x00%s%x00%an%x00%aI',
        `--since=${FIRST_SCAN_WINDOW_HOURS} hours ago`,
        branch,
      ],
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000 },
    ).toString();
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').map(parseCommitLine).reverse();
  } catch {
    return [];
  }
}

function scanRepo(repoDir: string, agentGroupId: string): number {
  const defaultBranch = getDefaultBranch(repoDir);
  if (!defaultBranch) return 0;

  // Refresh remote refs before reading. Without this we'd see whatever the
  // local clone last pulled — for a host-side scanner watching for external
  // commits and merged PRs, that's exactly the wrong thing. Fetch only
  // updates refs/remotes/* and doesn't touch the working tree, so safe even
  // when the agent has WIP in a worktree.
  fetchOrigin(repoDir);

  // Track origin/<branch>, not local <branch>. The local ref drifts whenever
  // the user works on a feature branch and forgets to pull main; the remote
  // ref is what actually represents "shipped to default branch."
  const remoteRef = `origin/${defaultBranch}`;
  const latestSha = getLatestCommitSha(repoDir, remoteRef);
  if (!latestSha) return 0;

  const state = getCommitDigestState(repoDir);
  const lastSha = state?.last_commit_sha ?? null;
  if (lastSha === latestSha) return 0;

  const commits = lastSha
    ? getDirectCommitsSince(repoDir, remoteRef, lastSha)
    : getRecentCommits(repoDir, remoteRef, FIRST_SCAN_COMMIT_CAP);

  upsertCommitDigestState({
    repo_path: repoDir,
    agent_group_id: agentGroupId,
    last_commit_sha: latestSha,
    last_scan: new Date().toISOString(),
  });

  if (commits.length === 0) return 0;

  const repoName = path.basename(repoDir);
  const title =
    commits.length === 1
      ? `${repoName}: ${commits[0].subject}`
      : `${repoName}: ${commits.length} direct commits to ${defaultBranch}`;
  const shown = commits.slice(0, DESCRIPTION_COMMIT_CAP);
  const lines = shown.map((c) => `\`${c.shortSha}\` ${c.subject} (${c.authorName})`);
  if (commits.length > DESCRIPTION_COMMIT_CAP) {
    lines.push(`… and ${commits.length - DESCRIPTION_COMMIT_CAP} more`);
  }
  const description = lines.join('\n');

  addShipLogEntry({
    id: `ship-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent_group_id: agentGroupId,
    title,
    description,
    pr_url: null,
    branch: defaultBranch,
    tags: `commit-digest,${repoName}`,
    shipped_at: new Date().toISOString(),
  });

  return commits.length;
}
