/**
 * Chat-invokable access grants (fork addition).
 *
 * Registers three delivery actions — `grant_access`, `revoke_access`,
 * `list_access` — that the container's permissions MCP tool emits. See
 * `container/agent-runner/src/mcp-tools/permissions.ts` for the agent-
 * facing side.
 *
 * Authorization (trust-minimal):
 *   1. Caller identity is read from the SESSION's latest inbound chat
 *      message — not from anything the agent can pass in. The agent
 *      can't impersonate; it can only choose whether to emit the
 *      action for the user who actually sent the triggering message.
 *   2. Authority tiers:
 *        - owner / global admin → can grant/revoke `member` or `admin`,
 *          on any agent group.
 *        - admin-of-target-group → can grant/revoke `member` only, on
 *          their own scoped group.
 *        - anyone else → denied.
 *      `list_access` is readable by anyone who can reach the session.
 *   3. Owner role is never grantable via tool. Set via
 *      `/init-first-agent` or a direct DB edit.
 */

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { deriveCallerId } from '../../caller-identity.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { addMember, getMembers, isMember, removeMember } from './db/agent-group-members.js';
import { createUser, getUser, upsertUser } from './db/users.js';
import {
  getAdminsOfAgentGroup,
  getGlobalAdmins,
  getOwners,
  getUserRoles,
  grantRole,
  hasAdminPrivilege,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
  revokeRole,
} from './db/user-roles.js';

interface GrantArgs {
  user?: unknown;
  role?: unknown;
  agentGroupId?: unknown;
}

/** Strip `<@…>` wrapping and prepend channel_type when needed. */
function resolveTargetUserId(rawUser: string, session: Session): string | null {
  let handle = rawUser.trim();
  if (handle.startsWith('<@') && handle.endsWith('>')) {
    handle = handle.slice(2, -1);
    // Discord role mentions look like <@&snowflake>; reject — not a user.
    if (handle.startsWith('&')) return null;
    // Slack user mentions can include a display alias after `|`: <@U12|operator>.
    const pipe = handle.indexOf('|');
    if (pipe >= 0) handle = handle.slice(0, pipe);
  }
  if (!handle) return null;
  if (handle.includes(':')) return handle;
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = mg?.channel_type ?? null;
  if (!channelType) return null;
  return `${channelType}:${handle}`;
}

function describeAuthority(userId: string, agentGroupId: string): string {
  const parts: string[] = [];
  if (isOwner(userId)) parts.push('owner');
  if (isGlobalAdmin(userId)) parts.push('global_admin');
  if (isAdminOfAgentGroup(userId, agentGroupId)) parts.push('admin_of_group');
  return parts.length > 0 ? parts.join(', ') : 'none';
}

async function ensureUserExists(userId: string): Promise<void> {
  if (await getUser(userId)) return;
  const [kind] = userId.split(':', 1);
  // createUser shape matches upsertUser; upsert is no-op safe.
  await upsertUser({ id: userId, kind: kind ?? 'unknown', display_name: null, created_at: new Date().toISOString() });
  void createUser; // imported for parity; upsertUser is the idempotent path.
}

// Exports the derivation helpers for unit testing. Handlers below are
// intentionally not exported — they self-register via registerDeliveryAction.
export { deriveCallerId as _deriveCallerId, resolveTargetUserId as _resolveTargetUserId };

export async function handleGrantAccess(content: Record<string, unknown>, session: Session): Promise<void> {
  const args = content as GrantArgs;
  const rawUser = typeof args.user === 'string' ? args.user : '';
  const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : 'member';
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;

  if (!rawUser) {
    await notifyAgent(session, 'grant_access failed: `user` is required.');
    return;
  }
  if (role !== 'member' && role !== 'admin') {
    await notifyAgent(session, `grant_access failed: role must be \`member\` or \`admin\`, got \`${role}\`.`);
    return;
  }
  if (!(await getAgentGroup(targetAgentGroupId))) {
    await notifyAgent(session, `grant_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const callerId = await deriveCallerId(session);
  if (!callerId) {
    await notifyAgent(session, 'grant_access failed: could not determine caller (no recent inbound message).');
    return;
  }

  // Authorization.
  const callerIsGlobal = isOwner(callerId) || isGlobalAdmin(callerId);
  const callerIsScopedAdmin = isAdminOfAgentGroup(callerId, targetAgentGroupId);
  if (!callerIsGlobal && !callerIsScopedAdmin) {
    log.info('grant_access denied', {
      callerId,
      targetAgentGroupId,
      authority: describeAuthority(callerId, targetAgentGroupId),
    });
    await notifyAgent(
      session,
      `grant_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`,
    );
    return;
  }
  if (role === 'admin' && !callerIsGlobal) {
    await notifyAgent(
      session,
      'grant_access denied: only owner / global admin can grant `admin`. You can grant `member`.',
    );
    return;
  }

  const targetUserId = resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    await notifyAgent(
      session,
      `grant_access failed: could not resolve \`${rawUser}\` to a user id (needs a namespaced id, a platform mention, or a bare handle).`,
    );
    return;
  }

  await ensureUserExists(targetUserId);

  if (role === 'member') {
    if (isMember(targetUserId, targetAgentGroupId) || hasAdminPrivilege(targetUserId, targetAgentGroupId)) {
      await notifyAgent(session, `\`${targetUserId}\` already has access to \`${targetAgentGroupId}\`.`);
      return;
    }
    await addMember({
      user_id: targetUserId,
      agent_group_id: targetAgentGroupId,
      added_by: callerId,
      added_at: new Date().toISOString(),
    });
    log.info('grant_access: member added', { callerId, targetUserId, targetAgentGroupId });
    // Best-effort: addMember above already committed. This is a system-action
    // delivery handler — an awaited rejection here would leave the message
    // undelivered, so the delivery loop retries the whole handler (re-adding
    // an already-added member) rather than just re-attempting the
    // notification.
    void Promise.resolve(
      notifyAgent(session, `Granted member access: \`${targetUserId}\` → \`${targetAgentGroupId}\`.`),
    ).catch((err) => log.warn('grant_access notification failed', { targetUserId, targetAgentGroupId, err }));
    return;
  }

  // role === 'admin'
  if (isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    await notifyAgent(session, `\`${targetUserId}\` is already admin of \`${targetAgentGroupId}\`.`);
    return;
  }
  await grantRole({
    user_id: targetUserId,
    role: 'admin',
    agent_group_id: targetAgentGroupId,
    granted_by: callerId,
    granted_at: new Date().toISOString(),
  });
  log.info('grant_access: admin granted', { callerId, targetUserId, targetAgentGroupId });
  // Best-effort — see the matching comment on the member-grant path above.
  void Promise.resolve(notifyAgent(session, `Granted admin: \`${targetUserId}\` → \`${targetAgentGroupId}\`.`)).catch(
    (err) => log.warn('grant_access notification failed', { targetUserId, targetAgentGroupId, err }),
  );
}

export async function handleRevokeAccess(content: Record<string, unknown>, session: Session): Promise<void> {
  const args = content as GrantArgs;
  const rawUser = typeof args.user === 'string' ? args.user : '';
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;

  if (!rawUser) {
    await notifyAgent(session, 'revoke_access failed: `user` is required.');
    return;
  }
  if (!(await getAgentGroup(targetAgentGroupId))) {
    await notifyAgent(session, `revoke_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const callerId = await deriveCallerId(session);
  if (!callerId) {
    await notifyAgent(session, 'revoke_access failed: could not determine caller.');
    return;
  }

  const callerIsGlobal = isOwner(callerId) || isGlobalAdmin(callerId);
  const callerIsScopedAdmin = isAdminOfAgentGroup(callerId, targetAgentGroupId);
  if (!callerIsGlobal && !callerIsScopedAdmin) {
    await notifyAgent(
      session,
      `revoke_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`,
    );
    return;
  }

  const targetUserId = resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    await notifyAgent(session, `revoke_access failed: could not resolve \`${rawUser}\`.`);
    return;
  }

  // Never let a scoped admin revoke owner or global admin.
  if (!callerIsGlobal && (isOwner(targetUserId) || isGlobalAdmin(targetUserId))) {
    await notifyAgent(session, 'revoke_access denied: you cannot revoke an owner or global admin. Ask a global admin.');
    return;
  }
  // Owners are never revoked via this path — sensitive, do it manually.
  if (isOwner(targetUserId)) {
    await notifyAgent(session, 'revoke_access refused: owner revocation must be done by direct edit (safety).');
    return;
  }
  // Scoped admins can only revoke `member`, not `admin` (that's an escalation).
  if (!callerIsGlobal && isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    await notifyAgent(session, 'revoke_access denied: only a global admin can revoke another admin.');
    return;
  }

  let revoked = false;
  if (isMember(targetUserId, targetAgentGroupId)) {
    await removeMember(targetUserId, targetAgentGroupId);
    revoked = true;
  }
  // `callerIsGlobal` is the load-bearing half of this condition, not a
  // shortcut for the check above (issue #443, Codex round 2).
  //
  // `removeMember` yields. If an owner grants the target an admin role in that
  // window, `isAdminOfAgentGroup` — evaluated HERE, after the yield — flips to
  // true, while the "only a global admin can revoke another admin" refusal was
  // decided BEFORE it and let this caller through. A scoped admin would then
  // revoke an admin role, which is exactly the escalation that refusal exists
  // to prevent.
  //
  // Re-testing the predicate is not enough on its own: the predicates are
  // synchronous on the raw handle by §4.5, but `revokeRole` is not, so any
  // re-test would still sit on the far side of an await from its write.
  // Gating on `callerIsGlobal` closes it without a lock, and changes nothing
  // for a legitimate flow: a scoped caller that reaches this line was already
  // proven not to be facing an admin target, so this branch was a no-op for
  // them in every non-racing case.
  if (callerIsGlobal && isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    await revokeRole(targetUserId, 'admin', targetAgentGroupId);
    revoked = true;
  } else if (!callerIsGlobal && isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    log.warn('revoke_access: target gained an admin role mid-revoke — role left in place', {
      callerId,
      targetUserId,
      targetAgentGroupId,
    });
  }

  if (!revoked) {
    await notifyAgent(session, `\`${targetUserId}\` had no access to \`${targetAgentGroupId}\` to revoke.`);
    return;
  }
  log.info('revoke_access: revoked', { callerId, targetUserId, targetAgentGroupId });
  // Best-effort: removeMember/revokeRole above already committed. Same
  // reasoning as the grant paths — an awaited rejection here would cause a
  // full-handler retry that re-attempts an already-completed revoke.
  void Promise.resolve(notifyAgent(session, `Revoked access: \`${targetUserId}\` ← \`${targetAgentGroupId}\`.`)).catch(
    (err) => log.warn('revoke_access notification failed', { targetUserId, targetAgentGroupId, err }),
  );
}

export async function handleListAccess(content: Record<string, unknown>, session: Session): Promise<void> {
  const args = content as GrantArgs;
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;
  if (!(await getAgentGroup(targetAgentGroupId))) {
    await notifyAgent(session, `list_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const owners = await getOwners();
  const globalAdmins = await getGlobalAdmins();
  const scopedAdmins = await getAdminsOfAgentGroup(targetAgentGroupId);
  const members = await getMembers(targetAgentGroupId);

  const lines: string[] = [`Access for \`${targetAgentGroupId}\`:`];
  lines.push(`  owners (global): ${owners.length ? owners.map((r) => r.user_id).join(', ') : '(none)'}`);
  lines.push(`  global admins: ${globalAdmins.length ? globalAdmins.map((r) => r.user_id).join(', ') : '(none)'}`);
  lines.push(`  scoped admins: ${scopedAdmins.length ? scopedAdmins.map((r) => r.user_id).join(', ') : '(none)'}`);
  lines.push(`  members: ${members.length ? members.map((m) => m.user_id).join(', ') : '(none)'}`);
  // Authority + role are distinct — a user with `getUserRoles` that are all
  // global owner/admin shows up in roles above but not members. Document
  // that explicitly if anyone reads the output and is confused:
  lines.push('  (note: owners + admins implicitly have member-level access even without a row in `members`).');
  // Referenced for type-check silence on the import and future extension.
  void getUserRoles;

  await notifyAgent(session, lines.join('\n'));
}

const ACCESS_ACTION = unguarded(
  'handler derives caller identity from the trusted session and enforces owner/admin authority tiers',
);
registerDeliveryAction('grant_access', handleGrantAccess, ACCESS_ACTION);
registerDeliveryAction('revoke_access', handleRevokeAccess, ACCESS_ACTION);
registerDeliveryAction('list_access', handleListAccess, ACCESS_ACTION);
