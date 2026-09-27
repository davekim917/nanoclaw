import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/**
 * Prune steer_idempotency rows: applied rows older than 60s, pending rows
 * older than 5min.
 */
export async function pruneSteerIdempotency(): Promise<void> {
  try {
    const db = getDb();
    await db.run(
      `DELETE FROM steer_idempotency WHERE status = 'applied' AND datetime(applied_at) < datetime('now', '-60 seconds')`,
    );
    // Pending rows past 5 minutes: the crash-recovery window has expired.
    await db.run(
      `DELETE FROM steer_idempotency WHERE status = 'pending' AND datetime(reserved_at) < datetime('now', '-300 seconds')`,
    );
  } catch (err) {
    log.warn('pruneSteerIdempotency: failed', { err });
  }
}
