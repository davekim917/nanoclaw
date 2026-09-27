import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { reconcileMergedClaims } from '../claims/reconcile.js';
import { sweepClaimsSelfHeal } from '../claims/self-heal.js';

function registerClaimsSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.T20,
    phase: 'tick:housekeeping',
    order: 100,
    // Order is load-bearing: a claim whose pull request has merged must be
    // CLOSED by reconcile before the self-heal ladder can escalate it.
    // Each step is isolated so a GitHub outage cannot take the other down.
    run: async () => {
      try {
        await reconcileMergedClaims();
      } catch (err) {
        log.warn('Claims reconcile sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T21,
    phase: 'tick:housekeeping',
    order: 110,
    // Strictly after T20.
    run: async () => {
      try {
        await sweepClaimsSelfHeal();
      } catch (err) {
        log.warn('Claims self-heal sweep step failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-claims', registerClaimsSweepDuties);
