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

    // Fetch + set origin HEAD (best-effort)
    tryGit(repoDir, ['fetch', 'origin'], 60_000);
    tryGit(repoDir, ['remote', 'set-head', 'origin', '--auto']);

    const originHeadOk = tryGit(repoDir, ['rev-parse', '--verify', 'origin/HEAD']) !== null;

    // Idempotent: if worktree already exists and has a .git pointer, return it.
    if (fs.existsSync(worktreeDir)) {
      if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
        log(`create_worktree: corrupt worktree at ${worktreeDir}, removing`);
        try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        const current = tryGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? branchArg ?? defaultBranchName(repo);
        return ok(`Worktree ready at ${worktreeDir} (branch ${current})`);
      }
    }

    const branchName = branchArg ?? defaultBranchName(repo);

    // MF-1: validate branch name shape
    if (tryGit(repoDir, ['check-ref-format', '--branch', branchName]) === null) {
      return err(`Invalid branch name: ${branchName}`);
    }

    const branchExists =
      tryGit(repoDir, ['rev-parse', '--verify', branchName]) !== null ||
      tryGit(repoDir, ['rev-parse', '--verify', `origin/${branchName}`]) !== null;

    fs.mkdirSync(WORKTREES_DIR, { recursive: true });

    // Clean up dangling .git/worktrees/ entries from prior crashes.
    tryGit(repoDir, ['worktree', 'prune'], 30_000);

    try {
      if (branchExists) {
        runGit(repoDir, ['worktree', 'add', worktreeDir, branchName]);
      } else if (originHeadOk) {
        runGit(repoDir, ['worktree', 'add', '-b', branchName, worktreeDir, 'origin/HEAD']);
      } else {
        return err('Cannot create worktree: origin/HEAD not resolved (fetch may have failed)');
      }
      log(`create_worktree: ${worktreeDir} on ${branchName}`);
      return ok(`Worktree created at ${worktreeDir} on branch ${branchName}`);
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
      'Push the worktree branch for <repo> to origin (sets upstream). Returns the pushed branch name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo directory name.' },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const nameErr = validateRepoName(repo);
    if (nameErr) return err(nameErr);

    const worktreeDir = path.join(WORKTREES_DIR, repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}.`);
    }

    try {
      const branch = runGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      runGit(worktreeDir, ['push', '-u', 'origin', branch], 60_000);
      return ok(`Pushed ${branch} to origin`);
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
