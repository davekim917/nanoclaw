import { getDb } from './connection.js';

export interface WorkOutcomeReceipt {
  workgroup_id: string;
  work_item: string;
  message_id: string;
  session_id: string;
  state: 'sending' | 'delivered' | 'uncertain' | 'retry';
  platform_message_id: string | null;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  resolution: string | null;
}

/** Call only after delivery's ordinary destination authorization has succeeded. */
export async function claimWorkOutcome(
  input: Omit<WorkOutcomeReceipt, 'state' | 'platform_message_id' | 'created_at' | 'updated_at' | 'resolution'>,
): Promise<{
  claimed: boolean;
  receipt: WorkOutcomeReceipt;
}> {
  const now = new Date().toISOString();
  const db = getDb();
  const inserted = await db.run(
    `INSERT INTO work_outcome_receipts
    (workgroup_id,work_item,message_id,session_id,state,channel_type,platform_id,thread_id,content,created_at,updated_at)
    VALUES (?,?,?,?,'sending',?,?,?,?,?,?) ON CONFLICT(workgroup_id,work_item) DO NOTHING`,
    input.workgroup_id,
    input.work_item,
    input.message_id,
    input.session_id,
    input.channel_type,
    input.platform_id,
    input.thread_id,
    input.content,
    now,
    now,
  );
  let claimed = inserted.changes > 0;
  // Only the original queued row retries after an operator verifies non-delivery.
  if (!claimed) {
    const retry = await db.run(
      `UPDATE work_outcome_receipts SET state='sending',updated_at=?
      WHERE workgroup_id=? AND work_item=? AND message_id=? AND state='retry'`,
      now,
      input.workgroup_id,
      input.work_item,
      input.message_id,
    );
    claimed = retry.changes > 0;
  }
  const receipt = await db.get<WorkOutcomeReceipt>(
    'SELECT * FROM work_outcome_receipts WHERE workgroup_id=? AND work_item=?',
    input.workgroup_id,
    input.work_item,
  );
  if (!receipt) throw new Error('Outcome receipt disappeared during claim');
  return { claimed, receipt };
}

export async function settleWorkOutcome(
  workgroup: string,
  key: string,
  platformMessageId: string | undefined,
  failure?: string,
): Promise<void> {
  await getDb().run(
    `UPDATE work_outcome_receipts SET state=?,platform_message_id=?,updated_at=?,resolution=CASE WHEN ? IS NULL THEN resolution ELSE COALESCE(resolution, '') || ? END
    WHERE workgroup_id=? AND work_item=?`,
    failure !== undefined ? 'uncertain' : 'delivered',
    platformMessageId ?? null,
    new Date().toISOString(),
    failure ?? null,
    failure === undefined
      ? null
      : JSON.stringify({ at: new Date().toISOString(), action: 'adapter-failure', error: failure }) + '\n',
    workgroup,
    key,
  );
}
