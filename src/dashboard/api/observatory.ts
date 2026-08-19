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
import { DATA_DIR, GROUPS_DIR, REPO_ROOT } from '../../config.js';
import { getActiveContainerSessionIds, resolveAssistantName } from '../../container-runner.js';
import { readContainerConfig, type ContainerConfig } from '../../container-config.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import { workgroupLegacyRoot } from '../../repository-activation.js';
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
  /**
   * The session whose transcript IS this claim's conversation — what a slug
   * like `xzo-whats-new-817` actually MEANS, readable without leaving the
   * board. Null when the claim has no thread, or no session on it. See
   * {@link attachClaimSessions} for which session wins when siblings share one.
   */
  sessionId: string | null;
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
  /**
   * Doing something HERE, right now — the floor's pulse.
   *
   * `awake` is container liveness across every session the agent owns, and an
   * agent whose task container is merely up reads as awake for as long as it
   * runs. Combined with `location`'s deliberately sticky 8h window that made a
   * seat pulse hours after its last word in the room (observed live: an agent
   * whose newest #room outbound was 4h50m old, drawn working). Where an agent
   * SITS is allowed to be sticky; whether it PULSES is not.
   *
   * So: awake AND the seated room session spoke within WORKING_WINDOW_MS. Same
   * session `location` and `liveSession` already picked — this only adds the
   * recency gate, so an agent is never "working" in a room it isn't standing in.
   */
  active: boolean;
  location: string | null;
  lastSeenAt: string | null;
  /**
   * The session this agent most recently spoke in — the one a steer should
   * land in. Null when it has never produced outbound. Deliberately tracks
   * `lastSeenAt`, not `location`: steering follows the conversation the agent
   * is actually in, including a room-less task session, whereas location is a
   * PLACE and only counts sessions with a room.
   */
  lastSessionId: string | null;
  holding: string[];
  // ponytail: no cheap source for a task's display title exists yet — the
  // scheduled-board snapshot deliberately keeps prompt/script text server-side
  // only (scheduled-assembly.ts's search_index, "NEVER serialized to the
  // wire"), and reading it back out would mean opening every agent's session
  // inbound.db on every observatory poll. Wire it once a titled read exists.
  nextTask: { title: string; at: string } | null;
  /**
   * The agent's most-recent session that carries a room — same source and
   * same LOCATION_WINDOW_MS gate as `location`, but carrying enough to link
   * to the actual live thread rather than just naming the channel. Null when
   * the agent has no room-scoped session inside the window.
   *
   * This is a single "where do I currently point" value, not a per-room map:
   * a caller that wants a ROOM-SCOPED drawer must compare
   * `liveSession.channelKey` against the room it is asking about and treat a
   * mismatch as "no live thread here" — an agent live in #ops has no live
   * session to show in #dispatch, however active #ops is.
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
  /** Slack channel the work lives in, e.g. '#qa-room' — how the floor and
   *  the assign path route an item to its room. Emitted 73/73 as of the
   *  2026-08-17 board wake. */
  channel?: string;
  /**
   * Ids of items on this same board that must land first. OMITTING the field
   * means "nobody checked"; an explicit `[]` means "checked, nothing blocks
   * it". The dependency view treats those as different states on purpose —
   * undeclared must never render as independent — so the watcher publishing
   * `[]` is a real assertion, not a filler value.
   */
  dependsOn?: string[];
  /**
   * The thread somebody already steered this item into, decorated onto the
   * board at read time from `observatory_item_threads` — the board's own memory
   * of a one-click ship. Null when nobody has. Never published by the watcher:
   * this is host state about an item, not a fact about the work.
   */
  steeredThread?: SteeredThread | null;
}

export interface SteeredThread {
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

/**
 * Decorate a board with the threads its items have already been steered into.
 *
 * One query per poll, not one per item, and a LEFT JOIN for the name so a user
 * row that has since been deleted degrades to the raw id rather than dropping
 * the whole decoration — knowing a thread exists matters more than knowing who
 * opened it.
 *
 * Read-time resolution on purpose: `observatory_item_threads` stores a
 * `users.id`, so a display-name change is never frozen into the table.
 */
export function decorateSteeredThreads(
  workgroupId: string,
  state: ReleaseState | null,
  linkFor: (threadId: string) => string | null = threadPermalink,
): ReleaseState | null {
  if (!state || state.items.length === 0) return state;
  let rows: { item_id: string; thread_id: string; created_at: string; by: string | null }[];
  try {
    rows = getDb()
      .prepare(
        `SELECT t.item_id, t.thread_id, t.created_at, u.display_name AS by
           FROM observatory_item_threads t
           LEFT JOIN users u ON u.id = t.created_by
          WHERE t.workgroup_id = ?`,
      )
      .all(workgroupId) as typeof rows;
  } catch (err) {
    // The table arrives with migration 050; a host running an older schema must
    // still render its board rather than blanking the scene.
    log.warn('observatory: could not read steered item threads', { workgroupId, err });
    return state;
  }
  if (rows.length === 0) return state;

  const byItem = new Map(rows.map((r) => [r.item_id, r]));
  return {
    ...state,
    items: state.items.map((i) => {
      const hit = byItem.get(i.id);
      if (!hit) return i;
      return {
        ...i,
        steeredThread: {
          threadId: hit.thread_id,
          threadUrl: linkFor(hit.thread_id),
          at: hit.created_at,
          by: hit.by ?? 'someone',
        },
      };
    }),
  };
}

/**
 * One room's live-state indicator. `active` is always stated: a bound room that
 * is quiet is a different fact from a room nobody bound, and the UI must be
 * able to tell them apart without inferring anything.
 */
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
 * Themed-floor slot bindings (normalized channel name → office-map.js slot),
 * install config only — see office-data.ts's buildOfficeData. A channel name
 * is install identity, which `check:public-boundary` rightly refuses to let
 * live in trunk source, so the real mapping is the operator's own untracked
 * `.nanoclaw/office-themes.json`, resolved the same repo-root-relative way
 * the boundary checker resolves its own identifier file. Missing or
 * unparseable → undefined, logged once (not every 15s poll) rather than on
 * every call, and the scene must never blank over it — the floor just falls
 * back to plain order-fill.
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

/** The closed entry schema. An entry carrying anything else is not this shape. */
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
 * A binding entry, or null if it is not one. CLOSED on purpose: a key this
 * doesn't know is a config written against a contract this build does not
 * implement, and quietly ignoring it would render a room's state from a rule
 * nobody applied.
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
 * The state file this binding names, resolved inside the workgroup directory —
 * or null if it escapes.
 *
 * REALPATH, not string prefixing: `..` and an absolute path are the obvious
 * escapes, but a symlink planted inside the workgroup directory pointing at
 * `/etc` passes every textual check. The parent is resolved rather than the
 * file itself because the file legitimately may not exist yet (a campaign that
 * has never run), and an absent file is inactive, not rejected.
 *
 * This covers the DIRECTORY chain only. The final component is the other half,
 * and it is handled at read time with `O_NOFOLLOW` — see readContainedState.
 * Splitting it that way is what lets an absent file stay inactive rather than
 * rejected while a symlinked one is refused outright.
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
    // The workgroup dir (or the file's directory) does not exist. Nothing can
    // escape a directory that isn't there, and the read below will simply
    // report the signal inactive.
    return target;
  }
}

/**
 * Exactly what `Date.prototype.toISOString` emits, and nothing else.
 *
 * `Date.parse` is far more forgiving than R7's contract: it accepts
 * "12/25/2026", "Dec 25 2026 10:00", and a pile of other shapes whose meaning
 * is engine- and locale-dependent. A liveness stamp that only PARSES is not a
 * timestamp a room's state may be asserted from.
 */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Read the state file WITHOUT ever following a symlink on its final component.
 *
 * `containedStatePath` proves the file's directory chain resolves inside the
 * workgroup; this closes the other half. A state file that is ITSELF a symlink
 * pointing out of the workgroup passes every parent check — `readFileSync`
 * would happily follow it and read whatever it aimed at. `O_NOFOLLOW` makes the
 * kernel refuse (ELOOP) instead, `fstat` on the descriptor rejects anything
 * that is not a regular file (a fifo would block the poll; a directory is not
 * state), and the read comes FROM THE DESCRIPTOR — so nothing can be swapped
 * underneath between the check and the read.
 *
 * Returns null for absent, unreadable, not-a-regular-file, symlinked, or
 * oversized. Every one of those means "not running", which is the honest
 * reading of a liveness marker that is not simply there.
 */
function readContainedState(statePath: string): string | null {
  let fd: number | undefined;
  try {
    // O_NONBLOCK matters as much as O_NOFOLLOW: opening a FIFO for reading
    // BLOCKS until a writer shows up, and that open happens before fstat can
    // reject it — so without this a fifo in the state path hangs the poll
    // itself, not just this read. On a regular file it is a no-op.
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    // A liveness marker is a few hundred bytes. Anything else is not one, and
    // the poll must not be made to read it.
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

/** Whether the producer's own freshness stamp says this signal is live NOW. */
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
  // Open at the old end, closed at the new: exactly at the age limit the
  // producer itself calls stale, so does this. A stamp in the future is a clock
  // that disagrees, tolerated only as far as the skew window.
  return at > now - maxAgeSeconds * 1000 && at <= now + SIGNAL_FUTURE_SKEW_MS;
}

/**
 * Per-room live-state indicators, install config only.
 *
 * A room name and the file a producer writes are both install identity, which
 * `check:public-boundary` rightly refuses to let live in trunk source — so the
 * binding is the operator's own untracked `.nanoclaw/office-signals.json`,
 * resolved the same repo-root-relative way `readOfficeThemes` resolves its own.
 *
 * The contract is TOTAL, and every branch of it matters:
 *
 * - no config file, unreadable, malformed JSON, or not an array → `undefined`,
 *   and the scene ships without a `signals` key at all — byte-identical to
 *   before this existed;
 * - an entry that fails the closed schema is dropped, the rest still render;
 * - a duplicate `room` is dropped, first binding wins;
 * - a `file` that escapes the workgroup directory by any route — absolute,
 *   `..`, or a symlink — drops the ENTRY rather than reading it;
 * - every surviving entry ALWAYS emits `{room, vignette, active}`. A missing,
 *   unreadable, or unparseable state file is `active: false`, never a throw and
 *   never a dropped entry: a bound room that is quiet is a fact, and it is a
 *   different fact from a room nobody bound.
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
    // An id that is not a single safe path segment never reaches a real
    // workgroup directory, so there is nothing to read for it.
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

/**
 * How recently a room session must have spoken for the agent to read as
 * WORKING there — see ObservatoryAgent.active.
 *
 * Picked off the live cadence, not a round number: inside a session that is
 * genuinely mid-turn, consecutive `messages_out` rows land seconds to ~2
 * minutes apart (status narration plus chat), so 10 minutes is five times the
 * observed live gap and never blinks an agent off mid-task. It is also
 * strictly tighter than the host's own two "this is over" clocks —
 * CHAT_IDLE_REAP_MS (15m) and ABSOLUTE_CEILING_MS (30m) — so the floor can
 * never claim someone is working in a room the host is about to reap them out
 * of.
 */
export const WORKING_WINDOW_MS = 10 * 60 * 1000;

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

/**
 * Channel-level permalink for a room, resolved through the adapter that owns
 * its platform. Null when the adapter is absent or has no channelPermalink() —
 * an adapter must never fail the caller, and a fabricated URL is worse than
 * none.
 *
 * `channelPermalink`, NOT `permalink(platformId, null)`: `permalink` addresses
 * a THREAD and declines a null thread id by contract (slackPermalink's own
 * test asserts it), so asking it for a room link returned null on every room
 * of every floor — which is why "answer in #dispatch" rendered as dead text.
 */
export function roomPermalink(platform: string, platformId: string): string | null {
  try {
    return getChannelAdapter(platform)?.channelPermalink?.(platformId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Channel types that could own this thread, best first.
 *
 * A thread id's prefix is the bare PLATFORM (`slack:C0AAA:171…`), which is a
 * registered adapter key only in a single-workspace install. This install
 * registers per-workspace types (`slack-acme`, `slack-acme-support`, …), so
 * the bare prefix matched nothing and every genuine Slack thread resolved
 * to null. `messaging_groups` already carries the mapping — the
 * thread's channel is one row's `platform_id` — so ask it, and keep the bare
 * prefix as the last candidate for installs where it IS the key.
 *
 * All rows for one `platform_id` are the same workspace (channel ids don't
 * collide across workspaces), so which sibling type wins doesn't change the
 * resulting link — only whether the owning adapter happens to be online.
 */
function threadChannelTypes(threadId: string): string[] {
  const prefix = threadId.split(':')[0] ?? '';
  try {
    const rows = getDb()
      .prepare(`SELECT DISTINCT channel_type FROM messaging_groups WHERE platform_id = ? ORDER BY channel_type`)
      .all(threadPlatformId(threadId)) as { channel_type: string }[];
    return [...rows.map((r) => r.channel_type), prefix];
  } catch {
    // No DB (early boot, unit tests) — the bare prefix is the only candidate.
    return [prefix];
  }
}

/**
 * Permalink for a claim's thread, or null when no online adapter can build one
 * exactly. Exported: the claims board and the nudge write path must link to the
 * same place. Never throws — a dead link is worse than none, and a blank scene
 * is worse than both.
 */
export function threadPermalink(threadId: string): string | null {
  for (const channelType of threadChannelTypes(threadId)) {
    try {
      const link = getChannelAdapter(channelType)?.permalink?.(threadPlatformId(threadId), threadId);
      if (link) return link;
    } catch {
      continue;
    }
  }
  return null;
}

/** '<channelType>:<channel>:<ts>' → '<channelType>:<channel>', the messaging_groups.platform_id key. */
export function threadPlatformId(threadId: string): string {
  return threadId.split(':').slice(0, 2).join(':');
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

/**
 * Persona name for an agent group with nothing pre-loaded — same resolution
 * the scene uses, for callers (the assign endpoint) that hold only the DB row.
 */
export async function personaName(agentGroup: AgentGroup): Promise<string> {
  return resolvePersonaName(agentGroup, readContainerConfig(agentGroup.folder), defaultDeps);
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
      let mostRecentSessionId: string | null = null;
      let mostRecentMs = -Infinity;
      let roomMs = -Infinity;
      let roomMgId: string | null = null;
      let roomSessionId: string | null = null;
      let roomThreadId: string | null = null;
      let roomAt: string | null = null;
      for (const s of sessions) {
        const ms = parseUtcMs(s.last_outbound_at);
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
        roomMgId && nowMs - roomMs <= LOCATION_WINDOW_MS ? (getMessagingGroup(roomMgId)?.platform_id ?? null) : null;
      const active = awake && location !== null && nowMs - roomMs <= WORKING_WINDOW_MS;

      // Same window and same winning session as `location` — this just also
      // carries the thread link, so a caller doesn't have to re-derive it.
      const linkForThread = deps.resolveThreadUrl ?? threadPermalink;
      const liveSession =
        location && roomSessionId
          ? {
              channelKey: location,
              sessionId: roomSessionId,
              threadUrl: roomThreadId ? linkForThread(roomThreadId) : null,
              lastOutboundAt: roomAt,
            }
          : null;

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
 * Fill in each claim's `sessionId` in place, once the agents are known.
 *
 * A claim records a THREAD; sessions are keyed by (agent_group,
 * messaging_group, thread), so a thread names more than one session whenever
 * siblings sit in the same room. The OWNER's session wins — that is the
 * conversation the claim is a claim on. Failing that (owner unresolved, or
 * holding nothing on this thread) the session that most recently SPOKE there
 * stands in: reading a sibling's copy of the room beats reading nothing, and
 * the one that said the last thing holds the most of the room. Same
 * `last_outbound_at` recency `location` and `liveSession` are picked by.
 *
 * Mutates rather than re-maps because `buildAgents` already consumed the claim
 * array to compute `holding`, and that join is exactly what names the owner.
 */
function attachClaimSessions(workgroupId: string, claims: ObservatoryClaim[], agents: ObservatoryAgent[]): void {
  if (!claims.some((c) => c.threadId)) return;
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.agent_group_id, s.thread_id, s.last_outbound_at
         FROM sessions s
         JOIN agent_groups g ON g.id = s.agent_group_id
        WHERE g.workgroup_id = ? AND s.thread_id IS NOT NULL AND s.status = 'active'`,
    )
    .all(workgroupId) as { id: string; agent_group_id: string; thread_id: string; last_outbound_at: string | null }[];
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
      (parseUtcMs(b.last_outbound_at) ?? -Infinity) > (parseUtcMs(a.last_outbound_at) ?? -Infinity) ? b : a,
    );
    c.sessionId = (mine ?? newest).id;
  }
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
  /** Themed-floor slot bindings, injected for tests; defaults to the live readOfficeThemes(). */
  themedSlots?: Record<string, string>;
  /** Room signals, injected for tests; defaults to the live readWorkgroupSignals(). */
  signals?: ObservatorySignal[] | undefined;
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
  const linkFor = deps.resolveThreadUrl ?? threadPermalink;
  const claims: ObservatoryClaim[] = rawClaims.map((c) => ({
    ...c,
    threadUrl: c.threadId ? linkFor(c.threadId) : null,
    sessionId: null,
  }));

  const agents = await buildAgents(workgroupId, claims, deps);
  attachClaimSessions(workgroupId, claims, agents);

  return {
    workgroupId,
    asOf: new Date().toISOString(),
    rooms: buildRooms(
      workgroupId,
      deps.platforms !== undefined ? deps.platforms : observatoryPlatforms(workgroupId),
      deps.hiddenRooms ?? observatoryHiddenRooms(workgroupId),
    ),
    agents,
    claims,
    releaseState: decorateSteeredThreads(
      workgroupId,
      deps.groupsDir !== undefined ? readReleaseState(workgroupId, deps.groupsDir) : readReleaseState(workgroupId),
      linkFor,
    ),
    themedSlots: deps.themedSlots !== undefined ? deps.themedSlots : readOfficeThemes(),
    signals: 'signals' in deps ? deps.signals : readWorkgroupSignals(workgroupId),
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
