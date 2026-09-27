import { withCentralSync } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
import { getMembershipGroupIds } from '../../modules/permissions/db/agent-group-members.js';
import type { GroupScope } from '../router.js';

interface UserRoleRow {
  role: string;
  agent_group_id: string | null;
}

export interface UserScopes {
  role: GroupScope['role'];
  allowed_group_ids: string[];
  no_filter: boolean;
}

/**
 * The dashboard scope for a user from `user_roles`. `requireAuth` and `authMeHandler` must both use this: enumerating
 * real groups is what lets scoped admins see anything.
 */
export async function computeScopes(userId: string): Promise<UserScopes> {
  const rows = await getDb().all<UserRoleRow>('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?', userId);

  const isOwner = rows.some((r) => r.role === 'owner' && r.agent_group_id === null);
  const isGlobalAdmin = rows.some((r) => r.role === 'admin' && r.agent_group_id === null);

  if (isOwner) {
    return { role: 'owner', allowed_group_ids: [], no_filter: true };
  }
  if (isGlobalAdmin) {
    return { role: 'global_admin', allowed_group_ids: [], no_filter: true };
  }

  const scopedAdminGroups = rows
    .filter((r) => r.role === 'admin' && r.agent_group_id !== null)
    .map((r) => r.agent_group_id as string)
    .sort();

  if (scopedAdminGroups.length > 0) {
    return { role: 'admin_of_group', allowed_group_ids: scopedAdminGroups, no_filter: false };
  }

  // The 'member' role in user_roles is legacy; the real grant is `agent_group_members`. Both are unioned.
  const roleMemberGroups = rows
    .filter((r) => r.role === 'member' && r.agent_group_id !== null)
    .map((r) => r.agent_group_id as string);
  const membershipGroups = await withCentralSync(() => getMembershipGroupIds(userId), 'computeScopes membership');
  const memberGroups = [...new Set([...roleMemberGroups, ...membershipGroups])].sort();

  return { role: 'member', allowed_group_ids: memberGroups, no_filter: false };
}
