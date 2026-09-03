/**
 * Storage-maintenance start and stop, declared together.
 *
 * `startStorageMaintenanceOnce` is fire-and-forget, called once per sweep
 * tick (T13, host-sweep.ts) with the tick's already-computed active session
 * ids; the persistent worker owns its own 1h/6h cadence internally
 * (storage-maintenance-worker.ts), so there is no host-owned timer to START
 * here — only a persistent worker to STOP cleanly on the way down. That
 * asymmetry is why both halves live in one module instead of splitting
 * across host-sweep.ts (start) and main.ts (stop), as they did before.
 *
 * S2-PR1's content (module timers), reproduced here per the S2-PR6 brief so
 * the eventual rebase merges cleanly — S2-PR1 is not merged under S2-PR2 on
 * this branch's base. One deliberate adaptation: S2-PR1's own file registers
 * its stop via `onHostShutdown` from `host-lifecycle.ts` (S2-PR0), which also
 * does not exist on this base; this file uses the currently-live equivalent,
 * `onShutdown` from `response-registry.js` (the mechanism every other module
 * already registers shutdown work through — see modules/approvals/index.ts).
 * `src/main.ts` still ALSO calls `stopStorageMaintenanceWorker()` directly at
 * shutdown (its own S2-PR1 job to remove) — harmless since `close()` is
 * idempotent (`storage-maintenance-worker.ts`'s `stopped` guard), but flagged
 * here rather than silently touching main.ts, which is outside S2-PR6's
 * ownership.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { onShutdown } from '../../response-registry.js';
import { runStorageMaintenanceInBackground, stopStorageMaintenanceWorker } from '../../storage-maintenance-worker.js';
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

onShutdown(async () => {
  try {
    await stopStorageMaintenanceWorker();
  } catch (err) {
    // Worker teardown failure must not prevent channel teardown and container
    // reaping; those children otherwise linger until systemd's hard timeout.
    log.error('Storage maintenance worker failed to stop cleanly', { err });
  }
});

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
