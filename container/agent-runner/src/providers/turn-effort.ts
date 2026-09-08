/**
 * Reasoning-effort attribution for `turn_usage` rows.
 *
 * WHY THIS EXISTS. `turn_usage` records what the API BILLED — its `model`
 * column comes from the provider's own usage report, so it is a measurement.
 * Effort is the other half of a turn's configuration and it is a REQUEST
 * parameter: no provider bills it back, so nothing in the usage report can
 * confirm it. Without this, "did `ncl groups config update --effort` actually
 * reach the container" was only answerable by reading code — which is how a
 * class of silent config no-ops survived unnoticed across nine Claude groups
 * for months (fixed 2026-09-07, PRs #532/#540/#535). The model half of every
 * one of those claims was measured; the effort half was inferred.
 *
 * EFFECTIVE, NOT REQUESTED — and both, because they diverge. `effort` is the
 * value actually handed to the provider after its own clamp, which is the
 * number that describes what ran. `effort_requested` is what the resolution
 * chain produced BEFORE that clamp. They differ exactly where the clamp does
 * something: a Haiku turn resolves `high` from the group config and sends
 * nothing at all (Haiku has no effort control), and a `-e` value outside a
 * provider's vocabulary is dropped in favour of the sticky default. Recording
 * only the effective value would make those read identically to "no effort
 * was ever configured" — the very failure mode this column exists to catch.
 *
 * ATTRIBUTION RULE — one sentence, deliberately narrow:
 *
 *   Effort is attached to a usage entry only when that entry unambiguously
 *   represents the model the effort was resolved for.
 *
 * In practice:
 *
 *   - A turn with a SINGLE usage entry (every Codex and OpenCode turn, and
 *     every single-model Claude turn) — the entry IS the turn, so there is no
 *     other model for the value to be smeared onto. Attach.
 *   - A MULTI-ENTRY Claude turn (Opus parent + Sonnet/Haiku subagents; the SDK
 *     reports one `modelUsage` entry per model) — attach to the entry whose
 *     model id equals the model the query is currently running at, and leave
 *     every other entry NULL. We never set a subagent's effort
 *     (CLAUDE_CODE_SUBAGENT_MODEL is deliberately unset and no per-subagent
 *     effort is sent), so we cannot honestly claim one — and stamping the
 *     parent's `high` onto a Haiku subagent row, which supports no effort at
 *     all, would be a plausible-looking lie in the one place that must not
 *     carry them. A NULL here means "not attributable", not "no effort".
 *
 * The id comparison is exact, and that is safe because the SDK's `modelUsage`
 * keys are the strings WE sent: verified against the live central ledger,
 * where 2,924 rows carry `claude-opus-5[1m]` — a string that only exists
 * because `ensureOpus1mSuffix` constructed it. Where a match cannot be made
 * the column stays NULL, which under-claims rather than guessing.
 */
import type { TurnUsageInfo } from './types.js';

export interface TurnEffortAttribution {
  /**
   * The model this turn's effort was resolved for — the provider's own
   * currently-active model id, in the same spelling it hands to the API.
   * `null`/`undefined` when the provider has no concrete id, which makes a
   * multi-entry turn record NULL effort on every row.
   */
  model: string | null | undefined;
  /** Post-clamp value actually sent to the provider. NULL = deliberately none. */
  effective: string | null | undefined;
  /** Pre-clamp result of the effort resolution chain. */
  requested: string | null | undefined;
}

/**
 * Stamp `effort`/`effortRequested` onto a `result` event's usage payload.
 *
 * Pure: returns new objects and never mutates the provider's own. `undefined`
 * in (a provider that reported no usage this turn) is `undefined` out — the
 * absence of a usage report is not something to invent an effort row for.
 */
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
      : // Not the model the effort was resolved for. Explicit NULLs rather
        // than passthrough, so a provider cannot leak a value onto a row this
        // rule says is unattributable.
        { ...entry, effort: null, effortRequested: null },
  );
}
