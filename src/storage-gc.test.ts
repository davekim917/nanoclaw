import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '',
  groupsDir: '',
  rows: [] as Array<Record<string, string | null>>,
  inventoryFails: false,
  running: new Set<string>(),
  spawning: new Set<string>(),
  claiming: new Set<string>(),
  dockerBin: '/bin/true',
  rowsPerCall: null as Array<Array<Record<string, string | null>>> | null,
  call: 0,
  failAtCall: null as number | null,
  /** Codex P2 test only: make the NEXT `git worktree prune` call fail, then
   *  self-clear — everything else passes through to the real execFileSync. */
  failPruneOnce: false,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const [file, fileArgs] = args;
      if (state.failPruneOnce && file === 'git' && Array.isArray(fileArgs) && fileArgs.includes('prune')) {
        state.failPruneOnce = false;
        throw new Error('simulated: sweep prune still failing');
      }
      return actual.execFileSync(...args);
    },
  };
});
vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
  get GROUPS_DIR() {
    return state.groupsDir;
  },
}));
vi.mock('./container-runtime.js', () => ({
  get CONTAINER_RUNTIME_BIN() {
    return state.dockerBin;
  },
}));
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (id: string) => state.running.has(id),
  isContainerSpawning: (id: string) => state.spawning.has(id),
}));
vi.mock('./db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => {
        if (state.inventoryFails) throw new Error('database unavailable');
        const thisCall = state.call;
        state.call += 1;
        if (state.failAtCall !== null && thisCall === state.failAtCall) {
          throw new Error('database unavailable for this call only');
        }
        if (state.rowsPerCall) {
          return state.rowsPerCall[Math.min(thisCall, state.rowsPerCall.length - 1)];
        }
        return state.rows;
      },
    }),
  }),
}));
vi.mock('./session-manager.js', () => ({
  openOutboundDb: (_agentGroupId: string, sessionId: string) => ({
    sessionId,
    prepare: () => ({ get: () => undefined }),
    close: () => undefined,
  }),
  sessionsBaseDir: () => path.join(state.dataDir, 'v2-sessions'),
  threadsBaseDir: () => path.join(state.dataDir, 'v2-threads'),
  threadWorktreeDir: (key: string) => path.join(state.dataDir, 'v2-threads', key, 'worktrees'),
  inboundDbPath: (a: string, s: string) => path.join(state.dataDir, 'v2-sessions', a, s, 'inbound.db'),
  outboundDbPath: (a: string, s: string) => path.join(state.dataDir, 'v2-sessions', a, s, 'outbound.db'),
}));
vi.mock('./db/session-db.js', () => ({
  getProcessingClaims: (db: { sessionId: string }) => (state.claiming.has(db.sessionId) ? [{}] : []),
  getContainerState: () => ({ current_tool: null }),
}));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runStorageGcOnce,
  _hostPathForProcessCwdForTesting,
  _liveProcessCwdsForTesting,
  type GcCandidate,
  type GcReport,
} from './worktree-cleanup.js';
import { resolveRepositoryWorkUnit, topicStateDir } from './repository-workspaces.js';

const WG = 'wg-a';
const OLD = new Date(Date.now() - 30 * 86_400_000);
/** Shared across describe blocks — apply-mode removal (topic or clone) always
 *  goes through the real /usr/bin/trash binary. */
const hasTrash = fs.existsSync('/usr/bin/trash');

/** Poll (no sleep) until /proc/<pid>/cwd is readable — closes the (tiny,
 *  unobserved-in-practice) window between spawn() returning and the child's
 *  /proc entry appearing, without an arbitrary fixed wait. */
function waitForProcCwd(pid: number, deadlineMs = 2000): void {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      fs.readlinkSync(`/proc/${pid}/cwd`);
      return;
    } catch {
      if (Date.now() >= deadline) return;
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A bare remote plus a seeded main branch — the origin every fixture clones. */
function makeRemote(name: string): string {
  const seed = path.join(state.dataDir, 'seed', name);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(state.dataDir, 'remotes', `${name}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  return remote;
}

function workUnit(threadId: string) {
  return resolveRepositoryWorkUnit({
    workgroupId: WG,
    sessionId: `s-${threadId}`,
    platformId: 'slack:C1',
    messagingGroupId: 'mg-1',
    threadId,
  });
}

/** idleDays: how long ago (last_active, created_at) was — omit for "just now". */
function sessionRow(threadId: string, folder = 'folder-a', status = 'closed', idleDays = 0) {
  return {
    session_id: `s-${threadId}`,
    agent_group_id: `ag-${threadId}`,
    status,
    thread_id: threadId,
    messaging_group_id: 'mg-1',
    platform_id: 'slack:C1',
    folder,
    workgroup_id: WG,
    idle_since: new Date(Date.now() - idleDays * 86_400_000).toISOString(),
  };
}

/** A topic directory holding one linked worktree of a canonical clone. */
function topicFixture(
  threadId: string,
  repo = 'repo-a',
): { topicDir: string; worktree: string; canonical: string; branch: string } {
  // Suffixed with threadId so multiple topicFixture() calls in one test (each
  // defaulting to repo='repo-a') get distinct canonical repos. The worktree
  // subdirectory name must match this exactly — production code (discover(),
  // and the GC's post-collection worktree-prune step) resolves a topic's
  // canonical repo FROM that subdirectory name via canonicalRepoDir.
  const repoDirName = `${repo}-${threadId}`;
  const remote = makeRemote(repoDirName);
  const canonical = path.join(state.dataDir, 'repositories', WG, repoDirName);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, canonical]);
  git(canonical, ['remote', 'set-head', 'origin', '--auto']);

  const topicDir = topicStateDir(workUnit(threadId), state.dataDir);
  const worktree = path.join(topicDir, 'worktrees', repoDirName);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const branch = `topic-${threadId}`;
  git(canonical, ['worktree', 'add', '-q', '-b', branch, worktree, 'origin/HEAD']);
  fs.utimesSync(topicDir, OLD, OLD);
  return { topicDir, worktree, canonical, branch };
}

/** A standalone clone (real .git DIRECTORY) at an arbitrary depth under groups/. */
function cloneFixture(relative: string, name = 'clone-a'): string {
  const remote = makeRemote(`${name}-${relative.replace(/\W/g, '')}`);
  const dir = path.join(state.groupsDir, relative);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, dir]);
  git(dir, ['remote', 'set-head', 'origin', '--auto']);
  fs.utimesSync(dir, OLD, OLD);
  return dir;
}

/** A stand-in container runtime. `ps -q` prints ids; `inspect` prints mounts. */
function fakeRuntime(mounts: string[]): string {
  const bin = path.join(path.dirname(state.dataDir), 'fake-docker');
  const script = [
    '#!/bin/sh',
    'if [ "$2" = "-q" ]; then echo c1; exit 0; fi',
    ...mounts.map((m) => `echo ${JSON.stringify(m)}`),
    'exit 0',
  ].join('\n');
  fs.writeFileSync(bin, script + '\n', { mode: 0o755 });
  return bin;
}

function find(report: GcReport, target: string): GcCandidate | undefined {
  return report.candidates.find((c) => c.path === target);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-gc-'));
  state.dataDir = path.join(root, 'data');
  state.groupsDir = path.join(root, 'groups');
  fs.mkdirSync(state.dataDir, { recursive: true });
  fs.mkdirSync(state.groupsDir, { recursive: true });
  state.rows = [];
  state.inventoryFails = false;
  state.running.clear();
  state.spawning.clear();
  state.claiming.clear();
  state.dockerBin = '/bin/true';
  state.rowsPerCall = null;
  state.call = 0;
  state.failAtCall = null;
  state.failPruneOnce = false;
  delete process.env.NANOCLAW_STORAGE_GC;
  delete process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS;
});

afterEach(() => {
  fs.rmSync(path.dirname(state.dataDir), { recursive: true, force: true });
  delete process.env.NANOCLAW_STORAGE_GC;
  delete process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS;
});

describe('storage GC — evidence', () => {
  it('distinguishes "ran and collected nothing" from "did not run"', () => {
    const ranEmpty = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(ranEmpty.ran).toBe(true);
    expect(ranEmpty.examined).toBe(0);
    expect(ranEmpty.collected).toBe(0);

    state.inventoryFails = true;
    const didNotRun = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(didNotRun.ran).toBe(false);
    expect(didNotRun.examined).toBe(0);
  });

  it('reports a reason for every skip and bytes for every collection', () => {
    const clean = topicFixture('thread-clean');
    const dirty = topicFixture('thread-dirty');
    fs.writeFileSync(path.join(dirty.worktree, 'scratch.txt'), 'x');

    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(report.mode).toBe('dry-run');
    expect(report.examined).toBe(2);
    for (const candidate of report.candidates) {
      expect(candidate.reason).not.toBe('');
      if (!candidate.collect) expect(candidate.bytes).toBe(0);
    }
    expect(find(report, clean.topicDir)!.bytes).toBeGreaterThan(0);
    expect(report.reclaimableBytes['orphan-topic']).toBeGreaterThan(0);
  });

  it('does not remove anything without NANOCLAW_STORAGE_GC=apply', () => {
    const { topicDir } = topicFixture('thread-clean');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)!.collect).toBe(true);
    expect(fs.existsSync(topicDir)).toBe(true);
  });
});

describe('storage GC — the predicate refuses', () => {
  it('collects an orphaned topic whose worktree is clean and pushed', () => {
    const { topicDir } = topicFixture('thread-clean');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'orphaned-and-clean' });
  });

  it('refuses a topic with a DIRTY worktree', () => {
    const { topicDir, worktree } = topicFixture('thread-dirty');
    fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'work in progress');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'dirty' });
  });

  it('refuses a topic with an UNPUSHED commit', () => {
    const { topicDir, worktree } = topicFixture('thread-unpushed');
    fs.writeFileSync(path.join(worktree, 'README.md'), 'local only\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-q', '-m', 'local only']);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'unpushed' });
  });

  it('refuses a topic whose owning session row is still OPEN', () => {
    const { topicDir } = topicFixture('thread-open');
    state.rows = [sessionRow('thread-open', 'folder-a', 'active')];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it('refuses a CLOSED topic whose container is still running', () => {
    const { topicDir } = topicFixture('thread-busy');
    state.rows = [sessionRow('thread-busy', 'folder-a', 'closed')];
    state.running.add('s-thread-busy');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-busy' });
  });

  it('refuses a CLOSED topic that still holds a processing claim', () => {
    const { topicDir } = topicFixture('thread-claimed');
    state.rows = [sessionRow('thread-claimed', 'folder-a', 'closed')];
    state.claiming.add('s-thread-claimed');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-busy' });
  });

  it('collects a CLOSED, quiet topic whose worktree is clean and pushed', () => {
    const { topicDir } = topicFixture('thread-closed');
    state.rows = [sessionRow('thread-closed', 'folder-a', 'closed')];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'closed-and-clean' });
  });

  it('refuses a topic whose worktree status cannot be proven at all', () => {
    const { topicDir, worktree } = topicFixture('thread-broken');
    // A pruned worktree admin directory — the dominant real-world shape.
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /workspace/agent/repo-a/.git/worktrees/x\n');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'status-unprovable' });
  });

  it('refuses a topic that has not been idle long enough', () => {
    const { topicDir } = topicFixture('thread-fresh');
    const now = new Date();
    fs.utimesSync(topicDir, now, now);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'recent' });
  });

  it('round 6 P2: refuses a topic whose linked worktree is LOCKED', () => {
    const { topicDir, worktree, canonical } = topicFixture('thread-locked');
    git(canonical, ['worktree', 'lock', worktree]);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'worktree-locked' });
  });
});

describe('storage GC — idle-threshold reclaim (owner-approved side-a widening)', () => {
  it('collects an OPEN topic whose sole owning session has been idle past the threshold', () => {
    const { topicDir } = topicFixture('thread-idle-20');
    state.rows = [sessionRow('thread-idle-20', 'folder-a', 'active', 20)];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'idle-and-clean' });
  });

  it('refuses an OPEN topic whose session has not been idle long enough', () => {
    const { topicDir } = topicFixture('thread-idle-10');
    state.rows = [sessionRow('thread-idle-10', 'folder-a', 'active', 10)];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it('still refuses a DIRTY checkout even once the idle threshold is met', () => {
    const { topicDir, worktree } = topicFixture('thread-idle-dirty');
    fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'wip');
    state.rows = [sessionRow('thread-idle-dirty', 'folder-a', 'active', 20)];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'dirty' });
  });

  it('refuses when ANY owning OPEN session is under the idle threshold', () => {
    const { topicDir } = topicFixture('thread-idle-mixed');
    const stale = sessionRow('thread-idle-mixed', 'folder-a', 'active', 20);
    // A second sibling session on the SAME topic (own row), too fresh.
    const fresh = sessionRow('thread-idle-mixed-2', 'folder-a', 'active', 2);
    fresh.thread_id = 'thread-idle-mixed';
    state.rows = [stale, fresh];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it('refuses when a CLOSED sibling was itself only recently closed', () => {
    // Quantifier: once ANY participant is open, EVERY participant — closed
    // ones included — must clear the idle floor. A sibling closed yesterday
    // is evidence of recent topic activity, not proof the topic is quiet.
    const { topicDir } = topicFixture('thread-idle-closed-recent');
    const open = sessionRow('thread-idle-closed-recent', 'folder-a', 'active', 20);
    const closedRecent = sessionRow('thread-idle-closed-recent-2', 'folder-a', 'closed', 1);
    closedRecent.thread_id = 'thread-idle-closed-recent';
    state.rows = [open, closedRecent];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it('refuses an idle ARCHIVING (transitional-status) participant via the idle path', () => {
    // archiving is a real mid-reclaim-CAS status, not a steady closed/active
    // state the idle floor was ever meant to reason about.
    const { topicDir } = topicFixture('thread-idle-archiving');
    state.rows = [sessionRow('thread-idle-archiving', 'folder-a', 'archiving', 20)];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it('NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS=0 disables the idle path (old behavior)', () => {
    process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS = '0';
    const { topicDir } = topicFixture('thread-idle-disabled');
    state.rows = [sessionRow('thread-idle-disabled', 'folder-a', 'active', 100)];
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
  });

  it.each(['abc', '1e2', '-1', '0.5', 'NaN', ''])(
    'treats an invalid knob value (%s) as DISABLED, never as the default',
    (bad) => {
      process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS = bad;
      const { topicDir } = topicFixture(`thread-idle-badknob-${bad}`);
      state.rows = [sessionRow(`thread-idle-badknob-${bad}`, 'folder-a', 'active', 100)];
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'topic-open' });
    },
  );
});

describe('storage GC — clones', () => {
  it('collects a clean, pushed, idle scratch clone at depth', () => {
    const dir = cloneFixture('folder-a/prwork/668');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ category: 'clone', collect: true });
    expect(report.reclaimableBytes.clone).toBeGreaterThan(0);
  });

  it('refuses a clone with an unpushed commit on a NON-HEAD branch', () => {
    const dir = cloneFixture('folder-a/side');
    git(dir, ['checkout', '-q', '-b', 'side-branch']);
    fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'side']);
    git(dir, ['checkout', '-q', 'main']);
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'unpushed' });
  });

  it('refuses a clone with a stash', () => {
    const dir = cloneFixture('folder-a/stashed');
    fs.writeFileSync(path.join(dir, 'README.md'), 'stashed\n');
    git(dir, ['stash', 'push', '-q', '-m', 'wip']);
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'stashed' });
  });

  it('refuses a clone that still backs a linked worktree', () => {
    const dir = cloneFixture('folder-a/backing');
    const bound = path.join(state.dataDir, 'v2-topics', WG, 'thread-bound', 'worktrees', 'backing');
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    git(dir, ['worktree', 'add', '-q', '-b', 'bound', bound, 'HEAD']);
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'bound-worktrees' });
  });

  it('#190: refuses a clone backing a worktree the filesystem sweep cannot see', () => {
    // Codex review: cloneHasBoundWorktrees only indexes gitdir pointers under
    // dataDir's known roots. A `git worktree add` to anywhere else is
    // invisible to it, and with the agent-group-live gate gone nothing else
    // would refuse the clone — trashing it would take the object store the
    // linked checkout depends on. provenDisposable now asks git's own
    // registry, which knows about every linked worktree regardless of path.
    const dir = cloneFixture('folder-a/backing-offscan');
    const bound = path.join(path.dirname(state.dataDir), 'elsewhere', 'bound');
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    git(dir, ['worktree', 'add', '-q', '-b', 'offscan', bound, 'HEAD']);
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'backs-worktrees' });
  });

  it('#190: still collects a clean, pushed, idle clone even when its agent group has a live container', () => {
    // The old behavior refused every clone under a group with any running
    // container — but groups/<folder> is itself a container bind-mount
    // source, so that gate fired unconditionally and made clone reclaim
    // unreachable. Scan-time collection no longer looks at container/session
    // liveness at all; only mount relation and process rooting (checked at
    // apply time — see the apply-mode and process-rooted tests below) can
    // refuse a specific clone.
    const dir = cloneFixture('folder-a/live');
    state.rows = [sessionRow('thread-live', 'folder-a', 'closed')];
    state.running.add('s-thread-live');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ category: 'clone', collect: true, reason: 'clean-and-pushed' });
  });

  it('refuses a clone idle only 10 days, but collects one idle 30 (the 14-day floor)', () => {
    const tooFresh = cloneFixture('folder-a/idle10');
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(tooFresh, tenDaysAgo, tenDaysAgo);

    const oldEnough = cloneFixture('folder-a/idle30');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(oldEnough, thirtyDaysAgo, thirtyDaysAgo);

    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, tooFresh)).toMatchObject({ collect: false, reason: 'recent' });
    expect(find(report, oldEnough)).toMatchObject({ collect: true, reason: 'clean-and-pushed' });
  });

  describe('hostPathForProcessCwd translation', () => {
    it('picks the longest matching mountpoint when both /workspace and /workspace/agent are mounted', () => {
      // Field index 3 (root) carries the host source for each mount; field 4
      // is the mountpoint as the process's namespace sees it.
      const mountinfo = [
        '20 1 0:20 / / rw - ext4 /dev/root rw',
        '21 20 0:21 /data/workgroups/wg-a /workspace rw - overlay overlay-wg rw',
        '22 21 0:22 /data/groups/folder-a /workspace/agent rw - overlay overlay-group rw',
      ].join('\n');
      const host = _hostPathForProcessCwdForTesting(mountinfo, '/workspace/agent/scratch/x');
      expect(host).toBe('/data/groups/folder-a/scratch/x');
    });

    it('maps a container path exactly at /workspace/agent to the host group dir', () => {
      const mountinfo = [
        '20 1 0:20 / / rw - ext4 /dev/root rw',
        '21 20 0:21 /data/workgroups/wg-a /workspace rw - overlay overlay-wg rw',
        '22 21 0:22 /data/groups/folder-a /workspace/agent rw - overlay overlay-group rw',
      ].join('\n');
      const host = _hostPathForProcessCwdForTesting(mountinfo, '/workspace/agent');
      expect(host).toBe('/data/groups/folder-a');
    });

    it('maps root mountpoint "/" as identity when nothing more specific matches', () => {
      const mountinfo = ['20 1 0:20 / / rw - ext4 /dev/root rw'].join('\n');
      const host = _hostPathForProcessCwdForTesting(mountinfo, '/home/ubuntu/some/where');
      expect(host).toBe('/home/ubuntu/some/where');
    });
  });

  describe('liveProcessCwds — a vanished process is not an unreadable one', () => {
    /** A fake /proc: each pid gets a `cwd` symlink, and mountinfo only if given. */
    function fakeProc(pids: Array<{ pid: string; cwd: string; mountinfo?: string }>): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
      for (const entry of pids) {
        const dir = path.join(root, entry.pid);
        fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync(entry.cwd, path.join(dir, 'cwd'));
        if (entry.mountinfo !== undefined) fs.writeFileSync(path.join(dir, 'mountinfo'), entry.mountinfo);
      }
      return root;
    }

    const IDENTITY = '20 1 0:20 / / rw - ext4 /dev/root rw';

    it('skips a pid whose mountinfo is GONE and still reports the others', () => {
      // No mountinfo file at all == the process exited mid-scan. Treating that
      // as unreadable would abort the pass, and on a host with constant
      // process churn that disables the GC intermittently and invisibly.
      const root = fakeProc([
        { pid: '100', cwd: '/home/ubuntu/live', mountinfo: IDENTITY },
        { pid: '200', cwd: '/home/ubuntu/vanished' },
      ]);
      try {
        expect(_liveProcessCwdsForTesting(root)).toEqual(['/home/ubuntu/live']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses the whole pass when a live pid mountinfo is unreadable for a REAL reason', () => {
      const root = fakeProc([{ pid: '100', cwd: '/home/ubuntu/live', mountinfo: IDENTITY }]);
      try {
        // A directory where a file belongs reads as EISDIR, not ENOENT — a
        // process that exists but cannot be placed.
        fs.rmSync(path.join(root, '100', 'mountinfo'));
        fs.mkdirSync(path.join(root, '100', 'mountinfo'));
        expect(_liveProcessCwdsForTesting(root)).toBeNull();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it.skipIf(!hasTrash)(
    '#190: a live process rooted in a clone refuses it as process-rooted, without trashing it',
    () => {
      const dir = cloneFixture('folder-a/rooted');
      const child = spawn('sleep', ['30'], { cwd: dir });
      try {
        if (child.pid) waitForProcCwd(child.pid);
        process.env.NANOCLAW_STORAGE_GC = 'apply';
        const report = runStorageGcOnce(state.dataDir, state.groupsDir);
        expect(find(report, dir)).toMatchObject({ collect: false, reason: 'process-rooted' });
        expect(fs.existsSync(dir)).toBe(true);
      } finally {
        child.kill();
      }
    },
  );

  it('never treats a symlink to a shared workgroup clone as a private clone', () => {
    const shared = path.join(state.dataDir, 'workgroups', WG, 'shared-repo');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const remote = makeRemote('shared-repo');
    execFileSync('git', ['clone', '-q', remote, shared]);
    fs.utimesSync(shared, OLD, OLD);

    const bedroom = path.join(state.groupsDir, 'folder-a', 'shared-repo');
    fs.mkdirSync(path.dirname(bedroom), { recursive: true });
    fs.symlinkSync(shared, bedroom);

    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, bedroom)).toBeUndefined();
    expect(find(report, shared)).toBeDefined();
  });

  it('ignores the repo store (.repos/.worktrees) at the workgroup root', () => {
    const store = path.join(state.dataDir, 'workgroups', WG, '.repos', 'thing');
    fs.mkdirSync(path.join(store, '.git'), { recursive: true });
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(report.candidates.some((c) => c.path.includes('.repos'))).toBe(false);
  });

  it('#190: reports a checkout whose .git points to an unresolvable container gitdir as keep-unprovable', () => {
    const dir = path.join(state.groupsDir, 'folder-a', 'unprovable-checkout');
    fs.mkdirSync(dir, { recursive: true });
    // `.git` is a FILE (not a real worktree here) pointing at a path that only
    // ever resolves inside the container that made it.
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /workspace/workgroup/repo-a/.git/worktrees/foo\n');
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ category: 'clone', collect: false, reason: 'keep-unprovable' });
  });

  it('does not report a checkout as keep-unprovable when its .git pointer resolves on the host', () => {
    const dir = path.join(state.groupsDir, 'folder-a', 'resolvable-checkout');
    fs.mkdirSync(dir, { recursive: true });
    // Points at a real host path (need not be a genuine gitdir — the
    // predicate only asks whether the target exists on this host).
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${state.dataDir}\n`);
    fs.utimesSync(dir, OLD, OLD);
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toBeUndefined();
  });
});

describe('storage GC — apply mode', () => {
  it.skipIf(!hasTrash)('removes NOTHING when the container runtime cannot be listed', () => {
    const { topicDir } = topicFixture('thread-clean');
    state.dockerBin = '/bin/false';
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(report.collected).toBe(0);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'runtime-unreadable' });
    expect(fs.existsSync(topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)('refuses a candidate mounted into a running container', () => {
    const { topicDir } = topicFixture('thread-clean');
    state.dockerBin = fakeRuntime([topicDir]);
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'container-mounted' });
    expect(fs.existsSync(topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)('refuses a topic that reopened between the scan and the removal', () => {
    const { topicDir } = topicFixture('thread-reopen');
    // Call 1 is the scan's inventory, call 2 its participant map; the pre-trash
    // recheck sees an active row that did not exist when the scan ran.
    state.rowsPerCall = [[], [], [sessionRow('thread-reopen', 'folder-a', 'active')]];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'recheck-topic-open' });
    expect(fs.existsSync(topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)('actually trashes an idle-qualified OPEN topic', () => {
    const { topicDir } = topicFixture('thread-idle-apply');
    state.rows = [sessionRow('thread-idle-apply', 'folder-a', 'active', 20)];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'idle-and-clean' });
    expect(fs.existsSync(topicDir)).toBe(false);
  });

  it.skipIf(!hasTrash)('deregisters the linked worktree so a resumed thread can recreate it — Codex #3', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-resume');
    state.rows = [sessionRow('thread-idle-resume', 'folder-a', 'active', 20)];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'idle-and-clean' });
    expect(fs.existsSync(topicDir)).toBe(false);
    // The canonical repo no longer lists the collected worktree...
    expect(git(canonical, ['worktree', 'list'])).not.toContain(branch);
    // ...so a resumed thread's create_worktree (same branch, fresh path) works.
    expect(() => git(canonical, ['worktree', 'add', '-q', worktree, branch])).not.toThrow();
  });

  it.skipIf(!hasTrash)('demotes an idle-qualified topic whose session went active again by recheck time', () => {
    const { topicDir } = topicFixture('thread-idle-recheck');
    // Same 3-call shape as the reopen test above: scan sees idle 20d (qualifies
    // and gets scheduled), pre-trash recheck sees idle only 10d (fails the
    // floor again) — proves stillDisposable re-evaluates the idle path fresh
    // rather than trusting the scan-time verdict.
    state.rowsPerCall = [
      [sessionRow('thread-idle-recheck', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-recheck', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-recheck', 'folder-a', 'active', 10)],
    ];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'recheck-topic-open' });
    expect(fs.existsSync(topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)(
    'restores an idle-qualified topic when activity advances after the pre-move recheck already passed',
    () => {
      // 5 calls per topic candidate in apply mode: (1) initial inventory,
      // (2) scan-time owners map (idleSnapshot captured here, idle 20d),
      // (3) stillDisposable's OWN sessionInventory() (clone-branch liveScopes,
      // unused here but still fetched), (4) stillDisposable's
      // participantsByTopic pre-move recheck (still idle 20d, passes), (5)
      // finalizeIdleCollection's OWN post-move recheck — this is the one
      // Codex's review added, and only it sees the late activity (idle 1d).
      const { topicDir, canonical, branch } = topicFixture('thread-idle-latemove');
      state.rowsPerCall = [
        [sessionRow('thread-idle-latemove', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-latemove', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-latemove', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-latemove', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-latemove', 'folder-a', 'active', 1)],
      ];
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-late-activity' });
      expect(fs.existsSync(topicDir)).toBe(true);
      // A rollback must never touch the canonical repo's worktree registration.
      expect(git(canonical, ['worktree', 'list'])).toContain(branch);
    },
  );

  it.skipIf(!hasTrash)(
    'round 5 P1: fails closed and restores when the post-move inventory check is unavailable',
    () => {
      const { topicDir, canonical, branch } = topicFixture('thread-idle-inventoryfail');
      state.rows = [sessionRow('thread-idle-inventoryfail', 'folder-a', 'active', 20)];
      // Call 4 (0-indexed) is finalizeIdleCollection's OWN direct
      // sessionInventory() check — everything before it (initial inventory,
      // owners map, stillDisposable's own inventory + participant recheck)
      // must still succeed for the topic to reach this point at all.
      state.failAtCall = 4;
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-recheck-unavailable' });
      expect(fs.existsSync(topicDir)).toBe(true);
      expect(git(canonical, ['worktree', 'list'])).toContain(branch);
    },
  );

  it.skipIf(!hasTrash)("round 5 P1: aborts when inbound.db's durable write moved after the scan snapshot", () => {
    const { topicDir, canonical, branch } = topicFixture('thread-idle-inboundmoved');
    state.rows = [sessionRow('thread-idle-inboundmoved', 'folder-a', 'active', 20)];
    const inboundPath = path.join(
      state.dataDir,
      'v2-sessions',
      'ag-thread-idle-inboundmoved',
      's-thread-idle-inboundmoved',
      'inbound.db',
    );
    fs.mkdirSync(path.dirname(inboundPath), { recursive: true });
    fs.writeFileSync(inboundPath, '');
    const old = new Date(Date.now() - 20 * 86_400_000);
    fs.utimesSync(inboundPath, old, old);
    // Simulate a message landing (bumping inbound.db's mtime, the durable
    // write) in the gap right after the scan snapshot — same synchronous
    // point the earlier rollback tests use to inject a mid-flight race.
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      realRename(from as fs.PathLike, to as fs.PathLike);
      const now = new Date();
      fs.utimesSync(inboundPath, now, now);
    });
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    vi.restoreAllMocks();
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-late-activity' });
    expect(fs.existsSync(topicDir)).toBe(true);
    expect(git(canonical, ['worktree', 'list'])).toContain(branch);
  });

  it.skipIf(!hasTrash)('round 5 P2: recovers a topic orphaned in quarantine by a prior interrupted pass', () => {
    const { topicDir } = topicFixture('thread-idle-orphanquarantine');
    const quarantinePath = path.join(state.dataDir, '.gc-quarantine', 'orphan-1');
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.cpSync(topicDir, quarantinePath, { recursive: true });
    fs.rmSync(topicDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(quarantinePath, '.gc-quarantine-meta.json'), JSON.stringify({ originalPath: topicDir }));
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'quarantine-recovered' });
    expect(fs.existsSync(topicDir)).toBe(true);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-quarantine'))).toBe(false);
  });

  it.skipIf(!hasTrash)('round 5 P2: reconciles an orphaned quarantine entry whose destination was recreated', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-orphanreconcile');
    const quarantinePath = path.join(state.dataDir, '.gc-quarantine', 'orphan-2');
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.cpSync(topicDir, quarantinePath, { recursive: true });
    fs.rmSync(topicDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(quarantinePath, '.gc-quarantine-meta.json'), JSON.stringify({ originalPath: topicDir }));
    // The destination exists again — a spawn recreated this repo's slot
    // while the process was down.
    fs.mkdirSync(worktree, { recursive: true });
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'quarantine-reconciled' });
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-quarantine'))).toBe(false);
    expect(git(canonical, ['worktree', 'list'])).not.toContain(branch);
    expect(() => git(canonical, ['worktree', 'add', '-q', `${worktree}-2`, branch])).not.toThrow();
  });

  it.skipIf(!hasTrash)('round 6 P1: leaves the entry in quarantine when its worktrees listing is unreadable', () => {
    const { topicDir, canonical, branch } = topicFixture('thread-idle-unreadable');
    state.rows = [sessionRow('thread-idle-unreadable', 'folder-a', 'active', 20)];
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      realRename(from as fs.PathLike, to as fs.PathLike);
      fs.chmodSync(path.join(to as string, 'worktrees'), 0o000); // EACCES-shaped
    });
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    let report: GcReport;
    try {
      report = runStorageGcOnce(state.dataDir, state.groupsDir);
    } finally {
      vi.restoreAllMocks();
    }
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'quarantine-unreadable' });
    expect(fs.existsSync(topicDir)).toBe(false); // untouched, not restored — still in quarantine
    expect(git(canonical, ['worktree', 'list'])).toContain(branch); // never pruned
    // Restore permissions so afterEach's rmSync can actually clean up.
    const quarantineRoot = path.join(state.dataDir, '.gc-quarantine');
    for (const entry of fs.readdirSync(quarantineRoot)) {
      fs.chmodSync(path.join(quarantineRoot, entry, 'worktrees'), 0o755);
    }
  });

  it.skipIf(!hasTrash)('round 6 P2: a locked quarantined repo copy is left in quarantine, never trashed', () => {
    const { topicDir, worktree, canonical } = topicFixture('thread-idle-orphanlocked');
    git(canonical, ['worktree', 'lock', worktree]);
    const quarantinePath = path.join(state.dataDir, '.gc-quarantine', 'orphan-locked');
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.cpSync(topicDir, quarantinePath, { recursive: true });
    fs.rmSync(topicDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(quarantinePath, '.gc-quarantine-meta.json'), JSON.stringify({ originalPath: topicDir }));
    // Destination recreated -> the "keep the live copy" reconcile branch.
    fs.mkdirSync(worktree, { recursive: true });
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'quarantine-reconciled' });
    // Never trashed — the locked copy is still sitting in quarantine, unresolved.
    expect(fs.existsSync(path.join(quarantinePath, 'worktrees', path.basename(worktree)))).toBe(true);
  });

  it.skipIf(!hasTrash)('P2: a trash failure restores intact and runs no prune — the checkout stays usable', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-trashfail');
    state.rows = [sessionRow('thread-idle-trashfail', 'folder-a', 'active', 20)];
    // Block trash-cli's own trash dir (a FILE where it wants a directory)
    // so the real `/usr/bin/trash` call fails deterministically — confirmed
    // this makes trash-put exit 74 rather than silently falling back.
    const blockedXdg = path.join(path.dirname(state.dataDir), 'blocked-xdg-data-home');
    fs.writeFileSync(blockedXdg, '');
    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = blockedXdg;
    try {
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'trash-failed' });
      expect(fs.existsSync(topicDir)).toBe(true);
      // Registration untouched — prune must not have run.
      expect(git(canonical, ['worktree', 'list'])).toContain(branch);
      // The restored checkout is actually usable.
      expect(() => git(worktree, ['rev-parse', 'HEAD'])).not.toThrow();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  it.skipIf(!hasTrash)('P1: rollback tolerates the spawn path recreating just the worktrees root', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-rootrecreated');
    state.rowsPerCall = [
      [sessionRow('thread-idle-rootrecreated', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-rootrecreated', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-rootrecreated', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-rootrecreated', 'folder-a', 'active', 20)],
      [sessionRow('thread-idle-rootrecreated', 'folder-a', 'active', 1)],
    ];
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      realRename(from as fs.PathLike, to as fs.PathLike);
      // container-runner.ts:1746's own mkdirSync(<topic>/worktrees, {recursive:true}) —
      // the root exists again, but this repo's slot inside it does not yet.
      fs.mkdirSync(path.join(topicDir, 'worktrees'), { recursive: true });
    });
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    vi.restoreAllMocks();
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-late-activity' });
    // The destination slot was free — per-repo rename landed normally, no
    // stranding, so registrations stayed valid and nothing got pruned.
    expect(git(canonical, ['worktree', 'list'])).toContain(branch);
    expect(() => git(worktree, ['rev-parse', 'HEAD'])).not.toThrow();
  });

  it.skipIf(!hasTrash)(
    'P1: destination slot already occupied — keeps the live copy and prunes so the branch is free again',
    () => {
      const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-slotoccupied');
      state.rowsPerCall = [
        [sessionRow('thread-idle-slotoccupied', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-slotoccupied', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-slotoccupied', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-slotoccupied', 'folder-a', 'active', 20)],
        [sessionRow('thread-idle-slotoccupied', 'folder-a', 'active', 1)],
      ];
      const realRename = fs.renameSync.bind(fs);
      vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
        realRename(from as fs.PathLike, to as fs.PathLike);
        // The agent fully recreated this repo's worktree slot before rollback ran.
        fs.mkdirSync(worktree, { recursive: true });
      });
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      vi.restoreAllMocks();
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-late-activity' });
      // The live (recreated) copy was kept in place, not clobbered.
      expect(fs.existsSync(worktree)).toBe(true);
      // Its dangling registration was pruned, so the branch is free for a
      // fresh checkout elsewhere.
      expect(git(canonical, ['worktree', 'list'])).not.toContain(branch);
      expect(() => git(canonical, ['worktree', 'add', '-q', `${worktree}-2`, branch])).not.toThrow();
    },
  );

  it.skipIf(!hasTrash)('trashes a CLOSED-path topic directly, untouched by the idle rollback logic', () => {
    const { topicDir } = topicFixture('thread-closed-apply');
    state.rows = [sessionRow('thread-closed-apply', 'folder-a', 'closed')];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({ collect: true, reason: 'closed-and-clean' });
    expect(fs.existsSync(topicDir)).toBe(false);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-quarantine'))).toBe(false);
  });

  it.skipIf(!hasTrash)('removes only what the predicate cleared', () => {
    const clean = topicFixture('thread-clean');
    const dirty = topicFixture('thread-dirty');
    fs.writeFileSync(path.join(dirty.worktree, 'uncommitted.txt'), 'keep me');

    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(report.mode).toBe('apply');
    expect(report.collected).toBe(1);
    expect(fs.existsSync(clean.topicDir)).toBe(false);
    expect(fs.existsSync(dirty.topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)(
    '#183: aborts when inbound.db moves after freshMounts/repoListing but before the physical trash',
    () => {
      const { topicDir, canonical, branch } = topicFixture('thread-idle-latewrite');
      state.rows = [sessionRow('thread-idle-latewrite', 'folder-a', 'active', 20)];
      const inboundPath = path.join(
        state.dataDir,
        'v2-sessions',
        'ag-thread-idle-latewrite',
        's-thread-idle-latewrite',
        'inbound.db',
      );
      fs.mkdirSync(path.dirname(inboundPath), { recursive: true });
      fs.writeFileSync(inboundPath, '');
      const old = new Date(Date.now() - 20 * 86_400_000);
      fs.utimesSync(inboundPath, old, old);

      // Simulate a message landing (bumping inbound.db's durable-write mtime)
      // AFTER the freshMounts/container-runtime check has already run — the
      // window #183 narrows by moving the mtime fence to be the LAST check
      // before the physical trash. Hooked on the quarantine worktrees listing,
      // the step immediately preceding that final fence.
      const realReaddir = fs.readdirSync.bind(fs);
      let injected = false;
      vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: unknown, opts?: unknown) => {
        if (!injected && typeof dir === 'string' && dir.includes('.gc-quarantine') && dir.endsWith('worktrees')) {
          injected = true;
          const now = new Date();
          fs.utimesSync(inboundPath, now, now);
        }
        return (realReaddir as (...args: unknown[]) => unknown)(dir, opts);
      }) as typeof fs.readdirSync);
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      let report: GcReport;
      try {
        report = runStorageGcOnce(state.dataDir, state.groupsDir);
      } finally {
        vi.restoreAllMocks();
      }
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-late-activity' });
      expect(fs.existsSync(topicDir)).toBe(true);
      expect(git(canonical, ['worktree', 'list'])).toContain(branch);
    },
  );

  it.skipIf(!hasTrash)('#184: a metadata-write failure leaves the topic untouched, never half-quarantined', () => {
    const { topicDir, canonical, branch } = topicFixture('thread-idle-metafail');
    state.rows = [sessionRow('thread-idle-metafail', 'folder-a', 'active', 20)];
    fs.chmodSync(topicDir, 0o555); // no write permission: writing the marker into it fails
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    let report: GcReport;
    try {
      report = runStorageGcOnce(state.dataDir, state.groupsDir);
    } finally {
      fs.chmodSync(topicDir, 0o755); // restore so afterEach's rmSync can clean up
    }
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'quarantine-meta-write-failed' });
    // Nothing was renamed — the topic never left its original path.
    expect(fs.existsSync(topicDir)).toBe(true);
    expect(git(canonical, ['worktree', 'list'])).toContain(branch);
  });

  it.skipIf(!hasTrash)('#185: sweeps and finishes a prune left dangling by a crash between trash and dereg', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-prunecrash');
    const repo = path.basename(worktree);
    // Simulate the crash window directly: the checkout is already gone (as
    // if trashPath had succeeded) but the canonical registration was never
    // pruned, and the journal #185 writes before every trash records exactly
    // this pending prune — the state a crash right after trashPath leaves.
    fs.rmSync(topicDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(state.dataDir, '.gc-pending-prunes.json'), JSON.stringify([{ workgroupId: WG, repo }]));
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(git(canonical, ['worktree', 'list'])).not.toContain(branch);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-pending-prunes.json'))).toBe(false);
    // The branch is free again for a fresh checkout.
    expect(() => git(canonical, ['worktree', 'add', '-q', `${worktree}-2`, branch])).not.toThrow();
  });

  it.skipIf(!hasTrash)('Codex P2: aborts collection when the prune journal cannot be persisted', () => {
    const { topicDir, canonical, branch } = topicFixture('thread-idle-journalfail');
    state.rows = [sessionRow('thread-idle-journalfail', 'folder-a', 'active', 20)];
    // Pre-create the quarantine root (writable) so only the journal WRITE
    // itself — not the earlier rename into quarantine — is blocked by making
    // dataDir read-only afterward (simulating a read-only dataDir / ENOSPC).
    fs.mkdirSync(path.join(state.dataDir, '.gc-quarantine'), { recursive: true });
    fs.chmodSync(state.dataDir, 0o555);
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    let report: GcReport;
    try {
      report = runStorageGcOnce(state.dataDir, state.groupsDir);
    } finally {
      fs.chmodSync(state.dataDir, 0o755); // restore so afterEach's rmSync can clean up
    }
    expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-prune-journal-unwritable' });
    // Nothing was ever trashed — the topic was rolled back, not left dangling.
    expect(fs.existsSync(topicDir)).toBe(true);
    expect(git(canonical, ['worktree', 'list'])).toContain(branch);
  });

  it.skipIf(!hasTrash)('Codex P2: a trash failure preserves an OLDER pending-prune entry for the same repo', () => {
    const { topicDir, worktree, canonical, branch } = topicFixture('thread-idle-trashfail-journal');
    const repo = path.basename(worktree);
    state.rows = [sessionRow('thread-idle-trashfail-journal', 'folder-a', 'active', 20)];
    // A stale entry from an earlier interrupted pass, for the SAME
    // workgroupId/repo this attempt is about to journal too.
    const olderEntry = { workgroupId: WG, repo };
    fs.writeFileSync(path.join(state.dataDir, '.gc-pending-prunes.json'), JSON.stringify([olderEntry]));

    // Make the SWEEP's own prune attempt on the older entry fail (as if it
    // were still failing from the prior interrupted pass), so it survives
    // into this pass's collection cycle instead of being cleared before
    // collection even starts. Self-clearing: only that one call is touched,
    // every other git invocation (status/log/stash, the real trash) is real.
    state.failPruneOnce = true;

    // Block trash-cli's own trash dir so the real /usr/bin/trash call fails
    // deterministically (same technique as the P2 trash-failure test above).
    const blockedXdg = path.join(path.dirname(state.dataDir), 'blocked-xdg-data-home-journal');
    fs.writeFileSync(blockedXdg, '');
    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = blockedXdg;
    try {
      process.env.NANOCLAW_STORAGE_GC = 'apply';
      const report = runStorageGcOnce(state.dataDir, state.groupsDir);
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'trash-failed' });
      expect(fs.existsSync(topicDir)).toBe(true);
      expect(git(canonical, ['worktree', 'list'])).toContain(branch);
      // The older entry must survive — a naive filter-by-workgroupId/repo
      // would also wipe it, even though it predates this attempt.
      const journal = JSON.parse(fs.readFileSync(path.join(state.dataDir, '.gc-pending-prunes.json'), 'utf8'));
      expect(journal).toEqual([olderEntry]);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  it.skipIf(!hasTrash)(
    'Codex P2: a failed journal write never corrupts the existing journal (atomic tmp+rename)',
    () => {
      const { topicDir } = topicFixture('thread-idle-journalpartial');
      state.rows = [sessionRow('thread-idle-journalpartial', 'folder-a', 'active', 20)];
      const journalPath = path.join(state.dataDir, '.gc-pending-prunes.json');
      const existing = [{ workgroupId: WG, repo: 'unrelated-repo' }];
      fs.writeFileSync(journalPath, JSON.stringify(existing));

      // Force the TEMP-file write to fail (simulating ENOSPC/EIO/a kill
      // mid-write). Because writes go to a tmp path first, this must never
      // touch the real journal file at all.
      const realWriteFileSync = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
        const [file] = args;
        if (typeof file === 'string' && file.includes('.gc-pending-prunes.json.tmp-')) {
          throw new Error('simulated: partial write / crash mid-write');
        }
        return (realWriteFileSync as (...a: unknown[]) => unknown)(...args);
      }) as typeof fs.writeFileSync);

      process.env.NANOCLAW_STORAGE_GC = 'apply';
      let report: GcReport;
      try {
        report = runStorageGcOnce(state.dataDir, state.groupsDir);
      } finally {
        vi.restoreAllMocks();
      }
      expect(find(report, topicDir)).toMatchObject({ collect: false, reason: 'aborted-prune-journal-unwritable' });
      // The pre-existing journal content survives untouched — no corruption.
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toEqual(existing);
    },
  );

  it.skipIf(!hasTrash)('#190: collects a clone via quarantine — the directory is gone afterward', () => {
    const dir = cloneFixture('folder-a/collectme');
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ category: 'clone', collect: true, reason: 'clean-and-pushed' });
    expect(fs.existsSync(dir)).toBe(false);
    // Nothing left behind under quarantine — trashPath took the moved copy,
    // and the (now-empty) quarantine root itself is reaped by a later pass's
    // recoverOrphanedQuarantine, not asserted here.
    expect(fs.readdirSync(path.join(state.dataDir, '.gc-quarantine'))).toEqual([]);
  });

  it.skipIf(!hasTrash)('#190: a clone made DIRTY during the quarantine window is restored, not trashed', () => {
    // finalizeCloneCollection re-runs the full git proof against the MOVED
    // copy after the rename into quarantine. Hook the rename itself (same
    // technique the topic-side "late activity" tests above use) to write an
    // untracked file into the quarantined copy right after the move — this
    // is the exact race the post-move re-proof exists to catch.
    const dir = cloneFixture('folder-a/dirtiedlate');
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      realRename(from as fs.PathLike, to as fs.PathLike);
      fs.writeFileSync(path.join(to as string, 'dirtied-during-quarantine.txt'), 'late write');
    });
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    let report: GcReport;
    try {
      report = runStorageGcOnce(state.dataDir, state.groupsDir);
    } finally {
      vi.restoreAllMocks();
    }
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'aborted-dirty' });
    // Restored to its original path with the late write intact — nothing lost.
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dirtied-during-quarantine.txt'))).toBe(true);
    expect(fs.readdirSync(path.join(state.dataDir, '.gc-quarantine'))).toEqual([]);
  });

  it.skipIf(!hasTrash)('#190: a rollback that cannot restore KEEPS the sidecar, so recovery can still find it', () => {
    // Codex review: restoreQuarantinedClone used to delete the marker before
    // it knew the restore would succeed. When the destination has been
    // recreated the function returns early, which left an entry on disk whose
    // marker was already gone — the one state cloneSidecarPath promises is
    // impossible, and one recoverOrphanedQuarantine can never identify again.
    // Recreate the original path during the rename to force that branch.
    const dir = cloneFixture('folder-a/rollbackblocked');
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      realRename(from as fs.PathLike, to as fs.PathLike);
      // Dirty the moved copy so the re-proof aborts AND put something back at
      // the original path, so the rollback hits the "recreated" branch.
      fs.writeFileSync(path.join(to as string, 'late.txt'), 'late');
      fs.mkdirSync(from as string, { recursive: true });
      fs.writeFileSync(path.join(from as string, 'recreated.txt'), 'new work');
    });
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    try {
      runStorageGcOnce(state.dataDir, state.groupsDir);
    } finally {
      vi.restoreAllMocks();
    }
    const entries = fs.readdirSync(path.join(state.dataDir, '.gc-quarantine'));
    const dirs = entries.filter((e) => !e.endsWith('.meta.json'));
    // The quarantined copy is still there — and so is a marker naming it.
    expect(dirs).toHaveLength(1);
    expect(entries).toContain(`${dirs[0]}.meta.json`);
    // Nothing was destroyed on either side.
    expect(fs.existsSync(path.join(dir, 'recreated.txt'))).toBe(true);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-quarantine', dirs[0], 'late.txt'))).toBe(true);
  });

  it.skipIf(!hasTrash)('#190: recovers a CLONE orphaned in quarantine by a prior interrupted pass', () => {
    // The clone marker is a SIDECAR next to the entry (`<entry>.meta.json`),
    // not a file inside it — see cloneSidecarPath. The ordering invariant
    // (marker written before the rename, deleted only after trash succeeds)
    // means a crash can leave (marker, no entry) but never (entry, no
    // marker), so recoverOrphanedQuarantine only ever needs to handle the
    // entry-present case for a clone.
    const originalPath = path.join(state.groupsDir, 'folder-a', 'orphan-clone');
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    const quarantinePath = path.join(state.dataDir, '.gc-quarantine', 'orphan-clone-123');
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.writeFileSync(path.join(quarantinePath, 'marker.txt'), 'kept');
    fs.writeFileSync(`${quarantinePath}.meta.json`, JSON.stringify({ originalPath, category: 'clone' }));
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, originalPath)).toMatchObject({
      category: 'clone',
      collect: false,
      reason: 'quarantine-restored',
    });
    expect(fs.existsSync(originalPath)).toBe(true);
    expect(fs.existsSync(path.join(originalPath, 'marker.txt'))).toBe(true);
    expect(fs.existsSync(`${quarantinePath}.meta.json`)).toBe(false);
    expect(fs.existsSync(path.join(state.dataDir, '.gc-quarantine'))).toBe(false);
  });

  it.skipIf(!hasTrash)('#190: an orphaned quarantine entry with no category field is still treated as a topic', () => {
    const { topicDir } = topicFixture('thread-idle-nocategory');
    const quarantinePath = path.join(state.dataDir, '.gc-quarantine', 'orphan-nocat');
    fs.mkdirSync(quarantinePath, { recursive: true });
    fs.cpSync(topicDir, quarantinePath, { recursive: true });
    fs.rmSync(topicDir, { recursive: true, force: true });
    // No `category` field at all — the pre-#190 shape.
    fs.writeFileSync(path.join(quarantinePath, '.gc-quarantine-meta.json'), JSON.stringify({ originalPath: topicDir }));
    state.rows = [];
    process.env.NANOCLAW_STORAGE_GC = 'apply';
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, topicDir)).toMatchObject({
      category: 'orphan-topic',
      collect: false,
      reason: 'quarantine-recovered',
    });
    expect(fs.existsSync(topicDir)).toBe(true);
  });

  it.skipIf(!hasTrash)(
    '#190: a process that exits between the cwd readlink and the mountinfo read does not abort the whole pass',
    () => {
      // Simulate the exact race hostPathForProcessCwd's ENOENT/ESRCH branch
      // exists for: readdirSync('/proc') sees a pid, readlinkSync(cwd) still
      // succeeds, but the process is gone by the time mountinfo is read. A
      // phantom pid lets us force exactly that sequence deterministically,
      // without racing a real process exit.
      const dir = cloneFixture('folder-a/racy');
      const phantomPid = '999999999';
      const realReaddirSync = fs.readdirSync.bind(fs);
      const realReadlinkSync = fs.readlinkSync.bind(fs);
      const realReadFileSync = fs.readFileSync.bind(fs);
      vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, opts?: unknown) => {
        if (p === '/proc' && !opts) return [...(realReaddirSync(p as string) as string[]), phantomPid];
        return (realReaddirSync as (...args: unknown[]) => unknown)(p, opts);
      }) as typeof fs.readdirSync);
      vi.spyOn(fs, 'readlinkSync').mockImplementation(((p: unknown, opts?: unknown) => {
        if (p === `/proc/${phantomPid}/cwd`) return '/workspace/agent/gone';
        return (realReadlinkSync as (...args: unknown[]) => unknown)(p, opts);
      }) as typeof fs.readlinkSync);
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        if (p === `/proc/${phantomPid}/mountinfo`) {
          const err = new Error('simulated: process exited mid-scan') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return (realReadFileSync as (...args: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readFileSync);

      process.env.NANOCLAW_STORAGE_GC = 'apply';
      let report: GcReport;
      try {
        report = runStorageGcOnce(state.dataDir, state.groupsDir);
      } finally {
        vi.restoreAllMocks();
      }
      expect(find(report, dir)).toMatchObject({ category: 'clone', collect: true, reason: 'clean-and-pushed' });
      expect(fs.existsSync(dir)).toBe(false);
    },
  );
});
