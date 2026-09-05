import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { equivalentSlackUserIds } from '../../../slack-user-identity.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export async function addMember(row: AgentGroupMember): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)`,
    row,
  );
}

export async function removeMember(userId: string, agentGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?', userId, agentGroupId);
}

export async function getMembers(agentGroupId: string): Promise<AgentGroupMember[]> {
  return getDb().all<AgentGroupMember>(
    'SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at',
    agentGroupId,
  );
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 *
 * The three role predicates stay SYNCHRONOUS (seam-3 plan §4.5, I-1): they are
 * reached from guard `decide` bodies, which never await. Calling them from an
 * async body needs no `await` and changes nothing about the order of the
 * checks below.
 */
export async function isMember(userId: string, agentGroupId: string): Promise<boolean> {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = await getDb().get(
    'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1',
    userId,
    agentGroupId,
  );
  return !!row;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export async function hasMembershipRow(userId: string, agentGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1',
    userId,
    agentGroupId,
  );
  return !!row;
}

/**
 * Every agent group the user is a member of, resolving same-workspace Slack
 * sibling identities (see slack-user-identity.ts) so a member who messages
 * from a sibling adapter is not locked out of their own membership.
 */
export async function getMembershipGroupIds(userId: string): Promise<string[]> {
  const ids = equivalentSlackUserIds(userId);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await getDb().all<{ agent_group_id: string }>(
    `SELECT DISTINCT agent_group_id FROM agent_group_members WHERE user_id IN (${placeholders})`,
    ...ids,
  );
  return rows.map((r) => r.agent_group_id);
}

/**
 * True if the user (or an equivalent same-workspace identity) has any
 * membership row.
 *
 * Sequential, not `Promise.all`: the pre-seam body short-circuited on the
 * first candidate that matched, and the driver contract (src/db/driver.ts)
 * forbids issuing central statements concurrently.
 */
export async function hasAnyMembership(userId: string): Promise<boolean> {
  for (const candidate of equivalentSlackUserIds(userId)) {
    const row = await getDb().get('SELECT 1 FROM agent_group_members WHERE user_id = ? LIMIT 1', candidate);
    if (row) return true;
  }
  return false;
}
