/**
 * Account-level rate-limit utilization samples (outbound.db, container-owned).
 *
 * Why this exists: the SDK's `rate_limit_event` is emitted ONLY when there is
 * something to warn about, so utilization readings existed only for accounts
 * already past ~84%. Live, exactly one agent group had any readings at all and
 * the heaviest group had none — no baseline, no trajectory. The `/usage`
 * control request (see providers/claude.ts) is a PULL and reports every
 * window for every account regardless.
 *
 * Shape rationale, `available` semantics, and the 0-1 utilization convention
 * are documented on RATE_LIMIT_SAMPLES_DDL in schema.ts.
 *
 * Claude and Codex (providers/codex-rate-limit-tracker.ts writes the Codex
 * rows through the same function). Nothing here covers OpenCode.
 */
import { getOutboundDb } from '../../mailbox/sqlite/connection.js';

/** Which capture path produced the row. Both are kept; the pull is primary. */
export type RateLimitSampleSource = 'usage_pull' | 'rate_limit_event';

/**
 * Who a sample is about. `account` alone is NOT an identity — the host
 * forwards a group's scoped tokens under the same unscoped `_N` slot names as
 * the global pool, so only the PAIR (credentialSet, account) names one
 * Anthropic account. See the caveat on RATE_LIMIT_SAMPLES_DDL.
 */
export interface AccountIdentity {
  /** OAuth ring slot name; null for API-key sessions. */
  account: string | null;
  /** 'global' | 'group:<folder>'; null when the host did not say. */
  credentialSet: string | null;
  /** Operator-declared lane for this slot; null when undeclared. */
  lane: string | null;
}

export interface RateLimitSample extends AccountIdentity {
  source: RateLimitSampleSource;
  subscriptionType: string | null;
  /** false = plan limits do not apply to this session (NOT an error). */
  available: boolean;
  limitType: string | null;
  /** 0-1 fraction, never 0-100. */
  utilization: number | null;
  resetsAt: string | null;
  status: string | null;
}

export interface RateLimitSampleRow {
  id: number;
  ts: string;
  source: string;
  account: string | null;
  credential_set: string | null;
  lane: string | null;
  subscription_type: string | null;
  available: number;
  limit_type: string | null;
  utilization: number | null;
  resets_at: string | null;
  status: string | null;
}

/**
 * Record one sample's rows. Never throws — this is telemetry, and a failure
 * here must never fail the turn it was sampled from.
 */
export function recordRateLimitSamples(samples: RateLimitSample[]): void {
  if (samples.length === 0) return;
  const ts = new Date().toISOString();
  try {
    // bun:sqlite requires the `$` prefix in the JS keys too (better-sqlite3
    // auto-strips it, bun:sqlite does not).
    const stmt = getOutboundDb().prepare(
      `INSERT INTO rate_limit_samples (ts, source, account, credential_set, lane, subscription_type, available, limit_type, utilization, resets_at, status)
       VALUES ($ts, $source, $account, $credential_set, $lane, $subscription_type, $available, $limit_type, $utilization, $resets_at, $status)`,
    );
    for (const s of samples) {
      stmt.run({
        $ts: ts,
        $source: s.source,
        $account: s.account ?? null,
        $credential_set: s.credentialSet ?? null,
        $lane: s.lane ?? null,
        $subscription_type: s.subscriptionType ?? null,
        $available: s.available ? 1 : 0,
        $limit_type: s.limitType ?? null,
        $utilization: s.utilization ?? null,
        $resets_at: s.resetsAt ?? null,
        $status: s.status ?? null,
      });
    }
  } catch (err) {
    console.error(`[rate-limit-samples] Failed to record sample: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** For tests/diagnostics — reads back all rows in insertion order. */
export function getRateLimitSampleRows(): RateLimitSampleRow[] {
  return getOutboundDb().prepare('SELECT * FROM rate_limit_samples ORDER BY id ASC').all() as RateLimitSampleRow[];
}
