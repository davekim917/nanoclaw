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

// runReconcilerSweep is the earliest UNGUARDED call in the tick body, so
// throwing here reaches the wrapper the same way the production failure did.
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

import { SWEEP_INTERVAL_MS, startHostSweep, stopHostSweep } from './host-sweep.js';
import { log } from './log.js';

describe('host sweep reschedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunReconcilerSweep.mockReset();
    activeSessions.rows = [];
  });

  afterEach(() => {
    stopHostSweep();
    vi.useRealTimers();
  });

  // Seam-2 R-8: carried unchanged, now driven through the duty registry —
  // `runReconcilerSweep` is the `orchestrator-reconciler` duty's whole body and
  // is still deliberately unguarded, so its throw still reaches this wrapper.
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
