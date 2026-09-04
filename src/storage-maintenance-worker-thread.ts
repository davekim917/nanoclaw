import { parentPort, workerData } from 'node:worker_threads';

import { closeDb, initDb } from './db/connection.js';
import {
  assertStorageAdmission,
  getStorageReport,
  runStorageMaintenance,
  type StorageReportOptions,
} from './storage-manager.js';

interface StorageWorkerData {
  dbPath: string;
}

// Both omitted members are functions: they cannot survive the structured clone
// into the worker, and both are supplied on this side instead.
type SerializableStorageOptions = Omit<StorageReportOptions, 'isContainerRunning' | 'runningContainerMounts'>;

type StorageWorkerRequest =
  | {
      id: number;
      command: 'maintenance';
      activeSessionIds: string[];
      options?: SerializableStorageOptions;
    }
  | {
      id: number;
      command: 'admission';
      activeSessionIds: string[];
      options?: SerializableStorageOptions;
    }
  | {
      id: number;
      command: 'report';
      activeSessionIds: string[];
      options?: SerializableStorageOptions;
    }
  | { id: number; command: 'close' };

const port = parentPort;
if (!port) throw new Error('Storage maintenance worker requires a parent port');

await initDb((workerData as StorageWorkerData).dbPath);

port.on('message', (message: StorageWorkerRequest) => {
  try {
    if (message.command === 'close') {
      // `void`, not `await`: this listener must stay synchronous (an async
      // listener would report success before the close ran, and is a
      // no-misused-promises error). `closeDb()` runs `SqliteDriver.close()`,
      // whose body reaches `raw.close()` synchronously whenever no driver
      // transaction is open — and this worker opens none — so the handle is
      // shut before `postMessage`, exactly as before the driver landed.
      void closeDb();
      port.postMessage({ id: message.id, ok: true });
      port.close();
      return;
    }

    const activeSessionIds = new Set(message.activeSessionIds);
    const options: StorageReportOptions = {
      ...message.options,
      isContainerRunning: (sessionId) => activeSessionIds.has(sessionId),
    };
    const result =
      message.command === 'maintenance'
        ? runStorageMaintenance(options)
        : message.command === 'admission'
          ? assertStorageAdmission(options)
          : getStorageReport(options);
    port.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Same reasoning as the 'close' command: an exit handler cannot await, and
// `closeDb()` closes the raw handle synchronously when no transaction is open.
process.once('exit', () => {
  void closeDb();
});
