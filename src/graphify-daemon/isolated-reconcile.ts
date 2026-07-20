import { Worker } from 'node:worker_threads';

import type { DiscoveredSource } from '../graphify/discovery.js';
import type { WorkgroupRoot } from './types.js';

export interface IsolatedCodeSourceBuild {
  source: DiscoveredSource;
  root: WorkgroupRoot;
}

export interface IsolatedReconcileResult {
  codeSources: IsolatedCodeSourceBuild[];
  completedAt: string;
  /** Private, complete database for the parent daemon to validate and promote. */
  candidatePath?: string;
}

export interface IsolatedReconcileOptions {
  dataDir: string;
  groupsDir: string;
  centralDbPath: string;
  archivePath: string;
  workgroupId: string;
  enableEnrichment: boolean;
  signal?: AbortSignal;
}

export async function runIsolatedReconcile(options: IsolatedReconcileOptions): Promise<IsolatedReconcileResult> {
  const worker = new Worker(new URL('./isolated-reconcile-thread.js', import.meta.url), {
    workerData: {
      dataDir: options.dataDir,
      groupsDir: options.groupsDir,
      centralDbPath: options.centralDbPath,
      archivePath: options.archivePath,
      workgroupId: options.workgroupId,
      enableEnrichment: options.enableEnrichment,
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
    const onAbort = (): void => finish(() => reject(new Error('Graphify isolated reconcile aborted')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.once('message', (message: { ok: boolean; result?: IsolatedReconcileResult; error?: string }) => {
      if (message.ok && message.result) finish(() => resolve(message.result!));
      else finish(() => reject(new Error(message.error ?? 'Graphify isolated reconcile failed')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Graphify isolated reconcile exited ${code}`)));
    });
  });
}
