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
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
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

/** Resolve the session's most recent inbound chat senderId, namespaced. */
function deriveCallerId(session: Session, inDb: Database.Database): string | null {
  // `kind='chat'` so we skip `task`/`system` messages that wouldn't carry a sender.
  const row = inDb
    .prepare(`SELECT content, channel_type FROM messages_in WHERE kind='chat' ORDER BY timestamp DESC LIMIT 1`)
    .get() as { content?: string; channel_type?: string } | undefined;
  if (!row?.content) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawId = (() => {
    const direct = parsed.senderId;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const author = parsed.author as { userId?: unknown } | undefined;
    if (typeof author?.userId === 'string' && author.userId.length > 0) return author.userId;
    return null;
  })();
  if (!rawId) return null;
  if (rawId.includes(':')) return rawId;
  // Fall back to the session's messaging_group for channel_type when
  // the message row didn't carry it.
  const mgFallback = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
  if (!channelType) return null;
  return `${channelType}:${rawId}`;
}

/** Strip `<@…>` wrapping and prepend channel_type when needed. */
function resolveTargetUserId(rawUser: string, session: Session): string | null {
  let handle = rawUser.trim();
  if (handle.startsWith('<@') && handle.endsWith('>')) {
    handle = handle.slice(2, -1);
    // Discord role mentions look like <@&snowflake>; reject — not a user.
    if (handle.startsWith('&')) return null;
    // Slack user mentions can include a display alias after `|`: <@U12|dave>.
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

function ensureUserExists(userId: string): void {
  if (getUser(userId)) return;
  const [kind] = userId.split(':', 1);
  // createUser shape matches upsertUser; upsert is no-op safe.
  upsertUser({ id: userId, kind: kind ?? 'unknown', display_name: null, created_at: new Date().toISOString() });
  void createUser; // imported for parity; upsertUser is the idempotent path.
}

// Exports the derivation helpers for unit testing. Handlers below are
// intentionally not exported — they self-register via registerDeliveryAction.
export { deriveCallerId as _deriveCallerId, resolveTargetUserId as _resolveTargetUserId };

export async function handleGrantAccess(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const args = content as GrantArgs;
  const rawUser = typeof args.user === 'string' ? args.user : '';
  const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : 'member';
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;

  if (!rawUser) {
    notifyAgent(session, 'grant_access failed: `user` is required.');
    return;
  }
  if (role !== 'member' && role !== 'admin') {
    notifyAgent(session, `grant_access failed: role must be \`member\` or \`admin\`, got \`${role}\`.`);
    return;
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    notifyAgent(session, `grant_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const callerId = deriveCallerId(session, inDb);
  if (!callerId) {
    notifyAgent(session, 'grant_access failed: could not determine caller (no recent inbound message).');
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
    notifyAgent(session, `grant_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`);
    return;
  }
  if (role === 'admin' && !callerIsGlobal) {
    notifyAgent(session, 'grant_access denied: only owner / global admin can grant `admin`. You can grant `member`.');
    return;
  }

  const targetUserId = resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    notifyAgent(
      session,
      `grant_access failed: could not resolve \`${rawUser}\` to a user id (needs a namespaced id, a platform mention, or a bare handle).`,
    );
    return;
  }

  ensureUserExists(targetUserId);

  if (role === 'member') {
    if (isMember(targetUserId, targetAgentGroupId) || hasAdminPrivilege(targetUserId, targetAgentGroupId)) {
      notifyAgent(session, `\`${targetUserId}\` already has access to \`${targetAgentGroupId}\`.`);
      return;
    }
    addMember({
      user_id: targetUserId,
      agent_group_id: targetAgentGroupId,
      added_by: callerId,
      added_at: new Date().toISOString(),
    });
    log.info('grant_access: member added', { callerId, targetUserId, targetAgentGroupId });
    notifyAgent(session, `Granted member access: \`${targetUserId}\` → \`${targetAgentGroupId}\`.`);
    return;
  }

  // role === 'admin'
  if (isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    notifyAgent(session, `\`${targetUserId}\` is already admin of \`${targetAgentGroupId}\`.`);
    return;
  }
  grantRole({
    user_id: targetUserId,
    role: 'admin',
    agent_group_id: targetAgentGroupId,
    granted_by: callerId,
    granted_at: new Date().toISOString(),
  });
  log.info('grant_access: admin granted', { callerId, targetUserId, targetAgentGroupId });
  notifyAgent(session, `Granted admin: \`${targetUserId}\` → \`${targetAgentGroupId}\`.`);
}

export async function handleRevokeAccess(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const args = content as GrantArgs;
  const rawUser = typeof args.user === 'string' ? args.user : '';
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;

  if (!rawUser) {
    notifyAgent(session, 'revoke_access failed: `user` is required.');
    return;
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    notifyAgent(session, `revoke_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const callerId = deriveCallerId(session, inDb);
  if (!callerId) {
    notifyAgent(session, 'revoke_access failed: could not determine caller.');
    return;
  }

  const callerIsGlobal = isOwner(callerId) || isGlobalAdmin(callerId);
  const callerIsScopedAdmin = isAdminOfAgentGroup(callerId, targetAgentGroupId);
  if (!callerIsGlobal && !callerIsScopedAdmin) {
    notifyAgent(session, `revoke_access denied: you don't have authority over agent group \`${targetAgentGroupId}\`.`);
    return;
  }

  const targetUserId = resolveTargetUserId(rawUser, session);
  if (!targetUserId) {
    notifyAgent(session, `revoke_access failed: could not resolve \`${rawUser}\`.`);
    return;
  }

  // Never let a scoped admin revoke owner or global admin.
  if (!callerIsGlobal && (isOwner(targetUserId) || isGlobalAdmin(targetUserId))) {
    notifyAgent(session, 'revoke_access denied: you cannot revoke an owner or global admin. Ask a global admin.');
    return;
  }
  // Owners are never revoked via this path — sensitive, do it manually.
  if (isOwner(targetUserId)) {
    notifyAgent(session, 'revoke_access refused: owner revocation must be done by direct edit (safety).');
    return;
  }
  // Scoped admins can only revoke `member`, not `admin` (that's an escalation).
  if (!callerIsGlobal && isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    notifyAgent(session, 'revoke_access denied: only a global admin can revoke another admin.');
    return;
  }

  let revoked = false;
  if (isMember(targetUserId, targetAgentGroupId)) {
    removeMember(targetUserId, targetAgentGroupId);
    revoked = true;
  }
  if (isAdminOfAgentGroup(targetUserId, targetAgentGroupId)) {
    revokeRole(targetUserId, 'admin', targetAgentGroupId);
    revoked = true;
  }

  if (!revoked) {
    notifyAgent(session, `\`${targetUserId}\` had no access to \`${targetAgentGroupId}\` to revoke.`);
    return;
  }
  log.info('revoke_access: revoked', { callerId, targetUserId, targetAgentGroupId });
  notifyAgent(session, `Revoked access: \`${targetUserId}\` ← \`${targetAgentGroupId}\`.`);
}

export async function handleListAccess(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const args = content as GrantArgs;
  const targetAgentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId : session.agent_group_id;
  if (!getAgentGroup(targetAgentGroupId)) {
    notifyAgent(session, `list_access failed: agent group \`${targetAgentGroupId}\` does not exist.`);
    return;
  }

  const owners = getOwners();
  const globalAdmins = getGlobalAdmins();
  const scopedAdmins = getAdminsOfAgentGroup(targetAgentGroupId);
  const members = getMembers(targetAgentGroupId);

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

  notifyAgent(session, lines.join('\n'));
}

registerDeliveryAction('grant_access', handleGrantAccess);
registerDeliveryAction('revoke_access', handleRevokeAccess);
registerDeliveryAction('list_access', handleListAccess);
