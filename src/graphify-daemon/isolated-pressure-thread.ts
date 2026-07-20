import { parentPort, workerData } from 'node:worker_threads';

import { InteractivePressureScanner } from './background-runner.js';

const port = parentPort;
if (!port) throw new Error('Graphify isolated pressure scanner requires a parent port');
const scanner = new InteractivePressureScanner((workerData as { sessionsRoot: string }).sessionsRoot);

port.on('message', (message: { id: number; command: 'scan' | 'close' }) => {
  if (message.command === 'close') {
    port.postMessage({ id: message.id, ok: true, pressure: false });
    return;
  }
  try {
    port.postMessage({ id: message.id, ok: true, pressure: scanner.scan() });
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
