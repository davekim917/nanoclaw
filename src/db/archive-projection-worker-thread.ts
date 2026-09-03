/**
 * Worker-thread half of the archive projection build.
 *
 * `buildArchiveProjection` runs a `GROUP BY` over `messages_archive`'s
 * unindexed `text` column against a multi-hundred-megabyte `archive.db`, then
 * writes the result row by row through `better-sqlite3`. All of that is
 * synchronous, and it used to run on the host's main thread on every container
 * spawn — the dominant cause of the chronic event-loop stalls in #315
 * (p50 18 s, ~20/hour). The work itself is unchanged; only the thread it runs
 * on is.
 *
 * The projection is self-contained IO: it reads one SQLite file and writes
 * another, sharing no state with the host. Nothing but the four request fields
 * crosses the boundary. Mirrors `src/storage-maintenance-worker-thread.ts`.
 */
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';

import { buildArchiveProjection } from './per-agent-projections.js';

export interface ArchiveProjectionRequest {
  id: number;
  srcPath: string;
  dstPath: string;
  agentGroupId: string;
  workgroupMemberIds?: string[];
}

export interface ArchiveProjectionResponse {
  id: number;
  ok: boolean;
  bytes?: number;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error('Archive projection worker requires a parent port');

port.on('message', (message: ArchiveProjectionRequest) => {
  try {
    buildArchiveProjection(message.srcPath, message.dstPath, message.agentGroupId, message.workgroupMemberIds);
    let bytes = 0;
    try {
      bytes = fs.statSync(message.dstPath).size;
    } catch {
      bytes = 0;
    }
    port.postMessage({ id: message.id, ok: true, bytes } satisfies ArchiveProjectionResponse);
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ArchiveProjectionResponse);
  }
});
