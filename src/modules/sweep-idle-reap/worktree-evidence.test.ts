import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectWorktreesForReap } from './worktree-evidence.js';

let root: string;
let worktrees: string;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

/** A clone of a bare origin, checked out on `branch` with that branch pushed and tracked. */
function makeCheckout(name: string, branch = 'main'): string {
  const origin = path.join(root, `${name}-origin.git`);
  git(root, ['init', '-q', '--bare', origin]);
  const seed = path.join(root, `${name}-seed`);
  git(root, ['init', '-q', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fs.mkdirSync(path.join(seed, 'src'));
  fs.writeFileSync(path.join(seed, 'src', 'a.ts'), 'a\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', origin, 'HEAD:main']);
  const checkout = path.join(worktrees, name);
  git(root, ['clone', '-q', origin, checkout]);
  if (branch !== 'main') {
    git(checkout, ['checkout', '-q', '-b', branch]);
    git(checkout, ['push', '-q', '-u', 'origin', branch]);
  }
  return checkout;
}

function age(file: string, msAgo: number): void {
  const at = new Date(Date.now() - msAgo);
  fs.utimesSync(file, at, at);
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-evidence-'));
  worktrees = path.join(root, 'worktrees');
  fs.mkdirSync(worktrees);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('inspectWorktreesForReap', () => {
  it('reports nothing for a clean, pushed checkout', async () => {
    makeCheckout('repo', 'feat/x');
    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - HOUR);
    expect(evidence).toEqual({ inFlight: [], unreadable: [] });
  });

  it('reports uncommitted edits written since the container spawned', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const spawnedAt = Date.now() - 1_000;
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'edited\n');
    fs.writeFileSync(path.join(checkout, 'src', 'new file.ts'), 'new\n');

    const evidence = await inspectWorktreesForReap(worktrees, spawnedAt);

    expect(evidence.unreadable).toEqual([]);
    expect(evidence.inFlight).toHaveLength(1);
    const [found] = evidence.inFlight;
    expect(found.name).toBe('repo');
    expect(found.branch).toBe('feat/x');
    expect(found.upstream).toBe('origin/feat/x');
    expect(found.upstreamHead).toBe(git(checkout, ['rev-parse', 'origin/feat/x']));
    expect(found.unpushedCommits).toBe(0);
    expect(found.dirtyFiles.sort()).toEqual(['src/a.ts', 'src/new file.ts']);
  });

  it('ignores uncommitted edits older than the container (an earlier container left them)', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const edited = path.join(checkout, 'src', 'a.ts');
    fs.writeFileSync(edited, 'edited long ago\n');
    age(edited, 3 * HOUR);

    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - HOUR);

    expect(evidence).toEqual({ inFlight: [], unreadable: [] });
  });

  it('reports a file deleted since spawn through its directory', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const spawnedAt = Date.now() - 1_000;
    fs.rmSync(path.join(checkout, 'src', 'a.ts'));

    const evidence = await inspectWorktreesForReap(worktrees, spawnedAt);

    expect(evidence.inFlight.map((c) => c.dirtyFiles)).toEqual([['src/a.ts']]);
  });

  it('reports a recent commit not on the upstream, with the pushed upstream head', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const pushedHead = git(checkout, ['rev-parse', 'HEAD']);
    const spawnedAt = Date.now() - 5_000;
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'committed\n');
    git(checkout, ['commit', '-q', '-am', 'local work']);

    const evidence = await inspectWorktreesForReap(worktrees, spawnedAt);

    expect(evidence.inFlight).toHaveLength(1);
    expect(evidence.inFlight[0]).toMatchObject({
      branch: 'feat/x',
      upstream: 'origin/feat/x',
      upstreamHead: pushedHead,
      unpushedCommits: 1,
      dirtyFiles: [],
    });
  });

  it('ignores an unpushed commit made before the container spawned', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'committed\n');
    const past = new Date(Date.now() - 3 * HOUR).toISOString();
    git(checkout, ['commit', '-q', '-am', 'old local work'], { GIT_COMMITTER_DATE: past, GIT_AUTHOR_DATE: past });

    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - HOUR);

    expect(evidence).toEqual({ inFlight: [], unreadable: [] });
  });

  it('counts commits on a never-pushed branch against every remote', async () => {
    const checkout = makeCheckout('repo');
    git(checkout, ['checkout', '-q', '-b', 'feat/local-only']);
    const spawnedAt = Date.now() - 5_000;
    fs.writeFileSync(path.join(checkout, 'b.ts'), 'b\n');
    git(checkout, ['add', 'b.ts']);
    git(checkout, ['commit', '-q', '-m', 'local only']);

    const evidence = await inspectWorktreesForReap(worktrees, spawnedAt);

    expect(evidence.inFlight).toHaveLength(1);
    expect(evidence.inFlight[0]).toMatchObject({
      branch: 'feat/local-only',
      upstream: null,
      upstreamHead: null,
      unpushedCommits: 1,
    });
  });

  it('reports a checkout git cannot read as unreadable, never as clean or in flight', async () => {
    const broken = path.join(worktrees, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/admin/dir\n');

    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - HOUR);

    expect(evidence.inFlight).toEqual([]);
    expect(evidence.unreadable).toHaveLength(1);
    expect(evidence.unreadable[0].name).toBe('broken');
  });

  it('still reports in-flight work in one checkout when another is unreadable', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const broken = path.join(worktrees, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/admin/dir\n');
    const spawnedAt = Date.now() - 1_000;
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'edited\n');

    const evidence = await inspectWorktreesForReap(worktrees, spawnedAt);

    expect(evidence.inFlight.map((c) => c.name)).toEqual(['repo']);
    expect(evidence.unreadable.map((c) => c.name)).toEqual(['broken']);
  });

  it('marks checkouts the time budget does not reach as unreadable', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'edited\n');

    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - HOUR, { budgetMs: 0 });

    expect(evidence.inFlight).toEqual([]);
    expect(evidence.unreadable).toEqual([{ name: 'repo', reason: 'inspection budget exhausted' }]);
  });

  it('never runs a filter or fsmonitor the container configured', async () => {
    const checkout = makeCheckout('repo', 'feat/x');
    const marker = path.join(root, 'pwned');
    const script = path.join(root, 'hook.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    git(checkout, ['config', 'filter.evil.clean', script]);
    git(checkout, ['config', 'core.fsmonitor', script]);
    fs.writeFileSync(path.join(checkout, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), 'edited\n');

    const evidence = await inspectWorktreesForReap(worktrees, Date.now() - 5_000);

    expect(fs.existsSync(marker)).toBe(false);
    expect(evidence.inFlight.map((c) => c.name)).toEqual(['repo']);
  });
});
