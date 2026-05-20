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
 * by HANDLE (the segment after the first colon) within the same Slack
 * WORKSPACE (the channel_type with known sibling suffixes stripped). For
 * Slack that means `slack-madisonreed:U0…` and `slack-madisonreed-codex:U0…`
 * both count as the same owner from the gate's perspective.
 *
 * Cross-tenant defense: workspace matching is keyed on the FULL channel_type
 * (sibling suffix stripped) — `slack-madisonreed` vs `slack-illysium` stay
 * distinct, so a hypothetical user_id collision in a different Slack
 * workspace cannot satisfy the gate. The MCP is Slack-only by name and the
 * gate enforces it by requiring both sides to be `slack-*` channel_types —
 * a Discord DM session can never satisfy the Slack MCP gate even if its
 * handle happens to equal an owner's.
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
  const dmWorkspace = slackWorkspaceOf(dm.channel_type);
  // Slack MCP only applies in Slack DMs. Non-Slack channel_types short-
  // circuit here regardless of handle, preventing a Discord/Telegram DM
  // session with a colliding handle from satisfying the gate.
  if (!dmHandle || !dmWorkspace) return false;

  // Match any global owner whose handle equals the DM user's handle AND
  // whose channel_type resolves to the SAME Slack workspace after stripping
  // sibling suffixes. `slack-madisonreed:U0…` ≡ `slack-madisonreed-codex:U0…`
  // (same workspace, sibling bots). `slack-madisonreed:U0…` ≢
  // `slack-illysium:U0…` (different workspaces — colliding handles do NOT
  // cross-tenant escalate). Caught by Codex review on PR #110.
  const owners = db
    .prepare(`SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL`)
    .all() as Array<{ user_id: string }>;

  for (const o of owners) {
    if (handleOf(o.user_id) !== dmHandle) continue;
    const ownerChannelType = channelTypeOf(o.user_id);
    if (!ownerChannelType) continue;
    if (slackWorkspaceOf(ownerChannelType) !== dmWorkspace) continue;
    return true;
  }
  return false;
}

/**
 * Known sibling-bot channel-type suffixes. The clone-as-codex skill provisions
 * codex twins under a `-codex`-suffixed Slack app; future sibling kinds (e.g.,
 * `-research`, `-data-analyst`) would follow the same convention. Add to this
 * list when a new sibling kind ships — the test suite covers each pattern.
 */
const SIBLING_CHANNEL_SUFFIXES = ['-codex'] as const;

/**
 * Extract the handle from a NanoClaw user_id (`<channel_type>:<handle>`).
 * Returns null when there is no `:` separator.
 */
function handleOf(userId: string): string | null {
  const idx = userId.indexOf(':');
  if (idx < 0) return null;
  return userId.slice(idx + 1) || null;
}

/** Extract the channel_type prefix from a NanoClaw user_id. */
function channelTypeOf(userId: string): string | null {
  const idx = userId.indexOf(':');
  if (idx <= 0) return null;
  return userId.slice(0, idx);
}

/**
 * Resolve the Slack WORKSPACE for a channel_type. Returns null for non-Slack
 * channel_types (Discord/Telegram/etc.) — the Slack MCP gate must refuse to
 * cross platforms even if a handle happens to collide.
 *
 *   slack-madisonreed       → "slack-madisonreed"
 *   slack-madisonreed-codex → "slack-madisonreed"   (sibling suffix stripped)
 *   slack-illysium          → "slack-illysium"      (different workspace, no match with above)
 *   slack-illysium-codex    → "slack-illysium"
 *   discord                 → null                   (not Slack — gate denies)
 *   discord-axie-codex      → null
 *   telegram                → null
 */
function slackWorkspaceOf(channelType: string): string | null {
  if (channelType !== 'slack' && !channelType.startsWith('slack-')) return null;
  for (const suffix of SIBLING_CHANNEL_SUFFIXES) {
    if (channelType.endsWith(suffix)) {
      return channelType.slice(0, -suffix.length);
    }
  }
  return channelType;
}
