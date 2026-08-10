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
 */
import { getOutboundDb } from './connection.js';
import type { TurnUsageInfo } from '../providers/types.js';

export interface TurnUsageRow {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

/**
 * Record one turn's usage. Never throws — a failure here must never fail
 * the turn it's accounting for, so errors are logged and swallowed.
 */
export function recordTurnUsage(provider: string, usage: TurnUsageInfo = {}): void {
  try {
    // bun:sqlite requires named parameters to be passed with the prefix
    // character in the JS object keys (better-sqlite3 auto-stripped it,
    // bun:sqlite does not).
    getOutboundDb()
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($ts, $provider, $model, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd)`,
      )
      .run({
        $ts: new Date().toISOString(),
        $provider: provider,
        $model: usage.model ?? null,
        $input_tokens: usage.inputTokens ?? null,
        $output_tokens: usage.outputTokens ?? null,
        $cache_read_tokens: usage.cacheReadTokens ?? null,
        $cache_write_tokens: usage.cacheWriteTokens ?? null,
        $cost_usd: usage.costUsd ?? null,
      });
  } catch (err) {
    console.error(`[turn-usage] Failed to record turn usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** For tests/diagnostics — reads back all rows in insertion order. */
export function getTurnUsageRows(): TurnUsageRow[] {
  return getOutboundDb().prepare('SELECT * FROM turn_usage ORDER BY id ASC').all() as TurnUsageRow[];
}
