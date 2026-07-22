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

type SerializableStorageOptions = Omit<StorageReportOptions, 'isContainerRunning'>;

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

initDb((workerData as StorageWorkerData).dbPath);

port.on('message', (message: StorageWorkerRequest) => {
  try {
    if (message.command === 'close') {
      closeDb();
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

process.once('exit', closeDb);
