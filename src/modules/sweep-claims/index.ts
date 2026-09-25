/**
 * Sweep family: claims. Registers
 * T20 (claims-reconcile, order 100) and T21 (claims-self-heal, order 110) on
 * `tick:housekeeping` — both housekeeping duties, but the order between them
 * is load-bearing (plan.md §4.3 constraint 3): a claim whose pull request has
 * merged must be CLOSED by the reconcile pass before the self-heal ladder
 * gets a chance to escalate it.
 *
 * Moved from src/host-sweep.ts UNCHANGED (cut/paste, same statements, same
 * log strings, same internal throttles). The claims logic itself
 * (`reconcileMergedClaims`, `sweepClaimsSelfHeal`) already lives in, and
 * stays in, `../claims/reconcile.js` / `../claims/self-heal.js` — those files
 * predate the sweep registry and are NOT owned by this family PR (mailbox PR
 * 7 converts self-heal.ts's internals with its exported signature UNCHANGED,
 * per plan.md §5). Only the thin registerSweepDuty wrapper each duty sat
 * behind inside host-sweep.ts moves here; their own test suites
 * (`../claims/reconcile.test.ts`, `../claims/self-heal.test.ts`,
 * `../claims/escalation.test.ts` — 93 cases total, close to the plan's "92
 * ported claims cases") already live beside them and are untouched by this
 * move.
 *
 * Registers at import via `registerSweepDutySource`, not `registerSweepDuty`
 * directly, so `_resetSweepRegistryForTesting()` can replay it — see the
 * comment above `registerSweepDutySource` in src/host-sweep.ts.
 */
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
    // Claim reconciliation, then self-heal. Order is load-bearing: a claim whose
    // pull request has merged must be CLOSED, not escalated at somebody — the
    // reconcile pass deletes those files first, so the ladder below never sees
    // them. Both are throttled internally to once per 10 minutes and each is
    // isolated, so a GitHub outage cannot take the nudge ladder down with it.
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
    // Strictly after T20 — see the comment there.
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
