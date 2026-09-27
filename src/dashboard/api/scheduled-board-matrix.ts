/**
 * The authoritative verb × state availability matrix and its derivation. Every mutation handler and the drawer's verb
 * buttons read THIS module; guards must never be re-scattered as per-handler conditionals.
 */
import { SWEEP_INTERVAL_MS } from './scheduled-shared.js';

export type HealthState = 'healthy' | 'late' | 'stalled' | 'paused' | 'processing' | 'unknown' | 'strand';

export type SeriesKind = 'recurring' | 'one_off' | 'thread_loop';

export type Verb = 'edit' | 'pause' | 'resume' | 'run_now' | 'cancel' | 'move';

/**
 * The guard→write race margin (seconds to minutes), DISTINCT from the stall grace (hours): reusing the stall formula
 * would make move `source_busy` for half of every daily cycle.
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
  claimed: boolean;
  processAfterMs: number | null;
  nowMs: number;
  /** Explicit operator force override (run_now / move). */
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

/** One verdict function per verb over the health-state cell; `verbVerdict` applies the series-kind masks on top. */
const STATE_CELL: Record<Verb, (ctx: VerbCtx) => VerbVerdict> = {
  edit: (ctx) => {
    switch (ctx.state) {
      case 'processing':
        return BUSY;
      case 'strand':
        return STALE;
      default:
        return ALLOW;
    }
  },

  pause: (ctx) => {
    switch (ctx.state) {
      case 'paused':
        return NA;
      case 'processing':
        return BUSY;
      case 'strand':
        return STALE;
      default:
        return ALLOW;
    }
  },

  resume: (ctx) => (ctx.state === 'paused' ? ALLOW : NA),

  run_now: (ctx) => {
    switch (ctx.state) {
      case 'unknown':
        // Fail closed: with claim state unknowable, firing could duplicate an in-flight run.
        return { allowed: false, status: 503, reason: 'claim_state_unreadable' };
      case 'processing':
        return BUSY;
      case 'paused':
      case 'strand':
        return NA;
      case 'late':
      case 'stalled':
        // An unclaimed overdue row is exactly what run_now fixes; a claimed one is a double-fire risk.
        return ctx.claimed ? BUSY : ALLOW;
      case 'healthy':
        // Within guard_grace of the next slot a run can double-fire (recurrence computes next() from completion
        // time): 409 unless forced.
        if (isNearDue(ctx) && !ctx.forced) {
          return { allowed: false, status: 409, reason: 'near_slot', needsForce: true };
        }
        if (ctx.claimed) return BUSY;
        return ALLOW;
      default:
        return NA;
    }
  },

  cancel: () => ALLOW, // Available in every state; it is the remedy for a strand.

  move: (ctx) => {
    // Move requires paused, or pending with the slot strictly beyond now + guard_grace, which closes the guard→cancel
    // race structurally.
    if (ctx.state === 'paused') return ALLOW;
    if (ctx.state === 'processing' || ctx.state === 'unknown' || ctx.state === 'strand') return BUSY;
    if (ctx.claimed) return BUSY;
    if (isDue(ctx) || isNearDue(ctx)) return BUSY; // Near-due or overdue is a double-fire risk.
    if (ctx.processAfterMs !== null && ctx.processAfterMs > ctx.nowMs + GUARD_GRACE_MS) return ALLOW;
    return BUSY;
  },
};

/** Verbs each series kind disables regardless of state; one-offs and thread-loops cannot move. */
const KIND_DISABLES: Record<SeriesKind, ReadonlySet<Verb>> = {
  recurring: new Set<Verb>(),
  one_off: new Set<Verb>(['move']),
  thread_loop: new Set<Verb>(['move']),
};

/**
 * The single guard source: a verb is available only if both the kind mask and the state cell allow it, and the kind
 * mask wins.
 */
export function verbVerdict(verb: Verb, ctx: VerbCtx): VerbVerdict {
  if (KIND_DISABLES[ctx.kind].has(verb)) {
    return { allowed: false, reason: 'kind_unsupported' };
  }
  return STATE_CELL[verb](ctx);
}

const ALL_VERBS: readonly Verb[] = ['edit', 'pause', 'resume', 'run_now', 'cancel', 'move'];

export function availableVerbs(ctx: VerbCtx): Verb[] {
  return ALL_VERBS.filter((v) => verbVerdict(v, ctx).allowed);
}
