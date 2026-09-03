/**
 * PR 1 (main) adds the onHostShutdown stop for the worker here; at the
 * rebase onto main after PR 0/PR 1 deploy, take the UNION of both versions.
 *
 * `startStorageMaintenanceOnce` is fire-and-forget, called once per sweep
 * tick (T13 below) with the tick's already-computed active session ids; the
 * persistent worker owns its own 1h/6h cadence internally
 * (storage-maintenance-worker.ts). On this branch's base (S2-PR2, mailbox
 * PR 5 lineage) neither S2-PR0's `host-lifecycle.ts` nor S2-PR1's own
 * version of this file exist, so this file carries ONLY what compiles here
 * — the start half and T13's registration — and none of PR 1's shutdown
 * registration. `src/main.ts` still calls `stopStorageMaintenanceWorker()`
 * directly at shutdown today; that stays exactly as-is (PR 1's job, outside
 * S2-PR6's ownership) until the union above happens.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { runStorageMaintenanceInBackground } from '../../storage-maintenance-worker.js';
import { handleStoragePressureAlert } from '../../storage-pressure-alert.js';

/**
 * Same fire-and-forget semantics as the former host-sweep.ts:1206 call site,
 * including its existing `.catch` — reclaim disk from idle caches and Docker
 * artifacts after per-session sweep work has had a chance to notice and wake
 * due messages, without blocking the host event loop.
 */
export function startStorageMaintenanceOnce(activeSessionIds: string[]): void {
  void runStorageMaintenanceInBackground(activeSessionIds)
    .then((storageReport) => (storageReport ? handleStoragePressureAlert(storageReport) : undefined))
    .catch((err) => log.warn('storage-manager: background maintenance failed', { err }));
}

// ─────────────────────────────────────────────────────────────────────────────
// S2-PR6: T13 (storage-maintenance) sweep duty registration.
//
// Moved from src/host-sweep.ts UNCHANGED (plan.md §4.3 constraint 2:
// "storage maintenance after the session loop" — tick:post-session, order
// 30). The pre-move body duplicated exactly the fire-and-forget chain
// `startStorageMaintenanceOnce` above already implements, so the registered
// duty calls this module's own export instead of re-stating it.
// ─────────────────────────────────────────────────────────────────────────────

export function registerStorageSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T13,
    phase: 'tick:post-session',
    order: 30,
    // Reclaim disk from idle caches and Docker artifacts after per-session sweep
    // work has had a chance to notice and wake due messages. Fire-and-forget
    // into a persistent worker. The worker owns the expensive synchronous
    // filesystem/Docker implementation and its cadence state; the host event
    // loop stays available for channel heartbeats and inbound events.
    run: (ctx) => {
      startStorageMaintenanceOnce([...ctx.activeContainerSessionIds]);
    },
  });
}

registerSweepDutySource('sweep-storage', registerStorageSweepDuties);
