/**
 * Host-side transport for archive projection builds. One request means "make this projection current"; the worker
 * decides reuse, append or rebuild (`materializeArchiveProjection`) and the host thread never reads the large source.
 * Synchronous builds on the main thread were the dominant cause of event-loop stalls. One persistent worker, as in
 * `src/storage-maintenance-worker.ts`, which also serializes builds so concurrent spawns cannot stampede the source.
 */
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { onHostShutdown } from '../host-lifecycle.js';
import { log } from '../log.js';
import { materializeArchiveProjection } from './per-agent-projections.js';
import type { ArchiveProjectionResult } from './per-agent-projections.js';
import type { ArchiveProjectionRequest, ArchiveProjectionResponse } from './archive-projection-worker-thread.js';

interface WorkerLike {
  on(event: 'message', listener: (message: ArchiveProjectionResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref?(): void;
}

export type ArchiveProjectionWorkerFactory = () => WorkerLike;

function createWorker(): WorkerLike {
  const runningTypeScript = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(
    runningTypeScript ? './archive-projection-worker-thread.ts' : './archive-projection-worker-thread.js',
    import.meta.url,
  );
  if (runningTypeScript) {
    // Node does not apply `--import tsx` hooks to a file-backed Worker, so tsx is registered inside an eval
    // bootstrap.
    const entryPath = fileURLToPath(workerUrl);
    const parentPath = fileURLToPath(import.meta.url);
    const bootstrap = `const { require: tsxRequire } = require('tsx/cjs/api'); tsxRequire(${JSON.stringify(entryPath)}, ${JSON.stringify(parentPath)});`;
    return new Worker(bootstrap, { eval: true, execArgv: [] });
  }
  // Never inherit parent-only flags such as `--input-type=module`; Node rejects them for a file-URL Worker.
  return new Worker(workerUrl, { execArgv: [] });
}

/** The worker could not be used at all, as opposed to a build that ran and failed. */
class WorkerUnavailableError extends Error {}

class ArchiveProjectionWorker {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<
    number,
    { resolve(result: ArchiveProjectionResult): void; reject(error: Error): void }
  >();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly workerFactory: ArchiveProjectionWorkerFactory = createWorker) {}

  build(request: Omit<ArchiveProjectionRequest, 'id'>): Promise<ArchiveProjectionResult> {
    if (this.stopped) return Promise.reject(new WorkerUnavailableError('Archive projection worker is stopped'));
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)));
    }
    const id = this.nextId++;
    return new Promise<ArchiveProjectionResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...request } satisfies ArchiveProjectionRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    this.failPending(new WorkerUnavailableError('Archive projection worker stopped'));
    if (worker) await worker.terminate();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      // A build that ran and threw is a real failure for the spawn path, never WorkerUnavailableError, which would
      // retry the same doomed build on the main thread.
      if (message.ok) {
        pending.resolve({
          mode: message.mode ?? 'rebuilt',
          rows: message.rows ?? 0,
          merged: message.merged ?? 0,
          bytes: message.bytes ?? 0,
          ms: message.ms ?? 0,
          sinceRowid: message.sinceRowid ?? null,
          seededFrom: message.seededFrom ?? null,
        });
      } else {
        pending.reject(new Error(message.error ?? 'Archive projection build failed'));
      }
    });
    worker.on('error', (error) => this.handleWorkerFailure(worker, new WorkerUnavailableError(error.message)));
    worker.on('exit', (code) => {
      if (!this.stopped) {
        this.handleWorkerFailure(worker, new WorkerUnavailableError(`Archive projection worker exited ${code}`));
      }
    });
    // Must never hold the host process open at shutdown.
    worker.unref?.();
    this.worker = worker;
    return worker;
  }

  private handleWorkerFailure(worker: WorkerLike, error: Error): void {
    // A failed Worker emits `error` then `exit`; ignore the late exit if a replacement already took requests.
    if (this.worker !== worker) return;
    this.worker = null;
    this.failPending(error);
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

let sharedWorker = new ArchiveProjectionWorker();

/**
 * Makes the session's archive projection current. Fail-closed: a build that throws propagates and the spawn aborts.
 * The one exception is an unavailable worker (failed to start, crashed, shutting down): an infrastructure fault that
 * falls back to the SAME decision in process, blocking, logged at WARN, rather than refusing every spawn.
 */
export async function ensureArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): Promise<ArchiveProjectionResult> {
  let result: ArchiveProjectionResult;
  let offThread = true;
  try {
    result = await sharedWorker.build({ srcPath, dstPath, agentGroupId, workgroupMemberIds });
  } catch (error) {
    if (!(error instanceof WorkerUnavailableError)) throw error;
    log.warn('Archive projection worker unavailable — building on the main thread', {
      agentGroupId,
      dstPath,
      err: error.message,
    });
    offThread = false;
    result = materializeArchiveProjection(srcPath, dstPath, agentGroupId, workgroupMemberIds);
  }

  const scope = workgroupMemberIds?.length ?? null;
  if (result.mode === 'seeded') {
    // Distinct log mode so a fresh session's seed is greppable apart from steady-state traffic.
    log.info('Archive projection seeded', {
      agentGroupId,
      dstPath,
      seededFrom: result.seededFrom,
      rows: result.rows,
      merged: result.merged,
      bytes: result.bytes,
      ms: result.ms,
      sinceRowid: result.sinceRowid,
      offThread,
      scope,
    });
  } else if (result.mode === 'reused') {
    log.info('Archive projection reused', {
      agentGroupId,
      dstPath,
      bytes: result.bytes,
      ms: result.ms,
      offThread,
      scope,
    });
  } else if (result.mode === 'appended') {
    log.info('Archive projection appended', {
      agentGroupId,
      dstPath,
      rows: result.rows,
      merged: result.merged,
      ms: result.ms,
      bytes: result.bytes,
      sinceRowid: result.sinceRowid,
      offThread,
      scope,
    });
  } else {
    log.info('Archive projection built', {
      agentGroupId,
      dstPath,
      rows: result.rows,
      ms: result.ms,
      bytes: result.bytes,
      offThread,
      scope,
    });
  }
  return result;
}

export function stopArchiveProjectionWorker(): Promise<void> {
  return sharedWorker.close();
}

// Registration at import is inert (see host-lifecycle.ts). The worker is unref'd, and a rebuild killed mid-write
// leaves no stamp, so the next spawn rebuilds.
onHostShutdown(async function archiveProjectionHostShutdown() {
  try {
    await stopArchiveProjectionWorker();
  } catch (err) {
    log.error('Archive projection worker failed to stop cleanly', { err });
  }
});

/** Test hook: swaps the worker factory. */
export function __setArchiveProjectionWorkerFactoryForTest(factory: ArchiveProjectionWorkerFactory | null): void {
  sharedWorker = factory ? new ArchiveProjectionWorker(factory) : new ArchiveProjectionWorker();
}
