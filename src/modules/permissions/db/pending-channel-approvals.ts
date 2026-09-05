/**
 * CRUD for pending_channel_approvals — the in-flight state for the
 * unknown-channel registration flow. A row exists while an owner-approval
 * card is outstanding; it's deleted on approve (after wiring is created)
 * or deny (after denied_at is set on the messaging_group).
 *
 * PRIMARY KEY on messaging_group_id gives free in-flight dedup. A second
 * mention/DM while a card is pending resolves via
 * `hasInFlightChannelApproval` in the request flow and drops silently
 * instead of spamming the owner.
 */
import { getDb, getRawDb } from '../../../db/connection.js';

export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  question: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
}

export async function createPendingChannelApproval(row: PendingChannelApproval): Promise<boolean> {
  const result = await getDb().run(
    `INSERT OR IGNORE INTO pending_channel_approvals (
         messaging_group_id, agent_group_id, original_message,
         approver_user_id, created_at, title, question, options_json
       )
       VALUES (
         @messaging_group_id, @agent_group_id, @original_message,
         @approver_user_id, @created_at, @title, @question, @options_json
       )`,
    row,
  );
  return result.changes > 0;
}

/** The row the `channels.register` guard reads. */
export const PENDING_CHANNEL_APPROVAL_BY_GROUP_SQL =
  'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?';

/**
 * Synchronous by design (seam-3 plan §4.5, I-1): the `channels.register` guard
 * in `../guard.ts` reads this row inside its `decide` body, which never awaits.
 * Same rule as §4.2's transaction-reachable leaf exports — not a `*Sync` twin
 * (there is one form, not two), simply not yet converted. PR 6 moves it inside
 * `withCentralSync`/`withRawDb`.
 */
export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined {
  return getRawDb().prepare(PENDING_CHANNEL_APPROVAL_BY_GROUP_SQL).get(messagingGroupId) as
    | PendingChannelApproval
    | undefined;
}

export async function hasInFlightChannelApproval(messagingGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ x: number }>(
    'SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = ?',
    messagingGroupId,
  );
  return row !== undefined;
}

export async function updatePendingChannelApprovalCard(
  messagingGroupId: string,
  title: string,
  question: string,
  optionsJson: string,
): Promise<void> {
  await getDb().run(
    'UPDATE pending_channel_approvals SET title = ?, question = ?, options_json = ? WHERE messaging_group_id = ?',
    title,
    question,
    optionsJson,
    messagingGroupId,
  );
}

export async function deletePendingChannelApproval(messagingGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?', messagingGroupId);
}
