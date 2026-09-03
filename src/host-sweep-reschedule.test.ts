/**
 * The sweep's reschedule is load-bearing: a throw anywhere in the tick body
 * must still re-arm the 60s timer. Before the try/catch wrapper, an unguarded
 * throw rejected sweep()'s promise, the reschedule never ran, `running` stayed
 * true so startHostSweep() was a permanent no-op, and log.ts swallowed the
 * unhandledRejection — so the process kept running with a dead sweep and every
 * health signal read green. Live: 2026-08-06 ~22:20 ET.
 *
 * Own file, not host-sweep.test.ts: this one needs fake timers and starts the
 * real timer chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunReconcilerSweep = vi.fn();

// runReconcilerSweep was the earliest UNGUARDED call in the tick body, which is
// why the production failure reached the wrapper through it. Seam 2 made the
// registry the guard for every tick duty, so its throw is now isolated one
// level lower — this case still pins the property that matters: whatever a duty
// does, the next tick happens.
vi.mock('./modules/orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => mockRunReconcilerSweep(),
  runReconcilerOnStartup: vi.fn(),
}));

const activeSessions = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('./db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/sessions.js')>();
  return { ...real, getActiveSessions: () => activeSessions.rows };
});

vi.mock('./db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/agent-groups.js')>();
  return { ...real, getAgentGroup: () => undefined };
});

// Seam mocks for the duties whose real bodies leave the process. Both cases
// here run a WHOLE tick, and until seam 2 isolated a tick duty's throw the
// first one stopped at the reconciler and never reached these — so the storage
// worker thread was really walking the disk and reporting real usage, and the
// claims duties were really reaching GitHub. Every duty that keeps its own
// cadence, its own guard, or its own DB access is left alone: the reschedule
// property is about the tick completing and re-arming, not about doing less.
const spawnAttempts = vi.hoisted(() => [] as string[]);

/**
 * A tripwire, not a functional mock. It records the call (every caller here
 * already wraps its real work in try/catch, so an uncaught-throw-only tripwire
 * could fire and still leave a test green) and then throws.
 */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const attempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`host-sweep-reschedule.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: attempted('exec'),
    execFile: attempted('execFile'),
    execSync: attempted('execSync'),
    execFileSync: attempted('execFileSync'),
    spawn: attempted('spawn'),
    spawnSync: attempted('spawnSync'),
    fork: attempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawnAttempts));
vi.mock('node:child_process', () => childProcessTripwire(spawnAttempts));

vi.mock('./egress-lockdown.js', () => ({ ensureEgressNetwork: () => undefined }));
vi.mock('./storage-maintenance-worker.js', () => ({
  runStorageMaintenanceInBackground: async () => null,
  stopStorageMaintenanceWorker: () => undefined,
}));
vi.mock('./storage-pressure-alert.js', () => ({ handleStoragePressureAlert: () => undefined }));
vi.mock('./modules/claims/reconcile.js', () => ({ reconcileMergedClaims: async () => undefined }));
vi.mock('./modules/claims/self-heal.js', () => ({ sweepClaimsSelfHeal: async () => undefined }));
vi.mock('./repo-fence-recovery.js', () => ({ sweepOrphanedRepoIngressFences: async () => null }));
vi.mock('./github-app-token.js', () => ({ refreshExpiringGitHubAppTokens: async () => undefined }));
vi.mock('./modules/approvals/index.js', () => ({ sweepAwaitingReasonRejects: async () => undefined }));
vi.mock('./dashboard/session-title-sweep.js', () => ({ runSessionTitleSweep: async () => undefined }));
vi.mock('./topic-title.js', () => ({ retryPendingThreadTitles: async () => undefined }));
vi.mock('./dashboard/db/dashboard-tokens.js', () => ({ pruneDashboardTokens: () => undefined }));

import { SWEEP_INTERVAL_MS, startHostSweep, stopHostSweep } from './host-sweep.js';
import { log } from './log.js';

describe('host sweep reschedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunReconcilerSweep.mockReset();
    activeSessions.rows = [];
    // Truncate, never reassign: the tripwire factory closed over THIS array.
    spawnAttempts.length = 0;
  });

  afterEach(() => {
    stopHostSweep();
    vi.useRealTimers();
    // Both cases advance fake timers and run whole tick bodies, so this is the
    // assertion that actually fails if a seam mock above is ever weakened.
    expect(spawnAttempts).toEqual([]);
  });

  // Seam-2 R-8: carried unchanged, now driven through the duty registry.
  // `runReconcilerSweep` is the `orchestrator-reconciler` duty's whole body.
  it('re-arms the timer even when the tick body throws', async () => {
    mockRunReconcilerSweep.mockImplementation(() => {
      throw new Error('boom');
    });

    // waitFor, not a bare advance: the tick awaits real dynamic imports before
    // it reaches the reconciler, and those do not resolve on the timer queue.
    startHostSweep();
    await vi.waitFor(() => expect(mockRunReconcilerSweep).toHaveBeenCalledTimes(1));

    // The whole point: a second tick happens after a throwing first one.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(mockRunReconcilerSweep).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(mockRunReconcilerSweep).toHaveBeenCalledTimes(3));
  });

  // A session the host cannot open used to return the same silent quiet-until
  // as a genuinely idle one, so 24 session dirs with no inbound.db were skipped
  // forever with zero log output.
  it('reports unreadable sessions instead of silently treating them as quiet', async () => {
    activeSessions.rows = [{ id: 'sess-unreadable', agent_group_id: 'gone', last_active: null }];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    startHostSweep();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Host sweep: sessions skipped as UNREADABLE (not quiet)',
        expect.objectContaining({
          count: 1,
          samples: [{ sessionId: 'sess-unreadable', reason: 'agent group missing' }],
        }),
      ),
    );
    warn.mockRestore();
  });
});
