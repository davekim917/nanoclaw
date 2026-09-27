/**
 * Thread-keyed work list: one row per thread, not per session (a multi-agent thread is several sessions).
 * Channels key off `thread_id`, never `messaging_group_id` (one messaging_groups row per sibling bot per channel).
 * Liveness comes from `.heartbeat` mtime, never `sessions.container_status`. `container_state` is read only for
 * sessions with a live container process, because each read opens a per-session outbound.db.
 */
import { getDb } from '../../db/connection.js';
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import { TASKS_SYSTEM_THREAD_ID, isTaskThread } from '../../db/sessions.js';
import { readSessionOutbound, type ContainerState } from '../../modules/mailbox/index.js';
import { getActiveContainerSessionIds, resolveAssistantName } from '../../container-runner.js';
import { readContainerConfig } from '../../container-config.js';
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import {
  isAttentionItemId,
  readAttentionItems,
  stripAttentionItemPrefix,
  workgroupIdsForAgentGroups,
  workgroupIdsWithAttentionSources,
  type AttentionItem,
  type AttentionSourceEnv,
} from '../../attention-sources.js';
import { log } from '../../log.js';
import type { AgentGroup, SessionMode } from '../../types.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { isSnoozed, readThreadSnoozes } from '../thread-snooze.js';
import { ASSIGN_DEDUPE_MS, assignmentKey, readItemAssignments, readUserDisplayNames } from '../db/item-assignments.js';
import { readThreadClosures, type ThreadCloseState } from '../thread-close.js';
import { requiredConfirmations } from '../thread-close-guard.js';
import {
  deriveContainerStatus,
  readSessionTranscript,
  type ContainerStatus,
  type SessionTranscriptEntry,
} from './sessions.js';

export const UNKNOWN_CHANNEL_KEY = 'unknown';

/**
 * Discord's middle segment is the guild, not the channel: keying on it would collapse every Discord channel into one
 * bucket.
 */
const EXTRA_SEGMENT_PLATFORMS: Record<string, number> = { discord: 3 };

/** Deepest channel key we will ever consider (Discord threads carry four segments). */
const MAX_KEY_SEGMENTS = 4;

/**
 * The channel key of a thread id: the longest prefix that is a wired `messaging_groups.platform_id` in `known` wins.
 * Never throws; an unreadable id goes to the shared UNKNOWN_CHANNEL_KEY bucket, never a per-row singleton.
 */
export function threadChannelKey(threadId: string | null | undefined, known?: ReadonlySet<string>): string {
  if (typeof threadId !== 'string') return UNKNOWN_CHANNEL_KEY;
  // An attention-source item id is a `<prefix>:<repo>#<n>` dedupe key, not a thread id; parsing it would mint one
  // fake channel bucket per item.
  if (isAttentionItemId(threadId)) return UNKNOWN_CHANNEL_KEY;
  const segments = threadId.trim().split(':');
  const platform = segments[0];
  if (!platform || segments.length < 2 || !segments[1]) return UNKNOWN_CHANNEL_KEY;

  if (known) {
    for (let n = Math.min(segments.length, MAX_KEY_SEGMENTS); n >= 2; n--) {
      const candidate = segments.slice(0, n).join(':');
      if (known.has(candidate)) return candidate;
    }
  }

  const want = EXTRA_SEGMENT_PLATFORMS[platform] ?? 2;
  const depth = Math.min(want, segments.length);
  // A `discord:<guild>` with no channel segment is not a channel key; fall back
  // rather than emit a guild id that would swallow the whole server.
  if (depth < want && want > 2) return UNKNOWN_CHANNEL_KEY;
  const key = segments.slice(0, depth).join(':');
  return segments[depth - 1] ? key : UNKNOWN_CHANNEL_KEY;
}

/**
 * `idle` is the residual: no container running, nothing claimed, last tool finished normally. Archived threads land
 * here.
 */
export type ThreadState = 'unassigned' | 'needs_you' | 'stalled' | 'running' | 'parked' | 'idle';

/** §5: a tool that started this long ago with nothing newer out is stuck. */
const STALL_AFTER_MS = 30 * 60_000;

export interface ThreadStateInput {
  /** How many sessions back this work item. Zero = an unowned item with no thread yet. */
  sessionCount: number;
  claimState: BoardClaim['state'] | null;
  claimNote: string;
  /** Any backing session is waiting on a human (task `needs_input`, or an unanswered `ask_question`). */
  needsOperator: boolean;
  /** Recomputed from heartbeat mtime — never `sessions.container_status` (§3.4). */
  containerStatus: ContainerStatus;
  /** `container_state.provider_status`, or null when we did not probe / it is unset. */
  providerStatus: string | null;
  toolStartedAtMs: number | null;
  /** Newest outbound across the thread's sessions, epoch ms. */
  lastOutputAtMs: number | null;
  now: number;
}

const WAITING_ON_NOTE = /\bwaiting on\b/i;

export type NeedsYouReason =
  | {
      cause: 'parked_note';
      text: string;
      /**
       * Null, never zero, when the claim has no readable `parked_at` (zero would read as "parked just now"). The
       * console never reconciles a claim against reality; the age is the staleness signal.
       */
      parked_ms: number | null;
    }
  | { cause: 'ask_question'; text: string }
  | { cause: 'task_needs_input'; text: string };

/**
 * Pure. The two `needs_you` tests must run BEFORE the `unassigned` guard: claims are keyed by thread id, so a
 * zero-session item can carry a parked claim that is waiting on a human.
 */
export function deriveThreadState(input: ThreadStateInput): ThreadState {
  if (input.claimState === 'parked' && WAITING_ON_NOTE.test(input.claimNote)) return 'needs_you';
  if (input.needsOperator) return 'needs_you';

  if (input.sessionCount === 0) return 'unassigned';

  // Age-only, never dependent on `current_tool`: Codex reports the generic `CodexItem`.
  if (input.providerStatus === 'failed') return 'stalled';
  if (
    input.toolStartedAtMs !== null &&
    input.now - input.toolStartedAtMs > STALL_AFTER_MS &&
    (input.lastOutputAtMs === null || input.lastOutputAtMs <= input.toolStartedAtMs)
  ) {
    return 'stalled';
  }

  // Liveness alone gates `running`: a healthy container between tool calls has no tool in flight.
  if (input.containerStatus === 'running' || input.providerStatus === 'active') return 'running';

  if (input.claimState === 'parked') return 'parked';
  return 'idle';
}

interface ThreadParticipant {
  agent_group_id: string;
  name: string;
  /**
   * This participant's most recent session on the thread, where a reply to it is steered. A sibling bot wired through
   * two messaging groups can hold two sessions; the freshest wins.
   */
  session_id: string;
  avatarUrl: string | null;
  /**
   * On the wire because a Codex row's `current_tool` is the generic `CodexItem`, so the UI must not promise a
   * readable step name.
   */
  provider: string;
}

interface ThreadAgentOption {
  agent_group_id: string;
  name: string;
}

export interface ThreadSummary {
  /** Durable identity (§3.1). Synthetic `session:<id>` when the session has no thread. */
  thread_id: string;
  /** True when `thread_id` above is synthetic — the session's `sessions.thread_id` is NULL. */
  synthetic: boolean;
  channel_key: string;
  /** Human channel name resolved from `messaging_groups`; falls back to the key's last segment. */
  channel_name: string;
  title: string | null;
  /** Most-recent speaker first. */
  participants: ThreadParticipant[];
  /**
   * Other agents wired to this thread's channel, which it can be handed to; empty when no wiring names the channel.
   * Kept apart from `participants` so the UI can show that picking one opens a new session.
   */
  assignable_agents: ThreadAgentOption[];
  /**
   * ISO-8601 UTC, always: `sessions.last_outbound_at` is stored naive, which `new Date()` would shift by the viewer's
   * offset.
   */
  last_activity_at: string | null;
  state: ThreadState;
  /** Present only when `state` is `needs_you`, and null even then if the cause cannot be named. */
  needs_you_reason: NeedsYouReason | null;
  session_ids: string[];
  /** Freshest liveness across the thread's sessions, from heartbeat mtime. */
  container_status: ContainerStatus;
  /** `container_state.provider_status` — null when no session was probed or the column is unset. */
  provider_status: string | null;
  current_tool: string | null;
  /** ISO-8601 UTC, normalized — see {@link ThreadSummary.last_activity_at}. */
  tool_started_at: string | null;
  /**
   * Default target of the Answer/Steer composer: the session that drove this row's state (the asker for `needs_you`,
   * the probed one for `stalled`/`running`, else the most recent). A default, never a lock.
   */
  reply_target_session_id: string | null;
  /** This caller's own snooze is in force. Per-user view state, not a thread state. */
  snoozed: boolean;
  /**
   * True for an `ncl tasks` execution's own session (`system:tasks[:<seriesId>]`), which has no messaging group and
   * so lands in the `system:tasks` pseudo-channel.
   */
  scheduled_task: boolean;
  /**
   * The agent's own `propose_done` record, or null. A flag, not a state: a proposing agent is often still `running`.
   * Only the `propose_done` MCP tool can produce it (through the sweep's mirror, so it lags up to one sweep); the
   * close path re-reads the container's copy instead.
   */
  done_proposal: ThreadDoneProposal | null;
  /** An operator-confirmed close is in flight. Not a state. */
  closing: boolean;
  /** 1 when an agent has proposed, 2 when none has. Display only: the `threads.close` guard recounts server-side. */
  close_confirmations_required: 1 | 2;
  /** Present only on rows produced by a workgroup attention source: an ownerless item with no session. */
  attention_source?: ThreadAttentionSource;
}

interface ThreadAttentionSource {
  /** The declared source kind — `release-board`, etc. */
  kind: string;
  /**
   * When this row's own source last regenerated (ISO-8601 UTC), or null. Per source, never an aggregate, so one dead
   * generator cannot age every row. No staleness threshold may suppress a row.
   */
  as_of: string | null;
  /**
   * Null means no claim (no declared `refresh_hours`, or unreadable `as_of`) and must not render as fresh. `true`
   * marks the row; it never hides it.
   */
  stale: boolean | null;
  /** Where a person goes to act on this item, or null. Never invented. */
  url: string | null;
  /** What a person has to do, in the source's own words. */
  next_action: string;
  /**
   * Who the item was handed to, only while the reservation is younger than `ASSIGN_DEDUPE_MS` (the window
   * `reserveItemAssignment` writes with). Without it the row reads Unassigned with a live Assign button until the
   * agent claims the work, inviting a duplicate assignment. The state stays `unassigned`; only the verb is disabled.
   * After the window the reservation moves to `assigned_expired`.
   */
  assigned: ThreadItemAssignment | null;
  /** The same reservation once its window has elapsed; never set together with `assigned`. */
  assigned_expired: ThreadItemAssignment | null;
}

interface ThreadItemAssignment {
  agent_group_id: string;
  /** The name the item's own room knows this agent by, resolved like a participant's. */
  agent_name: string;
  /** ISO-8601 UTC. */
  at: string;
  /** Display name of whoever assigned it, resolved at read time so a rename shows. */
  by: string;
}

export interface ThreadDoneProposal {
  reason: string;
  /** ISO-8601 UTC, as the agent wrote it. */
  proposed_at: string;
  agent_group_id: string;
  session_id: string;
}

/** Delegates to `isTaskThread` so there is one definition of a scheduled-task thread. */
export function isScheduledTaskThread(threadId: string): boolean {
  return isTaskThread(threadId);
}

/** Anything that leaves this module as a timestamp goes out as ISO-8601 UTC. */
function isoOrNull(s: string | null | undefined): string | null {
  const ms = parseUtcTimestampMs(s);
  return ms === null ? null : new Date(ms).toISOString();
}

export interface ThreadTranscriptEntry extends SessionTranscriptEntry {
  session_id: string;
  agent_group_id: string;
  agent_name: string;
}

interface ThreadSessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  /**
   * Task sessions only: the channel the series is routed to (migration 056). Never outranks an anchor; see
   * {@link threadRoutingChannel}.
   */
  task_routing_platform_id: string | null;
  agent_provider: string | null;
  title: string | null;
  title_generated_at: string | null;
  last_active: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;
  archived_at: string | null;
  created_at: string;
  /** Mirror of the container's `session_state.done_proposal` — see {@link ThreadSummary.done_proposal}. */
  done_proposal: string | null;
  attached_task_status: string | null;
  attached_task_needs_input: number | null;
  /** The worker's own free-text question from `spawn_request_steer`, or null when it gave none. */
  attached_task_steer_question: string | null;
}

const DEFAULT_SINCE_HOURS = 168; // 7d — §3.3's stated working set
const MAX_SINCE_HOURS = 24 * 90;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * `datetime()` wraps both sides, and ordering uses `julianday()`, because `last_outbound_at` is stored naive while
 * `last_active`/`created_at` are ISO-8601; a string comparison sorts every ISO value above every naive one.
 */
async function selectScopedSessions(
  ctx: AuthedRequestContext,
  opts: {
    workgroupId?: string | null;
    groupId: string | null;
    includeArchived: boolean;
    sinceHours: number | null;
    limit: number;
    offset?: number;
    threadId?: string | null;
  },
  now: number,
): Promise<ThreadSessionRow[]> {
  const conditions: string[] = ["s.status = 'active'"];
  const values: unknown[] = [];

  if (!ctx.scopes.no_filter) {
    const ids = ctx.scopes.allowed_group_ids;
    if (ids.length === 0) return [];
    conditions.push(`s.agent_group_id IN (${ids.map(() => '?').join(', ')})`);
    values.push(...ids);
  }
  if (opts.workgroupId) {
    // Can never widen scope: it is a separate AND term, so the workgroup only subtracts. An unknown or out-of-scope
    // workgroup yields zero rows, not a 403.
    conditions.push('s.agent_group_id IN (SELECT id FROM agent_groups WHERE workgroup_id = ?)');
    values.push(opts.workgroupId);
  }
  if (opts.groupId) {
    // An out-of-scope group_id yields zero rows rather than a 403.
    conditions.push('s.agent_group_id = ?');
    values.push(opts.groupId);
  }
  if (!opts.includeArchived) conditions.push('s.archived_at IS NULL');

  if (opts.threadId) {
    // The synthetic key for a NULL-thread session must match `groupByThread`'s, so `session:<id>` addresses that row.
    conditions.push(`COALESCE(s.thread_id, 'session:' || s.id) = ?`);
    values.push(opts.threadId);
  } else if (opts.sinceHours !== null) {
    conditions.push(`datetime(COALESCE(s.last_outbound_at, s.last_active, s.created_at)) >= datetime(?)`);
    values.push(new Date(now - opts.sinceHours * 3_600_000).toISOString());
  }

  // Same never-engaged filter as sessions.ts: an inbound that never woke an
  // agent mints a session row and would otherwise clutter the queue forever.
  conditions.push("(s.last_outbound_at IS NOT NULL OR s.container_status <> 'stopped' OR t.task_id IS NOT NULL)");

  // Limit thread keys rather than sessions: sibling adapters can contribute
  // multiple rows to one thread, and callers need all of those participants.
  // `julianday()` gives the SQL page boundary the same ordering as `activityMs`
  // for both ISO-8601 and legacy naive UTC timestamps.
  const sql = `
    WITH scoped_sessions AS (
      SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.task_routing_platform_id, s.agent_provider,
             s.title, s.title_generated_at, s.last_active, s.last_outbound_at, s.last_outbound_kind,
             s.archived_at, s.created_at, s.done_proposal,
             t.status         AS attached_task_status,
             t.needs_input    AS attached_task_needs_input,
             t.steer_question AS attached_task_steer_question,
             COALESCE(s.thread_id, 'session:' || s.id) AS thread_key,
             MAX(
               COALESCE(julianday(s.last_outbound_at), -1.0e300),
               COALESCE(julianday(s.last_active), -1.0e300),
               COALESCE(julianday(s.created_at), -1.0e300)
             ) AS activity
        FROM sessions s
   LEFT JOIN (
              SELECT task_id, child_session_id, status, needs_input, steer_question, admitted_at,
                     ROW_NUMBER() OVER (PARTITION BY child_session_id ORDER BY admitted_at DESC) AS rn
                FROM tasks
               WHERE child_session_id IS NOT NULL
                 AND status IN ('pending', 'running')
            ) t ON t.child_session_id = s.id AND t.rn = 1
       WHERE ${conditions.join(' AND ')}
    ), thread_page AS (
      SELECT thread_key
        FROM scoped_sessions
       GROUP BY thread_key
       ORDER BY MAX(activity) DESC, thread_key ASC
       LIMIT ?
      OFFSET ?
    )
    SELECT id, agent_group_id, messaging_group_id, thread_id, task_routing_platform_id, agent_provider,
           title, title_generated_at, last_active, last_outbound_at, last_outbound_kind,
           archived_at, created_at, done_proposal,
           attached_task_status, attached_task_needs_input, attached_task_steer_question
      FROM scoped_sessions
     WHERE thread_key IN (SELECT thread_key FROM thread_page)
  `;
  return getDb().all<ThreadSessionRow>(sql, ...values, opts.limit, opts.offset ?? 0);
}

export interface ChannelDirectory {
  known: Set<string>;
  names: Map<string, string>;
  /** `messaging_groups.id` → `platform_id` — the join a synthetic (NULL-thread_id) session needs. */
  byId: Map<string, string>;
  /** DM room `platform_id` → a stable cross-instance key for the human on the other end. */
  dmDedupeKey: Map<string, string>;
}

/** `messaging_groups.platform_id` → friendly name, and the key set §3.2 parses against. */
export async function readChannelDirectory(): Promise<ChannelDirectory> {
  const known = new Set<string>();
  const names = new Map<string, string>();
  const byId = new Map<string, string>();
  const dmDedupeKey = new Map<string, string>();
  try {
    const rows = await getDb().all<{
      id: string;
      platform_id: string;
      name: string | null;
    }>('SELECT id, platform_id, name FROM messaging_groups');
    for (const r of rows) {
      known.add(r.platform_id);
      byId.set(r.id, r.platform_id);
      if (r.name && !names.has(r.platform_id)) names.set(r.platform_id, r.name);
    }
  } catch (err) {
    log.warn('threads: could not read messaging_groups directory', { err });
  }

  // One human DMing two sibling bots produces two DM rooms. The raw platform user id from `user_dms` is shared across
  // sibling instances (unlike `user_dms.user_id` and `users.id`, which are per instance), so it collapses those rooms
  // to one sidebar entry. DM rooms with no `user_dms` row pass through unmerged: a name-based fallback could merge
  // unrelated channels that share a display name.
  try {
    const dmRows = await getDb().all<{
      platform_id: string;
      channel_type: string;
      user_id: string;
      display_name: string | null;
    }>(
      `SELECT mg.platform_id AS platform_id, ud.channel_type AS channel_type, ud.user_id AS user_id,
              u.display_name AS display_name
         FROM user_dms ud
         JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
         LEFT JOIN users u ON u.id = ud.user_id`,
    );
    for (const r of dmRows) {
      const rawUserId = r.user_id.startsWith(`${r.channel_type}:`)
        ? r.user_id.slice(r.channel_type.length + 1)
        : r.user_id;
      const platformFamily = r.platform_id.split(':')[0] ?? r.channel_type;
      const key = `dm:${platformFamily}:${rawUserId}`;
      dmDedupeKey.set(r.platform_id, key);
      if (r.display_name && !names.has(key)) names.set(key, r.display_name);
    }
  } catch (err) {
    log.warn('threads: could not read user_dms directory', { err });
  }

  // Label for the fallback bucket of task threads with no anchor. Still live: every per-series
  // `system:tasks:<seriesId>` thread collapses to the `system:tasks` channel key.
  if (!names.has(TASKS_SYSTEM_THREAD_ID)) names.set(TASKS_SYSTEM_THREAD_ID, 'Unrouted tasks');

  return { known, names, byId, dmDedupeKey };
}

/** Last segment of a channel key — the honest fallback when no wiring names it. */
function channelKeyLabel(key: string): string {
  const segments = key.split(':');
  return segments[segments.length - 1] || key;
}

/**
 * Every agent wired to a channel, indexed by `messaging_groups.platform_id`. The assign selector and the assign write
 * path both read this, so they agree on what "wired" means.
 */
export interface WiredAgent {
  agent_group_id: string;
  /** `agent_groups.name` — the infrastructure name. Display names resolve separately. */
  name: string;
  folder: string;
  messaging_group_id: string;
  session_mode: SessionMode;
}

export async function wiredAgentsByChannel(): Promise<Map<string, WiredAgent[]>> {
  const byChannel = new Map<string, WiredAgent[]>();
  let rows: (WiredAgent & { platform_id: string })[];
  try {
    // `session_mode` is per wiring, and its default is `per-thread` (what `getMessagingGroupAgents` hydrates to), not
    // the stale `shared` in the CREATE TABLE.
    rows = await getDb().all<WiredAgent & { platform_id: string }>(
      `SELECT mg.platform_id                          AS platform_id,
              mg.id                                   AS messaging_group_id,
              COALESCE(mga.session_mode,'per-thread') AS session_mode,
              ag.id                                   AS agent_group_id,
              ag.name                                 AS name,
              ag.folder                               AS folder
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups     ag ON ag.id = mga.agent_group_id`,
    );
  } catch (err) {
    log.warn('threads: wiring lookup failed', { err });
    return byChannel;
  }
  for (const r of rows) {
    const list = byChannel.get(r.platform_id) ?? [];
    // A sibling bot can be wired to one channel through two messaging groups;
    // the first one wins so the selector never lists the same agent twice.
    if (!list.some((a) => a.agent_group_id === r.agent_group_id)) {
      list.push({
        agent_group_id: r.agent_group_id,
        name: r.name,
        folder: r.folder,
        messaging_group_id: r.messaging_group_id,
        session_mode: r.session_mode,
      });
    }
    byChannel.set(r.platform_id, list);
  }
  return byChannel;
}

/**
 * Callers MUST gate this on a live container ({@link liveContainerState}): opening a per-session SQLite file is the
 * most expensive step on this path.
 */
export function readContainerState(agentGroupId: string, sessionId: string): ContainerState | null {
  try {
    // Read-only seam, never `withExistingMailboxSession`: listing must not provision, migrate or schema-ensure a
    // session. The hot-journal rollback keeps a SIGKILLed container's outbound.db readable.
    return (
      readSessionOutbound({ agentGroupId, sessionId }, (mailbox) => mailbox.getContainerState(), {
        busyTimeoutMs: 5000,
        recoverJournal: true,
      }) ?? null
    );
  } catch (err) {
    log.warn('threads: container_state probe failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Probes only sessions with a live container process (an in-memory map, zero I/O).
 * DO NOT narrow this to a fresh-heartbeat gate: the runner touches `.heartbeat` once per provider event, so a wedged
 * tool's heartbeat is stale by construction and stall detection would silently disappear.
 */
function liveContainerState(
  rows: ThreadSessionRow[],
  liveIds: ReadonlySet<string>,
  probe: (agentGroupId: string, sessionId: string) => ContainerState | null,
): Map<string, ContainerState> {
  const out = new Map<string, ContainerState>();
  for (const row of rows) {
    if (!liveIds.has(row.id)) continue;
    const state = probe(row.agent_group_id, row.id);
    if (state) out.set(row.id, state);
  }
  return out;
}

interface AgentIdentity {
  agent_group_id: string;
  name: string;
  canonicalName: string;
  avatarUrl: string | null;
  provider: string;
}

interface IdentityKey {
  agentGroupId: string;
  messagingGroupId: string | null;
  sessionProvider: string | null;
}

const identityKey = (k: IdentityKey): string => `${k.agentGroupId}|${k.messagingGroupId ?? ''}`;

/** Keyed on (agent_group_id, messaging_group_id): the same agent has a different bot display name per channel. */
async function resolveIdentities(
  pairs: Array<IdentityKey>,
  avatarByChannelType: (channelType: string) => string | null,
): Promise<Map<string, AgentIdentity>> {
  const wanted = new Map<string, IdentityKey>();
  for (const p of pairs) wanted.set(identityKey(p), p);
  if (wanted.size === 0) return new Map();

  const agentIds = [...new Set([...wanted.values()].map((p) => p.agentGroupId))];
  const groups = new Map(
    (
      await getDb().all<AgentGroup>(
        `SELECT * FROM agent_groups WHERE id IN (${agentIds.map(() => '?').join(', ')})`,
        ...agentIds,
      )
    ).map((g) => [g.id, g]),
  );

  const avatars = new Map<string, string | null>();
  try {
    const rows = await getDb().all<{ agent_group_id: string; channel_type: string }>(
      `SELECT mga.agent_group_id AS agent_group_id, mg.channel_type AS channel_type
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id IN (${agentIds.map(() => '?').join(', ')})`,
      ...agentIds,
    );
    for (const r of rows) {
      if (avatars.get(r.agent_group_id)) continue;
      avatars.set(r.agent_group_id, avatarByChannelType(r.channel_type));
    }
  } catch (err) {
    log.warn('threads: avatar lookup failed', { err });
  }

  const out = new Map<string, AgentIdentity>();
  await Promise.all(
    [...wanted.entries()].map(async ([key, pair]) => {
      const group = groups.get(pair.agentGroupId);
      if (!group) return;
      let name = group.name;
      // Precedence lives in `resolveProviderName`; `agent_groups.agent_provider` is deprecated.
      let provider = resolveProviderName(pair.sessionProvider, (await getContainerConfig(group.id))?.provider);
      try {
        const config = readContainerConfig(group.folder);
        // container.json is authoritative for the runtime (see CLAUDE.md
        // "Container Config"), so it wins over the DB projection when set.
        provider = resolveProviderName(pair.sessionProvider, config.provider ?? provider);
        name = await resolveAssistantName(group, config, pair.messagingGroupId);
      } catch (err) {
        // A missing container.json must never blank a row — the infrastructure
        // name is always a correct, if less friendly, answer.
        log.warn('threads: identity resolution fell back to agent_groups.name', {
          agentGroupId: pair.agentGroupId,
          err,
        });
      }
      out.set(key, {
        agent_group_id: group.id,
        name,
        canonicalName: group.name,
        avatarUrl: avatars.get(group.id) ?? null,
        provider,
      });
    }),
  );
  return out;
}

/** Claims are per-workgroup files, not DB rows: one directory scan per workgroup, not per thread. */
export async function readClaimsByThread(
  agentGroupIds: string[],
  now: number,
  claimsRoot?: string,
): Promise<Map<string, BoardClaim>> {
  const byThread = new Map<string, BoardClaim>();
  if (agentGroupIds.length === 0) return byThread;
  let workgroupIds: string[];
  try {
    workgroupIds = (
      await getDb().all<{ workgroup_id: string }>(
        `SELECT DISTINCT workgroup_id FROM agent_groups
          WHERE workgroup_id IS NOT NULL AND id IN (${agentGroupIds.map(() => '?').join(', ')})`,
        ...agentGroupIds,
      )
    ).map((r) => r.workgroup_id);
  } catch (err) {
    log.warn('threads: workgroup lookup for claims failed', { err });
    return byThread;
  }
  for (const wg of workgroupIds) {
    const claims = claimsRoot !== undefined ? readClaims(wg, now, claimsRoot) : readClaims(wg, now);
    for (const c of claims) {
      if (!c.threadId) continue;
      const existing = byThread.get(c.threadId);
      // Parked outranks a live claim on the same thread: it is the one that
      // names a state the operator has to act on.
      if (!existing || (existing.state !== 'parked' && c.state === 'parked')) byThread.set(c.threadId, c);
    }
  }
  return byThread;
}

/** One session's most-recently-created `task_thread_anchors` row. */
interface TaskAnchor {
  platformId: string;
  atMs: number;
}

/**
 * `task_thread_anchors.session_id` → the channel it most recently posted in (migration 048), which lets a task thread
 * live in its real channel. A task that never posted has no anchor and stays in the `system:tasks` bucket.
 */
async function readTaskThreadAnchors(sessionIds: string[]): Promise<Map<string, TaskAnchor>> {
  const bySession = new Map<string, TaskAnchor>();
  if (sessionIds.length === 0) return bySession;
  let rows: { session_id: string; platform_id: string; created_at: string }[];
  try {
    rows = await getDb().all<{ session_id: string; platform_id: string; created_at: string }>(
      `SELECT session_id, platform_id, created_at FROM task_thread_anchors
        WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`,
      ...sessionIds,
    );
  } catch (err) {
    log.warn('threads: task_thread_anchors lookup failed', { err });
    return bySession;
  }
  for (const r of rows) {
    // A recurring series can be re-pointed between runs, so one session can hold several anchors; the most recent
    // wins.
    const atMs = parseUtcTimestampMs(r.created_at) ?? -Infinity;
    const existing = bySession.get(r.session_id);
    if (!existing || atMs > existing.atMs) bySession.set(r.session_id, { platformId: r.platform_id, atMs });
  }
  return bySession;
}

/** Same most-recent-wins tie-break, across every session in the thread. */
function threadAnchorChannel(rows: ThreadSessionRow[], anchors: ReadonlyMap<string, TaskAnchor>): string | null {
  let best: TaskAnchor | null = null;
  for (const row of rows) {
    const a = anchors.get(row.id);
    if (a && (!best || a.atMs > best.atMs)) best = a;
  }
  return best?.platformId ?? null;
}

/**
 * The routing stamp written at task-definition time (migration 056), or null.
 * It must lose to `threadAnchorChannel`: the agent chooses its destination at fire time, so the stamp is only a
 * default, and a re-pointed series would otherwise show in the room it stopped posting to. Tie-break across sessions
 * is on session `created_at`.
 */
function threadRoutingChannel(rows: ThreadSessionRow[]): string | null {
  let best: { platformId: string; atMs: number } | null = null;
  for (const row of rows) {
    if (!row.task_routing_platform_id) continue;
    const atMs = parseUtcTimestampMs(row.created_at) ?? -Infinity;
    if (!best || atMs > best.atMs) best = { platformId: row.task_routing_platform_id, atMs };
  }
  return best?.platformId ?? null;
}

/**
 * The ownerless work items this caller may see; the only place a row enters the queue without a session.
 * Filters only narrow (an unknown or out-of-scope workgroup yields zero items, not a 403). `group_id` yields nothing:
 * an ownerless item is on no agent.
 * `since_hours` must never exclude one of these rows: an item blocked on a human needs surfacing more the longer it
 * waits. Age decides sort order only.
 */
export async function selectScopedAttentionItems(
  ctx: AuthedRequestContext,
  opts: { workgroupId?: string | null; groupId: string | null; sinceHours: number | null; threadId?: string | null },
  now: number,
  env: AttentionSourceEnv,
): Promise<AttentionItem[]> {
  const empty: AttentionItem[] = [];
  if (opts.groupId) return empty;

  let workgroupIds: string[];
  if (ctx.scopes.no_filter) {
    workgroupIds = await workgroupIdsWithAttentionSources();
  } else {
    if (ctx.scopes.allowed_group_ids.length === 0) return empty;
    workgroupIds = await workgroupIdsForAgentGroups(ctx.scopes.allowed_group_ids);
  }
  if (opts.workgroupId) workgroupIds = workgroupIds.filter((id) => id === opts.workgroupId);
  if (workgroupIds.length === 0) return empty;

  const items: AttentionItem[] = [];
  for (const wg of workgroupIds) {
    for (const item of (await readAttentionItems(wg, now, env)).items) {
      // `opts.sinceHours` is deliberately never read here; see the doc comment above.
      if (opts.threadId) {
        if (item.id === opts.threadId) items.push(item);
        continue;
      }
      items.push(item);
    }
  }
  return items;
}

/** Liveness ordering: the freshest wins when a thread's sessions disagree. */
const STATUS_RANK: Record<ContainerStatus, number> = { running: 3, idle: 2, stale: 1, unknown: 0 };

export interface ThreadListDeps {
  now?: number;
  /** Session ids the host currently holds a container process for. */
  activeContainerSessionIds?: () => string[];
  containerStatus?: (agentGroupId: string, sessionId: string) => ContainerStatus;
  containerState?: (agentGroupId: string, sessionId: string) => ContainerState | null;
  /** Injected claims root for tests; defaults to readClaims' own live base dir. */
  claimsRoot?: string;
  avatarByChannelType?: (channelType: string) => string | null;
  /** Wiring lookup for the assign selector; defaults to {@link wiredAgentsByChannel}. */
  wiredAgents?: () => Map<string, WiredAgent[]> | Promise<Map<string, WiredAgent[]>>;
  /** Injected roots for attention sources (tests); defaults to the live ones. */
  attentionEnv?: AttentionSourceEnv;
}

function activityMs(row: ThreadSessionRow): number {
  return Math.max(
    parseUtcTimestampMs(row.last_outbound_at) ?? -Infinity,
    parseUtcTimestampMs(row.last_active) ?? -Infinity,
    parseUtcTimestampMs(row.created_at) ?? -Infinity,
  );
}

type NeedsOperatorCause = 'task_needs_input' | 'ask_question';

function sessionNeedsOperatorCause(row: ThreadSessionRow): NeedsOperatorCause | null {
  if (row.attached_task_needs_input === 1) return 'task_needs_input';
  if (
    row.last_outbound_kind === 'chat-sdk:ask_question' &&
    (parseUtcTimestampMs(row.last_active) ?? 0) < (parseUtcTimestampMs(row.last_outbound_at) ?? 0)
  ) {
    return 'ask_question';
  }
  return null;
}

/** One predicate shared with {@link sessionNeedsOperatorCause}, so the state gate and the reason can never disagree. */
function sessionNeedsOperator(row: ThreadSessionRow): boolean {
  return sessionNeedsOperatorCause(row) !== null;
}

const ASK_QUESTION_REASON_TEXT = 'The agent asked a question and is waiting for a reply.';
const TASK_NEEDS_INPUT_REASON_TEXT = 'A running task needs input to continue.';

/**
 * WHY a `needs_you` row is `needs_you`, following `deriveThreadState`'s own precedence so it can only explain a state
 * this module computed.
 * Text is never fabricated: the claim note and the worker's `steer_question` are quoted verbatim, and an
 * `ask_question` gets a generic statement because its text lives in a per-session DB this list does not open. Returns
 * null when no cause explains it.
 */
export function deriveNeedsYouReason(
  ordered: ThreadSessionRow[],
  claim: { state: BoardClaim['state'] | null; note: string; staleMs?: number },
): NeedsYouReason | null {
  if (claim.state === 'parked' && WAITING_ON_NOTE.test(claim.note)) {
    // `staleMs` for a parked claim is 0 when `parked_at` is missing or unparseable, which means unmeasured, not "just
    // now".
    const parkedMs = typeof claim.staleMs === 'number' && claim.staleMs > 0 ? claim.staleMs : null;
    return { cause: 'parked_note', text: claim.note, parked_ms: parkedMs };
  }
  for (const row of ordered) {
    const cause = sessionNeedsOperatorCause(row);
    if (cause === 'task_needs_input') {
      return { cause, text: row.attached_task_steer_question?.trim() || TASK_NEEDS_INPUT_REASON_TEXT };
    }
    if (cause === 'ask_question') return { cause, text: ASK_QUESTION_REASON_TEXT };
  }
  return null;
}

/**
 * The freshest standing close proposal across the thread's sessions. The only input is the mirrored `done_proposal`
 * column; there is no other way to construct one.
 */
export function pickDoneProposal(ordered: ThreadSessionRow[]): ThreadDoneProposal | null {
  let best: ThreadDoneProposal | null = null;
  let bestAt = -Infinity;
  for (const row of ordered) {
    if (!row.done_proposal) continue;
    let parsed: { reason?: unknown; proposed_at?: unknown };
    try {
      parsed = JSON.parse(row.done_proposal) as { reason?: unknown; proposed_at?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') continue;
    if (typeof parsed.proposed_at !== 'string') continue;
    const at = parseUtcTimestampMs(parsed.proposed_at);
    if (at === null || at <= bestAt) continue;
    bestAt = at;
    best = {
      reason: parsed.reason.trim(),
      proposed_at: new Date(at).toISOString(),
      agent_group_id: row.agent_group_id,
      session_id: row.id,
    };
  }
  return best;
}

/**
 * Which session a reply to this thread lands in by default. A thread is N inbound queues and the steer path writes to
 * exactly one, so the wrong pick sends the answer to an agent that never asked. `ordered` must already be
 * activity-sorted; `pickedSessionId` is the probed session, null when none was.
 */
export function replyTargetSessionId<T extends { id: string }>(
  state: ThreadState,
  ordered: T[],
  opts: { needsOperator: (row: T) => boolean; pickedSessionId: string | null },
): string | null {
  if (state === 'needs_you') {
    const asked = ordered.find((r) => opts.needsOperator(r));
    if (asked) return asked.id;
  }
  if ((state === 'stalled' || state === 'running') && opts.pickedSessionId) return opts.pickedSessionId;
  return ordered[0]?.id ?? null;
}

interface ThreadAccum {
  threadId: string;
  synthetic: boolean;
  rows: ThreadSessionRow[];
}

function groupByThread(rows: ThreadSessionRow[]): ThreadAccum[] {
  const byThread = new Map<string, ThreadAccum>();
  for (const row of rows) {
    // A NULL thread_id is real work (a task session that never got a platform thread), so it gets a synthetic
    // per-session key rather than being dropped.
    const synthetic = !row.thread_id;
    const key = row.thread_id ?? `session:${row.id}`;
    const existing = byThread.get(key);
    if (existing) existing.rows.push(row);
    else byThread.set(key, { threadId: key, synthetic, rows: [row] });
  }
  return [...byThread.values()];
}

/**
 * The console's thread queue.
 * A `system:tasks:<seriesId>` session has no `messaging_group_id` (that NULL is `src/delivery.ts`'s task-session
 * discriminator and must stay NULL), so its channel resolves as: (a) `task_thread_anchors`, where it most recently
 * posted; (b) `sessions.task_routing_platform_id`, the default routing stamp; (c) the `system:tasks` bucket. (a) must
 * beat (b): a re-pointed series' stamp still names its old home.
 */
export async function buildThreadList(
  ctx: AuthedRequestContext,
  opts: {
    workgroupId?: string | null;
    groupId: string | null;
    includeArchived: boolean;
    sinceHours: number | null;
    limit: number;
    offset?: number;
    threadId?: string | null;
  },
  deps: ThreadListDeps = {},
): Promise<{ threads: ThreadSummary[] }> {
  const now = deps.now ?? Date.now();
  const statusOf = deps.containerStatus ?? deriveContainerStatus;
  const probeState = deps.containerState ?? readContainerState;
  const avatarLookup = deps.avatarByChannelType ?? ((ct: string) => getKnownSlackBots().get(ct)?.imageUrl ?? null);

  // Read before the session query so an install whose only blocked work is on a board still gets a queue.
  const attentionItems = await selectScopedAttentionItems(ctx, opts, now, deps.attentionEnv ?? {});

  const rows = await selectScopedSessions(ctx, opts, now);
  if (rows.length === 0 && attentionItems.length === 0) return { threads: [] };

  const { known, names, byId, dmDedupeKey } = await readChannelDirectory();
  const grouped = groupByThread(rows)
    .map((t) => ({ ...t, activity: Math.max(...t.rows.map(activityMs)) }))
    .sort((a, b) => b.activity - a.activity || a.threadId.localeCompare(b.threadId))
    .slice(0, opts.limit);

  const pagedRows = grouped.flatMap((t) => t.rows);
  const liveIds = new Set((deps.activeContainerSessionIds ?? getActiveContainerSessionIds)());
  const states = liveContainerState(pagedRows, liveIds, probeState);
  const claims = await readClaimsByThread([...new Set(pagedRows.map((r) => r.agent_group_id))], now, deps.claimsRoot);
  const taskAnchors = await readTaskThreadAnchors(
    pagedRows.filter((r) => r.thread_id && isScheduledTaskThread(r.thread_id)).map((r) => r.id),
  );

  // A synthetic (`session:<id>`) thread resolves its channel from its own `messaging_group_id`, never by passing the
  // synthetic id to `threadChannelKey`, which would mint a per-row bucket. A scheduled-task thread tries its anchors
  // first and falls back to the `system:tasks` bucket only when it has never posted.
  const channelKeys = new Map(
    grouped.map((t) => {
      if (t.synthetic) {
        const mgId = t.rows[0]?.messaging_group_id;
        const platformId = mgId ? byId.get(mgId) : undefined;
        return [t.threadId, platformId ?? UNKNOWN_CHANNEL_KEY] as const;
      }
      if (isScheduledTaskThread(t.threadId)) {
        // The order (anchor, then routing stamp, then fallback bucket) is load-bearing; see `threadRoutingChannel`.
        const anchored = threadAnchorChannel(t.rows, taskAnchors);
        if (anchored) return [t.threadId, anchored] as const;
        const routed = threadRoutingChannel(t.rows);
        if (routed) return [t.threadId, routed] as const;
      }
      return [t.threadId, threadChannelKey(t.threadId, known)] as const;
    }),
  );
  const wiredByChannel = await (deps.wiredAgents ?? wiredAgentsByChannel)();
  const inScope = (agentGroupId: string): boolean =>
    ctx.scopes.no_filter || ctx.scopes.allowed_group_ids.includes(agentGroupId);

  const identities = await resolveIdentities(
    [
      ...pagedRows.map((r) => ({
        agentGroupId: r.agent_group_id,
        messagingGroupId: r.messaging_group_id,
        sessionProvider: r.agent_provider,
      })),
      ...[...new Set([...channelKeys.values(), ...attentionItems.map((i) => i.channel_key)])].flatMap((key) =>
        (wiredByChannel.get(key) ?? [])
          .filter((a) => inScope(a.agent_group_id))
          .map((a) => ({
            agentGroupId: a.agent_group_id,
            messagingGroupId: a.messaging_group_id,
            sessionProvider: null,
          })),
      ),
    ],
    avatarLookup,
  );
  const assignableOn = (channelKey: string, include: (agentGroupId: string) => boolean): ThreadAgentOption[] =>
    (wiredByChannel.get(channelKey) ?? [])
      .filter((a) => include(a.agent_group_id))
      .map((a) => ({
        agent_group_id: a.agent_group_id,
        name:
          identities.get(
            identityKey({
              agentGroupId: a.agent_group_id,
              messagingGroupId: a.messaging_group_id,
              sessionProvider: null,
            }),
          )?.name ?? a.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  // Session threads only: `thread_snoozes`' only writer refuses ids with no `sessions` row, so an attention item can
  // never carry a snooze.
  const snoozes = await readThreadSnoozes(
    ctx.user.id,
    grouped.map((t) => t.threadId),
  );
  // Fleet-wide, not per-user: a close is a decision about the work, so every operator must see it.
  const closures: Map<string, ThreadCloseState> = await readThreadClosures(grouped.map((t) => t.threadId));
  const assignments = await readItemAssignments([...new Set(attentionItems.map((i) => i.workgroupId))]);
  const assignerNames = await readUserDisplayNames([...new Set([...assignments.values()].map((a) => a.assignedBy))]);

  const threads: ThreadSummary[] = grouped.map((thread) => {
    const ordered = [...thread.rows].sort((a, b) => activityMs(b) - activityMs(a));

    const participants: ThreadParticipant[] = [];
    const seenAgents = new Set<string>();
    for (const row of ordered) {
      if (seenAgents.has(row.agent_group_id)) continue;
      seenAgents.add(row.agent_group_id);
      const id = identities.get(
        identityKey({
          agentGroupId: row.agent_group_id,
          messagingGroupId: row.messaging_group_id,
          sessionProvider: row.agent_provider,
        }),
      );
      participants.push({
        agent_group_id: row.agent_group_id,
        name: id?.name ?? row.agent_group_id,
        session_id: row.id,
        avatarUrl: id?.avatarUrl ?? null,
        provider: id?.provider ?? resolveProviderName(row.agent_provider, null),
      });
    }

    // Titles are generated per session; the freshest wins, falling back to session activity for rows with no
    // `title_generated_at`.
    let title: string | null = null;
    let titleAt = -Infinity;
    for (const row of ordered) {
      if (!row.title) continue;
      const at = parseUtcTimestampMs(row.title_generated_at) ?? activityMs(row);
      if (at > titleAt) {
        titleAt = at;
        title = row.title;
      }
    }

    let containerStatus: ContainerStatus = 'unknown';
    for (const row of ordered) {
      const s = statusOf(row.agent_group_id, row.id);
      if (STATUS_RANK[s] > STATUS_RANK[containerStatus]) containerStatus = s;
    }

    // A failed provider outranks a tool in flight, which outranks anything idle.
    let picked: ContainerState | null = null;
    // Tracked alongside `picked` so the rendered container_state and the session that owns it can never disagree.
    let pickedSessionId: string | null = null;
    for (const row of ordered) {
      const s = states.get(row.id);
      if (!s) continue;
      if (!picked) {
        picked = s;
        pickedSessionId = row.id;
      } else if (s.provider_status === 'failed') {
        picked = s;
        pickedSessionId = row.id;
      } else if (picked.provider_status !== 'failed' && !picked.tool_started_at && s.tool_started_at) {
        picked = s;
        pickedSessionId = row.id;
      }
    }

    // Hoisted out of the return literal: control-flow analysis narrows `picked` to `never` when it is read after the
    // arrow functions below.
    const providerStatus: string | null = picked?.provider_status ?? null;
    const currentTool: string | null = picked?.current_tool ?? null;
    const toolStartedAt: string | null = isoOrNull(picked?.tool_started_at);
    const toolStartedAtMs: number | null = parseUtcTimestampMs(picked?.tool_started_at);

    const lastOutputAtMs = ordered.reduce<number | null>((acc, row) => {
      const ms = parseUtcTimestampMs(row.last_outbound_at);
      return ms !== null && (acc === null || ms > acc) ? ms : acc;
    }, null);
    const lastActivity = ordered[0]
      ? (ordered[0].last_outbound_at ?? ordered[0].last_active ?? ordered[0].created_at)
      : null;
    const claim = claims.get(thread.threadId) ?? null;
    // Wiring lookups key off the raw platform_id, which `messaging_group_agents` is wired against; DM dedupe must
    // never change who a thread can be handed to.
    const channelKey = channelKeys.get(thread.threadId) ?? UNKNOWN_CHANNEL_KEY;
    // Display-only channel identity: collapses DM rooms with the same human (see `dmDedupeKey`). Never used for
    // wiring lookups.
    const displayChannelKey = dmDedupeKey.get(channelKey) ?? channelKey;

    const onThread = new Set(participants.map((p) => p.agent_group_id));
    const assignableAgents = assignableOn(channelKey, (id) => !onThread.has(id) && inScope(id));

    const state = deriveThreadState({
      sessionCount: ordered.length,
      claimState: claim?.state ?? null,
      claimNote: claim?.note ?? '',
      needsOperator: ordered.some(sessionNeedsOperator),
      containerStatus,
      providerStatus,
      toolStartedAtMs,
      lastOutputAtMs,
      now,
    });
    const lastActivityAt = isoOrNull(lastActivity);
    const doneProposal = pickDoneProposal(ordered);
    const closure = closures.get(thread.threadId);
    // Gated on `state` too: a reason must never ride on a row this module did not call `needs_you`.
    const needsYouReason =
      state === 'needs_you'
        ? deriveNeedsYouReason(ordered, {
            state: claim?.state ?? null,
            note: claim?.note ?? '',
            staleMs: claim?.staleMs,
          })
        : null;

    return {
      thread_id: thread.threadId,
      synthetic: thread.synthetic,
      channel_key: displayChannelKey,
      channel_name: names.get(displayChannelKey) ?? channelKeyLabel(displayChannelKey),
      title,
      participants,
      assignable_agents: assignableAgents,
      last_activity_at: lastActivityAt,
      state,
      needs_you_reason: needsYouReason,
      session_ids: ordered.map((r) => r.id),
      container_status: containerStatus,
      provider_status: providerStatus,
      current_tool: currentTool,
      tool_started_at: toolStartedAt,
      reply_target_session_id: replyTargetSessionId(state, ordered, {
        needsOperator: sessionNeedsOperator,
        pickedSessionId,
      }),
      snoozed: snoozes.has(thread.threadId) && isSnoozed(snoozes.get(thread.threadId), lastActivityAt),
      scheduled_task: isScheduledTaskThread(thread.threadId),
      done_proposal: doneProposal,
      closing: closure !== undefined && closure.state !== 'closed',
      close_confirmations_required: requiredConfirmations(doneProposal !== null),
    };
  });

  /**
   * The item's standing assignment, split by freshness with the same `ASSIGN_DEDUPE_MS` window the write side
   * enforces, so a reservation an assign attempt would overwrite is never shown as live. The agent name comes from
   * the participant identity memo, falling back to the wiring name, then the id.
   */
  const assignmentOf = (
    item: AttentionItem,
  ): { assigned: ThreadItemAssignment | null; assigned_expired: ThreadItemAssignment | null } => {
    const found = assignments.get(assignmentKey(item.workgroupId, stripAttentionItemPrefix(item.id)));
    if (!found) return { assigned: null, assigned_expired: null };
    const wiring = (wiredByChannel.get(item.channel_key) ?? []).find((a) => a.agent_group_id === found.agentGroupId);
    const identity = wiring
      ? identities.get(
          identityKey({
            agentGroupId: found.agentGroupId,
            messagingGroupId: wiring.messaging_group_id,
            sessionProvider: null,
          }),
        )
      : undefined;
    const resolved: ThreadItemAssignment = {
      agent_group_id: found.agentGroupId,
      agent_name: identity?.name ?? wiring?.name ?? found.agentGroupId,
      at: found.assignedAt,
      by: assignerNames.get(found.assignedBy) ?? found.assignedBy,
    };
    const assignedMs = parseUtcTimestampMs(found.assignedAt);
    // Mirrors the write side's `WHERE assigned_at < staleBefore` exactly.
    const stale = assignedMs === null || now - assignedMs > ASSIGN_DEDUPE_MS;
    return stale ? { assigned: null, assigned_expired: resolved } : { assigned: resolved, assigned_expired: null };
  };

  const attentionThreads: ThreadSummary[] = attentionItems.map((item) => {
    const displayChannelKey = dmDedupeKey.get(item.channel_key) ?? item.channel_key;
    const assignableAgents = assignableOn(item.channel_key, inScope);

    // Never set `state` directly: one function decides every row's state.
    const state = deriveThreadState({
      sessionCount: item.sessionCount,
      claimState: item.claimState,
      claimNote: item.claimNote ?? '',
      needsOperator: false,
      containerStatus: 'unknown',
      providerStatus: null,
      toolStartedAtMs: null,
      lastOutputAtMs: null,
      now,
    });
    const lastActivityAt = isoOrNull(item.since);
    const { assigned, assigned_expired } = assignmentOf(item);
    return {
      thread_id: item.id,
      synthetic: false,
      channel_key: displayChannelKey,
      channel_name: names.get(displayChannelKey) ?? channelKeyLabel(displayChannelKey),
      title: item.title,
      participants: [],
      assignable_agents: assignableAgents,
      last_activity_at: lastActivityAt,
      state,
      // No park age: there is no claim file behind this item whose `parked_at` could be measured.
      needs_you_reason:
        state === 'needs_you' && item.claimNote
          ? { cause: 'parked_note', text: `${item.claimNote} — next: ${item.nextAction}`, parked_ms: null }
          : null,
      session_ids: [],
      container_status: 'unknown',
      provider_status: null,
      current_tool: null,
      tool_started_at: null,
      reply_target_session_id: null,
      snoozed: false,
      scheduled_task: false,
      done_proposal: null,
      closing: false,
      close_confirmations_required: requiredConfirmations(false),
      attention_source: {
        kind: item.sourceKind,
        as_of: item.sourceAsOf,
        stale: item.sourceStale,
        url: item.url,
        next_action: item.nextAction,
        // Keyed on the item's natural id: migration 058 does not store the `board:` prefix.
        assigned,
        assigned_expired,
      },
    };
  });

  if (attentionThreads.length === 0) return { threads };
  // Merged into one queue sorted freshest first, but each kind is capped SEPARATELY and the merged list is not
  // re-cut. An attention row's `last_activity_at` is when it started waiting, so a shared cap would drop the
  // longest-blocked items first. A page can therefore carry up to 2x `limit` rows.
  const merged = [...threads, ...cappedByAge(attentionThreads, opts.limit)].sort(
    (a, b) =>
      (parseUtcTimestampMs(b.last_activity_at) ?? -Infinity) - (parseUtcTimestampMs(a.last_activity_at) ?? -Infinity),
  );
  return { threads: merged };
}

/**
 * At most `limit` attention rows, keeping the OLDEST, so a biting cap drops the freshest arrival. Undated rows sort
 * last and are dropped first.
 */
function cappedByAge(rows: ThreadSummary[], limit: number): ThreadSummary[] {
  if (rows.length <= limit) return rows;
  return [...rows]
    .sort((a, b) => {
      const am = parseUtcTimestampMs(a.last_activity_at);
      const bm = parseUtcTimestampMs(b.last_activity_at);
      if (am === null || bm === null) return (am === null ? 1 : 0) - (bm === null ? 1 : 0);
      return am - bm;
    })
    .slice(0, limit);
}

export const threadsHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const sinceHours = Math.min(
    parseInt(url.searchParams.get('since_hours') ?? '', 10) || DEFAULT_SINCE_HOURS,
    MAX_SINCE_HOURS,
  );
  const includeArchivedRaw = url.searchParams.get('include_archived');
  try {
    const body = await buildThreadList(ctx, {
      workgroupId: url.searchParams.get('workgroup'),
      groupId: url.searchParams.get('group_id'),
      includeArchived: includeArchivedRaw === '1' || includeArchivedRaw === 'true',
      sinceHours,
      limit,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    log.warn('threadsHandler: failed', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

const THREAD_TRANSCRIPT_TAIL = 200;

/**
 * Ordered by timestamp, not `seq`: `seq` is unique only within a session. Ties break on session id then seq only for
 * determinism.
 */
export function mergeThreadTranscript(
  sessions: Array<{ sessionId: string; agentGroupId: string; agentName: string }>,
  readOne: (agentGroupId: string, sessionId: string) => SessionTranscriptEntry[] = readSessionTranscript,
  tail: number = THREAD_TRANSCRIPT_TAIL,
): ThreadTranscriptEntry[] {
  const merged: ThreadTranscriptEntry[] = [];
  for (const s of sessions) {
    for (const entry of readOne(s.agentGroupId, s.sessionId)) {
      merged.push({ ...entry, session_id: s.sessionId, agent_group_id: s.agentGroupId, agent_name: s.agentName });
    }
  }
  merged.sort((a, b) => {
    const at = parseUtcTimestampMs(a.timestamp) ?? 0;
    const bt = parseUtcTimestampMs(b.timestamp) ?? 0;
    if (at !== bt) return at - bt;
    if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
    return a.seq - b.seq;
  });
  return merged.slice(-tail);
}

export interface ThreadDetailDeps extends ThreadListDeps {
  transcript?: (agentGroupId: string, sessionId: string) => SessionTranscriptEntry[];
}

export async function buildThreadDetail(
  threadId: string,
  ctx: AuthedRequestContext,
  deps: ThreadDetailDeps = {},
): Promise<{ thread: ThreadSummary; transcript: ThreadTranscriptEntry[] } | null> {
  // Reuses the list path so the detail header matches the row, scoped to this one thread. Archived threads stay
  // readable by direct link.
  const { threads } = await buildThreadList(
    ctx,
    { groupId: null, includeArchived: true, sinceHours: DEFAULT_SINCE_HOURS, limit: 1, threadId },
    deps,
  );
  const thread = threads[0];
  if (!thread) return null;

  // An ownerless item has no sessions, and `IN ()` is not valid SQLite.
  if (thread.session_ids.length === 0) return { thread, transcript: [] };

  const byName = new Map(thread.participants.map((p) => [p.agent_group_id, p.name]));
  const rows = await getDb().all<{ id: string; agent_group_id: string }>(
    `SELECT id, agent_group_id FROM sessions WHERE id IN (${thread.session_ids.map(() => '?').join(', ')})`,
    ...thread.session_ids,
  );

  return {
    thread,
    transcript: mergeThreadTranscript(
      rows.map((r) => ({
        sessionId: r.id,
        agentGroupId: r.agent_group_id,
        agentName: byName.get(r.agent_group_id) ?? r.agent_group_id,
      })),
      deps.transcript,
    ),
  };
}

export const threadsDetailHandler: AuthHandler = async (_req, params, ctx) => {
  // Thread ids carry `:` and `.`; a client that percent-encodes them must work too.
  const raw = params['id'] ?? '';
  let threadId = raw;
  try {
    threadId = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded — use it verbatim */
  }
  if (!threadId) {
    return new Response(JSON.stringify({ error: 'thread_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await buildThreadDetail(threadId, ctx);
    // Nonexistent and out-of-scope collapse to the same 404.
    if (!body) {
      return new Response(JSON.stringify({ error: 'thread_not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    log.warn('threadsDetailHandler: failed', { threadId, err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
