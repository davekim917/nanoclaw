import type { AgentGroupMember } from '../../../types.js';
import { getDb, getRawDb } from '../../../db/connection.js';
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

const MEMBERSHIP_ROW_SQL = 'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1';

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 *
 * ⚠️  Synchronous by design, with the three role predicates it composes and
 * `getMembershipGroupIds` below (seam-3 plan §4.5, I-1). This is the
 * authorization-predicate family: `dashboard/assign.ts`'s `canAssign` and
 * `dashboard/steer.ts`'s `canSteer` are the non-guard halves of the same
 * decision `observatory-assign-guard.ts` and `thread-close-guard.ts` make
 * inside a `decide` body, and `compute-scopes.ts` runs on the token path with
 * them. §4.2's "leaf exports reachable from a synchronous decision stay
 * synchronous until PR 6" applies: one form each, no `*Sync` twin. PR 6 moves
 * the family inside `withCentralSync`/`withRawDb`.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  return getRawDb().prepare(MEMBERSHIP_ROW_SQL).get(userId, agentGroupId) !== undefined;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export function hasMembershipRow(userId: string, agentGroupId: string): boolean {
  return getRawDb().prepare(MEMBERSHIP_ROW_SQL).get(userId, agentGroupId) !== undefined;
}

/**
 * Every agent group the user is a member of, resolving same-workspace Slack
 * sibling identities (see slack-user-identity.ts) so a member who messages
 * from a sibling adapter is not locked out of their own membership.
 *
 * Synchronous by design — see `isMember` above.
 */
export function getMembershipGroupIds(userId: string): string[] {
  const ids = equivalentSlackUserIds(userId);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getRawDb()
    .prepare(`SELECT DISTINCT agent_group_id FROM agent_group_members WHERE user_id IN (${placeholders})`)
    .all(...ids) as { agent_group_id: string }[];
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
