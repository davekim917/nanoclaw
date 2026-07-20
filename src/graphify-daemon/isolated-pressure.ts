import { Worker } from 'node:worker_threads';

export class IsolatedPressureScanner {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: boolean): void; reject(error: Error): void }>();
  private nextId = 1;
  private closed = false;

  constructor(sessionsRoot: string) {
    this.worker = new Worker(new URL('./isolated-pressure-thread.js', import.meta.url), {
      workerData: { sessionsRoot },
    });
    this.worker.on('message', (message: { id: number; ok: boolean; pressure?: boolean; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(Boolean(message.pressure));
      else pending.reject(new Error(message.error ?? 'Graphify pressure scan failed'));
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Graphify pressure scanner exited ${code}`));
    });
  }

  async scan(): Promise<boolean> {
    return await this.request('scan');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request('close');
    this.closed = true;
    await this.worker.terminate();
  }

  private async request(command: 'scan' | 'close'): Promise<boolean> {
    if (this.closed) return false;
    const id = this.nextId++;
    return await new Promise<boolean>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, command });
    });
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
