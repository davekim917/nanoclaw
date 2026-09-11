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
  /** What the container runtime reports as bind-mounted; `null` is "cannot list". */
  mounts: [] as string[] | null,
  /** Every path handed to the trash binary, in order. */
  trashed: [] as string[],
  trashDir: '',
}));

// The GC's removal is `/usr/bin/trash` (TRASH_BIN in worktree-cleanup.ts).
// Stand in for it so a test run never fills this host's trash can: record the
// path and move it aside, where a test can still read what was trashed.
// Everything else passes through to the real child_process.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  const realPath = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const [file, fileArgs] = args;
      if (file === '/usr/bin/trash' && Array.isArray(fileArgs)) {
        const target = String(fileArgs[0]);
        state.trashed.push(target);
        realFs.renameSync(
          target,
          realPath.join(state.trashDir, `${state.trashed.length}-${realPath.basename(target)}`),
        );
        return Buffer.alloc(0);
      }
      return actual.execFileSync(...args);
    },
  };
});
vi.mock('./container-mounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-mounts.js')>()),
  runningContainerMounts: () => state.mounts,
}));
// A pass-through spy: P2-13 asserts the lister is how the GC finds checkouts.
vi.mock('./repository-workspaces.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repository-workspaces.js')>();
  return { ...actual, listTopicCheckouts: vi.fn(actual.listTopicCheckouts) };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  get DATA_DIR() {
    return state.dataDir;
  },
}));
vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  isContainerRunning: (id: string) => state.running.has(id),
  isContainerSpawning: (id: string) => state.spawning.has(id),
}));
vi.mock('./db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/connection.js')>()),
  getRawDb: () => ({ prepare: () => ({ all: () => state.rows }) }),
}));
// The GC's reclaim gate reads outbound state through the mailbox module's
// read-only session (it is synchronous; the seam's session() is not), so that
// is the one seam this suite substitutes. Throwing stands for
// present-but-unreadable, which the gate must fail closed on.
vi.mock('./modules/mailbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modules/mailbox/index.js')>();
  return {
    ...actual,
    readSessionOutbound: (
      location: { sessionId: string },
      action: (mailbox: {
        getProcessingClaimRows: () => unknown[];
        getContainerState: () => { current_tool: string | null };
        hasWorkContinuation: () => boolean;
      }) => unknown,
    ) => {
      if (state.unreadable.has(location.sessionId)) throw new Error('persisted state unavailable');
      return action({
        getProcessingClaimRows: () => (state.processing.has(location.sessionId) ? [{}] : []),
        getContainerState: () => ({ current_tool: state.tools.has(location.sessionId) ? 'git' : null }),
        hasWorkContinuation: () => state.continuations.has(location.sessionId),
      });
    },
  };
});
// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead,
// covering the full export surface (the mailbox module barrel, imported for the
// session path helper, uses more of log.js than just `log`).
// (davekim917/nanoclaw#355 review thread)
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { log } from './log.js';
import {
  _cleanupOneForTesting,
  _discoverWorktreesForTesting,
  _discoveryStatsForTesting,
  disposability,
  runStorageGcOnce,
  runWorktreeCleanupOnce,
  type GcCandidate,
  type GcReport,
} from './worktree-cleanup.js';
import {
  canonicalRepoDir,
  checkoutStagingRoot,
  defaultTopicBranch,
  listTopicCheckouts,
  repositoryLockPath,
  resolveRepositoryWorkUnit,
  topicStateDir,
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

/** A bare remote holding one pushed commit, and the workgroup's canonical clone of it. */
function canonicalFixture(repo = 'repo-a'): { remote: string; canonical: string } {
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
  return { remote, canonical };
}

function repositoryFixture(threadId = 'thread-1', repo = 'repo-a') {
  const { canonical } = canonicalFixture(repo);

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
  state.mounts = [];
  state.trashed = [];
  state.trashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-cleanup-trash-'));
  vi.mocked(listTopicCheckouts).mockClear();
  delete process.env.NANOCLAW_STORAGE_GC;
});

afterEach(() => {
  fs.rmSync(state.dataDir, { recursive: true, force: true });
  fs.rmSync(state.trashDir, { recursive: true, force: true });
  delete process.env.NANOCLAW_STORAGE_GC;
});

describe('per-topic linked worktree cleanup', () => {
  it('maps same-topic sibling sessions to exactly one cleanup target', async () => {
    const fixture = repositoryFixture();
    state.rows.push(row('s2'));
    const targets = await _discoverWorktreesForTesting(state.dataDir);
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
    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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
    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);

    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('preserves the worktree when an inactive participant persisted state is unknown and NOT reclaimed', async () => {
    // The fail-closed counter-case: unreadable but never recorded in the
    // reclaim journal must never be read as "reclaimed".
    state.rows = [row('s1', 'thread-1', 'inactive')];
    const fixture = repositoryFixture();
    state.unreadable.add('s1');

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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

    const [target] = await _discoverWorktreesForTesting(state.dataDir);
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
      const [target] = await _discoverWorktreesForTesting(state.dataDir);
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
    const [target] = await _discoverWorktreesForTesting(state.dataDir);
    await _cleanupOneForTesting(target, state.dataDir);
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('does not discover unknown topic directories', async () => {
    const unknown = path.join(state.dataDir, 'v2-topics', 'wg-a', 'thread-00000000000000000000000000000000');
    fs.mkdirSync(path.join(unknown, 'worktrees', 'important'), { recursive: true });
    expect(await _discoverWorktreesForTesting(state.dataDir)).toEqual([]);
    expect(fs.existsSync(path.join(unknown, 'worktrees', 'important'))).toBe(true);
  });

  // The worktrees root is shared with host infrastructure whose names are not
  // valid repository segments. Before the name filter, canonicalRepoDir() threw
  // on the first one and killed discovery for the whole fleet.
  it.each(['.pnpm-store', '.nanoclaw-storage-active'])(
    'discovers real checkouts alongside the %s infrastructure directory',
    async (infraName) => {
      const fixture = repositoryFixture();
      const infra = path.join(topicWorktreesDir(fixture.workUnit, state.dataDir), infraName);
      fs.mkdirSync(infra, { recursive: true });

      const targets = await _discoverWorktreesForTesting(state.dataDir);

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

    const stats = await _discoveryStatsForTesting(state.dataDir);
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
      const stats = await _discoveryStatsForTesting(state.dataDir);
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

  it('reports an absent worktrees root as an ordinary empty topic', async () => {
    const fixture = repositoryFixture();
    fs.rmSync(topicWorktreesDir(fixture.workUnit, state.dataDir), { recursive: true, force: true });

    const stats = await _discoveryStatsForTesting(state.dataDir);
    expect(stats).toMatchObject({ targets: [], filteredNames: [], unreadableRoots: 0 });
  });
});

// ── Branch clones (docs/specs/repository-branch-clones/plan.md §5.8) ────────

describe('branch clone checkouts', () => {
  const OLD = new Date(Date.now() - 30 * 86_400_000);

  function threadUnit(threadId: string) {
    return unit(threadId, `s-${threadId}`);
  }

  /** A closed session row, the topic side-(a) evidence both collectors accept. */
  function closedRow(threadId: string) {
    return { ...row(`s-${threadId}`, threadId, 'closed'), folder: 'folder-a', idle_since: OLD.toISOString() };
  }

  /** Back-date a checkout and its topic's worktrees root past every idle floor. Call it last. */
  function age(checkout: string): void {
    fs.utimesSync(checkout, OLD, OLD);
    fs.utimesSync(path.dirname(checkout), OLD, OLD);
  }

  /**
   * A clone checkout built the way repository_checkout builds one (plan §5.2):
   * a local clone of the canonical whose `refs/remotes/origin/*` is replaced by
   * the canonical's own remote-tracking refs (remote-ref hygiene, step 2), with
   * origin pointed at the pin, on `branch` started from origin/main or copied
   * from canonical `refs/heads/<branch>` (step 3).
   */
  function cloneCheckout(
    canon: { remote: string; canonical: string },
    threadId: string,
    name: string,
    branch: string,
    startedFrom: 'origin' | 'canonical-local' = 'origin',
  ): { topicDir: string; root: string; checkout: string } {
    const root = topicWorktreesDir(threadUnit(threadId), state.dataDir);
    const checkout = path.join(root, name);
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['clone', '-q', '--no-checkout', canon.canonical, checkout]);
    const cloned = git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
    for (const ref of cloned.split('\n').filter(Boolean)) git(checkout, ['update-ref', '--no-deref', '-d', ref]);
    git(checkout, ['fetch', '-q', canon.canonical, '+refs/remotes/origin/*:refs/remotes/origin/*']);
    git(checkout, ['remote', 'set-url', 'origin', canon.remote]);
    if (startedFrom === 'canonical-local') {
      git(checkout, ['fetch', '-q', canon.canonical, `+refs/heads/${branch}:refs/heads/${branch}`]);
    } else {
      git(checkout, ['branch', '-f', branch, 'refs/remotes/origin/main']);
    }
    git(checkout, ['checkout', '-q', branch]);
    git(checkout, ['config', 'gc.auto', '0']);
    // The premise of the `--remotes` proof: no canonical head reached the clone's remote refs.
    expect(git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).split('\n').sort()).toEqual([
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    age(checkout);
    return { topicDir: topicStateDir(threadUnit(threadId), state.dataDir), root, checkout };
  }

  function commitFile(dir: string, file: string): void {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', file]);
  }

  /** Everything a collector could lose: HEAD, every local ref, the tree's status, and the stash. */
  function snapshot(dir: string): Record<string, string> {
    return {
      head: git(dir, ['rev-parse', 'HEAD']),
      refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
      status: git(dir, ['status', '--porcelain=v1', '--untracked-files=all']),
      stash: git(dir, ['stash', 'list']),
    };
  }

  function find(report: GcReport, target: string): GcCandidate | undefined {
    return report.candidates.find((candidate) => candidate.path === target);
  }

  it('clone disposability refuses dirty, unpushed, stashed, non-HEAD unpushed branches, and copied legacy branches', async () => {
    const canon = canonicalFixture('repo-a');
    // Committed-but-unpushed legacy work in canonical refs/heads/legacy, which
    // plan §5.2 step 3 copies into a new clone's local branch.
    const base = git(canon.canonical, ['rev-parse', 'HEAD']);
    const legacy = git(canon.canonical, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'legacy work']);
    git(canon.canonical, ['update-ref', 'refs/heads/legacy', legacy]);

    const cases: Array<{
      thread: string;
      name: string;
      branch: string;
      startedFrom?: 'canonical-local';
      reason: string;
      arrange: (dir: string) => void;
    }> = [
      {
        thread: 'p212-dirty',
        name: 'repo-a@feat',
        branch: 'feat',
        reason: 'dirty',
        arrange: (dir) => fs.writeFileSync(path.join(dir, 'scratch.txt'), 'uncommitted\n'),
      },
      {
        thread: 'p212-unpushed-head',
        name: 'repo-a',
        branch: 'feat',
        reason: 'unpushed',
        arrange: (dir) => commitFile(dir, 'head-only.txt'),
      },
      {
        thread: 'p212-unpushed-branch',
        name: 'repo-a@feat',
        branch: 'feat',
        reason: 'unpushed',
        arrange: (dir) => {
          git(dir, ['checkout', '-q', '-b', 'side']);
          commitFile(dir, 'side.txt');
          git(dir, ['checkout', '-q', 'feat']);
        },
      },
      {
        thread: 'p212-legacy',
        name: 'repo-a@legacy',
        branch: 'legacy',
        startedFrom: 'canonical-local',
        reason: 'unpushed',
        arrange: (dir) => expect(git(dir, ['rev-parse', 'HEAD'])).toBe(legacy),
      },
      {
        thread: 'p212-stash',
        name: 'repo-a@feat',
        branch: 'feat',
        reason: 'stashed',
        arrange: (dir) => {
          fs.writeFileSync(path.join(dir, 'README.md'), 'stashed edit\n');
          git(dir, ['stash', 'push', '-q', '-m', 'wip']);
        },
      },
      {
        // An unpushed commit reachable only from a detached HEAD: `--branches`
        // alone cannot see it.
        thread: 'p212-detached',
        name: 'repo-a@feat',
        branch: 'feat',
        reason: 'unpushed',
        arrange: (dir) => {
          commitFile(dir, 'detached.txt');
          git(dir, ['checkout', '-q', '--detach']);
          git(dir, ['branch', '-f', 'feat', 'refs/remotes/origin/main']);
        },
      },
    ];
    const refused = cases.map((spec) => {
      const fixture = cloneCheckout(canon, spec.thread, spec.name, spec.branch, spec.startedFrom);
      spec.arrange(fixture.checkout);
      age(fixture.checkout);
      return { ...spec, ...fixture, before: snapshot(fixture.checkout) };
    });
    const clean = cloneCheckout(canon, 'p212-clean', 'repo-a', 'feat');
    state.rows = [...refused.map((spec) => closedRow(spec.thread)), closedRow('p212-clean')];

    // The orphan-topic loop, applying: every refused topic keeps its checkout
    // byte for byte; only the clean pushed clone's topic is trashed.
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const groupsDir = path.join(state.dataDir, 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    const report = await runStorageGcOnce(state.dataDir, groupsDir);
    for (const spec of refused) {
      expect(find(report, spec.topicDir), spec.thread).toMatchObject({ collect: false, reason: spec.reason });
      expect(snapshot(spec.checkout), spec.thread).toEqual(spec.before);
    }
    expect(find(report, clean.topicDir)).toMatchObject({ collect: true, reason: 'closed-and-clean' });
    expect(state.trashed).toEqual([clean.topicDir]);

    // The clone branch of worktree cleanup: the same refusals, the same
    // reasons, and only a fresh clean pushed clone is quarantined and trashed.
    const fresh = cloneCheckout(canon, 'p212-clean-branch', 'repo-a@feat', 'feat');
    state.rows.push(closedRow('p212-clean-branch'));
    const decisions = new Map<string, unknown>();
    for (const target of await _discoverWorktreesForTesting(state.dataDir)) {
      decisions.set(target.worktreePath, await _cleanupOneForTesting(target, state.dataDir));
    }
    for (const spec of refused) {
      expect(decisions.get(spec.checkout), spec.thread).toEqual({ collected: false, reason: spec.reason });
      expect(snapshot(spec.checkout), spec.thread).toEqual(spec.before);
    }
    expect(decisions.get(fresh.checkout)).toEqual({ collected: true, reason: 'clean-and-pushed' });
    expect(fs.existsSync(fresh.checkout)).toBe(false);
    expect(state.trashed).toHaveLength(2);
    const quarantined = state.trashed[1]!;
    expect(path.dirname(quarantined)).toBe(path.join(state.dataDir, '.gc-quarantine'));
    expect(path.basename(quarantined)).toMatch(/^repo-a@feat-\d+$/);
    expect(fs.existsSync(`${quarantined}.meta.json`)).toBe(false);
    // The trashed copy is the clone itself, working tree and history intact.
    const trashedCopy = path.join(state.trashDir, `2-${path.basename(quarantined)}`);
    expect(fs.readFileSync(path.join(trashedCopy, 'README.md'), 'utf8')).toBe('base\n');
    expect(git(trashedCopy, ['symbolic-ref', '--short', 'HEAD'])).toBe('feat');
  });

  it('orphan-topic GC enumerates through the lister, proves clones with scope all, and refuses unknown shapes', async () => {
    const canonA = canonicalFixture('repo-a');
    const canonB = canonicalFixture('repo-b');

    // A topic with a clean clone, a clean linked worktree, and host staging
    // holding a half-built clone with bytes nobody committed.
    const mixed = cloneCheckout(canonA, 'p213-mixed', 'repo-a', 'feat');
    const linked = path.join(mixed.root, 'repo-b');
    git(canonB.canonical, ['worktree', 'add', '-q', '-b', 'topic-p213', linked, 'origin/HEAD']);
    const staged = path.join(checkoutStagingRoot(mixed.root), 'req-1', 'repo-a@wip');
    fs.mkdirSync(path.join(staged, '.git'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'half-built.txt'), 'not yet published\n');
    age(linked);
    age(mixed.checkout);

    // A parsed checkout name whose `.git` is missing: shape `unknown`.
    const unknown = cloneCheckout(canonA, 'p213-unknown', 'repo-a', 'feat');
    const unknownEntry = path.join(unknown.root, 'repo-c');
    fs.mkdirSync(unknownEntry);
    fs.writeFileSync(path.join(unknownEntry, 'notes.md'), 'whose is this?\n');
    age(unknownEntry);

    // A name the lister does not parse, beside a clean clone.
    const odd = cloneCheckout(canonA, 'p213-odd', 'repo-a', 'feat');
    const oddEntry = path.join(odd.root, '.github');
    fs.mkdirSync(oddEntry);
    fs.writeFileSync(path.join(oddEntry, 'CODEOWNERS'), '* @someone\n');
    age(oddEntry);

    // A worktrees root nobody can read: refused, never proved empty.
    const unreadable = cloneCheckout(canonA, 'p213-unreadable', 'repo-a', 'feat');

    state.rows = [];
    const prove = vi.spyOn(disposability, 'proveCheckoutDisposable');
    const proven = vi.spyOn(disposability, 'provenDisposable');
    const groupsDir = path.join(state.dataDir, 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.chmodSync(unreadable.root, 0o000);
    let report: GcReport;
    // Copied before mockRestore, which also clears a spy's recorded calls.
    let proveCalls: typeof prove.mock.calls;
    let provenCalls: typeof proven.mock.calls;
    try {
      report = await runStorageGcOnce(state.dataDir, groupsDir);
    } finally {
      fs.chmodSync(unreadable.root, 0o755);
      proveCalls = [...prove.mock.calls];
      provenCalls = [...proven.mock.calls];
      prove.mockRestore();
      proven.mockRestore();
    }

    expect(find(report, mixed.topicDir)).toMatchObject({ collect: true, reason: 'orphaned-and-clean' });
    expect(find(report, unknown.topicDir)).toMatchObject({ collect: false, reason: 'unknown-shape' });
    expect(find(report, odd.topicDir)).toMatchObject({ collect: false, reason: 'unknown-shape' });
    expect(find(report, unreadable.topicDir)).toMatchObject({ collect: false, reason: 'worktrees-unreadable' });

    // The lister is the one enumerator: called once for every topic examined.
    expect(
      vi
        .mocked(listTopicCheckouts)
        .mock.calls.map(([root]) => root)
        .sort(),
    ).toEqual([mixed.root, unknown.root, odd.root, unreadable.root].sort());

    // Every entry was proved through proveCheckoutDisposable, with the shape
    // the lister gave it; a non-parsing entry is probed as `unknown`.
    const byPath = (a: string[], b: string[]) => a[0]!.localeCompare(b[0]!);
    expect(proveCalls.map(([checkout]) => [checkout.path, checkout.shape]).sort(byPath)).toEqual(
      [
        [mixed.checkout, 'clone'],
        [linked, 'linked'],
        [unknown.checkout, 'clone'],
        [unknownEntry, 'unknown'],
        [odd.checkout, 'clone'],
        [oddEntry, 'unknown'],
      ].sort(byPath),
    );
    // ...and nothing reached the underlying git proof any other way: clones
    // with scope `all`, the linked worktree with `head`, `unknown` never.
    expect(provenCalls.map(([dir, scope]) => [dir, scope]).sort(byPath)).toEqual(
      [
        [mixed.checkout, 'all'],
        [linked, 'head'],
        [unknown.checkout, 'all'],
        [odd.checkout, 'all'],
      ].sort(byPath),
    );
    // Staging sits outside worktrees/ and goes with its topic: never probed.
    const proved = [...proveCalls.map(([c]) => c.path), ...provenCalls.map(([dir]) => dir)];
    expect(proved.filter((dir) => dir.startsWith(checkoutStagingRoot(mixed.root)))).toEqual([]);
    expect(fs.readFileSync(path.join(staged, 'half-built.txt'), 'utf8')).toBe('not yet published\n');
  });
});
