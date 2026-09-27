/**
 * CRUD for pending_sender_approvals — the in-flight state for the
 * request_approval unknown-sender flow. Rows are created when an unknown
 * sender writes into a wired messaging group with that policy, and are
 * deleted on admin approve (after adding the user as a member) or deny.
 *
 * UNIQUE(messaging_group_id, sender_identity) enforces in-flight dedup:
 * a retry / second message from the same unknown sender while a card is
 * still pending is silently dropped instead of spamming the admin.
 */
import { getDb } from '../../../db/connection.js';

export interface PendingSenderApproval {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  /** Original card body retained when the approval reaches a terminal state. */
  question: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
}

export async function createPendingSenderApproval(row: PendingSenderApproval): Promise<boolean> {
  const result = await getDb().run(
    `INSERT OR IGNORE INTO pending_sender_approvals (
         id, messaging_group_id, agent_group_id, sender_identity,
         sender_name, original_message, approver_user_id, created_at,
         title, question, options_json
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id, @sender_identity,
         @sender_name, @original_message, @approver_user_id, @created_at,
         @title, @question, @options_json
       )`,
    row,
  );
  return result.changes > 0;
}

export async function getPendingSenderApproval(id: string): Promise<PendingSenderApproval | undefined> {
  return getDb().get<PendingSenderApproval>('SELECT * FROM pending_sender_approvals WHERE id = ?', id);
}

export async function getInFlightSenderApproval(
  messagingGroupId: string,
  senderIdentity: string,
): Promise<PendingSenderApproval | undefined> {
  return getDb().get<PendingSenderApproval>(
    'SELECT * FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?',
    messagingGroupId,
    senderIdentity,
  );
}

/**
 * Delete the row, and say whether THIS caller is the one that deleted it.
 *
 * The boolean is the claim: two callbacks for one card can both find the row
 * live, and only the caller whose DELETE applied may replay the message.
 */
export async function deletePendingSenderApproval(id: string): Promise<boolean> {
  const info = await getDb().run('DELETE FROM pending_sender_approvals WHERE id = ?', id);
  return info.changes > 0;
}

// ── Decline stamps (decline_notify dedupe) ──
// The decline-and-notify flow persists "last declined at" per (messaging
// group, sender) by reusing this table's UNIQUE key — an id prefix
// distinguishes stamps from real card rows. Stamps never render a card and
// no click can resolve one: response handlers look a row up by exact id, and
// a stamp's id is not a `nsa-` id any card was ever delivered with. A policy
// flip in either direction collides on the UNIQUE key deliberately.

const DECLINE_STAMP_ID_PREFIX = 'decline:';

/**
 * A stamp records only THAT a sender was declined, never what they wrote.
 *
 * A declined sender has no replay path, so their message is not retained; the
 * sentinel satisfies NOT NULL and parses as "not the retained event".
 */
const DECLINE_STAMP_BODY = '{"declined":true}';

/** ISO timestamp of the last decline for this pair, if any. */
/**
 * Stamps and cards share the table and its UNIQUE key; a reader that does not
 * know which flow wrote a row has to ask.
 */
export function isDeclineStampId(id: string): boolean {
  return id.startsWith(DECLINE_STAMP_ID_PREFIX);
}

/**
 * Freshness check and stamp write as ONE statement, returning whether this
 * caller won.
 *
 * Read-then-write would let two overlapping declines both send; the conflict
 * clause applies the upsert only when the existing row is NOT a fresh stamp.
 * A stale stamp is refreshed and a card row converted; only a FRESH stamp blocks.
 */
export async function claimDeclineStamp(
  stamp: { messaging_group_id: string; agent_group_id: string; sender_identity: string },
  freshSince: string,
): Promise<boolean> {
  const info = await getDb().run(
    `INSERT INTO pending_sender_approvals (
         id, messaging_group_id, agent_group_id, sender_identity,
         sender_name, original_message, approver_user_id, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id, @sender_identity,
         NULL, @original_message, '', @created_at
       )
       ON CONFLICT(messaging_group_id, sender_identity) DO UPDATE SET
         id = excluded.id,
         created_at = excluded.created_at,
         sender_name = excluded.sender_name,
         original_message = excluded.original_message,
         approver_user_id = excluded.approver_user_id,
         title = excluded.title,
         question = excluded.question,
         options_json = excluded.options_json
       WHERE pending_sender_approvals.id NOT LIKE '${DECLINE_STAMP_ID_PREFIX}%'
          OR datetime(pending_sender_approvals.created_at) <= datetime(@freshSince)`,
    {
      id: `${DECLINE_STAMP_ID_PREFIX}${stamp.messaging_group_id}:${stamp.sender_identity}`,
      ...stamp,
      original_message: DECLINE_STAMP_BODY,
      created_at: new Date().toISOString(),
      freshSince,
    },
  );
  return info.changes > 0;
}

/** Remove any decline stamp for this pair — real card rows are untouched. */
export async function clearDeclineStamp(messagingGroupId: string, senderIdentity: string): Promise<void> {
  await getDb().run(
    `DELETE FROM pending_sender_approvals
        WHERE messaging_group_id = ? AND sender_identity = ? AND id LIKE '${DECLINE_STAMP_ID_PREFIX}%'`,
    messagingGroupId,
    senderIdentity,
  );
}
