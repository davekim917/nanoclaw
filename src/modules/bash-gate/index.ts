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
import { markDelivered, markDeliveryFailed, markPending } from '../../db/session-db.js';
import { openInboundDb } from '../../session-manager.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { deletePendingApproval, getPendingApprovalsBySession, getSession } from '../../db/sessions.js';

import {
  editApprovalCard,
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
  /** Emoji shown in the card title (⚠️ for soft gates, 🛑 for destructive). */
  titleEmoji: string;
  /** Short category word rendered in the card body header (e.g. "Email send", "Destructive command"). */
  kindNoun: string;
}

/**
 * Build the card body shown to the approver. Structure:
 *
 *   **<title-label>**
 *
 *   <summary sentence>
 *
 *   ```
 *   <truncated command>
 *   ```
 *
 *   _Approve to run. Reject to cancel. Times out in 60 min._
 *
 * Keeps the Slack/Discord rendering readable: title stays short, the
 * command lives in its own code block instead of being inlined with
 * the summary, and the footer tells the approver what each outcome
 * means and what the timeout is. Matches v1's richer card layout.
 */
function buildCardBody(category: GateCategory, summary: string, command: string): string {
  const parts: string[] = [summary];
  if (command) {
    // Multi-line fenced code block renders nicely on both Slack and
    // Discord (mrkdwn + markdown). Truncate to keep the card readable —
    // the full command is persisted in the approval payload for audit.
    const trimmed = command.length > 800 ? command.slice(0, 800) + '\n…[truncated]' : command;
    parts.push('```\n' + trimmed + '\n```');
  }
  const timeoutMinutes = BASH_GATE_TIMEOUT_MS / 60_000;
  parts.push(
    `_Approve runs this ${category.kindNoun.toLowerCase()}. Reject cancels it. Times out in ${timeoutMinutes} min._`,
  );
  return parts.join('\n\n');
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
    const timer = setTimeout(async () => {
      pendingTimeouts.delete(requestId);
      log.warn(`${category.logPrefix} gate timed out`, { requestId, agentGroupId: session.agent_group_id });
      writeGateAck(
        session,
        requestId,
        'timeout',
        `${category.logPrefix} gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`,
      );
      // Edit the card in-place to show the timeout. Without this the
      // buttons stay live in Slack/Discord and a user clicking 59 min
      // late would hit a no-op handler.
      const pending = getPendingApprovalsBySession(session.id).find((p) => p.request_id === requestId);
      if (pending) {
        await editApprovalCard(
          pending,
          `🕒 *${pending.title}* — timed out\n\nNo approval received within ${BASH_GATE_TIMEOUT_MS / 60_000} minutes. The ${category.kindNoun} was not run.`,
        );
        deletePendingApproval(pending.approval_id);
      }
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
      title: `${category.titleEmoji} ${label}`,
      question: buildCardBody(category, summary, command),
      // Gates deliver in-thread so teammates using the agent can approve
      // their own work-level requests without waiting on the bot owner.
      // response-handler.ts doesn't check clicker identity — thread access
      // IS the authority for work-level gates. Self-mod / credential
      // approvals stay admin-DM (their defaults).
      deliveryTarget: 'thread',
    });

    // Write a 'pending' row to `delivered` so the delivery loop's
    // getDeliveredIds dedup filter skips this message on the next poll
    // tick. Without this, every poll re-dispatches the gate → one
    // approval card per poll interval (~500ms) until the human acts.
    // The bash-gate approval handler (or timeout path) later UPSERTs
    // this to 'delivered' or 'failed' — both outcomes supersede 'pending'.
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      markPending(inDb, requestId);
    } finally {
      inDb.close();
    }

    // Defer the ack — the container polls `delivered` keyed on requestId
    // (which is messages_out.id). Marking delivered now would short-circuit
    // the gate; the approval handler (or the 60-min timeout above) is the
    // only writer for the final 'delivered'/'failed' state.
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
  defaultSummary: 'The agent wants to run a sensitive command.',
  logPrefix: 'Bash',
  titleEmoji: '⚠️',
  kindNoun: 'command',
};
const DESTRUCTIVE_GATE: GateCategory = {
  deliveryAction: 'request_destructive_gate',
  approvalAction: 'destructive-gate',
  defaultLabel: 'Destructive command',
  defaultSummary: 'The agent wants to run a destructive command.',
  logPrefix: 'Destructive',
  titleEmoji: '🛑',
  kindNoun: 'destructive command',
};

registerDeliveryAction(BASH_GATE.deliveryAction, createGateHandler(BASH_GATE));
registerApprovalHandler(BASH_GATE.approvalAction, createApprovalHandler(BASH_GATE.logPrefix));
registerDeliveryAction(DESTRUCTIVE_GATE.deliveryAction, createGateHandler(DESTRUCTIVE_GATE));
registerApprovalHandler(DESTRUCTIVE_GATE.approvalAction, createApprovalHandler(DESTRUCTIVE_GATE.logPrefix));

/**
 * Auto-cancel every in-flight gate for `sessionId`. Called from the
 * router when a new inbound message arrives for a session that has
 * pending gates — v1 behavior: sending a follow-up implicitly rejects
 * the open gate so the agent can answer the new question instead of
 * staying blocked on awaitDeliveryAck.
 *
 * For each pending bash-gate or destructive-gate row:
 *   1. Clear the in-memory 60-min timeout (no-op if the handler was
 *      registered on a previous host run).
 *   2. Edit the card in Slack/Discord to show "cancelled by follow-up"
 *      and drop the buttons. Best-effort — failures just leave the
 *      card live but that's recoverable by the user clicking anyway
 *      (the pending_approvals row is deleted below, so clicks become
 *      no-ops rather than firing the stale gate).
 *   3. Write 'failed' to the session's inbound.db delivered table so
 *      the container's awaitDeliveryAck returns → PreToolUse hook
 *      denies the Bash command → current turn ends → next turn picks
 *      up the new inbound message cleanly.
 *   4. Delete the pending_approvals row so a late click can't
 *      retroactively approve a cancelled gate.
 *
 * Safe to call with no pending gates — returns immediately.
 */
export async function cancelPendingGatesForSession(sessionId: string, reason: string): Promise<void> {
  const pending: PendingApproval[] = getPendingApprovalsBySession(sessionId).filter(
    (p) => p.action === BASH_GATE.approvalAction || p.action === DESTRUCTIVE_GATE.approvalAction,
  );
  if (pending.length === 0) return;

  const session = getSession(sessionId);
  if (!session) {
    log.warn('cancelPendingGatesForSession called for unknown session', { sessionId });
    return;
  }

  log.info('Auto-cancelling in-flight gates', {
    sessionId,
    count: pending.length,
    approvalIds: pending.map((p) => p.approval_id),
  });

  for (const p of pending) {
    // The container polls `delivered` keyed on the GATE's requestId
    // (the gate-* messages_out row it wrote), NOT on pending_approvals'
    // `request_id` field — those are different identifiers. The gate
    // requestId lives in the serialized payload that the original
    // `handleGateRequest` stored when it called createPendingApproval.
    // Parse it back out here so writeGateAck targets the row the
    // container is actually waiting on.
    let gateRequestId: string | undefined;
    try {
      const payload = JSON.parse(p.payload) as BashGatePayload;
      gateRequestId = payload.requestId;
    } catch {
      log.warn('Pending gate payload unparseable; skipping cancel', { approvalId: p.approval_id });
      continue;
    }
    if (!gateRequestId) {
      log.warn('Pending gate payload missing requestId; skipping cancel', { approvalId: p.approval_id });
      continue;
    }
    clearPending(gateRequestId);
    try {
      await editApprovalCard(p, `❌ *${p.title}* — cancelled\n\n${reason}`);
    } catch (err) {
      log.warn('Failed to edit cancelled approval card', { approvalId: p.approval_id, err });
    }
    writeGateAck(session, gateRequestId, 'rejected', reason);
    deletePendingApproval(p.approval_id);
  }
}
