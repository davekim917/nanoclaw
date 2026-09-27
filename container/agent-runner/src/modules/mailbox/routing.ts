/** Fork-only session_routing reads: the spawned-session identity written by the host's applySpawnTask. */
import { getInboundDb } from '../../mailbox/sqlite/connection.js';

/** The spawn task_id when this is an orchestrator's child session; null otherwise, including legacy DBs without the column. */
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

/** This session's id, or null (not written yet, non-spawned, or legacy); callers degrade gracefully. */
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
