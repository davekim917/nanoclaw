import { readItemThread, claimItemThread } from '../observatory-steer.js';
import { getDb } from '../../db/connection.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { resolveSession } from '../../session-manager.js';
import { threadPlatformId, ownerMatchesAgent } from '../api/observatory.js';
import { canSteer } from '../steer.js';
import type { AuthedRequestContext } from '../router.js';
import { groupVisible, type SourceDecision } from './sources.js';
import { SignalError, readRecord, readReview, saveReview, type ReviewRecord } from './state.js';
import type { SignalDecisionDetail } from './types.js';

type Candidate = {
  id: string;
  name: string;
  folder: string;
  messaging_group_id: string;
  platform_id: string;
  channel_name: string | null;
  channel_type: string;
  priority: number;
  session_id?: string;
};
export type Destination = SignalDecisionDetail['destination'] & {
  candidates: Candidate[];
  session_thread_id?: string | null;
};
export async function resolveDestination(
  source: SourceDecision,
  ctx: AuthedRequestContext,
  canSend: typeof canSteer = canSteer,
): Promise<Destination> {
  const linked =
    source.source_kind === 'release-item' ? await readItemThread(source.workgroup_id, source.source_id) : null;
  const threadId = source.thread_id ?? linked?.thread_id ?? null;
  let originId: string | undefined;
  if (source.source_kind === 'thread-question') {
    try {
      const identity = JSON.parse(source.source_id);
      if (Array.isArray(identity) && typeof identity[0] === 'string') originId = identity[0];
    } catch {
      /* unavailable source identity */
    }
  }
  const origin = originId
    ? await getDb().get<Candidate & { session_id: string; thread_id: string | null }>(
        `SELECT a.id,a.name,a.folder,s.id AS session_id,s.thread_id,s.messaging_group_id,
      m.platform_id,m.name AS channel_name,m.channel_type,0 AS priority
      FROM sessions s JOIN agent_groups a ON a.id=s.agent_group_id
      LEFT JOIN messaging_groups m ON m.id=s.messaging_group_id
      WHERE s.id=? AND s.agent_group_id=? AND a.workgroup_id=?`,
        originId,
        source.agent_group_id,
        source.workgroup_id,
      )
    : undefined;
  const synthetic = !!threadId && (threadId.startsWith('session:') || threadId.startsWith('system:'));
  const channelKey = synthetic
    ? (origin?.platform_id ?? source.channel_key)
    : threadId
      ? await threadPlatformId(threadId)
      : source.channel_key;
  const rows = await getDb().all<Candidate>(
    `SELECT a.id,a.name,a.folder,m.id AS messaging_group_id,m.platform_id,m.name AS channel_name,m.channel_type,
      COALESCE(w.priority,0) AS priority FROM messaging_group_agents w
      JOIN agent_groups a ON a.id=w.agent_group_id JOIN messaging_groups m ON m.id=w.messaging_group_id
      WHERE a.workgroup_id=? ORDER BY COALESCE(w.priority,0) DESC,a.name ASC,a.id ASC,m.id ASC`,
    source.workgroup_id,
  );
  const normalize = (s: string) => s.replace(/^#/, '').trim().toLowerCase();
  const visibleRows = rows.filter((r) => groupVisible(ctx, r.id));
  const matched = visibleRows.filter(
    (r) =>
      r.platform_id === channelKey ||
      (!threadId && !!channelKey && normalize(r.channel_name ?? '') === normalize(channelKey)),
  );
  const channels = new Set(matched.map((r) => r.platform_id));
  const result: Destination = {
    thread_id: threadId,
    channel_name: null,
    default_agent_group_id: null,
    default_reason: null,
    error: null,
    candidates: [],
  };
  // Synthetic task conversations are their original session, not a platform
  // thread. Preserve their existing reply path without manufacturing a channel.
  if (
    synthetic &&
    origin &&
    (threadId?.startsWith('system:') || channels.size !== 1) &&
    groupVisible(ctx, origin.id) &&
    (await canSend(ctx.user.id, origin.id)).ok
  ) {
    return {
      ...result,
      candidates: [origin],
      channel_name: origin.channel_name ?? source.context,
      default_agent_group_id: origin.id,
      default_reason: 'origin',
      session_thread_id: origin.thread_id,
    };
  }
  if (channels.size !== 1)
    return { ...result, error: channels.size ? 'ambiguous_source_channel' : 'source_channel_unavailable' };
  result.channel_name = matched[0]!.channel_name ?? matched[0]!.platform_id;
  for (const r of matched) {
    if (
      !groupVisible(ctx, r.id) ||
      !(await canSend(ctx.user.id, r.id)).ok ||
      result.candidates.some((c) => c.id === r.id)
    )
      continue;
    result.candidates.push(origin?.id === r.id ? { ...r, session_id: origin.session_id } : r);
  }
  const exactAgent = result.candidates.find((r) => r.id === source.agent_group_id);
  const ownerMatches = exactAgent
    ? [exactAgent]
    : result.candidates.filter((r) => !!source.owner_hint && ownerMatchesAgent(source.owner_hint, r));
  if (origin) result.session_thread_id = origin.thread_id;
  const chosen = ownerMatches.length === 1 ? ownerMatches[0] : result.candidates[0];
  result.default_agent_group_id = chosen?.id ?? null;
  result.default_reason = !chosen
    ? null
    : ownerMatches.length === 1
      ? source.source_kind === 'thread-question'
        ? 'origin'
        : 'owner'
      : 'channel_default';
  if (!chosen) result.error = 'no_eligible_agent';
  return result;
}

export type Creation = {
  messaging_group_id: string;
  platform_id: string;
  channel_type: string;
  phase: 'ready' | 'posting_parent' | 'parent_posted' | 'creating_thread' | 'thread_created';
  parent_id?: string;
};
export interface CreationDeps {
  adapter?: typeof getChannelAdapter;
  session?: typeof resolveSession;
}

/** Creation intent is durable before external IO. An interrupted non-idempotent
 * platform operation is never blindly repeated. IDs saved after each successful
 * stage permit subsequent session/delivery retries without another platform post. */
export async function prepareDestination(
  source: SourceDecision,
  record: ReviewRecord,
  deps: CreationDeps = {},
): Promise<ReviewRecord['dispatch']> {
  const dispatch = record.dispatch!;
  const persist = async () => {
    const row = await readReview(source.id);
    const current = readRecord(row);
    if (!row || current.dispatch?.key !== dispatch.key) throw new SignalError(409, 'dispatch_reservation_changed');
    current.dispatch = dispatch;
    await saveReview(source, row.version, current);
  };
  const creation = dispatch.creation;
  if (creation?.phase === 'ready' && !dispatch.thread_id) {
    const linked = await readItemThread(source.workgroup_id, source.source_id);
    if (linked) {
      if ((await threadPlatformId(linked.thread_id)) !== creation.platform_id)
        throw new SignalError(409, 'source_thread_changed');
      dispatch.thread_id = linked.thread_id;
      creation.phase = 'thread_created';
      await persist();
    }
  }
  if (creation && !dispatch.thread_id) {
    if (creation.phase === 'posting_parent' || creation.phase === 'creating_thread')
      throw new SignalError(409, 'thread_creation_uncertain_reconciliation_required');
    const adapter = (deps.adapter ?? getChannelAdapter)(creation.channel_type);
    if (!adapter?.postParent || !adapter.createThread) throw new SignalError(409, 'channel_cannot_open_threads');
    if (creation.phase === 'ready') {
      creation.phase = 'posting_parent';
      await persist();
      const parent = await adapter
        .postParent(
          creation.platform_id,
          `Observatory decision: ${source.question.slice(0, 500)}${source.source_url ? `\n${source.source_url}` : ''}`,
        )
        .catch(() => {
          throw new SignalError(503, 'thread_creation_uncertain_reconciliation_required');
        });
      creation.parent_id = parent.messageId;
      creation.phase = 'parent_posted';
      await persist();
    }
    if (creation.phase === 'parent_posted') {
      creation.phase = 'creating_thread';
      await persist();
      const thread = await adapter
        .createThread(
          creation.platform_id,
          creation.parent_id!,
          source.question.slice(0, 80),
          `Decision source: ${source.source_id}${source.source_url ? `\n${source.source_url}` : ''}\n${source.context.slice(0, 1500)}`,
        )
        .catch(() => {
          throw new SignalError(503, 'thread_creation_uncertain_reconciliation_required');
        });
      dispatch.thread_id = thread.threadId.includes(':')
        ? thread.threadId
        : `${creation.platform_id}:${thread.threadId}`;
      creation.phase = 'thread_created';
      await persist();
    }
  }
  if (creation && dispatch.thread_id && source.source_kind === 'release-item') {
    const linked = await claimItemThread(source.workgroup_id, source.source_id, dispatch.thread_id, dispatch.user_id);
    if (linked !== dispatch.thread_id) throw new SignalError(409, 'source_thread_changed');
  }
  if (!dispatch.session_id) {
    if (!dispatch.thread_id || !dispatch.messaging_group_id) throw new SignalError(409, 'destination_unavailable');
    // A console decision explicitly targets this conversation, including when
    // the normal ingress wiring uses shared sessions. Never redirect its reply.
    const boundThread = dispatch.session_thread_id !== undefined ? dispatch.session_thread_id : dispatch.thread_id;
    const { session } = await (deps.session ?? resolveSession)(
      dispatch.agent_group_id,
      dispatch.messaging_group_id,
      boundThread,
      'per-thread',
    );
    if (
      session.thread_id !== boundThread ||
      session.messaging_group_id !== dispatch.messaging_group_id ||
      session.agent_group_id !== dispatch.agent_group_id
    )
      throw new SignalError(409, 'session_destination_mismatch');
    dispatch.session_id = session.id;
    await persist();
  }
  return dispatch;
}
