/**
 * GET /dashboard/api/messaging-groups, gated to the Scheduled Tasks Board's mutation tier (owner or global admin).
 * Messaging groups have no workgroup scoping, and this list's only consumer is the move-target dropdown, which is
 * already gated to that tier; without the gate a scoped member could read every other workgroup's channel names and
 * platform ids. A caller failing the gate gets an empty list (200), matching groups.ts. `name` is nullable, so the
 * fallback label is computed here.
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
