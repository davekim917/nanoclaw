import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  blastRadiusAdvisory,
  getReposDir,
  resolveRepoDir,
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  openPrTool,
} from './git-worktrees';

// The advisory shells out to `node <post-commit-verify.cjs>`. Where node is
// absent the helper must fail safe (return null) — but the parse-path tests
// genuinely need node, so guard them. The container image ships node 22.
function nodeAvailable(): boolean {
  try {
    execFileSync('node', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const hasNode = nodeAvailable();

/** Run blastRadiusAdvisory with NANOCLAW_POSTCOMMIT_CJS pointed at `cjs`. */
function withAnalyzer(cjs: string, worktreeDir: string): string | null {
  const prev = process.env.NANOCLAW_POSTCOMMIT_CJS;
  const prevRoot = process.env.CLAUDE_PLUGINS_ROOT;
  process.env.NANOCLAW_POSTCOMMIT_CJS = cjs;
  delete process.env.CLAUDE_PLUGINS_ROOT; // don't let a real mount interfere
  try {
    return blastRadiusAdvisory(worktreeDir);
  } finally {
    if (prev !== undefined) process.env.NANOCLAW_POSTCOMMIT_CJS = prev;
    else delete process.env.NANOCLAW_POSTCOMMIT_CJS;
    if (prevRoot !== undefined) process.env.CLAUDE_PLUGINS_ROOT = prevRoot;
  }
}

function stubAnalyzer(body: string): { dir: string; cjs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pcv-'));
  const cjs = join(dir, 'stub.cjs');
  writeFileSync(cjs, body);
  return { dir, cjs };
}

describe('blastRadiusAdvisory', () => {
  test('returns null when no analyzer .cjs is resolvable (fail-safe)', () => {
    expect(withAnalyzer('/nonexistent/post-commit-verify.cjs', tmpdir())).toBeNull();
  });

  test.skipIf(!hasNode)('parses additionalContext from analyzer stdout', () => {
    const { dir, cjs } = stubAnalyzer(
      `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '## Post-Commit Verification CHECKLIST-MARKER' } }));`,
    );
    expect(withAnalyzer(cjs, dir)).toContain('CHECKLIST-MARKER');
  });

  test.skipIf(!hasNode)('returns null on empty analyzer output (no index / early-return)', () => {
    const { dir, cjs } = stubAnalyzer(`// analyzer printed nothing — mirrors the no-index early return`);
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });

  test.skipIf(!hasNode)('returns null on malformed analyzer output (fail-safe parse)', () => {
    const { dir, cjs } = stubAnalyzer(`console.log('not json at all');`);
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });

  test.skipIf(!hasNode)('returns null when additionalContext is blank', () => {
    const { dir, cjs } = stubAnalyzer(
      `console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: '   ' } }));`,
    );
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getReposDir / resolveRepoDir / clone_repo (Group G — workgroup repoint)
//
// These exercise the real filesystem (matching the blastRadiusAdvisory tests'
// real-dir style rather than module mocks). The dir-resolution helpers read
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
});
