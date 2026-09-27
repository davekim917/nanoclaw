import type { UserRole, UserRoleKind } from '../../../types.js';
import { withRawDb } from '../../../db/central-lease.js';
import { getDb } from '../../../db/connection.js';
import { equivalentSlackUserIds } from '../../../slack-user-identity.js';

/**
 * ⚠️  `isOwner`, `isGlobalAdmin`, `isAdminOfAgentGroup` and `hasAdminPrivilege`
 * are SYNCHRONOUS: guard `decide` bodies never await, so they run through
 * `withRawDb` and throw outside a `withCentralSync` block. A caller not already
 * inside one takes the lease: `await withCentralSync(() => isOwner(id), '…')`.
 */

/**
 * Also matches Slack sibling identities of the same workspace (slack-user-identity.ts).
 */
function hasEquivalentRole(userId: string, predicate: (candidate: string) => boolean): boolean {
  return equivalentSlackUserIds(userId).some(predicate);
}

/**
 * Sequential: short-circuits, and the driver runs one statement at a time.
 */
async function hasEquivalentRoleAsync(
  userId: string,
  predicate: (candidate: string) => Promise<boolean>,
): Promise<boolean> {
  for (const candidate of equivalentSlackUserIds(userId)) {
    if (await predicate(candidate)) return true;
  }
  return false;
}

const GLOBAL_ROLE_SQL = 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1';
const SCOPED_ROLE_SQL = 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ? LIMIT 1';

/**
 * Grant a role. Owner rows must have agent_group_id = null (enforced here,
 * not by schema, so callers get a clean error path).
 */
/**
 * Constants so `grant.ts` can run the write through `withRawDb` in the same
 * lease block as its authority re-check.
 */
export const GRANT_ROLE_SQL = `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`;
export const REVOKE_SCOPED_ROLE_SQL = 'DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?';

export async function grantRole(row: UserRole): Promise<void> {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  await getDb().run(GRANT_ROLE_SQL, row);
}

export async function revokeRole(userId: string, role: UserRoleKind, agentGroupId: string | null): Promise<void> {
  if (agentGroupId === null) {
    await getDb().run('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL', userId, role);
  } else {
    await getDb().run(REVOKE_SCOPED_ROLE_SQL, userId, role, agentGroupId);
  }
}

export async function getUserRoles(userId: string): Promise<UserRole[]> {
  return getDb().all<UserRole>('SELECT * FROM user_roles WHERE user_id = ?', userId);
}

/** Synchronous, lease-only — see the file header. */
export function isOwner(userId: string): boolean {
  return withRawDb((db) =>
    hasEquivalentRole(userId, (candidate) => db.prepare(GLOBAL_ROLE_SQL).get(candidate, 'owner') !== undefined),
  );
}

/** Synchronous, lease-only — see the file header. */
export function isGlobalAdmin(userId: string): boolean {
  return withRawDb((db) =>
    hasEquivalentRole(userId, (candidate) => db.prepare(GLOBAL_ROLE_SQL).get(candidate, 'admin') !== undefined),
  );
}

/** Synchronous, lease-only — see the file header. */
export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  return withRawDb((db) =>
    hasEquivalentRole(
      userId,
      (candidate) => db.prepare(SCOPED_ROLE_SQL).get(candidate, 'admin', agentGroupId) !== undefined,
    ),
  );
}

/**
 * Any admin privilege over this agent group: global admin OR scoped admin.
 */
export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}

export async function getOwners(): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at',
    'owner',
  );
}

export async function hasAnyOwner(): Promise<boolean> {
  const row = await getDb().get('SELECT 1 FROM user_roles WHERE role = ? AND agent_group_id IS NULL LIMIT 1', 'owner');
  return !!row;
}

export async function getGlobalAdmins(): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id IS NULL ORDER BY granted_at',
    'admin',
  );
}

export async function getAdminsOfAgentGroup(agentGroupId: string): Promise<UserRole[]> {
  return getDb().all<UserRole>(
    'SELECT * FROM user_roles WHERE role = ? AND agent_group_id = ? ORDER BY granted_at',
    'admin',
    agentGroupId,
  );
}

export async function isAnyAdmin(userId: string): Promise<boolean> {
  return hasEquivalentRoleAsync(userId, async (candidate) => {
    const row = await getDb().get(
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('owner', 'admin') LIMIT 1",
      candidate,
    );
    return !!row;
  });
}
