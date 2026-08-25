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
 * Claude's and Codex's numeric fields are converted from a running-total
 * report into this turn's own delta before being written — see toTurnDelta
 * below for why, and the fix's dated comment for how inflated/deflated
 * pre-fix history is.
 */
import { getOutboundDb } from './connection.js';
import type { TurnUsageInfo } from '../providers/types.js';

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
}

/**
 * Turn-level metadata that doesn't vary per model even when a turn spans
 * several (see recordTurnUsage's caller in poll-loop.ts, which writes one
 * row per model but the same TurnMeta on each). `steps` coverage varies by
 * provider — see each provider's result-event construction — and is NULL
 * when the provider exposes nothing usable rather than a guessed count.
 * `rateLimit*` fields are Claude-only (see ProviderEvent's `result.rateLimit`
 * doc) — always NULL for the other two providers. `turnId` is generated once
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
 * Codex UNDERCOUNT fix (2026-08-25): the same transform is what Codex needs
 * too, in the other direction. `thread/tokenUsage/updated` fires once per
 * MODEL REQUEST and carries both `last` (that single request) and `total`
 * (running total for the thread). codex.ts recorded `last`, so a 66-step
 * turn was billed as its final request only — live `turn_usage` showed codex
 * at 66.5 steps/turn but 39 output tokens/turn against Claude's 2,597.
 * Confirmed against codex 0.145.0's own rollout log
 * (~/.codex/sessions/.../rollout-*.jsonl), where consecutive `token_count`
 * records give total.input 8,116,919 -> 8,244,310 -> 8,373,916 and
 * total.output 25,671 -> 25,827 -> 32,687, with each successive DIFFERENCE
 * (127,391 / 156 and 129,606 / 6,860) equal to that record's own `last`.
 * So `total` deltas are the per-turn number and `last` is one request of it.
 *
 * OpenCode is NOT this shape and must never be routed through here: its
 * assistant-message map is per-message, not cumulative (see opencode.ts's
 * result construction for the evidence), so it is summed at the provider
 * instead.
 *
 * Scope key (2026-08-25): the memo used to be keyed by model alone, so a
 * brand-new stream whose first report happened to land ABOVE the previous
 * stream's stored total was silently subtracted against an unrelated series.
 * Entries now carry the scope they were observed in and a scope change
 * forces a raw (unsubtracted) row.
 *
 * The scope is the provider's CONTINUATION (Claude SDK session id / Codex
 * thread id), not the stream, because the two providers reset their counters
 * at different boundaries: Claude's accumulator lives in the `query()` call
 * and restarts at zero on a new stream, while Codex's is a property of the
 * thread and a new app-server resuming that thread can carry the old total
 * forward. Continuation-keying is correct for both — a restart-at-zero shows
 * up as a decrease and is caught by the reset check below, whereas
 * stream-keying would re-record Codex's entire thread total as one turn.
 */
type CumulativeMemo = { scope: string; usage: TurnUsageInfo };
/** One entry per live counter — keyed per model or per scope, see CUMULATIVE_PROVIDERS. */
const lastCumulativeByCounter = new Map<string, CumulativeMemo>();

/**
 * Providers whose `result.usage` is a running total rather than one turn's
 * own, and whether that total is counted PER MODEL.
 *
 * Claude's SDK reports `modelUsage` — a separate running total per model, so
 * an Opus parent and a Sonnet subagent each need their own baseline. Codex's
 * `thread/tokenUsage/updated` reports ONE total for the whole thread with the
 * model as a mere label, so a mid-thread `-m` switch must keep subtracting
 * against the same baseline; keying it per model would re-record the entire
 * thread total as that turn's usage.
 */
const CUMULATIVE_PROVIDERS = new Map<string, { perModel: boolean }>([
  ['claude', { perModel: true }],
  ['codex', { perModel: false }],
]);

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
  const cumulative = CUMULATIVE_PROVIDERS.get(provider);
  const counterKey = cumulative ? (cumulative.perModel ? (usage.model ?? '') : '') : null;
  const effectiveUsage = counterKey === null ? usage : toTurnDelta(usage, scope, counterKey);
  try {
    // bun:sqlite requires named parameters to be passed with the prefix
    // character in the JS object keys (better-sqlite3 auto-stripped it,
    // bun:sqlite does not).
    getOutboundDb()
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, turn_id, steps, duration_ms, trigger, rate_limit_type, rate_limit_utilization, rate_limit_resets_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($ts, $provider, $model, $turn_id, $steps, $duration_ms, $trigger, $rate_limit_type, $rate_limit_utilization, $rate_limit_resets_at, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd)`,
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
