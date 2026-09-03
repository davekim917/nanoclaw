import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The twelve start/stop symbols the six main.ts timers used to hold directly,
// plus stopStorageMaintenanceWorker (its start half, T13, was never in
// main.ts — only the stop was). main.ts must reference none of them; the six
// side-effect imports (`import './worktree-cleanup.js';` etc.) are allowed
// and must NOT match, since they name the file, not the symbol.
const RETIRED_MAIN_TS_SYMBOLS = [
  'startWorktreeCleanup',
  'stopWorktreeCleanup',
  'startRepoFreshness',
  'stopRepoFreshness',
  'startPluginUpdater',
  'stopPluginUpdater',
  'startCommitScan',
  'stopCommitScan',
  'startDailySummary',
  'stopDailySummary',
  'startBacklogCanvas',
  'stopBacklogCanvas',
  'stopStorageMaintenanceWorker',
];

const SIX_TIMER_MODULE_SPECIFIERS = [
  './worktree-cleanup.js',
  './repo-freshness.js',
  './plugin-updater.js',
  './commit-scan.js',
  './daily-summary.js',
  './backlog-canvas.js',
];

describe('main.ts starts no duty timer directly', () => {
  it('references none of the twelve start/stop symbols or stopStorageMaintenanceWorker', () => {
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    for (const symbol of RETIRED_MAIN_TS_SYMBOLS) {
      expect(source).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  it('still imports the six timer modules for their onHostStart/onHostShutdown registration side effects', () => {
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    for (const specifier of SIX_TIMER_MODULE_SPECIFIERS) {
      expect(source).toContain(`'${specifier}'`);
    }
  });
});

/**
 * Heavy-dep mocks for the six timer modules, reusing the pattern each
 * module's own test suite already establishes (worktree-cleanup.test.ts,
 * repo-freshness.test.ts, daily-summary.test.ts) rather than inventing a new
 * one. Every case here uses `vi.resetModules()` + `vi.doMock` + a fresh
 * dynamic import so each test sees its own host-lifecycle registry instead
 * of accumulating registrations across cases (registration happens once, at
 * import time).
 */
/**
 * A tripwire, not a functional mock. It records the call (so the test can
 * assert on that record even though the thrown error itself may be
 * swallowed — every caller here already wraps its real work in try/catch or
 * .catch, precisely so a git/network failure never crashes the host, which
 * means an uncaught-throw-only tripwire could fire and still leave a test
 * green) and then throws, so a caller that does NOT catch it fails loudly
 * too. Pass a fresh `record` array per test and assert `record` is empty at
 * the end — that assertion is what actually fails the test if a seam mock is
 * ever weakened or a new duty adds an unguarded child_process call, instead
 * of a real process (git, docker, …) spawning silently from a unit test run.
 */
function childProcessTripwireFactory(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`host-sweep-registry.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    spawnSync: spawnAttempted('spawnSync'),
  };
}

function mockWorktreeCleanupDeps(
  logMock: Record<string, ReturnType<typeof vi.fn>>,
  dataDir = '/tmp/host-sweep-registry-test',
): void {
  vi.doMock('./config.js', () => ({
    DATA_DIR: dataDir,
    GROUPS_DIR: `${dataDir}/groups`,
  }));
  vi.doMock('./container-runner.js', () => ({ isContainerRunning: () => false, isContainerSpawning: () => false }));
  vi.doMock('./db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
  vi.doMock('./session-manager.js', () => ({
    inboundDbPath: () => '',
    openOutboundDb: () => {
      throw new Error('not available in this test');
    },
  }));
  vi.doMock('./db/session-db.js', () => ({
    getProcessingClaims: () => [],
    getContainerState: () => ({ current_tool: null }),
  }));
  // setLogScrubber is a no-op here: secret-scrubber.ts calls it at import
  // time, and secret-scrubber.ts is pulled in transitively (repo-freshness.js
  // -> modules/repository-workspaces/index.js -> delivery.js -> secret-
  // scrubber.js), so the mock must carry it even though nothing here asserts
  // on scrubbing.
  vi.doMock('./log.js', () => ({ log: logMock, setLogScrubber: () => undefined }));
}

describe('a timer that fails to start still aborts boot, and a failing interval tick does not', () => {
  afterEach(() => {
    vi.doUnmock('./config.js');
    vi.doUnmock('./container-runner.js');
    vi.doUnmock('./db/connection.js');
    vi.doUnmock('./session-manager.js');
    vi.doUnmock('./db/session-db.js');
    vi.doUnmock('./log.js');
    vi.doUnmock('./db/agent-groups.js');
    vi.doUnmock('child_process');
    vi.doUnmock('node:child_process');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('T-2a: a synchronous failure in the registered start callback rejects startHostModules (fail-fast preserved)', async () => {
    vi.resetModules();
    const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    mockWorktreeCleanupDeps(logMock);

    const { startHostModules } = await import('./host-lifecycle.js');
    // Importing worktree-cleanup.js registers its real, bare/unguarded
    // onHostStart(() => { startWorktreeCleanup(); ... }) callback — exactly
    // the production wiring under test, not a stand-in.
    await import('./worktree-cleanup.js');

    // startWorktreeCleanup's only fallible operation is the setTimeout call
    // itself; forcing that to throw exercises the real function through its
    // real code path without needing to intercept a same-module export.
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('worktree cleanup boom');
    });

    await expect(startHostModules({ db: {} as never, signal: new AbortController().signal })).rejects.toThrow(
      'worktree cleanup boom',
    );

    timeoutSpy.mockRestore();
  });

  it('T-2b: a failing recurring tick is caught and logged, never becomes an unhandled rejection, and the next tick still fires', async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    let callCount = 0;
    // commit-scan's runScan() calls getAllAgentGroups() unguarded at its top
    // — a real external dependency, not a same-module binding — so mocking
    // it to throw exercises the module's actual (already-`.catch`ed) wiring
    // rather than a synthetic stand-in.
    vi.doMock('./db/agent-groups.js', () => ({
      getAllAgentGroups: () => {
        callCount += 1;
        if (callCount === 1) throw new Error('tick boom');
        return [];
      },
    }));
    const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.doMock('./log.js', () => ({ log: logMock }));
    // Tripwire (see childProcessTripwireFactory): getAllAgentGroups()
    // returning [] already means commit-scan's own group loop — the only
    // path that reaches execFileSync('git', …) — never runs; this is
    // regression insurance, not the primary guard. spawnAttempts must stay
    // empty (asserted below) even though the module already `.catch`es its
    // own git failures, which would otherwise swallow a bare thrown tripwire
    // without ever failing the test.
    const spawnAttempts: string[] = [];
    vi.doMock('child_process', () => childProcessTripwireFactory(spawnAttempts));
    vi.doMock('node:child_process', () => childProcessTripwireFactory(spawnAttempts));

    try {
      const commitScan = await import('./commit-scan.js');
      commitScan.startCommitScan();

      // STARTUP_DELAY_MS (90s): fires the first tick, which throws inside runScan().
      await vi.advanceTimersByTimeAsync(90_000);
      expect(callCount).toBe(1);
      expect(logMock.error).toHaveBeenCalledWith(
        'Commit scan failed',
        expect.objectContaining({ err: expect.any(Error) }),
      );

      // SCAN_INTERVAL_MS (10min): the next tick still fires despite the prior throw.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(callCount).toBe(2);

      commitScan.stopCommitScan();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(spawnAttempts).toEqual([]);

    expect(unhandled).toEqual([]);
  });
});

describe("module intervals are unref'd and cleared on shutdown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.doUnmock('./config.js');
    vi.doUnmock('./container-runner.js');
    vi.doUnmock('./db/connection.js');
    vi.doUnmock('./session-manager.js');
    vi.doUnmock('./db/session-db.js');
    vi.doUnmock('./db/agent-groups.js');
    vi.doUnmock('./db/backlog.js');
    vi.doUnmock('./db/messaging-groups.js');
    vi.doUnmock('./delivery.js');
    vi.doUnmock('./container-config.js');
    vi.doUnmock('./github-token.js');
    vi.doUnmock('./log.js');
    vi.doUnmock('fs');
    vi.doUnmock('child_process');
    vi.doUnmock('node:child_process');
  });

  it("T-4: every timer handle the six modules create is unref'd, and none remain pending after stopHostModules", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const createdHandles: Array<{ unrefCalled: boolean }> = [];
    const wrapTimerFn = <T extends (...args: never[]) => NodeJS.Timeout>(fn: T): T =>
      ((...args: Parameters<T>) => {
        const handle = fn(...args);
        const record = { unrefCalled: false };
        createdHandles.push(record);
        const originalUnref = handle.unref.bind(handle);
        handle.unref = ((...unrefArgs: Parameters<typeof handle.unref>) => {
          record.unrefCalled = true;
          return originalUnref(...unrefArgs);
        }) as typeof handle.unref;
        return handle;
      }) as T;
    vi.stubGlobal('setTimeout', wrapTimerFn(globalThis.setTimeout));
    vi.stubGlobal('setInterval', wrapTimerFn(globalThis.setInterval));

    // A real, empty, test-owned tmp dir: DATA_DIR for worktree-cleanup and
    // repo-freshness (both resolve their real targets from it, and an empty
    // dir means zero targets, so neither ever reaches its own git calls); a
    // fake-home this test never populates for plugin-updater, below.
    const tmpRoot = fs.mkdtempSync('/tmp/host-sweep-registry-t4-');
    // Vitest does not intercept `os`/`node:os` in this project's config
    // (verified: vi.doMock('os', …) has zero effect on a dynamically
    // imported consumer's os.homedir()) — so plugin-updater's own
    // `path.join(os.homedir(), 'plugins')` is computed here, for real,
    // against the REAL home directory, to know exactly what path the
    // fs.existsSync seam below needs to intercept.
    const realPluginsRoot = path.join(os.homedir(), 'plugins');

    try {
      const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      mockWorktreeCleanupDeps(logMock, tmpRoot);
      vi.doMock('./db/agent-groups.js', () => ({ getAllAgentGroups: () => [] }));
      vi.doMock('./db/backlog.js', () => ({
        getBacklog: () => [],
        getBacklogResolvedSince: () => [],
        getShipLogSince: () => [],
        addShipLogEntry: () => undefined,
        getCommitDigestState: () => null,
        upsertCommitDigestState: () => undefined,
      }));
      vi.doMock('./db/messaging-groups.js', () => ({ getMessagingGroup: () => null }));
      // NOT mocked: ./delivery.js. repo-freshness.js pulls in
      // ./modules/repository-workspaces/index.js, which calls
      // registerDeliveryAction(...) from ./delivery.js at IMPORT time — a
      // stub lacking that export breaks module evaluation itself, not just a
      // later call. repo-freshness.test.ts already proves the real module is
      // safe to import unmocked; its own getDeliveryAdapter() returns null
      // with no adapter registered, which every tick body here already
      // handles as a no-op.
      vi.doMock('./container-config.js', () => ({ readContainerConfig: () => ({}) }));
      vi.doMock('./github-token.js', () => ({ resolveGitHubToken: () => null }));
      // plugin-updater's own seam: runPluginUpdates()' very first line is
      // `path.join(os.homedir(), 'plugins')`, then a real fs.existsSync
      // check that returns early (before ever calling git) the moment it is
      // false. Since os.homedir() can't be intercepted (see realPluginsRoot
      // above), the seam has to sit one call later: fs.existsSync itself,
      // wrapped so ONLY that one exact real path is faked to "missing" —
      // every other fs call (worktree-cleanup's and repo-freshness's real
      // scans of tmpRoot included) passes straight through to the real fs.
      vi.doMock('fs', async (importOriginal) => {
        const actual = (await importOriginal<typeof import('fs')>()) as unknown as Record<string, unknown> & {
          existsSync: typeof fs.existsSync;
          default?: Record<string, unknown>;
        };
        const guardedExistsSync = ((p: fs.PathLike, ...rest: unknown[]) =>
          String(p) === realPluginsRoot
            ? false
            : (actual.existsSync as (...a: unknown[]) => boolean)(p, ...rest)) as typeof fs.existsSync;
        return {
          ...actual,
          default: { ...actual.default, existsSync: guardedExistsSync },
          existsSync: guardedExistsSync,
        };
      });
      // Tripwire (see childProcessTripwireFactory) — regression insurance on
      // top of the seam mocks above, not the primary guard. spawnAttempts
      // must stay empty (asserted below) even though every one of these
      // modules already catches its own git/network failures, which would
      // otherwise swallow a bare thrown tripwire without ever failing the
      // test.
      const spawnAttempts: string[] = [];
      vi.doMock('child_process', () => childProcessTripwireFactory(spawnAttempts));
      vi.doMock('node:child_process', () => childProcessTripwireFactory(spawnAttempts));

      const { startHostModules, stopHostModules } = await import('./host-lifecycle.js');
      await import('./worktree-cleanup.js');
      await import('./repo-freshness.js');
      await import('./plugin-updater.js');
      await import('./commit-scan.js');
      await import('./daily-summary.js');
      await import('./backlog-canvas.js');

      await startHostModules({ db: {} as never, signal: new AbortController().signal });

      // Advance far enough to trigger the first self-reschedule of the
      // self-rescheduling chains (commit-scan/daily-summary/backlog-canvas),
      // so their RESCHEDULED handle — not just the initial one — is checked
      // too. This also crosses plugin-updater's 5-minute startup delay,
      // which is exactly why the os.js seam mock above matters: without it
      // this advance would fire a REAL `git pull --ff-only` against every
      // repo under ~/plugins.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      expect(createdHandles.length).toBeGreaterThan(0);
      expect(createdHandles.every((h) => h.unrefCalled)).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await stopHostModules();

      expect(vi.getTimerCount()).toBe(0);
      expect(spawnAttempts).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
