/**
 * Admin-approval gates for in-container Bash: `request_bash_gate` (soft
 * sensitive, e.g. email send) and `request_destructive_gate`. Distinct action
 * names so cards, logs and policy can differ; shared ack mechanics.
 *
 * The container hook writes the request (requestId === messages_out.id) and
 * polls inbound.db's `delivered` table for requestId; approve, reject or
 * timeout writes the decision there. Without a registered handler the
 * container-side hook blocks until its own timeout on every send.
 */

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  deletePendingApproval,
  getPendingApprovalByRequestId,
  getPendingApprovalsBySession,
  getSession,
} from '../../db/sessions.js';

import {
  editApprovalCard,
  registerApprovalHandler,
  requestApproval,
  notifyAgent,
  type ApprovalHandlerContext,
} from '../approvals/primitive.js';

// Approvers are often in a meeting when the card lands.
const BASH_GATE_TIMEOUT_MS = 60 * 60 * 1000;
const GATE_CARD_TITLE_MAX_CHARS = 140;
// Head+tail preview: a long command's final arguments are often the most
// consequential part.
const GATE_COMMAND_PREVIEW_MAX_CHARS = 1400;

const pendingTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Lets the router skip the cancel query in the common case. Not persisted: on
 * host restart every container gate is already stale.
 */
const sessionsWithActiveGates = new Set<string>();

export function sessionHasActiveGates(sessionId: string): boolean {
  return sessionsWithActiveGates.has(sessionId);
}

interface BashGatePayload {
  requestId: string;
  label: string;
  summary: string;
  command: string;
  sessionId: string;
}

/**
 * Runs long after the dispatching drain, in its own short session. Existing-only:
 * a session whose mailbox is gone has no container polling for the decision.
 */
async function writeGateAck(
  session: Session,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'timeout',
  errorText?: string,
): Promise<void> {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if (outcome === 'approved') {
      mailbox.markDelivered(requestId, null);
    } else {
      mailbox.markDeliveryFailed(requestId, errorText ?? outcome);
    }
  });
}

function clearPending(requestId: string): void {
  const handle = pendingTimeouts.get(requestId);
  if (handle) {
    clearTimeout(handle);
    pendingTimeouts.delete(requestId);
  }
}

interface GateCategory {
  deliveryAction: string;
  approvalAction: string;
  defaultLabel: string;
  defaultSummary: string;
  logPrefix: string;
  titleEmoji: string;
  kindNoun: string;
}

function commandPreview(command: string): string {
  const codePoints = Array.from(command);
  if (codePoints.length <= GATE_COMMAND_PREVIEW_MAX_CHARS) return command;

  const marker = '\n…[middle omitted; full command retained in the approval record]…\n';
  const markerLength = Array.from(marker).length;
  const headLength = Math.floor((GATE_COMMAND_PREVIEW_MAX_CHARS - markerLength) / 2);
  const tailLength = GATE_COMMAND_PREVIEW_MAX_CHARS - markerLength - headLength;
  return codePoints.slice(0, headLength).join('') + marker + codePoints.slice(-tailLength).join('');
}

function buildCardBody(category: GateCategory, summary: string, command: string): string {
  const parts: string[] = [summary];
  if (command) {
    // The full command is persisted in the approval payload; the card preview
    // keeps head and tail so the approver never infers omitted final arguments.
    parts.push('```\n' + commandPreview(command) + '\n```');
  }
  const timeoutMinutes = BASH_GATE_TIMEOUT_MS / 60_000;
  parts.push(
    `_Approve runs this ${category.kindNoun.toLowerCase()}. Reject cancels it. Times out in ${timeoutMinutes} min._`,
  );
  return parts.join('\n\n');
}

function buildCardTitle(category: GateCategory, label: string): string {
  const title = `${category.titleEmoji} ${label}`;
  const codePoints = Array.from(title);
  if (codePoints.length <= GATE_CARD_TITLE_MAX_CHARS) return title;
  return (
    codePoints
      .slice(0, GATE_CARD_TITLE_MAX_CHARS - 1)
      .join('')
      .trimEnd() + '…'
  );
}

function createGateHandler(category: GateCategory) {
  return async function handleGateRequest(
    content: Record<string, unknown>,
    session: Session,
  ): Promise<{ deferAck: true }> {
    const label = typeof content.label === 'string' ? content.label : category.defaultLabel;
    const summary = typeof content.summary === 'string' ? content.summary : category.defaultSummary;
    // Keep the full command: truncating would drop consequential trailing flags.
    const command = typeof content.command === 'string' ? content.command : '';
    const requestId = typeof content.requestId === 'string' ? (content.requestId as string) : '';
    if (!requestId) {
      log.warn(`${category.deliveryAction} missing requestId`, { content });
      // Still defer: the container polls for a decision on its own requestId,
      // and auto-acking would falsely unblock it.
      return { deferAck: true };
    }

    sessionsWithActiveGates.add(session.id);

    // Schedule the timeout before dispatching, so a throw below still
    // auto-resolves the container side.
    const timer = setTimeout(() => {
      void (async () => {
        pendingTimeouts.delete(requestId);
        sessionsWithActiveGates.delete(session.id);
        log.warn(`${category.logPrefix} gate timed out`, { requestId, agentGroupId: session.agent_group_id });
        await writeGateAck(
          session,
          requestId,
          'timeout',
          `${category.logPrefix} gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`,
        );
        const pending = await getPendingApprovalByRequestId(requestId);
        if (pending) {
          await editApprovalCard(
            pending,
            `🕒 *${pending.title}* — timed out\n\nNo approval received within ${BASH_GATE_TIMEOUT_MS / 60_000} minutes. The ${category.kindNoun} was not run.`,
          );
          await deletePendingApproval(pending.approval_id);
        }
      })().catch((err) => {
        log.error(`${category.logPrefix} gate timeout handler failed`, { requestId, err });
      });
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

    const approvalDelivered = await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: category.approvalAction,
      requestId,
      payload: payload as unknown as Record<string, unknown>,
      title: buildCardTitle(category, label),
      question: buildCardBody(category, summary, command),
      // In-thread: thread access IS the authority for work-level gates
      // (response-handler.ts doesn't check clicker identity). Self-mod and
      // credential approvals stay admin-DM.
      deliveryTarget: 'thread',
    });
    if (!approvalDelivered) {
      clearPending(requestId);
      sessionsWithActiveGates.delete(session.id);
      await writeGateAck(
        session,
        requestId,
        'rejected',
        `${category.approvalAction} delivery failed: approval request could not be posted.`,
      );
      return { deferAck: true };
    }

    // Mark 'pending' so the delivery loop's dedup skips it; otherwise every
    // poll re-dispatches the gate and posts another card.
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.markPending(requestId));

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
    sessionsWithActiveGates.delete(p.sessionId);

    const session = await getSession(p.sessionId);
    if (!session) {
      log.warn(`${logPrefix} gate approval for unknown session`, { sessionId: p.sessionId, requestId: p.requestId });
      return;
    }

    // Only invoked on Approve; Reject is handled in response-handler.ts.
    await writeGateAck(session, p.requestId, 'approved');
    log.info(`${logPrefix} gate approved`, { requestId: p.requestId, userId });
    // Best-effort, never awaited: an awaited rejection whose fallback notify
    // also fails leaves the approval row clickable, replaying the ack.
    void Promise.resolve(notifyAgent(session, `${logPrefix} gate approved: ${p.label}`)).catch((err) =>
      log.warn(`${logPrefix} gate approval notification failed`, { requestId: p.requestId, err }),
    );
  };
}

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

registerDeliveryAction(
  BASH_GATE.deliveryAction,
  createGateHandler(BASH_GATE),
  unguarded('request path only; execution waits for the registered bash-gate approval handler'),
);
registerApprovalHandler(BASH_GATE.approvalAction, createApprovalHandler(BASH_GATE.logPrefix));
registerDeliveryAction(
  DESTRUCTIVE_GATE.deliveryAction,
  createGateHandler(DESTRUCTIVE_GATE),
  unguarded('request path only; execution waits for the registered destructive-gate approval handler'),
);
registerApprovalHandler(DESTRUCTIVE_GATE.approvalAction, createApprovalHandler(DESTRUCTIVE_GATE.logPrefix));

/**
 * A follow-up message implicitly rejects the session's open gates so the
 * agent can answer it instead of staying blocked. Card edit is best-effort;
 * the pending_approvals row is deleted so a late click can't approve a
 * cancelled gate.
 */
export async function cancelPendingGatesForSession(sessionId: string, reason: string): Promise<void> {
  const pending: PendingApproval[] = (await getPendingApprovalsBySession(sessionId)).filter(
    (p) => p.action === BASH_GATE.approvalAction || p.action === DESTRUCTIVE_GATE.approvalAction,
  );
  if (pending.length === 0) return;

  const session = await getSession(sessionId);
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
    // request_id is the gate's own outbound message id, which the container polls on.
    clearPending(p.request_id);
    try {
      await editApprovalCard(p, `❌ *${p.title}* — cancelled\n\n${reason}`);
    } catch (err) {
      log.warn('Failed to edit cancelled approval card', { approvalId: p.approval_id, err });
    }
    await writeGateAck(session, p.request_id, 'rejected', reason);
    await deletePendingApproval(p.approval_id);
  }
  sessionsWithActiveGates.delete(sessionId);
}
