/**
 * Pure ceiling-follow-up decision.
 *
 * Deliberately split out of `index.ts`: `src/host-restart-warn.ts` imports
 * `decideCeilingFollowUp` from `src/host-sweep.js` and that import path is
 * outside this PR's ownership, so `host-sweep.ts` must re-export the symbol
 * from here. `index.ts` cannot be that source — it calls
 * `registerSweepDutySource` at module eval, and a re-export from
 * `host-sweep.ts` would put that side effect inside `host-sweep.ts`'s own
 * dependency cycle, where the registry's module-level `const`s are still in
 * their temporal dead zone. This file has no top-level side effect and reads
 * nothing from `host-sweep.ts` until call time, so the cycle is inert in
 * either evaluation order.
 *
 * Body moved from `src/host-sweep.ts` UNCHANGED.
 */
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';
import { ABSOLUTE_CEILING_MS, SWEEP_INTERVAL_MS } from '../../host-sweep.js';

export type CeilingFollowUp = { action: 'none' } | { action: 'wake-accountable'; reason: 'continuation' | 'tool' };

export function decideCeilingFollowUp(args: {
  hasContinuation: boolean;
  currentTool: string | null;
  toolStartedAt: string | null;
  priorToolAttempts: number;
  now: number;
  /**
   * The ceiling that actually fired for this kill (decideStuckAction's
   * `ceilingMs`, itself widened by a declared Bash/CodexItem timeout). Supply
   * it ONLY from the kill path: it buys the tool-freshness bound one extra
   * sweep interval of detection lag. Callers that ask "is a tool in flight
   * right now" rather than "what did this kill interrupt" — host-restart-warn
   * runs against live state with no sweep lag — omit it and keep the plain
   * ABSOLUTE_CEILING_MS freshness window.
   */
  ceilingMs?: number;
}): CeilingFollowUp {
  if (args.hasContinuation) return { action: 'wake-accountable', reason: 'continuation' };
  if (!args.currentTool || !args.toolStartedAt) return { action: 'none' };
  const startedAt = parseSqliteUtc(args.toolStartedAt);
  // Bound against the ceiling that actually fired, plus one sweep interval of
  // detection lag. Bounding against ABSOLUTE_CEILING_MS made this branch
  // unreachable: starting a tool emits a provider event, which touches the
  // heartbeat, so at kill time the tool's age is always at
  // least the heartbeat age that just exceeded the ceiling. Every genuinely
  // wedged tool was killed and then went dark with no accountability wake.
  const maxToolAgeMs =
    args.ceilingMs === undefined
      ? ABSOLUTE_CEILING_MS
      : Math.max(args.ceilingMs, ABSOLUTE_CEILING_MS) + SWEEP_INTERVAL_MS;
  if (!Number.isFinite(startedAt) || startedAt > args.now || args.now - startedAt > maxToolAgeMs) {
    return { action: 'none' };
  }
  if (args.priorToolAttempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS) return { action: 'none' };
  return { action: 'wake-accountable', reason: 'tool' };
}
