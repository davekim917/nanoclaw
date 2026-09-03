/**
 * Fork-only session_routing reads. `getSessionRouting`/`getTaskSeriesId` are
 * upstream's (db/session-routing.ts); the two columns below are the fork's
 * spawned-session identity, written by the host's applySpawnTask.
 */
import { getInboundDb } from '../../mailbox/sqlite/connection.js';

/**
 * Returns the spawn task_id for this session if it is a child of an
 * orchestrator's spawn, or null if it is a plain (non-spawned) session.
 *
 * Reads `spawn_task_id` from inbound.db's `session_routing` table.
 * The host writes this column via applySpawnTask when launching a child
 * session for a spawned task.
 *
 * Returns null when:
 * - No session_routing row exists (before first host wake)
 * - The column value is NULL (non-spawned session)
 * - The column doesn't exist (legacy session DB pre-migration)
 */
export function getSessionSpawnTaskId(): string | null {
  const db = getInboundDb();
  try {
    const row = db.prepare('SELECT spawn_task_id FROM session_routing WHERE id = 1').get() as
      | { spawn_task_id: string | null }
      | undefined;
    return row?.spawn_task_id ?? null;
  } catch {
    // Column may not exist on a legacy session DB — return null gracefully
    return null;
  }
}

/**
 * Returns this session's own ID, or null if the host hasn't written it yet
 * or the session_routing table doesn't have a session_id column (legacy).
 *
 * The host writes `session_id` into session_routing when writing the
 * spawn_task_id (applySpawnTask). Non-spawned sessions and legacy sessions
 * return null; callers degrade gracefully (e.g., list_spawned_tasks returns
 * an empty list when session_id is null).
 */
export function getSessionId(): string | null {
  const db = getInboundDb();
  try {
    const row = db.prepare('SELECT session_id FROM session_routing WHERE id = 1').get() as
      | { session_id: string | null }
      | undefined;
    return row?.session_id ?? null;
  } catch {
    // Column may not exist on a legacy session DB — return null gracefully
    return null;
  }
}
