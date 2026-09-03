import fs from 'fs';
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
function mockWorktreeCleanupDeps(logMock: Record<string, ReturnType<typeof vi.fn>>): void {
  vi.doMock('./config.js', () => ({
    DATA_DIR: '/tmp/host-sweep-registry-test',
    GROUPS_DIR: '/tmp/host-sweep-registry-test/groups',
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

    const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    mockWorktreeCleanupDeps(logMock);
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
    // so their RESCHEDULED handle — not just the initial one — is checked too.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    expect(createdHandles.length).toBeGreaterThan(0);
    expect(createdHandles.every((h) => h.unrefCalled)).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await stopHostModules();

    expect(vi.getTimerCount()).toBe(0);
  });
});
