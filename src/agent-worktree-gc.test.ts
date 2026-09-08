import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assess,
  hasLiveProcess,
  hasTrackedChanges,
  parseWorktreeList,
  runAgentWorktreeGcOnce,
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
  return { path: '/tmp/wt', head: 'a'.repeat(40), branch: 'topic', missing: false, locked: false, ...over };
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

  it('reads the lock flag, bare or with a reason', () => {
    const out = [
      'worktree /a',
      'HEAD ' + '1'.repeat(40),
      'locked',
      '',
      'worktree /b',
      'HEAD ' + '2'.repeat(40),
      'locked claude session',
      '',
      'worktree /c',
      'HEAD ' + '3'.repeat(40),
    ].join('\n');
    const rows = parseWorktreeList(out);
    expect(rows.map((r) => r.locked)).toEqual([true, true, false]);
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
    expect(hasLiveProcess(wt, proc)).toEqual({ live: true, uninspectable: 0 });
  });

  it('reports idle when no cwd is inside', () => {
    const proc = tmp();
    const wt = tmp();
    fs.mkdirSync(path.join(proc, '4242'));
    fs.symlinkSync('/somewhere/else', path.join(proc, '4242', 'cwd'));
    expect(hasLiveProcess(wt, proc)).toEqual({ live: false, uninspectable: 0 });
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
    expect(hasLiveProcess(wt, proc).live).toBe(false);
  });

  // The instrument must never read as "nothing is running" when it simply
  // could not look. A false idle here deletes a worktree out from under a
  // working agent.
  it('FAILS CLOSED — an unreadable /proc reports live, not idle', () => {
    const r = hasLiveProcess('/tmp/anything', '/definitely/not/a/proc');
    expect(r.live).toBe(true);
    expect(r.uninspectable).toBe(Number.POSITIVE_INFINITY);
  });

  // A PID that vanished between readdir and readlink genuinely is not using
  // the worktree; a PID we were not ALLOWED to read is a hole. Only the second
  // counts as uninspectable.
  it('counts an exited PID as absence, not as a hole', () => {
    const proc = tmp();
    fs.mkdirSync(path.join(proc, '777')); // no cwd link at all => ENOENT
    expect(hasLiveProcess(tmp(), proc)).toEqual({ live: false, uninspectable: 0 });
  });

  it('counts an unreadable cwd as a hole, not as absence', () => {
    const proc = tmp();
    const hidden = path.join(proc, '888');
    fs.mkdirSync(hidden);
    fs.symlinkSync('/somewhere', path.join(hidden, 'cwd'));
    fs.chmodSync(hidden, 0o000); // EACCES on readlink
    const r = hasLiveProcess(tmp(), proc);
    fs.chmodSync(hidden, 0o755); // restore so cleanup can remove it
    expect(r.live).toBe(false);
    expect(r.uninspectable).toBe(1);
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

  // A substring test would swallow these and let the worktree be deleted with
  // the edit still in it. node_modules must match as a PATH COMPONENT.
  it('does NOT ignore a tracked file whose name merely contains node_modules', () => {
    expect(hasTrackedChanges(' M docs/node_modules-policy.md\n')).toBe(true);
    expect(hasTrackedChanges('A  src/node_modules_shim.ts\n')).toBe(true);
  });

  it('still ignores a real node_modules path at any depth', () => {
    expect(hasTrackedChanges('?? node_modules/\n?? container/agent-runner/node_modules\n')).toBe(false);
  });

  it('reads the destination of a rename, which is what would be lost', () => {
    expect(hasTrackedChanges('R  node_modules/x -> src/real.ts\n')).toBe(true);
  });

  // The exemption is for the untracked/ignored symlink, not for the name. A
  // TRACKED change under a node_modules path is real work: `git mv tracked
  // node_modules/x` must still block removal.
  it('does NOT exempt a tracked or staged change under a node_modules path', () => {
    expect(hasTrackedChanges('A  node_modules/kept.ts\n')).toBe(true);
    expect(hasTrackedChanges(' M node_modules/kept.ts\n')).toBe(true);
    expect(hasTrackedChanges('R  src/old.ts -> node_modules/new.ts\n')).toBe(true);
    expect(hasTrackedChanges('D  node_modules/gone.ts\n')).toBe(true);
  });

  it('still exempts the untracked and ignored link itself', () => {
    expect(hasTrackedChanges('?? node_modules\n')).toBe(false);
    expect(hasTrackedChanges('!! node_modules/\n')).toBe(false);
    expect(hasTrackedChanges('?? container/agent-runner/node_modules\n')).toBe(false);
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

  // #570: the husky pre-push hook builds these and lints them from a different
  // working directory, so nothing has its cwd inside one even mid-push. The
  // liveness probe cannot see the owner, so the first real run reported a
  // snapshot with a push in flight as safe to reclaim.
  it('never touches a pre-push snapshot, which no cwd probe can see in use', () => {
    const a = assess(row({ path: '/tmp/nanoclaw-pre-push.v7E5RQ/tree' }), repo);
    expect(a.verdict).toBe('out-of-scope');
    expect(a.detail).toMatch(/pre-push snapshot/);
  });

  it('does not exclude an unrelated /tmp worktree that merely starts similarly', () => {
    expect(assess(row({ path: '/tmp/nanoclaw-prepush-notahook' }), repo, { procRoot: noProc }).verdict).not.toBe(
      'out-of-scope',
    );
  });

  // The hook builds it with `mktemp -d "${TMPDIR:-/tmp}/nanoclaw-pre-push.XXXXXX"`,
  // so a push run with TMPDIR set lands nowhere near /tmp. Matching a `/tmp`
  // prefix would have missed exactly the in-flight snapshot this excludes.
  it.each([
    '/var/tmp/nanoclaw-pre-push.Ab12Cd/tree',
    '/run/user/1001/nanoclaw-pre-push.zzzzzz/tree',
    '/home/ubuntu/scratch/nanoclaw-pre-push.q1w2e3/tree',
    '/tmp/nanoclaw-pre-push.v7E5RQ/tree',
  ])('excludes a pre-push snapshot wherever TMPDIR put it: %s', (p) => {
    expect(assess(row({ path: p }), repo, { procRoot: noProc }).verdict).toBe('out-of-scope');
  });

  // The literal dot is what separates the snapshot from a lookalike; without
  // it the pattern would swallow unrelated worktrees.
  it.each(['/tmp/nanoclaw-pre-pushing/tree', '/tmp/my-nanoclaw-pre-push-notes', '/tmp/nanoclaw-pre-push'])(
    'does not exclude a lookalike path: %s',
    (p) => {
      expect(assess(row({ path: p }), repo, { procRoot: noProc }).verdict).not.toBe('out-of-scope');
    },
  );

  // The /tmp population's real leak: the directory goes on reboot, the
  // registration survives. No FILES can be lost by pruning it — but the
  // registration can still be the only reference to a commit, so the ancestor
  // proof is not skipped. With an unverifiable ancestry this refuses.
  // (This assertion used to expect 'eligible'; that encoded the bug a round-5
  // review caught, not the intended contract.)
  it('does not prune an orphaned registration it cannot prove is merged', () => {
    // `repo` here is a path with no git repository, so the ancestry probe does
    // not answer "not an ancestor" — it fails outright, which is now reported
    // as such rather than mislabelled `unmerged`. Either way it refuses; the
    // real-git case asserting `unmerged` with the "only reference" detail is
    // covered below.
    const a = assess(row({ missing: true }), repo, { procRoot: noProc });
    expect(a.verdict).toBe('probe-failed');
  });

  // A lock is a deliberate instruction and outranks the shortcut for a missing
  // directory — the operator still said not to touch this registration.
  it('honours a lock even on a worktree whose directory is gone', () => {
    expect(assess(row({ missing: true, locked: true }), repo, { procRoot: noProc }).verdict).toBe('locked');
  });

  // The registration of a vanished detached worktree can be the ONLY reference
  // keeping an unmerged commit reachable; pruning it makes the commit gc-able.
  it('refuses to prune a missing registration whose HEAD is not merged', () => {
    const r = tmp();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: r, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(r, 'f'), 'x');
    g('add', 'f');
    g('commit', '-qm', 'one');
    const gone = path.join(tmp(), 'gone');
    g('worktree', 'add', '-q', '--detach', gone, 'main');
    fs.writeFileSync(path.join(gone, 'g'), 'y');
    execFileSync('git', ['add', 'g'], { cwd: gone, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'orphan'], {
      cwd: gone,
      stdio: 'ignore',
    });
    const orphanHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gone, encoding: 'utf-8' }).trim();
    fs.rmSync(gone, { recursive: true, force: true }); // directory vanishes, registration survives

    const a = assess({ path: gone, head: orphanHead, branch: null, missing: true, locked: false }, r, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('unmerged');
    expect(a.detail).toMatch(/only reference/);
  });

  // "not an ancestor" and "the probe broke" both refuse, so nothing unsafe
  // follows either way — but labelling a broken probe `unmerged` is a
  // confident wrong answer, and the report's labels are now the product.
  it('labels a broken ancestry probe probe-failed, not unmerged', () => {
    const r = tmp();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: r, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(r, 'f'), 'x');
    g('add', 'f');
    g('commit', '-qm', 'one');
    // A head git has never heard of: not "not an ancestor", but unresolvable.
    const a = assess({ path: '/gone', head: 'f'.repeat(40), branch: null, missing: true, locked: false }, r, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('probe-failed');
  });

  it('still prunes a missing registration whose HEAD is merged', () => {
    const r = tmp();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: r, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(r, 'f'), 'x');
    g('add', 'f');
    g('commit', '-qm', 'one');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf-8' }).trim();
    const a = assess({ path: '/gone/for/good', head, branch: null, missing: true, locked: false }, r, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('eligible');
  });

  // Idle was never established, so it must not be treated as established.
  it('refuses when some processes could not be inspected', () => {
    const proc = tmp();
    const hidden = path.join(proc, '999');
    fs.mkdirSync(hidden);
    fs.symlinkSync('/elsewhere', path.join(hidden, 'cwd'));
    fs.chmodSync(hidden, 0o000);
    const a = assess(row({ path: tmp() }), repo, { procRoot: proc });
    fs.chmodSync(hidden, 0o755);
    expect(a.verdict).toBe('probe-failed');
    expect(a.detail).toMatch(/could not be inspected/);
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

  // Lock absence proves nothing, but lock PRESENCE is a deliberate
  // do-not-remove and is honoured as one.
  it('refuses a locked worktree even when nothing is running in it', () => {
    const wt = tmp();
    const a = assess(row({ path: wt, locked: true }), repo, { procRoot: tmp() });
    expect(a.verdict).toBe('locked');
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
    const a = assess({ path: wt, head, branch: 'topic', missing: false, locked: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(), // empty /proc — readable, nothing running
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('eligible');
  });

  it('SPARES that same worktree once its branch has an open PR', () => {
    const { repo, wt, head } = repoWithMergedWorktree();
    const a = assess({ path: wt, head, branch: 'topic', missing: false, locked: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(['topic']),
    });
    expect(a.verdict).toBe('open-pr');
    expect(a.detail).toMatch(/topic/);
  });

  // Refused either way — but it must not CLAIM an open PR it never saw. That
  // is the same unverified-success assertion this collector exists to prevent.
  it('reports pr-unknown, not open-pr, when GitHub could not be reached', () => {
    const { repo, wt, head } = repoWithMergedWorktree();
    const a = assess({ path: wt, head, branch: 'topic', missing: false, locked: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
      prStateUnknown: true,
    });
    expect(a.verdict).toBe('pr-unknown');
    expect(a.detail).toMatch(/could not reach GitHub/);
  });

  it('refuses a worktree whose head is NOT an ancestor of main', () => {
    const { repo, wt } = repoWithMergedWorktree();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'ignore' });
    fs.writeFileSync(path.join(wt, 'g'), 'y');
    g('add', 'g');
    g('commit', '-qm', 'ahead');
    const ahead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim();
    const a = assess({ path: wt, head: ahead, branch: 'topic', missing: false, locked: false }, repo, {
      mainRef: 'main',
      procRoot: tmp(),
      openPrBranches: new Set(),
    });
    expect(a.verdict).toBe('unmerged');
  });
});

describe('failed probes and the pre-delete re-check', () => {
  function realRepo(): { repo: string; wt: string; head: string } {
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
    g('worktree', 'add', '-q', '--detach', wt, head);
    return { repo, wt, head };
  }

  // `git status` failing used to become `?? ''`, which reads as a clean tree —
  // a fail-OPEN that force-removes a worktree with uncommitted files in it.
  it('refuses when the cleanliness probe cannot run, instead of assuming clean', () => {
    const notARepo = tmp(); // exists, but git status will fail here
    const a = assess({ path: notARepo, head: 'a'.repeat(40), branch: null, missing: false, locked: false }, tmp(), {
      procRoot: tmp(),
    });
    expect(a.verdict).toBe('probe-failed');
    expect(a.detail).toMatch(/could not be established/);
  });

  it('classifies an eligible worktree and reports it, without touching it', () => {
    const { repo, wt } = realRepo();
    const r = runAgentWorktreeGcOnce(repo, { mainRef: 'main', procRoot: tmp() });
    expect(r).not.toBeNull();
    expect(r!.assessments.some((a) => a.row.path === wt && a.verdict === 'eligible')).toBe(true);
    // The whole point of dropping apply mode: the directory is still there.
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('classifies a worktree with uncommitted changes as dirty', () => {
    const { repo, wt } = realRepo();
    fs.writeFileSync(path.join(wt, 'f'), 'edited');
    const r = runAgentWorktreeGcOnce(repo, { mainRef: 'main', procRoot: tmp() });
    expect(r!.assessments.find((a) => a.row.path === wt)?.verdict).toBe('dirty');
    expect(fs.existsSync(wt)).toBe(true);
  });

  // In any environment without a reachable `gh` — CI, a fresh clone, an offline
  // host — PR state is unknowable, so every BRANCH-carrying worktree is
  // refused. Correct, and load-bearing: a run in CI recommends nothing rather
  // than guessing.
  it('refuses a branch-carrying worktree when gh cannot be reached', () => {
    const { repo } = realRepo();
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const branched = path.join(tmp(), 'branched');
    g('worktree', 'add', '-q', '-b', 'topic', branched, 'main');
    const r = runAgentWorktreeGcOnce(repo, { mainRef: 'main', procRoot: tmp() });
    expect(r!.assessments.find((x) => x.row.path === branched)?.verdict).toBe('pr-unknown');
    expect(fs.existsSync(branched)).toBe(true);
  });

  it('reports a failed inventory as null rather than as an empty sweep', () => {
    expect(runAgentWorktreeGcOnce(tmp(), { procRoot: tmp() })).toBeNull();
  });
});
