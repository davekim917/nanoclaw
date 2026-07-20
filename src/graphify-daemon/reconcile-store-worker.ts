import { Worker } from 'node:worker_threads';

import { WorkgroupGraphStore, type SourceReconciliation, type SourceStateAppend } from '../graphify/store.js';

export interface ReconcileStore {
  beginGeneration(reason: string): Promise<number>;
  appendSources(items: SourceReconciliation[], generation: number): Promise<void>;
  appendSourceStates(items: SourceStateAppend[], generation: number): Promise<void>;
  completeGeneration(generation: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type ReconcileStoreFactory = (path: string, workgroupId: string) => ReconcileStore;

/** Test/dev fallback; production JavaScript always uses the isolated worker. */
class InProcessReconcileStore implements ReconcileStore {
  private readonly store: WorkgroupGraphStore;
  constructor(path: string, workgroupId: string) {
    this.store = new WorkgroupGraphStore(path, workgroupId);
  }
  async beginGeneration(reason: string): Promise<number> {
    return this.store.beginGeneration(reason);
  }
  async appendSources(items: SourceReconciliation[], generation: number): Promise<void> {
    this.store.appendSources(items, generation);
  }
  async appendSourceStates(items: SourceStateAppend[], generation: number): Promise<void> {
    this.store.appendSourceStates(items, generation);
  }
  async completeGeneration(generation: number): Promise<void> {
    this.store.completeGeneration(generation);
  }
  async close(): Promise<void> {
    this.store.close();
  }
  async abort(): Promise<void> {
    this.store.close();
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class ThreadedReconcileStore implements ReconcileStore {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopped = false;

  constructor(path: string, workgroupId: string) {
    this.worker = new Worker(new URL('./reconcile-store-worker-thread.js', import.meta.url), {
      workerData: { path, workgroupId },
    });
    this.worker.on('message', (message: { id: number; ok: boolean; data?: unknown; error?: string }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.data);
      else request.reject(new Error(message.error ?? 'Graphify reconcile store worker failed'));
    });
    this.worker.on('error', (error) => this.failPending(error));
    this.worker.on('exit', (code) => {
      if (!this.stopped && code !== 0) this.failPending(new Error(`Graphify reconcile store worker exited ${code}`));
    });
  }

  async beginGeneration(reason: string): Promise<number> {
    return (await this.request({ command: 'begin', reason })) as number;
  }
  async appendSources(items: SourceReconciliation[], generation: number): Promise<void> {
    await this.request({ command: 'append', items, generation });
  }
  async appendSourceStates(items: SourceStateAppend[], generation: number): Promise<void> {
    await this.request({ command: 'append-states', items, generation });
  }
  async completeGeneration(generation: number): Promise<void> {
    await this.request({ command: 'complete', generation });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    await this.request({ command: 'close' });
    this.stopped = true;
    await this.worker.terminate();
  }
  async abort(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.failPending(new Error('Graphify reconcile store worker aborted'));
    await this.worker.terminate();
  }

  private async request(message: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error('Graphify reconcile store worker is closed');
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message });
    });
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export const createReconcileStore: ReconcileStoreFactory = (path, workgroupId) =>
  // Vitest transforms TypeScript in-process but does not emit the sibling JS
  // worker entrypoint. Built production code always takes the threaded path.
  import.meta.url.endsWith('.ts')
    ? new InProcessReconcileStore(path, workgroupId)
    : new ThreadedReconcileStore(path, workgroupId);
