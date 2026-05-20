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
 * Sibling-aware matching: codex twins (and any future sibling agents that
 * have their own bot user) get their own channel adapter and therefore their
 * own `channel_type` namespace. The same human appears as TWO distinct
 * `users` rows — `slack-madisonreed:U0…` for the bo DM and
 * `slack-madisonreed-codex:U0…` for the bo-codex DM. A naive exact-match
 * JOIN between `user_roles.user_id` and `user_dms.user_id` would only see
 * the owner of the bot they originally talked to. Instead, the gate matches
 * by HANDLE (the segment after the first colon) within the same channel
 * FAMILY (the segment before the first hyphen in `channel_type`). For Slack
 * that means `slack-madisonreed:U0…` and `slack-madisonreed-codex:U0…` both
 * count as the same owner from the gate's perspective. The channel-family
 * check prevents accidental cross-platform handle collisions (a Discord
 * snowflake that happens to equal a Slack user-id string).
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

  // Find this session's DM row (must be is_group=0).
  const dm = db
    .prepare(
      `SELECT ud.user_id AS user_id, mg.channel_type AS channel_type
       FROM user_dms ud
       JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
       WHERE ud.messaging_group_id = ?
         AND mg.is_group = 0
       LIMIT 1`,
    )
    .get(sessionMessagingGroupId) as { user_id: string; channel_type: string } | undefined;

  if (!dm) return false;

  const dmHandle = handleOf(dm.user_id);
  const dmFamily = familyOf(dm.channel_type);
  if (!dmHandle || !dmFamily) return false;

  // Match any global owner whose handle equals the DM user's handle AND
  // whose channel-type family matches (Slack-to-Slack, Discord-to-Discord).
  const owners = db
    .prepare(`SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL`)
    .all() as Array<{ user_id: string }>;

  for (const o of owners) {
    if (handleOf(o.user_id) !== dmHandle) continue;
    if (familyOfUserId(o.user_id) !== dmFamily) continue;
    return true;
  }
  return false;
}

/**
 * Extract the handle from a NanoClaw user_id (`<channel_type>:<handle>`).
 * Returns null when there is no `:` separator.
 */
function handleOf(userId: string): string | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  return userId.slice(idx + 1) || null;
}

/**
 * Extract the channel-type family from a NanoClaw user_id. The family is
 * the segment before the first hyphen in the channel_type prefix. Examples:
 *   slack-madisonreed:U0…       → "slack"
 *   slack-madisonreed-codex:U0… → "slack"
 *   discord-axie-codex:6087…    → "discord"
 *   discord:6087…               → "discord"
 *   telegram:6037840640         → "telegram"
 */
function familyOfUserId(userId: string): string | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  return familyOf(userId.slice(0, idx));
}

/** Same as familyOfUserId but takes a raw channel_type string. */
function familyOf(channelType: string): string | null {
  if (!channelType) return null;
  const dash = channelType.indexOf('-');
  return dash < 0 ? channelType : channelType.slice(0, dash);
}
