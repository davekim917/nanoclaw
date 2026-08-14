import { describe, expect, it } from 'vitest';

import { evaluateManagedGitCommand } from './managed-git-command-guard.js';

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

describe('host managed Git command guard', () => {
  it.each(STATIC_EXECUTION_WRAPPER_CASES)('blocks direct protected Git through $wrapper', ({ direct }) => {
    expect(evaluateManagedGitCommand(direct)).toMatchObject({ action: 'deny' });
  });

  it.each(STATIC_EXECUTION_WRAPPER_CASES)('blocks nested protected Git through $wrapper', ({ nested }) => {
    expect(evaluateManagedGitCommand(nested)).toMatchObject({ action: 'deny' });
  });

  it.each(STATIC_EXECUTION_WRAPPER_CASES)(
    'allows ordinary and read-only Git through $wrapper',
    ({ safeDirect, safeNested }) => {
      expect(evaluateManagedGitCommand(safeDirect)).toEqual({ action: 'allow' });
      expect(evaluateManagedGitCommand(safeNested)).toEqual({ action: 'allow' });
    },
  );

  it.each([
    ['worktree add', 'git worktree add /host/topic branch'],
    ['worktree lock', 'git -C /host/canonical worktree lock /host/topic'],
    ['worktree move', '/usr/bin/git --git-dir=/host/canonical/.git worktree move old new'],
    ['worktree prune', 'git --no-pager -C/host/canonical worktree prune --expire now'],
    ['worktree remove', 'command git -C /host/canonical worktree remove /host/topic'],
    ['worktree repair', 'env GIT_OPTIONAL_LOCKS=0 git worktree repair /host/topic'],
    ['worktree unlock', 'sudo -n git worktree unlock /host/topic'],
    ['gc', 'git --git-dir /host/canonical/.git gc --prune=now'],
    ['maintenance', 'git -C /host/canonical maintenance run'],
    ['prune', 'git prune --expire now'],
    ['repack', 'git repack -Ad'],
    ['reflog expire', 'git reflog expire --expire=now --all'],
    ['reflog delete', 'git reflog delete refs/heads/topic@{0}'],
    ['multi-pack-index expire', 'git multi-pack-index --object-dir /host/canonical/.git/objects expire'],
    ['multi-pack-index repack', 'git multi-pack-index repack'],
    ['pack-refs', 'git pack-refs --all --prune'],
  ])('blocks %s', (_label, command) => {
    expect(evaluateManagedGitCommand(command)).toMatchObject({ action: 'deny' });
  });

  it('blocks protected operations behind shell wrappers, separators, and inline Git aliases', () => {
    const commands = [
      "bash -lc 'git -C /host/canonical worktree prune'",
      'echo checking && git maintenance run',
      'status=0; /usr/bin/git prune || status=$?',
      "git -c alias.destroy='worktree remove' destroy /host/topic",
      "git -c alias.destroy='!git reflog expire --all' destroy",
      '{ git prune --expire=now; }',
      'if true; then git worktree prune; fi',
      'while false; do git maintenance run; done',
      '! git repack -Ad',
      "eval 'git reflog expire --all'",
      'time -p git pack-refs --all',
    ];

    for (const command of commands) {
      expect(evaluateManagedGitCommand(command)).toMatchObject({ action: 'deny' });
    }
  });

  it.each([
    ['switch', 'git switch topic-a'],
    ['add', 'git add file.ts'],
    ['commit', 'git commit -m topic-a'],
    ['status', 'git status --short'],
    ['fetch', 'git fetch origin'],
    ['push', 'git push origin topic-a'],
    ['worktree list', 'git worktree list --porcelain'],
    ['reflog show', 'git reflog show topic-a'],
    ['multi-pack-index verify', 'git multi-pack-index verify'],
    ['empty', ''],
  ])('allows ordinary/read-only Git operation %s', (_label, command) => {
    expect(evaluateManagedGitCommand(command)).toEqual({ action: 'allow' });
  });
});
