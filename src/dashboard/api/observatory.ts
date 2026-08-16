/**
 * Observatory scene graph (read-only, derived entirely at request time — no
 * new tables, no caching, no stored state):
 *
 *   GET /dashboard/api/observatory?workgroup=<workgroupId>
 *
 * Same disclose-as-not-found spirit as workgroups.ts, but flattened to one
 * status code: an unknown or out-of-scope workgroup id returns 200 with the
 * same empty-array shape rather than 404/403 — this endpoint has no route
 * param to gate, just a query string, so there's nothing to 404 on.
 */
import fs from 'fs';
import path from 'path';

import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { GROUPS_DIR } from '../../config.js';
import { getActiveContainerSessionIds, resolveAssistantName } from '../../container-runner.js';
import { readContainerConfig, type ContainerConfig } from '../../container-config.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import { log } from '../../log.js';
import type { AgentGroup } from '../../types.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export type ObservatoryClaim = BoardClaim & {
  /** Resolved permalink to the thread the work was claimed in — every row on the
   *  board links back to where it actually happened. Null when unresolvable. */
  threadUrl: string | null;
};

export interface ObservatoryRoom {
  key: string;
  name: string;
  platform: string;
  memberAgentIds: string[];
  lastActivityAt: string | null;
  permalink: string | null;
}

export interface ObservatoryAgent {
  id: string;
  /** Channel-facing persona name (resolveAssistantName) — what claim owners are written as. */
  name: string;
  /** agent_groups.name — infrastructure identity, secondary UI detail only. */
  canonicalName: string;
  folder: string;
  provider: string;
  /** The bot's real Slack avatar (public slack-edge URL) — the UI pixelates it client-side. Null when no wired bot has one. */
  avatarUrl: string | null;
  awake: boolean;
  location: string | null;
  lastSeenAt: string | null;
  holding: string[];
  // ponytail: no cheap source for a task's display title exists yet — the
  // scheduled-board snapshot deliberately keeps prompt/script text server-side
  // only (scheduled-assembly.ts's search_index, "NEVER serialized to the
  // wire"), and reading it back out would mean opening every agent's session
  // inbound.db on every observatory poll. Wire it once a titled read exists.
  nextTask: { title: string; at: string } | null;
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
  /**
   * Ids of items on this same board that must land first. OMITTING the field
   * means "nobody checked"; an explicit `[]` means "checked, nothing blocks
   * it". The dependency view treats those as different states on purpose —
   * undeclared must never render as independent — so the watcher publishing
   * `[]` is a real assertion, not a filler value.
   */
  dependsOn?: string[];
}

export interface ReleaseState {
  asOf: string;
  generatedBy?: string;
  release?: { moratorium?: boolean; holds?: { kind: string; reason?: string; since?: string }[] };
  items: ReleaseStateItem[];
}

/**
 * The release desk's machine artifact, written by the workgroup's own release
 * watcher every ~30 minutes (see the workgroup runbook + decisions.md
 * 2026-08-16). The observatory only RENDERS it — one aggregator, one
 * renderer, so the desk and the dashboard can never tell two stories. Member
 * folders are scanned because the file lives in the owning group's folder
 * (siblings reach it via a symlink the host must not depend on); newest
 * mtime wins. Absent or unparseable → null, and the UI says "no release
 * desk" rather than inventing one.
 */
export function readReleaseState(workgroupId: string, groupsDir: string = GROUPS_DIR): ReleaseState | null {
  const members = getDb().prepare('SELECT folder FROM agent_groups WHERE workgroup_id = ?').all(workgroupId) as {
    folder: string;
  }[];

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

export interface ObservatoryScene {
  workgroupId: string;
  asOf: string;
  rooms: ObservatoryRoom[];
  agents: ObservatoryAgent[];
  releaseState: ReleaseState | null;
  claims: ObservatoryClaim[];
}

function emptyScene(workgroupId: string): ObservatoryScene {
  return { workgroupId, asOf: new Date().toISOString(), rooms: [], agents: [], releaseState: null, claims: [] };
}

/**
 * Whether the caller may see this workgroup at all — same scope predicate as
 * workgroups.ts's resolveWorkgroup, minus the "row exists" check (a
 * nonexistent workgroup id naturally yields empty query results below, so
 * there's no separate not-found branch to maintain).
 */
function hasWorkgroupAccess(workgroupId: string, ctx: AuthedRequestContext): boolean {
  if (ctx.scopes.no_filter) return true;
  if (ctx.scopes.allowed_group_ids.length === 0) return false;
  const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
  const hit = getDb()
    .prepare(`SELECT 1 FROM agent_groups WHERE workgroup_id = ? AND id IN (${placeholders}) LIMIT 1`)
    .get(workgroupId, ...ctx.scopes.allowed_group_ids);
  return !!hit;
}

/**
 * Normalize a SQLite TIMESTAMP (naive `YYYY-MM-DD HH:MM:SS`, no zone marker —
 * see `bumpLastOutbound`) to epoch ms as UTC. Same fix scheduled-assembly.ts
 * applies to the same column family: without it, `Date.parse` reads the
 * string as local time.
 */
function parseUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.includes('T') ? s : s.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

const LOCATION_WINDOW_MS = 8 * 60 * 60 * 1000;

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
 * Platform allow-list for a workgroup's floor, declared as
 * `observatory.platforms` on any one member's container.json (same
 * one-declaration convention as backlogCanvas). Lets a workgroup that lives on
 * Slack hide dormant wiring on another platform without un-wiring it. Absent =
 * every platform shows.
 */
export function observatoryHiddenRooms(workgroupId: string): string[] {
  const members = getDb().prepare('SELECT folder FROM agent_groups WHERE workgroup_id = ?').all(workgroupId) as {
    folder: string;
  }[];
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

export function observatoryPlatforms(workgroupId: string): string[] | null {
  const members = getDb().prepare('SELECT folder FROM agent_groups WHERE workgroup_id = ?').all(workgroupId) as {
    folder: string;
  }[];
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
 * Rooms are WORKING ROOMS. Two things get filtered off the floor:
 *
 * - **Direct messages.** A 1:1 conversation is not a place the team works; it
 *   is a private line. Slack DM ids carry a `D` in the channel segment, which
 *   is how the platform itself distinguishes them.
 * - **Anything explicitly hidden** via `observatory.hideRooms`. The live case
 *   is a Slack CANVAS whose backing object the API reports as
 *   `is_channel: true` (with no member count) — it renders as a tab inside
 *   another channel, so it looks like a room to the API and like a document
 *   to the humans. Trust the humans.
 */
export function isNotARoom(platformId: string, hidden: string[]): boolean {
  if (hidden.includes(platformId)) return true;
  const parts = platformId.split(':');
  const channel = parts.length > 1 ? parts[1] : parts[0];
  return platformId.startsWith('slack:') && /^D/.test(channel ?? '');
}

function buildRooms(workgroupId: string, allowed: string[] | null, hidden: string[] = []): ObservatoryRoom[] {
  const wiringRows = getDb()
    .prepare(
      `SELECT mg.id AS messaging_group_id, mg.platform_id AS platform_id, mg.channel_type AS channel_type,
              mg.name AS name, ag.id AS agent_group_id
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE ag.workgroup_id = ?`,
    )
    .all(workgroupId) as WiringRow[];

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
    const activityRow = getDb()
      .prepare(`SELECT MAX(last_outbound_at) AS last FROM sessions WHERE messaging_group_id IN (${placeholders})`)
      .get(...mgIds) as { last: string | null } | undefined;

    let permalink: string | null = null;
    try {
      permalink = getChannelAdapter(room.platform)?.permalink?.(room.key, null) ?? null;
    } catch {
      permalink = null; // an adapter's permalink() must never fail the whole scene
    }

    rooms.push({
      key: room.key,
      name: room.name ?? room.key,
      platform: room.platform,
      memberAgentIds: [...room.memberAgentIds],
      lastActivityAt: activityRow?.last ?? null,
      permalink,
    });
  }
  return rooms;
}

/**
 * Persona name for the scene — resolveAssistantName is what wrote the claim
 * owners, so it's what `holding` must match against. `null` session context:
 * the observatory shows an agent generally, not scoped to one channel; the
 * operator-set `container_configs.assistant_name` override (which doesn't
 * need a session) is the common case in practice. A resolution failure must
 * never blank the scene — log and fall back to the infrastructure name.
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

async function buildAgents(
  workgroupId: string,
  claims: ObservatoryClaim[],
  deps: ObservatoryDeps,
): Promise<ObservatoryAgent[]> {
  const agentRows = getDb()
    .prepare('SELECT * FROM agent_groups WHERE workgroup_id = ?')
    .all(workgroupId) as AgentGroup[];

  const activeSessionIds = new Set(deps.getActiveContainerSessionIds());
  const nowMs = Date.now();

  return Promise.all(
    agentRows.map(async (row) => {
      const sessions = getSessionsByAgentGroup(row.id);
      const awake = sessions.some((s) => activeSessionIds.has(s.id));

      // Two separate trackers on purpose. lastSeenAt is "last spoke anywhere",
      // including task sessions with no destination room. location is a PLACE,
      // so only sessions carrying a messaging group count — otherwise an
      // agent whose newest outbound is a room-less task session gets pulled to
      // its desk while its real in-room activity is minutes old (observed live:
      // a 01:25 task outbound shadowing a 00:54 #dispatch post).
      let mostRecentAt: string | null = null;
      let mostRecentMs = -Infinity;
      let roomMs = -Infinity;
      let roomMgId: string | null = null;
      for (const s of sessions) {
        const ms = parseUtcMs(s.last_outbound_at);
        if (ms === null) continue;
        if (ms > mostRecentMs) {
          mostRecentMs = ms;
          mostRecentAt = s.last_outbound_at ?? null;
        }
        if (s.messaging_group_id && ms > roomMs) {
          roomMs = ms;
          roomMgId = s.messaging_group_id;
        }
      }

      const location =
        roomMgId && nowMs - roomMs <= LOCATION_WINDOW_MS ? (getMessagingGroup(roomMgId)?.platform_id ?? null) : null;

      const provider = getContainerConfig(row.id)?.provider ?? row.agent_provider ?? '';
      const containerConfig = readContainerConfig(row.folder);
      const name = await resolvePersonaName(row, containerConfig, deps);

      const holding = claims.filter((c) => ownerMatchesAgent(c.owner, { name, folder: row.folder })).map((c) => c.slug);

      // The agent's face: its own bot's Slack avatar, found via whichever of
      // its wired channel types carries a registered identity with an image.
      const lookup = deps.avatarByChannelType ?? ((ct: string) => getKnownSlackBots().get(ct)?.imageUrl ?? null);
      const channelTypes = getDb()
        .prepare(
          `SELECT DISTINCT mg.channel_type FROM messaging_group_agents mga
             JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
            WHERE mga.agent_group_id = ?`,
        )
        .all(row.id) as { channel_type: string }[];
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
        location,
        lastSeenAt: mostRecentAt,
        holding,
        nextTask: null,
      };
    }),
  );
}

export interface ObservatoryDeps {
  getActiveContainerSessionIds: () => string[];
  /** Injected claims root for tests; defaults to readClaims' own live claimsBaseDir(). */
  claimsRoot?: string;
  /** Injected groups dir for tests; defaults to the live GROUPS_DIR. */
  groupsDir?: string;
  resolveAssistantName: (
    agentGroup: AgentGroup,
    containerConfig: ContainerConfig,
    sessionMessagingGroupId: string | null,
  ) => Promise<string>;
  /** Bot avatar by channel type — defaults to the live Slack bot registry. Injected so tests never need an adapter. */
  avatarByChannelType?: (channelType: string) => string | null;
  /** Thread-id → permalink; defaults to resolving through the owning channel adapter. */
  resolveThreadUrl?: (threadId: string) => string | null;
  /** Platform allow-list override for tests; defaults to the workgroup's declared observatory.platforms. */
  platforms?: string[] | null;
  /** Explicitly hidden room ids; defaults to the workgroup's declared observatory.hideRooms. */
  hiddenRooms?: string[];
}

const defaultDeps: ObservatoryDeps = { getActiveContainerSessionIds, resolveAssistantName };

export async function buildObservatoryScene(
  workgroupId: string,
  deps: ObservatoryDeps = defaultDeps,
): Promise<ObservatoryScene> {
  // deps.claimsRoot undefined → readClaims falls back to its own live claimsBaseDir().
  const rawClaims =
    deps.claimsRoot !== undefined
      ? readClaims(workgroupId, Date.now(), deps.claimsRoot)
      : readClaims(workgroupId, Date.now());

  // Every claim carries a link back to the thread it was worked in. A claim's
  // thread_id already encodes its channel type + channel + ts, so the adapter
  // that owns that platform resolves it — one hop, no extra state.
  const linkFor =
    deps.resolveThreadUrl ??
    ((threadId: string): string | null => {
      const channelType = threadId.split(':')[0] ?? '';
      const adapter = getChannelAdapter(channelType);
      if (!adapter?.permalink) return null;
      const platformId = threadId.split(':').slice(0, 2).join(':');
      try {
        return adapter.permalink(platformId, threadId);
      } catch {
        return null;
      }
    });
  const claims: ObservatoryClaim[] = rawClaims.map((c) => ({
    ...c,
    threadUrl: c.threadId ? linkFor(c.threadId) : null,
  }));

  return {
    workgroupId,
    asOf: new Date().toISOString(),
    rooms: buildRooms(
      workgroupId,
      deps.platforms !== undefined ? deps.platforms : observatoryPlatforms(workgroupId),
      deps.hiddenRooms ?? observatoryHiddenRooms(workgroupId),
    ),
    agents: await buildAgents(workgroupId, claims, deps),
    claims,
    releaseState:
      deps.groupsDir !== undefined ? readReleaseState(workgroupId, deps.groupsDir) : readReleaseState(workgroupId),
  };
}

export const observatoryHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const workgroupId = url.searchParams.get('workgroup') ?? '';
  if (!workgroupId || !hasWorkgroupAccess(workgroupId, ctx)) {
    return json(emptyScene(workgroupId));
  }
  return json(await buildObservatoryScene(workgroupId));
};
