import { parentPort, workerData } from 'node:worker_threads';

import { WorkgroupGraphStore, type SourceReconciliation } from '../graphify/store.js';

interface WorkerOptions {
  path: string;
  workgroupId: string;
  reason: string;
  upserts: SourceReconciliation[];
  deletes: string[];
}

const port = parentPort;
if (!port) throw new Error('Graphify isolated source reconcile requires a parent port');
const options = workerData as WorkerOptions;

try {
  const store = new WorkgroupGraphStore(options.path, options.workgroupId);
  const result = store.reconcileSources(options.reason, options.upserts, options.deletes);
  store.close();
  port.postMessage({ ok: true, result });
} catch (error) {
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
