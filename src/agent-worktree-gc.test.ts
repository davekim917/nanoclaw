import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assess,
  gcMode,
  hasLiveProcess,
  hasTrackedChanges,
  parseWorktreeList,
  type WorktreeRow,
} from './agent-worktree-gc.js';

const tmpdirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgc-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

function row(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return { path: '/tmp/wt', head: 'a'.repeat(40), branch: 'topic', missing: false, ...over };
}

describe('parseWorktreeList', () => {
  // The bug this guards: a blank-line-grouped parse dropped ~75% of entries and
  // reported 22 worktrees where there were 85. An undercount reads as a clean
  // inventory, so the parser is pinned against a run with no trailing blank.
  it('reads every entry, including the last with no trailing blank line', () => {
    const out = [
      'worktree /repo',
      'HEAD ' + '1'.repeat(40),
      'branch refs/heads/main',
      '',
      'worktree /tmp/a',
      'HEAD ' + '2'.repeat(40),
      'branch refs/heads/feat/a',
      '',
      'worktree /tmp/b',
      'HEAD ' + '3'.repeat(40),
      'detached',
    ].join('\n');
    const rows = parseWorktreeList(out);
    expect(rows.map((r) => r.path)).toEqual(['/repo', '/tmp/a', '/tmp/b']);
    expect(rows[1].branch).toBe('feat/a');
    expect(rows[2].branch).toBeNull();
  });

  it('does not lose entries when blank-line separators are absent entirely', () => {
    const out = ['worktree /a', 'HEAD ' + '1'.repeat(40), 'worktree /b', 'HEAD ' + '2'.repeat(40)].join('\n');
    expect(parseWorktreeList(out).map((r) => r.path)).toEqual(['/a', '/b']);
  });
});

describe('hasLiveProcess', () => {
  it('reports live when a process cwd is inside the worktree', () => {
    const proc = tmp();
    const wt = tmp();
    fs.mkdirSync(path.join(proc, '4242'));
    fs.symlinkSync(path.join(wt, 'src'), path.join(proc, '4242', 'cwd'));
    expect(hasLiveProcess(wt, proc)).toBe(true);
  });

  it('reports idle when no cwd is inside', () => {
    const proc = tmp();
    const wt = tmp();
    fs.mkdirSync(path.join(proc, '4242'));
    fs.symlinkSync('/somewhere/else', path.join(proc, '4242', 'cwd'));
    expect(hasLiveProcess(wt, proc)).toBe(false);
  });

  it('does not match a sibling directory sharing a name prefix', () => {
    const base = tmp();
    const wt = path.join(base, 'topic');
    const sibling = path.join(base, 'topic-2');
    fs.mkdirSync(wt);
    fs.mkdirSync(sibling);
    const proc = tmp();
    fs.mkdirSync(path.join(proc, '1'));
    fs.symlinkSync(sibling, path.join(proc, '1', 'cwd'));
    expect(hasLiveProcess(wt, proc)).toBe(false);
  });

  // The instrument must never read as "nothing is running" when it simply
  // could not look. A false idle here deletes a worktree out from under a
  // working agent.
  it('FAILS CLOSED — an unreadable /proc reports live, not idle', () => {
    expect(hasLiveProcess('/tmp/anything', '/definitely/not/a/proc')).toBe(true);
  });
});

describe('hasTrackedChanges', () => {
  it('ignores node_modules, which is a symlink present in every worktree', () => {
    expect(hasTrackedChanges('?? node_modules\n?? container/agent-runner/node_modules\n')).toBe(false);
  });

  it('catches a real modification', () => {
    expect(hasTrackedChanges(' M src/delivery.ts\n?? node_modules\n')).toBe(true);
  });

  it('catches a staged addition', () => {
    expect(hasTrackedChanges('A  scripts/thing.sh\n')).toBe(true);
  });

  it('treats an empty status as clean', () => {
    expect(hasTrackedChanges('')).toBe(false);
  });
});

describe('assess', () => {
  const repo = '/repo';
  const noProc = '/definitely/not/a/proc';

  it('never touches the primary checkout', () => {
    expect(assess(row({ path: repo }), repo).verdict).toBe('main');
  });

  it('never touches a codex worktree', () => {
    const r = row({ path: '/home/u/.codex/worktrees/abc/nanoclaw-v2' });
    expect(assess(r, repo).verdict).toBe('out-of-scope');
  });

  // The /tmp population's real leak: the directory goes on reboot, the
  // registration survives. Nothing can be lost by pruning it.
  it('treats an orphaned registration as eligible without probing anything', () => {
    const a = assess(row({ missing: true }), repo, { procRoot: noProc });
    expect(a.verdict).toBe('eligible');
    expect(a.detail).toMatch(/orphaned/);
  });

  it('refuses a worktree with a live process, ahead of every other check', () => {
    const proc = tmp();
    const wt = tmp();
    fs.mkdirSync(path.join(proc, '99'));
    fs.symlinkSync(wt, path.join(proc, '99', 'cwd'));
    expect(assess(row({ path: wt }), repo, { procRoot: proc }).verdict).toBe('live-process');
  });

  // With an unreadable /proc every worktree must be refused, so a broken
  // liveness probe degrades to doing nothing rather than to deleting.
  it('refuses everything when the liveness probe cannot run', () => {
    const wt = tmp();
    expect(assess(row({ path: wt }), repo, { procRoot: noProc }).verdict).toBe('live-process');
  });
});

// The open-PR guard sits behind the merged/clean/idle checks, so on a real host
// it is usually unreachable — an open PR's branch is normally unmerged and
// refused earlier. It exists for the case that gets past those: a branch whose
// commits already reached main while its PR is still open. That path is only
// exercisable against a real repository, so this builds one.
describe('assess — open-PR guard (real git)', () => {
  function repoWithMergedWorktree(): { repo: string; wt: string; head: string } {
    const repo = tmp();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    g('add', 'f');
    g('commit', '-qm', 'one');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const wt = path.join(tmp(), 'wt');
    // A branch pointing at the SAME commit as main: merged by any measure,
    // clean, and idle — everything the collector needs to delete it.
    g('worktree', 'add', '-q', '-b', 'topic', wt, head);
    return { repo, wt, head };
  }

  it('deletes a merged, clean, idle worktree when no PR is open', () => {
    const { repo, wt, head } = repoWithMergedWorktree();
    const a = assess({ path: wt, head, branch: 'topic', missing: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(), // empty /proc — readable, nothing running
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('eligible');
  });

  it('SPARES that same worktree once its branch has an open PR', () => {
    const { repo, wt, head } = repoWithMergedWorktree();
    const a = assess({ path: wt, head, branch: 'topic', missing: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(['topic']),
    });
    expect(a.verdict).toBe('open-pr');
    expect(a.detail).toMatch(/topic/);
  });

  it('refuses a worktree whose head is NOT an ancestor of main', () => {
    const { repo, wt } = repoWithMergedWorktree();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'ignore' });
    fs.writeFileSync(path.join(wt, 'g'), 'y');
    g('add', 'g');
    g('commit', '-qm', 'ahead');
    const ahead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim();
    const a = assess({ path: wt, head: ahead, branch: 'topic', missing: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('unmerged');
  });
});

describe('gcMode', () => {
  it('is dry-run unless explicitly set to apply', () => {
    expect(gcMode({})).toBe('dry-run');
    expect(gcMode({ NANOCLAW_WORKTREE_GC: 'true' })).toBe('dry-run');
    expect(gcMode({ NANOCLAW_WORKTREE_GC: 'yes' })).toBe('dry-run');
    expect(gcMode({ NANOCLAW_WORKTREE_GC: 'apply' })).toBe('apply');
  });
});
