/**
 * Worker-thread half of the archive projection build.
 *
 * `buildArchiveProjection` runs a `GROUP BY` over `messages_archive`'s
 * unindexed `text` column against a multi-hundred-megabyte `archive.db`, then
 * writes the result row by row through `better-sqlite3`. All of that is
 * synchronous, and it used to run on the host's main thread on every container
 * spawn — the dominant cause of the chronic event-loop stalls
 * (p50 18 s, ~20/hour). The work itself is unchanged; only the thread it runs
 * on is.
 *
 * The DECISION runs here too, not just the build: one request means
 * "make this projection current", and the reply says whether that took a reuse,
 * an append or a full rebuild. The decision needs `COUNT(*)`/`MAX(rowid)` over
 * the source, and a boot with ~800 sessions cannot afford to run that on the
 * host's own thread.
 *
 * The projection is self-contained IO: it reads one SQLite file and writes
 * another, sharing no state with the host. Nothing but the four request fields
 * crosses the boundary. Mirrors `src/storage-maintenance-worker-thread.ts`.
 */
import { parentPort } from 'node:worker_threads';

import { materializeArchiveProjection } from './per-agent-projections.js';
import type { ArchiveProjectionMode } from './per-agent-projections.js';

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
  mode?: ArchiveProjectionMode;
  rows?: number;
  merged?: number;
  bytes?: number;
  ms?: number;
  sinceRowid?: number | null;
  /** 'seeded' only: the sibling projection this session was copied from. */
  seededFrom?: string | null;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error('Archive projection worker requires a parent port');

port.on('message', (message: ArchiveProjectionRequest) => {
  try {
    const result = materializeArchiveProjection(
      message.srcPath,
      message.dstPath,
      message.agentGroupId,
      message.workgroupMemberIds,
    );
    port.postMessage({
      id: message.id,
      ok: true,
      mode: result.mode,
      rows: result.rows,
      merged: result.merged,
      bytes: result.bytes,
      ms: result.ms,
      sinceRowid: result.sinceRowid,
      seededFrom: result.seededFrom,
    } satisfies ArchiveProjectionResponse);
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ArchiveProjectionResponse);
  }
});
