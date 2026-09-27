/**
 * OneCLI manual-approval handler.
 *
 * When the OneCLI gateway intercepts a credentialed request that needs human
 * approval, it holds the HTTP connection open and fires our
 * `configureManualApproval` callback. We:
 *   1. Deliver an ask_question card to the approver's DM (same routing as
 *      `requestApproval()`).
 *   2. Persist a `pending_approvals` row (action='onecli_credential') — the
 *      durable, restart-surviving record of the decision being awaited.
 *   3. Wait on an in-memory Promise: resolved by the approver's click
 *      (`resolveOneCLIApproval`) or by a local pre-TTL expiry timer.
 *
 * Resolution is ROW-keyed, so a card posted by a previous process stays
 * clickable: after a restart the gateway redelivers every request it still
 * holds (within one ~35s poll), and `handleRequest` re-arms the surviving row by
 * `request_id` instead of posting a second card. A click landing before that
 * redelivery is HELD on the row and consumed by it. Expiry is also row-driven,
 * because a timer dies with the process that armed it.
 */
import { OneCLI, type ApprovalRequest, type ManualApprovalHandle } from '@onecli-sh/sdk';

import { approvalResolutionLine, pickApprovalDelivery, pickApprover } from './primitive.js';
import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

export const ONECLI_ACTION = 'onecli_credential';

type Decision = 'approve' | 'deny';
type ExpiryReason = 'no response' | 'host restarted';

const EXPIRY_SWEEP_MS = 60_000;

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface PendingState {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
  promise: Promise<Decision>;
}

const pending = new Map<string, PendingState>();
let handle: ManualApprovalHandle | null = null;
let adapterRef: ChannelDeliveryAdapter | null = null;
let expirySweep: NodeJS.Timeout | null = null;

/**
 * Generate a short approval id for card buttons.
 *
 * OneCLI's native request.id is a UUID, which pushes a card button past
 * Telegram's 64-byte `callback_data` limit.
 *
 * Instead we generate a 10-byte id (`oa-` + 8 base36 chars) for the card, and
 * keep the OneCLI request.id on the row (`request_id`) for audit and for
 * redelivery dedupe. The pending map, DB row, and button callback all use this
 * short id.
 */
function shortApprovalId(): string {
  return `oa-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Derived from the row at click time, so it survives a restart and a role
 * revoked between card and click takes effect immediately. Any eligible
 * approver may resolve an unpinned request: DM delivery is best-effort and can
 * land with an admin who is not the right decider.
 */
async function approversFor(row: PendingApproval): Promise<string[]> {
  if (row.approver_user_id) return [row.approver_user_id];
  return pickApprover(row.agent_group_id);
}

/**
 * Called from the approvals response handler when a card button is clicked.
 *
 * Row-keyed: the click works whether or not this process armed the card. A
 * live request resolves its waiting Promise; a card whose callback died with a
 * previous process takes the late-decision path.
 *
 * Returns true when this handler claims the response (the row is ours),
 * false only when the row is absent or belongs to another action.
 */
export async function resolveOneCLIApproval(
  approvalId: string,
  selectedOption: string,
  userId: string,
): Promise<boolean> {
  const row = await getPendingApproval(approvalId);
  if (!row || row.action !== ONECLI_ACTION) return false;

  // SECURITY: the clicker must be in the approver set. An empty userId (an
  // adapter that does not carry one) falls through with a warning.
  const approvers = await approversFor(row);
  // Fail closed on an empty set (the last approver's role revoked while the
  // card sat in a DM); the card then expires on the sweep.
  if (approvers.length === 0) {
    log.warn('OneCLI approval click rejected: no eligible approver for the originating agent group', {
      approvalId,
      agentGroupId: row.agent_group_id,
      userId,
    });
    return true;
  }
  if (userId && !approvers.includes(userId)) {
    log.warn('OneCLI approval click rejected: clicker not in approver set', {
      approvalId,
      userId,
      approvers,
    });
    return true;
  }
  if (!userId) {
    log.warn('OneCLI approval click carries no user id — resolving without an identity check', { approvalId });
  }

  if (selectedOption !== 'approve' && selectedOption !== 'reject') {
    log.warn('Ignoring OneCLI approval response with an unknown option', {
      approvalId,
      selectedOption,
      userId,
    });
    return true;
  }

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';

  // Claim the row first: the expiry sweep and a click can race for it.
  if (
    !(await transitionPendingApprovalStatus(approvalId, 'pending', decision === 'approve' ? 'approved' : 'rejected'))
  ) {
    log.warn('OneCLI approval already resolved — ignoring duplicate click', {
      approvalId,
      status: (await getPendingApproval(approvalId))?.status ?? 'gone',
      userId,
    });
    return true;
  }

  const state = pending.get(approvalId);
  if (state) {
    pending.delete(approvalId);
    clearTimeout(state.timer);
    // The bridge edits no approval card on click; edit the card this ROW names.
    await editCardResolution(row, await approvalResolutionLine(row, selectedOption, userId));
    await deletePendingApproval(approvalId);
    state.resolve(decision);
    log.info('OneCLI approval resolved', { approvalId, decision, userId });
    return true;
  }

  // Nothing armed in memory, but the gateway may not have redelivered yet: the
  // row STAYS as the recorded decision for `handleRequest` to consume, or for
  // the sweep to settle once the TTL passes.
  await editCardResolution(row, await approvalResolutionLine(row, selectedOption, userId));
  log.info('OneCLI approval decided while unarmed — holding the decision for redelivery', {
    approvalId,
    decision,
    userId,
    expiresAt: row.expires_at,
  });
  return true;
}

/**
 * A recorded decision whose TTL passed without a redelivery. The SDK has no
 * out-of-band decision API, so an approval card (already showing "✅ Approved")
 * must be corrected: the call ended and the agent has to retry. A rejection
 * needs no correction.
 */
async function settleUnconsumedDecision(row: PendingApproval): Promise<void> {
  if (row.status === 'approved') {
    await editCardResolution(
      row,
      '✅ Approved — recorded, but the original request ended when the host restarted. Ask the agent to retry the action.',
    );
  }
  await deletePendingApproval(row.approval_id);
  log.info('OneCLI approval decision expired undelivered', {
    approvalId: row.approval_id,
    status: row.status,
  });
}

export function startOneCLIApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (handle) return;
  adapterRef = deliveryAdapter;

  reattachSurvivingApprovals().catch((err) => log.error('OneCLI approval re-attach failed', { err }));

  handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
    try {
      return await handleRequest(request);
    } catch (err) {
      log.error('OneCLI approval handler errored', { id: request.id, err });
      return 'deny';
    }
  });

  // Row-driven expiry: overdue rows expire on the sweep regardless of which
  // process armed them — a timer that dies with its process is not the record.
  expirySweep = setInterval(() => {
    void expireOverdueApprovals();
  }, EXPIRY_SWEEP_MS);
  expirySweep.unref?.();

  log.info('OneCLI approval handler started');
}

export function stopOneCLIApprovalHandler(): void {
  handle?.stop();
  handle = null;
  if (expirySweep) {
    clearInterval(expirySweep);
    expirySweep = null;
  }
  for (const state of pending.values()) {
    clearTimeout(state.timer);
  }
  pending.clear();
  adapterRef = null;
}

/** Arm the in-memory Promise for a live request, with its pre-TTL expiry timer. */
function armPendingPromise(approvalId: string, expiresAt: string): Promise<Decision> {
  // Expiry timer fires just before the gateway's own TTL so our decision lands
  // in time to be recorded, even though the HTTP side will already be closing.
  const timeoutMs = Math.max(1000, new Date(expiresAt).getTime() - Date.now() - 1000);
  let state: PendingState;
  const promise = new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      // Identity check, not just presence: a redelivery may have replaced us.
      if (pending.get(approvalId) !== state) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Failed to mark OneCLI approval expired', { approvalId, err }),
      );
      resolve('deny');
    }, timeoutMs);
    state = { resolve, timer, promise: undefined as unknown as Promise<Decision> };
  });
  state!.promise = promise;
  pending.set(approvalId, state!);
  return promise;
}

async function handleRequest(request: ApprovalRequest): Promise<Decision> {
  if (!adapterRef) return 'deny';

  // Redelivery dedupe: re-arm the card already posted, and share the waiting
  // Promise on a poll race rather than arming a competing one.
  const existing = (await getPendingApprovalsByAction(ONECLI_ACTION)).find((row) => row.request_id === request.id);
  if (existing && existing.status !== 'pending') {
    // Decided before this redelivery arrived: consume the held decision.
    await deletePendingApproval(existing.approval_id);
    const decided: Decision = existing.status === 'approved' ? 'approve' : 'deny';
    log.info('Applied a decision recorded before the gateway redelivered', {
      approvalId: existing.approval_id,
      requestId: request.id,
      decision: decided,
    });
    return decided;
  }
  if (existing) {
    const armed = pending.get(existing.approval_id);
    if (armed) return armed.promise;
    log.info('Re-armed existing card for redelivered OneCLI approval request', {
      approvalId: existing.approval_id,
      requestId: request.id,
    });
    return armPendingPromise(existing.approval_id, request.expiresAt);
  }

  // Originating agent group is carried on the request via OneCLI's agent
  // identifier (set by container-runner.ts to agentGroup.id). Use it as
  // the scope for approver selection: admin @ group → global admin → owner.
  const originGroup = request.agent.externalId ? await getAgentGroup(request.agent.externalId) : undefined;
  const agentGroupId = originGroup?.id ?? null;
  const approvers = await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('OneCLI approval auto-denied: no eligible approver', {
      id: request.id,
      host: request.host,
      agent: request.agent.externalId,
    });
    return 'deny';
  }

  // No origin channel preference — OneCLI requests don't carry one. First
  // approver with a reachable DM wins.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    // Privacy-safe like pickApprovalDelivery: a count, not the handles.
    log.warn('OneCLI approval auto-denied: no DM channel for any approver', {
      id: request.id,
      approverCount: approvers.length,
    });
    return 'deny';
  }

  const approvalId = shortApprovalId();
  const question = buildQuestion(request, originGroup?.name ?? request.agent.name);

  const onecliTitle = 'Credentials Request';
  const onecliOptions = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' as const },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' as const },
  ];
  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: onecliTitle,
        question,
        options: onecliOptions,
      }),
      undefined,
      // ensureUserDm may resolve the DM through a named instance (its registry
      // lookup falls back across instances of a channel type); dispatch here is
      // exact-key, so the card must be addressed to the instance that owns the
      // conversation or it cannot be posted at all.
      target.messagingGroup.instance,
    );
  } catch (err) {
    log.error('Failed to deliver OneCLI approval card', { approvalId, oneCliRequestId: request.id, err });
    return 'deny';
  }

  await createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: request.id,
    action: ONECLI_ACTION,
    payload: JSON.stringify({
      oneCliRequestId: request.id,
      method: request.method,
      host: request.host,
      path: request.path,
      bodyPreview: request.bodyPreview,
      agent: request.agent,
      approver: target.userId,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    instance: target.messagingGroup.instance ?? null,
    platform_message_id: platformMessageId ?? null,
    expires_at: request.expiresAt,
    status: 'pending',
    title: onecliTitle,
    question,
    options_json: JSON.stringify(onecliOptions),
  });

  return armPendingPromise(approvalId, request.expiresAt);
}

async function expireApproval(approvalId: string, reason: ExpiryReason): Promise<void> {
  const row = await getPendingApproval(approvalId);
  if (!row || row.action !== ONECLI_ACTION) return;

  // Same claim as a click: whichever of sweep/timer/click gets the row decides it.
  if (!(await transitionPendingApprovalStatus(approvalId, 'pending', 'expired'))) return;
  await editCardExpired(row, reason);
  await deletePendingApproval(approvalId);
  log.info('OneCLI approval expired', { approvalId, reason });
}

/**
 * Re-attach surviving rows after a restart instead of blanket-expiring them:
 * a still-open row stays decidable (resolution is row-keyed), an overdue one
 * gets an honest timeout edit.
 */
async function reattachSurvivingApprovals(): Promise<void> {
  const rows = await getPendingApprovalsByAction(ONECLI_ACTION);
  if (rows.length === 0) return;

  let rearmed = 0;
  let expired = 0;
  let held = 0;
  for (const row of rows) {
    const stillOpen = row.expires_at !== null && new Date(row.expires_at).getTime() > Date.now();
    if (row.status !== 'pending') {
      if (stillOpen) held += 1;
      else await settleUnconsumedDecision(row);
      continue;
    }
    if (!stillOpen) {
      await expireApproval(row.approval_id, 'host restarted');
      expired += 1;
      continue;
    }
    rearmed += 1;
    log.info('Re-armed OneCLI approval from previous process', {
      approvalId: row.approval_id,
      requestId: row.request_id,
      expiresAt: row.expires_at,
    });
  }
  log.info('OneCLI approval re-attach complete', { rearmed, held, expired });
}

/** Row-driven expiry sweep: overdue rows expire regardless of which process armed them. */
export async function expireOverdueApprovals(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the sweep must survive any single row's failure */
  try {
    for (const row of await getPendingApprovalsByAction(ONECLI_ACTION)) {
      if (row.expires_at !== null && new Date(row.expires_at).getTime() > Date.now()) continue;
      if (row.status !== 'pending') {
        await settleUnconsumedDecision(row);
        continue;
      }
      // Live requests have their own pre-TTL timer; the sweep owns the rest.
      if (pending.has(row.approval_id)) continue;
      await expireApproval(row.approval_id, 'no response');
    }
  } catch (err) {
    log.warn('OneCLI approval expiry sweep failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export async function editCardExpired(row: PendingApproval, reason: ExpiryReason): Promise<void> {
  const resolution =
    reason === 'no response' ? '⏱️ Timed out — no response' : '⏱️ Timed out — host restarted before resolution';
  await editCardResolution(row, resolution);
}

async function editCardResolution(row: PendingApproval, resolution: string): Promise<void> {
  if (!adapterRef || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapterRef.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
      }),
      undefined,
      // Dispatch is exact-key: editing through the bare channel type finds no
      // adapter at all on an install whose bots are all named instances.
      row.instance ?? row.channel_type,
    );
  } catch (err) {
    // Louder than a warn: the row is deleted straight after, so a swallowed
    // failure leaves a card showing live Approve/Reject buttons that resolve
    // nothing, with no other trace that it happened.
    log.error('Failed to edit resolved OneCLI approval card', { approvalId: row.approval_id, err });
  }
}

/** The hosted gateway's structured request summary — not yet in the SDK's
 *  ApprovalRequest type (observed on api.onecli.sh, 2026-07): the action being
 *  performed plus labeled fields (To / Subject / Body for email sends). */
interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

const SUMMARY_VALUE_EXCERPT_CHARS = 900;

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* ${agentName}`];

  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* ${summary.action}`);
    // A render bug here must never decide the request: handleRequest's catch
    // returns 'deny', so stay defensive — coerce non-string values instead of
    // assuming the gateway's shape, and keep the card under Slack's 3000-char
    // section limit or delivery itself fails.
    let budget = 2600;
    for (const { label, value } of summary.details) {
      const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      const cap = Math.min(SUMMARY_VALUE_EXCERPT_CHARS, Math.max(0, budget));
      if (cap === 0) {
        lines.push(`_…${summary.details.length} field(s) omitted for length — see the audit payload._`);
        break;
      }
      const v = raw.length > cap ? `${raw.slice(0, cap)}…` : raw;
      budget -= v.length + String(label).length + 8;
      // Multi-line values (message bodies) read better fenced; short labeled
      // fields (To, Subject) inline.
      if (v.includes('\n')) lines.push(`*${label}:*`, '```', v, '```');
      else lines.push(`*${label}:* ${v}`);
    }
  } else if (request.bodyPreview) {
    lines.push('```', request.bodyPreview.slice(0, SUMMARY_VALUE_EXCERPT_CHARS * 2), '```');
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  } else {
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  }
  return lines.join('\n');
}
