import type { ReleaseItem, ReleaseNextMover } from '../lib/api.js';

/**
 * The commitment ledger.
 *
 * A work item is not a commitment. `XZO#832 exists` tells you nothing about
 * whether anything will ever happen to it — 32 of 70 items on this board are
 * perfectly valid work items that nobody has touched in up to 29 days. A
 * COMMITMENT is a triple: an item, exactly one owner, and a promised next
 * transition with a deadline. That is the only object that can be stalled,
 * and therefore the only one worth putting a top-down view on.
 *
 * `nextMover` is already a degenerate commitment — it names an owner but has
 * no deadline and permits a null owner. This module treats both of those as
 * defects to SURFACE rather than to smooth over:
 *
 *   - `nextMover: 'nobody'` is **breached at birth**. Nobody has promised
 *     anything, so there is nothing to be on track for. It sorts with the
 *     breaches, not into a tidy "unowned" bucket that reads as a backlog.
 *   - an owner with no `dueAt` is **undated** — a promise with no clock is
 *     indistinguishable from no promise, and it is reported as a coverage gap
 *     the same way undeclared dependencies are.
 *
 * Nothing here decides anything. Deciding is the sweep's job, and it must be
 * dumb code on a clock — an agent asked to notice its own silence is the one
 * actor structurally incapable of it. This module only tells the truth about
 * what the sweep has and hasn't done.
 */

export type CommitmentState = 'unowned' | 'breached' | 'undated' | 'due-soon' | 'on-track';

/** Inside this window a commitment is "due soon" rather than "on track". */
export const DUE_SOON_MS = 4 * 60 * 60 * 1000;

export interface Commitment {
  item: ReleaseItem;
  state: CommitmentState;
  mover: ReleaseNextMover;
  /** ms until the deadline; negative once breached. Null when undated/unowned. */
  msToDue: number | null;
  /** How long the item has existed in its current state, ms. Null if unknown. */
  ageMs: number | null;
}

function parse(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function classify(item: ReleaseItem, now: number): Commitment {
  const since = parse(item.since);
  const ageMs = since === null ? null : now - since;
  const due = parse(item.dueAt);

  // No owner means no promise. This is the state the whole exercise exists to
  // make impossible, so it is never allowed to look like a calm backlog.
  if (item.nextMover === 'nobody') {
    return { item, state: 'unowned', mover: 'nobody', msToDue: null, ageMs };
  }
  if (due === null) {
    return { item, state: 'undated', mover: item.nextMover, msToDue: null, ageMs };
  }
  const msToDue = due - now;
  const state: CommitmentState = msToDue < 0 ? 'breached' : msToDue <= DUE_SOON_MS ? 'due-soon' : 'on-track';
  return { item, state, mover: item.nextMover, msToDue, ageMs };
}

/**
 * Sort order IS the design. Anything that has already failed its promise comes
 * first, oldest first, because the oldest breach is the one the system has been
 * lying about longest. Then what a person owes, then everything else by how
 * soon it will breach.
 */
const RANK: Record<CommitmentState, number> = {
  breached: 0,
  unowned: 0, // breached at birth — same tier, deliberately
  'due-soon': 2,
  undated: 3,
  'on-track': 4,
};

export interface Ledger {
  rows: Commitment[];
  counts: { breached: number; person: number; onTrack: number };
  /** Percentage of owned commitments that carry a deadline at all (0-100). */
  datedPct: number;
  undatedCount: number;
}

export function buildLedger(items: ReleaseItem[], now = Date.now()): Ledger {
  const rows = items.map((i) => classify(i, now));

  rows.sort((a, b) => {
    const ra = RANK[a.state];
    const rb = RANK[b.state];

    // Breaches win outright, before any other consideration. Checking the
    // person-priority first (as this did originally) let a human's on-track
    // item outrank an already-failed promise, which inverts the whole point.
    const aBreach = ra === 0;
    const bBreach = rb === 0;
    if (aBreach !== bBreach) return aBreach ? -1 : 1;
    // Within the breach tier, oldest first — longest-standing lie leads.
    if (aBreach) return (b.ageMs ?? 0) - (a.ageMs ?? 0);

    // Then what a person owes, whatever its deadline.
    const aPerson = a.mover === 'human';
    const bPerson = b.mover === 'human';
    if (aPerson !== bPerson) return aPerson ? -1 : 1;

    if (ra !== rb) return ra - rb;
    // Everywhere else, soonest to breach leads.
    if (a.msToDue !== null && b.msToDue !== null) return a.msToDue - b.msToDue;
    return (b.ageMs ?? 0) - (a.ageMs ?? 0);
  });

  const breached = rows.filter((r) => r.state === 'breached' || r.state === 'unowned').length;
  const person = rows.filter((r) => r.mover === 'human' && r.state !== 'breached' && r.state !== 'unowned').length;
  const owned = rows.filter((r) => r.state !== 'unowned');
  const dated = owned.filter((r) => r.state !== 'undated').length;

  return {
    rows,
    counts: { breached, person, onTrack: rows.length - breached - person },
    datedPct: owned.length === 0 ? 100 : Math.round((dated / owned.length) * 100),
    undatedCount: owned.length - dated,
  };
}

/** "3h overdue" · "in 40m" · "no deadline" · "nobody owns this". */
export function dueLabel(c: Commitment): string {
  if (c.state === 'unowned') return 'nobody owns this';
  if (c.msToDue === null) return 'no deadline';
  const abs = Math.abs(c.msToDue);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const d = Math.floor(h / 24);
  const span = d > 0 ? `${d}d` : h > 0 ? `${h}h` : `${m}m`;
  return c.msToDue < 0 ? `${span} overdue` : `in ${span}`;
}
