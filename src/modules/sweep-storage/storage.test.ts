/**
 * Acceptance cases for the storage sweep family (convergence seam 2, S2-PR6 —
 * F-6.2, F-6.5 in docs/specs/upstream-host-sweep-seam/plan.md §8). T-3 (S2-PR1
 * module timers) is reproduced here per the S2-PR6 brief, since S2-PR1 is not
 * merged under S2-PR2 on this branch's base — see the deviation note in
 * ./index.ts's docstring (onShutdown vs onHostShutdown).
 *
 * Hermeticity (brief-common.md HARD RULE): importing this module's ./index.js
 * registers T13 at import — registration only pushes a duty object into an
 * array (no body executes), and host-sweep.ts's own import graph is inert at
 * import time (S2-PR5's orchestrator.test.ts documents the same property).
 *
 * The G64-moved pruneIdleSessionArtifacts/pruneIdleThreadArtifacts cases
 * drive storage-manager.ts's REAL implementation (tmp fixtures only, per
 * plan — moved unchanged, not re-mocked into a no-op). That implementation's
 * `getFilesystemUsage` legitimately shells out to `df` on every call (a pure,
 * side-effect-free local read, already caught in its own try/catch) —
 * storage-manager.test.ts's own precedent (`mockExecFileSync`, no tripwire)
 * mocks this the same way, since a blanket throwing tripwire would fail a
 * call the code path takes by design, not a hazard. `execFileSync` here is a
 * controllable stand-in, not a tripwire that throws — but it still records
 * every command name, and the shared assertion below is the hermeticity
 * guarantee: the ONLY command ever reaches it is `df`. `tar` and
 * CONTAINER_RUNTIME_BIN (docker) — the two real hazards a storage-manager.ts
 * code path could reach — never appear, because these tests exercise only
 * the idle-artifact prune path (`includeDocker: false`, no archive/restore
 * involved).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncCalls = vi.hoisted(() => [] as string[]);
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    execFileSync: (...args: unknown[]) => {
      execFileSyncCalls.push(String(args[0]));
      return mockExecFileSync(...args);
    },
  };
});

afterEach(() => {
  // The hermeticity guarantee for this file: only the benign `df` disk-usage
  // probe ever reaches a real process seam — never `tar`, never docker.
  expect(
    execFileSyncCalls.every((cmd) => cmd === 'df'),
    `unexpected real commands: ${execFileSyncCalls}`,
  ).toBe(true);
  execFileSyncCalls.length = 0;
  mockExecFileSync.mockReset();
});

const mocks = vi.hoisted(() => ({
  runStorageMaintenanceInBackground: vi.fn(),
  stopStorageMaintenanceWorker: vi.fn(),
  handleStoragePressureAlert: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../storage-maintenance-worker.js', () => ({
  runStorageMaintenanceInBackground: mocks.runStorageMaintenanceInBackground,
  stopStorageMaintenanceWorker: mocks.stopStorageMaintenanceWorker,
}));
vi.mock('../../storage-pressure-alert.js', () => ({
  handleStoragePressureAlert: mocks.handleStoragePressureAlert,
}));
vi.mock('../../log.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../log.js')>();
  return {
    ...real,
    log: { info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: mocks.logDebug },
  };
});

import { getShutdownCallbacks } from '../../response-registry.js';
// Registers T13 into host-sweep.ts's live registry — needed so the F-6.2
// registered-wrapper case below can obtain it by name, the same accessor R-7
// uses in src/host-sweep-registry.test.ts. Safe to import unmocked:
// registration is inert at import time (see docstring above).
import { startStorageMaintenanceOnce } from './index.js';
import { _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';

// ── T-3 (S2-PR1, reproduced) ─────────────────────────────────────────────────

describe('storage maintenance start and stop are declared in one module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('startStorageMaintenanceOnce is exported from the module and wraps the background worker call', async () => {
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(null);

    startStorageMaintenanceOnce(['session-1', 'session-2']);
    // Fire-and-forget: let the microtask queue drain so the .then/.catch chain runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStorageMaintenanceInBackground).toHaveBeenCalledWith(['session-1', 'session-2']);
    expect(mocks.handleStoragePressureAlert).not.toHaveBeenCalled();
  });

  it('forwards a non-null storage report to handleStoragePressureAlert, same as the former host-sweep.ts call site', async () => {
    const report = { usagePct: 91 } as never;
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(report);

    startStorageMaintenanceOnce(['session-1']);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.handleStoragePressureAlert).toHaveBeenCalledWith(report);
  });

  it('a rejected background pass is caught and logged, never left unhandled', async () => {
    mocks.runStorageMaintenanceInBackground.mockRejectedValue(new Error('background boom'));

    startStorageMaintenanceOnce(['session-1']);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      'storage-manager: background maintenance failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('registers a shutdown callback that stops the worker, guarding a failed stop', async () => {
    mocks.stopStorageMaintenanceWorker.mockResolvedValue(undefined);

    const callbacksBefore = getShutdownCallbacks().length;
    expect(callbacksBefore).toBeGreaterThan(0);
    const shutdown = getShutdownCallbacks()[callbacksBefore - 1];
    await shutdown();

    expect(mocks.stopStorageMaintenanceWorker).toHaveBeenCalledTimes(1);
  });

  it('a stop failure is logged, not thrown, so the rest of shutdown proceeds', async () => {
    mocks.stopStorageMaintenanceWorker.mockRejectedValue(new Error('stop boom'));

    const callbacks = getShutdownCallbacks();
    const shutdown = callbacks[callbacks.length - 1];
    await expect(shutdown()).resolves.toBeUndefined();

    expect(mocks.logError).toHaveBeenCalledWith(
      'Storage maintenance worker failed to stop cleanly',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('src/main.ts still references stopStorageMaintenanceWorker directly (S2-PR1 prerequisite gap)', () => {
    // Deviation from T-3's original assertion ("main.ts references neither"):
    // S2-PR1 has not landed on this branch's base, so main.ts's own direct
    // call is still there — harmless (stopStorageMaintenanceWorker's
    // underlying close() is idempotent) but not yet removed, since removing
    // it is S2-PR1's job, outside S2-PR6's ownership. See ./index.ts's
    // docstring.
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    expect(source).not.toMatch(/\bstartStorageMaintenanceOnce\b/);
    expect(source).toMatch(/\bstopStorageMaintenanceWorker\b/);
  });
});

// ── F-6.2 ────────────────────────────────────────────────────────────────────

describe("storage maintenance runs after the session fan-out and keeps the worker's own cadence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T13 is registered on tick:post-session at order 30, after the per-session fan-out phases', () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const t13 = duties.find((d) => d.name === 'storage-maintenance');
    expect(t13).toBeDefined();
    expect(t13?.phase).toBe('tick:post-session');
    expect(t13?.order).toBe(30);
  });

  it("run(ctx) forwards the tick's active container session ids, without calling its own session scan", async () => {
    // Family-case rule: for a duty that consumes ctx.sessions/activeContainerSessionIds,
    // pass a sentinel and assert it was forwarded verbatim — not re-derived.
    const { duties } = _listSweepRegistrationsForTesting();
    const t13 = duties.find((d) => d.name === 'storage-maintenance');
    if (!t13) throw new Error('duty storage-maintenance not registered');
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(null);
    const sentinel = new Set(['sentinel-session-a', 'sentinel-session-b']);
    const ctx = { now: Date.now(), sessions: [], activeContainerSessionIds: sentinel } as unknown as SweepTickContext;

    t13.run(ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStorageMaintenanceInBackground).toHaveBeenCalledWith(['sentinel-session-a', 'sentinel-session-b']);
  });

  // The worker's own 1h scan / 6h prune cadence lives entirely inside
  // storage-maintenance-worker.ts (BackgroundStorageMaintenance), which this
  // duty's registered wrapper never re-implements — it is mocked wholesale
  // above, and its own cadence is that file's test surface, not this
  // family's. Asserted here only as "the wrapper does not own a cadence of
  // its own": calling run(ctx) twice calls the (mocked) worker twice, with no
  // throttling at the sweep-duty layer.
  it("the registered wrapper adds no throttle of its own — cadence is entirely the worker's", () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const t13 = duties.find((d) => d.name === 'storage-maintenance');
    if (!t13) throw new Error('duty storage-maintenance not registered');
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(null);
    const ctx = {
      now: Date.now(),
      sessions: [],
      activeContainerSessionIds: new Set<string>(),
    } as unknown as SweepTickContext;

    t13.run(ctx);
    t13.run(ctx);

    expect(mocks.runStorageMaintenanceInBackground).toHaveBeenCalledTimes(2);
  });
});

// ── F-6.5 (G64 deletion) ─────────────────────────────────────────────────────
//
// pruneIdleSessionArtifacts/pruneIdleThreadArtifacts were thin back-compat
// shims in host-sweep.ts wrapping storage-manager.ts's own exports with
// host-owned defaults (isContainerRunning, sessionsBaseDir()). storage-
// manager.ts already exports both directly with its own defaults
// (isContainerRunning defaulting to () => false, root defaulting to
// sessionsBaseDir()/threadsBaseDir()) — the shims added no behavior, only an
// extra hop. Deleted from host-sweep.ts; the 12 cases that exercised them are
// moved here UNCHANGED (assertions untouched), now calling storage-manager.js
// directly and passing isContainerRunning explicitly where the pre-move
// cases relied on host-sweep.ts's bound default.

describe('the idle-artifact prune shims are gone and callers use storage-manager directly', () => {
  it('pruneIdleSessionArtifacts and pruneIdleThreadArtifacts are no longer exported from host-sweep.ts', async () => {
    const hostSweep = (await import('../../host-sweep.js')) as unknown as Record<string, unknown>;
    expect(hostSweep.pruneIdleSessionArtifacts).toBeUndefined();
    expect(hostSweep.pruneIdleThreadArtifacts).toBeUndefined();
    expect(hostSweep.SESSION_ARTIFACT_IDLE_MS).toBeUndefined();
    // They (and the constant) were always, and remain, storage-manager.ts's own.
    const storageManager = await import('../../storage-manager.js');
    expect(typeof storageManager.pruneIdleSessionArtifacts).toBe('function');
    expect(typeof storageManager.pruneIdleThreadArtifacts).toBe('function');
    expect(typeof storageManager.SESSION_ARTIFACT_IDLE_MS).toBe('number');
  });

  describe('pruneIdleSessionArtifacts (moved from host-sweep.test.ts, now calling storage-manager.js directly)', () => {
    let tmpRoot: string;
    let isContainerRunning: (sessionId: string) => boolean;
    const HOUR = 60 * 60 * 1000;
    let SESSION_ARTIFACT_IDLE_MS: number;
    let pruneIdleSessionArtifacts: typeof import('../../storage-manager.js').pruneIdleSessionArtifacts;

    beforeEach(async () => {
      const storageManager = await import('../../storage-manager.js');
      pruneIdleSessionArtifacts = storageManager.pruneIdleSessionArtifacts;
      SESSION_ARTIFACT_IDLE_MS = storageManager.SESSION_ARTIFACT_IDLE_MS;
      isContainerRunning = () => false;
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-storage-prune-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function makeSession(opts: {
      group: string;
      sess: string;
      dbAgeMs: number;
      withNodeModules?: boolean;
      withPnpmStore?: boolean;
      nodeModulesInWorktree?: boolean;
    }): string {
      const dir = path.join(tmpRoot, opts.group, opts.sess);
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'inbound.db');
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE messages_in (
        status TEXT NOT NULL DEFAULT 'completed',
        trigger INTEGER NOT NULL DEFAULT 1,
        process_after TEXT
      )`);
      db.close();
      const mtime = (Date.now() - opts.dbAgeMs) / 1000;
      fs.utimesSync(dbPath, mtime, mtime);
      if (opts.withNodeModules) {
        const nm = path.join(dir, 'node_modules');
        fs.mkdirSync(nm);
        fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
      }
      if (opts.withPnpmStore) {
        const ps = path.join(dir, '.pnpm-store');
        fs.mkdirSync(ps);
        fs.writeFileSync(path.join(ps, 'index.db'), 'x');
      }
      if (opts.nodeModulesInWorktree) {
        const nested = path.join(dir, 'worktrees', 'repo', 'node_modules');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'pkg.json'), '{}');
      }
      return dir;
    }

    it('removes node_modules and .pnpm-store from idle sessions', () => {
      const dir = makeSession({
        group: 'ag-1',
        sess: 'sess-old',
        dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
        withNodeModules: true,
        withPnpmStore: true,
        nodeModulesInWorktree: true,
      });

      pruneIdleSessionArtifacts(Date.now(), tmpRoot, isContainerRunning);

      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.pnpm-store'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'worktrees', 'repo', 'node_modules'))).toBe(false);
      // Session dir and DB file untouched
      expect(fs.existsSync(path.join(dir, 'inbound.db'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'worktrees', 'repo'))).toBe(true);
    });

    it('leaves recently-active sessions alone', () => {
      const dir = makeSession({
        group: 'ag-1',
        sess: 'sess-fresh',
        dbAgeMs: HOUR, // 1 hour < 24 hour default
        withNodeModules: true,
      });

      pruneIdleSessionArtifacts(Date.now(), tmpRoot, isContainerRunning);

      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
    });

    it('skips sessions whose container is currently running', () => {
      const dir = makeSession({
        group: 'ag-1',
        sess: 'sess-running',
        dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
        withNodeModules: true,
      });

      pruneIdleSessionArtifacts(Date.now(), tmpRoot, (sid) => sid === 'sess-running');

      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
    });

    it('ignores non-sess dirs (e.g. .claude-shared, .claude-memory)', () => {
      const sharedDir = path.join(tmpRoot, 'ag-1', '.claude-shared');
      fs.mkdirSync(sharedDir, { recursive: true });
      const nmInShared = path.join(sharedDir, 'node_modules');
      fs.mkdirSync(nmInShared);
      fs.writeFileSync(path.join(nmInShared, 'pkg.json'), '{}');

      pruneIdleSessionArtifacts(Date.now(), tmpRoot, isContainerRunning);

      expect(fs.existsSync(nmInShared)).toBe(true);
    });

    it('does not follow symlinks out of the session subtree', () => {
      const dir = makeSession({
        group: 'ag-1',
        sess: 'sess-symlink',
        dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-store-'));
      const outsideNm = path.join(outside, 'node_modules');
      fs.mkdirSync(outsideNm);
      fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
      try {
        fs.symlinkSync(outside, path.join(dir, 'shared-link'));

        pruneIdleSessionArtifacts(Date.now(), tmpRoot, isContainerRunning);

        expect(fs.existsSync(outsideNm)).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('no-ops on a non-existent sessions root', () => {
      expect(() =>
        pruneIdleSessionArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'), isContainerRunning),
      ).not.toThrow();
    });
  });

  describe('pruneIdleThreadArtifacts (moved from host-sweep.test.ts, now calling storage-manager.js directly)', () => {
    let tmpRoot: string;
    const HOUR = 60 * 60 * 1000;
    let SESSION_ARTIFACT_IDLE_MS: number;
    let pruneIdleThreadArtifacts: typeof import('../../storage-manager.js').pruneIdleThreadArtifacts;

    beforeEach(async () => {
      const storageManager = await import('../../storage-manager.js');
      pruneIdleThreadArtifacts = storageManager.pruneIdleThreadArtifacts;
      SESSION_ARTIFACT_IDLE_MS = storageManager.SESSION_ARTIFACT_IDLE_MS;
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-storage-thread-prune-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function makeThread(opts: {
      key: string;
      activityAgeMs: number;
      withPnpmStore?: boolean;
      withNodeModules?: boolean;
    }): { worktreeDir: string; repoDir: string } {
      const worktreeDir = path.join(tmpRoot, opts.key, 'worktrees');
      const repoDir = path.join(worktreeDir, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });
      if (opts.withPnpmStore) {
        const store = path.join(worktreeDir, '.pnpm-store');
        fs.mkdirSync(store, { recursive: true });
        fs.writeFileSync(path.join(store, 'index.db'), 'x');
      }
      if (opts.withNodeModules) {
        const nm = path.join(repoDir, 'node_modules');
        fs.mkdirSync(nm, { recursive: true });
        fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
      }
      const mtime = (Date.now() - opts.activityAgeMs) / 1000;
      fs.utimesSync(worktreeDir, mtime, mtime);
      return { worktreeDir, repoDir };
    }

    it('removes package caches from idle thread worktrees but preserves repos', () => {
      const { worktreeDir, repoDir } = makeThread({
        key: 'thread-old',
        activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
        withPnpmStore: true,
        withNodeModules: true,
      });

      pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

      expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(false);
      expect(fs.existsSync(path.join(repoDir, 'node_modules'))).toBe(false);
      expect(fs.existsSync(repoDir)).toBe(true);
    });

    it('leaves recently active thread worktrees alone', () => {
      const { worktreeDir } = makeThread({
        key: 'thread-fresh',
        activityAgeMs: HOUR,
        withPnpmStore: true,
      });

      pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

      expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
    });

    it('uses session activity when supplied instead of stale filesystem mtime', () => {
      const { worktreeDir } = makeThread({
        key: 'thread-db-active',
        activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
        withPnpmStore: true,
      });

      pruneIdleThreadArtifacts(
        Date.now(),
        tmpRoot,
        new Map([
          [worktreeDir, { lastActivityMs: Date.now() - HOUR, hasRunningContainer: false, hasBusySession: false }],
        ]),
      );

      expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
    });

    it('skips thread worktrees with a running container', () => {
      const { worktreeDir } = makeThread({
        key: 'thread-running',
        activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
        withPnpmStore: true,
      });

      pruneIdleThreadArtifacts(
        Date.now(),
        tmpRoot,
        new Map([
          [
            worktreeDir,
            {
              lastActivityMs: Date.now() - SESSION_ARTIFACT_IDLE_MS - HOUR,
              hasRunningContainer: true,
              hasBusySession: false,
            },
          ],
        ]),
      );

      expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
    });

    it('does not follow symlinks out of the thread worktree subtree', () => {
      const { repoDir } = makeThread({
        key: 'thread-symlink',
        activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-thread-store-'));
      const outsideNm = path.join(outside, 'node_modules');
      fs.mkdirSync(outsideNm);
      fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
      try {
        fs.symlinkSync(outside, path.join(repoDir, 'shared-link'));

        pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

        expect(fs.existsSync(outsideNm)).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('no-ops on a non-existent thread root', () => {
      expect(() => pruneIdleThreadArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'), new Map())).not.toThrow();
    });
  });
});
