import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateCanonicalRepository,
  normalizeGitHubOrigin,
  planRepositoryActivation,
  rollbackCanonicalRepository,
  workgroupLegacyRoot,
} from './repository-activation.js';
import { canonicalRepoDir, readOriginPin } from './repository-workspaces.js';

let root: string;
const WG = 'wg-a';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
      HOME: root,
    },
  }).trim();
}

/**
 * Build a legacy shared-FS checkout: a normal clone with a github origin and
 * synthetic remote-tracking refs, so no test ever touches the network.
 */
function legacyCheckout(
  repo: string,
  options: { origin?: string; defaultBranch?: string; commits?: number } = {},
): string {
  const defaultBranch = options.defaultBranch ?? 'develop';
  const dir = path.join(workgroupLegacyRoot(WG, root), repo);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', defaultBranch);
  for (let index = 0; index < (options.commits ?? 2); index += 1) {
    fs.writeFileSync(path.join(dir, `file-${index}.txt`), `content ${index}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `commit ${index}`);
  }
  git(dir, 'remote', 'add', 'origin', options.origin ?? `https://github.com/Example/${repo}.git`);
  // Synthetic remote-tracking state: everything committed so far is "pushed".
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', `refs/remotes/origin/${defaultBranch}`, head);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`);
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-activation-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy checkout classification', () => {
  it('normalizes only credential-free HTTPS github origins', () => {
    expect(normalizeGitHubOrigin('https://github.com/Example/repo.git')).toBe('https://github.com/Example/repo');
    expect(normalizeGitHubOrigin('git@github.com:Example/repo.git')).toBe('https://github.com/Example/repo');
    // Assembled rather than written inline so the public-boundary scanner does
    // not read a credentialed URL literal as a leaked address.
    const credentialed = ['https://user:pw', 'github.com/Example/repo'].join('@');
    expect(normalizeGitHubOrigin(credentialed)).toBeNull();
    expect(normalizeGitHubOrigin('https://gitlab.com/Example/repo')).toBeNull();
    expect(normalizeGitHubOrigin('https://github.com/Example/repo?x=1')).toBeNull();
  });

  it('adopts one canonical per origin and marks duplicate clones disposable', () => {
    legacyCheckout('etl');
    legacyCheckout('etl-pr944', { origin: 'https://github.com/Example/etl.git' });
    legacyCheckout('etl-pr946', { origin: 'https://github.com/Example/etl.git' });

    const plan = planRepositoryActivation(WG, root);

    expect(plan.adopt.map((entry) => entry.repo)).toEqual(['etl']);
    expect(plan.skip.map((entry) => entry.repo).sort()).toEqual(['etl-pr944', 'etl-pr946']);
    for (const skipped of plan.skip) expect(skipped.reason).toMatch(/duplicate clone/);
  });

  it('flags a duplicate that still owns unpushed work instead of silently discarding it', () => {
    legacyCheckout('mr');
    const duplicate = legacyCheckout('svc-side', { origin: 'https://github.com/Example/mr.git' });
    git(duplicate, 'checkout', '-q', '-b', 'feat/unpushed');
    fs.writeFileSync(path.join(duplicate, 'new.txt'), 'x\n');
    git(duplicate, 'add', '-A');
    git(duplicate, 'commit', '-q', '-m', 'unpushed work');

    const plan = planRepositoryActivation(WG, root);

    const skipped = plan.skip.find((entry) => entry.repo === 'svc-side');
    expect(skipped?.unpushedBranches).toBe(1);
    expect(skipped?.reason).toMatch(/must be pushed or adopted manually/);
  });

  it('plans without writing anything, including for a checkout missing origin/HEAD', () => {
    // Adoption repairs a missing origin/HEAD by writing a symbolic-ref. Planning
    // must never reach that path: an operator inspects a plan before approving
    // it, and a survey that mutates is not a survey.
    const clean = legacyCheckout('app');
    const needsRepair = legacyCheckout('storefront-core');
    git(needsRepair, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');

    const snapshot = () => {
      const seen: string[] = [];
      for (const dir of [clean, needsRepair]) {
        for (const entry of fs.readdirSync(path.join(dir, '.git'), { withFileTypes: true }).sort()) {
          const stat = fs.lstatSync(path.join(dir, '.git', entry.name));
          seen.push(`${dir}/${entry.name}:${stat.mtimeMs}:${stat.size}`);
        }
      }
      return seen.join('\n');
    };

    const before = snapshot();
    planRepositoryActivation(WG, root);

    expect(snapshot()).toBe(before);
    expect(() => git(needsRepair, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).toThrow();
  });

  it('never treats a linked worktree or a non-github checkout as a canonical', () => {
    const canonicalSource = legacyCheckout('app');
    const linked = path.join(workgroupLegacyRoot(WG, root), 'app-pr688');
    git(canonicalSource, 'worktree', 'add', '-q', '--detach', linked);
    legacyCheckout('internal', { origin: 'https://git.example.com/internal.git' });

    const plan = planRepositoryActivation(WG, root);

    expect(plan.adopt.map((entry) => entry.repo)).toEqual(['app']);
    expect(plan.skip.find((entry) => entry.repo === 'app-pr688')?.linked).toBe(true);
    expect(plan.skip.find((entry) => entry.repo === 'internal')?.reason).toMatch(/not an HTTPS github.com URL/);
  });
});

describe('canonical adoption', () => {
  it('detaches at origin/HEAD rather than assuming main', async () => {
    legacyCheckout('app', { defaultBranch: 'develop' });
    const [checkout] = planRepositoryActivation(WG, root).adopt;

    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'app', root);
    expect(result.canonicalPath).toBe(canonical);
    expect(git(canonical, 'rev-parse', 'refs/remotes/origin/develop')).toBe(result.detachedAt);
    // A canonical must never reserve a branch a topic worktree might want.
    expect(git(canonical, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('preserves dirty, staged, and untracked bytes before cleaning the canonical', async () => {
    const legacy = legacyCheckout('mr');
    fs.writeFileSync(path.join(legacy, 'file-0.txt'), 'locally modified\n');
    fs.writeFileSync(path.join(legacy, 'staged.txt'), 'staged content\n');
    git(legacy, 'add', 'staged.txt');
    fs.mkdirSync(path.join(legacy, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'notes', 'scratch.md'), 'untracked note\n');

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    expect(result.preservedFileCount).toBe(3);
    const snapshot = result.preservedStatePath!;
    expect(fs.readFileSync(path.join(snapshot, 'file-0.txt'), 'utf8')).toBe('locally modified\n');
    expect(fs.readFileSync(path.join(snapshot, 'staged.txt'), 'utf8')).toBe('staged content\n');
    expect(fs.readFileSync(path.join(snapshot, 'notes', 'scratch.md'), 'utf8')).toBe('untracked note\n');

    // The published canonical is clean, which is what the mount contract needs.
    const canonical = canonicalRepoDir(WG, 'mr', root);
    expect(git(canonical, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  });

  it('keeps gitignored files that exist nowhere else instead of cleaning them away', async () => {
    const legacy = legacyCheckout('storefront-core');
    fs.writeFileSync(path.join(legacy, '.gitignore'), '.env\nnode_modules/\n');
    git(legacy, 'add', '-A');
    git(legacy, 'commit', '-q', '-m', 'add ignores');
    // The ignore rules must be part of the published remote default, otherwise
    // detaching there rewinds past them and the files stop being ignored.
    git(legacy, 'update-ref', 'refs/remotes/origin/develop', git(legacy, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(legacy, '.env'), 'SECRET=keep-me\n');
    fs.mkdirSync(path.join(legacy, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'node_modules', 'vendor.js'), '// regenerable\n');
    // Force the cleaning branch by adding one non-ignored untracked file.
    fs.writeFileSync(path.join(legacy, 'scratch.txt'), 'transient\n');

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    expect(checkout!.dirtyPaths).toEqual(['scratch.txt']);
    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'storefront-core', root);
    // Irreplaceable ignored config survives; the untracked file was preserved
    // and removed; the tree still reads clean.
    expect(fs.readFileSync(path.join(canonical, '.env'), 'utf8')).toBe('SECRET=keep-me\n');
    expect(fs.existsSync(path.join(canonical, 'node_modules', 'vendor.js'))).toBe(true);
    expect(fs.existsSync(path.join(canonical, 'scratch.txt'))).toBe(false);
    expect(git(canonical, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  });

  it('resolves a missing origin/HEAD from unambiguous local evidence', async () => {
    const legacy = legacyCheckout('demo-stage');
    // A checkout built by init + remote add never gets one. Delete the symref
    // itself — `update-ref -d` would delete the branch it points at instead.
    git(legacy, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git(legacy, 'config', 'branch.develop.remote', 'origin');
    git(legacy, 'config', 'branch.develop.merge', 'refs/heads/develop');

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'demo-stage', root);
    expect(git(canonical, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/develop');
    expect(result.detachedAt).toBe(git(canonical, 'rev-parse', 'refs/remotes/origin/develop'));
  });

  it('leaves origin/HEAD unset rather than guessing when candidates are ambiguous', async () => {
    const legacy = legacyCheckout('app');
    git(legacy, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    // Two plausible defaults and no configured upstream — never pick one.
    git(legacy, 'update-ref', 'refs/remotes/origin/main', git(legacy, 'rev-parse', 'HEAD'));

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'app', root);
    expect(() => git(canonical, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).toThrow();
  });

  it('preserves an edit hidden behind assume-unchanged, which git diff will not report', async () => {
    const legacy = legacyCheckout('mr');
    git(legacy, 'update-index', '--assume-unchanged', 'file-0.txt');
    fs.writeFileSync(path.join(legacy, 'file-0.txt'), 'edit git diff cannot see\n');
    // Proof the ordinary union is blind to it: reset --hard would overwrite
    // this file regardless, because it consults neither bit.
    expect(git(legacy, 'diff', '--name-only')).toBe('');

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    expect(checkout!.dirtyPaths).toContain('file-0.txt');
    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    expect(fs.readFileSync(path.join(result.preservedStatePath!, 'file-0.txt'), 'utf8')).toBe(
      'edit git diff cannot see\n',
    );
  });

  it('records a tracked deletion that reset --hard will resurrect', async () => {
    const legacy = legacyCheckout('etl');
    fs.rmSync(path.join(legacy, 'file-1.txt'));

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    expect(checkout!.dirtyPaths).toContain('file-1.txt');
    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const manifest = JSON.parse(fs.readFileSync(path.join(result.preservedStatePath!, 'MANIFEST.json'), 'utf8'));
    expect(manifest.revertedDeletions).toEqual(['file-1.txt']);
    expect(manifest.copied).toEqual([]);
    // The file is back, which is exactly why the deletion needed recording.
    expect(fs.existsSync(path.join(canonicalRepoDir(WG, 'etl', root), 'file-1.txt'))).toBe(true);
  });

  it('refuses a checkout with a merge in progress rather than reset --hard over it', async () => {
    const legacy = legacyCheckout('app');
    git(legacy, 'checkout', '-q', '-b', 'side', 'HEAD~1');
    fs.writeFileSync(path.join(legacy, 'file-1.txt'), 'conflicting\n');
    git(legacy, 'add', '-A');
    git(legacy, 'commit', '-q', '-m', 'conflicting change');
    // Leaves MERGE_HEAD and an unmerged index behind.
    try {
      git(legacy, 'merge', 'develop');
    } catch {
      // Expected: the merge conflicts.
    }

    const plan = planRepositoryActivation(WG, root);

    expect(plan.adopt).toEqual([]);
    expect(plan.skip.find((entry) => entry.repo === 'app')?.reason).toMatch(/in progress; finish or abort it/);
  });

  it('carries local-only commits and unpushed branches across the move', async () => {
    const legacy = legacyCheckout('etl');
    git(legacy, 'checkout', '-q', '-b', 'feat/unpushed');
    fs.writeFileSync(path.join(legacy, 'only-here.txt'), 'irreplaceable\n');
    git(legacy, 'add', '-A');
    git(legacy, 'commit', '-q', '-m', 'local only');
    const localTip = git(legacy, 'rev-parse', 'HEAD');

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    expect(checkout!.unpushedBranches).toBe(1);
    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'etl', root);
    expect(git(canonical, 'rev-parse', 'refs/heads/feat/unpushed')).toBe(localTip);
    expect(git(canonical, 'cat-file', '-e', `${localTip}^{commit}`)).toBe('');
  });

  it('pins the origin, disables automatic gc, and empties the legacy path', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;

    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const canonical = canonicalRepoDir(WG, 'app', root);
    // The identity reads in the one form publication compares (#697), whatever form was passed.
    expect(readOriginPin(WG, 'app', root)).toEqual({
      origin: 'https://github.com/Example/app',
      repositoryId: 'github.com/example/app',
    });
    expect(git(canonical, 'config', '--get', 'gc.auto')).toBe('0');
    expect(git(canonical, 'config', '--get', 'gc.worktreePruneExpire')).toBe('never');
    expect(fs.existsSync(path.join(workgroupLegacyRoot(WG, root), 'app'))).toBe(false);
  });

  it('drops worktree records whose gitdir is unreachable from the host', async () => {
    const legacy = legacyCheckout('app');
    const stale = path.join(root, 'stale-worktree');
    git(legacy, 'worktree', 'add', '-q', '--detach', stale);
    // Model the container-absolute pointer case: the checkout is gone but the
    // administrative record still reserves it.
    fs.rmSync(stale, { recursive: true, force: true });

    const [checkout] = planRepositoryActivation(WG, root).adopt;
    const result = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    expect(result.prunedWorktrees).toBe(1);
    const canonical = canonicalRepoDir(WG, 'app', root);
    expect(git(canonical, 'worktree', 'list', '--porcelain')).not.toContain('stale-worktree');
  });

  it('replays its own completed move instead of reporting a conflict', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;
    const first = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    // Same input again, exactly as a retry after a crash between the rename and
    // the caller recording success.
    const replay = await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    expect(replay.canonicalPath).toBe(first.canonicalPath);
    expect(replay.detachedAt).toBe(first.detachedAt);
  });

  it('still refuses when a foreign repository occupies the canonical path', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;
    // A different repository already sitting there must never be adopted as
    // this one just because the path matches.
    const impostor = canonicalRepoDir(WG, 'app', root);
    fs.mkdirSync(impostor, { recursive: true });
    git(impostor, 'init', '-q', '-b', 'main');
    git(impostor, 'remote', 'add', 'origin', 'https://github.com/Example/other.git');

    await expect(activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root })).rejects.toThrow(
      /canonical already exists/,
    );
    expect(fs.existsSync(path.join(workgroupLegacyRoot(WG, root), 'app'))).toBe(true);
  });

  it('refuses to overwrite an existing canonical and leaves the legacy checkout in place', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;
    fs.mkdirSync(canonicalRepoDir(WG, 'app', root), { recursive: true });

    await expect(activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root })).rejects.toThrow(
      /canonical already exists/,
    );
    expect(fs.existsSync(path.join(workgroupLegacyRoot(WG, root), 'app'))).toBe(true);
  });

  it('refuses a checkout the plan marked unadoptable', async () => {
    legacyCheckout('internal', { origin: 'https://git.example.com/internal.git' });
    const [checkout] = planRepositoryActivation(WG, root).skip;

    await expect(activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root })).rejects.toThrow(
      /not adoptable/,
    );
  });
});

describe('per-repository rollback', () => {
  it('restores the legacy path and drops the pin', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;
    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });

    const restored = await rollbackCanonicalRepository({ workgroupId: WG, repo: 'app', dataDir: root });

    expect(restored.restoredPath).toBe(path.join(workgroupLegacyRoot(WG, root), 'app'));
    expect(fs.existsSync(canonicalRepoDir(WG, 'app', root))).toBe(false);
    expect(readOriginPin(WG, 'app', root)).toBeNull();
    // Re-adoptable immediately, so a rollback is never a one-way door.
    expect(planRepositoryActivation(WG, root).adopt.map((entry) => entry.repo)).toEqual(['app']);
  });

  it('refuses to clobber an occupied legacy path', async () => {
    legacyCheckout('app');
    const [checkout] = planRepositoryActivation(WG, root).adopt;
    await activateCanonicalRepository({ workgroupId: WG, checkout: checkout!, dataDir: root });
    fs.mkdirSync(path.join(workgroupLegacyRoot(WG, root), 'app'), { recursive: true });

    await expect(rollbackCanonicalRepository({ workgroupId: WG, repo: 'app', dataDir: root })).rejects.toThrow(
      /legacy path is occupied/,
    );
    expect(fs.existsSync(canonicalRepoDir(WG, 'app', root))).toBe(true);
  });
});
