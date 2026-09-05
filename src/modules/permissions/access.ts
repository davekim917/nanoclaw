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
import { isMember } from './db/agent-group-members.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './db/user-roles.js';
import { getUser } from './db/users.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };

/**
 * Can this user interact with this agent group?
 *
 * The three role predicates stay synchronous (seam-3 plan §4.5, I-1); the two
 * awaited reads keep their original position in the check order.
 */
export async function canAccessAgentGroup(userId: string, agentGroupId: string): Promise<AccessDecision> {
  if (!(await getUser(userId))) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}

/**
 * Is this sender one of NanoClaw's OWN bots (a sibling agent)?
 *
 * Sender ids are namespaced `<channelType>:<platformUserId>` (e.g.
 * `discord-opencode:123456789000000001`). `botIds` is the set of platform
 * user-ids belonging to our own bots in this process — collected from the
 * channel adapters' known-bot registries and injected into the access gate
 * (see `setSiblingBotIdsProvider` in `index.ts`).
 *
 * A match authorizes the sender to engage even under a `strict` /
 * `request_approval` messaging group: sibling agents are trusted peers, not
 * unknown senders. This mirrors the Discord adapter's `__nanoclawDiscordSiblings`
 * allow-list, which already lets sibling-authored messages past the
 * "drop other bots" filter at the forwarding layer — the access gate is the
 * second layer that, without this, would re-drop them as `not_member`.
 *
 * Pure (set passed in) so it is unit-testable without standing up adapters.
 * Empty `botIds` ⇒ always false (fail-closed before the host wires the
 * provider). Platform user-ids are globally unique per account, so a human
 * sender can never collide with a bot's id — no false positives.
 */
export function isSiblingBotSender(userId: string, botIds: ReadonlySet<string>): boolean {
  if (botIds.size === 0) return false;
  const sep = userId.indexOf(':');
  if (sep < 0) return false;
  const platformUserId = userId.slice(sep + 1);
  if (platformUserId.length === 0) return false;
  return botIds.has(platformUserId);
}
