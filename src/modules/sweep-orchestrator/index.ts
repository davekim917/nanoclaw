/**
 * T6 is DORMANT: no agent group holds the `orchestrator` capability, so it is a
 * no-op in production, and restoring the capability also needs a task reaper
 * this module no longer has. T14 archives completed tasks regardless.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { runReconcilerSweep } from '../orchestrator-dispatch/reconciler.js';
import { autoArchiveOldCompleted } from './auto-archive.js';

function registerOrchestratorSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.T6,
    phase: 'tick:post-session',
    order: 10,
    // No guard of its own: the phase runner keeps its throw from costing the
    // duties behind it.
    run: async () => {
      await runReconcilerSweep();
    },
  });

  registerSweepDuty({
    name: id.T14,
    phase: 'tick:housekeeping',
    order: 70,
    run: async () => {
      await autoArchiveOldCompleted();
    },
  });
}

registerSweepDutySource('sweep-orchestrator', registerOrchestratorSweepDuties);
