/**
 * Observatory scene graph, derived entirely at request time (no tables, no cache). An unknown or out-of-scope
 * workgroup returns 200 with the empty shape, not 404/403.
 */
import fs from 'fs';
import path from 'path';

import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { DATA_DIR, GROUPS_DIR, REPO_ROOT } from '../../config.js';
import { getActiveContainerSessionIds, resolveAssistantName } from '../../container-runner.js';
import { readContainerConfig, type ContainerConfig } from '../../container-config.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import { workgroupLegacyRoot } from '../../repository-activation.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { threadChannelKey } from './threads.js';
import type { AgentGroup } from '../../types.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type ObservatoryClaim = BoardClaim & {
  /** Permalink to the thread the work was claimed in; null when unresolvable. */
  threadUrl: string | null;
  /**
   * The session whose transcript is this claim's conversation; null when there is none. See
   * {@link attachClaimSessions} for which sibling wins.
   */
  sessionId: string | null;
};

interface ObservatoryRoom {
  key: string;
  name: string;
  platform: string;
  memberAgentIds: string[];
  lastActivityAt: string | null;
  permalink: string | null;
}

interface ObservatoryAgent {
  id: string;
  /** Channel-facing persona name (resolveAssistantName) — what claim owners are written as. */
  name: string;
  canonicalName: string;
  folder: string;
  provider: string;
  /**
   * The bot's real Slack avatar, drawn unmodified; null when no wired bot has one (the UI falls back to initials,
   * never an invented face).
   */
  avatarUrl: string | null;
  awake: boolean;
  /**
   * Pulsing here right now: `awake` AND the seated room session spoke within WORKING_WINDOW_MS. `awake` alone covers
   * every session the agent owns, and `location` is deliberately sticky, so without the recency gate a seat pulses
   * hours after its last word in the room.
   */
  active: boolean;
  location: string | null;
  lastSeenAt: string | null;
  /**
   * The session this agent most recently spoke in, where a steer lands; null when it has never produced outbound.
   * Tracks `lastSeenAt`, not `location`, so it includes room-less task sessions.
   */
  lastSessionId: string | null;
  holding: string[];
  // No cheap source for a task's display title exists: prompt text stays server-side, and reading it would open every
  // session's inbound.db on every poll.
  nextTask: { title: string; at: string } | null;
  /**
   * The agent's most recent room-carrying session within LOCATION_WINDOW_MS, with enough to link to the live thread;
   * null when none. One value, not a per-room map: a room-scoped caller must treat a `channelKey` mismatch as "no
   * live thread here".
   */
  liveSession: {
    channelKey: string;
    sessionId: string;
    threadUrl: string | null;
    lastOutboundAt: string | null;
  } | null;
}

export interface ReleaseStateItem {
  id: string;
  kind: string;
  title: string;
  nextMover: 'human' | 'agent' | 'nobody';
  owner?: string;
  blocksRelease?: boolean;
  why?: string;
  since?: string;
  url?: string;
  /** ISO deadline the current mover promised the next transition by. */
  dueAt?: string | null;
  /** One line: what the current mover does next. */
  nextAction?: string;
  /** Slack channel the work lives in, e.g. '#qa-room'; how the floor and the assign path route an item to its room. */
  channel?: string;
  /**
   * Ids of items on this board that must land first. Omitted means "nobody checked"; `[]` means "checked, nothing
   * blocks it". Undeclared must never render as independent.
   */
  dependsOn?: string[];
  /**
   * The thread this item was already steered into, decorated at read time from `observatory_item_threads`; null when
   * nobody has. Host state, never published by the watcher.
   */
  steeredThread?: SteeredThread | null;
}

interface SteeredThread {
  threadId: string;
  threadUrl: string | null;
  at: string;
  /** Display name of whoever fired it, resolved at read time so a rename shows. */
  by: string;
}

export interface ReleaseState {
  asOf: string;
  generatedBy?: string;
  release?: { moratorium?: boolean; holds?: { kind: string; reason?: string; since?: string }[] };
  items: ReleaseStateItem[];
}

/**
 * The release desk artifact the workgroup's release watcher writes; the observatory only renders it. Member folders
 * are scanned because the file lives in the owning group's folder (siblings reach it via a symlink the host must not
 * depend on); newest mtime wins. Absent or unparseable → null.
 */
export async function readReleaseState(
  workgroupId: string,
  groupsDir: string = GROUPS_DIR,
): Promise<ReleaseState | null> {
  const members = await getDb().all<{ folder: string }>(
    'SELECT folder FROM agent_groups WHERE workgroup_id = ?',
    workgroupId,
  );

  let best: { mtime: number; state: ReleaseState } | null = null;
  for (const { folder } of members) {
    const file = path.join(groupsDir, folder, 'releases', 'release-state.json');
    try {
      const stat = fs.statSync(file);
      if (best && stat.mtimeMs <= best.mtime) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseState;
      if (typeof raw.asOf !== 'string' || !Array.isArray(raw.items)) continue;
      best = { mtime: stat.mtimeMs, state: raw };
    } catch {
      continue; // absent or unparseable — never let one folder break the scan
    }
  }
  return best?.state ?? null;
}

/**
 * Decorates a board with the threads its items were steered into: one query per poll. The LEFT JOIN degrades a
 * deleted user to the raw id rather than dropping the decoration; names resolve at read time so renames show.
 */
export async function decorateSteeredThreads(
  workgroupId: string,
  state: ReleaseState | null,
  linkFor: (threadId: string) => string | null | Promise<string | null> = threadPermalink,
): Promise<ReleaseState | null> {
  if (!state || state.items.length === 0) return state;
  let rows: { item_id: string; thread_id: string; created_at: string; by: string | null }[];
  try {
    rows = await getDb().all(
      `SELECT t.item_id, t.thread_id, t.created_at, u.display_name AS by
         FROM observatory_item_threads t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.workgroup_id = ?`,
      workgroupId,
    );
  } catch (err) {
    // The table arrives with migration 050; an older schema must still render its board.
    log.warn('observatory: could not read steered item threads', { workgroupId, err });
    return state;
  }
  if (rows.length === 0) return state;

  const byItem = new Map(rows.map((r) => [r.item_id, r]));
  return {
    ...state,
    items: await Promise.all(
      state.items.map(async (i) => {
        const hit = byItem.get(i.id);
        if (!hit) return i;
        return {
          ...i,
          steeredThread: {
            threadId: hit.thread_id,
            threadUrl: await linkFor(hit.thread_id),
            at: hit.created_at,
            by: hit.by ?? 'someone',
          },
        };
      }),
    ),
  };
}

/** `active` is always stated: a quiet bound room is a different fact from a room nobody bound. */
export interface ObservatorySignal {
  room: string;
  vignette: string;
  active: boolean;
}

export interface ObservatoryScene {
  workgroupId: string;
  asOf: string;
  rooms: ObservatoryRoom[];
  agents: ObservatoryAgent[];
  releaseState: ReleaseState | null;
  claims: ObservatoryClaim[];
  /** Themed-floor slot bindings — see readOfficeThemes. Undefined = no themes configured. */
  themedSlots?: Record<string, string>;
  /** Per-room live-state indicators — see readWorkgroupSignals. Undefined = no signals configured. */
  signals?: ObservatorySignal[];
}

function emptyScene(workgroupId: string): ObservatoryScene {
  return { workgroupId, asOf: new Date().toISOString(), rooms: [], agents: [], releaseState: null, claims: [] };
}

let themeConfigWarned = false;

/**
 * Themed-floor slot bindings (normalized channel name → office-map.js slot). Channel names are install identity,
 * which `check:public-boundary` keeps out of trunk, so they come from the operator's untracked
 * `.nanoclaw/office-themes.json`. Missing or unparseable → undefined, logged once rather than every poll; the floor
 * falls back to order-fill.
 */
export function readOfficeThemes(repoRoot: string = REPO_ROOT): Record<string, string> | undefined {
  const file = path.join(repoRoot, '.nanoclaw', 'office-themes.json');
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('office-themes.json is not an object');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (err) {
    if (!themeConfigWarned) {
      themeConfigWarned = true;
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      log[missing ? 'debug' : 'warn']('observatory: .nanoclaw/office-themes.json unreadable, themed floor disabled', {
        file,
        err,
      });
    }
    return undefined;
  }
}

let signalConfigWarned = false;

/** Clock skew a producer's timestamp is allowed to be ahead by. */
const SIGNAL_FUTURE_SKEW_MS = 60_000;

/** Closed entry schema: an entry carrying any other key is rejected. */
const SIGNAL_KEYS = new Set(['room', 'file', 'freshKey', 'maxAgeSeconds', 'vignette']);
const SIGNAL_VIGNETTES = new Set(['smoke']);

interface SignalBinding {
  room: string;
  file: string;
  freshKey: string;
  maxAgeSeconds: number;
  vignette: string;
}

/**
 * CLOSED on purpose: an unknown key means config written against a contract this build does not implement, and
 * ignoring it would render state from a rule nobody applied.
 */
function parseSignalBinding(raw: unknown): SignalBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SIGNAL_KEYS.has(k)) return null;
  const { room, file, freshKey, maxAgeSeconds, vignette } = o;
  if (typeof room !== 'string' || room.length === 0) return null;
  if (typeof file !== 'string' || file.length === 0) return null;
  if (typeof freshKey !== 'string' || freshKey.length === 0) return null;
  if (typeof maxAgeSeconds !== 'number' || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  if (typeof vignette !== 'string' || !SIGNAL_VIGNETTES.has(vignette)) return null;
  return { room, file, freshKey, maxAgeSeconds, vignette };
}

/**
 * The state file resolved inside the workgroup directory, or null if it escapes.
 * REALPATH, not string prefixing: a symlink inside the workgroup pointing at `/etc` passes every textual check. The
 * parent is resolved rather than the file because an absent file is inactive, not rejected; the final component is
 * guarded at read time with `O_NOFOLLOW` (see readContainedState).
 */
function containedStatePath(workgroupDir: string, file: string): string | null {
  if (path.isAbsolute(file)) return null;
  const target = path.resolve(workgroupDir, file);
  const rel = path.relative(workgroupDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.length === 0) return null;
  try {
    const realRoot = fs.realpathSync(workgroupDir);
    const realParent = fs.realpathSync(path.dirname(target));
    const realRel = path.relative(realRoot, realParent);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    return path.join(realParent, path.basename(target));
  } catch {
    // The directory does not exist; nothing can escape it, and the read reports the signal inactive.
    return target;
  }
}

/**
 * Exactly what `Date.prototype.toISOString` emits: `Date.parse` accepts engine- and locale-dependent shapes that no
 * liveness stamp may be asserted from.
 */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Reads the state file without following a symlink on its final component (`O_NOFOLLOW`), rejects non-regular files
 * via `fstat`, and reads from the descriptor so nothing can be swapped between check and read.
 * Returns null for absent, unreadable, not-a-regular-file, symlinked, or oversized; each means "not running".
 */
function readContainedState(statePath: string): string | null {
  let fd: number | undefined;
  try {
    // O_NONBLOCK matters as much as O_NOFOLLOW: opening a FIFO blocks until a writer appears, before fstat can reject
    // it, which would hang the poll.
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > 1_000_000) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function signalIsFresh(statePath: string, freshKey: string, maxAgeSeconds: number, now: number): boolean {
  const text = readContainedState(statePath);
  if (text === null) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const stamp = (raw as Record<string, unknown>)[freshKey];
  if (typeof stamp !== 'string' || !ISO_STAMP.test(stamp)) return false;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return false;
  // Open at the old end, closed at the new, matching the producer's own staleness rule. A future stamp is tolerated
  // only within the skew window.
  return at > now - maxAgeSeconds * 1000 && at <= now + SIGNAL_FUTURE_SKEW_MS;
}

/**
 * Per-room live-state indicators from the operator's untracked `.nanoclaw/office-signals.json` (room names and
 * producer files are install identity, kept out of trunk).
 * The contract is total: no/unreadable/malformed config → `undefined` and no `signals` key at all; an entry failing
 * the closed schema or duplicating a `room` is dropped; a `file` escaping the workgroup directory by any route drops
 * the entry; every surviving entry always emits `{room, vignette, active}`, with an unreadable state file meaning
 * `active: false`, never a throw.
 */
export function readWorkgroupSignals(
  workgroupId: string,
  now = Date.now(),
  repoRoot: string = REPO_ROOT,
  dataDir: string = DATA_DIR,
): ObservatorySignal[] | undefined {
  const configFile = path.join(repoRoot, '.nanoclaw', 'office-signals.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    if (!signalConfigWarned) {
      signalConfigWarned = true;
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      log[missing ? 'debug' : 'warn']('observatory: .nanoclaw/office-signals.json unreadable, room signals disabled', {
        file: configFile,
        err,
      });
    }
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;

  let workgroupDir: string;
  try {
    workgroupDir = workgroupLegacyRoot(workgroupId, dataDir);
  } catch {
    // An id that is not a single safe path segment cannot name a real workgroup directory.
    return undefined;
  }

  const out: ObservatorySignal[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const binding = parseSignalBinding(entry);
    if (!binding || seen.has(binding.room)) continue;
    const statePath = containedStatePath(workgroupDir, binding.file);
    if (statePath === null) continue;
    seen.add(binding.room);
    out.push({
      room: binding.room,
      vignette: binding.vignette,
      active: signalIsFresh(statePath, binding.freshKey, binding.maxAgeSeconds, now),
    });
  }
  return out;
}

/**
 * Same scope predicate as workgroups.ts's resolveWorkgroup, minus the existence check (an unknown id yields empty
 * results anyway). issue-brief.ts must refuse on this same predicate before touching the workgroup's board or its
 * scoped GitHub token.
 */
export async function hasWorkgroupAccess(workgroupId: string, ctx: AuthedRequestContext): Promise<boolean> {
  if (ctx.scopes.no_filter) return true;
  if (ctx.scopes.allowed_group_ids.length === 0) return false;
  const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
  const hit = await getDb().get(
    `SELECT 1 FROM agent_groups WHERE workgroup_id = ? AND id IN (${placeholders}) LIMIT 1`,
    workgroupId,
    ...ctx.scopes.allowed_group_ids,
  );
  return !!hit;
}

const LOCATION_WINDOW_MS = 8 * 60 * 60 * 1000;

/**
 * How recently a room session must have spoken for the agent to read as working there. 10 minutes is about five times
 * the observed gap between outbound rows mid-turn, and tighter than CHAT_IDLE_REAP_MS (15m) and ABSOLUTE_CEILING_MS
 * (30m), so the floor never shows someone working in a room the host is about to reap.
 */
const WORKING_WINDOW_MS = 10 * 60 * 1000;

/** Case-insensitive match of a claim owner against an agent's channel-facing name OR folder. */
export function ownerMatchesAgent(owner: string, agent: { name: string; folder: string }): boolean {
  const o = owner.trim().toLowerCase();
  return o === agent.name.trim().toLowerCase() || o === agent.folder.trim().toLowerCase();
}

interface RoomAccum {
  key: string;
  name: string | null;
  platform: string;
  memberAgentIds: Set<string>;
  messagingGroupIds: Set<string>;
}

interface WiringRow {
  messaging_group_id: string;
  platform_id: string;
  channel_type: string;
  name: string | null;
  agent_group_id: string;
}

/**
 * Platform allow-list from `observatory.platforms` on any one member's container.json; absent means every platform
 * shows.
 */
async function observatoryHiddenRooms(workgroupId: string): Promise<string[]> {
  const members = await getDb().all<{ folder: string }>(
    'SELECT folder FROM agent_groups WHERE workgroup_id = ?',
    workgroupId,
  );
  for (const { folder } of members) {
    try {
      const declared = readContainerConfig(folder).observatory?.hideRooms;
      if (Array.isArray(declared) && declared.length > 0) return declared;
    } catch {
      continue;
    }
  }
  return [];
}

async function observatoryPlatforms(workgroupId: string): Promise<string[] | null> {
  const members = await getDb().all<{ folder: string }>(
    'SELECT folder FROM agent_groups WHERE workgroup_id = ?',
    workgroupId,
  );
  for (const { folder } of members) {
    try {
      const declared = readContainerConfig(folder).observatory?.platforms;
      if (Array.isArray(declared) && declared.length > 0) return declared;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Filtered off the floor: DMs (Slack DM ids carry a `D` in the channel segment) and anything in
 * `observatory.hideRooms`, e.g. a Slack canvas the API reports as `is_channel: true`.
 */
export function isNotARoom(platformId: string, hidden: string[]): boolean {
  if (hidden.includes(platformId)) return true;
  const parts = platformId.split(':');
  const channel = parts.length > 1 ? parts[1] : parts[0];
  return platformId.startsWith('slack:') && /^D/.test(channel ?? '');
}

/**
 * Channel-level permalink via the owning adapter; null when it cannot build one (a fabricated URL is worse than
 * none).
 * `channelPermalink`, NOT `permalink(platformId, null)`: `permalink` addresses a thread and declines a null thread id
 * by contract.
 */
export function roomPermalink(platform: string, platformId: string): string | null {
  try {
    return getChannelAdapter(platform)?.channelPermalink?.(platformId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Channel types that could own this thread, best first. The thread id prefix is the bare platform, which is an
 * adapter key only in a single-workspace install; per-workspace types (`slack-acme`, …) are looked up via
 * `messaging_groups`, with the bare prefix as the last candidate. Rows for one `platform_id` are one workspace, so
 * which sibling type wins does not change the link.
 */
async function threadChannelTypes(threadId: string): Promise<string[]> {
  const prefix = threadId.split(':')[0] ?? '';
  try {
    const rows = await getDb().all<{ channel_type: string }>(
      `SELECT DISTINCT channel_type FROM messaging_groups WHERE platform_id = ? ORDER BY channel_type`,
      await threadPlatformId(threadId),
    );
    return [...rows.map((r) => r.channel_type), prefix];
  } catch {
    // No DB (early boot, unit tests) — the bare prefix is the only candidate.
    return [prefix];
  }
}

/**
 * Permalink for a claim's thread, or null when no online adapter can build one exactly. The claims board and the
 * nudge write path must link to the same place. Never throws.
 */
export async function threadPermalink(threadId: string): Promise<string | null> {
  const platformId = await threadPlatformId(threadId);
  for (const channelType of await threadChannelTypes(threadId)) {
    try {
      const link = getChannelAdapter(channelType)?.permalink?.(platformId, threadId);
      if (link) return link;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Delegates to `threadChannelKey` so the board and the delivery path share one answer: a two-segment slice yields the
 * GUILD for Discord (`discord:<guild>:<channel>`) and matches nothing.
 */
export async function threadPlatformId(threadId: string): Promise<string> {
  let known: Set<string> | undefined;
  try {
    const rows = await getDb().all<{ platform_id: string }>('SELECT DISTINCT platform_id FROM messaging_groups');
    known = new Set(rows.map((r) => r.platform_id));
  } catch {
    // No DB (early boot, unit tests) — the parser's own segment rule stands in.
  }
  return threadChannelKey(threadId, known);
}

async function buildRooms(
  workgroupId: string,
  allowed: string[] | null,
  hidden: string[] = [],
): Promise<ObservatoryRoom[]> {
  const wiringRows = await getDb().all<WiringRow>(
    `SELECT mg.id AS messaging_group_id, mg.platform_id AS platform_id, mg.channel_type AS channel_type,
            mg.name AS name, ag.id AS agent_group_id
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
      WHERE ag.workgroup_id = ?`,
    workgroupId,
  );

  const onFloor = (
    allowed
      ? wiringRows.filter((r) => allowed.some((p) => r.channel_type === p || r.channel_type.startsWith(`${p}-`)))
      : wiringRows
  ).filter((r) => !isNotARoom(r.platform_id, hidden));

  const byPlatformId = new Map<string, RoomAccum>();
  for (const row of onFloor) {
    let room = byPlatformId.get(row.platform_id);
    if (!room) {
      room = {
        key: row.platform_id,
        name: row.name,
        platform: row.channel_type,
        memberAgentIds: new Set(),
        messagingGroupIds: new Set(),
      };
      byPlatformId.set(row.platform_id, room);
    }
    if (!room.name && row.name) room.name = row.name;
    room.memberAgentIds.add(row.agent_group_id);
    room.messagingGroupIds.add(row.messaging_group_id);
  }

  const rooms: ObservatoryRoom[] = [];
  for (const room of byPlatformId.values()) {
    const mgIds = [...room.messagingGroupIds];
    const placeholders = mgIds.map(() => '?').join(', ');
    // Ordered by `datetime(...)`, NOT `MAX(last_outbound_at)`: the column is TEXT, and a naive `2026-08-20 23:00:00`
    // sorts below an ISO `2026-08-20T07:00:00.000Z` byte-wise.
    const activityRow = await getDb().get<{ last: string | null }>(
      `SELECT last_outbound_at AS last FROM sessions
        WHERE messaging_group_id IN (${placeholders})
          AND last_outbound_at IS NOT NULL
        ORDER BY datetime(last_outbound_at) DESC
        LIMIT 1`,
      ...mgIds,
    );

    rooms.push({
      key: room.key,
      name: room.name ?? room.key,
      platform: room.platform,
      memberAgentIds: [...room.memberAgentIds],
      lastActivityAt: activityRow?.last ?? null,
      permalink: roomPermalink(room.platform, room.key),
    });
  }
  return rooms;
}

/**
 * resolveAssistantName is what wrote the claim owners, so `holding` must match against it. `null` session context:
 * the scene shows an agent generally, not per channel. A resolution failure falls back to the infrastructure name.
 */
async function resolvePersonaName(
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  deps: ObservatoryDeps,
): Promise<string> {
  try {
    return await deps.resolveAssistantName(agentGroup, containerConfig, null);
  } catch (err) {
    log.warn('observatory: resolveAssistantName failed, falling back to agent_groups.name', {
      agentGroupId: agentGroup.id,
      err,
    });
    return agentGroup.name;
  }
}

/** Same persona resolution as the scene, for callers that hold only the DB row. */
export async function personaName(agentGroup: AgentGroup): Promise<string> {
  return resolvePersonaName(agentGroup, readContainerConfig(agentGroup.folder), defaultDeps);
}

async function buildAgents(
  workgroupId: string,
  claims: ObservatoryClaim[],
  deps: ObservatoryDeps,
): Promise<ObservatoryAgent[]> {
  const agentRows = await getDb().all<AgentGroup>('SELECT * FROM agent_groups WHERE workgroup_id = ?', workgroupId);

  const activeSessionIds = new Set(deps.getActiveContainerSessionIds());
  const nowMs = Date.now();

  return Promise.all(
    agentRows.map(async (row) => {
      const sessions = await getSessionsByAgentGroup(row.id);
      const awake = sessions.some((s) => activeSessionIds.has(s.id));

      // Two separate trackers on purpose: lastSeenAt is "last spoke anywhere", including room-less task sessions;
      // location is a PLACE, so only sessions with a messaging group count.
      let mostRecentAt: string | null = null;
      let mostRecentSessionId: string | null = null;
      let mostRecentMs = -Infinity;
      let roomMs = -Infinity;
      let roomMgId: string | null = null;
      let roomSessionId: string | null = null;
      let roomThreadId: string | null = null;
      let roomAt: string | null = null;
      for (const s of sessions) {
        const ms = parseUtcTimestampMs(s.last_outbound_at);
        if (ms === null) continue;
        if (ms > mostRecentMs) {
          mostRecentMs = ms;
          mostRecentAt = s.last_outbound_at ?? null;
          mostRecentSessionId = s.id;
        }
        if (s.messaging_group_id && ms > roomMs) {
          roomMs = ms;
          roomMgId = s.messaging_group_id;
          roomSessionId = s.id;
          roomThreadId = s.thread_id ?? null;
          roomAt = s.last_outbound_at ?? null;
        }
      }

      const location =
        roomMgId && nowMs - roomMs <= LOCATION_WINDOW_MS
          ? ((await getMessagingGroup(roomMgId))?.platform_id ?? null)
          : null;
      const active = awake && location !== null && nowMs - roomMs <= WORKING_WINDOW_MS;

      const linkForThread = deps.resolveThreadUrl ?? threadPermalink;
      const liveSession =
        location && roomSessionId
          ? {
              channelKey: location,
              sessionId: roomSessionId,
              threadUrl: roomThreadId ? await linkForThread(roomThreadId) : null,
              lastOutboundAt: roomAt,
            }
          : null;

      const provider = (await getContainerConfig(row.id))?.provider ?? row.agent_provider ?? '';
      const containerConfig = readContainerConfig(row.folder);
      const name = await resolvePersonaName(row, containerConfig, deps);

      const holding = claims.filter((c) => ownerMatchesAgent(c.owner, { name, folder: row.folder })).map((c) => c.slug);

      const lookup = deps.avatarByChannelType ?? ((ct: string) => getKnownSlackBots().get(ct)?.imageUrl ?? null);
      const channelTypes = await getDb().all<{ channel_type: string }>(
        `SELECT DISTINCT mg.channel_type FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ?`,
        row.id,
      );
      let avatarUrl: string | null = null;
      for (const { channel_type } of channelTypes) {
        avatarUrl = lookup(channel_type);
        if (avatarUrl) break;
      }

      return {
        id: row.id,
        name,
        canonicalName: row.name,
        avatarUrl,
        folder: row.folder,
        provider,
        awake,
        active,
        location,
        lastSeenAt: mostRecentAt,
        lastSessionId: mostRecentSessionId,
        holding,
        nextTask: null,
        liveSession,
      };
    }),
  );
}

/**
 * Fills each claim's `sessionId` in place. Siblings in one room each have a session on the thread; the OWNER's
 * session wins, else the one that most recently spoke there. Mutates because `buildAgents` already consumed the array
 * to compute `holding`.
 */
async function attachClaimSessions(
  workgroupId: string,
  claims: ObservatoryClaim[],
  agents: ObservatoryAgent[],
): Promise<void> {
  if (!claims.some((c) => c.threadId)) return;
  const rows = await getDb().all<{
    id: string;
    agent_group_id: string;
    thread_id: string;
    last_outbound_at: string | null;
  }>(
    `SELECT s.id, s.agent_group_id, s.thread_id, s.last_outbound_at
       FROM sessions s
       JOIN agent_groups g ON g.id = s.agent_group_id
      WHERE g.workgroup_id = ? AND s.thread_id IS NOT NULL AND s.status = 'active'`,
    workgroupId,
  );
  if (rows.length === 0) return;

  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byThread.get(r.thread_id);
    if (list) list.push(r);
    else byThread.set(r.thread_id, [r]);
  }
  const ownerOfSlug = new Map<string, string>();
  for (const a of agents) for (const slug of a.holding) ownerOfSlug.set(slug, a.id);

  for (const c of claims) {
    if (!c.threadId) continue;
    const onThread = byThread.get(c.threadId);
    if (!onThread) continue;
    const owner = ownerOfSlug.get(c.slug);
    const mine = owner ? onThread.find((r) => r.agent_group_id === owner) : undefined;
    const newest = onThread.reduce((a, b) =>
      (parseUtcTimestampMs(b.last_outbound_at) ?? -Infinity) > (parseUtcTimestampMs(a.last_outbound_at) ?? -Infinity)
        ? b
        : a,
    );
    c.sessionId = (mine ?? newest).id;
  }
}

export interface ObservatoryDeps {
  getActiveContainerSessionIds: () => string[];
  claimsRoot?: string;
  groupsDir?: string;
  resolveAssistantName: (
    agentGroup: AgentGroup,
    containerConfig: ContainerConfig,
    sessionMessagingGroupId: string | null,
  ) => Promise<string>;
  avatarByChannelType?: (channelType: string) => string | null;
  resolveThreadUrl?: (threadId: string) => string | null | Promise<string | null>;
  platforms?: string[] | null;
  hiddenRooms?: string[];
  themedSlots?: Record<string, string>;
  signals?: ObservatorySignal[] | undefined;
}

const defaultDeps: ObservatoryDeps = { getActiveContainerSessionIds, resolveAssistantName };

export async function buildObservatoryScene(
  workgroupId: string,
  deps: ObservatoryDeps = defaultDeps,
): Promise<ObservatoryScene> {
  const rawClaims =
    deps.claimsRoot !== undefined
      ? readClaims(workgroupId, Date.now(), deps.claimsRoot)
      : readClaims(workgroupId, Date.now());

  // A claim's thread_id encodes channel type, channel and ts, so the owning adapter resolves the link with no extra
  // state.
  const linkFor = deps.resolveThreadUrl ?? threadPermalink;
  const claims: ObservatoryClaim[] = await Promise.all(
    rawClaims.map(async (c) => ({
      ...c,
      threadUrl: c.threadId ? await linkFor(c.threadId) : null,
      sessionId: null,
    })),
  );

  const agents = await buildAgents(workgroupId, claims, deps);
  await attachClaimSessions(workgroupId, claims, agents);

  const platforms = deps.platforms !== undefined ? deps.platforms : await observatoryPlatforms(workgroupId);
  const hiddenRooms = deps.hiddenRooms ?? (await observatoryHiddenRooms(workgroupId));
  const releaseStateRaw =
    deps.groupsDir !== undefined
      ? await readReleaseState(workgroupId, deps.groupsDir)
      : await readReleaseState(workgroupId);

  return {
    workgroupId,
    asOf: new Date().toISOString(),
    rooms: await buildRooms(workgroupId, platforms, hiddenRooms),
    agents,
    claims,
    releaseState: await decorateSteeredThreads(workgroupId, releaseStateRaw, linkFor),
    themedSlots: deps.themedSlots !== undefined ? deps.themedSlots : readOfficeThemes(),
    signals: 'signals' in deps ? deps.signals : readWorkgroupSignals(workgroupId),
  };
}

export const observatoryHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const workgroupId = url.searchParams.get('workgroup') ?? '';
  if (!workgroupId || !(await hasWorkgroupAccess(workgroupId, ctx))) {
    return json(emptyScene(workgroupId));
  }
  return json(await buildObservatoryScene(workgroupId));
};
