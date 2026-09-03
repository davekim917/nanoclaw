/**
 * Boot-order and inertness cases for the upstream host-lifecycle seam (S2-PR0).
 * docs/specs/upstream-host-sweep-seam/plan.md §4.1, §8 "S2-PR0" (L-3, L-4).
 *
 * main() and shutdown() carry too much production side effect (real DB init,
 * channel adapters, container runtime) to drive end-to-end in a unit test — the
 * same reasoning src/main.memory-startup-order.test.ts's 4th case already
 * applies to a different ordering constraint in this file. L-3 is therefore
 * two parts: source-position assertions on the exact call strings in main()
 * and shutdown() (this file's established precedent), plus a runtime
 * assertion against src/host-lifecycle.ts itself proving the ctx a registered
 * callback receives is exactly the {db, signal} pair main.ts's call site
 * constructs — db by reference, and signal from the exported
 * hostAbortController.
 */
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('L-3: startHostModules fires after the delivery adapter and before the delivery polls; stopHostModules is the first shutdown action', () => {
  it('main() calls startHostModules after setDeliveryAdapter and before the recovery release / delivery polls', () => {
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    const deliveryReady = source.indexOf('setDeliveryAdapter(createChannelDeliveryAdapter())');
    const modulesStart = source.indexOf('await startHostModules(');
    const recoveryReleased = source.indexOf('releaseChannelRecoveryReady()');
    const pollingStart = source.indexOf('startActiveDeliveryPoll()');

    expect(deliveryReady).toBeGreaterThan(-1);
    expect(modulesStart).toBeGreaterThan(deliveryReady);
    expect(recoveryReleased).toBeGreaterThan(modulesStart);
    expect(pollingStart).toBeGreaterThan(modulesStart);
  });

  it('shutdown() aborts and stops host modules before the shutdown-callback loop and before stopDeliveryPolls', () => {
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    const shutdownSignalReceived = source.indexOf("log.info('Shutdown signal received'");
    const abort = source.indexOf('hostAbortController.abort()');
    const modulesStop = source.indexOf('await stopHostModules()');
    const callbackLoop = source.indexOf('for (const cb of getShutdownCallbacks())');
    const pollsStop = source.indexOf('stopDeliveryPolls()');

    expect(shutdownSignalReceived).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(shutdownSignalReceived);
    expect(modulesStop).toBeGreaterThan(abort);
    expect(callbackLoop).toBeGreaterThan(modulesStop);
    expect(pollsStop).toBeGreaterThan(modulesStop);
  });

  it('startHostModules awaits every registered callback with the exact {db, signal} ctx object main.ts constructs', async () => {
    const lifecycle = await import('./host-lifecycle.js');
    const db = { marker: 'fork-sync-handle' } as never;
    const controller = new AbortController();
    const ctx = { db, signal: controller.signal };
    const received: unknown[] = [];

    lifecycle.onHostStart(async (actual) => {
      received.push(actual);
    });

    await lifecycle.startHostModules(ctx);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(ctx);
    expect((received[0] as typeof ctx).db).toBe(db);
    expect((received[0] as typeof ctx).signal).toBe(controller.signal);
  });
});

/**
 * L-4 ("the lifecycle port registers no callbacks") is superseded here: PR 1
 * gives the six main.ts timers + sweep-storage real registrants, so an empty
 * registry is no longer the invariant post-PR-1. T-5 replaces it with the new
 * invariant — the exact SET of registrant NAMES, independent of env gates.
 *
 * Names, not a count. A count says "8" and names nothing, so it breaks on every
 * legitimate new registrant with a diff that cannot tell a missing duty from an
 * added one — which is exactly how this case went red when #324's archive
 * projection worker became the 8th shutdown registrant. Every callback is
 * therefore registered as a NAMED function expression at its registration site,
 * and this case asserts the sorted name lists.
 *
 * The names are deliberately NOT the module's own `startX`/`stopX` symbols: a
 * function expression's name binds inside its own body, so
 * `onHostStart(function startWorktreeCleanup() { startWorktreeCleanup(); })`
 * would call itself forever instead of the module function. Each registrant is
 * named `<duty>HostStart` / `<duty>HostShutdown`.
 *
 * `src/host-lifecycle.ts` is byte-locked to upstream (sha256 manifest), so
 * `onHostStart`/`onHostShutdown` cannot grow a name parameter — naming the
 * callback itself is the only way to get an identity across that seam.
 */
const EXPECTED_HOST_START_REGISTRANTS = [
  'backlogCanvasHostStart',
  'commitScanHostStart',
  'dailySummaryHostStart',
  'pluginUpdaterHostStart',
  'repoFreshnessHostStart',
  'worktreeCleanupHostStart',
].sort();

const EXPECTED_HOST_SHUTDOWN_REGISTRANTS = [
  // The six main.ts timer modules.
  'backlogCanvasHostShutdown',
  'commitScanHostShutdown',
  'dailySummaryHostShutdown',
  'pluginUpdaterHostShutdown',
  'repoFreshnessHostShutdown',
  'worktreeCleanupHostShutdown',
  // Reached through the modules barrel: sweep-storage stops the persistent
  // maintenance worker (its start half, T13, was never in main.ts).
  'storageMaintenanceHostShutdown',
  // Also reached through the barrel — src/db/archive-projection-worker.ts is
  // imported by src/container-runner.ts, which ten barrel modules import (#324).
  'archiveProjectionHostShutdown',
  // S2-PR14 moved the approvals module's OneCLI-handler stop off
  // response-registry.ts's own onShutdown onto the host lifecycle, which is
  // upstream's shape and what upstream's own case asserts.
  'approvalsHostShutdown',
].sort();

/**
 * Cold-importing the whole modules barrel plus the six timer modules costs
 * ~4.5 s on a loaded 8-core box, inside vitest's 5 s default by only a hair —
 * this case flaked under CPU contention before the explicit budget.
 */
const IMPORT_EVERY_REGISTRANT_TIMEOUT_MS = 30_000;

async function importEveryLifecycleRegistrant(): Promise<typeof import('./host-lifecycle.js')> {
  const lifecycle = await import('./host-lifecycle.js');
  // Production barrel — side-effect imports populate module registries
  // (sweep-storage's onHostShutdown), same pattern as src/guard/conformance.test.ts.
  await import('./modules/index.js');
  // The six timer modules are NOT part of the modules barrel — main.ts
  // imports them directly for their onHostStart/onHostShutdown side effects.
  await import('./worktree-cleanup.js');
  await import('./repo-freshness.js');
  await import('./plugin-updater.js');
  await import('./commit-scan.js');
  await import('./daily-summary.js');
  await import('./backlog-canvas.js');
  return lifecycle;
}

describe("T-5: after PR 1 the registries hold exactly the six timer starts and the host's shutdown registrants, regardless of env gates", () => {
  it(
    'importing the modules barrel plus the six timer modules registers exactly the named start and shutdown registrants',
    async () => {
      const lifecycle = await importEveryLifecycleRegistrant();

      expect(
        lifecycle
          .getHostStartCallbacks()
          .map((cb) => cb.name)
          .sort(),
      ).toEqual(EXPECTED_HOST_START_REGISTRANTS);
      expect(
        lifecycle
          .getHostShutdownCallbacks()
          .map((cb) => cb.name)
          .sort(),
      ).toEqual(EXPECTED_HOST_SHUTDOWN_REGISTRANTS);
    },
    IMPORT_EVERY_REGISTRANT_TIMEOUT_MS,
  );

  it(
    'holds the same named registrants with DAILY_SUMMARY_ENABLED=0 and BACKLOG_CANVAS_ENABLED=0 — a disabled duty still registers and no-ops',
    async () => {
      vi.stubEnv('DAILY_SUMMARY_ENABLED', '0');
      vi.stubEnv('BACKLOG_CANVAS_ENABLED', '0');
      try {
        const lifecycle = await importEveryLifecycleRegistrant();

        expect(
          lifecycle
            .getHostStartCallbacks()
            .map((cb) => cb.name)
            .sort(),
        ).toEqual(EXPECTED_HOST_START_REGISTRANTS);
        expect(
          lifecycle
            .getHostShutdownCallbacks()
            .map((cb) => cb.name)
            .sort(),
        ).toEqual(EXPECTED_HOST_SHUTDOWN_REGISTRANTS);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    IMPORT_EVERY_REGISTRANT_TIMEOUT_MS,
  );
});
