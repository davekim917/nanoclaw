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
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { canAssign } from './assign.js';
import { threadPermalink, threadPlatformId } from './api/observatory.js';
import type { AgentGroup } from '../types.js';
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

  const role = canAssign(ctx.user.id, agentGroupId);
  if (!role.ok) return json(role.reason === 'not_found' ? 404 : 403, { error: role.reason });

  const agent = getDb()
    .prepare(`SELECT * FROM agent_groups WHERE id = ? AND workgroup_id = ?`)
    .get(agentGroupId, workgroupId) as AgentGroup | undefined;
  if (!agent) return json(404, { error: 'agent_group_not_in_workgroup' });

  // Same read the board is rendered from, so "nudgeable" and "on the board"
  // agree by construction — including its classification of state/staleness.
  const claim = readClaims(workgroupId, Date.now()).find((c) => c.slug === claimSlug);
  if (!claim) return json(404, { error: 'claim_not_found' });
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
  const target = getDb()
    .prepare(
      `SELECT mg.id, mg.name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
    )
    .get(agentGroupId, threadPlatformId(claim.threadId)) as { id: string; name: string } | undefined;
  if (!target) return json(409, { error: 'agent_not_wired_to_thread_channel' });

  // Composed entirely from the claim file — nothing client-authored reaches it.
  const who = ctx.user.display_name ?? ctx.user.id;
  const hours = Math.max(0, Math.round(claim.staleMs / 3600000));
  const prompt =
    `Pushed forward by ${who} via the Observatory — the claim \`${claim.slug}\` has stopped moving.\n` +
    // staleMs means "since parked" for a parked claim and "past TTL" otherwise —
    // label it honestly rather than telling a parked claim it is overdue.
    `state: ${claim.state} · ${hours}h ${claim.state === 'parked' ? 'since parked' : 'past due'} · owner: ${claim.owner}` +
    (claim.escalated ? ' · already escalated once' : '') +
    (claim.note ? `\nnote on the claim: ${claim.note}` : '') +
    `\n\nDo ONE of these three, in this thread, before this task ends — there is no fourth option:\n` +
    `1. Finish it, and say so here.\n` +
    `2. Release it — \`bash /app/skills/work-claims/claim.sh release ${claim.slug}\`, or ` +
    `\`park ${claim.slug} "<what a successor needs to know>"\` if it needs a new owner — then say here that it is free.\n` +
    `3. Post what BLOCKS you, naming the human who owns that blocker.\n\n` +
    `An item neither moved nor released by the end of this task is the failure this button exists to end.`;

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
  return json(200, { ok: true, seriesId, threadUrl: threadPermalink(claim.threadId) });
};
