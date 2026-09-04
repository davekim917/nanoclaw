/**
 * Sweep family: orchestrator, dormant (seam 2, S2-PR5).
 *
 * T6 orchestrator-reconciler (tick:post-session, order 10), T18 task-watchdog
 * (tick:post-session, order 25) and T14 completed-task-auto-archive
 * (tick:housekeeping, order 70) — moved out of src/host-sweep.ts unchanged
 * (plan.md §4.3/§4.7). T6 and T18 read container state, so they MUST stay in
 * tick:post-session, after the per-session fan-out (constraint 1).
 *
 * DORMANT: no agent group holds the `orchestrator` capability (parked
 * 2026-08-11 — see src/modules/orchestrator-dispatch/index.ts), so
 * `spawn_task` never fires. `getOrphanedTasks()` and `getActiveTasks()`
 * therefore return nothing in production, and both T6 and T18 are no-ops.
 * Do not re-enable anything here — restoring the capability is a decision
 * made elsewhere (grantCapability()), not a side effect of this module.
 *
 * T18's and T14's own bodies live in sibling files (task-watchdog.ts,
 * auto-archive.ts) rather than here, so the acceptance-case suite can import
 * them directly without pulling in this file's dependency on host-sweep.ts —
 * the same split S2-PR4 used for steer-idempotency.ts.
 *
 * Registers at import — this module has no other consumer. It is imported by
 * src/modules/index.ts (production boot) and, for hermetic coverage, by
 * src/host-sweep-registry.test.ts alongside the other family-duty mocks that
 * file already carries.
 *
 * Registration goes through `registerSweepDutySource`, not `registerSweepDuty`
 * directly, so `_resetSweepRegistryForTesting()` can replay it — see the
 * comment above `registerSweepDutySource` in src/host-sweep.ts.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { runReconcilerSweep } from '../orchestrator-dispatch/reconciler.js';
import { autoArchiveOldCompleted } from './auto-archive.js';
import { sweepTaskWatchdog } from './task-watchdog.js';

export function registerOrchestratorSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  // ── tick:post-session — container state is now current ─────────────────────

  registerSweepDuty({
    name: id.T6,
    phase: 'tick:post-session',
    order: 10,
    // MODULE-HOOK:orchestrator-dispatch:reconciler — complete
    // admitted-but-incomplete tasks. Runs after per-session sweeps so container
    // state is current. Carries no guard of its own: it was the earliest
    // unguarded call in the old tick body, and the phase runner is now the
    // guard that keeps its throw from costing every duty behind it.
    run: () => {
      runReconcilerSweep();
    },
  });

  registerSweepDuty({
    name: id.T18,
    phase: 'tick:post-session',
    order: 25,
    // MODULE-HOOK:orchestrator-dispatch:watchdog — reap tasks that have exceeded
    // their deadline, spawn window, no-progress timeout, or whose child
    // container exited.
    run: () => sweepTaskWatchdog(),
  });

  // ── tick:housekeeping — order-free central work ─────────────────────────────

  registerSweepDuty({
    name: id.T14,
    phase: 'tick:housekeeping',
    order: 70,
    // Auto-archive completed tasks older than 24h so the "Done" lane stays
    // representative of recent work; failed tasks are intentionally skipped.
    run: () => {
      autoArchiveOldCompleted();
    },
  });
}

registerSweepDutySource('sweep-orchestrator', registerOrchestratorSweepDuties);
