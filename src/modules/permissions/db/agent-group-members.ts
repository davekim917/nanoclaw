import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { equivalentSlackUserIds } from '../../../slack-user-identity.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export function addMember(row: AgentGroupMember): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)`,
    )
    .run(row);
}

export function removeMember(userId: string, agentGroupId: string): void {
  getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?').run(userId, agentGroupId);
}

export function getMembers(agentGroupId: string): AgentGroupMember[] {
  return getDb()
    .prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at')
    .all(agentGroupId) as AgentGroupMember[];
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export function hasMembershipRow(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}

/**
 * Every agent group the user is a member of, resolving same-workspace Slack
 * sibling identities (see slack-user-identity.ts) so a member who messages
 * from a sibling adapter is not locked out of their own membership.
 */
export function getMembershipGroupIds(userId: string): string[] {
  const ids = equivalentSlackUserIds(userId);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT DISTINCT agent_group_id FROM agent_group_members WHERE user_id IN (${placeholders})`)
    .all(...ids) as { agent_group_id: string }[];
  return rows.map((r) => r.agent_group_id);
}

/** True if the user (or an equivalent same-workspace identity) has any membership row. */
export function hasAnyMembership(userId: string): boolean {
  return equivalentSlackUserIds(userId).some((candidate) => {
    const row = getDb().prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? LIMIT 1').get(candidate);
    return !!row;
  });
}
