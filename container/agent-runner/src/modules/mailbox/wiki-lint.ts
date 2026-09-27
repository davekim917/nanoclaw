/** Wiki-lint gate reads from a separate pre-task process: open READ-ONLY and close, never the read-write outbound singleton (a second writer). */
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

/** Newest completed run's `status_changed` from outbound processing_ack (updated immediately, unlike the host's mirror), so the lint's own edits can't retrigger it. */
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
