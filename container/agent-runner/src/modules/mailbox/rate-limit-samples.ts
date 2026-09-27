/**
 * Account-level rate-limit samples (outbound.db). Semantics are documented on RATE_LIMIT_SAMPLES_DDL in
 * schema.ts. Claude and Codex only; nothing covers OpenCode.
 */
import { getOutboundDb } from '../../mailbox/sqlite/connection.js';

/** Capture path. Claude `usage_pull` rows are old: its `/api/oauth/usage` pull needs a scope its tokens lack. */
export type RateLimitSampleSource = 'usage_pull' | 'rate_limit_event' | 'rate_limit_headers';

/** Only the PAIR (credentialSet, account) names one account: scoped tokens reuse the global pool's `_N` names. */
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

/** Never throws: telemetry must not fail the turn it was sampled from. */
export function recordRateLimitSamples(samples: RateLimitSample[]): void {
  if (samples.length === 0) return;
  const ts = new Date().toISOString();
  try {
    // bun:sqlite needs the `$` prefix in the JS keys too.
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
