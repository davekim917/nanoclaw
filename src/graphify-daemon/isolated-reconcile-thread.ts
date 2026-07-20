import { parentPort, workerData } from 'node:worker_threads';

import { WorkgroupGraphDaemon } from './daemon.js';

interface WorkerOptions {
  dataDir: string;
  groupsDir: string;
  centralDbPath: string;
  archivePath: string;
  workgroupId: string;
  enableEnrichment: boolean;
}

const port = parentPort;
if (!port) throw new Error('Graphify isolated reconcile requires a parent port');

const options = workerData as WorkerOptions;
const daemon = new WorkgroupGraphDaemon({
  dataDir: options.dataDir,
  groupsDir: options.groupsDir,
  centralDbPath: options.centralDbPath,
  archivePath: options.archivePath,
  enableEnrichment: options.enableEnrichment,
  isolateReconcile: false,
  scheduleEnrichmentAfterReconcile: false,
  watchFilesystem: false,
});

try {
  await daemon.refreshCatalog();
  const result = await daemon.reconcileOnce(options.workgroupId);
  await daemon.close();
  port.postMessage({ ok: true, result });
} catch (error) {
  await daemon.close().catch(() => undefined);
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
