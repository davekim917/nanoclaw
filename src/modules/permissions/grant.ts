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

/** Strip `<@…>` wrapping and prepend channel_type when needed. */
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

  // Authorization. The role predicates are lease-only (§4.5 I-1).
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

  // The authority snapshot above is UX — the fast denial before the target is
  // resolved. The decision that matters is re-taken INSIDE the block that
  // writes: the target resolution awaits, and a caller revoked
  // in that window must not complete a privileged write on stale authority.
  // Caller re-check, target check and the write are one synchronous lease
  // block; the write runs the leaf's exported constant through `withRawDb`.
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

  // ONE synchronous lease block: the caller's authority is RE-CHECKED here,
  // the target's standing is read, and the removal runs — nothing awaits
  // between them. The snapshot taken before `resolveTargetUserId`
  // is only the fast denial; another owner/admin can revoke this caller during
  // that await, and the write must see the caller as they are NOW. The writes
  // execute the leaves' exported constants through `withRawDb` (one constant,
  // two executors), so the block holds no driver statement.
  //
  // `callerIsGlobal` is the load-bearing half of the admin-role branch, not a
  // shortcut for the refusal above it: a scoped
  // admin may take membership, never a role, and with the checks and the
  // writes in one block a role granted concurrently is either seen (refused)
  // or lands after this block, untouched.
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
    // Owners are never revoked via this path — sensitive, do it manually.
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
  // Best-effort: the removal above already committed. Same
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
