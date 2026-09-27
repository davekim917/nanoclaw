/**
 * Failed tasks are excluded so they stay visible until an operator dismisses
 * them. No per-row SSE emit: a whole day of cards at once would flood the bus.
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
