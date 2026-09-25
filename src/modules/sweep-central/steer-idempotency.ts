import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/**
 * Prune steer_idempotency rows: applied rows older than 60s, pending rows
 * older than 5min.
 */
export async function pruneSteerIdempotency(): Promise<void> {
  try {
    const db = getDb();
    // Delete applied rows older than 60 seconds
    await db.run(
      `DELETE FROM steer_idempotency WHERE status = 'applied' AND datetime(applied_at) < datetime('now', '-60 seconds')`,
    );
    // Delete pending rows older than 5 minutes (crash-recovery window expires)
    await db.run(
      `DELETE FROM steer_idempotency WHERE status = 'pending' AND datetime(reserved_at) < datetime('now', '-300 seconds')`,
    );
  } catch (err) {
    log.warn('pruneSteerIdempotency: failed', { err });
  }
}
