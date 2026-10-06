import { stopOrphanedSessions } from '../../container-runner.js';
import { log } from '../../log.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

function registerOrphanContainerSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK7,
    phase: 'tick:housekeeping',
    order: 140,
    run: async () => {
      try {
        await stopOrphanedSessions();
      } catch (err) {
        log.error('Orphaned container sweep failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-orphan-containers', registerOrphanContainerSweepDuties);
