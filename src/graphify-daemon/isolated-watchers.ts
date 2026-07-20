import { Worker } from 'node:worker_threads';

import type { GraphifyFilesystemChange, WorkgroupDescriptor } from './types.js';

interface WatcherCallbacks {
  onDirty(workgroupId: string, changes: GraphifyFilesystemChange[], fullScan: boolean): void;
  onError(workgroupId: string | undefined, error: string): void;
}

export class IsolatedGraphifyWatchers {
  private readonly worker: Worker;
  private syncWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private closeWaiter?: { resolve(): void; reject(error: Error): void };

  constructor(private readonly callbacks: WatcherCallbacks) {
    this.worker = new Worker(new URL('./isolated-watchers-thread.js', import.meta.url));
    this.worker.on(
      'message',
      (message: {
        event: 'dirty' | 'error' | 'fatal' | 'synced' | 'closed';
        workgroupId?: string;
        error?: string;
        changes?: GraphifyFilesystemChange[];
        fullScan?: boolean;
      }) => {
        if (message.event === 'dirty' && message.workgroupId)
          callbacks.onDirty(message.workgroupId, message.changes ?? [], message.fullScan === true);
        else if (message.event === 'error') callbacks.onError(message.workgroupId, message.error ?? 'watcher error');
        else if (message.event === 'fatal') {
          const waiter = this.syncWaiters.shift();
          waiter?.reject(new Error(message.error ?? 'watcher sync failed'));
          callbacks.onError(undefined, message.error ?? 'watcher sync failed');
        } else if (message.event === 'synced') this.syncWaiters.shift()?.resolve();
        else if (message.event === 'closed') this.closeWaiter?.resolve();
      },
    );
    this.worker.on('error', (error) => {
      for (const waiter of this.syncWaiters.splice(0)) waiter.reject(error);
      this.closeWaiter?.reject(error);
      callbacks.onError(undefined, error.message);
    });
  }

  async sync(descriptors: WorkgroupDescriptor[], debounceMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.syncWaiters.push({ resolve, reject });
      this.worker.postMessage({ command: 'sync', descriptors, debounceMs });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.closeWaiter = { resolve, reject };
      this.worker.postMessage({ command: 'close' });
    });
    await this.worker.terminate();
  }
}
