/** Operator-only receipt reconciliation. Explicit DB path; no config or credentials read. */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonicalWorkItem } from '../src/outcome-reporting-schema.js';

export function reconcileOutcome(
  db: Database.Database,
  input: {
    action: 'confirm-delivered' | 'confirm-not-sent' | 'rekey';
    workgroup: string;
    workItem: string;
    expectedUpdatedAt: string;
    value?: string;
    reason: string;
  },
): void {
  if (!input.reason.trim()) throw new Error('A reconciliation reason and external evidence are required');
  const key = canonicalWorkItem(input.workItem);
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM work_outcome_receipts WHERE workgroup_id=? AND work_item=?')
      .get(input.workgroup, key) as { state: string; updated_at: string } | undefined;
    if (!row || row.updated_at !== input.expectedUpdatedAt)
      throw new Error('Receipt changed; inspect it again before reconciling');
    const note = JSON.stringify({ at: timestamp, action: input.action, reason: input.reason }) + '\n';
    if (input.action === 'rekey') {
      if (row.state !== 'delivered') throw new Error('Resolve unknown delivery before correcting a work-item identity');
      const replacement = canonicalWorkItem(input.value);
      db.prepare(
        `UPDATE work_outcome_receipts SET work_item=?,updated_at=?,resolution=COALESCE(resolution,'')||?
        WHERE workgroup_id=? AND work_item=?`,
      ).run(replacement, timestamp, note, input.workgroup, key);
    } else {
      if (!['sending', 'uncertain'].includes(row.state)) throw new Error('Only unresolved delivery can be reconciled');
      if (input.action === 'confirm-delivered' && !input.value?.trim())
        throw new Error('Confirmed platform message ID is required');
      db.prepare(
        `UPDATE work_outcome_receipts SET state=?,platform_message_id=?,updated_at=?,resolution=COALESCE(resolution,'')||?
        WHERE workgroup_id=? AND work_item=?`,
      ).run(
        input.action === 'confirm-delivered' ? 'delivered' : 'retry',
        input.action === 'confirm-delivered' ? input.value : null,
        timestamp,
        note,
        input.workgroup,
        key,
      );
    }
  })();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [action, dbPath, workgroup, workItem, expectedUpdatedAt, value, reason] = process.argv.slice(2);
  if (!dbPath || !['list', 'confirm-delivered', 'confirm-not-sent', 'rekey'].includes(action))
    throw new Error('Usage: outcome-receipts.ts list DB | ACTION DB WORKGROUP URL EXPECTED_UPDATED_AT VALUE REASON');
  const db = new Database(dbPath, { readonly: action === 'list', fileMustExist: true });
  try {
    if (action === 'list')
      console.log(
        JSON.stringify(db.prepare('SELECT * FROM work_outcome_receipts ORDER BY updated_at DESC').all(), null, 2),
      );
    else
      reconcileOutcome(db, {
        action: action as 'confirm-delivered' | 'confirm-not-sent' | 'rekey',
        workgroup,
        workItem,
        expectedUpdatedAt,
        value,
        reason: reason ?? '',
      });
  } finally {
    db.close();
  }
}
