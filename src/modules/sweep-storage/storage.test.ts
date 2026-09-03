import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runStorageMaintenanceInBackground: vi.fn(),
  stopStorageMaintenanceWorker: vi.fn(),
  handleStoragePressureAlert: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../storage-maintenance-worker.js', () => ({
  runStorageMaintenanceInBackground: mocks.runStorageMaintenanceInBackground,
  stopStorageMaintenanceWorker: mocks.stopStorageMaintenanceWorker,
}));
vi.mock('../../storage-pressure-alert.js', () => ({
  handleStoragePressureAlert: mocks.handleStoragePressureAlert,
}));
vi.mock('../../log.js', () => ({
  log: { info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: mocks.logDebug },
}));

import { getHostShutdownCallbacks } from '../../host-lifecycle.js';
import { startStorageMaintenanceOnce } from './index.js';

describe('storage maintenance start and stop are declared in one module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('startStorageMaintenanceOnce is exported from the module and wraps the background worker call', async () => {
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(null);

    startStorageMaintenanceOnce(['session-1', 'session-2']);
    // Fire-and-forget: let the microtask queue drain so the .then/.catch chain runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runStorageMaintenanceInBackground).toHaveBeenCalledWith(['session-1', 'session-2']);
    expect(mocks.handleStoragePressureAlert).not.toHaveBeenCalled();
  });

  it('forwards a non-null storage report to handleStoragePressureAlert, same as the former host-sweep.ts call site', async () => {
    const report = { usagePct: 91 } as never;
    mocks.runStorageMaintenanceInBackground.mockResolvedValue(report);

    startStorageMaintenanceOnce(['session-1']);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.handleStoragePressureAlert).toHaveBeenCalledWith(report);
  });

  it('a rejected background pass is caught and logged, never left unhandled', async () => {
    mocks.runStorageMaintenanceInBackground.mockRejectedValue(new Error('background boom'));

    startStorageMaintenanceOnce(['session-1']);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      'storage-manager: background maintenance failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('registers an onHostShutdown callback that stops the worker, guarding a failed stop', async () => {
    mocks.stopStorageMaintenanceWorker.mockResolvedValue(undefined);

    const callbacksBefore = getHostShutdownCallbacks().length;
    expect(callbacksBefore).toBeGreaterThan(0);
    const shutdown = getHostShutdownCallbacks()[callbacksBefore - 1];
    await shutdown();

    expect(mocks.stopStorageMaintenanceWorker).toHaveBeenCalledTimes(1);
  });

  it('a stop failure is logged, not thrown, so the rest of shutdown proceeds', async () => {
    mocks.stopStorageMaintenanceWorker.mockRejectedValue(new Error('stop boom'));

    const callbacks = getHostShutdownCallbacks();
    const shutdown = callbacks[callbacks.length - 1];
    await expect(shutdown()).resolves.toBeUndefined();

    expect(mocks.logError).toHaveBeenCalledWith(
      'Storage maintenance worker failed to stop cleanly',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('src/main.ts references neither startStorageMaintenanceOnce nor stopStorageMaintenanceWorker', () => {
    const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    expect(source).not.toMatch(/\bstartStorageMaintenanceOnce\b/);
    expect(source).not.toMatch(/\bstopStorageMaintenanceWorker\b/);
  });
});
