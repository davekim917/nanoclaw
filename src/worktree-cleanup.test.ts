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

vi.mock('./config.js', () => ({
  DATA_DIR: roots.dataDir,
  GROUPS_DIR: roots.groupsDir,
}));

vi.mock('./container-runner.js', () => ({
  isContainerRunning: () => false,
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
  getSession: (id: string) => ({ id }),
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogScrubber: vi.fn(),
}));

import { _discoverWorktreesForTesting } from './worktree-cleanup.js';

describe('worktree-cleanup thread worktree discovery', () => {
  beforeEach(() => {
    dbRows.value = [];
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
    });
  });
});
