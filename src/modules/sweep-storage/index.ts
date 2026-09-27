/**
 * The persistent worker owns its own cadence, so there is no host timer to
 * start, only a worker to stop. `onHostShutdown` is the ONE stop path; do not
 * add a second.
 */
import { onHostShutdown } from '../../host-lifecycle.js';
import { getStorageProtectedSessionIds } from '../../container-runner.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { runStorageMaintenanceInBackground, stopStorageMaintenanceWorker } from '../../storage-maintenance-worker.js';
import { handleStoragePressureAlert } from '../../storage-pressure-alert.js';

/** Fire-and-forget: must not block the host event loop. */
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

export function registerStorageSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T13,
    phase: 'tick:post-session',
    order: 30,
    // Fire-and-forget into a persistent worker, keeping the event loop free for
    // channel heartbeats and inbound events.
    run: (ctx) => {
      // Include pending survivors adoption could not yet claim: without a
      // storage lease they are otherwise unprotected from cleanup.
      startStorageMaintenanceOnce([...new Set([...ctx.activeContainerSessionIds, ...getStorageProtectedSessionIds()])]);
    },
  });
}

registerSweepDutySource('sweep-storage', registerStorageSweepDuties);
