import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '',
  rows: [] as Array<Record<string, string | null>>,
  running: new Set<string>(),
  spawning: new Set<string>(),
  processing: new Set<string>(),
  tools: new Set<string>(),
  continuations: new Set<string>(),
  unreadable: new Set<string>(),
}));

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (id: string) => state.running.has(id),
  isContainerSpawning: (id: string) => state.spawning.has(id),
}));
vi.mock('./db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => state.rows }) }),
}));
vi.mock('./session-manager.js', () => ({
  inboundDbPath: (agentGroupId: string, sessionId: string) =>
    path.join(state.dataDir, 'v2-sessions', agentGroupId, sessionId, 'inbound.db'),
  openOutboundDb: (_agentGroupId: string, sessionId: string) => {
    if (state.unreadable.has(sessionId)) throw new Error('persisted state unavailable');
    return {
      sessionId,
      prepare: () => ({ get: () => (state.continuations.has(sessionId) ? { value: '1' } : undefined) }),
      close: () => undefined,
    };
  },
}));
vi.mock('./db/session-db.js', () => ({
  getProcessingClaims: (db: { sessionId: string }) => (state.processing.has(db.sessionId) ? [{}] : []),
  getContainerState: (db: { sessionId: string }) => ({
    current_tool: state.tools.has(db.sessionId) ? 'git' : null,
  }),
}));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from './log.js';
import {
  _cleanupOneForTesting,
  _discoverWorktreesForTesting,
  _discoveryStatsForTesting,
  runWorktreeCleanupOnce,
} from './worktree-cleanup.js';
import {
  canonicalRepoDir,
  defaultTopicBranch,
  repositoryLockPath,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  writeTransferTombstone,
} from './repository-workspaces.js';
import { SESSION_RECLAIM_JOURNAL_FILENAME, SESSION_RESCUES_DIRNAME } from './storage-manager.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function row(sessionId: string, threadId = 'thread-1', status = 'active') {
  return {
    session_id: sessionId,
    agent_group_id: `ag-${sessionId}`,
    status,
    thread_id: threadId,
    messaging_group_id: 'mg-1',
    platform_id: 'slack:C1',
    workgroup_id: 'wg-a',
  };
}

/** Records a real reclaim-journal line — the actual evidence sessionWasReclaimed reads. */
function markReclaimed(sessionId: string): void {
  const dir = path.join(state.dataDir, SESSION_RESCUES_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, SESSION_RECLAIM_JOURNAL_FILENAME),
    `${JSON.stringify({ session_id: sessionId, agent_group_id: `ag-${sessionId}`, prior_status: 'active', rescue_path: 'x' })}\n`,
  );
}

function unit(threadId = 'thread-1', sessionId = 's1') {
  return resolveRepositoryWorkUnit({
    workgroupId: 'wg-a',
    sessionId,
    platformId: 'slack:C1',
    messagingGroupId: 'mg-1',
    threadId,
  });
}

function repositoryFixture(threadId = 'thread-1', repo = 'repo-a') {
  const seed = path.join(state.dataDir, 'seed', repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(state.dataDir, 'remotes', `${repo}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);

  const canonical = canonicalRepoDir('wg-a', repo, state.dataDir);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, canonical]);
  git(canonical, ['remote', 'set-head', 'origin', '--auto']);
  git(canonical, ['config', 'gc.auto', '0']);

  const workUnit = unit(threadId);
  const worktree = path.join(topicWorktreesDir(workUnit, state.dataDir), repo);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const branch = defaultTopicBranch(workUnit, repo);
  git(canonical, ['worktree', 'add', '-q', '-b', branch, worktree, 'origin/HEAD']);
  const old = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(worktree, old, old);
  return { canonical, worktree, workUnit, repo, branch };
}

beforeEach(() => {
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-cleanup-'));
  state.rows = [row('s1')];
  state.running.clear();
  state.spawning.clear();
  state.processing.clear();
  state.tools.clear();
  state.continuations.clear();
  state.unreadable.clear();
});

afterEach(() => {
  fs.rmSync(state.dataDir, { recursive: true, force: true });
});

describe('per-topic linked worktree cleanup', () => {
  it('maps same-topic sibling sessions to exactly one cleanup target', () => {
    const fixture = repositoryFixture();
    state.rows.push(row('s2'));
    const targets = _discoverWorktreesForTesting(state.dataDir);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      repo: fixture.repo,
      worktreePath: fixture.worktree,
      canonicalRepoPath: fixture.canonical,
    });
    expect(targets[0].participants.map((participant) => participant.sessionId)).toEqual(['s1', 's2']);
  });

  it('removes only an inactive clean remote-contained linked checkout', async () => {
    const fixture = repositoryFixture();
    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);
    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(git(fixture.canonical, ['for-each-ref', '--format=%(refname)', `refs/heads/${fixture.branch}`])).toBe('');
  });

  it('does not prune another topic whose physical checkout is temporarily absent', async () => {
    const fixture = repositoryFixture();
    const otherUnit = unit('thread-2', 's2');
    const otherWorktree = path.join(topicWorktreesDir(otherUnit, state.dataDir), fixture.repo);
    const otherBranch = defaultTopicBranch(otherUnit, fixture.repo);
    fs.mkdirSync(path.dirname(otherWorktree), { recursive: true });
    git(fixture.canonical, ['worktree', 'add', '-q', '-b', otherBranch, otherWorktree, 'origin/HEAD']);
    fs.writeFileSync(path.join(otherWorktree, 'other-topic.txt'), 'staged only in the other topic\n');
    git(otherWorktree, ['add', 'other-topic.txt']);

    const otherAdminDir = git(otherWorktree, ['rev-parse', '--absolute-git-dir']);
    const otherIndex = path.join(otherAdminDir, 'index');
    const indexBefore = fs.readFileSync(otherIndex);
    const indexHashBefore = createHash('sha256').update(indexBefore).digest('hex');
    const branchBefore = git(fixture.canonical, ['rev-parse', `refs/heads/${otherBranch}^{commit}`]);
    fs.rmSync(otherWorktree, { recursive: true, force: true });

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    const indexAfter = fs.readFileSync(otherIndex);
    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(otherAdminDir)).toBe(true);
    expect(indexAfter).toEqual(indexBefore);
    expect(createHash('sha256').update(indexAfter).digest('hex')).toBe(indexHashBefore);
    expect(git(fixture.canonical, ['rev-parse', `refs/heads/${otherBranch}^{commit}`])).toBe(branchBefore);
  });

  it('preserves a standalone checkout that owns sibling worktree metadata', async () => {
    const fixture = repositoryFixture();
    const remote = git(fixture.canonical, ['remote', 'get-url', 'origin']);
    const sibling = path.join(state.dataDir, 'legacy-sibling');
    fs.rmSync(fixture.worktree, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', remote, fixture.worktree]);
    git(fixture.worktree, ['worktree', 'add', '-q', '-b', 'legacy-sibling', sibling, 'origin/HEAD']);
    const siblingPointer = fs.readFileSync(path.join(sibling, '.git'), 'utf8');
    const siblingAdmin = git(sibling, ['rev-parse', '--absolute-git-dir']);
    const old = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(fixture.worktree, old, old);

    // This checkout is otherwise eligible for deletion. The common-dir
    // identity check is the only reason cleanup must refuse it.
    expect(git(fixture.worktree, ['status', '--porcelain=v1'])).toBe('');
    expect(git(fixture.worktree, ['log', 'HEAD', '--not', '--remotes', '--oneline'])).toBe('');

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(true);
    expect(fs.existsSync(siblingAdmin)).toBe(true);
    expect(fs.readFileSync(path.join(sibling, '.git'), 'utf8')).toBe(siblingPointer);
  });

  it.each([
    ['running', () => state.running.add('s1')],
    ['spawning', () => state.spawning.add('s1')],
    ['processing', () => state.processing.add('s1')],
    ['active tool', () => state.tools.add('s1')],
    ['continuation', () => state.continuations.add('s1')],
  ])('preserves the worktree when any sibling is %s', async (_name, arrange) => {
    const fixture = repositoryFixture();
    state.rows.push(row('s2'));
    arrange();
    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it.each([
    ['continuation', () => state.continuations.add('s1')],
    ['processing claim', () => state.processing.add('s1')],
    ['current tool', () => state.tools.add('s1')],
  ])('preserves the worktree when an inactive participant retains a persisted %s', async (_name, arrange) => {
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    arrange();

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('preserves the worktree when an inactive participant persisted state is unknown and NOT reclaimed', async () => {
    // The fail-closed counter-case: unreadable but never recorded in the
    // reclaim journal must never be read as "reclaimed".
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    state.unreadable.add('s1');

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('does not treat a session recorded in the reclaim journal AND actually gone as busy', async () => {
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    // Real evidence a reclaim happened — not bare directory absence, which an
    // operator's out-of-band rm -rf on a still-ACTIVE session can also produce.
    markReclaimed('s1');
    state.unreadable.add('s1'); // the dir/DB is in fact gone too, but that's not what's being asserted

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(false);
  });

  it('still treats a JOURNALED session as busy if inbound.db is still present (CAS lost)', async () => {
    // storage-manager.ts appends the journal line BEFORE the archiving->closed
    // CAS, and on CAS loss the directory (inbound.db included) is deliberately
    // kept — journaled alone does not mean gone.
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    markReclaimed('s1');
    fs.mkdirSync(path.join(state.dataDir, 'v2-sessions', 'ag-s1', 's1'), { recursive: true });
    fs.writeFileSync(path.join(state.dataDir, 'v2-sessions', 'ag-s1', 's1', 'inbound.db'), '');
    state.unreadable.add('s1'); // falls through to the DB check, which fails closed

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('does not treat a JOURNALED session as busy when its root was recreated but inbound.db never was', async () => {
    // A late inbound write can lose the reclaim race: it acquires the storage
    // lease first (which mkdirs the session ROOT), then writeSessionMessageLocked
    // itself rejects the write because journal-exists + inbound.db-absent. The
    // root exists but is otherwise empty — inbound.db absence is still the
    // correct "gone" signal here, not the directory.
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    markReclaimed('s1');
    fs.mkdirSync(path.join(state.dataDir, 'v2-sessions', 'ag-s1', 's1'), { recursive: true });
    state.unreadable.add('s1'); // irrelevant here — sessionWasReclaimed short-circuits first

    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(false);
  });

  it('preserves dirty, unpushed, recent, and malformed linked checkouts', async () => {
    const scenarios: Array<(fixture: ReturnType<typeof repositoryFixture>) => void> = [
      (fixture) => fs.writeFileSync(path.join(fixture.worktree, 'README.md'), 'dirty\n'),
      (fixture) => {
        fs.writeFileSync(path.join(fixture.worktree, 'local.txt'), 'local\n');
        git(fixture.worktree, ['add', '-A']);
        git(fixture.worktree, ['commit', '-q', '-m', 'local']);
      },
      (fixture) => fs.utimesSync(fixture.worktree, new Date(), new Date()),
      (fixture) => fs.writeFileSync(path.join(fixture.worktree, '.git'), 'not a worktree pointer\n'),
    ];

    for (const [index, arrange] of scenarios.entries()) {
      fs.rmSync(state.dataDir, { recursive: true, force: true });
      fs.mkdirSync(state.dataDir, { recursive: true });
      const fixture = repositoryFixture('thread-1', `repo-${index}`);
      arrange(fixture);
      const [target] = _discoverWorktreesForTesting(state.dataDir);
      await _cleanupOneForTesting(target, state.dataDir);
      expect(fs.existsSync(fixture.worktree), `scenario ${index}`).toBe(true);
    }
  });

  it('consults transfer tombstones and preserves both referenced paths', async () => {
    const fixture = repositoryFixture();
    const destination = unit('thread-2', 's2');
    writeTransferTombstone(
      fixture.workUnit,
      fixture.repo,
      {
        version: 1,
        phase: 'moved',
        workgroupId: 'wg-a',
        repo: fixture.repo,
        sourceWorkUnitKey: fixture.workUnit.key,
        destinationWorkUnitKey: destination.key,
        sourcePath: fixture.worktree,
        destinationPath: path.join(topicWorktreesDir(destination, state.dataDir), fixture.repo),
        createdAt: new Date().toISOString(),
      },
      state.dataDir,
    );
    const [target] = _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('does not discover unknown topic directories', () => {
    const unknown = path.join(state.dataDir, 'v2-topics', 'wg-a', 'thread-00000000000000000000000000000000');
    fs.mkdirSync(path.join(unknown, 'worktrees', 'important'), { recursive: true });
    expect(_discoverWorktreesForTesting(state.dataDir)).toEqual([]);
    expect(fs.existsSync(path.join(unknown, 'worktrees', 'important'))).toBe(true);
  });

  // The worktrees root is shared with host infrastructure whose names are not
  // valid repository segments. Before the name filter, canonicalRepoDir() threw
  // on the first one and killed discovery for the whole fleet.
  it.each(['.pnpm-store', '.nanoclaw-storage-active'])(
    'discovers real checkouts alongside the %s infrastructure directory',
    (infraName) => {
      const fixture = repositoryFixture();
      const infra = path.join(topicWorktreesDir(fixture.workUnit, state.dataDir), infraName);
      fs.mkdirSync(infra, { recursive: true });

      const targets = _discoverWorktreesForTesting(state.dataDir);

      expect(targets.map((target) => target.repo)).toEqual([fixture.repo]);
      expect(fs.existsSync(infra)).toBe(true);
    },
  );

  it('keeps collecting after a target fails, and reports the skip', async () => {
    const failing = repositoryFixture('thread-1', 'repo-a');
    const healthy = repositoryFixture('thread-1', 'repo-b');

    // A symlinked coordination lock makes withHostRepositoryLock throw for
    // repo-a only — a per-target fault, exactly what used to abort the pass.
    const lock = repositoryLockPath('wg-a', failing.repo, state.dataDir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.symlinkSync('/dev/null', lock);

    await runWorktreeCleanupOnce(state.dataDir);

    expect(fs.existsSync(failing.worktree)).toBe(true);
    expect(fs.existsSync(healthy.worktree)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Worktree cleanup: target failed; continuing pass',
      expect.objectContaining({ repo: failing.repo, err: expect.any(Error) }),
    );
    expect(log.info).toHaveBeenCalledWith(
      'Worktree cleanup: pass complete',
      expect.objectContaining({ examined: 2, skipped: 1 }),
    );
  });

  // A failure that reports nothing is why the discovery throw survived months
  // of six-hourly passes. Every reason a pass collects less than the disk holds
  // has to be visible in the pass line.
  it('counts and names filtered entries instead of dropping them silently', async () => {
    const fixture = repositoryFixture();
    const root = topicWorktreesDir(fixture.workUnit, state.dataDir);
    // `.github` is a real GitHub repository name that SAFE_SEGMENT rejects.
    // The filter stays (it is a path-traversal boundary and it only ever
    // PRESERVES a checkout) but a real repository landing in it must be
    // visible to an operator, not swallowed.
    for (const name of ['.pnpm-store', '.github']) fs.mkdirSync(path.join(root, name), { recursive: true });

    const stats = _discoveryStatsForTesting(state.dataDir);
    expect(stats.targets.map((t) => t.repo)).toEqual([fixture.repo]);
    // Located, not just named: a bare deduped name reports one `.github` when
    // there are forty, and gives an operator nowhere to look.
    const prefix = `wg-a/${fixture.workUnit.kind}-${fixture.workUnit.id}`;
    expect(stats.filteredNames).toEqual([`${prefix}/.github`, `${prefix}/.pnpm-store`]);

    await runWorktreeCleanupOnce(state.dataDir);
    expect(log.info).toHaveBeenCalledWith(
      'Worktree cleanup: pass complete',
      expect.objectContaining({ filtered: 2, filteredNames: [`${prefix}/.github`, `${prefix}/.pnpm-store`] }),
    );
  });

  it('distinguishes an unreadable worktrees root from an empty one', async () => {
    const fixture = repositoryFixture();
    const root = topicWorktreesDir(fixture.workUnit, state.dataDir);
    fs.chmodSync(root, 0o000);
    try {
      const stats = _discoveryStatsForTesting(state.dataDir);
      expect(stats.targets).toEqual([]);
      expect(stats.unreadableRoots).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        'Worktree cleanup: worktrees root unreadable; preserving its topic',
        expect.objectContaining({ directory: root, err: expect.any(Error) }),
      );

      await runWorktreeCleanupOnce(state.dataDir);
      expect(log.info).toHaveBeenCalledWith(
        'Worktree cleanup: pass complete',
        expect.objectContaining({ examined: 0, unreadableRoots: 1 }),
      );
    } finally {
      fs.chmodSync(root, 0o755);
    }
    // Preserved, not collected: unreadable is never deletion authority.
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('reports an absent worktrees root as an ordinary empty topic', () => {
    const fixture = repositoryFixture();
    fs.rmSync(topicWorktreesDir(fixture.workUnit, state.dataDir), { recursive: true, force: true });

    const stats = _discoveryStatsForTesting(state.dataDir);
    expect(stats).toMatchObject({ targets: [], filteredNames: [], unreadableRoots: 0 });
  });
});
