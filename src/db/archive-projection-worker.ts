/**
 * Host-side owner of the archive projection build.
 *
 * Two changes to a spawn's cost, in the order they apply:
 *
 *   1. Skip the build entirely when the projection on disk was built from
 *      exactly these inputs (`archiveProjectionIsFresh`).
 *   2. When a build IS needed, run it on a worker thread and await it, so the
 *      host's event loop stays free for adapters, delivery and the sweep.
 *
 * Before this, `buildArchiveProjection` ran synchronously on the main thread on
 * every container spawn: a `GROUP BY` over an unindexed 135 MB `text` column
 * against a 414 MB source, then a row-by-row rewrite of a projection as large
 * as 238 MB. That was the dominant cause of #315 — 327 stalls in one day, p50
 * 18.3 s, max 59.7 s, with 86% of them ending inside a container spawn.
 *
 * Only step 2 is load-bearing for the stall: it removes main-thread blocking
 * whether or not step 1 ever hits. Step 1 is what stops the fleet rewriting
 * tens of gigabytes of projections it already has.
 *
 * Mirrors `src/storage-maintenance-worker.ts`: one persistent worker, which
 * also serializes rebuilds so concurrent spawns cannot stampede the same
 * source file.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { onHostShutdown } from '../host-lifecycle.js';
import { log } from '../log.js';
import {
  archiveProjectionIsFresh,
  buildArchiveProjection,
  computeArchiveProjectionStamp,
  removeArchiveProjectionStamp,
  writeArchiveProjectionStamp,
} from './per-agent-projections.js';
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
  private readonly pending = new Map<number, { resolve(bytes: number): void; reject(error: Error): void }>();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly workerFactory: ArchiveProjectionWorkerFactory = createWorker) {}

  build(request: Omit<ArchiveProjectionRequest, 'id'>): Promise<number> {
    if (this.stopped) return Promise.reject(new WorkerUnavailableError('Archive projection worker is stopped'));
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)));
    }
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
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
      if (message.ok) pending.resolve(message.bytes ?? 0);
      else pending.reject(new Error(message.error ?? 'Archive projection build failed'));
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
 * Produce the session's archive projection, reusing the existing file when its
 * inputs have not moved and building off the main thread when they have.
 *
 * Fail-closed is unchanged from the synchronous original: a build that runs and
 * throws propagates, and the spawn aborts rather than mounting a projection
 * that looks valid and yields nothing.
 *
 * The one deliberate exception is the worker being unavailable — it failed to
 * start, crashed, or the host is shutting it down. That is an infrastructure
 * fault, not a bad projection, and refusing every spawn on it would take the
 * fleet down. Those cases fall back to building in process, which is correct
 * but blocking, and say so at WARN.
 */
export async function ensureArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): Promise<void> {
  const stamp = computeArchiveProjectionStamp(srcPath, agentGroupId, workgroupMemberIds);
  if (archiveProjectionIsFresh(dstPath, stamp)) {
    log.info('Archive projection reused', {
      agentGroupId,
      dstPath,
      bytes: statSizeOrZero(dstPath),
      scope: stamp.scope?.length ?? null,
    });
    return;
  }

  // Invalidate BEFORE building. A build can leave a non-empty partial file
  // behind — the schema is written before the first row — and an earlier stamp
  // that still matches the unchanged source would make the next spawn mount
  // that partial projection as fresh. Storage cleanup deleting the projection
  // and leaving the stamp is one way to get there.
  removeArchiveProjectionStamp(dstPath);

  const startedAt = Date.now();
  let bytes: number;
  let offThread = true;
  try {
    bytes = await sharedWorker.build({ srcPath, dstPath, agentGroupId, workgroupMemberIds });
  } catch (error) {
    if (!(error instanceof WorkerUnavailableError)) throw error;
    log.warn('Archive projection worker unavailable — building on the main thread', {
      agentGroupId,
      dstPath,
      err: error.message,
    });
    offThread = false;
    buildArchiveProjection(srcPath, dstPath, agentGroupId, workgroupMemberIds);
    bytes = statSizeOrZero(dstPath);
  }

  writeArchiveProjectionStamp(dstPath, stamp);
  log.info('Archive projection built', {
    agentGroupId,
    dstPath,
    ms: Date.now() - startedAt,
    bytes,
    offThread,
    scope: stamp.scope?.length ?? null,
  });
}

function statSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
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
