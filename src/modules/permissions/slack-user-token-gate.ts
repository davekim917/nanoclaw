import type Database from 'better-sqlite3';

import type { SlackUserTokenConfig } from '../../container-config.js';

/**
 * Per-spawn permission gate for the Slack user-token MCP.
 *
 * The agent's container.json sets `slack_user_token.enabled: true` to grant
 * the CAPABILITY at all. This function decides whether — for THIS session's
 * messaging context — the MCP should be registered in the per-spawn config.
 *
 * Fail-closed semantics:
 *   - Capability not enabled → never register
 *   - Session has no messaging_group (e.g., admin shell) → never register
 *   - Default: only register when the session is the OWNER'S 1:1 DM with the
 *     agent. The user-token reads from the owner's lens; surfacing it in a
 *     shared channel would let teammates query the owner's DMs through the
 *     agent.
 *   - Override: `also_allowed_in` is an operator-curated list of
 *     `messaging_group.id` values that bypass the default. Use for trusted
 *     private channels (e.g., a channel that's just the owner + a vetted
 *     collaborator where queries from the owner's lens are acceptable).
 *
 * The check is run at spawn time, not per-tool-call: if the gate denies, the
 * MCP server is never spawned for this session, so the in-container agent
 * cannot invoke its tools at all. That's safer than runtime per-call gating
 * (no risk of an LLM bypass, no per-call DB lookup hot path).
 */
export function canUseSlackUserToken(
  db: Database.Database,
  sessionMessagingGroupId: string | null,
  config: SlackUserTokenConfig | undefined,
): boolean {
  if (!config?.enabled) return false;
  if (!sessionMessagingGroupId) return false;

  if (config.also_allowed_in?.includes(sessionMessagingGroupId)) return true;

  // Default gate: the messaging_group must be a 1:1 DM AND it must be the
  // owner's DM for this platform (per user_dms cache). The owner role on
  // user_roles is global (agent_group_id IS NULL).
  const row = db
    .prepare(
      `SELECT 1
       FROM user_roles ur
       JOIN user_dms ud ON ud.user_id = ur.user_id
       JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
       WHERE ur.role = 'owner'
         AND ur.agent_group_id IS NULL
         AND ud.messaging_group_id = ?
         AND mg.is_group = 0
       LIMIT 1`,
    )
    .get(sessionMessagingGroupId);

  return row !== undefined;
}
