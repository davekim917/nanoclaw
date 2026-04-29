/**
 * Git worktrees MCP tools (Phase 2.11) — port of v1 IPC handlers.
 *
 * v1 ran these host-side under withGroupMutex because worktrees lived
 * outside the container mount set. In v2, the canonical repo is already
 * mounted RW at /workspace/agent/<repo> and the session dir is mounted
 * RW at /workspace, so worktrees at /workspace/worktrees/<repo> live
 * entirely inside container-visible paths. That lets us run everything
 * in-process — no IPC, no host mirror mount, no mutex (a session has
 * exactly one container at a time).
 *
 * Credentials: gh pr create uses GH_TOKEN=placeholder + HTTPS_PROXY.
 * The OneCLI gateway rewrites the Authorization header with the real
 * GitHub token assigned to this agent's OneCLI identity. See
 * docs/PHASE_2_11_GIT_WORKTREES.md "Credentials — resolved".
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const AGENT_DIR = '/workspace/agent';
const WORKTREES_DIR = '/workspace/worktrees';

function log(msg: string): void {
  console.error(`[git-worktrees] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function runGit(cwd: string, args: string[], timeoutMs = 30_000): string {
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: timeoutMs,
  }).toString().trim();
}

function tryGit(cwd: string, args: string[], timeoutMs = 30_000): string | null {
  try {
    return runGit(cwd, args, timeoutMs);
  } catch {
    return null;
  }
}

function validateRepoName(repo: string): string | null {
  if (!repo || typeof repo !== 'string') return 'repo is required';
  if (/[/\\]/.test(repo) || repo.includes('..') || repo === '.' || repo === '') {
    return `Invalid repo name: ${repo}`;
  }
  return null;
}

function sanitizeBranchSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'session';
}

function defaultBranchName(repo: string): string {
  const sess = process.env.NANOCLAW_SESSION_ID || 'session';
  return `thread-${sanitizeBranchSegment(sess)}-${sanitizeBranchSegment(repo)}`;
}

/**
 * Rebase the currently-checked-out branch in `worktreeDir` onto `origin/HEAD`.
 *
 * Called when a thread resumes against a pre-existing worktree or pre-existing
 * local branch — both paths can otherwise leave the agent on a stale tip while
 * origin/main has moved on (the worktree-cleanup cron explicitly skips branches
 * with unpushed work, so dormant threads accumulate stale state).
 *
 * Safety:
 * - `git status --porcelain` must be clean. Autosave runs at turn-end but is
 *   not guaranteed (status failures are treated as clean upstream; commit
 *   failures only log; container kills mid-rebase skip it entirely). If the
 *   tree is dirty, return the worktree as-is with a note — never rewrite over
 *   uncommitted changes.
 * - Detached HEAD: skip silently (no branch to rebase).
 * - Fetch/origin-HEAD freshness: caller passes `fetchOk` and `originHeadOk`.
 *   If either is false, we can't trust the rebase target; return as-is with a
 *   note instead of rebasing onto stale state.
 * - On rebase failure: `git rebase --abort` to restore pre-rebase state, then
 *   return an error. The agent gets a clear message and decides how to resolve.
 *
 * Force-push exposure: if the branch already has an `origin/<branch>` ref, the
 * rebase rewrites already-pushed commits, so the next `git_push` will be
 * non-fast-forward. The success message warns the agent to pass `force: true`
 * to `git_push`.
 */
function rebaseOntoOriginHead(
  worktreeDir: string,
  repoDir: string,
  fetchOk: boolean,
  originHeadOk: boolean,
): { kind: 'ok'; text: string } | { kind: 'err'; text: string } {
  const branch = tryGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    return { kind: 'ok', text: `Worktree ready at ${worktreeDir} (detached HEAD; no rebase)` };
  }

  if (!fetchOk || !originHeadOk) {
    log(`rebase: skipping for ${branch} — fetch=${fetchOk} originHead=${originHeadOk}`);
    return {
      kind: 'ok',
      text: `Worktree ready at ${worktreeDir} (branch ${branch}; could not refresh — fetch or origin/HEAD lookup failed, branch may be stale)`,
    };
  }

  const status = tryGit(worktreeDir, ['status', '--porcelain']);
  if (status === null) {
    return { kind: 'err', text: `Cannot determine worktree state at ${worktreeDir} (git status failed)` };
  }
  if (status.length > 0) {
    log(`rebase: dirty worktree at ${worktreeDir}, leaving branch ${branch} as-is`);
    return {
      kind: 'ok',
      text: `Worktree ready at ${worktreeDir} (branch ${branch}; uncommitted changes present — not rebased, may be stale relative to origin)`,
    };
  }

  const behind = tryGit(worktreeDir, ['rev-list', '--count', 'HEAD..origin/HEAD']);
  if (behind === '0') {
    return { kind: 'ok', text: `Worktree ready at ${worktreeDir} (branch ${branch}, already at origin/HEAD)` };
  }

  const hasRemoteTracking = tryGit(repoDir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]) !== null;

  try {
    runGit(worktreeDir, ['rebase', 'origin/HEAD'], 60_000);
  } catch (e) {
    tryGit(worktreeDir, ['rebase', '--abort'], 30_000);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: 'err',
      text: `Rebase onto origin/HEAD failed for branch ${branch}: ${msg}. Worktree restored to pre-rebase state. Inspect conflicts with \`git status\` and resolve manually before continuing.`,
    };
  }

  const tip = tryGit(worktreeDir, ['rev-parse', '--short', 'HEAD']) ?? '';
  let text = `Worktree ready at ${worktreeDir} (branch ${branch}, rebased onto origin/HEAD${tip ? `; tip ${tip}` : ''})`;
  if (hasRemoteTracking) {
    text += `. NOTE: branch was previously pushed; next \`git_push\` must use \`force: true\` because history was rewritten.`;
  }
  log(`rebase: ${branch} rebased onto origin/HEAD${hasRemoteTracking ? ' (force-push needed)' : ''}`);
  return { kind: 'ok', text };
}

// -----------------------------------------------------------------------------
// clone_repo
// -----------------------------------------------------------------------------

export const cloneRepoTool: McpToolDefinition = {
  tool: {
    name: 'clone_repo',
    description:
      'Clone a GitHub repo into this agent group at /workspace/agent/<name>. Idempotent: returns the existing path if the repo is already cloned. Use this INSTEAD of `git clone` — direct git clone is not set up with credentials.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'HTTPS GitHub URL (github.com only).' },
        name: { type: 'string', description: 'Optional directory name. Defaults to the repo name from the URL.' },
      },
      required: ['url'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url.trim()) return err('url is required');

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err(`Invalid URL: ${url}`);
    }
    if (parsed.hostname !== 'github.com') {
      return err('Only GitHub URLs are allowed');
    }
    const urlParts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (urlParts.length < 2) return err('Cannot derive repo name from URL');

    const repoName = typeof args.name === 'string' && args.name ? args.name : urlParts[1];
    const nameErr = validateRepoName(repoName);
    if (nameErr) return err(nameErr);

    const destDir = path.join(AGENT_DIR, repoName);

    // Idempotent only if it's a *real* clone — a prior failed clone can leave
    // an empty dir behind, which would silently falsely return success here
    // and then break create_worktree downstream.
    if (fs.existsSync(destDir)) {
      if (fs.existsSync(path.join(destDir, '.git'))) {
        log(`clone_repo: ${repoName} already exists at ${destDir} (idempotent)`);
        return ok(`Repo already present at ${destDir}`);
      }
      log(`clone_repo: ${destDir} exists but has no .git — removing and re-cloning`);
      try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    try {
      execFileSync('git', ['clone', url, destDir], { stdio: 'pipe', timeout: 120_000 });
      log(`clone_repo: cloned ${url} → ${destDir}`);
      return ok(`Cloned to ${destDir}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`git clone failed: ${msg}`);
    }
  },
};

// -----------------------------------------------------------------------------
// create_worktree
// -----------------------------------------------------------------------------

export const createWorktreeTool: McpToolDefinition = {
  tool: {
    name: 'create_worktree',
    description:
      'Create (or reuse) a per-thread git worktree for <repo> at /workspace/worktrees/<repo>. Fetches origin, then checks out the given branch if it exists, or branches off origin/HEAD. Idempotent. Default branch: thread-<sessionId>-<repo>.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo directory name (must already be cloned via clone_repo).' },
        branch: { type: 'string', description: 'Optional branch name. Defaults to thread-<sessionId>-<repo>.' },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const branchArg = typeof args.branch === 'string' && args.branch ? args.branch : undefined;
    const nameErr = validateRepoName(repo);
    if (nameErr) return err(nameErr);

    const repoDir = path.join(AGENT_DIR, repo);
    if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
      return err(`Repo not found in agent group: ${repo}. Run clone_repo first.`);
    }

    const worktreeDir = path.join(WORKTREES_DIR, repo);

    // Validate branch name shape early — same value is needed by both paths
    // below, and we don't want to discover an invalid name only after fetch +
    // worktree-existence checks.
    const branchName = branchArg ?? defaultBranchName(repo);
    if (tryGit(repoDir, ['check-ref-format', '--branch', branchName]) === null) {
      return err(`Invalid branch name: ${branchName}`);
    }

    // Only auto-rebase the default thread branch. If the agent explicitly
    // passed `branch: "..."`, treat it as a deliberate checkout (e.g. bisect,
    // rollback, working off a feature branch) and leave it at whatever tip the
    // local ref points to. The agent can rebase manually if it wants to.
    const shouldRebase = branchArg === undefined;

    // Fetch + set origin HEAD. Capture fetch outcome — if it failed, the rebase
    // step has to skip rather than rebase onto stale local origin/HEAD.
    const fetchOk = tryGit(repoDir, ['fetch', 'origin'], 60_000) !== null;
    tryGit(repoDir, ['remote', 'set-head', 'origin', '--auto']);

    const originHeadOk = tryGit(repoDir, ['rev-parse', '--verify', 'origin/HEAD']) !== null;

    // Idempotent: if worktree already exists and has a .git pointer, rebase its
    // branch onto fresh origin/HEAD (when applicable) and return. A dormant
    // thread that resumes weeks later would otherwise pick up a stale branch
    // tip — the worktree-cleanup cron explicitly skips unpushed/unmerged
    // branches, so this is the only path that closes that gap.
    if (fs.existsSync(worktreeDir)) {
      if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
        log(`create_worktree: corrupt worktree at ${worktreeDir}, removing`);
        try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        if (!shouldRebase) {
          const current = tryGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? branchName;
          return ok(`Worktree ready at ${worktreeDir} (branch ${current}; explicit branch — not rebased)`);
        }
        const result = rebaseOntoOriginHead(worktreeDir, repoDir, fetchOk, originHeadOk);
        return result.kind === 'ok' ? ok(result.text) : err(result.text);
      }
    }

    // Use fully-qualified refs to avoid ambiguity with tags or other refs that
    // share the branch name (e.g. a tag and branch both named "release-1.0").
    const branchExists =
      tryGit(repoDir, ['rev-parse', '--verify', `refs/heads/${branchName}`]) !== null ||
      tryGit(repoDir, ['rev-parse', '--verify', `refs/remotes/origin/${branchName}`]) !== null;

    fs.mkdirSync(WORKTREES_DIR, { recursive: true });

    // Clean up dangling .git/worktrees/ entries from prior crashes.
    tryGit(repoDir, ['worktree', 'prune'], 30_000);

    try {
      if (branchExists) {
        // Pre-existing local branch from a prior session may be stale. Check it
        // out, then rebase onto fresh origin/HEAD (when applicable).
        runGit(repoDir, ['worktree', 'add', worktreeDir, branchName]);
        log(`create_worktree: ${worktreeDir} on existing branch ${branchName}`);
        if (!shouldRebase) {
          return ok(`Worktree created at ${worktreeDir} on branch ${branchName} (explicit branch — not rebased)`);
        }
        const result = rebaseOntoOriginHead(worktreeDir, repoDir, fetchOk, originHeadOk);
        return result.kind === 'ok' ? ok(result.text) : err(result.text);
      } else if (originHeadOk) {
        // Fresh branch off freshly-fetched origin/HEAD — already at the latest,
        // no rebase needed.
        runGit(repoDir, ['worktree', 'add', '-b', branchName, worktreeDir, 'origin/HEAD']);
        log(`create_worktree: ${worktreeDir} on new branch ${branchName}`);
        return ok(`Worktree created at ${worktreeDir} on branch ${branchName}`);
      } else {
        return err('Cannot create worktree: origin/HEAD not resolved (fetch may have failed)');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`git worktree add failed: ${msg}`);
    }
  },
};

// -----------------------------------------------------------------------------
// git_commit
// -----------------------------------------------------------------------------

export const gitCommitTool: McpToolDefinition = {
  tool: {
    name: 'git_commit',
    description:
      'Stage all changes and commit in the worktree for <repo>. Author: agent@nanoclaw.local. Uses --no-verify to skip hooks. Returns the short SHA.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo directory name (must have a worktree via create_worktree).' },
        message: { type: 'string', description: 'Commit message.' },
      },
      required: ['repo', 'message'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const message = typeof args.message === 'string' ? args.message : '';
    const nameErr = validateRepoName(repo);
    if (nameErr) return err(nameErr);
    if (!message.trim()) return err('message is required');

    const worktreeDir = path.join(WORKTREES_DIR, repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}. Run create_worktree first.`);
    }

    // Defensive: clear stale index.lock
    try { fs.unlinkSync(path.join(worktreeDir, '.git', 'index.lock')); } catch { /* ignore */ }

    try {
      runGit(worktreeDir, ['add', '-A']);
      runGit(worktreeDir, [
        '-c', 'user.email=agent@nanoclaw.local',
        '-c', 'user.name=agent',
        'commit', '--no-verify', '-m', message,
      ]);
      const sha = runGit(worktreeDir, ['rev-parse', '--short', 'HEAD']);
      return ok(`Committed ${sha}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`git commit failed: ${msg}`);
    }
  },
};

// -----------------------------------------------------------------------------
// git_push
// -----------------------------------------------------------------------------

export const gitPushTool: McpToolDefinition = {
  tool: {
    name: 'git_push',
    description:
      'Push the worktree branch for <repo> to origin (sets upstream). Returns the pushed branch name. Set force: true to use --force-with-lease — required when create_worktree rebased a previously-pushed branch (the response will say so).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo directory name.' },
        force: {
          type: 'boolean',
          description: 'Use --force-with-lease. Set this when create_worktree warned that the branch was rewritten by a rebase.',
        },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const force = args.force === true;
    const nameErr = validateRepoName(repo);
    if (nameErr) return err(nameErr);

    const worktreeDir = path.join(WORKTREES_DIR, repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}.`);
    }

    try {
      const branch = runGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const pushArgs = force
        ? ['push', '--force-with-lease', '-u', 'origin', branch]
        : ['push', '-u', 'origin', branch];
      runGit(worktreeDir, pushArgs, 60_000);
      return ok(`Pushed ${branch} to origin${force ? ' (force-with-lease)' : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`git push failed: ${msg}`);
    }
  },
};

// -----------------------------------------------------------------------------
// open_pr
// -----------------------------------------------------------------------------

export const openPrTool: McpToolDefinition = {
  tool: {
    name: 'open_pr',
    description:
      'Open a GitHub PR from the current worktree branch. Returns the PR URL. Push the branch first with git_push.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo directory name.' },
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR body (optional).' },
      },
      required: ['repo', 'title'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const nameErr = validateRepoName(repo);
    if (nameErr) return err(nameErr);
    if (!title.trim()) return err('title is required');

    const worktreeDir = path.join(WORKTREES_DIR, repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}.`);
    }

    try {
      const url = execFileSync('gh', ['pr', 'create', '--title', title, '--body', body], {
        cwd: worktreeDir,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 60_000,
      }).toString().trim();
      return ok(`PR opened: ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`gh pr create failed: ${msg}`);
    }
  },
};

export const gitWorktreeTools: McpToolDefinition[] = [
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  openPrTool,
];

registerTools(gitWorktreeTools);
