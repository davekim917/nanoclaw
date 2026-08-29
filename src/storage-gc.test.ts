import { execFileSync } from 'child_process';
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
}));

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
        if (state.rowsPerCall) {
          const index = Math.min(state.call, state.rowsPerCall.length - 1);
          state.call += 1;
          return state.rowsPerCall[index];
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

import { runStorageGcOnce, type GcCandidate, type GcReport } from './worktree-cleanup.js';
import { resolveRepositoryWorkUnit, topicStateDir } from './repository-workspaces.js';

const WG = 'wg-a';
const OLD = new Date(Date.now() - 30 * 86_400_000);

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

  it('refuses a clone whose agent group has a live container', () => {
    const dir = cloneFixture('folder-a/live');
    state.rows = [sessionRow('thread-live', 'folder-a', 'closed')];
    state.running.add('s-thread-live');
    const report = runStorageGcOnce(state.dataDir, state.groupsDir);
    expect(find(report, dir)).toMatchObject({ collect: false, reason: 'agent-group-live' });
  });

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
});

describe('storage GC — apply mode', () => {
  const hasTrash = fs.existsSync('/usr/bin/trash');

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
});
