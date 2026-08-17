/**
 * GET /dashboard/api/messaging-groups — list every messaging group.
 *
 * Global, unscoped list (messaging groups aren't authz-scoped the way
 * agent_group_ids are — see groups.ts). Used by the Scheduled Tasks Board
 * move-target dropdown (§obs.C.6): the SPA needs real ids to submit to
 * /scheduled/:key/move, and `name` is nullable in the DB (DMs / channels the
 * adapter never named), so the fallback label is computed here rather than
 * pushed onto every client.
 */
import { getAllMessagingGroups } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

export const messagingGroupsListHandler: AuthHandler = async (_req, _params, _ctx) => {
  let rows: { id: string; name: string }[];
  try {
    rows = getAllMessagingGroups().map((mg) => ({
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
