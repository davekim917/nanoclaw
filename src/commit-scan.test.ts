import cpSync, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const groups = vi.hoisted(() => ({ rows: [] as Array<{ id: string; folder: string }> }));

vi.mock('./db/agent-groups.js', () => ({ getAllAgentGroups: () => groups.rows }));
vi.mock('./db/backlog.js', () => ({
  addShipLogEntry: vi.fn(async () => undefined),
  getCommitDigestState: vi.fn(async () => null),
  upsertCommitDigestState: vi.fn(async () => undefined),
}));
vi.mock('./host-lifecycle.js', () => ({ onHostShutdown: vi.fn(), onHostStart: vi.fn() }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import { discoverRepos, runCommitScanOnce } from './commit-scan.js';
import { addShipLogEntry, getCommitDigestState, upsertCommitDigestState } from './db/backlog.js';
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

  it('discovers normal repositories and linked worktrees with relative gitdir metadata', async () => {
    const root = fixtureRoot();
    const repo = path.join(root, 'normal');
    const linked = path.join(root, 'linked');
    initializeRepo(repo);
    git(repo, ['worktree', 'add', '-q', '-b', 'fixture-topic', linked, 'HEAD']);

    const pointer = fs.readFileSync(path.join(linked, '.git'), 'utf8').trim();
    const gitDir = pointer.slice('gitdir: '.length);
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.relative(linked, gitDir)}\n`);

    expect((await discoverRepos(root)).sort()).toEqual([linked, repo].sort());
    expect(log.debug).not.toHaveBeenCalled();
  });
});

/**
 * Guards the readGit → execFileAsync conversion (issue #648): readGit must
 * never fall back to execFileSync (which blocks the host event loop for the
 * ~10-12s a full scan across every group repo used to cost), and the scan's
 * recorded output for the same repo state must be unchanged by the switch to
 * the promisified `execFile`.
 */
describe('commit scan recording (async git, behavior parity with #648)', () => {
  /** A real "pushed" repo, plus a clone with an `origin` remote pointing at
   *  it — `getDefaultBranch`/`fetchOrigin`/`getLatestCommitSha` all key off
   *  `origin/<branch>`, and `git clone` is the simplest way to get a working
   *  `refs/remotes/origin/HEAD` symref without hand-assembling one. */
  function initializeOriginAndClone(
    root: string,
    groupFolder: string,
    repoName: string,
  ): { originDir: string; cloneDir: string } {
    const originDir = path.join(root, `${repoName}-upstream`);
    initializeRepo(originDir);
    const groupDir = path.join(root, groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });
    const cloneDir = path.join(groupDir, repoName);
    git(root, ['clone', '-q', originDir, cloneDir]);
    return { originDir, cloneDir };
  }

  function commitToOrigin(originDir: string, message: string): void {
    const file = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
    fs.writeFileSync(path.join(originDir, file), message);
    git(originDir, ['add', '-A']);
    git(originDir, ['commit', '-q', '-m', message]);
  }

  /** Spies on execFileSync and makes it throw AND record the call, so a
   *  regression back to the sync API fails the test even if readGit's own
   *  try/catch would otherwise swallow the forced error (test-hermeticity.ts
   *  documents this exact swallow risk; pattern mirrored from
   *  agent-runner-image-check.test.ts's sync-surface tripwire). */
  function installExecFileSyncTripwire(): { record: string[]; restore: () => void } {
    const record: string[] = [];
    const spy = vi.spyOn(cpSync, 'execFileSync').mockImplementation(((...args: unknown[]) => {
      record.push('execFileSync');
      throw new Error(`sync git call attempted by production code: execFileSync(${JSON.stringify(args[0])})`);
    }) as typeof cpSync.execFileSync);
    return { record, restore: () => spy.mockRestore() };
  }

  it("records a first scan's commits, upserts digest state, and never calls execFileSync", async () => {
    const root = fixtureRoot();
    const { originDir, cloneDir } = initializeOriginAndClone(root, 'group-commits', 'repo');
    groups.rows = [{ id: 'group-commits', folder: 'group-commits' }];

    const originHead = git(originDir, ['rev-parse', 'HEAD']);
    const originSubject = git(originDir, ['log', '-1', '--format=%s']);

    const tripwire = installExecFileSyncTripwire();
    try {
      await runCommitScanOnce(root);
    } finally {
      tripwire.restore();
    }
    expect(tripwire.record).toEqual([]);

    expect(vi.mocked(upsertCommitDigestState)).toHaveBeenCalledWith(
      expect.objectContaining({
        repo_path: cloneDir,
        agent_group_id: 'group-commits',
        last_commit_sha: originHead,
      }),
    );
    expect(vi.mocked(addShipLogEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_group_id: 'group-commits',
        title: `repo: ${originSubject}`,
        description: expect.stringContaining(originSubject),
        pr_url: null,
        branch: 'main',
        tags: 'commit-digest,repo',
      }),
    );
  });

  it('records only the new direct commit on a rescan against prior state, still without execFileSync', async () => {
    const root = fixtureRoot();
    const { originDir, cloneDir } = initializeOriginAndClone(root, 'group-rescan', 'repo');
    groups.rows = [{ id: 'group-rescan', folder: 'group-rescan' }];

    const firstSha = git(originDir, ['rev-parse', 'HEAD']);
    vi.mocked(getCommitDigestState).mockResolvedValueOnce({
      repo_path: cloneDir,
      agent_group_id: 'group-rescan',
      last_commit_sha: firstSha,
      last_scan: new Date().toISOString(),
    });

    commitToOrigin(originDir, 'second commit');
    const secondSha = git(originDir, ['rev-parse', 'HEAD']);

    const tripwire = installExecFileSyncTripwire();
    try {
      await runCommitScanOnce(root);
    } finally {
      tripwire.restore();
    }
    expect(tripwire.record).toEqual([]);

    expect(vi.mocked(upsertCommitDigestState)).toHaveBeenCalledWith(
      expect.objectContaining({ repo_path: cloneDir, agent_group_id: 'group-rescan', last_commit_sha: secondSha }),
    );
    expect(vi.mocked(addShipLogEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_group_id: 'group-rescan',
        title: 'repo: second commit',
        branch: 'main',
        tags: 'commit-digest,repo',
      }),
    );
  });
});
