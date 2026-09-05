/**
 * Assign write path for `POST /dashboard/api/observatory/assign`.
 *
 * The console's verb for an OWNERLESS row. DESIGN.md §2: an unowned work item
 * "has no thread yet, and Assign is the verb that creates the thread". This is
 * that verb: it turns an attention item into a one-shot task owned by a chosen
 * agent group, routed to THE CHANNEL THE ITEM'S SOURCE DECLARED — a fresh
 * thread in the right room, never a steer into whatever conversation the agent
 * happens to be in (an assignment that barges into an unrelated thread is an
 * interruption, not an assignment — that shape was rejected explicitly).
 *
 * ## Why this endpoint and not `POST /threads/:id/message`
 *
 * That path is the console's primitive for every row that HAS a thread, and it
 * cannot serve these: it resolves the room by parsing the thread id, and an
 * attention item's id is a dedupe key with a `board:` prefix, explicitly never
 * a thread id (`ATTENTION_ITEM_PREFIX`). Running one through `threadChannelKey`
 * yields a channel nothing is wired to, so the send refuses — which is exactly
 * what an adversarial review found: the row rendered a selector with no handler
 * that could ever succeed behind it.
 *
 * The two paths therefore split on a real distinction, not a historical one:
 * a row with a thread gets a message in that thread, a row without one gets a
 * task that opens the conversation. DESIGN.md §10's "reconciling two steer
 * paths" is settled that way rather than by merging them — merged, the message
 * path would have to grow a "when the thread does not exist, spawn a task"
 * branch that only ever fires for this one row type.
 *
 * ## Security shape, deliberate
 *
 * The client sends two ids and nothing else, and the server re-derives every
 * fact behind them:
 *
 *  - **Which item.** Resolved through `selectScopedAttentionItems`, the SAME
 *    producer the row the operator clicked came from — not a raw board read.
 *    A board read admits items the console never showed (already claimed, next
 *    mover is an agent, shipped since the snapshot); those are not ownerless
 *    and must not be assignable. It also applies §2a's scope intersection, so
 *    an item in a workgroup this caller cannot see resolves to ABSENT, never a
 *    distinguishable refusal.
 *  - **Which room.** Off the item's own `channel_key`, which its attention
 *    source declared. A browser can choose which item and which agent; it can
 *    never redirect where the work lands.
 *  - **Which agents are eligible.** Re-derived from `messaging_group_agents`
 *    through `wiredAgentsByChannel()` — byte-for-byte the join that produced
 *    `ThreadSummary.assignable_agents`, so what the row offered and what the
 *    server accepts cannot disagree. An agent not wired to the room cannot be
 *    made to speak in it.
 *  - **What the agent is told.** Composed HERE out of board fields. A browser
 *    cannot author a single line of it.
 *
 * The privilege decision itself is not in this file: it is
 * `observatory-assign-guard.ts`, consulted through `guard()` like every other
 * privileged action. Scope stays here, because §2a requires an out-of-scope
 * target to be indistinguishable from a missing one and a guard can only ever
 * answer "denied".
 */
import { getAgentGroup } from '../db/agent-groups.js';
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
import type { AuthHandler, AuthedRequestContext } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * How long an assignment holds the item against a second assign.
 *
 * Re-exported from `item-assignments.ts`, which owns the definition so the
 * write side here and the read side in `api/threads.ts` share exactly one
 * constant. See that module for why.
 */
export { ASSIGN_DEDUPE_MS };

/**
 * The role gate for every Observatory write that makes an agent act. Exported so
 * nudge.ts and observatory-steer.ts draw the SAME line — one definition, so the
 * buttons can never disagree about who may point an agent at work.
 *
 * This path no longer calls it directly: its allow condition is
 * `hasAdminPrivilege`, which is what `observatory-assign-guard.ts` decides on.
 * The `member` distinction below is the part a guard cannot express — §2a wants
 * a stranger to see absence, while a member of the group is someone the surface
 * may honestly tell "not you".
 */
export function canAssign(userId: string, agentGroupId: string): { ok: boolean; reason?: string } {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return { ok: true };
  }
  if (isMember(userId, agentGroupId)) return { ok: false, reason: 'member_role_cannot_assign' };
  return { ok: false, reason: 'not_found' };
}

/**
 * The item's natural id, however the client spelled it.
 *
 * A console row's `thread_id` is the STAMPED id (`board:<natural>`); an older
 * caller sends the natural one. Both name the same item, so both are accepted
 * and the natural form is what reaches the DB — see migration 058 on why the
 * prefix is never stored.
 */
function naturalItemId(raw: string): string {
  return raw.startsWith(ATTENTION_ITEM_PREFIX) ? raw.slice(ATTENTION_ITEM_PREFIX.length) : raw;
}

/** A slug for the claim the receiving agent is told to take. */
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
 * The assign decision and write, with the attention feed's filesystem roots
 * injectable.
 *
 * Split out of the handler for the same reason `sendThreadMessage` is: the
 * board lives on disk, and a test that cannot point the reader at a fixture
 * would have to mock the producer — which is precisely the thing this path
 * must NOT do, since re-deriving the item from the real producer is half its
 * security argument.
 */
export async function assignAttentionItem(
  body: AssignBody,
  ctx: AuthedRequestContext,
  env: AttentionSourceEnv = {},
): Promise<Response> {
  const rawItemId = (body.itemId ?? '').trim();
  const agentGroupId = (body.agentGroupId ?? '').trim();
  if (!rawItemId || !agentGroupId) return json(400, { error: 'itemId and agentGroupId are required' });

  // §2a, first: an agent group outside the caller's ceiling is ABSENT. Before
  // any lookup that could time-differ, and never a 403.
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(agentGroupId)) {
    return json(404, { error: 'not_found' });
  }

  const now = Date.now();
  const itemId = naturalItemId(rawItemId);
  // The stamped id is what `selectScopedAttentionItems` matches on, and the
  // intersection with the caller's scope happens inside it — an unknown item
  // and an out-of-scope one both come back as an empty list.
  const [item] = selectScopedAttentionItems(
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

  // The SAME join that produced the row's `assignable_agents`. Re-derived, never
  // trusted from the request.
  const wired = (await wiredAgentsByChannel()).get(item.channel_key) ?? [];
  const target = wired.find((a) => a.agent_group_id === agentGroupId) ?? null;

  const payload: ObservatoryAssignPayload = {
    agentGroupId,
    channelKey: item.channel_key,
    wiredToItemChannel: target !== null,
  };
  // Under the central lease: `guard()`'s reads are raw by design (seam 3
  // §4.5 I-1).
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
    // Two refusals that must not look alike. "Not wired to this room" is a
    // state the operator can act on — pick a different agent — and the row
    // already told them which agents those are. Everything else (no privilege
    // here) collapses to §2a's absence so the surface never discloses that an
    // agent group exists.
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

  // RESERVE BEFORE DISPATCH. A losing double-click fails here, having queued
  // nothing — a record written after its side effect cannot prevent the side
  // effect happening twice.
  if (!(await reserveItemAssignment(item.workgroupId, itemId, agentGroupId, ctx.user.id, now, ASSIGN_DEDUPE_MS))) {
    return json(409, { error: 'already_assigned' });
  }

  // Composed entirely from board fields — nothing client-authored reaches the
  // prompt. The claim is the fleet's real ownership record; the item's own
  // source stays its author's file and picks the new owner up from the claim.
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

  // `getMessagingGroup` stays synchronous forever (seam 3 §4.2 — it is called
  // from inside raw transaction closures elsewhere); no await here.
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
    // The name the room knows this agent by, not the infrastructure one — the
    // confirmation should echo the agent the operator actually picked.
    agent: await personaName(agent),
    channelUrl: room ? roomPermalink(room.channel_type, room.platform_id) : null,
    // Sweep admits within ~60s, plus container boot. Deliberately coarse.
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
