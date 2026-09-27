import type { AgentGroupMember } from '../../../types.js';
import { withRawDb } from '../../../db/central-lease.js';
import { getDb } from '../../../db/connection.js';
import { equivalentSlackUserIds } from '../../../slack-user-identity.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

/**
 * Constants so `grant.ts` can run the write through `withRawDb` in the same
 * lease block as its authority re-check.
 */
export const ADD_MEMBER_SQL = `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)
       ON CONFLICT (user_id, agent_group_id) DO NOTHING`;
export const REMOVE_MEMBER_SQL = 'DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?';

export async function addMember(row: AgentGroupMember): Promise<void> {
  await getDb().run(ADD_MEMBER_SQL, row);
}

export async function getMembers(agentGroupId: string): Promise<AgentGroupMember[]> {
  return getDb().all<AgentGroupMember>(
    'SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at',
    agentGroupId,
  );
}

const MEMBERSHIP_ROW_SQL = 'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1';

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 *
 * ⚠️  Synchronous and lease-only: reads through `withRawDb`, so it works only
 * inside a `withCentralSync` block. See `user-roles.ts`.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  return hasMembershipRow(userId, agentGroupId);
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. Lease-only. */
export function hasMembershipRow(userId: string, agentGroupId: string): boolean {
  return withRawDb((db) => db.prepare(MEMBERSHIP_ROW_SQL).get(userId, agentGroupId) !== undefined);
}

/**
 * Resolves same-workspace Slack sibling identities, so a member messaging from
 * a sibling adapter keeps their membership. Synchronous, lease-only.
 */
export function getMembershipGroupIds(userId: string): string[] {
  const ids = equivalentSlackUserIds(userId);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = withRawDb(
    (db) =>
      db
        .prepare(`SELECT DISTINCT agent_group_id FROM agent_group_members WHERE user_id IN (${placeholders})`)
        .all(...ids) as { agent_group_id: string }[],
  );
  return rows.map((r) => r.agent_group_id);
}

/**
 * True if the user (or an equivalent same-workspace identity) has any
 * membership row.
 *
 * Sequential, not `Promise.all`: the driver forbids concurrent central statements.
 */
export async function hasAnyMembership(userId: string): Promise<boolean> {
  for (const candidate of equivalentSlackUserIds(userId)) {
    const row = await getDb().get('SELECT 1 FROM agent_group_members WHERE user_id = ? LIMIT 1', candidate);
    if (row) return true;
  }
  return false;
}
