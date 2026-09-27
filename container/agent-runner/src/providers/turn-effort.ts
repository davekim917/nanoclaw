/**
 * Reasoning-effort attribution for `turn_usage` rows. Effort is a request parameter no provider bills back, so
 * it is stamped here: `effort` is the post-clamp value sent, `effortRequested` the pre-clamp resolution. They
 * diverge where the clamp acts (a Haiku turn sends none), and recording only one would hide that.
 *
 * Attach effort only to a usage entry that unambiguously represents the model it was resolved for. On a
 * multi-model Claude turn only the entry whose id equals the query's current model gets it; subagent rows stay
 * NULL, meaning "not attributable", not "no effort". The exact id match is safe because `modelUsage` keys are the
 * strings we sent.
 */
import type { TurnUsageInfo } from './types.js';

export interface TurnEffortAttribution {
  /** Same spelling the provider sends the API; nullish makes every row of a multi-entry turn NULL. */
  model: string | null | undefined;
  /** Post-clamp value actually sent to the provider. NULL = deliberately none. */
  effective: string | null | undefined;
  /** Pre-clamp result of the effort resolution chain. */
  requested: string | null | undefined;
}

/** Pure: never mutates the provider's objects. `undefined` usage stays `undefined`: no report, no effort row. */
export function attachTurnEffort(
  usage: TurnUsageInfo | TurnUsageInfo[] | undefined,
  attribution: TurnEffortAttribution,
): TurnUsageInfo | TurnUsageInfo[] | undefined {
  if (usage === undefined) return undefined;
  const effort = attribution.effective ?? null;
  const effortRequested = attribution.requested ?? null;
  if (!Array.isArray(usage)) return { ...usage, effort, effortRequested };
  const target = attribution.model ?? null;
  return usage.map((entry) =>
    target !== null && entry.model === target
      ? { ...entry, effort, effortRequested }
      : // Explicit NULLs so a provider cannot leak a value onto an unattributable row.
        { ...entry, effort: null, effortRequested: null },
  );
}
