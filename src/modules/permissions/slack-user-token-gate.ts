import type { RawStatements } from '../../db/central-lease.js';

/**
 * Slack user-token owner-safety boundary. The OneCLI proxy injects the owner's
 * user token (xoxp-), which reads from the OWNER's Slack lens, so a session
 * that is not owner-safe spawns under the `<group>-noslack` identity whose
 * secret set excludes it. Decided at spawn, not per call, and this function is
 * the whole authorization decision.
 *
 * The same human appears as distinct `users` rows on sibling adapters
 * (`slack-x:U0…`, `slack-x-codex:U0…`). Matching them by parsing channel_type
 * strings is unsafe (family collapse, a workspace literally named `acme-codex`),
 * so matching needs HANDLE equality AND platform prefix AND WORKGROUP membership.
 * The Slack workspace itself is never checked: different workspaces MUST be in
 * different workgroups, or a matching handle authorizes across them.
 */

/**
 * Owner-safe iff the session's messaging group is in the operator-curated
 * `also_allowed_in` list, OR the session is the owner's 1:1 DM with this agent.
 * Fail-closed: no messaging group (admin shell) → not owner-safe. Unrelated to
 * `session_mode`, and independent of `slack_user_token.enabled`.
 */
export function isOwnerSafeSlackSession(
  db: RawStatements,
  agentGroupId: string,
  sessionMessagingGroupId: string | null,
  alsoAllowedIn: string[] | undefined,
): boolean {
  if (!sessionMessagingGroupId) return false;

  if (alsoAllowedIn?.includes(sessionMessagingGroupId)) return true;

  // The default path requires ALL of: the session's messaging group is a 1:1
  // DM wired to THIS agent (a multi-wired DM must not authorize via another
  // agent's workgroup); the agent has a workgroup; and a global owner with a DM
  // in that SAME workgroup shares the session user's handle AND platform prefix.

  type SessionRow = { user_id: string };
  const sessionRow = db
    .prepare(
      `SELECT ud_session.user_id AS user_id
       FROM messaging_group_agents mga_session
       JOIN agent_groups     a_session  ON a_session.id  = mga_session.agent_group_id
       JOIN messaging_groups mg_session ON mg_session.id = mga_session.messaging_group_id
       JOIN user_dms         ud_session ON ud_session.messaging_group_id = mga_session.messaging_group_id
       WHERE mga_session.messaging_group_id = ?
         AND mga_session.agent_group_id     = ?
         AND mg_session.is_group            = 0
         AND a_session.workgroup_id IS NOT NULL
       LIMIT 1`,
    )
    .get(sessionMessagingGroupId, agentGroupId) as SessionRow | undefined;

  if (!sessionRow) return false;

  const sessionHandle = handleOf(sessionRow.user_id);
  const sessionPrefix = platformPrefixOf(sessionRow.user_id);
  if (!sessionHandle || !sessionPrefix) return false;

  type OwnerRow = { user_id: string };
  const owners = db
    .prepare(
      `SELECT ur.user_id AS user_id
       FROM user_roles ur
       JOIN user_dms             ud_owner  ON ud_owner.user_id           = ur.user_id
       JOIN messaging_group_agents mga_owner ON mga_owner.messaging_group_id = ud_owner.messaging_group_id
       JOIN agent_groups         a_owner   ON a_owner.id                 = mga_owner.agent_group_id
       JOIN messaging_groups     mg_owner  ON mg_owner.id                = mga_owner.messaging_group_id
       JOIN messaging_group_agents mga_session ON mga_session.messaging_group_id = ?
       JOIN agent_groups         a_session ON a_session.id               = mga_session.agent_group_id
       WHERE ur.role = 'owner'
         AND ur.agent_group_id IS NULL
         AND mga_session.agent_group_id = ?
         AND mg_owner.is_group  = 0
         AND a_owner.workgroup_id = a_session.workgroup_id`,
    )
    .all(sessionMessagingGroupId, agentGroupId) as OwnerRow[];

  for (const owner of owners) {
    if (handleOf(owner.user_id) !== sessionHandle) continue;
    if (platformPrefixOf(owner.user_id) !== sessionPrefix) continue;
    return true;
  }
  return false;
}

function handleOf(userId: string): string | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  const handle = userId.slice(idx + 1);
  return handle || null;
}

function platformPrefixOf(userId: string): string | null {
  const colon = userId.indexOf(':');
  if (colon <= 0) return null;
  const channelType = userId.slice(0, colon);
  const dash = channelType.indexOf('-');
  return dash < 0 ? channelType : channelType.slice(0, dash);
}
