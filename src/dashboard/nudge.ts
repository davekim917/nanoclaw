/**
 * Push-it-forward write path for `POST /dashboard/api/observatory/nudge`.
 *
 * The claims board shows work that stopped moving — parked, stale, escalated.
 * This turns one of those rows into a one-shot task telling an agent to move
 * it, routed INTO THE CLAIM'S OWN THREAD. The context for a stalled claim lives
 * in the thread it was worked in; a nudge posted anywhere else is a barge-in
 * that starts by asking the room to re-explain itself.
 *
 * Which is why a claim with no `thread_id` gets a 409 rather than a guessed
 * room. There is no honest fallback: picking any wired channel is exactly the
 * barge-in above. The cure is upstream — `claim.sh thread <slug>` backfills the
 * missing id — and the 409 body says so.
 *
 * Security shape is assign.ts's, deliberately: the client sends three IDs, the
 * prompt is composed HERE from the claim file, and the role gate is literally
 * assign's `canAssign`. A browser chooses which claim and which agent; it can
 * never author a line of what the agent is told.
 */
import { readClaims } from '../claims-board.js';
import { dispatch } from '../cli/dispatch.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { buildNudgePrompt, NUDGE_TASK_QUIET_ARGS } from '../modules/claims/self-heal.js';
import { refuseUnassignableInWorkgroup } from './assign.js';
import { threadPermalink, threadPlatformId } from './api/observatory.js';
import type { AuthHandler } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// One nudge per claim per window — two clicks must not post the same demand twice.
const NUDGE_DEDUPE_MS = 10 * 60 * 1000;
const recentNudges = new Map<string, number>();

/** Test-only, same precedent as _resetAssignDedupeForTesting. */
export function _resetNudgeDedupeForTesting(): void {
  recentNudges.clear();
}

export const observatoryNudgeHandler: AuthHandler = async (req, _params, ctx) => {
  let body: { workgroupId?: string; claimSlug?: string; agentGroupId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const { workgroupId, claimSlug, agentGroupId } = body;
  if (!workgroupId || !claimSlug || !agentGroupId) {
    return json(400, { error: 'workgroupId, claimSlug and agentGroupId are required' });
  }

  const refusal = await refuseUnassignableInWorkgroup(ctx.user.id, agentGroupId, workgroupId);
  if (refusal) return refusal;

  // Same read the board is rendered from, so "nudgeable" and "on the board"
  // agree by construction — including its classification of state/staleness.
  const claim = readClaims(workgroupId, Date.now()).find((c) => c.slug === claimSlug);
  if (!claim) return json(404, { error: 'claim_not_found' });
  if (claim.state === 'paused') {
    return json(409, {
      error: 'claim_is_paused',
      hint: 'resume it with an explicit operator instruction before creating a nudge',
    });
  }
  if (!claim.threadId) {
    return json(409, {
      error: 'claim_has_no_thread',
      hint: 'the worker must backfill via claim.sh thread',
    });
  }

  const dedupeKey = `${workgroupId}:${claimSlug}`;
  const last = recentNudges.get(dedupeKey);
  if (last && Date.now() - last < NUDGE_DEDUPE_MS) return json(429, { error: 'recently_nudged' });

  // The thread's channel must be one this agent group is wired to — a nudge
  // can't make an agent speak somewhere it doesn't belong (assign's rule).
  const target = await getDb().get<{ id: string; name: string }>(
    `SELECT mg.id, mg.name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
    agentGroupId,
    await threadPlatformId(claim.threadId),
  );
  if (!target) return json(409, { error: 'agent_not_wired_to_thread_channel' });

  // Composed entirely from the claim file — nothing client-authored reaches it.
  // The contract itself lives in buildNudgePrompt so the operator-clicked nudge
  // and the autonomous one (modules/claims/self-heal.ts) cannot drift; this used
  // to be a second copy of the same text, and it drifted the moment the
  // announce-what-you-did clause was removed from one of them.
  const who = ctx.user.display_name ?? ctx.user.id;
  const threadUrl = await threadPermalink(claim.threadId);
  const prompt = buildNudgePrompt(claim, `Pushed forward by ${who} via the Observatory`, threadUrl);

  const res = await dispatch(
    {
      id: `nudge-${Date.now()}`,
      command: 'tasks-create',
      args: {
        group: agentGroupId,
        name: `push ${claim.slug}`,
        prompt,
        process_after: new Date().toISOString(),
        messaging_group: target.id,
        thread_id: claim.threadId,
        ...NUDGE_TASK_QUIET_ARGS,
      },
    },
    { caller: 'host' },
  );

  if (!res.ok) {
    log.warn('observatory nudge: task create failed', { claimSlug, agentGroupId, error: res });
    return json(502, { error: 'task_create_failed' });
  }

  recentNudges.set(dedupeKey, Date.now());
  const seriesId = (res.data as { series_id?: string } | null | undefined)?.series_id ?? null;
  log.info('observatory nudge', { userId: ctx.user.id, claimSlug, agentGroupId, channel: target.name, seriesId });
  return json(200, { ok: true, seriesId, threadUrl });
};
