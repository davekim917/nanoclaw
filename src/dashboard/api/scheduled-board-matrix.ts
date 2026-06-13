/**
 * Verb × state availability matrix (Task A5) — the AUTHORITATIVE §4.0 table as
 * ONE exported structure plus the derivation function that maps
 * (health-state, series-kind, claim/due facts) → available verbs and per-verb
 * guard verdict.
 *
 * Every host mutation handler and the drawer's verb-button enable/disable read
 * THIS module. Guards are never re-scattered as per-handler conditionals that
 * merely cite §4.0 (the cycle-2 failure mode). See
 * docs/specs/scheduled-tasks-board/design.md §4.0.
 */
import { SWEEP_INTERVAL_MS } from './scheduled-shared.js';

export type HealthState = 'healthy' | 'late' | 'stalled' | 'paused' | 'processing' | 'unknown' | 'strand';

export type SeriesKind = 'recurring' | 'one_off' | 'thread_loop';

export type Verb = 'edit' | 'pause' | 'resume' | 'run_now' | 'cancel' | 'move';

/**
 * The guard→write TOCTOU margin (seconds-to-minutes). DISTINCT from §4.1's
 * stall grace (hours): reusing the stall formula here would make move
 * `source_busy` for half of every daily cycle (F4). Sized to two sweep
 * intervals, floored at 2 minutes.
 */
export const GUARD_GRACE_MS = Math.max(2 * SWEEP_INTERVAL_MS, 120_000);

export interface VerbVerdict {
  allowed: boolean;
  status?: 409 | 503;
  reason?: string;
  needsForce?: boolean;
}

export interface VerbCtx {
  state: HealthState;
  kind: SeriesKind;
  /** Positive processing-ack claim on the live row. */
  claimed: boolean;
  /** The live row's `process_after` in epoch ms, or null if unreadable. */
  processAfterMs: number | null;
  nowMs: number;
  /** run_now / move with an explicit operator force override (§4.6 F3). */
  forced?: boolean;
}

const ALLOW: VerbVerdict = { allowed: true };
const BUSY: VerbVerdict = { allowed: false, status: 409, reason: 'source_busy' };
const STALE: VerbVerdict = { allowed: false, status: 409, reason: 'stale_key' };
const NA: VerbVerdict = { allowed: false, reason: 'not_applicable' };

function isDue(ctx: VerbCtx): boolean {
  return ctx.processAfterMs !== null && ctx.processAfterMs <= ctx.nowMs;
}
function isNearDue(ctx: VerbCtx): boolean {
  return ctx.processAfterMs !== null && ctx.processAfterMs <= ctx.nowMs + GUARD_GRACE_MS;
}

/**
 * The matrix proper: one verdict function per verb, mapping the health-state
 * cell (+ claim/due facts) to a verdict. The series-KIND masks are applied
 * separately by `verbVerdict` (axes-precedence: kind mask AND state cell).
 */
const STATE_CELL: Record<Verb, (ctx: VerbCtx) => VerbVerdict> = {
  edit: (ctx) => {
    switch (ctx.state) {
      case 'processing':
        return BUSY;
      case 'strand':
        return STALE;
      default:
        // healthy | late | stalled | paused | unknown
        return ALLOW;
    }
  },

  pause: (ctx) => {
    switch (ctx.state) {
      case 'paused':
        return NA; // already paused
      case 'processing':
        return BUSY;
      case 'strand':
        return STALE;
      default:
        // healthy | late | stalled | unknown
        return ALLOW;
    }
  },

  resume: (ctx) => (ctx.state === 'paused' ? ALLOW : NA),

  run_now: (ctx) => {
    switch (ctx.state) {
      case 'unknown':
        // Fail closed — claim state is unknowable; firing could duplicate an
        // in-flight run (F6).
        return { allowed: false, status: 503, reason: 'claim_state_unreadable' };
      case 'processing':
        return BUSY;
      case 'paused':
      case 'strand':
        return NA;
      case 'late':
      case 'stalled':
        // The remedy: an UNCLAIMED overdue row is exactly what run_now exists
        // to fix. A positive claim makes it source_busy (double-fire risk).
        return ctx.claimed ? BUSY : ALLOW;
      case 'healthy':
        // Within guard_grace of the next slot a forced run can double-fire
        // (handleRecurrence computes next() from completion-now, §4.6): 409 by
        // default, fire only on explicit force.
        if (isNearDue(ctx) && !ctx.forced) {
          return { allowed: false, status: 409, reason: 'near_slot', needsForce: true };
        }
        if (ctx.claimed) return BUSY;
        return ALLOW;
      default:
        return NA;
    }
  },

  cancel: () => ALLOW, // available in EVERY health state (strand = the remedy)

  move: (ctx) => {
    // F1 admission: move requires paused, OR pending with the slot strictly
    // beyond now + guard_grace (closes the guard→cancel TOCTOU structurally).
    if (ctx.state === 'paused') return ALLOW;
    if (ctx.state === 'processing' || ctx.state === 'unknown' || ctx.state === 'strand') return BUSY;
    if (ctx.claimed) return BUSY;
    // healthy | late | stalled with a readable slot.
    if (isDue(ctx) || isNearDue(ctx)) return BUSY; // near-due / overdue = double-fire risk
    if (ctx.processAfterMs !== null && ctx.processAfterMs > ctx.nowMs + GUARD_GRACE_MS) return ALLOW;
    return BUSY;
  },
};

/**
 * Series-KIND masks: the set of verbs each kind DISABLES regardless of state
 * (v1). `recurring` disables nothing; one-offs and thread-loops disable `move`
 * (the TaskDef.cron type hole + thread-scoped move are v2 — §5 OUT).
 */
const KIND_DISABLES: Record<SeriesKind, ReadonlySet<Verb>> = {
  recurring: new Set<Verb>(),
  one_off: new Set<Verb>(['move']),
  thread_loop: new Set<Verb>(['move']),
};

/**
 * The single guard source. A verb is available only if BOTH the kind mask and
 * the state cell allow it (axes-precedence). The kind mask takes precedence:
 * a masked verb is never allowed, whatever the state cell says.
 */
export function verbVerdict(verb: Verb, ctx: VerbCtx): VerbVerdict {
  if (KIND_DISABLES[ctx.kind].has(verb)) {
    return { allowed: false, reason: 'kind_unsupported' };
  }
  return STATE_CELL[verb](ctx);
}

const ALL_VERBS: readonly Verb[] = ['edit', 'pause', 'resume', 'run_now', 'cancel', 'move'];

/** Verbs whose verdict.allowed === true for the given context. */
export function availableVerbs(ctx: VerbCtx): Verb[] {
  return ALL_VERBS.filter((v) => verbVerdict(v, ctx).allowed);
}
