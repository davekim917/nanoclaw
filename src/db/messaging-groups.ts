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
import { updateColumnsById } from './update-columns.js';

// ── Messaging Groups ──

export async function createMessagingGroup(group: MessagingGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @instance, @name, @is_group, @unknown_sender_policy, @created_at)`,
    { ...group, instance: group.instance ?? group.channel_type },
  );
}

/**
 * For the synchronous guard-path caller (`modules/agent-to-agent/write-destinations.ts`'s `resolve()`, inside the
 * central lease just before a REPLACE-shaped mailbox write), which runs the SAME statement through `withRawDb`. One
 * constant, two executors, never a `*Sync` twin.
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
 * `adapter`: the raw platform string from the generic metadata fetch. `classified`: the classification seam's answer,
 * which can enrich it (a Slack MPDM is named by its roster, not its `mpdm-…` slug). `classified` outranks `adapter`.
 */
export type ChannelNameSource = 'adapter' | 'classified';

/** Only the ordering matters. */
const CHANNEL_NAME_SOURCE_RANK: Record<ChannelNameSource, number> = { adapter: 0, classified: 1 };

export function channelNameProvenance(platform: string, source: ChannelNameSource): string {
  return `${platform}:${source}`;
}

/** A pre-069 or unparseable token reads as adapter-sourced on the row's own platform. */
function parseChannelNameProvenance(
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
 * THE channel-name invariant: a stored name is overwritten only when empty, or by a refresh from the same platform
 * with a name source at least as well informed as the one that produced it. This keeps the generic metadata fetch
 * from undoing the classifier.
 * Consequence: a platform-side rename of a classified name is NOT picked up by the raw fetch (it cannot tell a rename
 * from the un-enriched view); only a classified refresh renames it.
 */
export function channelNameProvenanceAccepts(
  current: { name: string | null; name_source?: string | null; channel_type: string },
  incoming: { platform: string; source: ChannelNameSource },
): boolean {
  if (!current.name) return true;
  const held = parseChannelNameProvenance(current.name_source, current.channel_type);
  if (held.platform !== incoming.platform) return false;
  return CHANNEL_NAME_SOURCE_RANK[incoming.source] >= CHANNEL_NAME_SOURCE_RANK[held.source];
}

/**
 * `name` and `name_source` move together, enforced by the type: a name without provenance is indistinguishable from a
 * pre-069 row and would reopen the clobber.
 */
export type MessagingGroupUpdates = Partial<Pick<MessagingGroup, 'is_group' | 'unknown_sender_policy'>> &
  ({ name: string; name_source: string } | { name?: never; name_source?: never });

export async function updateMessagingGroup(id: string, updates: MessagingGroupUpdates): Promise<void> {
  await updateColumnsById('messaging_groups', id, updates);
}

/**
 * The provenance check runs INSIDE the write: the caller decides from a row it read and then awaits, and the router's
 * classified name can land in that window. The CASE is `channelNameProvenanceAccepts` clause for clause
 * (`@accept0`/`@accept1` are the tokens of rank ≤ incoming; NULL or unparseable reads as adapter on the row's own
 * platform). `is_group` has no provenance and is written unconditionally.
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

/**
 * Refuse to wire an agent into a messaging-group row already served by a
 * different workgroup. Agents fanned out on one wiring row share thread
 * worktrees, so a row never spans workgroups. Workgroup
 * identity falls back to the group folder for pre-workgroup rows, matching
 * container-runner's resolution.
 */
// Runs inside two central transaction closures (`createMessagingGroupAgent` and `cli/resources/wirings.ts`), which
// exist to make this guard and the INSERT atomic: one driver read, nothing else.
export async function assertSameWorkgroupWiring(messagingGroupId: string, agentGroupId: string): Promise<void> {
  // Scope: THIS row only. An identical platform_id on another row may be the same channel via a sibling bot app (must
  // share) or a colliding workspace (must not), so cross-row isolation is enforced where sharing happens: thread
  // worktree and cache paths are namespaced by workgroup. The row-level rule is unconditional: the workgroup is the
  // data-pool boundary.
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
  // One central transaction so the guard, the insert and the companion destination's name allocation are atomic
  // against a concurrent wiring; allocated after commit, two wirings with the same name both saw the base
  // `local_name` free and the second died on the primary key after its wiring committed.
  await centralTransaction(() => createMessagingGroupAgentInTransaction(mga), 'createMessagingGroupAgent');
}

/**
 * For a caller that ALREADY holds the lease (`centralTransaction` refuses to nest), such as the router's
 * workspace-trust auto-wire. DB-only.
 */
export async function createMessagingGroupAgentInTransaction(mga: MessagingGroupAgent): Promise<void> {
  await assertSameWorkgroupWiring(mga.messaging_group_id, mga.agent_group_id);
  await insertMessagingGroupAgentRow(mga);
  await ensureAgentDestinationForWiring(mga);
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
// DB-only: called inside the central transaction closures of `cli/resources/wirings.ts` and
// `createMessagingGroupAgent`.
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
  // COALESCE to OPERATIONAL defaults, not the stale schema defaults, so hand-inserted rows behave like router-created
  // ones: 'accumulate' (dropping loses thread context the agent needs when it engages) and 'per-thread' (shared
  // collapses unrelated threads into one session).
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
 * Peer agent groups on the same platform channel, excluding self, for the spawn-time peer roster. Matched on
 * `platform_id`, not messaging_group_id, because sibling bot adapters on one channel have separate messaging groups.
 * Also constrained to self's workgroup: platform ids are only workspace-unique, and the workgroup is the tenant
 * boundary (pre-036 schemas fall back to platform-only).
 */
export interface ChannelPeer {
  agent_group_id: string;
  name: string;
  /** Indexes `knownSlackBots`/`knownDiscordBots` for the peer's bot user id. */
  channel_type: string;
}

export async function getChannelPeers(messagingGroupId: string, agentGroupId: string): Promise<ChannelPeer[]> {
  const db = getDb();
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(agent_groups)`);
  const hasWorkgroupId = cols.some((c) => c.name === 'workgroup_id');
  // The self-side workgroup comes from a second agent_groups join.
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
  await updateColumnsById('messaging_group_agents', id, updates);
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
