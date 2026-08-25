/**
 * Host-side wrapper that runs a recall-projection build off the event loop
 * (docs/specs/workgroup-cerebro/plan.md §P2.5.6 steps 2-3, decisions 7 and 12).
 *
 * Shape follows `graphify-daemon/isolated-source-reconcile.ts`: one worker per
 * build, settle once, terminate on every exit path. The build itself owns the
 * promote protocol — this file only gets it onto another thread and back.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { projectionDir, type ProjectionBuildResult } from './recall-projection.js';

export interface ProjectionBuildOptions {
  /** Canonical workgroup memory tree (`workgroupMemoryDir`). */
  root: string;
  /** Directory that owns `index.db`; defaults to the workgroup's projection dir. */
  directory: string;
  signal?: AbortSignal;
}

function createWorker(workerData: { root: string; directory: string }): Worker {
  // Node does not apply the parent's `--import tsx` hooks to a file-backed
  // Worker, so a `.ts` entrypoint has to register tsx itself inside an eval
  // bootstrap. Same trick, same reason as `storage-maintenance-worker.ts`.
  const runningTypeScript = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(
    runningTypeScript ? './recall-projection-build-thread.ts' : './recall-projection-build-thread.js',
    import.meta.url,
  );
  if (runningTypeScript) {
    const entryPath = fileURLToPath(workerUrl);
    const parentPath = fileURLToPath(import.meta.url);
    const bootstrap = `const { require: tsxRequire } = require('tsx/cjs/api'); tsxRequire(${JSON.stringify(entryPath)}, ${JSON.stringify(parentPath)});`;
    return new Worker(bootstrap, { eval: true, workerData, execArgv: [] });
  }
  // Never inherit parent-only flags such as `--input-type=module`; Node rejects
  // those for a file-URL Worker entrypoint.
  return new Worker(workerUrl, { workerData, execArgv: [] });
}

export function workgroupProjectionBuildOptions(
  workgroupId: string,
  root: string,
  dataDir: string,
): ProjectionBuildOptions {
  return { root, directory: projectionDir(workgroupId, dataDir) };
}

export async function runProjectionBuild(options: ProjectionBuildOptions): Promise<ProjectionBuildResult> {
  const workerData = { root: path.resolve(options.root), directory: path.resolve(options.directory) };
  const worker = createWorker(workerData);
  return await new Promise<ProjectionBuildResult>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      operation();
      void worker.terminate();
    };
    const onAbort = (): void => finish(() => reject(new Error('recall projection build aborted')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.once('message', (message: { ok: boolean; result?: ProjectionBuildResult; error?: string }) => {
      if (message.ok && message.result) finish(() => resolve(message.result!));
      else finish(() => reject(new Error(message.error ?? 'recall projection build failed')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`recall projection build exited ${code}`)));
    });
  });
}
