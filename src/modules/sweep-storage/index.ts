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
 * The shutdown half: `onHostShutdown` from `host-lifecycle.ts` is the ONE
 * stop path — `stopHostModules()` runs before `stopHostSweep()` by design,
 * and main.ts has no direct stop call. Do not add a second stop path here.
 */
import { onHostShutdown } from '../../host-lifecycle.js';
import { getStorageProtectedSessionIds } from '../../container-runner.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { runStorageMaintenanceInBackground, stopStorageMaintenanceWorker } from '../../storage-maintenance-worker.js';
import { handleStoragePressureAlert } from '../../storage-pressure-alert.js';

/**
 * Fire-and-forget, with a `.catch` — reclaim disk from idle caches and Docker
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
// T13 (storage-maintenance) sweep duty registration. Storage maintenance runs
// after the session loop (tick:post-session, order 30), and the duty calls
// `startStorageMaintenanceOnce` above rather than re-stating its chain.
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
      // Active containers PLUS the pending survivors adoption could not yet
      // claim: a survivor whose storage lease could
      // not be taken is otherwise unprotected from the worker's cleanup.
      startStorageMaintenanceOnce([...new Set([...ctx.activeContainerSessionIds, ...getStorageProtectedSessionIds()])]);
    },
  });
}

registerSweepDutySource('sweep-storage', registerStorageSweepDuties);
