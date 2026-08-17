/**
 * Assign write path for `POST /dashboard/api/observatory/assign`.
 *
 * Turns a release-board item into a one-shot task owned by a chosen agent
 * group, routed to the CHANNEL THE ITEM NAMES — a fresh thread in the right
 * room, never a steer into whatever conversation the agent happens to be in
 * (an assignment that barges into an unrelated thread is an interruption, not
 * an assignment — that shape was rejected explicitly).
 *
 * Security shape, deliberate: the client sends three IDs and nothing else.
 * The task prompt is composed HERE from fields read out of the workgroup's own
 * release-state.json — a browser can choose which item and which agent, but
 * can never author a single line of what the agent is told to do. Role gate
 * matches steer's (owner / global admin / admin of the target group; members
 * cannot). Routing requires the target agent group to be WIRED to the item's
 * channel, so an assignment can't make an agent speak somewhere it doesn't
 * belong.
 */
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { dispatch } from '../cli/dispatch.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { readReleaseState, personaName, roomPermalink } from './api/observatory.js';
import type { AgentGroup } from '../types.js';
import type { AuthHandler } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// One assignment per item per window. Two clicks on a slow connection should
// not spawn two tasks telling two threads to take the same work.
const ASSIGN_DEDUPE_MS = 10 * 60 * 1000;
const recentAssigns = new Map<string, number>();

/** Test-only, same precedent as steer's _resetRateLimitForTesting. */
export function _resetAssignDedupeForTesting(): void {
  recentAssigns.clear();
}

function canAssign(userId: string, agentGroupId: string): { ok: boolean; reason?: string } {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return { ok: true };
  }
  if (isMember(userId, agentGroupId)) return { ok: false, reason: 'member_role_cannot_assign' };
  return { ok: false, reason: 'not_found' };
}

/** '#Qa-Room' / 'qa-room' → 'qa-room', for name matching. */
const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase();

export const observatoryAssignHandler: AuthHandler = async (req, _params, ctx) => {
  let body: { workgroupId?: string; itemId?: string; agentGroupId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const { workgroupId, itemId, agentGroupId } = body;
  if (!workgroupId || !itemId || !agentGroupId) {
    return json(400, { error: 'workgroupId, itemId and agentGroupId are required' });
  }

  const role = canAssign(ctx.user.id, agentGroupId);
  if (!role.ok) return json(role.reason === 'not_found' ? 404 : 403, { error: role.reason });

  const agent = getDb()
    .prepare(`SELECT * FROM agent_groups WHERE id = ? AND workgroup_id = ?`)
    .get(agentGroupId, workgroupId) as AgentGroup | undefined;
  if (!agent) return json(404, { error: 'agent_group_not_in_workgroup' });

  const state = readReleaseState(workgroupId);
  const item = state?.items.find((i) => i.id === itemId);
  if (!item) return json(404, { error: 'item_not_on_board' });
  if (!item.channel) return json(409, { error: 'item_has_no_channel' });

  const dedupeKey = `${workgroupId}:${itemId}`;
  const last = recentAssigns.get(dedupeKey);
  if (last && Date.now() - last < ASSIGN_DEDUPE_MS) return json(429, { error: 'recently_assigned' });

  // The channel must be one this agent group is actually wired to — same join
  // the floor itself is built from, so "assignable" and "on the map" agree.
  const mg = getDb()
    .prepare(
      `SELECT mg.id, mg.name, mg.platform_id, mg.channel_type
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as { id: string; name: string; platform_id: string; channel_type: string }[];
  const target = mg.find((m) => channelKey(m.name) === channelKey(item.channel!));
  if (!target) return json(409, { error: 'agent_not_wired_to_channel', channel: item.channel });

  // Composed entirely from board fields — nothing client-authored reaches the
  // prompt. The claim is the fleet's real ownership record; release-state.json
  // stays its author's file and picks the new owner up from the claim.
  const slug = itemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const who = ctx.user.display_name ?? ctx.user.id;
  const prompt =
    `[assigned from the Observatory by ${who}] Take ownership of ${item.id} — "${item.title}".\n` +
    `kind: ${item.kind}` +
    (item.url ? ` · ${item.url}` : '') +
    ` · current owner: ${item.owner ?? 'nobody'}` +
    (item.nextAction ? `\nnext action on the board: ${item.nextAction}` : '') +
    `\n\n1. REQUIRED: your FIRST message in this channel must open with exactly this line, before anything else you say: "Assigned by ${who} via the Observatory —". Everyone in the room should know where this came from without asking.\n` +
    `2. Claim it: \`bash /app/skills/work-claims/claim.sh take ${slug} 8 "<one-line note>" --source observatory-assign\` — and check for a twin before your first commit.\n` +
    `3. Do the work, or the named next action if one is stated.\n` +
    `4. Report the outcome in this channel. If you cannot take it, say so HERE naming exactly what blocks you and who owns that blocker — an assignment that ends in silence is the failure this button exists to end.`;

  const res = await dispatch(
    {
      id: `assign-${Date.now()}`,
      command: 'tasks-create',
      args: {
        group: agentGroupId,
        name: `assign ${slug}`,
        prompt,
        process_after: new Date().toISOString(),
        messaging_group: target.id,
      },
    },
    { caller: 'host' },
  );

  if (!res.ok) {
    log.warn('observatory assign: task create failed', { itemId, agentGroupId, error: res });
    return json(502, { error: 'task_create_failed' });
  }

  recentAssigns.set(dedupeKey, Date.now());
  const seriesId = (res.data as { series_id?: string } | null | undefined)?.series_id ?? null;
  log.info('observatory assign', {
    userId: ctx.user.id,
    itemId,
    agentGroupId,
    channel: target.name,
    seriesId,
  });
  return json(200, {
    ok: true,
    seriesId,
    channel: target.name,
    // The name the room knows this agent by, not the infrastructure one — the
    // confirmation should echo the agent the operator actually picked.
    agent: await personaName(agent),
    channelUrl: roomPermalink(target.channel_type, target.platform_id),
    // Sweep admits within ~60s, plus container boot. Deliberately coarse.
    etaSeconds: 120,
  });
};
