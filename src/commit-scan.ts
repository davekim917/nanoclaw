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
import { execFile } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'node:util';

import { GROUPS_DIR } from './config.js';
import { addShipLogEntry, getCommitDigestState, upsertCommitDigestState } from './db/backlog.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

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
// Guards against overlapping scans now that git calls are async: the old
// execFileSync-based scan could never overlap its own
// re-armed timer, because every await inside it settled as a same-tick
// microtask before the event loop could reach a timer callback. Now each git
// call actually yields, so a scan slower than SCAN_INTERVAL_MS (e.g. every
// repo's `git fetch` timing out at 30s with the network down — 72 repos ×
// 30s ≈ 36min) would otherwise let two scans run at once: both read
// commit_digest_state.last_commit_sha before either updates it, so the same
// commits get recorded twice, and concurrent fetches in one repo contend on
// git's own lock.
let scanInFlight = false;

export function startCommitScan(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    if (scanInFlight) {
      log.debug('Commit scan tick skipped — previous scan still in flight');
    } else {
      scanInFlight = true;
      runCommitScanOnce()
        .catch((error) => log.error('Commit scan failed', { error: errorMessage(error) }))
        .finally(() => {
          scanInFlight = false;
        });
    }
    // Re-armed unconditionally, same as before: a skipped or failed tick must
    // not stop future ticks from firing.
    timer = setTimeout(tick, SCAN_INTERVAL_MS);
    timer.unref?.();
  }, STARTUP_DELAY_MS);
  timer.unref?.();
}

export function stopCommitScan(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

onHostStart(function commitScanHostStart() {
  // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
  startCommitScan();
  log.info('Commit scan started');
});

onHostShutdown(function commitScanHostShutdown() {
  try {
    stopCommitScan();
  } catch (error) {
    log.error('Commit scan failed to stop', { error: errorMessage(error) });
  }
});

export async function runCommitScanOnce(groupsDir: string = GROUPS_DIR): Promise<void> {
  const groups = await getAllAgentGroups();
  let totalRepos = 0;
  let totalCommits = 0;
  for (const group of groups) {
    const groupDir = path.join(groupsDir, group.folder);
    if (!fs.existsSync(groupDir)) continue;
    const repos = await discoverRepos(groupDir);
    for (const repoDir of repos) {
      const commits = await scanRepo(repoDir, group.id);
      if (commits > 0) totalCommits += commits;
      totalRepos += 1;
    }
  }
  if (totalCommits > 0) {
    log.info('Commit scan recorded direct commits', { totalCommits, totalRepos });
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  const stdout = await readGit(dir, ['rev-parse', '--is-inside-work-tree'], 'validate checkout');
  return stdout?.trim() === 'true';
}

export async function discoverRepos(root: string): Promise<string[]> {
  const repos: string[] = [];
  if (await isGitRepo(root)) repos.push(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(root, entry.name);
    if (await isGitRepo(subDir)) repos.push(subDir);
  }
  return repos;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readGit(repoDir: string, args: string[], operation: string, timeout = 5000): Promise<string | null> {
  try {
    // execFile has no `stdio` option — @types/node's ExecFileOptions
    // extends only CommonOptions + Abortable, unlike CommonSpawnOptions, so it
    // can't reject a fetch's credential prompt the way execFileSync's
    // `stdio: ['ignore', 'pipe', 'pipe']` did. util.promisify's custom
    // execFile implementation attaches the live ChildProcess as `.child`
    // on the returned promise (PromiseWithChild, :1023), so ending stdin
    // immediately reproduces the same "no prompt, fail on timeout"
    // behavior instead of leaving the pipe open for git to block on.
    const pending = execFileAsync('git', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout.toString();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr ?? '').trim();
    log.debug('Commit scan Git command failed', {
      repo: repoDir,
      operation,
      error: stderrText ? `${errorMessage(error)}: ${stderrText}` : errorMessage(error),
    });
    return null;
  }
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

async function getDefaultBranch(repoDir: string): Promise<string | null> {
  const stdout = await readGit(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'], 'read default branch');
  if (stdout !== null) {
    const ref = stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } else {
    for (const branch of ['main', 'master', 'develop']) {
      if (
        await readGit(repoDir, ['rev-parse', '--verify', `refs/heads/${branch}`], `verify default branch ${branch}`)
      ) {
        return branch;
      }
    }
  }
  return null;
}

async function fetchOrigin(repoDir: string): Promise<void> {
  if ((await readGit(repoDir, ['fetch', '--quiet', '--no-tags', 'origin'], 'fetch origin', 30_000)) === null) {
    // Network failure, auth missing, repo without origin — fall through and
    // scan whatever the local refs already have. Loud failure here would
    // suppress every repo's data on a transient blip.
  }
}

async function getLatestCommitSha(repoDir: string, branch: string): Promise<string | null> {
  const stdout = await readGit(repoDir, ['rev-parse', branch], `read latest commit ${branch}`);
  return stdout?.trim() || null;
}

async function getDirectCommitsSince(repoDir: string, branch: string, sinceSha: string): Promise<CommitInfo[]> {
  const stdout = await readGit(
    repoDir,
    ['log', '--no-merges', '--first-parent', '--format=%H%x00%h%x00%s%x00%an%x00%aI', `${sinceSha}..${branch}`],
    'read direct commits',
    10_000,
  );
  if (!stdout?.trim()) return [];
  return stdout.trim().split('\n').map(parseCommitLine).reverse();
}

async function getRecentCommits(repoDir: string, branch: string, limit: number): Promise<CommitInfo[]> {
  const stdout = await readGit(
    repoDir,
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
    'read recent commits',
    10_000,
  );
  if (!stdout?.trim()) return [];
  return stdout.trim().split('\n').map(parseCommitLine).reverse();
}

async function scanRepo(repoDir: string, agentGroupId: string): Promise<number> {
  const defaultBranch = await getDefaultBranch(repoDir);
  if (!defaultBranch) return 0;

  // Refresh remote refs before reading. Without this we'd see whatever the
  // local clone last pulled — for a host-side scanner watching for external
  // commits and merged PRs, that's exactly the wrong thing. Fetch only
  // updates refs/remotes/* and doesn't touch the working tree, so safe even
  // when the agent has WIP in a worktree.
  await fetchOrigin(repoDir);

  // Track origin/<branch>, not local <branch>. The local ref drifts whenever
  // the user works on a feature branch and forgets to pull main; the remote
  // ref is what actually represents "shipped to default branch."
  const remoteRef = `origin/${defaultBranch}`;
  const latestSha = await getLatestCommitSha(repoDir, remoteRef);
  if (!latestSha) return 0;

  const state = await getCommitDigestState(repoDir);
  const lastSha = state?.last_commit_sha ?? null;
  if (lastSha === latestSha) return 0;

  const commits = lastSha
    ? await getDirectCommitsSince(repoDir, remoteRef, lastSha)
    : await getRecentCommits(repoDir, remoteRef, FIRST_SCAN_COMMIT_CAP);

  await upsertCommitDigestState({
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

  await addShipLogEntry({
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
