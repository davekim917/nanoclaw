/**
 * Worker-thread half of the archive projection build. The build and the reuse/append/rebuild decision are synchronous
 * `better-sqlite3` work over a multi-hundred-megabyte source (the decision needs `COUNT(*)`/`MAX(rowid)`), too heavy
 * for the host's main thread. Self-contained IO: only the request fields cross the boundary. Mirrors
 * `src/storage-maintenance-worker-thread.ts`.
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
