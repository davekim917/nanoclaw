/**
 * Sweep family: central housekeeping (seam 2, S2-PR4).
 *
 * Order-free `tick:housekeeping` work moved out of src/host-sweep.ts unchanged
 * (plan.md §4.3/§4.7): T7 github-app-token-refresh (20), T9 steer-idempotency
 * prune (30), T10 channel-ingress-receipt prune (40), T15 session-title sweep
 * (80), T16 thread-title retry (90), T17 dashboard-token prune (120). Phase
 * and order are unchanged from the PR 5 baseline — those coordinates encode
 * ordering constraints (plan.md §4.3 table) and must never move.
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
import { pruneChannelIngressReceipts } from '../../db/channel-ingress-receipts.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { pruneSteerIdempotency } from './steer-idempotency.js';

function registerCentralSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.T7,
    phase: 'tick:housekeeping',
    order: 20,
    // Proactively re-mint GitHub App installation tokens inside their refresh
    // margin, so a container respawning mid-hour gets a fresh credential instead
    // of one about to die (2026-08-23: an hour-old token flapped mid-session and
    // stalled release-day work). Opportunistic — failures log and retry next tick.
    run: async () => {
      try {
        const { refreshExpiringGitHubAppTokens } = await import('../../github-app-token.js');
        await refreshExpiringGitHubAppTokens();
      } catch (err) {
        log.warn('GitHub App token refresh sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T9,
    phase: 'tick:housekeeping',
    order: 30,
    // Prune steer_idempotency rows: applied rows older than 60s, pending rows
    // older than 5min.
    run: () => {
      pruneSteerIdempotency();
    },
  });

  registerSweepDuty({
    name: id.T10,
    phase: 'tick:housekeeping',
    order: 40,
    run: () => {
      pruneChannelIngressReceipts();
    },
  });

  registerSweepDuty({
    name: id.T15,
    phase: 'tick:housekeeping',
    order: 80,
    // Inbox: generate Haiku titles for sessions that don't have one (or whose
    // existing title is ≥1h old AND has ≥10 new messages since).
    // Concurrency-capped at 3 per tick — keeps the API spend bounded.
    run: () => {
      void import('../../dashboard/session-title-sweep.js')
        .then((mod) => mod.runSessionTitleSweep())
        .catch((err) => log.warn('session-title sweep failed', { err }));
    },
  });

  registerSweepDuty({
    name: id.T16,
    phase: 'tick:housekeeping',
    order: 90,
    // Retry Discord thread titles whose earlier attempts all failed (e.g. a 429
    // window that outlasted callHaiku's own retry budget). Regenerates from the
    // STORED, ORIGINAL first_message — never a later follow-up, which is the bug
    // this table exists to fix. Capped at 3/tick (inside retryPendingThreadTitles)
    // so a backlog of permanently-broken threads can't itself become a
    // Haiku/Discord-REST quota hog. See src/topic-title.ts.
    run: () => {
      void import('../../topic-title.js')
        .then((mod) => mod.retryPendingThreadTitles())
        .catch((err) => log.warn('thread-title retry sweep failed', { err }));
    },
  });

  registerSweepDuty({
    name: id.T17,
    phase: 'tick:housekeeping',
    order: 120,
    // Prune dashboard_tokens rows past expiry + 1d grace (post-build QA fix SF-6).
    run: () => {
      void import('../../dashboard/db/dashboard-tokens.js')
        .then((mod) => mod.pruneDashboardTokens())
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });
    },
  });
}

registerSweepDutySource('sweep-central', registerCentralSweepDuties);
