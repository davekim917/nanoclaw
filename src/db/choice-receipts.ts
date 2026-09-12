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
  /** The card's own `choice-…` id (`pending_approvals.request_id`). Primary key. */
  requestId: string;
  /** The internal `pending_approvals.approval_id` (`appr-…`) that carried it. */
  approvalId: string;
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
 * Record one resolved choice. `ON CONFLICT DO NOTHING`: defense in depth —
 * `request_id` only ever reaches this call once, because the pending→approved
 * compare-and-swap in `transitionPendingApprovalStatus` lets exactly one
 * click win per card (src/db/sessions.ts) — not a case this table expects to
 * hit in practice.
 */
export async function recordChoiceReceipt(receipt: ChoiceReceipt): Promise<void> {
  await getDb().run(
    `INSERT INTO choice_receipts
       (request_id, approval_id, action, agent_group_id, session_id,
        platform_id, thread_id, platform_message_id, value, label, clicker_user_id, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO NOTHING`,
    receipt.requestId,
    receipt.approvalId,
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
  request_id: string;
  approval_id: string;
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

export async function getChoiceReceipt(requestId: string): Promise<ChoiceReceiptRow | undefined> {
  return getDb().get<ChoiceReceiptRow>('SELECT * FROM choice_receipts WHERE request_id = ?', requestId);
}
