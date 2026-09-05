import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const groups = vi.hoisted(() => ({ rows: [] as Array<{ id: string; folder: string }> }));

vi.mock('./db/agent-groups.js', () => ({ getAllAgentGroups: () => groups.rows }));
vi.mock('./db/backlog.js', () => ({
  addShipLogEntry: vi.fn(),
  getCommitDigestState: vi.fn(),
  upsertCommitDigestState: vi.fn(),
}));
vi.mock('./host-lifecycle.js', () => ({ onHostShutdown: vi.fn(), onHostStart: vi.fn() }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import { discoverRepos, runCommitScanOnce } from './commit-scan.js';
import { log } from './log.js';
import { allowSubprocess, enforceHermeticity } from './test-hermeticity.js';

enforceHermeticity();

const roots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-scan-'));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@invalid', '-c', 'user.name=test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function initializeRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'fixture\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'fixture']);
}

beforeAll(() => {
  allowSubprocess(['git']);
});

afterEach(() => {
  vi.clearAllMocks();
  groups.rows = [];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('commit scan repository discovery', () => {
  it('skips an invalid container-absolute gitdir before branch probes without writing raw stderr', async () => {
    const root = fixtureRoot();
    const groupDir = path.join(root, 'group-fixture');
    const broken = path.join(groupDir, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /workspace/workgroup/missing/.git/worktrees/fixture\n');
    groups.rows = [{ id: 'group-fixture', folder: 'group-fixture' }];
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await runCommitScanOnce(root);

      expect(stderrWrite).not.toHaveBeenCalled();
      const failures = vi
        .mocked(log.debug)
        .mock.calls.filter(([message]) => message === 'Commit scan Git command failed');
      expect(failures).not.toHaveLength(0);
      expect(failures).toEqual(
        expect.arrayContaining([
          [
            'Commit scan Git command failed',
            expect.objectContaining({ repo: broken, operation: 'validate checkout', error: expect.any(String) }),
          ],
        ]),
      );
      expect(failures.every(([, details]) => details?.operation === 'validate checkout')).toBe(true);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('discovers normal repositories and linked worktrees with relative gitdir metadata', () => {
    const root = fixtureRoot();
    const repo = path.join(root, 'normal');
    const linked = path.join(root, 'linked');
    initializeRepo(repo);
    git(repo, ['worktree', 'add', '-q', '-b', 'fixture-topic', linked, 'HEAD']);

    const pointer = fs.readFileSync(path.join(linked, '.git'), 'utf8').trim();
    const gitDir = pointer.slice('gitdir: '.length);
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.relative(linked, gitDir)}\n`);

    expect(discoverRepos(root).sort()).toEqual([linked, repo].sort());
    expect(log.debug).not.toHaveBeenCalled();
  });
});
