import { parentPort, workerData } from 'node:worker_threads';

import { WorkgroupGraphStore, type SourceReconciliation, type SourceStateAppend } from '../graphify/store.js';

interface WorkerData {
  path: string;
  workgroupId: string;
}

type WorkerCommand =
  | { id: number; command: 'begin'; reason: string }
  | { id: number; command: 'append'; items: SourceReconciliation[]; generation: number }
  | { id: number; command: 'append-states'; items: SourceStateAppend[]; generation: number }
  | { id: number; command: 'complete'; generation: number }
  | { id: number; command: 'close' };

const port = parentPort;
if (!port) throw new Error('Graphify reconcile store worker requires a parent port');

const options = workerData as WorkerData;
const store = new WorkgroupGraphStore(options.path, options.workgroupId);
let closed = false;

port.on('message', (message: WorkerCommand) => {
  try {
    let data: unknown;
    switch (message.command) {
      case 'begin':
        data = store.beginGeneration(message.reason);
        break;
      case 'append':
        store.appendSources(message.items, message.generation);
        break;
      case 'append-states':
        store.appendSourceStates(message.items, message.generation);
        break;
      case 'complete':
        store.completeGeneration(message.generation);
        break;
      case 'close':
        store.close();
        closed = true;
        break;
    }
    port.postMessage({ id: message.id, ok: true, data });
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.once('exit', () => {
  if (!closed) store.close();
});
