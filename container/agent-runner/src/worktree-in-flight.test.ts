import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getOutboundDb } from './mailbox/sqlite/connection.js';
import { getWorktreeInFlight, setWorktreeInFlight } from './modules/mailbox/session-state.js';
import { initTestSessionDb } from './modules/mailbox/testing.js';
import { computeWorktreeInFlight, recordWorktreeInFlight, snapshotWorktrees } from './worktree-in-flight.js';

let root: string;
let worktrees: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();
}

/** A clone of a bare origin with `feat/x` pushed and tracked. */
function makeCheckout(name = 'app@feat-x'): string {
  const origin = path.join(root, `${name}-origin.git`);
  git(root, ['init', '-q', '--bare', origin]);
  const seed = path.join(root, `${name}-seed`);
  git(root, ['init', '-q', seed]);
  fs.writeFileSync(path.join(seed, 'a.ts'), 'a\n');
  fs.writeFileSync(path.join(seed, 'b.ts'), 'b\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', origin, 'HEAD:main']);
  const checkout = path.join(worktrees, name);
  git(root, ['clone', '-q', origin, checkout]);
  git(checkout, ['checkout', '-q', '-b', 'feat/x']);
  git(checkout, ['push', '-q', '-u', 'origin', 'feat/x']);
  return checkout;
}

beforeEach(() => {
  initTestSessionDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-in-flight-'));
  worktrees = path.join(root, 'worktrees');
  fs.mkdirSync(worktrees);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function inFlightAfter(mutate: (checkout: string) => void, setup?: (checkout: string) => void) {
  const checkout = makeCheckout();
  setup?.(checkout);
  const baseline = await snapshotWorktrees(worktrees);
  mutate(checkout);
  return { checkout, record: await computeWorktreeInFlight(baseline!) };
}

describe('worktree in-flight record', () => {
  it('reports nothing when nothing changed since the baseline', async () => {
    const { record } = await inFlightAfter(() => {});
    expect(record.checkouts).toEqual([]);
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it('ignores dirt that was already there at startup', async () => {
    const { record } = await inFlightAfter(
      () => {},
      (checkout) => fs.writeFileSync(path.join(checkout, 'a.ts'), 'left by an earlier container\n'),
    );
    expect(record.checkouts).toEqual([]);
  });

  it('counts a new edit, a new file, and a further edit to a file already dirty at startup', async () => {
    const { record, checkout } = await inFlightAfter(
      (c) => {
        fs.writeFileSync(path.join(c, 'b.ts'), 'edited this lifetime\n');
        fs.writeFileSync(path.join(c, 'new file.ts'), 'new\n');
        fs.writeFileSync(path.join(c, 'a.ts'), 'edited again, longer than before\n');
      },
      (c) => fs.writeFileSync(path.join(c, 'a.ts'), 'old dirt\n'),
    );
    expect(record.checkouts).toHaveLength(1);
    const [found] = record.checkouts;
    expect(found).toMatchObject({
      name: 'app@feat-x',
      branch: 'feat/x',
      upstream: 'origin/feat/x',
      upstream_head: git(checkout, ['rev-parse', 'origin/feat/x']),
      unpushed: 0,
      file_count: 3,
    });
    expect([...found.files].sort()).toEqual(['a.ts', 'b.ts', 'new file.ts']);
  });

  it('counts deleting a file that was clean at startup', async () => {
    const { record } = await inFlightAfter((c) => fs.rmSync(path.join(c, 'b.ts')));
    expect(record.checkouts.map((c) => c.files)).toEqual([['b.ts']]);
  });

  it('does not count a file that was already deleted at startup', async () => {
    const { record } = await inFlightAfter(
      // An unrelated change to the same directory must not date the old deletion.
      (c) => fs.writeFileSync(path.join(c, 'scratch.tmp'), 'x\n'),
      (c) => {
        fs.rmSync(path.join(c, 'b.ts'));
        fs.writeFileSync(path.join(c, '.gitignore'), 'scratch.tmp\n');
      },
    );
    expect(record.checkouts).toEqual([]);
  });

  it('counts a new unpushed commit', async () => {
    const { record } = await inFlightAfter((c) => {
      fs.writeFileSync(path.join(c, 'a.ts'), 'committed\n');
      git(c, ['commit', '-q', '-am', 'work']);
    });
    expect(record.checkouts).toHaveLength(1);
    expect(record.checkouts[0]).toMatchObject({ unpushed: 1, files: [], file_count: 0 });
  });

  it('does not count an unpushed commit already present at startup, on this or another branch', async () => {
    const { record } = await inFlightAfter(
      (c) => git(c, ['checkout', '-q', 'feat/old']),
      (c) => {
        fs.writeFileSync(path.join(c, 'a.ts'), 'committed earlier\n');
        git(c, ['commit', '-q', '-am', 'earlier work']);
        git(c, ['checkout', '-q', '-b', 'feat/old']);
        fs.writeFileSync(path.join(c, 'b.ts'), 'older branch work\n');
        git(c, ['commit', '-q', '-am', 'older work']);
        git(c, ['checkout', '-q', 'feat/x']);
      },
    );
    expect(record.checkouts).toEqual([]);
  });

  it('counts a commit made on another branch before switching back', async () => {
    const { record } = await inFlightAfter((c) => {
      git(c, ['checkout', '-q', '-b', 'feat/side']);
      fs.writeFileSync(path.join(c, 'a.ts'), 'side work\n');
      git(c, ['commit', '-q', '-am', 'side work']);
      git(c, ['checkout', '-q', 'feat/x']);
    });
    expect(record.checkouts).toHaveLength(1);
    expect(record.checkouts[0]).toMatchObject({ branch: 'feat/x', unpushed: 1, file_count: 0 });
  });

  it('counts a staged mode change on a file that was already staged and dirty', async () => {
    const { record } = await inFlightAfter(
      // --cacheinfo changes only the staged mode; `update-index --chmod` would also restage the worktree content.
      (c) => git(c, ['update-index', '--cacheinfo', `100755,${git(c, ['rev-parse', ':a.ts'])},a.ts`]),
      (c) => {
        fs.writeFileSync(path.join(c, 'a.ts'), 'staged\n');
        git(c, ['add', 'a.ts']);
        fs.writeFileSync(path.join(c, 'a.ts'), 'staged then edited\n');
      },
    );
    expect(record.checkouts.map((c) => c.files)).toEqual([['a.ts']]);
  });

  it('records an unusual path in a form the host accepts', async () => {
    const long = `${'d'.repeat(160)}/${'e'.repeat(160)}/f.ts`;
    const { record } = await inFlightAfter((c) => {
      fs.mkdirSync(path.dirname(path.join(c, long)), { recursive: true });
      fs.writeFileSync(path.join(c, long), 'x\n');
      fs.writeFileSync(path.join(c, 'line\nbreak.ts'), 'x\n');
    });
    const files = record.checkouts[0].files;
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.length).toBeLessThanOrEqual(200);
      expect(file).not.toMatch(/[\r\n]/);
    }
  });

  it('counts work on an unborn branch', async () => {
    const checkout = path.join(worktrees, 'app@unborn');
    fs.mkdirSync(checkout);
    git(checkout, ['init', '-q']);
    const baseline = await snapshotWorktrees(worktrees);
    fs.writeFileSync(path.join(checkout, 'first.ts'), 'x\n');
    const record = await computeWorktreeInFlight(baseline!);
    expect(record.checkouts.map((c) => [c.name, c.files, c.unpushed])).toEqual([['app@unborn', ['first.ts'], 0]]);
  });

  it('never attributes a checkout that was beyond the startup cap', async () => {
    const template = makeCheckout('a00');
    fs.writeFileSync(path.join(template, 'a.ts'), 'old dirt\n');
    for (let i = 1; i <= 32; i++) {
      fs.cpSync(template, path.join(worktrees, `a${String(i).padStart(2, '0')}`), { recursive: true });
    }
    const logs: string[] = [];
    const baseline = await snapshotWorktrees(worktrees, { log: (m) => logs.push(m) });
    expect(baseline!.truncated).toBe(true);
    expect(baseline!.checkouts.size).toBe(32);
    expect(logs.filter((m) => m.includes('more than 32 checkouts'))).toHaveLength(1);
    // Removing an inventoried checkout brings the uninventoried one into the listing.
    fs.rmSync(path.join(worktrees, [...baseline!.checkouts.keys()][0]), { recursive: true, force: true });

    const record = await computeWorktreeInFlight(baseline!);

    expect(record.checkouts).toEqual([]);
  });

  it('does not count old unpushed commits on a local upstream after switching to a remote-tracking branch', async () => {
    const { record } = await inFlightAfter(
      (c) => git(c, ['checkout', '-q', 'feat/x']),
      (c) => {
        git(c, ['checkout', '-q', '-b', 'base']);
        fs.writeFileSync(path.join(c, 'a.ts'), 'old one\n');
        git(c, ['commit', '-q', '-am', 'old one']);
        fs.writeFileSync(path.join(c, 'b.ts'), 'old two\n');
        git(c, ['commit', '-q', '-am', 'old two']);
        git(c, ['checkout', '-q', '-b', 'feat/on-base']);
        git(c, ['branch', '-q', '--set-upstream-to=base']);
      },
    );
    expect(record.checkouts).toEqual([]);
  });

  it('counts everything in a checkout created after startup', async () => {
    const baseline = await snapshotWorktrees(worktrees);
    const checkout = makeCheckout('app@later');
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    const record = await computeWorktreeInFlight(baseline!);
    expect(record.checkouts.map((c) => [c.name, c.files])).toEqual([['app@later', ['a.ts']]]);
  });

  it('skips a checkout that could not be read at startup, and one that cannot be read now', async () => {
    const checkout = makeCheckout();
    const broken = path.join(worktrees, 'app@broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/admin/dir\n');
    const logs: string[] = [];
    const baseline = await snapshotWorktrees(worktrees, { log: (m) => logs.push(m) });
    expect(baseline!.checkouts.get('app@broken')).toBeNull();
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    // Becomes unreadable after the baseline.
    fs.writeFileSync(path.join(checkout, '.git', 'HEAD'), 'garbage\n');

    const record = await computeWorktreeInFlight(baseline!, { log: (m) => logs.push(m) });

    expect(record.checkouts).toEqual([]);
    expect(logs.some((m) => m.includes('app@broken'))).toBe(true);
    expect(logs.some((m) => m.includes('app@feat-x'))).toBe(true);
  });

  it('records at most 20 file names but the full count', async () => {
    const { record } = await inFlightAfter((c) => {
      for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(c, `f${i}.ts`), `${i}\n`);
    });
    expect(record.checkouts[0].files).toHaveLength(20);
    expect(record.checkouts[0].file_count).toBe(25);
  });

  it('voids the whole result when the time budget runs out', async () => {
    const checkout = makeCheckout();
    const baseline = await snapshotWorktrees(worktrees);
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    await expect(computeWorktreeInFlight(baseline!, { budgetMs: 0 })).rejects.toThrow('budget exhausted');
  });

  it('clears the record, with no partial evidence, when a slow stat exhausts the budget', async () => {
    const checkout = makeCheckout();
    const baseline = await snapshotWorktrees(worktrees);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(checkout, `f${i}.ts`), 'new\n');
    setWorktreeInFlight({ at: new Date().toISOString(), checkouts: [] });
    const slowStat = async (file: string): Promise<fs.Stats> => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fs.promises.lstat(file);
    };

    const startedAt = Date.now();
    await recordWorktreeInFlight(baseline, { budgetMs: 150, lstat: slowStat });

    // Stopped after the first slow stat, not after all five.
    expect(Date.now() - startedAt).toBeLessThan(600);
    expect(getWorktreeInFlight()).toBeUndefined();
  });

  it('clears the record when the last git command runs past the budget, despite earlier evidence', async () => {
    const first = makeCheckout('a-first');
    const slow = makeCheckout('b-slow');
    const baseline = await snapshotWorktrees(worktrees);
    fs.writeFileSync(path.join(first, 'a.ts'), 'edited\n');
    const hook = path.join(root, 'slow-fsmonitor.sh');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    git(slow, ['config', 'core.fsmonitor', hook]);
    setWorktreeInFlight({ at: new Date().toISOString(), checkouts: [] });

    const startedAt = Date.now();
    await recordWorktreeInFlight(baseline, { budgetMs: 1_500 });

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(getWorktreeInFlight()).toBeUndefined();
  });

  it('clears the record when the last step finishes just past the budget', async () => {
    const checkout = makeCheckout();
    git(checkout, ['checkout', '-q', '-b', 'local-only']);
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    // No commit baseline and no upstream, so the final file stat is the last step of the pass.
    const baseline = {
      root: worktrees,
      truncated: false,
      checkouts: new Map([['app@feat-x', { dirty: new Map<string, string>(), unpushed: null }]]),
    };
    const budgetMs = 10_000;
    let skew = 0;
    setWorktreeInFlight({ at: new Date().toISOString(), checkouts: [] });

    await recordWorktreeInFlight(baseline, {
      budgetMs,
      now: () => Date.now() + skew,
      lstat: async (file) => {
        skew = budgetMs + 1;
        return fs.promises.lstat(file);
      },
    });

    expect(getWorktreeInFlight()).toBeUndefined();
  });

  it('takes no baseline, within the budget, when listing the root stalls', async () => {
    makeCheckout();
    const startedAt = Date.now();
    const baseline = await snapshotWorktrees(worktrees, {
      budgetMs: 50,
      opendir: (dir) => new Promise((resolve) => setTimeout(() => resolve(fs.promises.opendir(dir)), 1_000)),
    });
    expect(baseline).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it('takes an empty baseline when there is no worktrees root', async () => {
    const baseline = await snapshotWorktrees(path.join(root, 'missing'));
    expect(baseline).toEqual({ root: path.join(root, 'missing'), checkouts: new Map(), truncated: false });
  });

  it('takes no baseline when the startup budget runs out', async () => {
    makeCheckout();
    expect(await snapshotWorktrees(worktrees, { budgetMs: 0 })).toBeNull();
  });

  it('writes the record to session_state at turn end, empty when nothing is in flight', async () => {
    const checkout = makeCheckout();
    const baseline = await snapshotWorktrees(worktrees);
    await recordWorktreeInFlight(baseline);
    expect(getWorktreeInFlight()!.checkouts).toEqual([]);

    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    await recordWorktreeInFlight(baseline);
    expect(getWorktreeInFlight()!.checkouts.map((c) => c.files)).toEqual([['a.ts']]);
  });

  it('never throws, and clears an earlier record instead of leaving it stale, when recording fails', async () => {
    setWorktreeInFlight({ at: new Date().toISOString(), checkouts: [] });
    const logs: string[] = [];
    // A worktrees root that is a file makes the turn-end listing fail.
    const notADir = path.join(root, 'file');
    fs.writeFileSync(notADir, 'x');

    await recordWorktreeInFlight(
      { root: notADir, checkouts: new Map(), truncated: false },
      { log: (m) => logs.push(m) },
    );

    expect(getWorktreeInFlight()).toBeUndefined();
    expect(logs.some((m) => m.startsWith('worktree in-flight record skipped'))).toBe(true);
    expect(
      getOutboundDb().prepare("SELECT COUNT(*) AS n FROM session_state WHERE key = 'worktree_in_flight'").get(),
    ).toEqual({ n: 0 });
  });

  it('clears the record when there is no baseline', async () => {
    setWorktreeInFlight({ at: new Date().toISOString(), checkouts: [] });
    await recordWorktreeInFlight(null);
    expect(getWorktreeInFlight()).toBeUndefined();
  });
});
