/**
 * On main, S2-PR1 owns the worker's stop via `onHostShutdown` —
 * `stopHostModules()` runs before `stopHostSweep()` there by design, and
 * S2-PR1 removes main.ts's own direct stop call. At the rebase onto main,
 * take PR 1's version of this file verbatim (this file registers NO
 * shutdown of its own — see the Codex PR6 review finding below).
 *
 * `startStorageMaintenanceOnce` is fire-and-forget, called once per sweep
 * tick (T13 below) with the tick's already-computed active session ids; the
 * persistent worker owns its own 1h/6h cadence internally
 * (storage-maintenance-worker.ts). On this branch's base (S2-PR2, mailbox
 * PR 5 lineage) neither S2-PR0's `host-lifecycle.ts` nor S2-PR1's own
 * version of this file exist. An earlier draft of this file registered a
 * stop via `response-registry.js`'s `onShutdown` as a substitute — Codex's
 * PR6 review (F1, accepted) found that wrong on THIS base: response-registry
 * callbacks fire before `stopHostSweep()` in `main.ts`'s `shutdown()`, so
 * T13 could still tick against an already-stopped worker (a new
 * `storage-manager: background maintenance failed` line) and `main.ts`
 * would then stop the worker a second time. `src/main.ts`'s own direct
 * `stopStorageMaintenanceWorker()` call is the sole, exactly-once shutdown
 * owner on this branch and is untouched (S2-PR1's job to remove, outside
 * S2-PR6's ownership).
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
