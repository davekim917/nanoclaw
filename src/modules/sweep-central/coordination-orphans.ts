import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

const COORDINATION_TABLES = ['delivery_attempts', 'session_claims', 'wake_signals'] as const;

type CoordinationOrphanCounts = Record<(typeof COORDINATION_TABLES)[number], number>;

/**
 * Drop coordination rows whose session no longer exists. A write that lands
 * after teardown's delete (e.g. a late delivery failure upserting
 * `delivery_attempts`) recreates the row, and no foreign key removes it.
 * Never throws: a failure is a WARN and the next tick retries.
 */
export async function sweepCoordinationOrphans(): Promise<void> {
  try {
    const db = getDb();
    const counts = {} as CoordinationOrphanCounts;
    for (const table of COORDINATION_TABLES) {
      const result = await db.run(`DELETE FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`);
      counts[table] = result.changes;
    }
    if (COORDINATION_TABLES.some((table) => counts[table] > 0)) {
      log.info('Coordination orphans swept', counts);
    }
  } catch (err) {
    log.warn('Coordination orphan sweep failed', { err });
  }
}
