/**
 * GET /dashboard/api/groups — list agent groups visible to the caller.
 *
 * Owners and global admins (`ctx.scopes.no_filter === true`) see every row in
 * `agent_groups`. Scoped admins and members see only the groups enumerated in
 * `ctx.scopes.allowed_group_ids`. Out-of-scope ids are not leaked.
 *
 * Used by the SPA's group-filter dropdown — the brand-line header in
 * `dashboard/src/views/InboxBoard.tsx` morphs to display the active group's
 * name when a filter is selected.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AuthHandler } from '../router.js';

interface GroupRow {
  id: string;
  name: string;
}

export const groupsListHandler: AuthHandler = async (_req, _params, ctx) => {
  let rows: GroupRow[];
  try {
    if (ctx.scopes.no_filter) {
      rows = getDb().prepare('SELECT id, name FROM agent_groups ORDER BY name').all() as GroupRow[];
    } else if (ctx.scopes.allowed_group_ids.length === 0) {
      rows = [];
    } else {
      const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
      rows = getDb()
        .prepare(`SELECT id, name FROM agent_groups WHERE id IN (${placeholders}) ORDER BY name`)
        .all(...ctx.scopes.allowed_group_ids) as GroupRow[];
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
