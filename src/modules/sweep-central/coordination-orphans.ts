import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

/** The coordination tables keyed by `session_id`, in delete order. */
const COORDINATION_TABLES = ['delivery_attempts', 'session_claims', 'wake_signals'] as const;

export type CoordinationOrphanCounts = Record<(typeof COORDINATION_TABLES)[number], number>;

/**
 * Drop coordination rows whose session no longer exists (issue #430).
 *
 * Teardown removes a session's coordination rows, but a write that lands after
 * the delete wins the race: a delivery still awaiting an adapter when its group
 * is deleted upserts a fresh `delivery_attempts` row on its next failure, and
 * `session_claims` gains the same shape once the spawn path claims before it
 * spawns. Migration 071 declares no foreign key, so nothing else removes them.
 *
 * The two closing shapes that would prevent the row instead of sweeping it —
 * a cascading foreign key (a fork-side table rebuild) or a conditional insert
 * inside `recordDeliveryAttempt` — both land on surfaces this seam keeps
 * byte-identical to upstream. This duty is the fork-side answer: order-free
 * housekeeping over rows that are inert by the time it runs, which is also the
 * regression detector for the plan's "`delivery_attempts` ≈ 0 a few minutes
 * after boot" evidence row (plan §6).
 *
 * Never throws — a failed sweep is a WARN and the next tick retries. Silent
 * when there was nothing to sweep, which is the steady state.
 */
export async function sweepCoordinationOrphans(): Promise<void> {
  try {
    const db = getDb();
    const counts = {} as CoordinationOrphanCounts;
    for (const table of COORDINATION_TABLES) {
      // One statement per table, not a join: the sub-select is the whole
      // predicate, and `session_id` is indexed on the two tables that carry an
      // index at all.
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
