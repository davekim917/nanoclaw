import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { defineGuardedAction, guard, ALLOW, DENY } from '../../guard/index.js';
import { log } from '../../log.js';
import { applySessionSteer, canSteer } from '../steer.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import type { SignalDecisionDetail, SignalReviewRequest, SignalDispatchRequest, SignalDecision } from './types.js';
import {
  buildSignalData,
  canReview,
  globalAdmin,
  groupVisible,
  scopedThreadDetail,
  visibleWorkgroups,
  type SourceDeps,
  type SourceDecision,
} from './sources.js';
import {
  applyReview,
  decorateReview,
  parseDecisionId,
  readRecord,
  readReview,
  saveReview,
  SignalError,
} from './state.js';

const mutation = defineGuardedAction({
  action: 'observatory.signal.mutate',
  decide: (input) =>
    input.actor.kind === 'human' && input.payload.authorized === true
      ? ALLOW('authorized human Signal mutation')
      : DENY('Signal mutation requires the applicable administrator'),
});
function demand(ctx: AuthedRequestContext, authorized: boolean) {
  if (
    guard(mutation, { actor: { kind: 'human', userId: ctx.user.id }, resource: {}, payload: { authorized } }).effect !==
    'allow'
  )
    throw new SignalError(404, 'not_found');
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export interface ApiDeps extends SourceDeps {
  threadDetail?: typeof scopedThreadDetail;
  send?: typeof applySessionSteer;
  canSend?: typeof canSteer;
  afterSend?: () => void | Promise<void>;
}
async function loadSource(id: string, ctx: AuthedRequestContext, deps: SourceDeps = {}): Promise<SourceDecision> {
  const [wg, kind, sourceId] = parseDecisionId(id);
  let focusedDeps = deps;
  if (kind === 'thread-question' && !deps.threads) {
    try {
      const identity = JSON.parse(sourceId) as unknown;
      if (Array.isArray(identity) && typeof identity[0] === 'string') {
        const session = await getDb().get<{ thread_id: string | null; agent_group_id: string }>(
          'SELECT thread_id,agent_group_id FROM sessions WHERE id=?',
          identity[0],
        );
        if (session && groupVisible(ctx, session.agent_group_id))
          focusedDeps = { ...deps, threadId: session.thread_id ?? `session:${identity[0]}`, threadOffset: 0 };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      /* no source identity can invent thread access */
    }
  }
  const data = await buildSignalData(ctx, wg, focusedDeps);
  const source = data.rawDecisions.find((d) => d.id === id);
  if (!source) throw new SignalError(404, 'not_found');
  return source;
}
export async function decisionDetail(
  id: string,
  ctx: AuthedRequestContext,
  deps: ApiDeps = {},
): Promise<SignalDecisionDetail> {
  const source = await loadSource(id, ctx, deps);
  const reviewRow = await readReview(id);
  const record = readRecord(reviewRow);
  if (
    record.dispatch?.state === 'pending' &&
    record.owner?.id === ctx.user.id &&
    canReview(ctx, { ...source, exact_context: true })
  )
    source.capabilities.dispatch = true;
  const decision = decorateReview(source, reviewRow);
  decision.capabilities.release =
    canReview(ctx, source) && !!decision.owner && (decision.owner.id === ctx.user.id || globalAdmin(ctx));
  const evidence: SignalDecisionDetail['evidence'] = [
    { title: source.question, text: source.context, at: source.source_as_of, url: source.source_url },
  ];
  let recipients: SignalDecisionDetail['recipients'] = [];
  if (source.thread_id) {
    const detail = await (deps.threadDetail ?? scopedThreadDetail)(source.thread_id, ctx);
    if (detail) {
      // The board visibility grant cannot pull a hidden group's transcript
      // into this detail; the existing thread detail applies exact scope.
      evidence.push(
        ...detail.transcript.map((e) => ({ title: e.agent_name, text: e.text, at: e.timestamp, url: null })),
      );
      recipients = detail.thread.participants
        .filter(
          (p) => groupVisible(ctx, p.agent_group_id) && (deps.canSend ?? canSteer)(ctx.user.id, p.agent_group_id).ok,
        )
        .map((p) => ({ id: p.agent_group_id, name: p.name }));
    }
  }
  if (decision.owner?.id && decision.owner.id !== ctx.user.id) {
    decision.capabilities.answer = false;
    decision.capabilities.dispatch = false;
  }
  return { decision, evidence, recipients };
}
export async function reviewDecision(
  id: string,
  body: unknown,
  ctx: AuthedRequestContext,
  deps: ApiDeps = {},
): Promise<SignalDecision> {
  if (
    !object(body) ||
    !integer(body.expected_version) ||
    typeof body.evidence_hash !== 'string' ||
    typeof body.idempotency_key !== 'string' ||
    body.idempotency_key.length < 1 ||
    body.idempotency_key.length > 128 ||
    !['claim', 'release', 'answer'].includes(String(body.action)) ||
    ('text' in body && typeof body.text !== 'string')
  )
    throw new SignalError(400, 'invalid_request');
  const source = await loadSource(id, ctx, deps);
  demand(ctx, canReview(ctx, source));
  if (source.exact_context === false) throw new SignalError(409, 'inspect_question_in_thread');
  return applyReview(
    source,
    body as unknown as SignalReviewRequest,
    { id: ctx.user.id, name: ctx.user.display_name ?? ctx.user.id },
    globalAdmin(ctx),
  );
}

/** Reserve destination, sender, stable exact text and delivery key before IO. */
export async function dispatchDecision(
  id: string,
  body: unknown,
  ctx: AuthedRequestContext,
  deps: ApiDeps = {},
): Promise<SignalDecision> {
  if (
    !object(body) ||
    !integer(body.expected_version) ||
    typeof body.evidence_hash !== 'string' ||
    typeof body.agent_group_id !== 'string' ||
    ('target_thread_id' in body && typeof body.target_thread_id !== 'string')
  )
    throw new SignalError(400, 'invalid_request');
  const request = body as unknown as SignalDispatchRequest;
  const source = await loadSource(id, ctx, deps);
  const row = await readReview(id);
  const record = readRecord(row);
  // A pending reservation is an already-authorized immutable instruction:
  // reconciliation needs current actor/group authority, not source freshness.
  const authoritySource = record.dispatch?.state === 'pending' ? { ...source, exact_context: true } : source;
  demand(ctx, canReview(ctx, authoritySource));
  if (!row || !record.answer) throw new SignalError(409, 'answer_required');
  if (record.owner?.id !== ctx.user.id || record.answered_by?.id !== ctx.user.id)
    throw new SignalError(409, 'answer_owned_by_another_reviewer');
  if (!groupVisible(ctx, request.agent_group_id) || !(deps.canSend ?? canSteer)(ctx.user.id, request.agent_group_id).ok)
    throw new SignalError(404, 'not_found');
  let reservation = record.dispatch;
  let reservedSource = source;
  if (reservation) {
    if (
      reservation.user_id !== ctx.user.id ||
      reservation.agent_group_id !== request.agent_group_id ||
      (request.target_thread_id && request.target_thread_id !== reservation.thread_id)
    )
      throw new SignalError(409, 'dispatch_target_conflict');
    // Retrying an uncertain delivery is reconciliation of the PREVIOUS exact
    // answer, even if a watcher changed the source while that send was pending.
    if (request.evidence_hash !== row.evidence_hash) throw new SignalError(409, 'dispatch_evidence_conflict');
    if (reservation.state === 'sent') return decorateReview(source, row);
    reservedSource = { ...(record.snapshot ?? source), evidence_hash: row.evidence_hash };
    if (reservation.state === 'failed') {
      if (source.evidence_hash !== row.evidence_hash) throw new SignalError(409, 'evidence_changed');
      reservation.state = 'pending';
      reservation.error = null;
      await saveReview(reservedSource, row.version, record);
    }
  } else {
    if (request.expected_version !== row.version) throw new SignalError(409, 'revision_conflict');
    if (request.evidence_hash !== source.evidence_hash || row.evidence_hash !== source.evidence_hash)
      throw new SignalError(409, 'evidence_changed');
    const threadId = source.thread_id ?? request.target_thread_id;
    if (!threadId) throw new SignalError(409, 'select_existing_thread');
    if (source.thread_id && request.target_thread_id && source.thread_id !== request.target_thread_id)
      throw new SignalError(409, 'source_thread_mismatch');
    const detail = await (deps.threadDetail ?? scopedThreadDetail)(threadId, ctx);
    const participant = detail?.thread.participants.find((p) => p.agent_group_id === request.agent_group_id);
    if (!participant) throw new SignalError(404, 'not_found');
    const group = await getDb().get<{ workgroup_id: string }>(
      'SELECT workgroup_id FROM agent_groups WHERE id=?',
      participant.agent_group_id,
    );
    if (group?.workgroup_id !== source.workgroup_id) throw new SignalError(409, 'cross_workgroup_target');
    // Fixed wrapper is persisted, rather than regenerated on retry after a
    // display-name or claim change. The stored answer is reproduced verbatim.
    const text = `${ctx.user.display_name ?? ctx.user.id} sent a decision from the Observatory.\n\nQuestion: ${source.question.slice(0, 500)}\n\nTheir answer, verbatim:\n${record.answer}\n\nReply in this thread with what you did or what prevents action.`;
    if (text.length > 4000) throw new SignalError(400, 'message_too_long');
    reservation = {
      key: `signal:${randomUUID()}`,
      agent_group_id: participant.agent_group_id,
      session_id: participant.session_id,
      thread_id: threadId,
      user_id: ctx.user.id,
      text,
      state: 'pending',
      error: null,
    };
    record.dispatch = reservation;
    await saveReview(source, row.version, record);
  }
  let delivery: Awaited<ReturnType<typeof applySessionSteer>>;
  try {
    delivery = await (deps.send ?? applySessionSteer)(
      reservation.session_id,
      { idempotency_key: reservation.key, text: reservation.text },
      ctx,
    );
  } catch {
    // Unknown whether the write landed. Keep pending and preserve the exact
    // reservation, allowing the primitive to reconcile its durable message ID.
    throw new SignalError(503, 'delivery_uncertain_retry_same_decision');
  }
  await deps.afterSend?.();
  const latest = await readReview(id);
  const latestRecord = readRecord(latest);
  if (!latest || latestRecord.dispatch?.key !== reservation.key)
    throw new SignalError(409, 'dispatch_reservation_changed');
  if (latestRecord.dispatch.state === 'sent') return decorateReview(source, latest);
  // No rejection proves another same-key request has not already written.
  // Reservation remains immutable until a successful reconciliation; otherwise
  // an overlapping send could deliver an answer after a reviewer replaced it.
  latestRecord.dispatch.state = delivery.status === 202 ? 'sent' : 'pending';
  latestRecord.dispatch.error = delivery.status === 202 ? null : String(delivery.body.error ?? 'delivery_failed');
  try {
    await saveReview(reservedSource, latest.version, latestRecord);
  } catch (error) {
    // Another identical retry may already have recorded the same success.
    const winner = await readReview(id);
    if (readRecord(winner).dispatch?.state !== 'sent') throw error;
  }
  return decorateReview(source, await readReview(id));
}
export async function updateProject(id: string, body: unknown, ctx: AuthedRequestContext) {
  demand(ctx, globalAdmin(ctx));
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
    !object(body) ||
    typeof body.workgroup_id !== 'string' ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.length > 160 ||
    typeof body.description !== 'string' ||
    body.description.length > 4000 ||
    !integer(body.expected_version) ||
    !Array.isArray(body.repositories) ||
    !Array.isArray(body.channel_keys) ||
    body.repositories.length > 50 ||
    body.channel_keys.length > 100 ||
    body.repositories.some((v) => typeof v !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v)) ||
    body.channel_keys.some((v) => typeof v !== 'string' || v.length > 200)
  )
    throw new SignalError(400, 'invalid_project');
  if (!(await visibleWorkgroups(ctx)).some((w) => w.id === body.workgroup_id)) throw new SignalError(404, 'not_found');
  const channels = await getDb().all<{ platform_id: string }>(
    `SELECT DISTINCT m.platform_id FROM messaging_groups m JOIN messaging_group_agents ma ON ma.messaging_group_id=m.id JOIN agent_groups a ON a.id=ma.agent_group_id WHERE a.workgroup_id=?`,
    body.workgroup_id,
  );
  if (body.channel_keys.some((c) => !channels.some((r) => r.platform_id === c)))
    throw new SignalError(400, 'channel_not_in_workgroup');
  const existing = await getDb().get<{ version: number; workgroup_id: string }>(
    'SELECT version,workgroup_id FROM observatory_projects WHERE id=?',
    id,
  );
  if (existing && existing.workgroup_id !== body.workgroup_id) throw new SignalError(409, 'cross_workgroup_project');
  const repositories = [...new Set((body.repositories as string[]).map((r) => r.toLowerCase()))];
  const channelKeys = [...new Set(body.channel_keys as string[])];
  const now = new Date().toISOString();
  let changes: number;
  if (body.expected_version === 0)
    changes = (
      await getDb().run(
        `INSERT INTO observatory_projects(id,workgroup_id,name,description,repositories,channel_keys,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING`,
        id,
        body.workgroup_id,
        body.name.trim(),
        body.description,
        JSON.stringify(repositories),
        JSON.stringify(channelKeys),
        ctx.user.id,
        now,
      )
    ).changes;
  else
    changes = (
      await getDb().run(
        `UPDATE observatory_projects SET name=?,description=?,repositories=?,channel_keys=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND workgroup_id=? AND version=?`,
        body.name.trim(),
        body.description,
        JSON.stringify(repositories),
        JSON.stringify(channelKeys),
        ctx.user.id,
        now,
        id,
        body.workgroup_id,
        body.expected_version,
      )
    ).changes;
  if (!changes) throw new SignalError(409, 'revision_conflict');
  return { id, version: body.expected_version + 1 };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
function endpoint(fn: AuthHandler): AuthHandler {
  return async (req, params, ctx) => {
    try {
      return await fn(req, params, ctx);
    } catch (error) {
      if (error instanceof SignalError) return response({ error: error.message }, error.status);
      if (error instanceof SyntaxError) return response({ error: 'invalid_json' }, 400);
      log.warn('Signal API failed', { error });
      return response({ error: 'source_unavailable' }, 503);
    }
  };
}
function routeId(params: Record<string, string>) {
  try {
    return decodeURIComponent(params.id ?? '');
  } catch {
    throw new SignalError(404, 'not_found');
  }
}
export const signalOverviewHandler = endpoint(async (req, _params, ctx) => {
  const query = new URL(req.url).searchParams;
  const offset = Number(query.get('thread_offset') ?? '0');
  const limit = Number(query.get('thread_limit') ?? '200');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new SignalError(400, 'invalid_thread_page');
  const data = await buildSignalData(ctx, query.get('workgroup') ?? 'all', {
    threadOffset: offset,
    threadLimit: limit,
  });
  const { rawDecisions: _, ...overview } = data;
  return response(overview);
});
export const signalDecisionHandler = endpoint(async (_req, params, ctx) =>
  response(await decisionDetail(routeId(params), ctx)),
);
export const signalReviewHandler = endpoint(async (req, params, ctx) =>
  response({ decision: await reviewDecision(routeId(params), await req.json(), ctx) }),
);
export const signalDispatchHandler = endpoint(async (req, params, ctx) =>
  response({ decision: await dispatchDecision(routeId(params), await req.json(), ctx) }),
);
export const signalProjectHandler = endpoint(async (req, params, ctx) =>
  response(await updateProject(routeId(params), await req.json(), ctx)),
);
