/**
 * Sweep family: egress. Registers T2
 * (egress-network-reheal) on `tick:pre-session` at order 10 — the earliest
 * tick duty, before the per-session fan-out (constraint 4 in plan.md §4.3
 * lists T6/T10 as relying on the outer wrapper; T2 itself has no ordering
 * constraint beyond "before the fan-out", which the phase itself encodes).
 *
 * Moved from src/host-sweep.ts UNCHANGED (cut/paste, same statements, same
 * log string, same try/catch): behavior-preserving move only.
 *
 * Registers at import via `registerSweepDutySource`, not `registerSweepDuty`
 * directly, so `_resetSweepRegistryForTesting()` can replay it — see the
 * comment above `registerSweepDutySource` in src/host-sweep.ts.
 */
import { ensureEgressNetwork } from '../../egress-lockdown.js';
import { log } from '../../log.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

function registerEgressSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T2,
    phase: 'tick:pre-session',
    order: 10,
    run: () => {
      // Re-heal the egress network so already-running agents keep their gateway
      // hop if it was detached out-of-band. Best-effort here: a heal failure
      // isn't a leak (agents stay on the internal net), so log and continue.
      // No-op when lockdown is disabled.
      try {
        ensureEgressNetwork();
      } catch (err) {
        log.error('Egress lockdown re-heal failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-egress', registerEgressSweepDuties);
