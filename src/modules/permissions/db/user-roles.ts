import type { UserRole, UserRoleKind } from '../../../types.js';
import { getDb, getRawDb } from '../../../db/connection.js';
import { equivalentSlackUserIds } from '../../../slack-user-identity.js';

/**
 * ⚠️  Four exports below stay SYNCHRONOUS through seam 3 (plan §4.5, I-1):
 * `isOwner`, `isGlobalAdmin`, `isAdminOfAgentGroup` and their composite
 * `hasAdminPrivilege`. They are read from inside guard `decide` bodies —
 * `modules/permissions/guard.ts` (channels.register),
 * `dashboard/thread-close-guard.ts` (threads.close),
 * `dashboard/observatory-assign-guard.ts` (observatory.assign) — and a guard
 * never awaits, so an async form would be a promise used as a boolean at three
 * authorization sites. This is §4.2's "leaf exports reachable from a raw
 * transaction closure stay synchronous until PR 6" rule applied to the other
 * synchronous block the plan names: they are NOT `*Sync` twins (there is one
 * form of each, not two), they are simply not yet converted. PR 6 moves them
 * inside `withCentralSync`/`withRawDb` together with `evaluateGuardSync`.
 *
 * Everything else in this file is on the async driver.
 */

/**
 * Run a role predicate for the caller's exact identity and, for Slack only,
 * sibling adapter identities registered to the same workspace. See
 * `slack-user-identity.ts` for the teamId-bound equivalence rule.
 */
function hasEquivalentRole(userId: string, predicate: (candidate: string) => boolean): boolean {
  return equivalentSlackUserIds(userId).some(predicate);
}

/**
 * The async form of the same loop, for `isAnyAdmin`. Not a `*Sync` twin in
 * §4.2's sense — that rule is about a LEAF EXPORT gaining a second public
 * shape; this is a private helper serving one export each. Sequential, so the
 * short-circuit and the one-statement-at-a-time driver contract both hold.
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

/** Global (agent_group_id IS NULL) role probe — shared by the sync predicates. */
const GLOBAL_ROLE_SQL = 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL LIMIT 1';
/** Scoped role probe — shared by the sync predicates. */
const SCOPED_ROLE_SQL = 'SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ? LIMIT 1';

/**
 * Grant a role. Owner rows must have agent_group_id = null (enforced here,
 * not by schema, so callers get a clean error path).
 */
export async function grantRole(row: UserRole): Promise<void> {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  await getDb().run(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (@user_id, @role, @agent_group_id, @granted_by, @granted_at)`,
    row,
  );
}

export async function revokeRole(userId: string, role: UserRoleKind, agentGroupId: string | null): Promise<void> {
  if (agentGroupId === null) {
    await getDb().run('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL', userId, role);
  } else {
    await getDb().run(
      'DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?',
      userId,
      role,
      agentGroupId,
    );
  }
}

export async function getUserRoles(userId: string): Promise<UserRole[]> {
  return getDb().all<UserRole>('SELECT * FROM user_roles WHERE user_id = ?', userId);
}

/** Synchronous by design — see the file header. */
export function isOwner(userId: string): boolean {
  return hasEquivalentRole(userId, (candidate) => {
    return getRawDb().prepare(GLOBAL_ROLE_SQL).get(candidate, 'owner') !== undefined;
  });
}

/** Synchronous by design — see the file header. */
export function isGlobalAdmin(userId: string): boolean {
  return hasEquivalentRole(userId, (candidate) => {
    return getRawDb().prepare(GLOBAL_ROLE_SQL).get(candidate, 'admin') !== undefined;
  });
}

/** Synchronous by design — see the file header. */
export function isAdminOfAgentGroup(userId: string, agentGroupId: string): boolean {
  return hasEquivalentRole(userId, (candidate) => {
    return getRawDb().prepare(SCOPED_ROLE_SQL).get(candidate, 'admin', agentGroupId) !== undefined;
  });
}

/**
 * Any admin privilege over this agent group: global admin OR scoped admin.
 * Synchronous by design — see the file header.
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

/** True if the user has any admin role: owner or admin (global or scoped). */
export async function isAnyAdmin(userId: string): Promise<boolean> {
  return hasEquivalentRoleAsync(userId, async (candidate) => {
    const row = await getDb().get(
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('owner', 'admin') LIMIT 1",
      candidate,
    );
    return !!row;
  });
}
