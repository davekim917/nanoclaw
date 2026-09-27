/**
 * Chat-invokable access grants: `grant_access`, `revoke_access`, `list_access`.
 *
 * Caller identity is read from the SESSION's latest inbound chat message, never
 * from anything the agent passes in. Owner / global admin may grant or revoke
 * `member` or `admin` anywhere; a scoped admin only `member` on their own group.
 * The owner role is never grantable here.
 */

import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { deriveCallerId } from '../../caller-identity.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { ADD_MEMBER_SQL, REMOVE_MEMBER_SQL, getMembers, isMember } from './db/agent-group-members.js';
import { createUser, getUser, upsertUser } from './db/users.js';
import {
  getAdminsOfAgentGroup,
  getGlobalAdmins,
  getOwners,
  GRANT_ROLE_SQL,
  REVOKE_SCOPED_ROLE_SQL,
  getUserRoles,
  hasAdminPrivilege,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from './db/user-roles.js';

interface GrantArgs {
  user?: unknown;
  role?: unknown;
  agentGroupId?: unknown;
}

async function resolveTargetUserId(rawUser: string, session: Session): Promise<string | null> {
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
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = mg?.channel_type ?? null;
  if (!channelType) return null;
  return `${channelType}:${handle}`;
}

function describeAuthority(userId: string, agentGroupId: string): Promise<string> {
  return withCentralSync(() => {
    const parts: string[] = [];
    if (isOwner(userId)) parts.push('owner');
    if (isGlobalAdmin(userId)) parts.push('global_admin');
    if (isAdminOfAgentGroup(userId, agentGroupId)) parts.push('admin_of_group');
    return parts.length > 0 ? parts.join(', ') : 'none';
  }, 'describeAuthority');
}

async function ensureUserExists(userId: string): Promise<void> {
  if (await getUser(userId)) return;
  const [kind] = userId.split(':', 1);
  await upsertUser({ id: userId, kind: kind ?? 'unknown', display_name: null, created_at: new Date().toISOString() });
  void createUser;
}

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
    // Say what is allowed, not what was sent: the role is caller-supplied text.
    await notifyAgent(session, 'grant_access failed: role must be `member` or `admin`.');
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

  // The role predicates are lease-only.
  const { callerIsGlobal, callerIsScopedAdmin } = await withCentralSync(
    () => ({
      callerIsGlobal: isOwner(callerId) || isGlobalAdmin(callerId),
      callerIsScopedAdmin: isAdminOfAgentGroup(callerId, targetAgentGroupId),
    }),
    'grant_access authority',
  );
  if (!callerIsGlobal && !callerIsScopedAdmin) {
    log.info('grant_access denied', {
      callerId,
      targetAgentGroupId,
      authority: await describeAuthority(callerId, targetAgentGroupId),
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

  const targetUserId = await resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    await notifyAgent(
      session,
      `grant_access failed: could not resolve \`${rawUser}\` to a user id (needs a namespaced id, a platform mention, or a bare handle).`,
    );
    return;
  }

  await ensureUserExists(targetUserId);

  // The snapshot above is only the fast denial. Target resolution awaits, so
  // the caller re-check, target check and write are one synchronous lease block.
  if (role === 'member') {
    const outcome = await withCentralSync((): 'caller-revoked' | 'already' | 'added' => {
      if (!(isOwner(callerId) || isGlobalAdmin(callerId) || isAdminOfAgentGroup(callerId, targetAgentGroupId))) {
        return 'caller-revoked';
      }
      if (isMember(targetUserId, targetAgentGroupId) || hasAdminPrivilege(targetUserId, targetAgentGroupId)) {
        return 'already';
      }
      withRawDb((db) => {
        db.prepare(ADD_MEMBER_SQL).run({
          user_id: targetUserId,
          agent_group_id: targetAgentGroupId,
          added_by: callerId,
          added_at: new Date().toISOString(),
        });
      });
      return 'added';
    }, 'grant_access apply');
    if (outcome === 'caller-revoked') {
      log.info('grant_access denied: caller lost authority before the write', { callerId, targetAgentGroupId });
      await notifyAgent(
        session,
        `grant_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`,
      );
      return;
    }
    if (outcome === 'already') {
      await notifyAgent(session, `\`${targetUserId}\` already has access to \`${targetAgentGroupId}\`.`);
      return;
    }
    log.info('grant_access: member added', { callerId, targetUserId, targetAgentGroupId });
    // Not awaited: a rejection would make the delivery loop retry the whole
    // handler after the grant already committed.
    void Promise.resolve(
      notifyAgent(session, `Granted member access: \`${targetUserId}\` → \`${targetAgentGroupId}\`.`),
    ).catch((err) => log.warn('grant_access notification failed', { targetUserId, targetAgentGroupId, err }));
    return;
  }

  // role === 'admin' — same shape: the global re-check and the write share one block.
  const adminOutcome = await withCentralSync((): 'caller-revoked' | 'already' | 'granted' => {
    if (!(isOwner(callerId) || isGlobalAdmin(callerId))) return 'caller-revoked';
    if (isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) return 'already';
    withRawDb((db) => {
      db.prepare(GRANT_ROLE_SQL).run({
        user_id: targetUserId,
        role: 'admin',
        agent_group_id: targetAgentGroupId,
        granted_by: callerId,
        granted_at: new Date().toISOString(),
      });
    });
    return 'granted';
  }, 'grant_access apply');
  if (adminOutcome === 'caller-revoked') {
    log.info('grant_access denied: caller lost authority before the write', { callerId, targetAgentGroupId });
    await notifyAgent(
      session,
      'grant_access denied: only owner / global admin can grant `admin`. You can grant `member`.',
    );
    return;
  }
  if (adminOutcome === 'already') {
    await notifyAgent(session, `\`${targetUserId}\` is already admin of \`${targetAgentGroupId}\`.`);
    return;
  }
  log.info('grant_access: admin granted', { callerId, targetUserId, targetAgentGroupId });
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

  const { callerIsGlobal, callerIsScopedAdmin } = await withCentralSync(
    () => ({
      callerIsGlobal: isOwner(callerId) || isGlobalAdmin(callerId),
      callerIsScopedAdmin: isAdminOfAgentGroup(callerId, targetAgentGroupId),
    }),
    'revoke_access authority',
  );
  if (!callerIsGlobal && !callerIsScopedAdmin) {
    await notifyAgent(
      session,
      `revoke_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`,
    );
    return;
  }

  const targetUserId = await resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    await notifyAgent(session, `revoke_access failed: could not resolve \`${rawUser}\`.`);
    return;
  }

  // ONE synchronous lease block: caller re-check, target standing and removal,
  // nothing awaited between them, so the write sees the caller as they are NOW.
  // A scoped admin may take membership, never a role.
  type RevokeOutcome = 'caller-revoked' | 'target-global' | 'target-owner' | 'target-admin' | 'nothing' | 'revoked';
  const outcome = await withCentralSync((): RevokeOutcome => {
    const callerIsGlobalNow = isOwner(callerId) || isGlobalAdmin(callerId);
    const callerIsScopedAdminNow = isAdminOfAgentGroup(callerId, targetAgentGroupId);
    if (!callerIsGlobalNow && !callerIsScopedAdminNow) return 'caller-revoked';

    const targetIsOwner = isOwner(targetUserId);
    const targetIsGlobal = targetIsOwner || isGlobalAdmin(targetUserId);
    const targetIsAdminOfGroup = isAdminOfAgentGroup(targetUserId, targetAgentGroupId);
    const targetIsMember = isMember(targetUserId, targetAgentGroupId);
    // Never let a scoped admin revoke owner or global admin.
    if (!callerIsGlobalNow && targetIsGlobal) return 'target-global';
    if (targetIsOwner) return 'target-owner';
    // Scoped admins can only revoke `member`, not `admin` (that's an escalation).
    if (!callerIsGlobalNow && targetIsAdminOfGroup) return 'target-admin';

    let revoked = false;
    withRawDb((db) => {
      if (targetIsMember) {
        db.prepare(REMOVE_MEMBER_SQL).run(targetUserId, targetAgentGroupId);
        revoked = true;
      }
      if (callerIsGlobalNow && targetIsAdminOfGroup) {
        db.prepare(REVOKE_SCOPED_ROLE_SQL).run(targetUserId, 'admin', targetAgentGroupId);
        revoked = true;
      }
    });
    return revoked ? 'revoked' : 'nothing';
  }, 'revoke_access apply');

  if (outcome === 'caller-revoked') {
    log.info('revoke_access denied: caller lost authority before the write', { callerId, targetAgentGroupId });
    await notifyAgent(
      session,
      `revoke_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`,
    );
    return;
  }
  if (outcome === 'target-global') {
    await notifyAgent(session, 'revoke_access denied: you cannot revoke an owner or global admin. Ask a global admin.');
    return;
  }
  if (outcome === 'target-owner') {
    await notifyAgent(session, 'revoke_access refused: owner revocation must be done by direct edit (safety).');
    return;
  }
  if (outcome === 'target-admin') {
    await notifyAgent(session, 'revoke_access denied: only a global admin can revoke another admin.');
    return;
  }
  const revoked = outcome === 'revoked';
  if (!revoked) {
    await notifyAgent(session, `\`${targetUserId}\` had no access to \`${targetAgentGroupId}\` to revoke.`);
    return;
  }
  log.info('revoke_access: revoked', { callerId, targetUserId, targetAgentGroupId });
  // Not awaited, as on the grant paths.
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
