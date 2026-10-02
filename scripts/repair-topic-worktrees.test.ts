import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../src/db/agent-groups.js';
import { closeDb, initMigratedTestDb } from '../src/db/index.js';
import { createSession } from '../src/db/sessions.js';
import { resolveRepositoryWorkUnit, topicStateDir } from '../src/repository-workspaces.js';
import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

import {
  RESCUE_REF_PREFIX,
  adminDirName,
  repairTopicWorktrees,
  rescueRefName,
  sessionParticipants,
  type LivenessProbes,
  type RepairEntry,
} from './repair-topic-worktrees.js';

enforceHermeticity();
allowSubprocess(['git', 'flock']);

const WORKGROUP = 'wg';
const REPO = 'app';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

let root: string;
let dataDir: string;
let canonical: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function topicDirName(n: number): string {
  return `thread-${createHash('sha256').update(String(n)).digest('hex').slice(0, 32)}`;
}

function topicDir(n: number): string {
  return path.join(dataDir, 'v2-topics', WORKGROUP, topicDirName(n));
}

function checkoutPath(n: number, name = REPO): string {
  return path.join(topicDir(n), 'worktrees', name);
}

function addCheckout(n: number, options: string[], name = REPO): string {
  const target = checkoutPath(n, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(canonical, 'worktree', 'add', '--quiet', ...options, target, 'origin/main');
  return target;
}

function adminOf(checkout: string): string {
  return fs.readFileSync(path.join(checkout, '.git'), 'utf8').trim().slice('gitdir: '.length);
}

/** A checkout an agent made from its own clone: the pointer names a path only that container could resolve. */
function addContainerCheckout(n: number, name: string, commit: string): string {
  const containerClone = path.join(root, 'container-clone');
  if (!fs.existsSync(containerClone)) git(root, 'clone', '--quiet', canonical, containerClone);
  const target = checkoutPath(n, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(containerClone, 'worktree', 'add', '--quiet', '--detach', target, commit);
  fs.writeFileSync(path.join(target, '.git'), `gitdir: /workspace/agent/${REPO}/.git/worktrees/${name}\n`);
  return target;
}

/** Every file, symlink and dir under a checkout except its `.git` pointer, ignored files included. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (rel === '.git') continue;
      const stat = fs.lstatSync(full);
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        out[rel] = `dir:${stat.mode}`;
        walk(full);
      } else {
        out[rel] =
          `file:${stat.mode}:${stat.mtimeMs}:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

function probes(overrides: Partial<LivenessProbes> = {}): LivenessProbes {
  return {
    participants: () => Promise.resolve([]),
    participantBusy: () => false,
    mounts: () => [],
    processRooted: () => false,
    ...overrides,
  };
}

function rescueRefs(): string[] {
  return git(canonical, 'for-each-ref', '--format=%(refname) %(objectname)', RESCUE_REF_PREFIX)
    .split('\n')
    .filter(Boolean);
}

function entryFor(entries: RepairEntry[], n: number): RepairEntry {
  const found = entries.find((entry) => entry.topic === `${WORKGROUP}/${topicDirName(n)}`);
  if (!found) throw new Error(`no entry for topic ${n}`);
  return found;
}

/**
 * Topic 1: its admin dir was deleted and the freed name given to topic 3 (shared, foreign back-pointer), and it
 * holds uncommitted and untracked work. Topic 2: admin dir missing, tree at an origin commit. Topic 4: pointer names
 * a container-only path, tree at a commit only a local branch holds. Topic 3 owns the shared admin dir.
 */
function buildFixture(): { originHead: string; localCommit: string } {
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const seed = path.join(root, 'seed');
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n*.log\ndist/\n');
  fs.mkdirSync(path.join(seed, 'dist'));
  fs.writeFileSync(path.join(seed, 'dist', 'bundle.js'), 'force-tracked build output\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(seed, 'src'));
  fs.writeFileSync(path.join(seed, 'src', 'index.ts'), 'export const x = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'add', '-f', 'dist/bundle.js');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');

  canonical = path.join(dataDir, 'repositories', WORKGROUP, REPO);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  git(root, 'clone', '--quiet', origin, canonical);
  fs.writeFileSync(path.join(canonical, '.git', 'commondir'), '.\n');
  const originHead = git(canonical, 'rev-parse', 'origin/main');

  const one = addCheckout(1, ['--detach']);
  fs.writeFileSync(path.join(one, 'README.md'), 'hello, edited\n');
  fs.writeFileSync(path.join(one, 'notes.txt'), 'untracked work\n');
  fs.mkdirSync(path.join(one, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(one, 'node_modules', 'dep', 'index.js'), 'ignored\n');
  fs.symlinkSync('README.md', path.join(one, 'link-to-readme'));
  fs.rmSync(adminOf(one), { recursive: true });

  addCheckout(3, ['--detach']);

  const two = addCheckout(2, ['--detach']);

  const branch = addCheckout(7, ['-b', 'local-only']);
  fs.writeFileSync(path.join(branch, 'feature.ts'), 'export const y = 2;\n');
  git(branch, 'add', '-A');
  git(branch, 'commit', '--quiet', '-m', 'local only');
  const localCommit = git(branch, 'rev-parse', 'HEAD');
  const four = addContainerCheckout(4, REPO, localCommit);
  fs.writeFileSync(path.join(four, 'debug.log'), 'ignored log\n');
  fs.rmSync(adminOf(two), { recursive: true });

  return { originHead, localCommit };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-topic-worktrees-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('repairTopicWorktrees', () => {
  it('builds the three broken shapes the repair targets', async () => {
    buildFixture();
    expect(adminOf(checkoutPath(1))).toBe(adminOf(checkoutPath(3)));
    const report = await repairTopicWorktrees({ dataDir, apply: false, probes: probes(), scratchDir: root });
    expect(entryFor(report.entries, 1)).toMatchObject({ state: 'foreign-backpointer', sharedWith: 2 });
    expect(entryFor(report.entries, 2)).toMatchObject({ state: 'admin-missing' });
    expect(entryFor(report.entries, 3)).toMatchObject({
      state: 'healthy',
      action: 'none',
      reason: 'owns-shared-admin',
    });
    expect(entryFor(report.entries, 4)).toMatchObject({ state: 'container-path' });
  });

  it('dry-run plans every class and writes nothing', async () => {
    const { originHead, localCommit } = buildFixture();
    const pointers = [1, 2, 4].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'));
    const objectsBefore = git(canonical, 'count-objects', '-v');
    const adminsBefore = fs.readdirSync(path.join(canonical, '.git', 'worktrees')).sort();

    const report = await repairTopicWorktrees({ dataDir, apply: false, probes: probes(), scratchDir: root });

    expect(entryFor(report.entries, 1)).toMatchObject({ action: 'planned', match: 'no-match', locked: true });
    expect(entryFor(report.entries, 2)).toMatchObject({ action: 'planned', match: 'origin', head: originHead });
    expect(entryFor(report.entries, 4)).toMatchObject({
      action: 'planned',
      match: 'local-ref',
      head: localCommit,
      canonical: REPO,
      canonicalSource: 'name',
    });
    expect(rescueRefs()).toEqual([]);
    expect([1, 2, 4].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'))).toEqual(pointers);
    expect(git(canonical, 'count-objects', '-v')).toBe(objectsBefore);
    expect(fs.readdirSync(path.join(canonical, '.git', 'worktrees')).sort()).toEqual(adminsBefore);
  });

  it('apply repairs every shape without changing a working-tree byte', async () => {
    const { originHead, localCommit } = buildFixture();
    const before = Object.fromEntries([1, 2, 3, 4].map((n) => [n, fingerprint(checkoutPath(n))]));
    const ownerPointer = fs.readFileSync(path.join(checkoutPath(3), '.git'), 'utf8');

    const report = await repairTopicWorktrees({ dataDir, apply: true, probes: probes(), scratchDir: root });

    for (const n of [1, 2, 3, 4]) expect(fingerprint(checkoutPath(n))).toEqual(before[n]);
    expect(fs.readFileSync(path.join(checkoutPath(3), '.git'), 'utf8')).toBe(ownerPointer);

    const one = entryFor(report.entries, 1);
    expect(one).toMatchObject({ action: 'repaired', match: 'no-match', locked: true });
    expect(one.proof!.head).toBe(one.proof!.rescueCommit);
    const two = entryFor(report.entries, 2);
    expect(two).toMatchObject({ action: 'repaired', match: 'origin', locked: false, head: originHead });
    const four = entryFor(report.entries, 4);
    expect(four).toMatchObject({ action: 'repaired', match: 'local-ref', head: localCommit });

    for (const [n, entry] of [
      [1, one],
      [2, two],
      [4, four],
    ] as const) {
      const proof = entry.proof!;
      expect(proof.steps.indexOf('rescue-verified')).toBeLessThan(proof.steps.indexOf('admin-written'));
      expect(proof.treeAfter).toBe(proof.treeBefore);
      expect(proof.statusClean).toBe(true);
      expect(path.basename(proof.adminDir)).toBe(adminDirName(topicDirName(n), REPO));
      expect(git(checkoutPath(n), 'rev-parse', 'HEAD')).toBe(proof.head);
      expect(git(checkoutPath(n), 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(git(canonical, 'rev-parse', `${rescueRefName(topicDirName(n), REPO)}^{tree}`)).toBe(proof.treeBefore);
      expect(fs.existsSync(path.join(proof.adminDir, 'locked'))).toBe(entry.locked);
    }
    expect(git(canonical, 'rev-list', '--parents', '-n1', one.proof!.rescueCommit)).toBe(one.proof!.rescueCommit);
    expect(git(canonical, 'rev-list', '--parents', '-n1', two.proof!.rescueCommit)).toBe(
      `${two.proof!.rescueCommit} ${originHead}`,
    );
    expect(git(canonical, 'cat-file', '-p', `${one.proof!.rescueCommit}:notes.txt`)).toBe('untracked work');
    expect(git(canonical, 'cat-file', '-p', `${one.proof!.rescueCommit}:dist/bundle.js`)).toBe(
      'force-tracked build output',
    );
    expect(two.hashSeed).toBe(originHead);
    expect(git(canonical, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });

  it('is idempotent: a second apply changes nothing and reports every checkout healthy', async () => {
    buildFixture();
    await repairTopicWorktrees({ dataDir, apply: true, probes: probes(), scratchDir: root });
    const refs = rescueRefs();
    const pointers = [1, 2, 3, 4].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'));
    const prints = [1, 2, 3, 4].map((n) => fingerprint(checkoutPath(n)));

    const again = await repairTopicWorktrees({ dataDir, apply: true, probes: probes(), scratchDir: root });

    expect(again.entries).toEqual([]);
    expect(again.healthy).toBe(5);
    expect(rescueRefs()).toEqual(refs);
    expect([1, 2, 3, 4].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'))).toEqual(pointers);
    expect([1, 2, 3, 4].map((n) => fingerprint(checkoutPath(n)))).toEqual(prints);
  });

  it('refuses a topic a running container mounts, and one with a live session, touching nothing', async () => {
    buildFixture();
    const pointers = [1, 2].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'));

    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [1, 2].map((n) => `${WORKGROUP}/${topicDirName(n)}`),
      probes: probes({
        mounts: () => [path.join(topicDir(1), 'worktrees')],
        participants: (dir) =>
          Promise.resolve(dir === topicDir(2) ? [{ sessionId: 's', agentGroupId: 'g', status: 'active' }] : []),
      }),
    });

    expect(entryFor(report.entries, 1)).toMatchObject({ action: 'skipped', reason: 'container-mounted' });
    expect(entryFor(report.entries, 2)).toMatchObject({ action: 'skipped', reason: 'session-live' });
    expect(rescueRefs()).toEqual([]);
    expect([1, 2].map((n) => fs.readFileSync(path.join(checkoutPath(n), '.git'), 'utf8'))).toEqual(pointers);
  });

  it('refuses a busy closed session and a process rooted in the topic', async () => {
    buildFixture();
    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [1, 2].map((n) => `${WORKGROUP}/${topicDirName(n)}`),
      probes: probes({
        participants: (dir) =>
          Promise.resolve(dir === topicDir(1) ? [{ sessionId: 's', agentGroupId: 'g', status: 'closed' }] : []),
        participantBusy: () => true,
        processRooted: (dir) => dir === fs.realpathSync(topicDir(2)),
      }),
    });
    expect(entryFor(report.entries, 1)).toMatchObject({ action: 'skipped', reason: 'topic-busy' });
    expect(entryFor(report.entries, 2)).toMatchObject({ action: 'skipped', reason: 'process-rooted' });
    expect(rescueRefs()).toEqual([]);
  });

  it('keeps the verified rescue ref when the registration write fails after it', async () => {
    buildFixture();
    const pointer = fs.readFileSync(path.join(checkoutPath(1), '.git'), 'utf8');
    const admins = path.join(canonical, '.git', 'worktrees');
    fs.chmodSync(admins, 0o555);
    let report;
    try {
      report = await repairTopicWorktrees({
        dataDir,
        apply: true,
        scratchDir: root,
        topics: [`${WORKGROUP}/${topicDirName(1)}`],
        probes: probes(),
      });
    } finally {
      fs.chmodSync(admins, 0o755);
    }

    const entry = entryFor(report.entries, 1);
    expect(entry).toMatchObject({ action: 'failed' });
    expect(entry.reason).toContain('EACCES');
    expect(git(canonical, 'cat-file', '-p', `${rescueRefName(topicDirName(1), REPO)}:notes.txt`)).toBe(
      'untracked work',
    );
    expect(fs.readFileSync(path.join(checkoutPath(1), '.git'), 'utf8')).toBe(pointer);
  });

  it('refuses before any write when its admin dir name is held by another checkout', async () => {
    buildFixture();
    const taken = path.join(canonical, '.git', 'worktrees', adminDirName(topicDirName(1), REPO));
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, 'gitdir'), '/elsewhere/.git\n');

    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [`${WORKGROUP}/${topicDirName(1)}`],
      probes: probes(),
    });

    expect(entryFor(report.entries, 1).reason).toContain('admin dir name already taken');
    expect(rescueRefs()).toEqual([]);
    expect(fs.readFileSync(path.join(taken, 'gitdir'), 'utf8')).toBe('/elsewhere/.git\n');
  });

  it('reuses its own admin dir left without a back-pointer by an interrupted run', async () => {
    buildFixture();
    const residue = path.join(canonical, '.git', 'worktrees', adminDirName(topicDirName(2), REPO));
    fs.mkdirSync(residue);

    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [`${WORKGROUP}/${topicDirName(2)}`],
      probes: probes(),
    });

    expect(entryFor(report.entries, 2)).toMatchObject({ action: 'repaired' });
    expect(entryFor(report.entries, 2).proof!.adminDir).toBe(fs.realpathSync(residue));
  });

  it('names admin dirs uniquely even when two checkout names sanitise alike', () => {
    expect(adminDirName('thread-x', 'app@a/b')).not.toBe(adminDirName('thread-x', 'app@a-b'));
  });

  it('resolves a checkout whose name is not a canonical by the admin dir its pointer names', async () => {
    buildFixture();
    const odd = addCheckout(5, ['--detach'], `${REPO}-scratch`);
    fs.rmSync(adminOf(odd), { recursive: true });

    const report = await repairTopicWorktrees({
      dataDir,
      apply: false,
      scratchDir: root,
      topics: [`${WORKGROUP}/${topicDirName(5)}`],
      probes: probes(),
    });
    expect(entryFor(report.entries, 5)).toMatchObject({
      state: 'admin-missing',
      canonical: REPO,
      canonicalSource: 'pointer',
      match: 'origin',
    });
  });

  it('refuses a checkout another registration still names, so no path is registered twice', async () => {
    buildFixture();
    const five = addCheckout(5, ['--detach']);
    fs.writeFileSync(path.join(five, '.git'), `gitdir: /workspace/worktrees/${REPO}/.git/worktrees/${REPO}\n`);

    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [`${WORKGROUP}/${topicDirName(5)}`],
      probes: probes(),
    });
    expect(entryFor(report.entries, 5)).toMatchObject({
      action: 'skipped',
      reason: 'another-registration-names-checkout',
    });
    expect(rescueRefs()).toEqual([]);
  });

  it('resolves an unnamed container-path checkout by content only when one canonical clearly holds it', async () => {
    buildFixture();
    addContainerCheckout(6, `${REPO}-wip`, 'origin/main');
    const other = path.join(dataDir, 'repositories', WORKGROUP, 'other');
    git(root, 'init', '--quiet', other);
    fs.writeFileSync(path.join(other, 'unrelated.txt'), 'unrelated\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--quiet', '-m', 'unrelated');
    const scope = { dataDir, apply: false, scratchDir: root, topics: [`${WORKGROUP}/${topicDirName(6)}`] };

    const clear = await repairTopicWorktrees({ ...scope, probes: probes() });
    expect(entryFor(clear.entries, 6)).toMatchObject({ canonical: REPO, canonicalSource: 'content', match: 'origin' });

    git(other, 'fetch', '--quiet', path.join(root, 'origin.git'), 'main');
    const ambiguous = await repairTopicWorktrees({ ...scope, probes: probes() });
    expect(entryFor(ambiguous.entries, 6)).toMatchObject({ action: 'skipped', reason: 'no-canonical' });
  });

  it('re-reads liveness under the lock and again before the first registration write', async () => {
    buildFixture();
    const pointer = fs.readFileSync(path.join(checkoutPath(1), '.git'), 'utf8');
    const adminsBefore = fs.readdirSync(path.join(canonical, '.git', 'worktrees')).sort();
    const goesLiveOnCall = (n: number): LivenessProbes => {
      let calls = 0;
      return probes({
        participants: () => {
          calls += 1;
          return Promise.resolve(calls >= n ? [{ sessionId: 's', agentGroupId: 'g', status: 'active' }] : []);
        },
      });
    };
    const scope = { dataDir, apply: true, scratchDir: root, topics: [`${WORKGROUP}/${topicDirName(1)}`] };

    const underLock = await repairTopicWorktrees({ ...scope, probes: goesLiveOnCall(2) });
    expect(entryFor(underLock.entries, 1)).toMatchObject({ action: 'skipped', reason: 'recheck-session-live' });
    expect(rescueRefs()).toEqual([]);

    const beforeWrite = await repairTopicWorktrees({ ...scope, probes: goesLiveOnCall(3) });
    expect(entryFor(beforeWrite.entries, 1)).toMatchObject({
      action: 'skipped',
      reason: 'recheck-before-write-session-live',
    });
    expect(rescueRefs()).toHaveLength(1);
    expect(fs.readFileSync(path.join(checkoutPath(1), '.git'), 'utf8')).toBe(pointer);
    expect(fs.readdirSync(path.join(canonical, '.git', 'worktrees')).sort()).toEqual(adminsBefore);
  });

  it('never runs a clean filter the repository configures', async () => {
    buildFixture();
    const marker = path.join(root, 'filter-ran');
    git(canonical, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
    fs.writeFileSync(path.join(checkoutPath(2), '.gitattributes'), '* filter=evil\n');

    const report = await repairTopicWorktrees({
      dataDir,
      apply: true,
      scratchDir: root,
      topics: [`${WORKGROUP}/${topicDirName(2)}`],
      probes: probes(),
    });
    expect(entryFor(report.entries, 2).action).toBe('repaired');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('keys DB sessions to the topic dir they own, so a live session refuses its topic', async () => {
    buildFixture();
    await initMigratedTestDb();
    try {
      const created_at = new Date().toISOString();
      await createAgentGroup({
        id: 'ag',
        name: 'A',
        folder: WORKGROUP,
        agent_provider: null,
        created_at,
      });
      await createSession({
        id: 'sess-1',
        agent_group_id: 'ag',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at,
      });
      const unit = resolveRepositoryWorkUnit({
        workgroupId: WORKGROUP,
        sessionId: 'sess-1',
        platformId: null,
        messagingGroupId: null,
        threadId: null,
      });
      const owned = path.join(topicStateDir(unit, dataDir), 'worktrees', REPO);
      fs.mkdirSync(path.dirname(owned), { recursive: true });
      git(canonical, 'worktree', 'add', '--quiet', '--detach', owned, 'origin/main');
      fs.rmSync(adminOf(owned), { recursive: true });

      const report = await repairTopicWorktrees({
        dataDir,
        apply: true,
        scratchDir: root,
        topics: [`${WORKGROUP}/${path.basename(topicStateDir(unit, dataDir))}`],
        probes: probes({ participants: async (dir) => (await sessionParticipants(dataDir)).get(dir) ?? [] }),
      });
      expect(report.entries).toEqual([expect.objectContaining({ action: 'skipped', reason: 'session-live' })]);
      expect(rescueRefs()).toEqual([]);
    } finally {
      await closeDb();
    }
  });
});
