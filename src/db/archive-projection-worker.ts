/**
 * Host-side owner of the archive projection build.
 *
 * This module is now a thin transport. One request means "make this projection
 * current"; the worker decides between reuse, append and full rebuild and says
 * which it did (`materializeArchiveProjection`). The host thread reads nothing
 * from the 400 MB source.
 *
 * Before #315, `buildArchiveProjection` ran synchronously on the main thread on
 * every container spawn: a `GROUP BY` over an unindexed 135 MB `text` column
 * against a 414 MB source, then a row-by-row rewrite of a projection as large
 * as 238 MB. That was the dominant cause of #315 — 327 stalls in one day, p50
 * 18.3 s, max 59.7 s, with 86% of them ending inside a container spawn. Moving
 * it off-thread removed the stall but not the work: #360 measured 435 full
 * rebuilds against 65 reuses in a day, median 19 s and p90 28 s each, because
 * the v1 freshness stamp keyed on the whole archive file and a message for any
 * agent group invalidated every session's projection. Five of those serialized
 * behind one worker is what made a post-boot sweep tick take 200 s.
 *
 * Mirrors `src/storage-maintenance-worker.ts`: one persistent worker, which
 * also serializes rebuilds so concurrent spawns cannot stampede the same
 * source file.
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
    // Node does not apply `--import tsx` hooks to a file-backed Worker.
    // Register tsx inside an eval bootstrap, then load the real ESM-flavored
    // TypeScript entrypoint through its supported CJS API. Same shape as
    // `storage-maintenance-worker.ts`.
    const entryPath = fileURLToPath(workerUrl);
    const parentPath = fileURLToPath(import.meta.url);
    const bootstrap = `const { require: tsxRequire } = require('tsx/cjs/api'); tsxRequire(${JSON.stringify(entryPath)}, ${JSON.stringify(parentPath)});`;
    return new Worker(bootstrap, { eval: true, execArgv: [] });
  }
  // Never inherit parent-only flags such as `--input-type=module`; Node rejects
  // those when the Worker has a file URL entrypoint.
  return new Worker(workerUrl, { execArgv: [] });
}

/** Raised when the worker could not be used at all, as opposed to a build that ran and failed. */
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
      // A build that ran and threw is a real failure and must reach the spawn
      // path as one — never a WorkerUnavailableError, which would silently
      // retry the same doomed build on the main thread.
      if (message.ok) {
        pending.resolve({
          mode: message.mode ?? 'rebuilt',
          rows: message.rows ?? 0,
          merged: message.merged ?? 0,
          bytes: message.bytes ?? 0,
          ms: message.ms ?? 0,
          sinceRowid: message.sinceRowid ?? null,
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
    // The worker must never hold the host process open at shutdown.
    worker.unref?.();
    this.worker = worker;
    return worker;
  }

  private handleWorkerFailure(worker: WorkerLike, error: Error): void {
    // A failed Worker emits `error` and then `exit`. Ignore that late exit if a
    // replacement Worker has already accepted new requests.
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
 * Produce the session's archive projection, reusing the existing file when this
 * workgroup's own rows have not moved, extending it in place when rows have
 * only been added, and rebuilding it off the main thread otherwise.
 *
 * Fail-closed is unchanged from the synchronous original: a build that runs and
 * throws propagates, and the spawn aborts rather than mounting a projection
 * that looks valid and yields nothing.
 *
 * The one deliberate exception is the worker being unavailable — it failed to
 * start, crashed, or the host is shutting it down. That is an infrastructure
 * fault, not a bad projection, and refusing every spawn on it would take the
 * fleet down. Those cases fall back to running the SAME decision in process,
 * which is correct but blocking, and say so at WARN.
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
  if (result.mode === 'reused') {
    log.info('Archive projection reused', { agentGroupId, dstPath, bytes: result.bytes, ms: result.ms, offThread, scope });
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

// Registration at import time is inert by design (see host-lifecycle.ts). The
// worker is also unref'd, so a shutdown that never reaches this hook still
// cannot be held open by it; an in-flight rebuild killed mid-write leaves no
// stamp, so the next spawn rebuilds rather than trusting a partial file.
onHostShutdown(async function archiveProjectionHostShutdown() {
  try {
    await stopArchiveProjectionWorker();
  } catch (err) {
    log.error('Archive projection worker failed to stop cleanly', { err });
  }
});

/** Test hook — swaps the worker for a stub and returns a restore function. */
export function __setArchiveProjectionWorkerFactoryForTest(factory: ArchiveProjectionWorkerFactory | null): void {
  sharedWorker = factory ? new ArchiveProjectionWorker(factory) : new ArchiveProjectionWorker();
}

/** Exported for tests that need to distinguish an infrastructure fault from a build failure. */
export const __test = { WorkerUnavailableError };
