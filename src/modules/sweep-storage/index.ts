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
 */
import { onHostShutdown } from '../../host-lifecycle.js';
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
