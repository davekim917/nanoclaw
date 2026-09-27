/**
 * Host-written receipts for resolved choice cards (migration 077); this module is the sole writer. Written after the
 * answer is delivered and before the `pending_approvals` row is deleted, so a write failure must never unwind the
 * delivery: callers catch and log. `recordChoiceReceipt` itself throws on a DB error so that stays distinguishable
 * from a losing click.
 */
import { getDb } from './connection.js';

export interface ChoiceReceipt {
  /** Host-minted `pending_approvals.approval_id` (`appr-…`); the primary key. */
  approvalId: string;
  /**
   * The card's agent-chosen `choice-…` id, NOT unique: an agent can reuse one across cards, so it is indexed but
   * never the key.
   */
  requestId: string;
  action: string;
  agentGroupId: string | null;
  /** The session the answer was actually delivered to. */
  sessionId: string;
  platformId: string | null;
  threadId: string | null;
  platformMessageId: string | null;
  value: string;
  label: string;
  /** Namespaced (`<channel>:<handle>`). */
  clickerUserId: string;
  /** NULL for every generic choice. */
  releaseScopeJson: string | null;
  resolvedAt: string;
}

/**
 * Plain `INSERT`: exactly one click wins per approval (the compare-and-swap in `transitionPendingApprovalStatus`), so
 * a PK conflict is a genuine error and throws. A reused `request_id` is not a conflict: it inserts its own row.
 */
export async function recordChoiceReceipt(receipt: ChoiceReceipt): Promise<void> {
  await getDb().run(
    `INSERT INTO choice_receipts
       (approval_id, request_id, action, agent_group_id, session_id,
        platform_id, thread_id, platform_message_id, value, label, clicker_user_id, release_scope_json, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receipt.approvalId,
    receipt.requestId,
    receipt.action,
    receipt.agentGroupId,
    receipt.sessionId,
    receipt.platformId,
    receipt.threadId,
    receipt.platformMessageId,
    receipt.value,
    receipt.label,
    receipt.clickerUserId,
    receipt.releaseScopeJson,
    receipt.resolvedAt,
  );
}

export interface ChoiceReceiptRow {
  approval_id: string;
  request_id: string;
  action: string;
  agent_group_id: string | null;
  session_id: string;
  platform_id: string | null;
  thread_id: string | null;
  platform_message_id: string | null;
  value: string;
  label: string;
  clicker_user_id: string;
  release_scope_json: string | null;
  resolved_at: string;
}

export async function getChoiceReceipt(approvalId: string): Promise<ChoiceReceiptRow | undefined> {
  return getDb().get<ChoiceReceiptRow>('SELECT * FROM choice_receipts WHERE approval_id = ?', approvalId);
}

/**
 * Plural: two cards can share a choiceId when the first resolved before the second was created (a live collision is
 * refused up front in src/modules/interactive/choice.ts).
 */
export async function getChoiceReceiptsByRequestId(requestId: string): Promise<ChoiceReceiptRow[]> {
  return getDb().all<ChoiceReceiptRow>(
    'SELECT * FROM choice_receipts WHERE request_id = ? ORDER BY resolved_at',
    requestId,
  );
}
