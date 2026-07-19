import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  graphifyCacheDir,
  getReposDir,
  resolveRepoDir,
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  openPrTool,
} from './git-worktrees';

// ---------------------------------------------------------------------------
// getReposDir / resolveRepoDir / clone_repo (Group G — workgroup repoint)
//
// These exercise the real filesystem rather than module mocks. The
// dir-resolution helpers read
// their base paths from NANOCLAW_*_DIR_OVERRIDE env vars (a test-only escape
// hatch that production never sets), so we point them at fresh temp dirs.
// ---------------------------------------------------------------------------

/** Init a real git repo at <dir> with `origin` set to <originUrl>. */
function initRepoWithOrigin(dir: string, originUrl: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir, stdio: 'pipe' });
}

describe('getReposDir / resolveRepoDir / clone_repo', () => {
  let root: string;
  let agentDir: string;
  let workgroupDir: string;
  const ENV_KEYS = [
    'NANOCLAW_AGENT_DIR_OVERRIDE',
    'NANOCLAW_WORKTREES_DIR_OVERRIDE',
    'NANOCLAW_WORKGROUP_DIR_OVERRIDE',
    'NANOCLAW_GRAPHIFY_CACHE_DIR_OVERRIDE',
    'NANOCLAW_WORKGROUP_ID',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    root = mkdtempSync(join(tmpdir(), 'gw-'));
    agentDir = join(root, 'agent');
    workgroupDir = join(root, 'workgroup');
    mkdirSync(agentDir, { recursive: true });

    process.env.NANOCLAW_AGENT_DIR_OVERRIDE = agentDir;
    process.env.NANOCLAW_WORKGROUP_DIR_OVERRIDE = workgroupDir;
    process.env.NANOCLAW_WORKTREES_DIR_OVERRIDE = join(root, 'worktrees');
    process.env.NANOCLAW_GRAPHIFY_CACHE_DIR_OVERRIDE = join(root, 'graphify-cache');
    delete process.env.NANOCLAW_WORKGROUP_ID;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --- G1: getReposDir() -------------------------------------------------

  test('test_repos_dir_workgroup_present: prefers workgroup/repos when mounted', () => {
    mkdirSync(workgroupDir, { recursive: true });
    expect(getReposDir()).toBe(join(workgroupDir, 'repos'));
  });

  test('test_repos_dir_no_workgroup_private: falls back to agent/repos with no workgroup + no env', () => {
    // workgroupDir does not exist, NANOCLAW_WORKGROUP_ID unset.
    expect(existsSync(workgroupDir)).toBe(false);
    expect(getReposDir()).toBe(join(agentDir, 'repos'));
  });

  test('test_repos_dir_expected_but_missing_warns: env set but dir absent → loud warn, not silent private', () => {
    process.env.NANOCLAW_WORKGROUP_ID = 'wg-test';
    expect(existsSync(workgroupDir)).toBe(false);

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      // Still returns the private dir so the op can proceed degraded...
      expect(getReposDir()).toBe(join(agentDir, 'repos'));
    } finally {
      console.error = origErr;
    }
    // ...but it must have logged loudly about the missing mount (not silent).
    const joined = warnings.join('\n');
    expect(joined).toContain('WARNING');
    expect(joined).toContain('wg-test');
    expect(joined.toLowerCase()).toContain('mount');
  });

  // --- G2: resolveRepoDir() ----------------------------------------------

  test('test_resolve_precedence_order: workgroup/repos > agent/repos > legacy agent/<name>', () => {
    const name = 'demo';
    const legacy = join(agentDir, name);
    const namespaced = join(agentDir, 'repos', name);
    const shared = join(workgroupDir, 'repos', name);

    // Only legacy exists → legacy wins.
    mkdirSync(join(legacy, '.git'), { recursive: true });
    expect(resolveRepoDir(name)).toBe(legacy);

    // Add namespaced private → outranks legacy.
    mkdirSync(join(namespaced, '.git'), { recursive: true });
    expect(resolveRepoDir(name)).toBe(namespaced);

    // Add workgroup shared → outranks everything.
    mkdirSync(join(shared, '.git'), { recursive: true });
    expect(resolveRepoDir(name)).toBe(shared);
  });

  test('test_resolve_legacy_fallback: only legacy agent/<name> present resolves to legacy', () => {
    const name = 'oldrepo';
    const legacy = join(agentDir, name);
    mkdirSync(join(legacy, '.git'), { recursive: true });
    // No namespaced, no workgroup copy.
    expect(resolveRepoDir(name)).toBe(legacy);
  });

  test('test_resolve_same_name_two_locations_warns: prefer higher-precedence AND warn (no silent shadow)', () => {
    const name = 'dup';
    const namespaced = join(agentDir, 'repos', name);
    const shared = join(workgroupDir, 'repos', name);
    // Two real clones of the same name, different origins to surface the mismatch note.
    initRepoWithOrigin(namespaced, 'https://github.com/acme/dup.git');
    initRepoWithOrigin(shared, 'https://github.com/other/dup.git');

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    let resolved: string | null;
    try {
      resolved = resolveRepoDir(name);
    } finally {
      console.error = origErr;
    }
    // Higher-precedence (workgroup shared) wins.
    expect(resolved).toBe(shared);
    // And a shadow warning was emitted naming the shadowed lower-precedence dir.
    const joined = warnings.join('\n');
    expect(joined).toContain('WARNING');
    expect(joined).toContain(namespaced);
    expect(joined).toContain('ORIGIN MISMATCH');
  });

  test('test_resolve_workgroup_root_legacy: a clone at the workgroup ROOT (pre-repos/) is resolved', () => {
    // Shared clones predating the repos/ namespacing live at /workspace/workgroup/<name>.
    // Without a candidate for the root, a sibling resolves null and clone_repo
    // re-clones a duplicate into repos/ — this is the fix that prevents that.
    const name = 'svc';
    const root = join(workgroupDir, name);
    initRepoWithOrigin(root, 'https://github.com/acme/svc.git');
    expect(resolveRepoDir(name)).toBe(root);
  });

  test('test_resolve_shared_root_beats_private: workgroup ROOT outranks a private bedroom clone', () => {
    // SHARED always wins over PRIVATE so siblings converge on the shared clone.
    const name = 'svc';
    const sharedRoot = join(workgroupDir, name);
    const privateNs = join(agentDir, 'repos', name);
    initRepoWithOrigin(privateNs, 'https://github.com/acme/svc.git');
    expect(resolveRepoDir(name)).toBe(privateNs); // only private exists → private
    initRepoWithOrigin(sharedRoot, 'https://github.com/acme/svc.git');
    expect(resolveRepoDir(name)).toBe(sharedRoot); // shared root now outranks private
  });

  test('test_resolve_symlink_alias_not_shadow: a bedroom symlink to the workgroup clone is NOT a shadow', () => {
    // agent/<name> -> workgroup/<name> is one shared clone reached two ways. The
    // realpath dedup must (a) return the workgroup path and (b) emit NO warning.
    const name = 'svc';
    const root = join(workgroupDir, name);
    initRepoWithOrigin(root, 'https://github.com/acme/svc.git');
    symlinkSync(root, join(agentDir, name)); // bedroom compat symlink

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    let resolved: string | null;
    try {
      resolved = resolveRepoDir(name);
    } finally {
      console.error = origErr;
    }
    expect(resolved).toBe(root); // canonical shared path, not the symlink
    expect(warnings.join('\n')).not.toContain('WARNING'); // symlink alias ≠ shadow
  });

  // --- G3: clone_repo ----------------------------------------------------

  test('test_clone_lands_in_workgroup: idempotent reuse resolves to workgroup/repos when mounted', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Pre-place a matching-origin clone in the workgroup tree.
    const shared = join(workgroupDir, 'repos', name);
    initRepoWithOrigin(shared, url);

    const res = await cloneRepoTool.handler({ url, name });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    // Reuse must report the workgroup destination, not the private agent dir.
    expect(text).toContain(shared);
    expect(text).not.toContain(join(agentDir, 'repos', name));
  });

  test('test_clone_origin_mismatch_errors: same-name dir with different origin is rejected (no silent reuse)', async () => {
    const name = 'svc';
    const wrong = join(agentDir, 'repos', name);
    initRepoWithOrigin(wrong, 'https://github.com/someoneelse/svc.git');

    const res = await cloneRepoTool.handler({ url: 'https://github.com/acme/svc', name });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('does not');
    expect(text).toContain('someoneelse/svc');
  });

  test('test_clone_null_origin_warns_not_silent_reuse (S-QA1): no-origin clone reused but flagged loudly', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // A .git dir with NO origin remote (partial clone / operator local-only repo).
    const noOrigin = join(workgroupDir, 'repos', name);
    mkdirSync(noOrigin, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: noOrigin, stdio: 'pipe' });

    const res = await cloneRepoTool.handler({ url, name });
    // Non-destructive: reused (not an error — a hard error would break legit
    // local-only repos), but the message flags the missing origin loudly so the
    // mismatch is resolvable rather than silently handing back the wrong repo.
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain(noOrigin);
    expect(text).toContain("NO 'origin' remote");
    expect(text).toContain(url);
  });

  test('test_worktree_stale_attachment_rejected (codex #126 N4): worktree bound to a shadowed clone errors', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Agent clone with a commit + a worktree ATTACHED to it.
    const agentClone = join(agentDir, 'repos', name);
    initRepoWithOrigin(agentClone, url);
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: agentClone, stdio: 'pipe' },
    );
    const worktreeDir = join(root, 'worktrees', name);
    execFileSync('git', ['worktree', 'add', '-b', 'thread-old', worktreeDir], { cwd: agentClone, stdio: 'pipe' });

    // A workgroup clone of the same name now SHADOWS the agent clone, so
    // resolveRepoDir returns it — but the worktree is still bound to the agent clone.
    const wgClone = join(workgroupDir, 'repos', name);
    initRepoWithOrigin(wgClone, url);
    expect(resolveRepoDir(name)).toBe(wgClone); // premise: workgroup now wins

    const res = await createWorktreeTool.handler({ repo: name });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('different clone');
  });

  test('test_commit_push_pr_reject_stale_worktree_attachment (codex #126 N5)', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Worktree attached to the agent clone...
    const agentClone = join(agentDir, 'repos', name);
    initRepoWithOrigin(agentClone, url);
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: agentClone, stdio: 'pipe' },
    );
    const worktreeDir = join(root, 'worktrees', name);
    execFileSync('git', ['worktree', 'add', '-b', 'thread-old', worktreeDir], { cwd: agentClone, stdio: 'pipe' });
    // ...then a workgroup clone shadows it.
    initRepoWithOrigin(join(workgroupDir, 'repos', name), url);

    // commit / push / open_pr must all refuse before doing any git/gh work.
    for (const tool of [gitCommitTool, gitPushTool, openPrTool]) {
      const res = await tool.handler({ repo: name, message: 'm', title: 't' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('different clone');
    }
  });

  test('test_clone_nonempty_no_git_dir_errors: non-empty no-.git destination is NOT destroyed', async () => {
    const name = 'svc';
    process.env.NANOCLAW_WORKGROUP_ID = undefined; // private path
    delete process.env.NANOCLAW_WORKGROUP_ID;
    const dest = join(agentDir, 'repos', name);
    mkdirSync(dest, { recursive: true });
    const precious = join(dest, 'IMPORTANT.txt');
    writeFileSync(precious, 'do not delete me');

    const res = await cloneRepoTool.handler({ url: 'https://github.com/acme/svc', name });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Refusing to destroy');
    // The non-empty dir and its contents must survive untouched.
    expect(existsSync(precious)).toBe(true);
    expect(readdirSync(dest)).toContain('IMPORTANT.txt');
  });

  test('test_clone_empty_no_git_dir_cleared: empty no-.git destination may be cleared (then clone attempted)', async () => {
    const name = 'svc';
    const dest = join(agentDir, 'repos', name);
    mkdirSync(dest, { recursive: true }); // empty, no .git

    // The clone itself targets github.com over the network, which is not
    // reachable here — so it fails AT THE CLONE step, not the guard. Proving
    // we got past the guard (no "Refusing to destroy") is the assertion that
    // an empty no-.git dir is permitted to be cleared.
    const res = await cloneRepoTool.handler({ url: 'https://github.com/acme/svc', name });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).not.toContain('Refusing to destroy');
    expect(text).toContain('git clone failed');
  });

  // --- codex #126 round-5 fixes ------------------------------------------

  test('test_stale_check_symlink_alias_not_false_rejected (codex #126): a worktree on a symlinked repo alias is NOT flagged stale', async () => {
    // Migration compat symlink: resolveRepoDir returns the symlink alias
    // (/workspace/agent/<name> -> real clone), but git --git-common-dir reports
    // the real target. A path.resolve()-only compare would call this "a different
    // clone" and false-reject every worktree op. canonPath() (realpath) must
    // reconcile them.
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Real clone living OUTSIDE the agent dir, with a commit + an attached worktree.
    const realClone = join(root, 'realhome', name);
    initRepoWithOrigin(realClone, url);
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: realClone, stdio: 'pipe' },
    );
    const branch = 'thread-session-svc'; // = defaultBranchName('svc') with no NANOCLAW_SESSION_ID
    const worktreeDir = join(root, 'worktrees', name);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreeDir], { cwd: realClone, stdio: 'pipe' });

    // Legacy candidate-3 path is a SYMLINK to the real clone; no workgroup/private
    // copies exist, so resolveRepoDir must return the symlink alias itself.
    symlinkSync(realClone, join(agentDir, name));
    expect(resolveRepoDir(name)).toBe(join(agentDir, name));
    // Sanity: the alias really does resolve to the real clone.
    expect(realpathSync(join(agentDir, name))).toBe(realpathSync(realClone));

    const res = await createWorktreeTool.handler({ repo: name });
    // The op may no-op/succeed (fetch is offline), but it must NOT mis-fire the
    // stale-attachment guard. Before the canonPath fix this returned "different clone".
    expect(res.content[0].text).not.toContain('different clone');
    expect(res.isError).toBeFalsy();
  });

  test('test_clone_refuses_private_reuse_when_shared_mounted (codex #126): silent bedroom reuse is rejected', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Shared tree IS mounted, but the only existing clone is PRIVATE (bedroom).
    mkdirSync(workgroupDir, { recursive: true });
    const privateClone = join(agentDir, 'repos', name);
    initRepoWithOrigin(privateClone, url);
    expect(resolveRepoDir(name)).toBe(privateClone); // premise: private resolves

    const res = await cloneRepoTool.handler({ url, name });
    // Refuse loudly — a private clone is invisible to siblings under shared-FS.
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('PRIVATE');
    expect(text).toContain(privateClone);
    expect(text).toContain(join(workgroupDir, 'repos', name)); // the relocation hint
  });

  test('test_clone_symlinked_shared_repo_not_refused (codex #126): compat symlink whose realpath is in the shared tree is reused, not flagged private', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // Shared tree mounted; the real clone lives in the workgroup tree, exposed to
    // the agent only through the migration compat symlink /agent/<name> -> /workgroup/<name>.
    mkdirSync(workgroupDir, { recursive: true });
    const realInShared = join(workgroupDir, name); // realpath under the shared tree
    initRepoWithOrigin(realInShared, url);
    symlinkSync(realInShared, join(agentDir, name));
    // resolveRepoDir prefers the canonical workgroup ROOT clone (candidate 2) over
    // the bedroom symlink (candidate 4) — same real clone, canonical path returned.
    expect(resolveRepoDir(name)).toBe(realInShared);

    const res = await cloneRepoTool.handler({ url, name });
    // Its realpath is inside the workgroup tree → siblings CAN see it → reuse, not refuse.
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain('PRIVATE');
  });

  test('test_clone_private_reuse_ok_when_no_shared_tree (codex #126): degraded mode still reuses the bedroom clone', async () => {
    const name = 'svc';
    const url = 'https://github.com/acme/svc';
    // No workgroup mounted (default) — private reuse must still work, gate stays off.
    expect(existsSync(workgroupDir)).toBe(false);
    const privateClone = join(agentDir, 'repos', name);
    initRepoWithOrigin(privateClone, url);

    const res = await cloneRepoTool.handler({ url, name });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain(privateClone);
    expect(text).not.toContain('PRIVATE'); // the new gate did NOT fire
  });

  test('test_corrupt_worktree_replacement_removes_matching_graphify_cache', async () => {
    const name = 'corrupt-repo';
    const repo = join(agentDir, 'repos', name);
    initRepoWithOrigin(repo, 'https://github.com/acme/corrupt-repo.git');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      stdio: 'pipe',
    });
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'pipe' });

    const corruptWorktree = join(root, 'worktrees', name);
    mkdirSync(corruptWorktree, { recursive: true });
    writeFileSync(join(corruptWorktree, 'partial-checkout'), 'corrupt');
    const cache = graphifyCacheDir(name);
    mkdirSync(join(cache, 'timeout-debris'), { recursive: true });
    writeFileSync(join(cache, 'enospc.partial'), 'partial');
    writeFileSync(join(cache, 'lock'), '');

    const response = await createWorktreeTool.handler({ repo: name, branch: 'feature' });

    expect(response.isError).toBeFalsy();
    expect(existsSync(join(corruptWorktree, '.git'))).toBe(true);
    expect(existsSync(cache)).toBe(false);
  });

  test('test_valid_worktree_reuse_keeps_graphify_cache', async () => {
    const name = 'valid-repo';
    const repo = join(agentDir, 'repos', name);
    initRepoWithOrigin(repo, 'https://github.com/acme/valid-repo.git');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const worktree = join(root, 'worktrees', name);
    execFileSync('git', ['worktree', 'add', '-b', 'feature', worktree], { cwd: repo, stdio: 'pipe' });
    const cache = graphifyCacheDir(name);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'index.db'), 'stable');

    const reused = await createWorktreeTool.handler({ repo: name, branch: 'feature' });
    expect(reused.isError).toBeFalsy();
    expect(existsSync(join(cache, 'index.db'))).toBe(true);

    const mismatch = await createWorktreeTool.handler({ repo: name, branch: 'different-branch' });
    expect(mismatch.isError).toBe(true);
    expect(existsSync(join(cache, 'index.db'))).toBe(true);

    writeFileSync(join(worktree, 'dirty.ts'), 'uncommitted');
    const editedReuse = await createWorktreeTool.handler({ repo: name, branch: 'feature' });
    expect(editedReuse.isError).toBeFalsy();
    expect(existsSync(join(cache, 'index.db'))).toBe(true);
  });

  test('test_git_commit_returns_sha_without_advisory_subprocess', async () => {
    const name = 'commit-repo';
    const repo = join(agentDir, 'repos', name);
    initRepoWithOrigin(repo, 'https://github.com/acme/commit-repo.git');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const worktree = join(root, 'worktrees', name);
    execFileSync('git', ['worktree', 'add', '-b', 'feature', worktree], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(worktree, 'changed.ts'), 'export const changed = true;\n');

    const fakeBin = join(root, 'fake-bin');
    const nodeCanary = join(root, 'node-was-run');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch "${nodeCanary}"\nexit 99\n`);
    chmodSync(join(fakeBin, 'node'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    try {
      const response = await gitCommitTool.handler({ repo: name, message: 'commit everything' });
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: worktree,
        encoding: 'utf-8',
      }).trim();
      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toBe(`Committed ${sha}`);
      expect(existsSync(nodeCanary)).toBe(false);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf-8' }).trim()).toBe('');
      expect(
        execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: worktree, encoding: 'utf-8' }).trim(),
      ).toBe('agent <agent@nanoclaw.local>');
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
