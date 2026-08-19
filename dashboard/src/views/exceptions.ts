import type { ObservatorySnapshot, ObservatoryAgent, ReleaseItem } from '../lib/api.js';
import { buildLedger } from './commitments.js';
import { agentState } from './office-data.js';

/**
 * The exception feed — what needs a person, before any interaction.
 *
 * This derives from fields that already ship on the wire and NOTHING else. It
 * invents no severity the board did not state, no age the data does not carry,
 * and no action the host does not already expose. Every rule below is total:
 * given a snapshot it returns the same list, in the same order, every time.
 */

/** Worst first. The order here IS the feed's order. */
export const SEVERITY_ORDER = ['hands', 'decision', 'parked'] as const;
export type ExceptionSeverity = (typeof SEVERITY_ORDER)[number];

/** What a card offers. Each maps to an endpoint the product already has. */
export type ExceptionAction =
  /** Open the work's own thread and say something — the agent's live session. */
  | { kind: 'steer'; agentId: string; sessionId: string | null }
  /** Hand a board item to an agent (POST /observatory/assign). */
  | { kind: 'assign'; itemId: string; channel: string | null }
  /** Push a stopped claim forward in its own thread (POST /observatory/nudge). */
  | { kind: 'nudge'; slug: string; threadId: string | null }
  /** No verb — just the link out to where the work lives. */
  | { kind: 'open'; url: string };

export interface ExceptionItem {
  /** Dedup key: item id, claim slug, or agent id. One card per key. */
  key: string;
  source: 'item' | 'claim' | 'agent';
  severity: ExceptionSeverity;
  title: string;
  /**
   * How long this has been waiting. NULL means the data carries no usable
   * timestamp — the card renders an em dash and sorts last within its class,
   * rather than showing an age nobody measured.
   */
  ageMs: number | null;
  /**
   * The room this belongs to, as an ObservatoryRoom.key — directly comparable
   * to the floor plan's own room keys. Null when it cannot be resolved from
   * what the wire says, in which case the card carries no room accent.
   */
  roomKey: string | null;
  actions: ExceptionAction[];
}

export const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  hands: 'Hands needed',
  decision: 'Decision needed',
  parked: 'Parked',
};

/** Same normalization the themed floor uses to match a channel name to a room. */
export function normalizeRoomName(name: string): string {
  return name.trim().toLowerCase().replace(/^#/, '');
}

/** A claim's threadId already encodes its channel — the first two segments. */
function claimRoomKey(threadId: string | null): string | null {
  if (!threadId) return null;
  const parts = threadId.split(':');
  return parts.length >= 2 ? parts.slice(0, 2).join(':') : null;
}

/** Elapsed ms since an ISO timestamp, or null when it is absent or unparseable. */
function ageOf(iso: string | null | undefined, now: number): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : null;
}

/**
 * An item's class, evaluated in precedence order so an item that matches two
 * takes the higher one and appears exactly once.
 */
function itemSeverity(item: ReleaseItem): ExceptionSeverity | null {
  if (item.nextMover === 'human') return 'hands';
  const bucket = item.meta?.bucket;
  if (bucket === 'decision') return 'decision';
  if (bucket === 'escalated') return 'parked';
  return null;
}

/**
 * Every open exception on this floor, worst first.
 *
 * Classes:
 * - `hands`    — items whose next mover is a PERSON, and agents the ledger
 *                reads as blocked (they own work that has already failed its
 *                promise);
 * - `decision` — items the watcher bucketed as a decision;
 * - `parked`   — items it bucketed as escalated, plus claims that have gone
 *                stale.
 *
 * Sort: class, then age descending (unknown ages last within their class),
 * then key ascending so the order never depends on input order.
 */
export function deriveExceptions(scene: ObservatorySnapshot, now = Date.now()): ExceptionItem[] {
  const items = scene.releaseState?.items ?? [];
  const out = new Map<string, ExceptionItem>();

  // Room lookup by the item's own channel name — the only room attribution an
  // item carries. A channel this floor does not show resolves to null.
  const roomByName = new Map(scene.rooms.map((r) => [normalizeRoomName(r.name), r.key]));

  for (const item of items) {
    const severity = itemSeverity(item);
    if (severity === null || out.has(item.id)) continue;
    out.set(item.id, {
      key: item.id,
      source: 'item',
      severity,
      title: item.title,
      ageMs: ageOf(item.since, now),
      roomKey: (item.channel && roomByName.get(normalizeRoomName(item.channel))) || null,
      actions: exceptionItemActions(item),
    });
  }

  // A claim that has stopped moving. `staleMs` is the only age a claim carries
  // on this wire — the board's own "how long past the deadline" — so it is what
  // the card shows, rather than a claimed-at the snapshot does not ship.
  for (const claim of scene.claims) {
    if (claim.state !== 'stale' || out.has(claim.slug)) continue;
    out.set(claim.slug, {
      key: claim.slug,
      source: 'claim',
      severity: 'parked',
      title: claim.note?.trim() || claim.slug,
      ageMs: Number.isFinite(claim.staleMs) ? Math.abs(claim.staleMs) : null,
      roomKey: claimRoomKey(claim.threadId),
      actions: [{ kind: 'nudge', slug: claim.slug, threadId: claim.threadId }],
    });
  }

  // Blocked agents, read through the SAME function the floor uses — so a person
  // the floor draws as blocked and the feed's own count can never disagree.
  const breachedOwners = new Set(
    buildLedger(items, now)
      .rows.filter((r) => r.state === 'breached' || r.state === 'unowned')
      .map((r) => r.item.owner)
      .filter((o): o is string => typeof o === 'string' && o.length > 0),
  );
  for (const agent of scene.agents) {
    if (out.has(agent.id)) continue;
    if (agentState(agent, breachedOwners, agent.location ?? '') !== 'blocked') continue;
    out.set(agent.id, {
      key: agent.id,
      source: 'agent',
      severity: 'hands',
      title: `${agent.name} is blocked`,
      ageMs: ageOf(agent.lastSeenAt, now),
      roomKey: agent.location,
      actions: agentActions(agent),
    });
  }

  return [...out.values()].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      // Unknown age sorts last within its class, never first and never as zero.
      (a.ageMs === null ? 1 : 0) - (b.ageMs === null ? 1 : 0) ||
      (b.ageMs ?? 0) - (a.ageMs ?? 0) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * An item's actions. Handing a person's own item to an agent is not the move —
 * so an item waiting on a HUMAN is offered its link out, not an assignment.
 * That is the same rule the board's own row already applies.
 */
function exceptionItemActions(item: ReleaseItem): ExceptionAction[] {
  if (item.nextMover === 'human') return item.url ? [{ kind: 'open', url: item.url }] : [];
  return [{ kind: 'assign', itemId: item.id, channel: item.channel ?? null }];
}

/** A blocked agent is steered through the session it is actually live in. */
function agentActions(agent: ObservatoryAgent): ExceptionAction[] {
  return [{ kind: 'steer', agentId: agent.id, sessionId: agent.liveSession?.sessionId ?? null }];
}
