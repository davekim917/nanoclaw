/**
 * Access control.
 *
 * Privilege is user-level, not group-level. A user holds zero or more roles
 * (owner | admin) via `user_roles`, and is optionally "known" in specific
 * agent groups via `agent_group_members`. Admins are implicitly members of
 * the groups they administer.
 *
 * Approver-picking (`pickApprover`, `pickApprovalDelivery`) lives in the
 * approvals module — see `src/modules/approvals/primitive.ts`.
 */
import { withCentralSync } from '../../db/central-lease.js';
import { isMember } from './db/agent-group-members.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './db/user-roles.js';
import { getUser } from './db/users.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };

/**
 * Can this user interact with this agent group?
 *
 * The role predicates are lease-only, so the checks run as one block under the
 * central lease.
 */
export async function canAccessAgentGroup(userId: string, agentGroupId: string): Promise<AccessDecision> {
  if (!(await getUser(userId))) return { allowed: false, reason: 'unknown_user' };
  return withCentralSync((): AccessDecision => {
    if (isOwner(userId)) return { allowed: true, reason: 'owner' };
    if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
    if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
    if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
    return { allowed: false, reason: 'not_member' };
  }, 'canAccessAgentGroup');
}

/**
 * Is this sender one of NanoClaw's OWN bots (a sibling agent)?
 *
 * The access gate's second layer behind the adapters' sibling allow-lists;
 * without it siblings are re-dropped as `not_member` under `strict`. Empty
 * `botIds` ⇒ false (fail-closed before the provider is wired).
 */
export function isSiblingBotSender(userId: string, botIds: ReadonlySet<string>): boolean {
  if (botIds.size === 0) return false;
  const sep = userId.indexOf(':');
  if (sep < 0) return false;
  const platformUserId = userId.slice(sep + 1);
  if (platformUserId.length === 0) return false;
  return botIds.has(platformUserId);
}
