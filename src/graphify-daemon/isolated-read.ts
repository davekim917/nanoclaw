import { Worker } from 'node:worker_threads';

export type IsolatedReadCommand = 'query' | 'status' | 'explain' | 'path' | 'affected';

export async function runIsolatedRead<T>(
  path: string,
  workgroupId: string,
  command: IsolatedReadCommand,
  args: Record<string, unknown>,
): Promise<T> {
  const worker = new Worker(new URL('./isolated-read-thread.js', import.meta.url), {
    workerData: { path, workgroupId, command, args },
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      operation();
      void worker.terminate();
    };
    worker.once('message', (message: { ok: boolean; result?: T; error?: string }) => {
      if (message.ok) finish(() => resolve(message.result as T));
      else finish(() => reject(new Error(message.error ?? 'Graphify isolated read failed')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Graphify isolated read exited ${code}`)));
    });
  });
}
