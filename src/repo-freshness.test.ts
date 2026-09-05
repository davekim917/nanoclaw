import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { discoverCanonicalRefreshTargets, refreshOne, runFreshnessOnce } from './repo-freshness.js';
import { log } from './log.js';
import { canonicalRepoDir, writeOriginPin } from './repository-workspaces.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

let root: string;

function fixture(workgroupId: string, repo: string): { remote: string; canonical: string } {
  const seed = path.join(root, 'seed', workgroupId, repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(root, 'remotes', workgroupId, `${repo}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const canonical = canonicalRepoDir(workgroupId, repo, root);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, canonical]);
  git(canonical, ['remote', 'set-head', 'origin', '--auto']);
  writeOriginPin(workgroupId, repo, { origin: remote, repositoryId: remote }, root);
  return { remote, canonical };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-freshness-normal-'));
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('normal canonical freshness', () => {
  it('discovers one host-owned normal canonical per workgroup/repo and ignores old mirrors', () => {
    fixture('wg-a', 'proj');
    fs.mkdirSync(path.join(root, 'workgroups', 'wg-a', '.repos', 'old.git'), { recursive: true });

    expect(discoverCanonicalRefreshTargets(root).map((target) => `${target.workgroupId}/${target.repo}`)).toEqual([
      'wg-a/proj',
    ]);
  });

  it('advances from already-fetched refs after the remote is gone and records freshness', async () => {
    const { remote, canonical } = fixture('wg-a', 'proj');
    const scratch = path.join(root, 'scratch');
    execFileSync('git', ['clone', '-q', remote, scratch]);
    fs.writeFileSync(path.join(scratch, 'new.txt'), 'new\n');
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', 'advance']);
    git(scratch, ['push', '-q', 'origin', 'main']);
    const oid = git(scratch, ['rev-parse', 'HEAD']);
    git(canonical, ['fetch', 'origin']);
    fs.rmSync(remote, { recursive: true, force: true });

    const result = await refreshOne(discoverCanonicalRefreshTargets(root)[0], root);
    expect(result.ok).toBe(true);
    expect(result.oid).toBe(oid);
    expect(git(canonical, ['rev-parse', 'HEAD'])).toBe(oid);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'repository-state', 'wg-a', 'proj', 'refresh.json'), 'utf8'),
    );
    expect(state).toMatchObject({ ok: true, oid });
  });

  it('fails loudly and preserves a dirty canonical', async () => {
    const { canonical } = fixture('wg-a', 'proj');
    fs.writeFileSync(path.join(canonical, 'README.md'), 'ongoing host work\n');

    const result = await refreshOne(discoverCanonicalRefreshTargets(root)[0], root);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('local modifications');
    expect(fs.readFileSync(path.join(canonical, 'README.md'), 'utf8')).toBe('ongoing host work\n');
    expect(log.error).toHaveBeenCalled();
  });

  it('serially refreshes all discovered workgroups without host network fallback', async () => {
    fixture('wg-a', 'one');
    fixture('wg-b', 'two');
    await runFreshnessOnce(root);
    expect(fs.existsSync(path.join(root, 'repository-state', 'wg-a', 'one', 'refresh.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'repository-state', 'wg-b', 'two', 'refresh.json'))).toBe(true);
  });
});
