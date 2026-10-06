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

  it('stops at the time budget and reports nothing it did not read', async () => {
    const checkout = makeCheckout();
    const baseline = await snapshotWorktrees(worktrees);
    fs.writeFileSync(path.join(checkout, 'a.ts'), 'edited\n');
    const record = await computeWorktreeInFlight(baseline!, { budgetMs: 0 });
    expect(record.checkouts).toEqual([]);
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

    await recordWorktreeInFlight({ root: notADir, checkouts: new Map() }, { log: (m) => logs.push(m) });

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
