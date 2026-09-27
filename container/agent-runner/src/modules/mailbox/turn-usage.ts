/**
 * Per-turn token/cost accounting (outbound.db), one row per completed turn from poll-loop.ts's provider-agnostic
 * result seam. A row with NULL token columns still counts the turn, keeping coverage gaps visible. Column
 * names are a fixed contract with the host's usage_daily / turn_usage rollup: do not rename.
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
   * Effort EFFECTIVE (post-clamp) and REQUESTED (pre-clamp): request parameters, not billed measurements. Rows
   * before 2026-09-07 are NULL = not recorded, never "ran at no effort".
   */
  effort: string | null;
  effort_requested: string | null;
}

/**
 * Turn-level metadata written identically on each per-model row of a turn. `turnId` is shared by those rows,
 * so COUNT(DISTINCT turn_id) is the honest turn count (usage_daily's `turns` over-counts split turns).
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
 * Claude's SDK `modelUsage` is a RUNNING TOTAL for the whole SDK stream, and one stream serves many turns, so it
 * is converted to a per-turn delta here. turn_usage rows before 2026-08-24 are inflated by it.
 *
 * The memo is process-local and unpersisted: only a provider whose counter resets with the process may use it.
 * Codex's thread `total` survives a respawn (resumed thread) and would book the whole prior history as one
 * turn, so codex.ts sums per-request `last` instead. OpenCode is per-message and summed at the provider.
 * Entries carry the counter's scope; a scope change forces a raw row.
 */
type CumulativeMemo = { scope: string; usage: TurnUsageInfo };
/** One entry per live counter — keyed by model, see CUMULATIVE_PROVIDERS. */
const lastCumulativeByCounter = new Map<string, CumulativeMemo>();

/** Providers whose usage is a running total AND whose counter resets with this process. Keyed per model: each model has its own total. */
const CUMULATIVE_PROVIDERS = new Set(['claude']);

type Num = number | null | undefined;

/**
 * Running total -> this turn's delta. Reset detection is ONE decision per row: a scope change or ANY field
 * going down records every field raw (per-field decisions produced inconsistent rows). `curr === prev` is a
 * zero delta, not a reset. A null previous value falls back to raw for that field only. Pure: the caller
 * advances the baseline only after the row is written.
 */
function toTurnDelta(usage: TurnUsageInfo, scope: string, key: string): TurnUsageInfo {
  const memo = lastCumulativeByCounter.get(key);
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
 * A cumulative provider lists every model it has ever seen, so unused ones arrive as all-zero deltas and
 * would book phantom turns. Deliberately narrow: cumulative providers only, explicit zeros only (null keeps
 * the gap visible), and cost must be zero too (a zero-token row with real cost is real spend). The memo is
 * not advanced on a skip.
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
 * Never throws: a failure must not fail the turn it accounts for. `scope` identifies the running total's
 * series (the provider continuation). The baseline advances ONLY after the row is written, so a failed write's
 * tokens are absorbed by the next successful turn rather than lost.
 */
export function recordTurnUsage(
  provider: string,
  usage: TurnUsageInfo = {},
  meta: TurnMeta = NO_TURN_META,
  scope = '',
): void {
  const counterKey =
    usage.accounting?.kind !== 'per-turn' && CUMULATIVE_PROVIDERS.has(provider) ? (usage.model ?? '') : null;
  const counterScope = usage.accounting?.kind === 'cumulative' ? usage.accounting.scope : scope;
  const effectiveUsage = counterKey === null ? usage : toTurnDelta(usage, counterScope, counterKey);
  if (counterKey !== null && isUnusedModelEntry(effectiveUsage)) return;
  try {
    // bun:sqlite named params need the `$` prefix in the JS keys too.
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
        // Per-ROW from the untouched `usage`: effort is not a counter, so the delta transform must not touch it.
        $effort: usage.effort ?? null,
        $effort_requested: usage.effortRequested ?? null,
      });
  } catch (err) {
    console.error(`[turn-usage] Failed to record turn usage: ${err instanceof Error ? err.message : String(err)}`);
    return; // baseline stays put — the next successful turn absorbs this one's tokens
  }
  if (counterKey !== null) lastCumulativeByCounter.set(counterKey, { scope: counterScope, usage });
}

/** For tests/diagnostics — reads back all rows in insertion order. */
export function getTurnUsageRows(): TurnUsageRow[] {
  return getOutboundDb().prepare('SELECT * FROM turn_usage ORDER BY id ASC').all() as TurnUsageRow[];
}
