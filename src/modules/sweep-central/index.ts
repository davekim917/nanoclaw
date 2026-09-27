/**
 * Order-free central housekeeping duties on `tick:housekeeping`. Phase/order
 * coordinates of the ported T-duties encode ordering constraints; don't move them.
 * Order 45 in this phase is reserved by host-sweep-registry.test.ts's isolation probe.
 */
import { pruneCliRequestExecutions } from '../../cli/request-ledger.js';
import { pruneChannelIngressReceipts } from '../../db/channel-ingress-receipts.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { sweepCoordinationOrphans } from './coordination-orphans.js';
import { pruneSteerIdempotency } from './steer-idempotency.js';

function registerCentralSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.T7,
    phase: 'tick:housekeeping',
    order: 20,
    // Re-mint GitHub App tokens inside their refresh margin so a respawning
    // container never gets one about to expire. Failures retry next tick.
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
    name: id.FORK1,
    phase: 'tick:housekeeping',
    order: 25,
    // A running container's env is frozen at spawn but its read-only token file
    // mount is live, so rewriting the file hands it the fresh credential. Must
    // run after the T7 re-mint.
    run: async () => {
      try {
        const { refreshGroupGitHubTokenFiles } = await import('../../github-token-file.js');
        await refreshGroupGitHubTokenFiles();
      } catch (err) {
        log.warn('GitHub token file refresh sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T9,
    phase: 'tick:housekeeping',
    order: 30,
    run: async () => {
      await pruneSteerIdempotency();
    },
  });

  registerSweepDuty({
    name: id.T10,
    phase: 'tick:housekeeping',
    order: 40,
    run: async () => {
      await pruneChannelIngressReceipts();
    },
  });

  registerSweepDuty({
    name: id.T23,
    phase: 'tick:housekeeping',
    order: 42,
    // Rows only have to outlive the delivery loop's retry of one outbound row.
    run: async () => {
      await pruneCliRequestExecutions();
    },
  });

  registerSweepDuty({
    name: id.T15,
    phase: 'tick:housekeeping',
    order: 80,
    // Titles sessions lacking one (or with a ≥1h-old title and ≥10 new
    // messages). Capped at 3 per tick to bound API spend.
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
    // Regenerates from the STORED original first_message, never a later
    // follow-up. Capped at 3/tick so permanently-broken threads can't hog quota.
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
    run: () => {
      void import('../../dashboard/db/dashboard-tokens.js')
        .then((mod) => mod.pruneDashboardTokens())
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });
    },
  });

  registerSweepDuty({
    name: id.FORK2,
    phase: 'tick:housekeeping',
    order: 130,
    run: () => sweepCoordinationOrphans(),
  });
}

registerSweepDutySource('sweep-central', registerCentralSweepDuties);
