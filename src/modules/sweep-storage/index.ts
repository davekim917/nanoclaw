/**
 * Storage-maintenance start and stop, declared together.
 *
 * `startStorageMaintenanceOnce` is fire-and-forget, called once per sweep
 * tick (T13, registered below) with the tick's already-computed active
 * session ids; the persistent worker owns its own 1h/6h cadence internally
 * (storage-maintenance-worker.ts), so there is no host-owned timer to START
 * here — only a persistent worker to STOP cleanly on the way down. That
 * asymmetry is why both halves live in one module instead of splitting
 * across host-sweep.ts (start) and main.ts (stop), as they did before.
 *
 * The shutdown half is S2-PR1's, taken verbatim: `onHostShutdown` from
 * `host-lifecycle.ts` (S2-PR0) is the ONE stop path — `stopHostModules()`
 * runs before `stopHostSweep()` by design and S2-PR1 removed main.ts's own
 * direct stop call. S2-PR6's branch base carried neither file, so its own
 * copy of this module registered nothing (its earlier `response-registry`
 * substitute was withdrawn after Codex's PR6 review F1); on this integrated
 * lineage the file keeps PR 1's version and gains only PR 6's T13
 * registration below. Do not add a second stop path here.
 */
import { onHostShutdown } from '../../host-lifecycle.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
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

onHostShutdown(async function storageMaintenanceHostShutdown() {
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
