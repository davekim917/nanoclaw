/**
 * T14 completed-task-auto-archive duty body (seam 2, S2-PR5) — moved out of
 * src/host-sweep.ts unchanged. Kept in its own file, sibling to index.ts, so
 * the acceptance-case suite (orchestrator.test.ts) can import it directly
 * without pulling in host-sweep.ts's whole registry import graph.
 *
 * Auto-archive completed tasks older than 24h. Failed tasks are excluded
 * deliberately — operator must dismiss them explicitly so they stay
 * visible until acknowledged. No per-row SSE emit: the volume is "every
 * `done` card from yesterday at once," which would flood the bus; the
 * next dashboard list refresh picks the change up naturally.
 */
import { log } from '../../log.js';
import { autoArchiveCompletedBefore } from '../orchestrator-dispatch/db/tasks.js';

const COMPLETED_AUTO_ARCHIVE_AGE_HOURS = 24;

export async function autoArchiveOldCompleted(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - COMPLETED_AUTO_ARCHIVE_AGE_HOURS * 60 * 60 * 1000).toISOString();
    const count = await autoArchiveCompletedBefore(cutoff);
    if (count > 0) log.info('Auto-archived completed tasks', { count });
  } catch (err) {
    log.warn('autoArchiveOldCompleted: failed', { err });
  }
}
