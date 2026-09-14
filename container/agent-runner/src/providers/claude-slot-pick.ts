/**
 * Usage-maximizing OAuth slot pick (quota-burn plan item 0.6, operator-directed
 * 2026-09-14).
 *
 * Problem: the ring in providers/claude.ts starts every fresh session at
 * position 0 and advances only on a rate-limit failure, and `/usage` was
 * pulled only for the ACTIVE slot. Groups sharing a credential set therefore
 * exhausted slots in lockstep while idle slots went dark (slot 1 last sampled
 * 09-09). Measured 2026-09-14T14:00Z: four slots at 76-88% weekly, `_6` at
 * 18% with five sessions piled on it.
 *
 * Objective: every slot reaches its weekly reset at ~100% used. So at session
 * start (fresh AND resume) pull `/usage` for EVERY slot, record a sample row
 * per slot per window, and pick the slot with the HIGHEST `seven_day`
 * utilization that is still below 1.0 — drain the most-used account first,
 * because a slot at 88% resetting in 14h is 12% of free quota that a
 * lowest-first rule would leave on the table. Tiebreak: highest `five_hour`
 * below 1.0. Hitting 100% mid-session is handled by the existing in-turn
 * rotate-and-retry (poll-loop.ts, claude.ts `rotateApiKey`).
 *
 * Why a direct HTTP pull and not the SDK control request: the SDK's
 * `get_usage` is answered by the CLI subprocess of a RUNNING query, under
 * that query's own token (sdk.mjs:221 hands `env:rn` to the spawned CLI). To
 * read a slot that is not active we would have to spawn a CLI per slot. The
 * CLI itself answers `get_usage` by fetching `GET /api/oauth/usage` with
 * `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` and
 * passing the body through as `rate_limits` (CLI 2.1.270 bundle: `YD` builds
 * the request, `J5e` returns `rate_limits: d===null?null:...d`), so one
 * fetch per slot yields exactly the object `usageResponseToSamples` already
 * consumes. The container reaches api.anthropic.com directly: the host adds
 * it to NO_PROXY when forwarding OAuth slots (src/container-runner.ts, the
 * "OAuth path" block near `hostOauth`).
 *
 * Pure functions only. `fetchSlotUsage` takes its fetch as a parameter so
 * tests never touch the network (test-hermeticity.ts trips on global fetch).
 */
import type { RateLimitSample } from '../modules/mailbox/index.js';

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Structural mirror of the CLI's `get_usage` response — only what we read. */
export interface OauthUsageWindow {
  /** Percentage 0-100. */
  utilization?: number | null;
  resets_at?: string | null;
}
export interface OauthUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, OauthUsageWindow | null | undefined> | null;
}

export interface FetchSlotUsageOptions {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  url?: string;
}

/**
 * One `/api/oauth/usage` round-trip authenticated as `token`. Rejects on a
 * non-2xx status, a non-object body, or the deadline; the caller records a
 * rejection as "unsampled" (no row), which is distinct from the
 * `available: false` row that means "plan limits do not apply".
 *
 * `subscription_type` is null here: the CLI derives it from the OAuth
 * profile, not from this endpoint, and the pick does not need it.
 */
export async function fetchSlotUsage(token: string, opts: FetchSlotUsageOptions): Promise<OauthUsageResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(opts.url ?? OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`usage pull HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('usage pull returned a non-object body');
    }
    return {
      subscription_type: null,
      rate_limits_available: true,
      rate_limits: body as Record<string, OauthUsageWindow | null | undefined>,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One ring slot's pull outcome. `samples: null` means the pull failed (unsampled). */
export interface SlotUsageReading {
  name: string;
  samples: RateLimitSample[] | null;
}

export type SlotSkipReason =
  | 'unsampled'
  | 'not_applicable'
  | 'no_seven_day'
  | 'seven_day_exhausted'
  | 'five_hour_exhausted';

export interface SlotRanking {
  name: string;
  sevenDay: number | null;
  fiveHour: number | null;
  skipped: SlotSkipReason | null;
}

export interface SlotPick {
  /** Slot name to run on, or null when no slot is eligible (caller keeps today's behaviour). */
  chosen: string | null;
  /** Every slot in ring order, for the log line. */
  ranking: SlotRanking[];
}

function windowUtilization(samples: RateLimitSample[], limitType: string): number | null {
  const row = samples.find((s) => s.limitType === limitType);
  return row && typeof row.utilization === 'number' ? row.utilization : null;
}

/**
 * The rule. Utilizations are the 0-1 fractions the sample rows carry.
 *
 * Eligible: sampled, plan limits apply, `seven_day` present and < 1.0, and
 * `five_hour` (when reported) < 1.0. The five-hour exclusion is not in the
 * plan row's wording, but a slot whose five-hour window is already full
 * 429s on its first request and the in-turn rotation then moves to ring
 * position +1 — not to the next-best slot by usage — so choosing it can only
 * cost a failed turn. Flagged in the PR for veto.
 *
 * Order: `seven_day` desc, then `five_hour` desc (an unreported five-hour
 * window sorts as 0), then ring order — deterministic on exact ties.
 */
export function pickSlotByUsage(readings: SlotUsageReading[]): SlotPick {
  const ranking: SlotRanking[] = readings.map(({ name, samples }) => {
    if (samples === null) return { name, sevenDay: null, fiveHour: null, skipped: 'unsampled' };
    if (samples.some((s) => s.available === false)) {
      return { name, sevenDay: null, fiveHour: null, skipped: 'not_applicable' };
    }
    const sevenDay = windowUtilization(samples, 'seven_day');
    const fiveHour = windowUtilization(samples, 'five_hour');
    if (sevenDay === null) return { name, sevenDay, fiveHour, skipped: 'no_seven_day' };
    if (sevenDay >= 1) return { name, sevenDay, fiveHour, skipped: 'seven_day_exhausted' };
    if (fiveHour !== null && fiveHour >= 1) return { name, sevenDay, fiveHour, skipped: 'five_hour_exhausted' };
    return { name, sevenDay, fiveHour, skipped: null };
  });

  const eligible = ranking
    .map((r, ringIndex) => ({ r, ringIndex }))
    .filter(({ r }) => r.skipped === null)
    .sort((a, b) => {
      const seven = (b.r.sevenDay ?? 0) - (a.r.sevenDay ?? 0);
      if (seven !== 0) return seven;
      const five = (b.r.fiveHour ?? 0) - (a.r.fiveHour ?? 0);
      if (five !== 0) return five;
      return a.ringIndex - b.ringIndex;
    });

  return { chosen: eligible[0]?.r.name ?? null, ranking };
}

const pct = (v: number | null): string => (v === null ? '?' : `${Math.round(v * 100)}%`);

/** One line per ring for the container log: `TOKEN_2 7d=87% 5h=12% · TOKEN_4 7d=100% 5h=3% skipped:seven_day_exhausted`. */
export function formatSlotRanking(ranking: SlotRanking[]): string {
  return ranking
    .map((r) => `${r.name} 7d=${pct(r.sevenDay)} 5h=${pct(r.fiveHour)}${r.skipped ? ` skipped:${r.skipped}` : ''}`)
    .join(' · ');
}
