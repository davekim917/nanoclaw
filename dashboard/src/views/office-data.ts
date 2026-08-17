import type { ObservatoryRoom, ObservatoryAgent, ReleaseItem } from '../lib/api.js';
import { buildLedger } from './commitments.js';

/**
 * Live data → the office map's fixed floor plan.
 *
 * The plan's geometry is hand-authored and FIXED (see office-map.js): the same
 * slots, the same furniture, in the same places, every render. This module only
 * decides which channel occupies which slot and who is standing in it.
 *
 * That split is the whole point. A plan generated from data reshuffles whenever
 * the data moves, and a room you cannot find twice is worse than a list.
 */

/** Slots the plan offers, in fill order. Mirrors SLOTS in office-map.js. */
export const SLOTS = [
  'westFront', 'eastFront', 'kitchen', 'westBack', 'eastBack',
  'eastWingN', 'eastWingM', 'eastWingS',
  'southWest', 'southMid', 'southEast',
] as const;
export type Slot = (typeof SLOTS)[number];

export type OfficeState = 'blocked' | 'waiting' | 'working' | 'idle';

export interface OfficeAgent {
  name: string;
  status: OfficeState;
  shirt: string;
  shirtHi: string;
  hair: string;
  skin?: string;
  /** The agent's real platform avatar, shown as a pixelated face token above
   *  its seat. Null for an agent with no wiring — it keeps the sprite alone,
   *  and a face is never invented. Rendered in office-map.js's DOM overlay,
   *  NOT in the world SVG: that SVG ships as a data URI and a data-URI SVG
   *  cannot load an external image. */
  avatarUrl?: string | null;
}

export interface OfficeRoomData {
  slot: Slot;
  label: string;
  open: number;
  state: OfficeState;
  agents: OfficeAgent[];
}

export interface OfficeData {
  rooms: OfficeRoomData[];
  /** Rooms that had no slot left. Named so the UI can say so out loud. */
  overflow: string[];
}

/** FNV-1a — stable across renders, so an agent always looks like itself. */
function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Desaturated-warm shirt tones. None is a status colour — an agent's clothing
// must never be readable as their state; the dot does that job.
const SHIRTS: [string, string][] = [
  ['#5b86ad', '#6f9bc2'],
  ['#7f9c5c', '#93b06d'],
  ['#c39a4e', '#d6ad60'],
  ['#8c6ea0', '#a081b5'],
  ['#4f5560', '#626875'],
  ['#6f9b6a', '#82b07c'],
  ['#a86a5c', '#bd8072'],
];
const HAIRS = ['#3a2e26', '#7a4f2c', '#4a3728', '#241c17', '#1f1a16', '#5c4632'];
const SKINS = ['#e4b98f', '#f0cfa8', '#d9a97e', '#c68f63', '#e8c091'];

/** A stable look for an agent, derived from its id alone. */
export function agentLook(id: string): Omit<OfficeAgent, 'name' | 'status'> {
  const h = hashKey(id);
  const [shirt, shirtHi] = SHIRTS[h % SHIRTS.length]!;
  return { shirt, shirtHi, hair: HAIRS[(h >>> 8) % HAIRS.length]!, skin: SKINS[(h >>> 16) % SKINS.length]! };
}

/**
 * An agent's state on the floor.
 *
 * `blocked` outranks everything: an agent holding work that has already failed
 * its promise is the thing the operator is looking for, and it must not be
 * hidden behind "awake". Otherwise awake is `working` and asleep is `idle`.
 * We deliberately do NOT infer `waiting` for an agent — waiting is a property
 * of an ITEM (it needs a person), never of the agent sitting next to it.
 */
export function agentState(agent: ObservatoryAgent, breachedOwners: Set<string>): OfficeState {
  if (breachedOwners.has(agent.name)) return 'blocked';
  return agent.awake ? 'working' : 'idle';
}

/** The worst state present in a room, which is the state the room shows. */
export function roomState(agents: OfficeAgent[], open: number): OfficeState {
  if (agents.some((a) => a.status === 'blocked')) return 'blocked';
  if (agents.some((a) => a.status === 'working')) return 'working';
  return open > 0 ? 'waiting' : 'idle';
}

/**
 * Assign channels to slots and place agents.
 *
 * Rooms arrive already in stable order (sortRooms: platform, then name), and
 * slots are filled in that order, so a channel keeps its slot across polls for
 * as long as the channel set is unchanged — which is what makes the floor
 * memorable. Channels past the last slot are reported as overflow rather than
 * silently dropped.
 *
 * `open` counts stay 0 until release items carry the channel they belong to:
 * as of 2026-08-16 not one of 71 items does, so there is nothing to count. The
 * map shows no number rather than a made-up one.
 */
export function buildOfficeData(
  rooms: ObservatoryRoom[],
  agents: ObservatoryAgent[],
  items: ReleaseItem[] = [],
  now = Date.now(),
): OfficeData {
  const breachedOwners = new Set(
    buildLedger(items, now)
      .rows.filter((r) => r.state === 'breached' || r.state === 'unowned')
      .map((r) => r.item.owner)
      .filter((o): o is string => typeof o === 'string' && o.length > 0),
  );

  const placed = rooms.slice(0, SLOTS.length);
  const out: OfficeRoomData[] = placed.map((room, i) => {
    const slot = SLOTS[i]!;
    const here: OfficeAgent[] = agents
      .filter((a) => a.location === room.key)
      // The plan seats a bounded number per room; extra occupants would have
      // nowhere to sit, so they stay in the list rather than overlapping.
      .slice(0, 2)
      .map((a) => ({ name: a.name, status: agentState(a, breachedOwners), avatarUrl: a.avatarUrl, ...agentLook(a.id) }));
    return { slot, label: room.name.startsWith('#') ? room.name : `#${room.name}`, open: 0, state: roomState(here, 0), agents: here };
  });

  return { rooms: out, overflow: rooms.slice(SLOTS.length).map((r) => r.name) };
}
