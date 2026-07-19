import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({
  dataDir: `/tmp/worktree-cleanup-data-${process.pid}-${Date.now()}`,
  groupsDir: `/tmp/worktree-cleanup-groups-${process.pid}-${Date.now()}`,
}));

const dbRows = vi.hoisted(() => ({
  value: [] as Array<{ session_id: string; agent_group_id: string; thread_id: string | null; platform_id: string }>,
}));

const runtimeState = vi.hoisted(() => ({
  liveSessions: new Set<string>(),
  missingSessions: new Set<string>(),
}));

const gitState = vi.hoisted(() => ({
  dirty: false,
  unpushed: false,
  branch: 'feature/cleanup',
  merged: true,
  branchGone: false,
  statusFails: false,
  logFails: false,
  removeFails: false,
}));

const childProcessMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: childProcessMocks.execSync,
  execFileSync: childProcessMocks.execFileSync,
}));

vi.mock('./config.js', () => ({
  DATA_DIR: roots.dataDir,
  GROUPS_DIR: roots.groupsDir,
}));

vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn((sessionId: string) => runtimeState.liveSessions.has(sessionId)),
}));

vi.mock('./db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => dbRows.value,
    }),
  }),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => {
    if (id === 'ag-1') return { id, name: 'one', folder: 'alpha', agent_provider: null, created_at: '' };
    if (id === 'ag-2') return { id, name: 'two', folder: 'beta', agent_provider: null, created_at: '' };
    return undefined;
  },
}));

vi.mock('./db/sessions.js', () => ({
  getSession: (id: string) => (runtimeState.missingSessions.has(id) ? undefined : { id }),
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogScrubber: vi.fn(),
}));

import {
  _cleanupOneForTesting,
  _cleanupOrphanGraphifyCacheForTesting,
  _discoverOrphanGraphifyCachesForTesting,
  _discoverWorktreesForTesting,
} from './worktree-cleanup.js';
import { isContainerRunning } from './container-runner.js';

function sessionPaths(repo = 'repo-a', sessionId = 'sess-1') {
  const sessionRoot = path.join(roots.dataDir, 'v2-sessions', 'ag-1', sessionId);
  return {
    canonicalRepo: path.join(roots.groupsDir, 'alpha', repo),
    worktree: path.join(sessionRoot, 'worktrees', repo),
    cache: path.join(sessionRoot, 'graphify-cache', repo),
    lock: path.join(sessionRoot, 'graphify-cache', repo, 'lock'),
  };
}

function createSessionTarget(repo = 'repo-a', sessionId = 'sess-1') {
  const paths = sessionPaths(repo, sessionId);
  fs.mkdirSync(path.join(paths.canonicalRepo, '.git'), { recursive: true });
  fs.mkdirSync(paths.worktree, { recursive: true });
  fs.mkdirSync(paths.cache, { recursive: true });
  fs.writeFileSync(path.join(paths.cache, 'index.db'), 'cache');
  const target = _discoverWorktreesForTesting().find(
    (candidate) => candidate.scope === 'session' && candidate.repo === repo && candidate.sessionId === sessionId,
  );
  expect(target).toBeDefined();
  return { target: target!, paths };
}

describe('worktree-cleanup thread worktree discovery', () => {
  beforeEach(() => {
    dbRows.value = [];
    runtimeState.liveSessions.clear();
    runtimeState.missingSessions.clear();
    gitState.dirty = false;
    gitState.unpushed = false;
    gitState.branch = 'feature/cleanup';
    gitState.merged = true;
    gitState.branchGone = false;
    gitState.statusFails = false;
    gitState.logFails = false;
    gitState.removeFails = false;
    vi.mocked(isContainerRunning).mockClear();
    childProcessMocks.execSync.mockReset();
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.execSync.mockImplementation((command: string) => {
      if (command === 'git status --porcelain') {
        if (gitState.statusFails) throw new Error('status failed');
        return gitState.dirty ? ' M file.ts' : '';
      }
      if (command === 'git log HEAD --not --remotes --oneline') {
        if (gitState.logFails) throw new Error('log failed');
        return gitState.unpushed ? 'abc123 local commit' : '';
      }
      if (command === 'git rev-parse --abbrev-ref HEAD') return gitState.branch;
      if (command.startsWith('gh pr list ')) return gitState.merged ? '[{"number":1}]' : '[]';
      if (command.startsWith('git ls-remote ')) {
        return gitState.branchGone ? '' : `abc123\trefs/heads/${gitState.branch}`;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    childProcessMocks.execFileSync.mockImplementation((_file: string, args: string[]) => {
      if (gitState.removeFails && args.includes('remove')) throw new Error('git worktree remove failed');
      return '';
    });
    fs.rmSync(roots.dataDir, { recursive: true, force: true });
    fs.rmSync(roots.groupsDir, { recursive: true, force: true });
    fs.mkdirSync(roots.dataDir, { recursive: true });
    fs.mkdirSync(roots.groupsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(roots.dataDir, { recursive: true, force: true });
    fs.rmSync(roots.groupsDir, { recursive: true, force: true });
  });

  it('discovers thread-scoped worktrees and maps all sibling sessions to the cleanup gate', () => {
    const worktreeRepo = path.join(roots.dataDir, 'v2-threads', 'slack_C_1', 'worktrees', 'repo-a');
    fs.mkdirSync(worktreeRepo, { recursive: true });
    fs.mkdirSync(path.join(roots.groupsDir, 'alpha', 'repo-a', '.git'), { recursive: true });
    fs.mkdirSync(path.join(roots.groupsDir, 'beta', 'repo-a', '.git'), { recursive: true });

    dbRows.value = [
      { session_id: 'sess-1', agent_group_id: 'ag-1', thread_id: 'slack:C:1', platform_id: 'slack:C' },
      { session_id: 'sess-2', agent_group_id: 'ag-2', thread_id: 'slack:C:1', platform_id: 'slack:C' },
    ];

    const threadTargets = _discoverWorktreesForTesting().filter((target) => target.scope === 'thread');

    expect(threadTargets).toHaveLength(1);
    expect(threadTargets[0]).toMatchObject({
      scope: 'thread',
      repo: 'repo-a',
      worktreePath: worktreeRepo,
      canonicalRepoPath: path.join(roots.groupsDir, 'alpha', 'repo-a'),
      sessionIds: ['sess-1', 'sess-2'],
      graphifyCachePath: path.join(roots.dataDir, 'v2-threads', 'slack_C_1', 'graphify-cache', 'repo-a'),
    });
  });

  it('test_safe_worktree_removal_deletes_matching_cache_after_git', () => {
    const { target, paths } = createSessionTarget();
    const cacheStateDuringGit: boolean[] = [];
    childProcessMocks.execFileSync.mockImplementation(() => {
      cacheStateDuringGit.push(fs.existsSync(paths.cache));
      return '';
    });

    _cleanupOneForTesting(target);

    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['worktree', 'remove', '--force', paths.worktree],
      expect.objectContaining({ cwd: paths.canonicalRepo }),
    );
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['worktree', 'prune'],
      expect.objectContaining({ cwd: paths.canonicalRepo }),
    );
    expect(cacheStateDuringGit).toEqual([true, true]);
    expect(fs.existsSync(paths.cache)).toBe(false);
  });

  it('test_live_dirty_unpushed_and_failed_git_preserve_cache', () => {
    const cases: Array<{ name: string; arrange: (paths: ReturnType<typeof sessionPaths>) => void }> = [
      { name: 'live', arrange: () => runtimeState.liveSessions.add('sess-1') },
      { name: 'dirty', arrange: () => (gitState.dirty = true) },
      { name: 'unpushed', arrange: () => (gitState.unpushed = true) },
      { name: 'status-fail', arrange: () => (gitState.statusFails = true) },
      { name: 'log-fail', arrange: () => (gitState.logFails = true) },
      { name: 'detached-recent', arrange: () => (gitState.branch = 'HEAD') },
      {
        name: 'missing-canonical',
        arrange: (paths) => fs.rmSync(path.join(paths.canonicalRepo, '.git'), { recursive: true }),
      },
      { name: 'unknown-session', arrange: () => runtimeState.missingSessions.add('sess-1') },
      { name: 'git-fail', arrange: () => (gitState.removeFails = true) },
    ];

    for (const testCase of cases) {
      runtimeState.liveSessions.clear();
      runtimeState.missingSessions.clear();
      gitState.dirty = false;
      gitState.unpushed = false;
      gitState.statusFails = false;
      gitState.logFails = false;
      gitState.branch = 'feature/cleanup';
      gitState.removeFails = false;
      fs.rmSync(path.join(roots.dataDir, 'v2-sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(roots.groupsDir, 'alpha'), { recursive: true, force: true });
      const { target, paths } = createSessionTarget();
      testCase.arrange(paths);

      _cleanupOneForTesting(target);

      expect(fs.existsSync(paths.cache), `${testCase.name} must preserve cache`).toBe(true);
    }
  });

  it('test_thread_sibling_guard_checks_all_participants', () => {
    const worktreeRepo = path.join(roots.dataDir, 'v2-threads', 'slack_C_1', 'worktrees', 'repo-a');
    const cacheRepo = path.join(roots.dataDir, 'v2-threads', 'slack_C_1', 'graphify-cache', 'repo-a');
    fs.mkdirSync(worktreeRepo, { recursive: true });
    fs.mkdirSync(cacheRepo, { recursive: true });
    fs.mkdirSync(path.join(roots.groupsDir, 'alpha', 'repo-a', '.git'), { recursive: true });
    dbRows.value = [
      { session_id: 'sess-1', agent_group_id: 'ag-1', thread_id: 'slack:C:1', platform_id: 'slack:C' },
      { session_id: 'sess-2', agent_group_id: 'ag-2', thread_id: 'slack:C:1', platform_id: 'slack:C' },
    ];
    runtimeState.liveSessions.add('sess-2');
    const target = _discoverWorktreesForTesting().find((candidate) => candidate.scope === 'thread')!;

    _cleanupOneForTesting(target);

    expect(vi.mocked(isContainerRunning).mock.calls.map(([id]) => id)).toEqual(['sess-1', 'sess-2']);
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreeRepo)).toBe(true);
    expect(fs.existsSync(cacheRepo)).toBe(true);
  });

  it('test_active_gateway_lock_holder_preserves_worktree_and_cache', async () => {
    const { target, paths } = createSessionTarget();
    fs.writeFileSync(paths.lock, '');
    const inodeBefore = fs.statSync(paths.lock).ino;
    const holder = spawn('flock', ['-x', paths.lock, 'sh', '-c', 'echo locked; read _'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout!.once('data', () => resolve());
    });

    try {
      runtimeState.liveSessions.add('sess-1');
      _cleanupOneForTesting(target);

      expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
      expect(fs.existsSync(paths.worktree)).toBe(true);
      expect(fs.existsSync(paths.cache)).toBe(true);
      expect(fs.statSync(paths.lock).ino).toBe(inodeBefore);
    } finally {
      holder.stdin!.end();
      await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    }
  });

  it('test_orphan_cache_prunes_only_without_live_owner_or_worktree', () => {
    const inactive = sessionPaths('orphan-inactive', 'sess-1');
    fs.mkdirSync(inactive.cache, { recursive: true });
    const live = sessionPaths('orphan-live', 'sess-live');
    fs.mkdirSync(live.cache, { recursive: true });
    runtimeState.liveSessions.add('sess-live');
    const stillHasWorktree = sessionPaths('not-orphan', 'sess-1');
    fs.mkdirSync(stillHasWorktree.cache, { recursive: true });
    fs.mkdirSync(stillHasWorktree.worktree, { recursive: true });

    const orphans = _discoverOrphanGraphifyCachesForTesting();
    expect(orphans.map((target) => target.repo).sort()).toEqual(['orphan-inactive', 'orphan-live']);
    for (const orphan of orphans) _cleanupOrphanGraphifyCacheForTesting(orphan);

    expect(fs.existsSync(inactive.cache)).toBe(false);
    expect(fs.existsSync(live.cache)).toBe(true);
    expect(fs.existsSync(stillHasWorktree.cache)).toBe(true);

    const canary = path.join(roots.dataDir, 'canary');
    fs.mkdirSync(canary, { recursive: true });
    _cleanupOrphanGraphifyCacheForTesting({
      scope: 'session',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      sessionIds: ['sess-1'],
      repo: 'escape',
      worktreePath: path.join(roots.dataDir, 'v2-sessions', 'ag-1', 'sess-1', 'worktrees', 'escape'),
      graphifyCachePath: canary,
    });
    expect(fs.existsSync(canary)).toBe(true);
  });
});
