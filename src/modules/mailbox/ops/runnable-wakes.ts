/**
 * What a stopped session will be woken for, read without changing anything. Not a second opinion: each exclusion is
 * the read half of the op that performs it — the ack sync, stale-row expiry, the stale-claim cleanup, due admission — so a row is here
 * exactly when those leave it for a runner. The runner's own filter (any acknowledged row is skipped) lives in the
 * container package and cannot be imported; these are the host ops that settle the same acknowledgments.
 */
import type Database from 'better-sqlite3';

import { getProcessingClaims } from '../../../mailbox/sqlite/session-db.js';
import { migrateMessagesInTable } from '../schema.js';
import { ADMISSIBLE } from './admission.js';
import { staleClaimFate } from './recovery.js';
import { DUE_NOW, listAnsweredPendingRows, readTerminalAcks, STALE_PENDING, stalePendingCutoff } from './sweep.js';

export interface RunnableWake {
  id: string;
  /** Null when a wake would run it now; else the future instant it comes due. */
  at: string | null;
  /** False while it still waits for due admission to make it a trigger. */
  admitted: boolean;
}

/** `outDb` is null when no container ever ran, so nothing was acknowledged or claimed. */
export function listRunnableWakes(inDb: Database.Database, outDb: Database.Database | null): RunnableWake[] {
  migrateMessagesInTable(inDb);
  const rows = inDb
    .prepare(
      `SELECT id, process_after AS processAfter, trigger, ${DUE_NOW} AS due
         FROM messages_in
        WHERE status = 'pending'
          AND repo_fence_epoch IS NULL
          AND (trigger = 1 OR (${ADMISSIBLE}))
          AND NOT (${STALE_PENDING})
        ORDER BY seq`,
    )
    .all({ cutoff: stalePendingCutoff() }) as Array<{
    id: string;
    processAfter: string | null;
    trigger: number;
    due: number;
  }>;
  const settled = new Set<string>();
  if (outDb) {
    for (const { message_id } of readTerminalAcks(outDb)) settled.add(message_id);
    for (const id of listAnsweredPendingRows(inDb, outDb)) settled.add(id);
    const now = Date.now();
    for (const { message_id } of getProcessingClaims(outDb)) {
      const { fate } = staleClaimFate(inDb, outDb, message_id, now);
      if (fate === 'answered' || fate === 'exhausted') settled.add(message_id);
    }
  }
  return rows
    .filter((row) => !settled.has(row.id))
    .map((row) => ({ id: row.id, at: row.due ? null : row.processAfter, admitted: row.trigger === 1 }));
}
