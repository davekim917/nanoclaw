import { ensureEgressNetwork } from '../../egress-lockdown.js';
import { log } from '../../log.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

function registerEgressSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T2,
    phase: 'tick:pre-session',
    order: 10,
    run: () => {
      // Re-heal the egress network so running agents keep their gateway hop
      // if it was detached out-of-band. A heal failure is not a leak (agents
      // stay on the internal net), so log and continue.
      try {
        ensureEgressNetwork();
      } catch (err) {
        log.error('Egress lockdown re-heal failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-egress', registerEgressSweepDuties);
