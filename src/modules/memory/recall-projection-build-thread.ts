/**
 * Worker-thread entrypoint for a full recall-projection build
 * (docs/specs/workgroup-cerebro/plan.md §P2.5.6 step 3), mirroring the one-shot
 * shape of `graphify-daemon/isolated-source-reconcile-thread.ts`.
 *
 * `better-sqlite3` is synchronous and has no async escape hatch, so an ~8 s
 * rebuild (§P2.5.1) run in-process would stall routing, delivery and the sweep
 * for every session on the host. It must not be possible to call the build on
 * the caller's event loop by accident, which is why the build is reached
 * through `runProjectionBuild` and not exported as a host-side convenience.
 *
 * A second, quieter reason this thread matters: the build calls
 * `tokenizeForRecall`/`passageWindows`, which populate the process-wide
 * `TOKEN_STREAM_CACHE`. A worker gets its own module instance, so a rebuild
 * cannot evict the host's warm per-turn cache.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { buildAndPromoteProjection } from './recall-projection.js';

const port = parentPort;
if (!port) throw new Error('Recall projection build requires a parent port');
const options = workerData as { root: string; directory: string };

try {
  port.postMessage({ ok: true, result: buildAndPromoteProjection(options) });
} catch (error) {
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
