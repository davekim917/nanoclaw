/**
 * Bash gate — in-container Bash commands that require admin approval.
 *
 * Flow (originator: a PreToolUse:Bash hook in the container, currently
 * wired for `gws gmail +send/reply/forward`):
 *   1. Hook writes a system-action message to outbound.db with
 *      action='request_bash_gate' and content { requestId, label,
 *      summary, command }. requestId === messages_out.id.
 *   2. delivery.ts picks the system action up, dispatches to our
 *      handleRequestBashGate, which calls requestApproval with the
 *      payload and sets a 30-min timeout.
 *   3. Admin clicks approve / reject in their DM. response-handler.ts
 *      dispatches to our handleBashGateApproval, which writes the
 *      decision into inbound.db's `delivered` table under requestId.
 *   4. Timeout fires if still pending after 30 min → same table write
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

const BASH_GATE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes, matches v1's IDLE_TIMEOUT.

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

async function handleRequestBashGate(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const label = typeof content.label === 'string' ? content.label : 'Bash command';
  const summary = typeof content.summary === 'string' ? content.summary : 'Approve this Bash command?';
  const command = typeof content.command === 'string' ? (content.command as string).slice(0, 500) : '';
  const requestId = typeof content.requestId === 'string' ? (content.requestId as string) : '';
  if (!requestId) {
    log.warn('request_bash_gate missing requestId', { content });
    return;
  }

  // Schedule the timeout before we dispatch the approval, so if anything
  // below throws we still auto-resolve on the container side.
  const timer = setTimeout(() => {
    pendingTimeouts.delete(requestId);
    log.warn('Bash gate timed out', { requestId, agentGroupId: session.agent_group_id });
    writeGateAck(session, requestId, 'timeout', `Bash gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`);
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
    action: 'bash-gate',
    payload: payload as unknown as Record<string, unknown>,
    title: label,
    question: command ? `${summary}\n\n\`${command}\`` : summary,
  });
}

async function handleBashGateApproval(ctx: ApprovalHandlerContext): Promise<void> {
  const { payload, userId } = ctx;
  const p = payload as unknown as BashGatePayload;
  if (!p.requestId || !p.sessionId) {
    log.warn('Bash gate approval with malformed payload', { payload });
    return;
  }
  clearPending(p.requestId);

  const session = getSession(p.sessionId);
  if (!session) {
    log.warn('Bash gate approval for unknown session', { sessionId: p.sessionId, requestId: p.requestId });
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
  log.info('Bash gate approved', { requestId: p.requestId, userId });
  notifyAgent(session, `Bash gate approved: ${p.label}`);
}

registerDeliveryAction('request_bash_gate', handleRequestBashGate);
registerApprovalHandler('bash-gate', handleBashGateApproval);
