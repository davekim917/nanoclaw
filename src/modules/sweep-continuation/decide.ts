/**
 * Kept free of top-level side effects and of eager reads from host-sweep.ts:
 * host-sweep.ts re-exports this, and index.ts's import-time registration would
 * run inside host-sweep's import cycle while its registry consts are in TDZ.
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
   * The ceiling that actually fired; supply it ONLY from the kill path (it adds
   * one sweep interval of detection lag). Live-state callers omit it.
   */
  ceilingMs?: number;
}): CeilingFollowUp {
  if (args.hasContinuation) return { action: 'wake-accountable', reason: 'continuation' };
  if (!args.currentTool || !args.toolStartedAt) return { action: 'none' };
  const startedAt = parseSqliteUtc(args.toolStartedAt);
  // Bound against the ceiling that fired plus one sweep of lag: bounding
  // against ABSOLUTE_CEILING_MS alone made this branch unreachable, since a
  // tool's age at kill time is always at least the heartbeat age.
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
