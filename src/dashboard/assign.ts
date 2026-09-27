/**
 * Assign write path (`POST /dashboard/api/observatory/assign`): turns an ownerless attention item into a one-shot
 * task owned by a chosen agent group, routed to the channel the item's source declared: a fresh thread in the right
 * room, never a steer into whatever conversation the agent is in.
 * Not `POST /threads/:id/message`: an attention item id is a `board:` dedupe key, never a thread id, so that path
 * cannot resolve a wired room for it.
 * The client sends two ids; the server re-derives everything else. The item comes from `selectScopedAttentionItems`
 * (the producer the row came from, never a raw board read, which admits items that are not ownerless) with scope
 * applied, so an out-of-scope item is simply absent. The room comes from the item's declared `channel_key`. Eligible
 * agents come from `wiredAgentsByChannel()`, the join behind `assignable_agents`. The prompt is composed here from
 * board fields. Privilege is decided by `observatory-assign-guard.ts`; scope stays here because an out-of-scope
 * target must be indistinguishable from a missing one.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { ATTENTION_ITEM_PREFIX, type AttentionSourceEnv } from '../attention-sources.js';
import { dispatch } from '../cli/dispatch.js';
import { withCentralSync } from '../db/central-lease.js';
import { guard } from '../guard/index.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { personaName, roomPermalink } from './api/observatory.js';
import { selectScopedAttentionItems, wiredAgentsByChannel } from './api/threads.js';
import { ASSIGN_DEDUPE_MS, releaseItemAssignment, reserveItemAssignment } from './db/item-assignments.js';
import { observatoryAssign, type ObservatoryAssignPayload } from './observatory-assign-guard.js';
import type { AgentGroup } from '../types.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Owned by `item-assignments.ts` so the write side and `api/threads.ts`'s read side share one constant. */
export { ASSIGN_DEDUPE_MS };

/**
 * The role gate for every Observatory write that makes an agent act; nudge.ts and observatory-steer.ts draw the same
 * line. The `member` distinction is what a guard cannot express: a stranger sees absence, a group member may be told
 * "not you".
 */
function canAssign(userId: string, agentGroupId: string): Promise<{ ok: boolean; reason?: string }> {
  // Lease-only role predicates; one block for the whole decision.
  return withCentralSync((): { ok: boolean; reason?: string } => {
    if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
      return { ok: true };
    }
    if (isMember(userId, agentGroupId)) return { ok: false, reason: 'member_role_cannot_assign' };
    return { ok: false, reason: 'not_found' };
  }, 'canAssign');
}

export async function refuseUnassignableInWorkgroup(
  userId: string,
  agentGroupId: string,
  workgroupId: string,
): Promise<Response | null> {
  const role = await canAssign(userId, agentGroupId);
  if (!role.ok) return json(role.reason === 'not_found' ? 404 : 403, { error: role.reason });

  const agent = await getDb().get<AgentGroup>(
    `SELECT * FROM agent_groups WHERE id = ? AND workgroup_id = ?`,
    agentGroupId,
    workgroupId,
  );
  if (!agent) return json(404, { error: 'agent_group_not_in_workgroup' });
  return null;
}

/**
 * Accepts the stamped (`board:<natural>`) or natural id; only the natural form reaches the DB (migration 058 never
 * stores the prefix).
 */
function naturalItemId(raw: string): string {
  return raw.startsWith(ATTENTION_ITEM_PREFIX) ? raw.slice(ATTENTION_ITEM_PREFIX.length) : raw;
}

function claimSlug(itemId: string): string {
  return itemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export interface AssignBody {
  itemId?: string;
  agentGroupId?: string;
  /** Optional narrowing. Absent means "wherever this item is, within my scope". */
  workgroupId?: string;
}

/**
 * The assign decision and write, with the attention feed's roots injectable so tests use a fixture board rather than
 * mocking the producer, whose re-derivation is half this path's security argument.
 */
export async function assignAttentionItem(
  body: AssignBody,
  ctx: AuthedRequestContext,
  env: AttentionSourceEnv = {},
): Promise<Response> {
  const rawItemId = (body.itemId ?? '').trim();
  const agentGroupId = (body.agentGroupId ?? '').trim();
  if (!rawItemId || !agentGroupId) return json(400, { error: 'itemId and agentGroupId are required' });

  // An agent group outside the caller's ceiling is ABSENT, checked before any lookup that could time-differ; never a
  // 403.
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(agentGroupId)) {
    return json(404, { error: 'not_found' });
  }

  const now = Date.now();
  const itemId = naturalItemId(rawItemId);
  // Scope intersection happens inside; unknown and out-of-scope items both come back empty.
  const [item] = await selectScopedAttentionItems(
    ctx,
    {
      workgroupId: body.workgroupId ?? null,
      groupId: null,
      sinceHours: 0,
      threadId: `${ATTENTION_ITEM_PREFIX}${itemId}`,
    },
    now,
    env,
  );
  if (!item) return json(404, { error: 'not_found' });

  // Re-derived, never trusted from the request.
  const wired = (await wiredAgentsByChannel()).get(item.channel_key) ?? [];
  const target = wired.find((a) => a.agent_group_id === agentGroupId) ?? null;

  const payload: ObservatoryAssignPayload = {
    agentGroupId,
    channelKey: item.channel_key,
    wiredToItemChannel: target !== null,
  };
  // Under the central lease: `guard()`'s reads are raw by design.
  const decision = await withCentralSync(
    () =>
      guard(observatoryAssign, {
        actor: { kind: 'human', userId: ctx.user.id },
        resource: { itemId: item.id, workgroupId: item.workgroupId },
        payload,
      }),
    'observatory assign guard',
  );
  if (decision.effect !== 'allow') {
    // "Not wired to this room" is actionable and reported; any other refusal collapses to absence so the surface
    // never discloses that an agent group exists.
    if (!target) {
      return json(409, { error: 'agent_not_wired_to_channel', channel: item.channel_key });
    }
    log.info('observatory assign: refused', {
      itemId: item.id,
      agentGroupId,
      userId: ctx.user.id,
      reason: decision.reason,
    });
    return json(404, { error: 'not_found' });
  }

  const agent = await getAgentGroup(agentGroupId);
  if (!agent) return json(404, { error: 'not_found' });

  // RESERVE BEFORE DISPATCH: a losing double-click fails here having queued nothing.
  if (!(await reserveItemAssignment(item.workgroupId, itemId, agentGroupId, ctx.user.id, now, ASSIGN_DEDUPE_MS))) {
    return json(409, { error: 'already_assigned' });
  }

  // Nothing client-authored reaches the prompt. The claim is the fleet's real ownership record.
  const slug = claimSlug(itemId);
  const who = ctx.user.display_name ?? ctx.user.id;
  const prompt =
    `[assigned from the Observatory by ${who}] Take ownership of ${itemId} — "${item.title}".\n` +
    `source: ${item.sourceKind}` +
    (item.url ? ` · ${item.url}` : '') +
    ` · current owner: ${item.claimOwner ?? 'nobody'}` +
    (item.claimNote ? `\nwhy it is waiting: ${item.claimNote}` : '') +
    `\nnext action on the board: ${item.nextAction}` +
    `\n\n1. REQUIRED: your FIRST message in this channel must open with exactly this line, before anything else you say: "Assigned by ${who} via the Observatory —". Everyone in the room should know where this came from without asking.\n` +
    `2. Claim it: \`bash /app/skills/work-claims/claim.sh take ${slug} 8 "<one-line note>" --source observatory-assign\` — and check for a twin before your first commit.\n` +
    `3. Do the work, or the named next action if one is stated.\n` +
    `4. Report the outcome in this channel. If you cannot take it, say so HERE naming exactly what blocks you and who owns that blocker — an assignment that ends in silence is the failure this button exists to end.`;

  const res = await dispatch(
    {
      id: `assign-${now}`,
      command: 'tasks-create',
      args: {
        group: agentGroupId,
        name: `assign ${slug}`,
        prompt,
        process_after: new Date(now).toISOString(),
        messaging_group: target!.messaging_group_id,
      },
    },
    { caller: 'host' },
  );

  if (!res.ok) {
    // Nothing was queued, so nothing may keep holding the item.
    await releaseItemAssignment(item.workgroupId, itemId);
    log.warn('observatory assign: task create failed', { itemId: item.id, agentGroupId, error: res });
    return json(502, { error: 'task_create_failed' });
  }

  const room = await getMessagingGroup(target!.messaging_group_id);
  const seriesId = (res.data as { series_id?: string } | null | undefined)?.series_id ?? null;
  log.info('observatory assign', {
    userId: ctx.user.id,
    itemId: item.id,
    agentGroupId,
    channel: item.channel_key,
    seriesId,
  });
  return json(200, {
    ok: true,
    seriesId,
    channel: room?.name ?? item.channel_key,
    // The name the room knows this agent by.
    agent: await personaName(agent),
    channelUrl: room ? roomPermalink(room.channel_type, room.platform_id) : null,
    // Sweep admission (~60s) plus container boot. Deliberately coarse.
    etaSeconds: 120,
  });
}

export const observatoryAssignHandler: AuthHandler = async (req, _params, ctx) => {
  let body: AssignBody;
  try {
    body = (await req.json()) as AssignBody;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  try {
    return await assignAttentionItem(body, ctx);
  } catch (err) {
    log.warn('observatoryAssignHandler: failed', { err });
    return json(500, { error: 'internal_error' });
  }
};
