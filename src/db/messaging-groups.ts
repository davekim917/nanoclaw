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
import { centralTransaction } from './central-lease.js';
import { getDb, hasTable } from './connection.js';

// ── Messaging Groups ──

export async function createMessagingGroup(group: MessagingGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @instance, @name, @is_group, @unknown_sender_policy, @created_at)`,
    { ...group, instance: group.instance ?? group.channel_type },
  );
}

/**
 * The `getMessagingGroup` read as a constant, so the one synchronous
 * guard-path caller — `modules/agent-to-agent/write-destinations.ts`'s
 * `resolve()`, which runs inside the central lease immediately before a
 * REPLACE-shaped mailbox write — executes the SAME statement through
 * `withRawDb`. One constant, two executors, not a `*Sync` twin (plan
 * docs/specs/upstream-async-central-db-seam/plan.md §4.5 I-1).
 */
export const MESSAGING_GROUP_BY_ID_SQL = 'SELECT * FROM messaging_groups WHERE id = ?';

export async function getMessagingGroup(id: string): Promise<MessagingGroup | undefined> {
  return getDb().get<MessagingGroup>(MESSAGING_GROUP_BY_ID_SQL, id);
}

/**
 * Outbound / cold-DM / setup lookup by platform address.
 *
 * Instance semantics are deliberately ASYMMETRIC with the router's
 * `getMessagingGroupWithAgentCount` (exact-only): outbound callers usually
 * don't know (or care) which adapter instance owns a chat, so an unset
 * `instance` resolves the default instance first (instance = channel_type),
 * falling back deterministically to the lexically-first named instance.
 * A set `instance` is exact-only — unknown instance returns undefined.
 */
export async function getMessagingGroupByPlatform(
  channelType: string,
  platformId: string,
  instance?: string,
): Promise<MessagingGroup | undefined> {
  if (instance !== undefined) {
    return getDb().get<MessagingGroup>(
      'SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ? AND instance = ?',
      channelType,
      platformId,
      instance,
    );
  }
  return getDb().get<MessagingGroup>(
    `SELECT * FROM messaging_groups
        WHERE channel_type = ? AND platform_id = ?
     ORDER BY (instance = channel_type) DESC, instance ASC
        LIMIT 1`,
    channelType,
    platformId,
  );
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
 * agents. Uses the `UNIQUE(channel_type, platform_id, instance)` index plus
 * the `UNIQUE(messaging_group_id, agent_group_id)` index for the JOIN — both
 * covered by existing SQLite auto-indexes from the UNIQUE constraints.
 *
 * `instance` is EXACT-ONLY, with no fallback — deliberately asymmetric with
 * `getMessagingGroupByPlatform`'s default-instance-first resolution. An
 * unknown named instance must return null so the router auto-creates a
 * per-instance group instead of hijacking a sibling instance's row. The
 * default param (= channelType) keeps instance-less callers resolving the
 * default instance, identical to pre-instance behavior.
 */
export async function getMessagingGroupWithAgentCount(
  channelType: string,
  platformId: string,
  instance: string = channelType,
): Promise<{ mg: MessagingGroup; agentCount: number } | null> {
  const row = await getDb().get<MessagingGroup & { agent_count: number }>(
    `SELECT mg.*, COUNT(mga.id) AS agent_count
         FROM messaging_groups mg
    LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = ? AND mg.platform_id = ? AND mg.instance = ?
     GROUP BY mg.id`,
    channelType,
    platformId,
    instance,
  );
  if (!row) return null;
  const { agent_count, ...mg } = row;
  return { mg: mg as MessagingGroup, agentCount: agent_count };
}

export async function getAllMessagingGroups(): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>('SELECT * FROM messaging_groups ORDER BY name');
}

/**
 * All messaging groups on a platform, across every adapter instance.
 * Semantics intentionally unchanged by the instance dimension — channel_type
 * stays the semantic platform key. No live caller today; if a caller needs
 * a single instance's rows, filter on `mg.instance`.
 */
export async function getMessagingGroupsByChannel(channelType: string): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>('SELECT * FROM messaging_groups WHERE channel_type = ?', channelType);
}

/**
 * How a channel name was derived.
 *
 *  - `adapter`    — the raw string the platform puts on the conversation,
 *                   read by the generic per-channel metadata fetch
 *                   (`reportChannelMetadata`, chat-sdk-bridge.ts).
 *  - `classified` — the answer the classification seam produced
 *                   (`resolveConversation` / `resolveChannelName`), which can
 *                   enrich what the platform returned: a Slack MPDM has no
 *                   name a human recognizes, so it is named by its participant
 *                   roster instead of by Slack's internal `mpdm-a--b--c-1` slug.
 *
 * `classified` outranks `adapter`; see `channelNameProvenanceAccepts`.
 */
export type ChannelNameSource = 'adapter' | 'classified';

/** Higher rank = better informed. Only ordering matters, not the numbers. */
const CHANNEL_NAME_SOURCE_RANK: Record<ChannelNameSource, number> = { adapter: 0, classified: 1 };

/** The stored `messaging_groups.name_source` token for one derivation. */
export function channelNameProvenance(platform: string, source: ChannelNameSource): string {
  return `${platform}:${source}`;
}

/**
 * Read a stored token back. A row written before migration 069, or one whose
 * token is unparseable, is read as an adapter-sourced name on the row's own
 * platform — the pre-069 behavior, where a raw fetch always overwrote.
 */
export function parseChannelNameProvenance(
  raw: string | null | undefined,
  fallbackPlatform: string,
): { platform: string; source: ChannelNameSource } {
  const sep = raw ? raw.lastIndexOf(':') : -1;
  if (!raw || sep <= 0) return { platform: fallbackPlatform, source: 'adapter' };
  const source = raw.slice(sep + 1);
  if (source !== 'adapter' && source !== 'classified') return { platform: fallbackPlatform, source: 'adapter' };
  return { platform: raw.slice(0, sep), source };
}

/**
 * THE channel-name invariant, in one place:
 *
 *   a persisted channel name is only overwritten by a refresh that comes from
 *   the same platform and a name source at least as well informed as the one
 *   that produced the value being replaced — or when the name slot is empty.
 *
 * That is what keeps the generic metadata fetch from undoing the classifier.
 * Nothing here knows the shape of any platform's names: no slug patterns, no
 * per-platform exceptions. A refresh loses because of where it came from, not
 * because of what it says.
 *
 * Consequence worth knowing: a platform-side rename of a channel whose stored
 * name was classified is NOT picked up by the raw metadata fetch, because that
 * fetch cannot tell a rename from the un-enriched view of the same room. Only
 * a classified refresh renames such a channel. Renames of adapter-sourced names
 * refresh exactly as before.
 */
export function channelNameProvenanceAccepts(
  current: { name: string | null; name_source?: string | null; channel_type: string },
  incoming: { platform: string; source: ChannelNameSource },
): boolean {
  if (!current.name) return true; // empty slot — nothing to protect
  const held = parseChannelNameProvenance(current.name_source, current.channel_type);
  if (held.platform !== incoming.platform) return false;
  return CHANNEL_NAME_SOURCE_RANK[incoming.source] >= CHANNEL_NAME_SOURCE_RANK[held.source];
}

/**
 * `name` and `name_source` move together, enforced by the parameter type: a
 * name written without its provenance is indistinguishable from a pre-069 row
 * and would silently reopen the clobber the column exists to close. The union
 * makes `{ name }` alone a compile error rather than a runtime surprise.
 */
export type MessagingGroupUpdates = Partial<Pick<MessagingGroup, 'is_group' | 'unknown_sender_policy'>> &
  ({ name: string; name_source: string } | { name?: never; name_source?: never });

export async function updateMessagingGroup(id: string, updates: MessagingGroupUpdates): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = @id`, values);
}

/**
 * Apply a channel-metadata refresh with the provenance check INSIDE the write.
 *
 * `resolveChannelMetadataUpdates` (main.ts) decides from a row it READ, and
 * the adapter callback then awaits before writing; the router's classified
 * name can land in that window, and an unconditioned `updateMessagingGroup`
 * would overwrite the better-informed name with the adapter's (#416 site 5).
 * So the name/name_source pair is written through one UPDATE whose CASE
 * re-evaluates `channelNameProvenanceAccepts` against the STORED row at the
 * instant of the write — the SQL below is that predicate, clause for clause:
 *
 *   - an empty name slot accepts anything;
 *   - a parseable token accepts an incoming source of at least its own rank on
 *     the same platform, which for the two ranks is exactly the token list
 *     `@accept0`/`@accept1` (adapter accepts only `<platform>:adapter`;
 *     classified accepts both);
 *   - a NULL or unparseable token reads as adapter-sourced on the row's OWN
 *     platform (`parseChannelNameProvenance`), so it accepts when the incoming
 *     platform is that platform.
 *
 * `is_group` carries no provenance and is written unconditionally. One
 * statement, so the check and the write cannot be split by a yield.
 */
export async function applyChannelMetadataUpdates(
  id: string,
  updates: MessagingGroupUpdates,
  incoming: { platform: string; source: ChannelNameSource },
): Promise<void> {
  if (updates.name === undefined) {
    await updateMessagingGroup(id, updates);
    return;
  }
  const adapterToken = channelNameProvenance(incoming.platform, 'adapter');
  const classifiedToken = channelNameProvenance(incoming.platform, 'classified');
  await getDb().run(
    `UPDATE messaging_groups
        SET is_group = COALESCE(@is_group, is_group),
            name = CASE WHEN ${CHANNEL_NAME_ACCEPTS_SQL} THEN @name ELSE name END,
            name_source = CASE WHEN ${CHANNEL_NAME_ACCEPTS_SQL} THEN @name_source ELSE name_source END
      WHERE id = @id`,
    {
      id,
      is_group: updates.is_group ?? null,
      name: updates.name,
      name_source: updates.name_source,
      platform: incoming.platform,
      accept0: adapterToken,
      accept1: incoming.source === 'classified' ? classifiedToken : adapterToken,
    },
  );
}

/** `channelNameProvenanceAccepts` as a SQL predicate over the stored row; see `applyChannelMetadataUpdates`. */
const CHANNEL_NAME_ACCEPTS_SQL = `(
  name IS NULL OR name = ''
  OR name_source IN (@accept0, @accept1)
  OR (
    (name_source IS NULL OR (name_source NOT GLOB '?*:adapter' AND name_source NOT GLOB '?*:classified'))
    AND channel_type = @platform
  )
)`;

export async function deleteMessagingGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM messaging_groups WHERE id = ?', id);
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
export async function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): Promise<void> {
  await getDb().run('UPDATE messaging_groups SET denied_at = ? WHERE id = ?', deniedAt, id);
}

// ── Messaging Group Agents ──

/**
 * Refuse to wire an agent into a messaging-group row already served by a
 * different workgroup. Agents fanned out on one wiring row share thread
 * worktrees, so a row never spans workgroups. Workgroup
 * identity falls back to the group folder for pre-workgroup rows, matching
 * container-runner's resolution.
 */
/*
 * Runs inside two central transaction closures (`createMessagingGroupAgent`
 * below and `cli/resources/wirings.ts`'s wiring transaction), whose whole
 * point is that this guard and the INSERT are atomic: one driver read,
 * nothing else (plan §4.4).
 */
export async function assertSameWorkgroupWiring(messagingGroupId: string, agentGroupId: string): Promise<void> {
  // Scope: THIS messaging-group row only. Cross-row sharing on the same
  // platform_id cannot be policed here — an identical platform_id may be the
  // same real channel reached via a sibling bot app (must share) OR an
  // unrelated channel from a colliding workspace (must NOT share; see the
  // getChannelPeers tenant-boundary tests). That ambiguity is resolved where
  // the sharing actually happens: thread worktree/cache paths are namespaced
  // by workgroup (session-manager.ts), so cross-workgroup rows never resolve
  // to the same directory regardless of platform_id.
  //
  // This row-level invariant is intentional and unconditional — fan-out on
  // one wiring row never spans workgroups, with or without
  // NANOCLAW_THREAD_WORKTREES: the workgroup is the data-pool boundary.
  const row = await getDb().get<{ agent_group_id: string; wg: string }>(
    `SELECT ag.id AS agent_group_id, COALESCE(ag.workgroup_id, ag.folder) AS wg
         FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mga.messaging_group_id = ?
          AND wg != (SELECT COALESCE(workgroup_id, folder) FROM agent_groups WHERE id = ?)
        LIMIT 1`,
    messagingGroupId,
    agentGroupId,
  );
  if (row) {
    throw new Error(
      `Cannot wire agent group ${agentGroupId} to messaging group ${messagingGroupId}: ` +
        `agent ${row.agent_group_id} on the same channel surface belongs to workgroup '${row.wg}'. ` +
        `Agents on one channel share thread worktrees, so all must belong to the same workgroup.`,
    );
  }
}

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
export async function createMessagingGroupAgent(mga: MessagingGroupAgent): Promise<void> {
  // One central transaction (BEGIN IMMEDIATE under the driver) so guard +
  // insert are atomic against a concurrent wiring from another process (codex
  // phase-A review P2). DB-only closure (plan §4.4).
  //
  // The companion destination is allocated INSIDE the same transaction
  // (#460 round 2): its lookup, suffix allocation and insert are serialized
  // with the wiring row. Written after commit, two concurrent wirings with
  // the same normalized name both observed the base `local_name` unused, and
  // the second insert died on the (agent_group_id, local_name) primary key
  // after its wiring row had already committed. `ensureAgentDestinationForWiring`
  // is DB-only (driver statements in sequence), which is what lets it sit in
  // the closure — the same shape `cli/resources/wirings.ts` already uses.
  await centralTransaction(async () => {
    await assertSameWorkgroupWiring(mga.messaging_group_id, mga.agent_group_id);
    await insertMessagingGroupAgentRow(mga);
    await ensureAgentDestinationForWiring(mga);
  }, 'createMessagingGroupAgent');
}

async function insertMessagingGroupAgentRow(mga: MessagingGroupAgent): Promise<void> {
  await getDb().run(
    `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, default_model, default_effort, default_tone,
         instructions_profile, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id,
         @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @default_model, @default_effort, @default_tone,
         @instructions_profile, @created_at
       )`,
    mga,
  );
}

/**
 * Create the `agent_destinations` row that lets the agent address this chat
 * as a delivery target. Idempotent — no-op when the destination already
 * exists, the agent-to-agent module isn't installed, or the messaging group
 * has been deleted out from under the wiring.
 *
 * Split out from `createMessagingGroupAgent` so callers that already wrote
 * the `messaging_group_agents` row directly (e.g. the generic ncl CRUD path)
 * can still get the companion destination without re-inserting the wiring.
 *
 * ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
 * `agent_destinations` row. It does NOT project into any running agent's
 * session inbound.db (see top-of-file invariant in
 * src/modules/agent-to-agent/db/agent-destinations.ts). In practice this is
 * fine because the only real callers are one-shot setup paths
 * (setup/register.ts, scripts/init-first-agent.ts, /manage-channels skill,
 * ncl wirings create) that run in a separate process from the host. Any
 * already-running container for `mga.agent_group_id` will keep serving the
 * stale projection until its next wake (idle timeout or next inbound
 * message) at which point spawnContainer's writeDestinations call refreshes
 * from central. If you call this from code that runs INSIDE the host
 * process and need the refresh to happen immediately, explicitly call the
 * module's `writeDestinations(mga.agent_group_id, <sessionId>)` afterwards.
 */
/*
 * Called from inside the central transaction closures of
 * `cli/resources/wirings.ts` and `createMessagingGroupAgent` above, so it is
 * DB-only: driver statements, awaited in sequence, nothing else (plan §4.4).
 */
export async function ensureAgentDestinationForWiring(mga: MessagingGroupAgent): Promise<void> {
  // Guarded: when the agent-to-agent module isn't installed the table
  // doesn't exist — skip silently. Without the module, the ACL check in
  // delivery is also skipped (same guard), so channel sends still work.
  if (!(await hasTable(getDb(), 'agent_destinations'))) return;

  const existing = await getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
  if (existing) return;

  const mg = await getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (await getDestinationByName(mga.agent_group_id, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }

  await createDestination({
    agent_group_id: mga.agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: mga.messaging_group_id,
    created_at: mga.created_at,
  });
}

export async function getMessagingGroupAgents(messagingGroupId: string): Promise<MessagingGroupAgent[]> {
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
  return getDb().all<MessagingGroupAgent>(
    `SELECT
         id, messaging_group_id, agent_group_id,
         COALESCE(engage_mode, 'mention') AS engage_mode,
         engage_pattern,
         COALESCE(sender_scope, 'all') AS sender_scope,
         COALESCE(ignored_message_policy, 'accumulate') AS ignored_message_policy,
         COALESCE(session_mode, 'per-thread') AS session_mode,
         COALESCE(priority, 0) AS priority,
         default_model, default_effort, default_tone,
         threads,
         created_at
       FROM messaging_group_agents
       WHERE messaging_group_id = ?
       ORDER BY priority DESC`,
    messagingGroupId,
  );
}

export async function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): Promise<MessagingGroupAgent | undefined> {
  return getDb().get<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
    messagingGroupId,
    agentGroupId,
  );
}

/**
 * Peer agent_groups operating on the same platform-side channel as
 * `agentGroupId` — excluding the agent itself. Used by container-runner at
 * spawn time to inject the in-channel peer roster into the runtime system
 * prompt.
 *
 * Sibling adapter awareness: Example Assistant and Example Assistant Codex on the SAME Slack channel
 * have SEPARATE NanoClaw messaging_groups (one per bot adapter:
 * `slack-exampleretail` for Example Assistant, `slack-exampleretail-codex` for Example Assistant Codex)
 * even though Slack-side they're in the same channel. The shared identity
 * is `messaging_groups.platform_id` (the Slack channel id / Discord
 * snowflake). Matching on platform_id rather than messaging_group_id
 * surfaces siblings across adapters; matching on messaging_group_id alone
 * would miss Example Assistant Codex when querying from Example Assistant's session.
 *
 * Tenant scoping: peers are additionally constrained to share `workgroup_id`
 * with self. Slack channel IDs are workspace-scoped (only unique per
 * workspace, not globally), so a `slack:C123` in workspace A could in
 * principle collide with `slack:C123` in workspace B if both were ever
 * wired into the same NanoClaw install. Workgroup is the authoritative
 * multi-tenant boundary (docs/workgroups.md) so requiring a workgroup match
 * makes the lookup correct by construction rather than by luck. Pre-
 * migration-036 schemas don't have the column — fall back to platform-only
 * matching (the prior behavior) when the column is absent.
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

export async function getChannelPeers(messagingGroupId: string, agentGroupId: string): Promise<ChannelPeer[]> {
  const db = getDb();
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(agent_groups)`);
  const hasWorkgroupId = cols.some((c) => c.name === 'workgroup_id');
  // Workgroup-scoped query (post-migration-036). The self-side workgroup is
  // resolved by joining agent_groups twice: once for the peer (ag), once for
  // self (ag_self via mga_self.agent_group_id from THIS session's mg + caller).
  // Same-workgroup filter sits next to the platform_id filter so siblings in
  // OTHER workgroups are correctly excluded even if a Slack channel-id
  // collision were to occur.
  if (hasWorkgroupId) {
    return db.all<ChannelPeer>(
      `SELECT ag.id   AS agent_group_id,
                ag.name AS name,
                mg.channel_type AS channel_type
         FROM   messaging_group_agents mga
         JOIN   agent_groups     ag      ON ag.id = mga.agent_group_id
         JOIN   messaging_groups mg      ON mg.id = mga.messaging_group_id
         JOIN   messaging_groups mg_self ON mg_self.id = ?
         JOIN   agent_groups     ag_self ON ag_self.id = ?
         WHERE  mg.platform_id    = mg_self.platform_id
           AND  mga.agent_group_id != ?
           AND  ag.workgroup_id IS NOT NULL
           AND  ag.workgroup_id = ag_self.workgroup_id
         ORDER BY ag.name`,
      messagingGroupId,
      agentGroupId,
      agentGroupId,
    );
  }
  // Pre-036 fallback: platform_id only (no workgroup column to filter on).
  return db.all<ChannelPeer>(
    `SELECT ag.id   AS agent_group_id,
              ag.name AS name,
              mg.channel_type AS channel_type
       FROM   messaging_group_agents mga
       JOIN   agent_groups     ag      ON ag.id = mga.agent_group_id
       JOIN   messaging_groups mg      ON mg.id = mga.messaging_group_id
       JOIN   messaging_groups mg_self ON mg_self.id = ?
       WHERE  mg.platform_id    = mg_self.platform_id
         AND  mga.agent_group_id != ?
       ORDER BY ag.name`,
    messagingGroupId,
    agentGroupId,
  );
}

export async function getMessagingGroupAgent(id: string): Promise<MessagingGroupAgent | undefined> {
  return getDb().get<MessagingGroupAgent>('SELECT * FROM messaging_group_agents WHERE id = ?', id);
}

export async function updateMessagingGroupAgent(
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
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteMessagingGroupAgent(id: string): Promise<void> {
  await getDb().run('DELETE FROM messaging_group_agents WHERE id = ?', id);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export async function getMessagingGroupsByAgentGroup(agentGroupId: string): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>(
    `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?`,
    agentGroupId,
  );
}

/**
 * Pick the "primary" messaging group for an agent group — the one a background
 * task (for example, a daily source audit) should post its findings to. Ranks by
 * messaging_group_agents.priority DESC, with messaging_groups.created_at ASC
 * as a stable tiebreaker (older wiring wins). Returns null when the agent
 * group has no wired channels yet (e.g. brand-new agents from create_agent
 * before any wiring); callers must handle that case.
 */
export async function getPrimaryMessagingGroupByAgentGroup(agentGroupId: string): Promise<MessagingGroup | null> {
  const row = await getDb().get<MessagingGroup>(
    `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?
       ORDER BY mga.priority DESC, mg.created_at ASC
       LIMIT 1`,
    agentGroupId,
  );
  return row ?? null;
}
