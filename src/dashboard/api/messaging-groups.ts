/**
 * GET /dashboard/api/messaging-groups — list every messaging group, gated to
 * the Scheduled Tasks Board's mutation tier (owner or global admin).
 *
 * Messaging groups aren't authz-scoped by workgroup the way agent_group_ids
 * are (see groups.ts) — there's no per-messaging-group workgroup mapping to
 * filter on. The Scheduled Tasks Board move-target dropdown (§obs.C.6,
 * ScheduledDrawer.tsx's MoveForm via dashboard/src/lib/api.ts's
 * listMessagingGroups) is this list's ONLY consumer (grep-confirmed across
 * dashboard/ and every server-side route) and move preview/execute are
 * already gated to `canManageScheduled` — owner/global-admin only
 * (scheduled-shared.ts:39-41) — and 404 for anyone else
 * (scheduled-move.ts:249). Without the same gate here, a workgroup-scoped
 * member or admin who can never move a task could still read every OTHER
 * workgroup's channel names and platform ids off this endpoint. Gating the
 * whole list on that tier closes the read without inventing a second,
 * unneeded scoping model. A caller who fails the gate gets an empty list
 * (200) rather than 404 — matching groups.ts's existing scoped-empty
 * precedent (`ctx.scopes.allowed_group_ids.length === 0` → `[]`) and the
 * shape MoveForm already renders as empty, disabled selects.
 *
 * `name` is nullable in the DB (DMs / channels the adapter never named), so
 * the fallback label is computed here rather than pushed onto every client.
 */
import { getAllMessagingGroups } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';
import { canManageScheduled } from './scheduled-shared.js';

export const messagingGroupsListHandler: AuthHandler = async (_req, _params, ctx) => {
  if (!(await canManageScheduled(ctx.user.id))) {
    return new Response(JSON.stringify({ messaging_groups: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let rows: { id: string; name: string }[];
  try {
    rows = (await getAllMessagingGroups()).map((mg) => ({
      id: mg.id,
      name: mg.name ?? `${mg.channel_type}:${mg.platform_id}`,
    }));
  } catch (err) {
    log.warn('messagingGroupsListHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ messaging_groups: rows }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
