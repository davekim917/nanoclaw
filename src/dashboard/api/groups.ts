/**
 * GET /dashboard/api/groups: agent groups visible to the caller. `no_filter` callers see every row; scoped callers
 * only `allowed_group_ids`. `workgroup_id` rides along so the client can resolve a workgroup's siblings without a
 * second request.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

interface GroupRow {
  id: string;
  name: string;
  workgroup_id: string | null;
}

export const groupsListHandler: AuthHandler = async (_req, _params, ctx) => {
  let rows: GroupRow[];
  try {
    if (ctx.scopes.no_filter) {
      rows = await getDb().all<GroupRow>('SELECT id, name, workgroup_id FROM agent_groups ORDER BY name');
    } else if (ctx.scopes.allowed_group_ids.length === 0) {
      rows = [];
    } else {
      const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
      rows = await getDb().all<GroupRow>(
        `SELECT id, name, workgroup_id FROM agent_groups WHERE id IN (${placeholders}) ORDER BY name`,
        ...ctx.scopes.allowed_group_ids,
      );
    }
  } catch (err) {
    log.warn('groupsListHandler: DB error', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ groups: rows }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
