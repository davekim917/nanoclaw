/**
 * Repo-fence + approvals-scan sweep family (seam 2, PR 8 — G08).
 *
 * Registers two `tick`-phase duties at import:
 *   - T5  `approvals-reason-sweep`      (tick:housekeeping, order 10)
 *   - T22 `orphaned-repo-fence-release` (tick:post-session, order 50)
 *
 * Both were already thin wrappers around a body that lives outside
 * `host-sweep.ts` in its own module (`../../repo-fence-recovery.js`,
 * `../approvals/index.js`), so only the registration wrapper moves here —
 * plan.md §4.7 step 2's "the wrapper moves too" case. Neither underlying
 * module moves: `repo-fence-recovery.ts` is also imported directly by
 * `src/main.ts` (startup pass) and `src/delivery.ts` /
 * `src/modules/repository-workspaces/job-runner.ts` (dropped-message
 * recovery), both outside this family PR's ownership boundary.
 *
 * `registerSweepRepoFenceDuties` is exported (not just run as an import-time
 * side effect) so `src/host-sweep-registry.test.ts`'s `_resetSweepRegistryForTesting()`
 * — which clears the registry and rebuilds only the duties still inline in
 * `registerBuiltInSweepDuties()` — can restore this family's two after every
 * reset. Without that, R-7's 39/38 inventory assertion (and any other test
 * that drives a full tick after the file's first reset) silently loses T5 and
 * T22 the moment this module's own one-time import registration is wiped.
 */
import { log } from '../../log.js';
import { SWEEP_DUTY_INVENTORY, registerSweepDuty } from '../../host-sweep.js';
import { sweepOrphanedRepoIngressFences } from '../../repo-fence-recovery.js';
import type { Session } from '../../types.js';

const id = SWEEP_DUTY_INVENTORY;

export function registerSweepRepoFenceDuties(): void {
  registerSweepDuty({
    name: id.T22,
    phase: 'tick:post-session',
    order: 50,
    // Incident 2026-09-01: a failed repository publication left 1401 session
    // inbound DBs fenced (`repo_ingress_fence.state = 'active'`) with no
    // publication left to release them. Every inbound row since was held with
    // trigger=0 and every spawn refused, so the workgroup went silently deaf for
    // hours. Nothing else in the host releases a fence whose publication is gone.
    // Reuses the session list the per-session loop already loaded — no extra
    // query — and throttles its own full pass internally.
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
    // Finalize any "Reject with reason…" holds whose reply window elapsed (admin
    // ghosted, or the host restarted mid-capture). Central-DB scan, once per
    // tick — not per session.
    // MODULE-HOOK:approvals-reason-sweep:start
    run: async () => {
      try {
        const { sweepAwaitingReasonRejects } = await import('../approvals/index.js');
        await sweepAwaitingReasonRejects();
      } catch (err) {
        log.error('Reject-with-reason sweep failed', { err });
      }
    },
    // MODULE-HOOK:approvals-reason-sweep:end
  });
}

registerSweepRepoFenceDuties();
