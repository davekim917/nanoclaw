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
 * Claude's numeric fields are converted from the SDK's stream-cumulative
 * report into this turn's own delta before being written — see
 * toClaudeTurnDelta below for why, and the fix's dated comment for how
 * inflated pre-fix history is.
 */
import { getOutboundDb } from './connection.js';
import type { TurnUsageInfo } from '../providers/types.js';

export interface TurnUsageRow {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  steps: number | null;
  duration_ms: number | null;
  trigger: string | null;
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
 */
export interface TurnMeta {
  steps: number | null;
  durationMs: number | null;
  trigger: string | null;
}

const NO_TURN_META: TurnMeta = { steps: null, durationMs: null, trigger: null };

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
 * Codex's `tokenUsage.last` (see codex.ts's CodexTokenUsageBreakdown) and
 * OpenCode's per-turn assistant-message map are NOT this shape — both
 * already report one turn's own usage (verified by reading each provider's
 * source: Codex's own field name distinguishes a running total from `last`;
 * OpenCode's map is a fresh `const` scoped inside its per-turn loop
 * iteration). Applying this transform to them would corrupt already-correct
 * data, so it's gated to `provider === 'claude'` below.
 */
const lastClaudeCumulativeByModel = new Map<string, TurnUsageInfo>();

/**
 * Convert one model's cumulative SDK report into this turn's own delta.
 * A field going DOWN from the last-seen value for that model is the reset
 * signal — a new SDK stream started below the old running total. Checked
 * per-field (not one combined signal) so an unrelated field's blip can't
 * corrupt the others. Falls back to the raw value whenever either side is
 * null — a real delta needs both numbers.
 */
function toClaudeTurnDelta(usage: TurnUsageInfo): TurnUsageInfo {
  const key = usage.model ?? '';
  const last = lastClaudeCumulativeByModel.get(key);
  lastClaudeCumulativeByModel.set(key, usage);
  if (!last) return usage; // first observation for this model — nothing to subtract yet

  const delta = (curr: number | null | undefined, prev: number | null | undefined): number | null | undefined =>
    curr == null || prev == null || curr < prev ? curr : curr - prev;

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
export function _resetClaudeCumulativeTrackingForTesting(): void {
  lastClaudeCumulativeByModel.clear();
}

/**
 * Record one turn's usage. Never throws — a failure here must never fail
 * the turn it's accounting for, so errors are logged and swallowed.
 */
export function recordTurnUsage(provider: string, usage: TurnUsageInfo = {}, meta: TurnMeta = NO_TURN_META): void {
  const effectiveUsage = provider === 'claude' ? toClaudeTurnDelta(usage) : usage;
  try {
    // bun:sqlite requires named parameters to be passed with the prefix
    // character in the JS object keys (better-sqlite3 auto-stripped it,
    // bun:sqlite does not).
    getOutboundDb()
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, steps, duration_ms, trigger, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($ts, $provider, $model, $steps, $duration_ms, $trigger, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd)`,
      )
      .run({
        $ts: new Date().toISOString(),
        $provider: provider,
        $model: effectiveUsage.model ?? null,
        $steps: meta.steps ?? null,
        $duration_ms: meta.durationMs ?? null,
        $trigger: meta.trigger ?? null,
        $input_tokens: effectiveUsage.inputTokens ?? null,
        $output_tokens: effectiveUsage.outputTokens ?? null,
        $cache_read_tokens: effectiveUsage.cacheReadTokens ?? null,
        $cache_write_tokens: effectiveUsage.cacheWriteTokens ?? null,
        $cost_usd: effectiveUsage.costUsd ?? null,
      });
  } catch (err) {
    console.error(`[turn-usage] Failed to record turn usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** For tests/diagnostics — reads back all rows in insertion order. */
export function getTurnUsageRows(): TurnUsageRow[] {
  return getOutboundDb().prepare('SELECT * FROM turn_usage ORDER BY id ASC').all() as TurnUsageRow[];
}
