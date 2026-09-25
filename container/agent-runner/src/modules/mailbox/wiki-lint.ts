/**
 * Weekly wiki-lint gate reads (scheduling/wiki-lint-gate.ts).
 *
 * The gate runs as its own short-lived Bun process inside the container (a
 * pre-task script), alongside the agent-runner process that owns outbound.db
 * as sole writer. Both handles are therefore opened READ-ONLY and closed
 * immediately — never the module's read-write outbound singleton, which would
 * put a second writer on the file and run the outbound schema warm-up from a
 * process that has no business doing it.
 */
import { Database } from 'bun:sqlite';

import { getOutboundDb, openInboundDb } from '../../mailbox/sqlite/connection.js';
import { OUTBOUND_DB_PATH } from './schema.js';
import { isMailboxTestMode } from './test-mode.js';

interface TaskIdRow {
  id: string;
}

interface CompletedAckRow {
  status_changed: string;
}

/** Read-only outbound handle; the in-memory pair under initTestSessionDb(). */
function withOutboundReader<T>(action: (db: Database) => T): T {
  if (isMailboxTestMode()) return action(getOutboundDb());
  const db = new Database(OUTBOUND_DB_PATH, { readonly: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/**
 * The `status_changed` of the newest completed run of a task series, or null
 * when the series has never completed.
 *
 * Completion truth comes from outbound `processing_ack`. The host eventually
 * mirrors this status into inbound.db, but the container owns processing_ack
 * and updates it immediately after the lint finishes. Using status_changed
 * means edits made by that lint predate its boundary and cannot retrigger it
 * next week.
 */
export function readSeriesLastCompletedRun(seriesId: string): string | null {
  const inbound = openInboundDb();
  try {
    const taskIds = inbound
      .prepare("SELECT id FROM messages_in WHERE kind = 'task' AND series_id = ?")
      .all(seriesId) as TaskIdRow[];

    return withOutboundReader((outbound) => {
      const completedAck = outbound.prepare(
        "SELECT status_changed FROM processing_ack WHERE message_id = ? AND status = 'completed'",
      );
      let latestTimestamp: string | null = null;
      let latestMs = Number.NEGATIVE_INFINITY;
      for (const { id } of taskIds) {
        const row = completedAck.get(id) as CompletedAckRow | null;
        if (!row) continue;

        const changedMs = Date.parse(row.status_changed);
        if (Number.isNaN(changedMs)) throw new Error(`invalid lint completion timestamp: ${row.status_changed}`);
        if (changedMs > latestMs) {
          latestMs = changedMs;
          latestTimestamp = row.status_changed;
        }
      }
      return latestTimestamp;
    });
  } finally {
    inbound.close();
  }
}
