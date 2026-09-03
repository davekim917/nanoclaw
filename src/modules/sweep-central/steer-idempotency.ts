import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/**
 * Prune steer_idempotency rows: applied rows older than 60s, pending rows
 * older than 5min.
 *
 * Moved unchanged from src/host-sweep.ts (seam 2, S2-PR4 — central
 * housekeeping). Same statements, same log strings, same thresholds.
 */
export function pruneSteerIdempotency(): void {
  try {
    const db = getDb();
    // Delete applied rows older than 60 seconds
    db.prepare(
      `DELETE FROM steer_idempotency WHERE status = 'applied' AND datetime(applied_at) < datetime('now', '-60 seconds')`,
    ).run();
    // Delete pending rows older than 5 minutes (crash-recovery window expires)
    db.prepare(
      `DELETE FROM steer_idempotency WHERE status = 'pending' AND datetime(reserved_at) < datetime('now', '-300 seconds')`,
    ).run();
  } catch (err) {
    log.warn('pruneSteerIdempotency: failed', { err });
  }
}
