/**
 * Bash gate — in-container Bash commands that require admin approval.
 *
 * Two sibling entry points that share the same machinery but carry
 * different category labels:
 *   - `request_bash_gate` / approval action `bash-gate` —
 *     soft-sensitive ops (email send). Default title prefix: "Bash".
 *   - `request_destructive_gate` / approval action `destructive-gate` —
 *     destructive filesystem / infra ops, triggered by
 *     bootstrap/plugins/workflow/hooks/guards/block-destructive.ts.
 *     Default title prefix: "Destructive".
 *
 * The categorical split exists so approval cards, audit logs, and
 * future differentiated policy (e.g. always-block vs require-2FA for
 * destructive) can key off the action name rather than pattern-match
 * the label. The handlers themselves are shared — both categories
 * round-trip through the same ack mechanism.
 *
 * Flow (originator: a PreToolUse:Bash hook or plugin in the container):
 *   1. Hook writes a system-action message to outbound.db with
 *      action='request_bash_gate' or 'request_destructive_gate' and
 *      content { requestId, label, summary, command }.
 *      requestId === messages_out.id.
 *   2. delivery.ts picks the system action up, dispatches to our
 *      category-specific handler, which calls requestApproval with the
 *      matching approval action and sets a 60-min timeout.
 *   3. Admin clicks approve / reject in their DM. response-handler.ts
 *      dispatches to our shared approval handler, which writes the
 *      decision into inbound.db's `delivered` table under requestId.
 *   4. Timeout fires if still pending after 60 min → same table write
 *      with status='failed' + a timeout error.
 *   5. The container hook polls `delivered` for requestId via the same
 *      awaitDeliveryAck primitive that send_file uses. Approve →
 *      command executes; reject/timeout → command is denied with the
 *      returned error.
 *
 * Cross-mount state lives entirely in `delivered` — no new per-session
 * schema. The `delivered` table is dual-purpose (chat delivery outcomes
 * AND bash-gate outcomes) which is a mild semantic overload but keeps
 * the wire surface minimal and lets the container side reuse existing
 * code unchanged.
 *
 * Tier: default module. Optional in the sense that a fork that doesn't
 * want admin-gated Bash can `registerDeliveryAction` a no-op — but the
 * email-gate container hook will dead-lock for 30 min on every send
 * without a handler wired up, so effectively required wherever email
 * skills are enabled.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { markDelivered, markDeliveryFailed } from '../../db/session-db.js';
import { openInboundDb } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getSession } from '../../db/sessions.js';

import {
  registerApprovalHandler,
  requestApproval,
  notifyAgent,
  type ApprovalHandlerContext,
} from '../approvals/primitive.js';

// 60 minutes — users often step away for meetings and come back. The
// prior 30-min window matched v1's IDLE_TIMEOUT but routinely timed out
// on approvers who were in a call when the card landed.
const BASH_GATE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Map from pending approval gateId (which is also the messages_out id
 * the container is polling on) → scheduled-timeout handle. Lets the
 * approval handler clear the timer when the admin responds in time.
 */
const pendingTimeouts = new Map<string, NodeJS.Timeout>();

interface BashGatePayload {
  requestId: string;
  label: string;
  summary: string;
  command: string;
  /** Carried into the approval payload so the approval handler can find its way back to the session. */
  sessionId: string;
}

function writeGateAck(
  session: Session,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'timeout',
  errorText?: string,
): void {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  try {
    if (outcome === 'approved') {
      markDelivered(inDb, requestId, null);
    } else {
      markDeliveryFailed(inDb, requestId, errorText ?? outcome);
    }
  } finally {
    inDb.close();
  }
}

function clearPending(requestId: string): void {
  const handle = pendingTimeouts.get(requestId);
  if (handle) {
    clearTimeout(handle);
    pendingTimeouts.delete(requestId);
  }
}

interface GateCategory {
  /** Delivery-action name the container writes (e.g. 'request_bash_gate'). */
  deliveryAction: string;
  /** Approval-action name carried into requestApproval + registered on the approval side. */
  approvalAction: string;
  /** Fallback label when the container omits one. */
  defaultLabel: string;
  /** Fallback summary when the container omits one. */
  defaultSummary: string;
  /** Log prefix for this category. */
  logPrefix: string;
}

function createGateHandler(category: GateCategory) {
  return async function handleGateRequest(
    content: Record<string, unknown>,
    session: Session,
    _inDb: Database.Database,
  ): Promise<{ deferAck: true }> {
    const label = typeof content.label === 'string' ? content.label : category.defaultLabel;
    const summary = typeof content.summary === 'string' ? content.summary : category.defaultSummary;
    const command = typeof content.command === 'string' ? (content.command as string).slice(0, 500) : '';
    const requestId = typeof content.requestId === 'string' ? (content.requestId as string) : '';
    if (!requestId) {
      log.warn(`${category.deliveryAction} missing requestId`, { content });
      // Even on malformed request we want to defer — the container wrote a
      // messages_out row keyed on its own requestId and will poll for the
      // delivered/failed decision. Auto-acking here would falsely unblock.
      return { deferAck: true };
    }

    // Schedule the timeout before we dispatch the approval, so if anything
    // below throws we still auto-resolve on the container side.
    const timer = setTimeout(() => {
      pendingTimeouts.delete(requestId);
      log.warn(`${category.logPrefix} gate timed out`, { requestId, agentGroupId: session.agent_group_id });
      writeGateAck(
        session,
        requestId,
        'timeout',
        `${category.logPrefix} gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`,
      );
    }, BASH_GATE_TIMEOUT_MS);
    timer.unref(); // don't block process shutdown on a pending gate
    pendingTimeouts.set(requestId, timer);

    const payload: BashGatePayload = {
      requestId,
      label,
      summary,
      command,
      sessionId: session.id,
    };

    await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: category.approvalAction,
      payload: payload as unknown as Record<string, unknown>,
      title: label,
      question: command ? `${summary}\n\n\`${command}\`` : summary,
      // Gates deliver in-thread so teammates using the agent can approve
      // their own work-level requests without waiting on the bot owner.
      // response-handler.ts doesn't check clicker identity — thread access
      // IS the authority for work-level gates. Self-mod / credential
      // approvals stay admin-DM (their defaults).
      deliveryTarget: 'thread',
    });

    // Defer the ack — the container polls `delivered` keyed on requestId
    // (which is messages_out.id). Marking delivered now would short-circuit
    // the gate; the approval handler (or the 60-min timeout above) is the
    // only writer for this row.
    return { deferAck: true };
  };
}

function createApprovalHandler(logPrefix: string) {
  return async function handleGateApproval(ctx: ApprovalHandlerContext): Promise<void> {
    const { payload, userId } = ctx;
    const p = payload as unknown as BashGatePayload;
    if (!p.requestId || !p.sessionId) {
      log.warn(`${logPrefix} gate approval with malformed payload`, { payload });
      return;
    }
    clearPending(p.requestId);

    const session = getSession(p.sessionId);
    if (!session) {
      log.warn(`${logPrefix} gate approval for unknown session`, { sessionId: p.sessionId, requestId: p.requestId });
      return;
    }

    // The approval handler signals decision by calling ctx.notify OR by the
    // act of being called at all. response-handler.ts only invokes us on
    // approve; reject calls markDeliveryFailed via ctx.notify being skipped.
    // We don't have direct access to the decision value here — primitive's
    // interface collapses it. However, response-handler.ts currently ONLY
    // calls the registered handler on approve (reject just notifies). So
    // reaching this function means approved.
    writeGateAck(session, p.requestId, 'approved');
    log.info(`${logPrefix} gate approved`, { requestId: p.requestId, userId });
    notifyAgent(session, `${logPrefix} gate approved: ${p.label}`);
  };
}

// Categorical split: bash-gate (soft sensitive — email) vs destructive-gate
// (filesystem/infra destructive ops). Same ack mechanics, distinct labels
// and action names so logs / policy can differentiate.
const BASH_GATE: GateCategory = {
  deliveryAction: 'request_bash_gate',
  approvalAction: 'bash-gate',
  defaultLabel: 'Bash command',
  defaultSummary: 'Approve this Bash command?',
  logPrefix: 'Bash',
};
const DESTRUCTIVE_GATE: GateCategory = {
  deliveryAction: 'request_destructive_gate',
  approvalAction: 'destructive-gate',
  defaultLabel: 'Destructive command',
  defaultSummary: 'Approve this destructive command?',
  logPrefix: 'Destructive',
};

registerDeliveryAction(BASH_GATE.deliveryAction, createGateHandler(BASH_GATE));
registerApprovalHandler(BASH_GATE.approvalAction, createApprovalHandler(BASH_GATE.logPrefix));
registerDeliveryAction(DESTRUCTIVE_GATE.deliveryAction, createGateHandler(DESTRUCTIVE_GATE));
registerApprovalHandler(DESTRUCTIVE_GATE.approvalAction, createApprovalHandler(DESTRUCTIVE_GATE.logPrefix));
