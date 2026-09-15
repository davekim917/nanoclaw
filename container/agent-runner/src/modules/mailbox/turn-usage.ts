/**
 * Per-turn token/cost accounting (outbound.db, container-owned).
 *
 * One row per completed turn, written from the provider-agnostic result
 * seam in poll-loop.ts (see processQuery's `event.type === 'result'`
 * handling) — every provider's query converges there, so this is the one
 * place the write happens regardless of which provider ran. Coverage varies
 * by provider (see providers/types.ts TurnUsageInfo); a row with NULL token
 * columns still counts the turn and keeps the gap visible instead of
 * silently dropping it.
 *
 * Fleet-hardening Phase 0.1 (per-turn usage accounting). The host
 * sweep rolls these rows up into a central `usage_daily` table — schema is
 * fixed by that contract, do not rename columns here.
 *
 * `steps`/`duration_ms`/`trigger` (Phase 0.1 follow-up, per-turn cost
 * attribution) are also mirrored 1:1 into a central `turn_usage` ledger by
 * the same host sweep (src/db/usage.ts) — a fat-context turn and a
 * long-loop turn look identical in usage_daily's daily bucket, and steps is
 * the number that tells them apart. See TurnMeta below.
 *
 * Claude's numeric fields are converted from a running-total report into this
 * turn's own delta before being written — see toTurnDelta below for why, and
 * the fix's dated comment for how inflated pre-fix history is. Codex and
 * OpenCode already report per-turn figures and are written as they arrive.
 */
import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import type { TurnUsageInfo } from '../../providers/types.js';

export interface TurnUsageRow {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  turn_id: string | null;
  steps: number | null;
  duration_ms: number | null;
  trigger: string | null;
  rate_limit_type: string | null;
  rate_limit_utilization: number | null;
  rate_limit_resets_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  /**
   * Reasoning effort, EFFECTIVE (post-clamp) and as REQUESTED (pre-clamp).
   * Unlike every other column these are request parameters, not billed
   * measurements — the provider stamps them onto the usage entry it emits
   * (providers/turn-effort.ts), and a row whose model the effort was not
   * resolved for keeps NULL rather than borrowing the turn's value.
   *
   * CUTOFF: the columns landed 2026-09-07 and no backfill is possible — the
   * data never existed. Every row written before then is NULL, which means
   * "not recorded", not "ran at no effort". Do not read pre-cutoff NULLs as a
   * measurement of anything.
   */
  effort: string | null;
  effort_requested: string | null;
}

/**
 * Turn-level metadata that doesn't vary per model even when a turn spans
 * several (see recordTurnUsage's caller in poll-loop.ts, which writes one
 * row per model but the same TurnMeta on each). `steps` coverage varies by
 * provider — see each provider's result-event construction — and is NULL
 * when the provider exposes nothing usable rather than a guessed count.
 * `rateLimit*` fields are set by Claude and Codex (see ProviderEvent's
 * `result.rateLimit` doc) — always NULL for OpenCode. `turnId` is generated once
 * per `result` event (poll-loop.ts, outside the per-model recordTurnUsage
 * loop) so every row a multi-model turn produces shares it — the honest
 * denominator for "how many turns actually happened", since usage_daily's
 * `turns` column over-counts by one per extra model on a split turn.
 */
export interface TurnMeta {
  turnId: string | null;
  steps: number | null;
  durationMs: number | null;
  trigger: string | null;
  rateLimitType: string | null;
  rateLimitUtilization: number | null;
  rateLimitResetsAt: string | null;
}

const NO_TURN_META: TurnMeta = {
  turnId: null,
  steps: null,
  durationMs: null,
  trigger: null,
  rateLimitType: null,
  rateLimitUtilization: null,
  rateLimitResetsAt: null,
};

/**
 * Cumulative-usage bug fix (2026-08-24): the Claude Agent SDK's
 * `result.usage`/`modelUsage` is a RUNNING TOTAL FOR THE WHOLE SDK STREAM,
 * not a per-turn amount — and one stream serves MANY turns (poll-loop.ts
 * keeps the generator open across follow-up pushes; see the comment at its
 * `event.type === 'result'` handling). Recording it as-is on every `result`
 * re-recorded the same growing total every turn, inflating usage_daily's
 * SUM by 1.3-5.2x (verified empirically 2026-08-24 across 137 sessions; 32
 * (session, model) series >=85% strictly increasing, e.g. one series:
 * 887,166 -> 11,317,363 -> ... -> 86,353,143 cache-read tokens). turn_usage
 * rows written BEFORE this fix landed are inflated by that much — do not
 * read pre-fix history as clean.
 *
 * This memo is PROCESS-LOCAL and unpersisted, which is what decides who may
 * use it. Claude qualifies: its accumulator lives inside the `query()` call,
 * so a fresh container starts a fresh stream at zero and there is no
 * pre-restart total to mis-subtract. A provider whose counter OUTLIVES the
 * process must never be routed here — see the codex note below.
 *
 * Codex was briefly on this path (2026-08-25) and was removed the next day.
 * Its `thread/tokenUsage/updated` carries both `last` (one model request) and
 * `total` (the whole thread), and `total` survives a container respawn:
 * poll-loop.ts resumes the persisted thread, the new app-server replays the
 * carried-forward total, and an empty memo makes toTurnDelta return it RAW —
 * booking the entire pre-restart thread history as one turn. The reset check
 * cannot catch that, because the value went UP. codex.ts now sums `last`
 * across the turn instead, which depends on nothing outside the turn. The
 * `total`-delta reading was still arithmetically right — codex 0.145.0's
 * rollout log gives total.input 8,116,919 -> 8,244,310 -> 8,373,916 with each
 * successive difference equal to that record's own `last` — it was just not
 * restart-safe.
 *
 * OpenCode is NOT this shape either: its assistant-message map is per-message,
 * not cumulative (see opencode.ts's result construction), so it is likewise
 * summed at the provider.
 *
 * Scope key (2026-08-25): the memo used to be keyed by model alone, so a
 * brand-new stream whose first report happened to land ABOVE the previous
 * stream's stored total was silently subtracted against an unrelated series.
 * Entries now carry the scope they were observed in and a scope change
 * forces a raw (unsubtracted) row. The scope is the provider's CONTINUATION
 * (Claude's SDK session id), not the stream object, so a same-session
 * restart-at-zero shows up as a decrease and is caught by the reset check.
 */
type CumulativeMemo = { scope: string; usage: TurnUsageInfo };
/** One entry per live counter — keyed by model, see CUMULATIVE_PROVIDERS. */
const lastCumulativeByCounter = new Map<string, CumulativeMemo>();

/**
 * Providers whose `result.usage` is a running total rather than one turn's
 * own, AND whose counter resets when this process does. Both halves are
 * required — see the block above for why codex satisfies the first and fails
 * the second.
 *
 * Keyed per model because Claude's SDK reports `modelUsage`, a separate
 * running total per model: an Opus parent and a Sonnet subagent each need
 * their own baseline.
 */
const CUMULATIVE_PROVIDERS = new Set(['claude']);

type Num = number | null | undefined;

/**
 * Convert one model's running total into this turn's own delta.
 *
 * Reset detection is ONE decision for the whole row, not per field: if the
 * scope changed, or ANY field went down from the last-seen value, the
 * provider restarted its counter and every field is recorded raw. Deciding
 * per field produced internally inconsistent rows — a stream boundary
 * reporting `{in 900k, out 600}` after `{in 1M, out 500}` took input raw
 * (reset detected) but output as a 100-token delta, in the same row.
 *
 * `curr === prev` is a delta of 0, deliberately, and NOT a reset: an
 * unchanged running total means the turn consumed none of that field
 * (cache-write sits at 0 for whole sessions). Recording the raw value there
 * would re-bill the entire prior total as this turn's usage.
 *
 * A field whose PREVIOUS value is null has no baseline to subtract, so it
 * falls back to raw on its own — that is a missing baseline, not a reset,
 * and forcing the whole row raw for it would make every Codex row raw
 * (`costUsd` is permanently null there).
 *
 * PURE — it reads the memo but never advances it. The caller advances the
 * baseline only after the row is actually written; see recordTurnUsage.
 */
function toTurnDelta(usage: TurnUsageInfo, scope: string, key: string): TurnUsageInfo {
  const memo = lastCumulativeByCounter.get(key);
  // First observation for this counter, or a different stream/thread — no
  // comparable baseline, so nothing to subtract.
  if (!memo || memo.scope !== scope) return usage;

  const last = memo.usage;
  const fields: [Num, Num][] = [
    [usage.inputTokens, last.inputTokens],
    [usage.outputTokens, last.outputTokens],
    [usage.cacheReadTokens, last.cacheReadTokens],
    [usage.cacheWriteTokens, last.cacheWriteTokens],
    [usage.costUsd, last.costUsd],
  ];
  const counterReset = fields.some(([curr, prev]) => curr != null && prev != null && curr < prev);
  if (counterReset) return usage;

  const delta = (curr: Num, prev: Num): Num => (curr == null || prev == null ? curr : curr - prev);

  return {
    ...usage,
    inputTokens: delta(usage.inputTokens, last.inputTokens),
    outputTokens: delta(usage.outputTokens, last.outputTokens),
    cacheReadTokens: delta(usage.cacheReadTokens, last.cacheReadTokens),
    cacheWriteTokens: delta(usage.cacheWriteTokens, last.cacheWriteTokens),
    costUsd: delta(usage.costUsd, last.costUsd),
  };
}

/**
 * Phantom-model fix (2026-08-25): a cumulative provider reports its running
 * total for EVERY model it has ever seen in the continuation, not just the
 * ones this turn used — so a turn that only ran Opus still produced a
 * `modelUsage` entry for the Haiku a subagent used ten turns ago, whose
 * delta is zero across the board. Written as a row, that reads as "a turn
 * touched Haiku": measured live, 11 of 13 Haiku rows and 18 of 93 Sonnet
 * rows were all-zero, making Haiku's turn count ~85% phantom.
 *
 * The condition catches exactly the "listed but unused" case, and is
 * deliberately narrow on three axes:
 *
 *   - Cumulative providers only. A zero from OpenCode is a real reading from
 *     a per-message map (it is summed at the provider, never deltaed here),
 *     so it means "this turn genuinely consumed nothing measurable" and stays
 *     recorded — a provider coverage gap must stay visible, not get tidied
 *     away. Live, one such OpenCode turn exists.
 *   - Explicit zeros only. A field the provider never reported arrives as
 *     null/undefined, not 0; such a row still counts the turn and keeps the
 *     gap visible, which is the documented contract at the top of this file.
 *   - Cost must be zero too. Live data has a Claude row with all four token
 *     fields at an explicit 0 and cost_usd 2.25 — a real turn whose token
 *     counters were missed. Dropping it would delete $2.25 of spend from the
 *     ledger.
 *
 * The memo is deliberately NOT advanced on a skip: for the delta path the
 * totals are unchanged so advancing is a no-op, and for the raw path
 * (first observation / counter reset) leaving the older baseline in place
 * still yields the right answer on the next turn — either it is a fresh
 * series with no baseline, or the next value is below the stored one and the
 * existing reset check fires again.
 */
function isUnusedModelEntry(usage: TurnUsageInfo): boolean {
  const zero = (v: Num): boolean => v === 0;
  return (
    zero(usage.inputTokens) &&
    zero(usage.outputTokens) &&
    zero(usage.cacheReadTokens) &&
    zero(usage.cacheWriteTokens) &&
    (usage.costUsd == null || usage.costUsd === 0)
  );
}

/** Test-only: clear the cumulative-tracking state between cases. */
export function _resetCumulativeTrackingForTesting(): void {
  lastCumulativeByCounter.clear();
}

/**
 * Record one turn's usage. Never throws — a failure here must never fail
 * the turn it's accounting for, so errors are logged and swallowed.
 *
 * `scope` identifies the accounting series the running total belongs to —
 * the provider continuation, from poll-loop.ts. Omitted (tests, callers with
 * no continuation yet) it degrades to a single implicit series, which is the
 * pre-2026-08-25 behavior.
 *
 * Silent-token-loss fix (2026-08-25): the delta baseline is advanced ONLY
 * after the row is written. It used to advance before the INSERT, whose
 * errors this function deliberately swallows — so a failed write moved the
 * baseline past tokens that were never recorded, and every later turn
 * subtracted against the advanced baseline. Those tokens were permanently
 * and invisibly gone. Leaving the baseline put makes the next successful
 * turn absorb the failed turn's usage instead.
 */
export function recordTurnUsage(
  provider: string,
  usage: TurnUsageInfo = {},
  meta: TurnMeta = NO_TURN_META,
  scope = '',
): void {
  const counterKey = CUMULATIVE_PROVIDERS.has(provider) ? (usage.model ?? '') : null;
  const effectiveUsage = counterKey === null ? usage : toTurnDelta(usage, scope, counterKey);
  // See isUnusedModelEntry: a cumulative provider lists every model of the
  // continuation on every turn, and the ones it didn't use come through with
  // a zero delta. Booking those as turns makes a model's usage mostly phantom.
  if (counterKey !== null && isUnusedModelEntry(effectiveUsage)) return;
  try {
    // bun:sqlite requires named parameters to be passed with the prefix
    // character in the JS object keys (better-sqlite3 auto-stripped it,
    // bun:sqlite does not).
    getOutboundDb()
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, turn_id, steps, duration_ms, trigger, rate_limit_type, rate_limit_utilization, rate_limit_resets_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, effort, effort_requested)
         VALUES ($ts, $provider, $model, $turn_id, $steps, $duration_ms, $trigger, $rate_limit_type, $rate_limit_utilization, $rate_limit_resets_at, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd, $effort, $effort_requested)`,
      )
      .run({
        $ts: new Date().toISOString(),
        $provider: provider,
        $model: effectiveUsage.model ?? null,
        $turn_id: meta.turnId ?? null,
        $steps: meta.steps ?? null,
        $duration_ms: meta.durationMs ?? null,
        $trigger: meta.trigger ?? null,
        $rate_limit_type: meta.rateLimitType ?? null,
        $rate_limit_utilization: meta.rateLimitUtilization ?? null,
        $rate_limit_resets_at: meta.rateLimitResetsAt ?? null,
        $input_tokens: effectiveUsage.inputTokens ?? null,
        $output_tokens: effectiveUsage.outputTokens ?? null,
        $cache_read_tokens: effectiveUsage.cacheReadTokens ?? null,
        $cache_write_tokens: effectiveUsage.cacheWriteTokens ?? null,
        $cost_usd: effectiveUsage.costUsd ?? null,
        // Per-ROW, not per-turn: the provider already decided which of a
        // multi-model turn's entries may claim this value and left the rest
        // NULL (providers/turn-effort.ts). Read off the untouched `usage`
        // rather than `effectiveUsage` — effort is not a counter, so the
        // delta transform has no business anywhere near it.
        $effort: usage.effort ?? null,
        $effort_requested: usage.effortRequested ?? null,
      });
  } catch (err) {
    console.error(`[turn-usage] Failed to record turn usage: ${err instanceof Error ? err.message : String(err)}`);
    return; // baseline stays put — the next successful turn absorbs this one's tokens
  }
  if (counterKey !== null) lastCumulativeByCounter.set(counterKey, { scope, usage });
}

/** For tests/diagnostics — reads back all rows in insertion order. */
export function getTurnUsageRows(): TurnUsageRow[] {
  return getOutboundDb().prepare('SELECT * FROM turn_usage ORDER BY id ASC').all() as TurnUsageRow[];
}
