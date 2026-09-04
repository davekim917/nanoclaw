import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  createManagedGitMaintenanceHook,
  evaluateManagedGitCommand,
  MANAGED_GIT_OPENCODE_PLUGIN_PATH,
} from './managed-git-guard.js';
import { ManagedGitWorktreeGuard } from './managed-git-guard-opencode.js';
import { runPreToolUseChain } from './codex-hooks/runner.js';

const roots: string[] = [];
const managedEnv = {
  NANOCLAW_HOST_DATA_DIR: '/host/data',
  NANOCLAW_HOST_TOPIC_WORKTREES_DIR: '/host/data/v2-topics/wg/thread/worktrees',
};
const STATIC_EXECUTION_WRAPPER_CASES = [
  {
    wrapper: 'timeout',
    direct: '/usr/bin/timeout 30 git worktree prune --expire now',
    nested: "timeout --kill-after=5 30 sh -c 'git gc --prune=now'",
    safeDirect: 'timeout 30 git status --short',
    safeNested: "timeout 30 sh -c 'git count-objects -v'",
  },
  {
    wrapper: 'nice',
    direct: '/usr/bin/nice -n 5 git gc --prune=now',
    nested: "nice --adjustment=5 sh -c 'git worktree remove /host/topic'",
    safeDirect: 'nice -n 5 git status --short',
    safeNested: "nice sh -c 'git fsck --full'",
  },
  {
    wrapper: 'ionice',
    direct: 'ionice -c 3 git prune --expire=now',
    nested: "ionice --class=idle sh -c 'git maintenance run'",
    safeDirect: 'ionice -c 3 git status --short',
    safeNested: "ionice sh -c 'git count-objects -v'",
  },
  {
    wrapper: 'setsid',
    direct: 'setsid --fork git repack -Ad',
    nested: "setsid -f sh -c 'git multi-pack-index expire'",
    safeDirect: 'setsid --fork git status --short',
    safeNested: "setsid sh -c 'git fsck --full'",
  },
  {
    wrapper: 'stdbuf',
    direct: 'stdbuf -oL git worktree lock /host/topic',
    nested: "stdbuf --output=L sh -c 'git reflog expire --all'",
    safeDirect: 'stdbuf -o L git status --short',
    safeNested: "stdbuf -eL sh -c 'git count-objects -v'",
  },
] as const;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  delete process.env.NANOCLAW_HOST_DATA_DIR;
  delete process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('managed repository Git maintenance guard', () => {
  it.each(STATIC_EXECUTION_WRAPPER_CASES)('blocks direct protected Git through $wrapper', ({ direct }) => {
    expect(evaluateManagedGitCommand(direct, managedEnv)).toMatchObject({ action: 'deny' });
  });

  it.each(STATIC_EXECUTION_WRAPPER_CASES)('blocks nested protected Git through $wrapper', ({ nested }) => {
    expect(evaluateManagedGitCommand(nested, managedEnv)).toMatchObject({ action: 'deny' });
  });

  it.each(STATIC_EXECUTION_WRAPPER_CASES)(
    'allows ordinary and read-only Git through $wrapper',
    ({ safeDirect, safeNested }) => {
      expect(evaluateManagedGitCommand(safeDirect, managedEnv)).toEqual({ action: 'allow' });
      expect(evaluateManagedGitCommand(safeNested, managedEnv)).toEqual({ action: 'allow' });
    },
  );

  it('denies protected maintenance through common Git global options and shell wrappers', () => {
    const denied = [
      'git worktree prune',
      'git --no-pager -C /host/topic worktree remove /host/other',
      '/usr/bin/git --git-dir=/host/canonical/.git --work-tree /host/canonical worktree move old new',
      'git -c gc.auto=0 worktree repair /host/topic',
      'command git -C/host/topic worktree unlock /host/other',
      'git --git-dir /host/canonical/.git gc --prune=now',
      'env GIT_OPTIONAL_LOCKS=0 git -C /host/topic maintenance run',
      "bash -lc 'git -C /host/topic worktree prune'",
      "git -c alias.destroy='worktree remove' destroy /host/other",
      'git worktree add /host/topic-b topic-b',
      'git worktree lock --reason=busy /host/topic-b',
      'git prune --expire=now',
      'git repack -Ad',
      'git pack-refs --all',
      'git reflog expire --expire=now --all',
      'git reflog delete refs/heads/topic-b@{0}',
      'git multi-pack-index expire',
      'git multi-pack-index --object-dir /host/canonical/.git/objects repack',
      '{ git prune --expire=now; }',
      'if true; then git worktree prune; fi',
      'while false; do git maintenance run; done',
      '! git repack -Ad',
      "eval 'git reflog expire --all'",
      'time -p git pack-refs --all',
    ];
    for (const command of denied) {
      expect(evaluateManagedGitCommand(command, managedEnv)).toMatchObject({ action: 'deny' });
    }
    const guidance = evaluateManagedGitCommand('git worktree prune', managedEnv);
    expect(guidance.action).toBe('deny');
    if (guidance.action === 'deny') {
      expect(guidance.reason).toContain('continueFromThreadId');
      expect(guidance.reason).not.toContain('ask the host operator');
    }
  });

  it('allows ordinary topic work and does not activate outside a managed repository container', () => {
    for (const command of [
      'git switch topic-a',
      'git add file.ts',
      'git commit -m topic-a',
      'git status --short',
      'git fetch origin',
      'git push origin topic-a',
      'git worktree list --porcelain',
      'git reflog show --all',
      'git multi-pack-index verify',
      'git fsck --full',
      'git count-objects -v',
    ]) {
      expect(evaluateManagedGitCommand(command, managedEnv)).toEqual({ action: 'allow' });
    }
    expect(evaluateManagedGitCommand('git worktree prune', {})).toEqual({ action: 'allow' });
    expect(MANAGED_GIT_OPENCODE_PLUGIN_PATH).toBe('/app/src/managed-git-guard-opencode.ts');
  });

  it('is enforced by the Claude, Codex, and OpenCode tool adapters', async () => {
    process.env.NANOCLAW_HOST_DATA_DIR = managedEnv.NANOCLAW_HOST_DATA_DIR;
    process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR = managedEnv.NANOCLAW_HOST_TOPIC_WORKTREES_DIR;

    const claude = (await createManagedGitMaintenanceHook()(
      { tool_name: 'Bash', tool_input: { command: 'timeout 30 git worktree prune' } } as never,
      {} as never,
      {} as never,
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(claude.hookSpecificOutput?.permissionDecision).toBe('deny');

    const codex = (await runPreToolUseChain({
      tool_name: 'exec_command',
      tool_input: { command: "nice -n 5 sh -c 'git --git-dir=/host/canonical/.git gc'" },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(codex.hookSpecificOutput?.permissionDecision).toBe('deny');

    const opencode = await ManagedGitWorktreeGuard();
    await expect(
      opencode['tool.execute.before']({ tool: 'bash' }, { args: { command: 'stdbuf -oL git maintenance run' } }),
    ).rejects.toThrow(/git maintenance is host-only/);
  });

  it('preserves an invisible sibling admin, staged index, and ref while normal topic work succeeds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-guard-'));
    roots.push(root);
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    git(seed, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-q', '-m', 'base']);
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
    const canonical = path.join(root, 'canonical');
    execFileSync('git', ['clone', '-q', remote, canonical]);

    const topicA = path.join(root, 'topics', 'a', 'repo');
    const topicB = path.join(root, 'topics', 'b', 'repo');
    fs.mkdirSync(path.dirname(topicA), { recursive: true });
    fs.mkdirSync(path.dirname(topicB), { recursive: true });
    git(canonical, ['worktree', 'add', '-q', '-b', 'topic-a', topicA, 'origin/HEAD']);
    git(canonical, ['worktree', 'add', '-q', '-b', 'topic-b', topicB, 'origin/HEAD']);

    fs.writeFileSync(path.join(topicB, 'topic-b.txt'), 'staged only in topic B\n');
    git(topicB, ['add', 'topic-b.txt']);
    const stagedBlob = git(topicB, ['rev-parse', ':topic-b.txt']);
    const stagedBlobPath = path.join(canonical, '.git', 'objects', stagedBlob.slice(0, 2), stagedBlob.slice(2));
    const stagedBlobBefore = fs.readFileSync(stagedBlobPath);
    const stagedContentsBefore = execFileSync('git', ['cat-file', 'blob', stagedBlob], { cwd: canonical });
    const topicBAdmin = git(topicB, ['rev-parse', '--absolute-git-dir']);
    const topicBIndex = path.join(topicBAdmin, 'index');
    const indexBefore = fs.readFileSync(topicBIndex);
    const indexHashBefore = sha256(indexBefore);
    const refBefore = git(canonical, ['rev-parse', 'refs/heads/topic-b^{commit}']);
    fs.rmSync(topicB, { recursive: true, force: true });

    const allowedCommands: Array<{ command: string; args: string[] }> = [
      { command: `git -C ${topicA} switch -c topic-a-next`, args: ['switch', '-c', 'topic-a-next'] },
      { command: `git -C ${topicA} add topic-a.txt`, args: ['add', 'topic-a.txt'] },
      { command: `git -C ${topicA} commit -m topic-a`, args: ['commit', '-q', '-m', 'topic-a'] },
      { command: `git -C ${topicA} status --short`, args: ['status', '--short'] },
      { command: `git -C ${topicA} fetch origin`, args: ['fetch', 'origin'] },
      { command: `git -C ${topicA} push origin topic-a-next`, args: ['push', 'origin', 'topic-a-next'] },
    ];
    fs.writeFileSync(path.join(topicA, 'topic-a.txt'), 'normal topic A work\n');
    for (const { command, args } of allowedCommands) {
      expect(evaluateManagedGitCommand(command, managedEnv)).toEqual({ action: 'allow' });
      git(topicA, args);
    }

    const protectedCommands = [
      `git -C ${canonical} worktree add ${topicB}-new topic-b`,
      `git -C ${canonical} worktree lock ${topicB}`,
      `git -C ${canonical} worktree prune`,
      `git --git-dir=${path.join(canonical, '.git')} worktree remove ${topicB}`,
      `git -C ${canonical} worktree move ${topicB} ${topicB}-moved`,
      `git -C ${canonical} worktree repair ${topicB}`,
      `git -C ${canonical} worktree unlock ${topicB}`,
      `git --git-dir ${path.join(canonical, '.git')} gc --prune=now`,
      `git -C ${canonical} maintenance run`,
      `git -C ${canonical} prune --expire=now`,
      `git -C ${canonical} repack -Ad`,
      `git -C ${canonical} pack-refs --all`,
      `git -C ${canonical} reflog expire --expire=now --all`,
      `git -C ${canonical} reflog delete refs/heads/topic-b@{0}`,
      `git -C ${canonical} multi-pack-index expire`,
      `git -C ${canonical} multi-pack-index repack`,
    ];
    for (const command of protectedCommands) {
      expect(evaluateManagedGitCommand(command, managedEnv)).toMatchObject({ action: 'deny' });
      const indexAfter = fs.readFileSync(topicBIndex);
      expect(fs.existsSync(topicBAdmin)).toBe(true);
      expect(indexAfter).toEqual(indexBefore);
      expect(sha256(indexAfter)).toBe(indexHashBefore);
      expect(git(canonical, ['rev-parse', 'refs/heads/topic-b^{commit}'])).toBe(refBefore);
      expect(fs.readFileSync(stagedBlobPath)).toEqual(stagedBlobBefore);
      expect(execFileSync('git', ['cat-file', 'blob', stagedBlob], { cwd: canonical })).toEqual(stagedContentsBefore);
    }
  });

  it('proves direct worktree pruning plus object pruning can delete a sibling staged-only blob', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-prune-proof-'));
    roots.push(root);
    const canonical = path.join(root, 'canonical');
    fs.mkdirSync(canonical, { recursive: true });
    git(canonical, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(canonical, 'README.md'), 'base\n');
    git(canonical, ['add', 'README.md']);
    git(canonical, ['commit', '-q', '-m', 'base']);

    const topic = path.join(root, 'topic');
    git(canonical, ['worktree', 'add', '-q', '-b', 'topic', topic, 'HEAD']);
    fs.writeFileSync(path.join(topic, 'staged-only.txt'), 'not reachable from any ref\n');
    git(topic, ['add', 'staged-only.txt']);
    const stagedBlob = git(topic, ['rev-parse', ':staged-only.txt']);
    const stagedBlobPath = path.join(canonical, '.git', 'objects', stagedBlob.slice(0, 2), stagedBlob.slice(2));
    expect(fs.existsSync(stagedBlobPath)).toBe(true);

    fs.rmSync(topic, { recursive: true, force: true });
    git(canonical, ['worktree', 'prune', '--expire=now']);
    const old = new Date(0);
    fs.utimesSync(stagedBlobPath, old, old);
    git(canonical, ['prune', '--expire=now']);

    expect(fs.existsSync(stagedBlobPath)).toBe(false);
    expect(() => git(canonical, ['cat-file', '-e', stagedBlob])).toThrow();
  });
});
