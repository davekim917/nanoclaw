import { log } from '../../log.js';
import { SWEEP_DUTY_INVENTORY, registerSweepDuty, registerSweepDutySource } from '../../host-sweep.js';
import { sweepOrphanedRepoIngressFences } from '../../repo-fence-recovery.js';
import type { Session } from '../../types.js';

const id = SWEEP_DUTY_INVENTORY;

function registerSweepRepoFenceDuties(): void {
  registerSweepDuty({
    name: id.T22,
    phase: 'tick:post-session',
    order: 50,
    // Nothing else releases a fence whose publication is gone; a leaked fence
    // holds every inbound row and refuses every spawn for that session.
    run: async (ctx) => {
      try {
        await sweepOrphanedRepoIngressFences(ctx.sessions as Session[]);
      } catch (err) {
        log.warn('Orphaned repository fence sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T5,
    phase: 'tick:housekeeping',
    order: 10,
    // Finalize "Reject with reason…" holds whose reply window elapsed.
    run: async () => {
      try {
        const { sweepAwaitingReasonRejects } = await import('../approvals/index.js');
        await sweepAwaitingReasonRejects();
      } catch (err) {
        log.error('Reject-with-reason sweep failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-repo-fence', registerSweepRepoFenceDuties);
