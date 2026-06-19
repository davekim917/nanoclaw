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

// Base dirs are resolved through these helpers (not module consts) so a single
// override surface — the NANOCLAW_*_DIR_OVERRIDE env vars — can repoint them for
// tests without touching `/workspace`. Production never sets the overrides, so
// the canonical container paths apply unchanged.
function agentDir(): string {
  return process.env.NANOCLAW_AGENT_DIR_OVERRIDE || '/workspace/agent';
}
function worktreesDir(): string {
  return process.env.NANOCLAW_WORKTREES_DIR_OVERRIDE || '/workspace/worktrees';
}
function workgroupDir(): string {
  return process.env.NANOCLAW_WORKGROUP_DIR_OVERRIDE || '/workspace/workgroup';
}

/**
 * Resolve where new clones land. Cloned repos live under `<base>/repos/<name>`
 * so they stay namespaced away from the agent's bedroom files and a single
 * `repos/` rule can gitignore them.
 *
 * Destination preference:
 * - If the shared workgroup tree is mounted (`/workspace/workgroup` exists),
 *   clone into `/workspace/workgroup/repos` so every sibling in the workgroup
 *   shares one checkout (the "house"). This is the default when shared-FS is on.
 * - Otherwise clone into the private `/workspace/agent/repos` (the "bedroom").
 *
 * Fail-loud on expected-but-missing: if `NANOCLAW_WORKGROUP_ID` is set (the
 * agent_group HAS a workgroup) but `/workspace/workgroup` is absent, the mount
 * failed. We must NOT silently fall back to a private clone — that would split
 * the workgroup's shared tree and hide a real misconfiguration. Log loudly and
 * still return the private dir so the operation can proceed degraded, but the
 * warning is the signal the operator must act on.
 */
export function getReposDir(): string {
  const wg = workgroupDir();
  if (fs.existsSync(wg)) return path.join(wg, 'repos');

  if (process.env.NANOCLAW_WORKGROUP_ID) {
    log(
      `WARNING: NANOCLAW_WORKGROUP_ID is set (${process.env.NANOCLAW_WORKGROUP_ID}) but ${wg} ` +
        `is not mounted — the workgroup shared tree is missing. NOT cloning into the shared ` +
        `tree; falling back to the private ${agentDir()}/repos. This is a mount failure: clones ` +
        `will NOT be visible to sibling agents. Check the workgroup-shared-FS mount on the host.`,
    );
  }
  return path.join(agentDir(), 'repos');
}

/**
 * Resolve an existing cloned-repo dir for <name>, highest precedence first:
 *   1. workgroup shared repos: `/workspace/workgroup/repos/<name>`
 *   2. namespaced private repos: `/workspace/agent/repos/<name>`
 *   3. legacy private root:      `/workspace/agent/<name>`
 * Returns null if none is a real git clone.
 *
 * Same-name shadow guard: if a real clone of <name> exists in more than one of
 * these locations, the higher-precedence one wins, but we log a warning (no
 * silent shadow) — and, when both clones expose an `origin` URL, note whether
 * they disagree so an operator can spot a divergent shared/private checkout.
 */
export function resolveRepoDir(name: string): string | null {
  const candidates = [
    path.join(workgroupDir(), 'repos', name),
    path.join(agentDir(), 'repos', name),
    path.join(agentDir(), name),
  ];
  const matches = candidates.filter((dir) => fs.existsSync(path.join(dir, '.git')));
  if (matches.length === 0) return null;

  const chosen = matches[0];
  if (matches.length > 1) {
    const shadowed = matches.slice(1);
    const chosenOrigin = tryGit(chosen, ['config', '--get', 'remote.origin.url']);
    const originNote = shadowed
      .map((dir) => {
        const o = tryGit(dir, ['config', '--get', 'remote.origin.url']);
        const mismatch = chosenOrigin && o && o !== chosenOrigin ? ' [ORIGIN MISMATCH]' : '';
        return `${dir}${mismatch}`;
      })
      .join(', ');
    log(
      `WARNING: repo '${name}' exists in multiple locations — using higher-precedence ` +
        `${chosen}, shadowing: ${originNote}. Remove the stale copy to avoid confusion.`,
    );
  }
  return chosen;
}

/**
 * Resolve symlinks + normalize a path for an identity comparison. Falls back to
 * path.resolve() (string normalization only) when the path doesn't exist or
 * realpath otherwise throws, so callers that compare for EQUALITY degrade to the
 * stricter, non-symlink-aware compare rather than crashing. (codex #126)
 */
function canonPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Returns an error message if the worktree at <worktreeDir> is attached to a
 * DIFFERENT clone than the currently-resolved repo for <repo>, else null. This
 * catches the shadow case: a worktree created against /workspace/agent/repos/<repo>
 * once a /workspace/workgroup/repos/<repo> clone appears and resolveRepoDir starts
 * preferring it — every worktree-operating tool (create_worktree reuse, commit,
 * push, open_pr) must refuse rather than silently land work in the shadowed clone.
 * Returns null when there's no resolvable clone or git can't report the common
 * dir (the caller's own existence checks handle those). (codex #126 N4 + N5)
 */
function staleWorktreeAttachmentError(worktreeDir: string, repo: string): string | null {
  const repoDir = resolveRepoDir(repo);
  if (!repoDir) return null;
  const commonDir = tryGit(worktreeDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // Canonicalize BOTH sides through realpath before comparing. resolveRepoDir can
  // return a symlink alias (e.g. the migration compat symlink
  // /workspace/agent/<repo> -> /workspace/workgroup/repos/<repo>), while git's
  // --git-common-dir reports the real target. path.resolve() only normalizes the
  // string, not symlinks, so without this a valid worktree on a migrated repo
  // looks attached to a "different clone" and every worktree op false-rejects it.
  // realpath throws on a non-existent path — fall back to path.resolve there,
  // which preserves the stricter (over-blocking) compare = fail-closed. (codex #126)
  if (commonDir && canonPath(commonDir) !== canonPath(path.resolve(repoDir, '.git'))) {
    return (
      `Worktree at ${worktreeDir} is attached to a different clone (${commonDir}) than the ` +
      `currently-resolved repo (${path.resolve(repoDir, '.git')}) — a workgroup clone likely now ` +
      `shadows an older agent clone. Push any wanted work from the old clone, then remove the stale ` +
      `worktree (\`rm -rf ${worktreeDir}\`) and re-run create_worktree to re-attach it to the current clone.`
    );
  }
  return null;
}

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

/**
 * Compare two git remote URLs for "same repo" up to trivial differences a real
 * clone introduces: a trailing `.git`, a trailing slash, and case in the host.
 * Intentionally conservative — it only normalizes cosmetic suffixes, so a
 * genuinely different owner/repo still reads as a mismatch.
 */
function normalizeOrigin(u: string): string {
  return u
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}
function originsMatch(a: string, b: string): boolean {
  return normalizeOrigin(a) === normalizeOrigin(b);
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
      'Clone a GitHub repo into this agent group. Lands in the shared workgroup tree (/workspace/workgroup/repos/<name>) when it is mounted, otherwise the private /workspace/agent/repos/<name>. Idempotent: returns the existing path if the repo is already cloned (origin must match). Use this INSTEAD of `git clone` — direct git clone is not set up with credentials.',
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

    // Idempotent: reuse an existing real clone (workgroup/repos, namespaced
    // private repos/, or legacy root) — but only when its origin matches the
    // requested URL. A same-name dir pointing at a DIFFERENT origin is not the
    // repo the caller asked for; silently returning it would hand back the
    // wrong code, so error out and let the operator resolve the collision.
    const existing = resolveRepoDir(repoName);
    if (existing) {
      // When the shared workgroup tree is mounted, repos belong in
      // /workspace/workgroup/repos so every sibling sees them (see getReposDir).
      // resolveRepoDir also matches PRIVATE bedroom clones
      // (/workspace/agent/repos/<name> or the legacy /workspace/agent/<name>) at
      // lower precedence — handing one of those back reports success while siblings
      // can't see the checkout. Refuse loudly so the operator relocates it into the
      // shared tree (or removes it to re-clone there). Degraded mode — workgroup
      // expected but not mounted — leaves workgroupDir() absent, so this gate stays
      // off and the private clone remains reusable. (codex #126)
      const sharedClonePath = path.join(workgroupDir(), 'repos', repoName);
      if (fs.existsSync(workgroupDir()) && existing !== sharedClonePath) {
        return err(
          `Repo '${repoName}' is already cloned at ${existing}, a PRIVATE (bedroom) location, but ` +
            `the shared workgroup tree (${workgroupDir()}) is mounted — a private clone is NOT ` +
            `visible to sibling agents. Refusing to silently reuse it. Move it into the shared tree ` +
            `(\`mv ${existing} ${sharedClonePath}\`) or remove it and re-run clone_repo to clone there.`,
        );
      }
      const origin = tryGit(existing, ['config', '--get', 'remote.origin.url']);
      if (origin !== null && !originsMatch(origin, url)) {
        return err(
          `Repo '${repoName}' already exists at ${existing} but its origin (${origin}) does not ` +
            `match the requested URL (${url}). Refusing to reuse a mismatched clone. Use a ` +
            `different name, or remove the existing clone first.`,
        );
      }
      if (origin === null) {
        // The existing clone has NO origin remote, so it cannot be verified
        // against — or fetch/push to — the requested URL. It may be a partial
        // clone or an operator-placed local-only repo, not the repo the caller
        // asked for. Don't silently pass it off as a match: reuse it
        // (non-destructive — a conservative error would break legit local-only
        // repos) but surface the mismatch LOUDLY so it's resolvable (S-QA1).
        log(
          `clone_repo: WARNING — ${repoName} at ${existing} has NO origin remote; ` +
            `reusing as-is, but it may not match ${url}`,
        );
        return ok(
          `Repo already present at ${existing}, but it has NO 'origin' remote — it cannot be ` +
            `verified against or fetch/push to the requested URL (${url}). Reusing it as-is. ` +
            `If this is the wrong repo, remove ${existing} or clone under a different name.`,
        );
      }
      log(`clone_repo: ${repoName} already exists at ${existing} (idempotent)`);
      return ok(`Repo already present at ${existing}`);
    }

    const reposDir = getReposDir();
    const destDir = path.join(reposDir, repoName);
    // A prior failed clone can leave a dir behind with no .git, which would
    // break create_worktree downstream. Only auto-clear it if it is EMPTY — a
    // non-empty no-.git dir may hold real files (a partial clone, or something
    // an operator placed there) and we must never blindly destroy it. Surface
    // an error instead so the caller decides.
    if (fs.existsSync(destDir)) {
      let entries: string[];
      try {
        entries = fs.readdirSync(destDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Cannot inspect existing path ${destDir}: ${msg}`);
      }
      if (entries.length === 0) {
        log(`clone_repo: ${destDir} is an empty no-.git dir — clearing before clone`);
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        return err(
          `Destination ${destDir} already exists, is not a git clone, and is not empty ` +
            `(${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}). Refusing to destroy it. ` +
            `Remove it manually or choose a different name, then retry.`,
        );
      }
    }
    try { fs.mkdirSync(reposDir, { recursive: true }); } catch { /* ignore */ }

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

    const repoDir = resolveRepoDir(repo);
    if (!repoDir) {
      return err(`Repo not found in agent group: ${repo}. Run clone_repo first.`);
    }

    const worktreeDir = path.join(worktreesDir(), repo);

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
    //
    // Branch-mismatch guard (the XZO-40 / XZO-42 fix): the prior turn could
    // have `git checkout`-ed onto an arbitrary branch (e.g., bisecting,
    // inspecting an existing PR, or rebasing). On the NEXT call, blindly
    // rebasing whatever's currently checked out would silently land the new
    // work on the wrong branch — and a subsequent `git_push` could then
    // force-overwrite an unrelated PR's HEAD. Refuse instead, with an
    // actionable error: the caller can either (a) pass `branch: "<the
    // current branch>"` if it really wants to resume that work, or (b)
    // `git switch -c thread-...` to a fresh branch before retrying.
    if (fs.existsSync(worktreeDir)) {
      if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
        log(`create_worktree: corrupt worktree at ${worktreeDir}, removing`);
        try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        // Stale-attachment guard (codex #126 N4): refuse to reuse a worktree bound
        // to a clone other than the currently-resolved one (workgroup now shadows
        // the agent clone it was created against) rather than mixing object stores.
        const staleErr = staleWorktreeAttachmentError(worktreeDir, repo);
        if (staleErr) return err(staleErr);
        const current = tryGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (current && current !== branchName) {
          return err(
            `Worktree at ${worktreeDir} is currently on branch '${current}', not the requested '${branchName}'. ` +
              `To resume work on '${current}', pass branch: "${current}" explicitly. ` +
              `To start fresh, run \`git -C ${worktreeDir} switch -c ${branchName} origin/HEAD\` first, ` +
              `then retry create_worktree.`,
          );
        }
        if (!shouldRebase) {
          return ok(`Worktree ready at ${worktreeDir} (branch ${current ?? branchName}; explicit branch — not rebased)`);
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

    fs.mkdirSync(worktreesDir(), { recursive: true });

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

/**
 * Locate the shared post-commit blast-radius analyzer. It is the SAME .cjs the
 * Claude container runs as a PostToolUse hook — reused here (not reimplemented)
 * so the two paths can never drift. Always-mounted at /workspace/plugins/
 * nanoclaw-hooks; the env override exists for tests and non-standard mounts.
 */
function findPostCommitCjs(): string | null {
  const candidates = [
    process.env.NANOCLAW_POSTCOMMIT_CJS,
    process.env.CLAUDE_PLUGINS_ROOT
      ? path.join(process.env.CLAUDE_PLUGINS_ROOT, 'nanoclaw-hooks/hooks/post-commit-verify.cjs')
      : undefined,
    '/workspace/plugins/nanoclaw-hooks/hooks/post-commit-verify.cjs',
    '/workspace/project/container/nanoclaw-plugin/hooks/post-commit-verify.cjs',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Best-effort GitNexus blast-radius checklist for the commit just made in
 * `worktreeDir`. Container agents commit via this MCP tool (not raw `git
 * commit`), so a Bash-matched hook never sees these commits — running the
 * analyzer here is what gives BOTH Claude and OpenCode siblings the advisory on
 * their real commit path.
 *
 * Fail-safe by construction: a missing analyzer, missing/stale index, timeout,
 * or any error returns null and git_commit returns its plain result. The
 * advisory must never block, delay unduly, or fail a commit — so the analyzer
 * runs under a tight self-limiting budget with a hard process cap above it.
 */
export function blastRadiusAdvisory(worktreeDir: string): string | null {
  const cjs = findPostCommitCjs();
  if (!cjs) return null;
  try {
    const input = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit' },
      tool_output: { exit_code: 0 },
      cwd: worktreeDir,
    });
    const out = execFileSync('node', [cjs], {
      input,
      cwd: worktreeDir,
      encoding: 'utf-8',
      // The .cjs self-limits to this budget (printing partial results); the
      // process timeout below is a backstop slightly above it.
      env: { ...process.env, GITNEXUS_ADVISORY_BUDGET_MS: '12000' },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = (out || '').trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as { hookSpecificOutput?: { additionalContext?: string } };
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' && ctx.trim() ? ctx.trim() : null;
  } catch {
    return null;
  }
}

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

    const worktreeDir = path.join(worktreesDir(), repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}. Run create_worktree first.`);
    }
    // Refuse to commit into a worktree bound to a shadowed clone (codex #126 N5).
    const staleErr = staleWorktreeAttachmentError(worktreeDir, repo);
    if (staleErr) return err(staleErr);

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
      const advisory = blastRadiusAdvisory(worktreeDir);
      return ok(advisory ? `Committed ${sha}\n\n${advisory}` : `Committed ${sha}`);
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

    const worktreeDir = path.join(worktreesDir(), repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}.`);
    }
    // Refuse to push from a worktree bound to a shadowed clone (codex #126 N5):
    // pushing would publish the OLD clone's branch, not the resolved clone's.
    const staleErr = staleWorktreeAttachmentError(worktreeDir, repo);
    if (staleErr) return err(staleErr);

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

    const worktreeDir = path.join(worktreesDir(), repo);
    if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
      return err(`Worktree not found: ${repo}.`);
    }
    // Refuse to open a PR from a worktree bound to a shadowed clone (codex #126 N5).
    const staleErr = staleWorktreeAttachmentError(worktreeDir, repo);
    if (staleErr) return err(staleErr);

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
