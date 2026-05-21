import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
// Transitional tier violation: core imports from optional agent-to-agent module.
// `createMessagingGroupAgent` auto-creates a destination row on wiring — the
// two concerns are currently bundled. When agent-to-agent isn't installed,
// the table doesn't exist and this import chain remains dormant because
// `createMessagingGroupAgent` is only called from setup/admin paths that
// also only run when wiring channels to agents (which implicitly requires
// agent-to-agent for the destination ACL to mean anything). A cleaner split
// (or making the destination side effect module-owned) is tracked in the
// refactor plan.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { getDb, hasTable } from './connection.js';

// ── Messaging Groups ──

export function createMessagingGroup(group: MessagingGroup): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @name, @is_group, @unknown_sender_policy, @created_at)`,
    )
    .run(group);
}

export function getMessagingGroup(id: string): MessagingGroup | undefined {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE id = ?').get(id) as MessagingGroup | undefined;
}

export function getMessagingGroupByPlatform(channelType: string, platformId: string): MessagingGroup | undefined {
  return getDb()
    .prepare('SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as MessagingGroup | undefined;
}

/**
 * Combined lookup for the router's fast-drop path. Returns the messaging
 * group (if it exists) and a count of wired agents in one query — lets
 * `routeInbound` short-circuit messages for unwired / unknown channels
 * with a single DB read instead of four (mg lookup, sender upsert, agents
 * lookup, dropped_messages insert).
 *
 * Returns `null` when no messaging_groups row exists for this channel.
 * Returns `{ mg, agentCount: 0 }` when the row exists but has no wired
 * agents. Uses the `UNIQUE(channel_type, platform_id)` index plus the
 * `UNIQUE(messaging_group_id, agent_group_id)` index for the JOIN — both
 * covered by existing SQLite auto-indexes from the UNIQUE constraints.
 */
export function getMessagingGroupWithAgentCount(
  channelType: string,
  platformId: string,
): { mg: MessagingGroup; agentCount: number } | null {
  const row = getDb()
    .prepare(
      `SELECT mg.*, COUNT(mga.id) AS agent_count
         FROM messaging_groups mg
    LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = ? AND mg.platform_id = ?
     GROUP BY mg.id`,
    )
    .get(channelType, platformId) as (MessagingGroup & { agent_count: number }) | undefined;
  if (!row) return null;
  const { agent_count, ...mg } = row;
  return { mg: mg as MessagingGroup, agentCount: agent_count };
}

export function getAllMessagingGroups(): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups ORDER BY name').all() as MessagingGroup[];
}

export function getMessagingGroupsByChannel(channelType: string): MessagingGroup[] {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE channel_type = ?').all(channelType) as MessagingGroup[];
}

export function updateMessagingGroup(
  id: string,
  updates: Partial<Pick<MessagingGroup, 'name' | 'is_group' | 'unknown_sender_policy'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroup(id: string): void {
  getDb().prepare('DELETE FROM messaging_groups WHERE id = ?').run(id);
}

/**
 * Mark a messaging group as denied by the owner (channel-registration flow).
 * Future mentions on this channel silently drop until an admin explicitly
 * wires it via `createMessagingGroupAgent`, which implicitly clears the
 * denied state by making `agentCount > 0` — the router's denied-channel
 * check sits on the `agentCount === 0` branch.
 *
 * Passing null unsets the flag (used by tests or a future "unblock channel"
 * admin command).
 */
export function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): void {
  getDb().prepare('UPDATE messaging_groups SET denied_at = ? WHERE id = ?').run(deniedAt, id);
}

// ── Messaging Group Agents ──

/**
 * Wire a messaging group to an agent group. Also auto-creates the matching
 * `agent_destinations` row so the agent can deliver to this chat as a
 * target, not just reply to the origin. Without this, routing to chats that
 * aren't the session's origin (agent-shared sessions, cross-channel sends)
 * would require an operator to hand-insert destination rows every time.
 *
 * The destination row is skipped if one already exists for the same target,
 * so re-wiring is a no-op. The local_name uses the messaging group's `name`
 * field when set, falling back to `${channel_type}-${mg_id prefix}`, with
 * a numeric suffix to break collisions within the agent's namespace. This
 * mirrors the backfill logic in migration 004.
 */
export function createMessagingGroupAgent(mga: MessagingGroupAgent): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, default_model, default_effort, default_tone,
         created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id,
         @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @default_model, @default_effort, @default_tone,
         @created_at
       )`,
    )
    .run(mga);

  // Auto-create an agent_destinations row so delivery's ACL doesn't block
  // outbound messages that target this chat. Guarded: when the agent-to-agent
  // module isn't installed the table doesn't exist — skip silently. Without
  // the module, the ACL check in delivery is also skipped (same guard), so
  // channel sends still work.
  //
  // ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
  // `agent_destinations` row. It does NOT project into any running
  // agent's session inbound.db (see top-of-file invariant in
  // src/modules/agent-to-agent/db/agent-destinations.ts). In practice this
  // is fine because the only real callers are one-shot setup scripts
  // (setup/register.ts, scripts/init-first-agent.ts, /manage-channels
  // skill) that run in a separate process from the host. Any already-
  // running container for `mga.agent_group_id` will keep serving the
  // stale projection until its next wake (idle timeout or next inbound
  // message) at which point spawnContainer's writeDestinations call
  // refreshes from central. If you call this from code that runs INSIDE
  // the host process and need the refresh to happen immediately,
  // explicitly call the module's `writeDestinations(mga.agent_group_id,
  // <sessionId>)` afterwards.
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const existing = getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
  if (existing) return;

  const mg = getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (getDestinationByName(mga.agent_group_id, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }

  createDestination({
    agent_group_id: mga.agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: mga.messaging_group_id,
    created_at: mga.created_at,
  });
}

export function getMessagingGroupAgents(messagingGroupId: string): MessagingGroupAgent[] {
  // COALESCE-hydrate nullable columns to OPERATIONAL defaults (not the schema
  // CREATE TABLE defaults) so manually-inserted rows match how the router
  // actually wires new MGs. The schema defaults (`drop`, `shared`) are stale
  // relative to runtime behavior:
  //
  //   - ignored_message_policy='accumulate' — matches router.ts:370 (auto-create
  //     uses 'accumulate'). Drop = silently discard non-engaging messages,
  //     which loses thread context the agent needs when it later engages.
  //   - session_mode='per-thread' — matches every channel's operational config
  //     (NANOCLAW_DEFAULT_SESSION_MODE_SLACK_<workspace>=per-thread). Shared
  //     would collapse every thread into one session, mixing context across
  //     unrelated conversations.
  //
  // Schema CREATE TABLE defaults need a separate migration to match.
  return getDb()
    .prepare(
      `SELECT
         id, messaging_group_id, agent_group_id,
         COALESCE(engage_mode, 'mention') AS engage_mode,
         engage_pattern,
         COALESCE(sender_scope, 'all') AS sender_scope,
         COALESCE(ignored_message_policy, 'accumulate') AS ignored_message_policy,
         COALESCE(session_mode, 'per-thread') AS session_mode,
         COALESCE(priority, 0) AS priority,
         default_model, default_effort, default_tone,
         created_at
       FROM messaging_group_agents
       WHERE messaging_group_id = ?
       ORDER BY priority DESC`,
    )
    .all(messagingGroupId) as MessagingGroupAgent[];
}

export function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): MessagingGroupAgent | undefined {
  return getDb()
    .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(messagingGroupId, agentGroupId) as MessagingGroupAgent | undefined;
}

/**
 * Peer agent_groups operating on the same platform-side channel as
 * `agentGroupId` — excluding the agent itself. Used by container-runner at
 * spawn time to inject the in-channel peer roster into the runtime system
 * prompt.
 *
 * Sibling adapter awareness: Bo and Bo-codex on the SAME Slack channel
 * have SEPARATE NanoClaw messaging_groups (one per bot adapter:
 * `slack-madisonreed` for Bo, `slack-madisonreed-codex` for Bo-codex)
 * even though Slack-side they're in the same channel. The shared identity
 * is `messaging_groups.platform_id` (the Slack channel id / Discord
 * snowflake). Matching on platform_id rather than messaging_group_id
 * surfaces siblings across adapters; matching on messaging_group_id alone
 * would miss Bo-codex when querying from Bo's session.
 *
 * The peer's bot user_id (for canonical `<@U…>` mentions) is resolved by
 * the caller from `knownSlackBots`/`knownDiscordBots` keyed by the peer's
 * `channel_type` (which IS distinct per adapter and tells us which
 * registry entry to look up).
 */
export interface ChannelPeer {
  agent_group_id: string;
  name: string;
  /** channel_type of THIS peer's wiring on the platform channel — used to
   *  index `knownSlackBots`/`knownDiscordBots` for the peer's bot user_id. */
  channel_type: string;
}

export function getChannelPeers(messagingGroupId: string, agentGroupId: string): ChannelPeer[] {
  return getDb()
    .prepare(
      `SELECT ag.id   AS agent_group_id,
              ag.name AS name,
              mg.channel_type AS channel_type
       FROM messaging_group_agents mga
       JOIN agent_groups     ag       ON ag.id = mga.agent_group_id
       JOIN messaging_groups mg       ON mg.id = mga.messaging_group_id
       JOIN messaging_groups mg_self  ON mg_self.id = ?
       WHERE mg.platform_id    = mg_self.platform_id
         AND mga.agent_group_id != ?
       ORDER BY ag.name`,
    )
    .all(messagingGroupId, agentGroupId) as ChannelPeer[];
}

export function getMessagingGroupAgent(id: string): MessagingGroupAgent | undefined {
  return getDb().prepare('SELECT * FROM messaging_group_agents WHERE id = ?').get(id) as
    | MessagingGroupAgent
    | undefined;
}

export function updateMessagingGroupAgent(
  id: string,
  updates: Partial<
    Pick<
      MessagingGroupAgent,
      | 'engage_mode'
      | 'engage_pattern'
      | 'sender_scope'
      | 'ignored_message_policy'
      | 'session_mode'
      | 'priority'
      | 'default_model'
      | 'default_effort'
      | 'default_tone'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteMessagingGroupAgent(id: string): void {
  getDb().prepare('DELETE FROM messaging_group_agents WHERE id = ?').run(id);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export function getMessagingGroupsByAgentGroup(agentGroupId: string): MessagingGroup[] {
  return getDb()
    .prepare(
      `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as MessagingGroup[];
}

/**
 * Pick the "primary" messaging group for an agent group — the one a background
 * task (e.g. daily wiki synthesise) should post its findings to. Ranks by
 * messaging_group_agents.priority DESC, with messaging_groups.created_at ASC
 * as a stable tiebreaker (older wiring wins). Returns null when the agent
 * group has no wired channels yet (e.g. brand-new agents from create_agent
 * before any wiring); callers must handle that case.
 */
export function getPrimaryMessagingGroupByAgentGroup(agentGroupId: string): MessagingGroup | null {
  const row = getDb()
    .prepare(
      `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?
       ORDER BY mga.priority DESC, mg.created_at ASC
       LIMIT 1`,
    )
    .get(agentGroupId);
  return (row as MessagingGroup | undefined) ?? null;
}
