import { Worker } from 'node:worker_threads';

import type { SourceReconciliation, SourceReconciliationResult } from '../graphify/store.js';

export interface IsolatedSourceReconcileOptions {
  path: string;
  workgroupId: string;
  reason: string;
  upserts: SourceReconciliation[];
  deletes: string[];
  signal?: AbortSignal;
}

export async function runIsolatedSourceReconcile(
  options: IsolatedSourceReconcileOptions,
): Promise<SourceReconciliationResult> {
  const worker = new Worker(new URL('./isolated-source-reconcile-thread.js', import.meta.url), {
    workerData: {
      path: options.path,
      workgroupId: options.workgroupId,
      reason: options.reason,
      upserts: options.upserts,
      deletes: options.deletes,
    },
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      operation();
      void worker.terminate();
    };
    const onAbort = (): void => finish(() => reject(new Error('Graphify isolated source reconcile aborted')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.once('message', (message: { ok: boolean; result?: SourceReconciliationResult; error?: string }) => {
      if (message.ok && message.result) finish(() => resolve(message.result!));
      else finish(() => reject(new Error(message.error ?? 'Graphify isolated source reconcile failed')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Graphify isolated source reconcile exited ${code}`)));
    });
  });
}
