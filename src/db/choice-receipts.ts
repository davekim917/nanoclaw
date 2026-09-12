/**
 * Durable, host-written receipts for resolved choice cards (migration 077).
 *
 * See migration 077 for the WHY. This module is the sole writer: one row per
 * resolved card, written from `resolveChoice`
 * (src/modules/approvals/choices.ts) after the answer has been delivered and
 * before the backing `pending_approvals` row is deleted. A write failure here
 * must never unwind that delivery — callers catch and log, never propagate,
 * on the write path; `recordChoiceReceipt` itself throws on a genuine DB
 * error so a test (or a future caller) can observe that distinctly from "a
 * losing click wrote nothing".
 */
import { getDb } from './connection.js';

export interface ChoiceReceipt {
  /** The internal, host-minted `pending_approvals.approval_id` (`appr-…`). Primary key. */
  approvalId: string;
  /**
   * The card's own `choice-…` id (`pending_approvals.request_id`) — agent-chosen,
   * NOT unique. Indexed, not the key: an agent can reuse a choiceId across two
   * different cards (migration 077 explains why that must not collapse two
   * receipts into one).
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
  /** Namespaced user id (`<channel>:<handle>`) of the authorized clicker. */
  clickerUserId: string;
  /** ISO-8601 UTC timestamp of resolution. */
  resolvedAt: string;
}

/**
 * Record one resolved choice. Plain `INSERT`, no `ON CONFLICT`: a conflict on
 * the host-minted `approval_id` PK must never happen (the pending→approved
 * compare-and-swap in `transitionPendingApprovalStatus` lets exactly one
 * click win per approval, src/db/sessions.ts, and approval ids don't repeat)
 * — so a genuine conflict throws, same as any other DB error, into the
 * logged catch at the one call site (choices.ts writeChoiceReceipt). A
 * reused `request_id` (agent-chosen `choiceId`) is NOT a conflict here: it
 * inserts its own row, keyed by its own approval_id — see migration 077.
 */
export async function recordChoiceReceipt(receipt: ChoiceReceipt): Promise<void> {
  await getDb().run(
    `INSERT INTO choice_receipts
       (approval_id, request_id, action, agent_group_id, session_id,
        platform_id, thread_id, platform_message_id, value, label, clicker_user_id, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    receipt.resolvedAt,
  );
}

/** Raw row shape (DB column names), for reads — tests and any future consumer. */
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
  resolved_at: string;
}

/** Look up a receipt by the host-minted approval id (the table's PK). */
export async function getChoiceReceipt(approvalId: string): Promise<ChoiceReceiptRow | undefined> {
  return getDb().get<ChoiceReceiptRow>('SELECT * FROM choice_receipts WHERE approval_id = ?', approvalId);
}

/**
 * Every receipt sharing an agent-chosen `request_id` (choiceId) — plural,
 * because `request_id` is indexed but not unique (migration 077): two cards
 * can legitimately share a choiceId if the first resolved before the second
 * was created (the live-collision case is refused up front instead, see
 * src/modules/interactive/choice.ts).
 */
export async function getChoiceReceiptsByRequestId(requestId: string): Promise<ChoiceReceiptRow[]> {
  return getDb().all<ChoiceReceiptRow>(
    'SELECT * FROM choice_receipts WHERE request_id = ? ORDER BY resolved_at',
    requestId,
  );
}
