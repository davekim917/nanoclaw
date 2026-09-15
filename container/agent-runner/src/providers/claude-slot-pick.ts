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
 * start (fresh AND resume) read plan utilization for EVERY slot, record a
 * sample row per slot per window, and pick the slot with the HIGHEST
 * `seven_day` utilization that is still below 1.0 — drain the most-used
 * account first, because a slot at 88% resetting in 14h is 12% of free quota
 * that a lowest-first rule would leave on the table. Tiebreak: highest
 * `five_hour` below 1.0. Hitting 100% mid-session is handled by the existing
 * in-turn rotate-and-retry (poll-loop.ts, claude.ts `rotateApiKey`).
 *
 * WHERE THE READINGS COME FROM. #811 shipped this as one direct
 * `GET /api/oauth/usage` per slot, issued from here at every session start.
 * That is once per container boot, so each token saw a request rate equal to
 * the fleet's Claude session-start rate and the endpoint started answering
 * `429 rate_limit_error` for every slot at once (measured 2026-09-15 03:53Z,
 * `retry-after: 3166`). No throttle inside a container can fix a per-identity
 * limit driven by how many containers start, so the HOST now surveys on its
 * own clock and hands each spawn the readings in `NANOCLAW_SLOT_USAGE_SURVEY`
 * (`src/slot-usage-survey.ts`). This module parses that and picks; it makes no
 * network call at all, and a missing or stale survey degrades to
 * "unsampled" — the pre-0.6 behaviour of keeping the restored slot.
 *
 * Why a direct HTTP pull rather than the SDK control request, host-side or
 * otherwise: the SDK's `get_usage` is answered by the CLI subprocess of a
 * RUNNING query, under that query's own token (sdk.mjs:221 hands `env:rn` to
 * the spawned CLI). To read a slot that is not active we would have to spawn a
 * CLI per slot. The CLI itself answers `get_usage` by fetching
 * `GET /api/oauth/usage` with `Authorization: Bearer <token>` +
 * `anthropic-beta: oauth-2025-04-20` and passing the body through as
 * `rate_limits` (CLI 2.1.270 bundle: `YD` builds the request, `J5e` returns
 * `rate_limits: d===null?null:...d`), so one fetch per slot yields exactly the
 * object `usageResponseToSamples` already consumes.
 *
 * Pure functions only — no IO, no clock of its own.
 */
import type { RateLimitSample } from '../modules/mailbox/index.js';

// Headroom left on a slot so the in-flight turn can finish before the wall. A wall mid-turn aborts and replays the whole query (SDK snapshots the token at spawn — see PR #811 body), which costs more than 5% of a weekly slot. Tune from measurement: slots resetting under 90% used → tighten; mid-turn walls still >2/day → widen.
export const SLOT_PICK_HEADROOM = 0.05;

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

/** The env variable the host fills with its survey (`src/slot-usage-survey.ts`). */
export const SLOT_USAGE_SURVEY_ENV = 'NANOCLAW_SLOT_USAGE_SURVEY';

/**
 * How old a host reading may be and still steer the pick.
 *
 * The host refreshes each slot every 10 minutes, but parks a slot for as long
 * as the server's own `retry-after` when it is rate limited (~53 minutes
 * observed). Past this age a reading stops being evidence: the slot is
 * reported `unsampled`, the pick ignores it, and with nothing left the session
 * keeps the slot it restored. Under-reading is the safe direction anyway —
 * utilization only climbs inside a window, so a stale number can only make us
 * pick a slot LESS eagerly than it deserves, and a slot that crossed the wall
 * since is caught by the in-turn rotate-and-retry.
 */
export const SLOT_USAGE_SURVEY_MAX_AGE_MS = 45 * 60_000;

/** One slot's reading as the host serializes it. `utilization` is 0-100, as the endpoint reports it. */
export interface SlotUsageSurveyEntry {
  fetchedAt: string;
  rateLimits: Record<string, { utilization: number; resets_at: string | null }>;
}

export interface ParsedSlotUsageSurvey {
  /** Slot name -> a reading young enough to use. */
  fresh: Record<string, SlotUsageSurveyEntry>;
  /** Slot names dropped for age, in the order they appeared. */
  staleSlots: string[];
  /** Set when the variable was present but unusable — logged, never thrown. */
  problem: string | null;
}

/**
 * Parse `NANOCLAW_SLOT_USAGE_SURVEY`.
 *
 * Total function: every malformed shape — absent, not JSON, not an object, a
 * slot whose entry is the wrong shape, a `fetchedAt` that is not a date —
 * yields no reading for that slot rather than an exception. The caller treats
 * a missing reading exactly as it used to treat a failed pull: unsampled, no
 * sample row, ineligible for the pick.
 */
export function parseSlotUsageSurvey(
  raw: string | undefined,
  opts: { now: number; maxAgeMs?: number },
): ParsedSlotUsageSurvey {
  const empty: ParsedSlotUsageSurvey = { fresh: {}, staleSlots: [], problem: null };
  if (raw === undefined) return { ...empty, problem: `${SLOT_USAGE_SURVEY_ENV} is not set` };
  if (raw.trim() === '') return { ...empty, problem: `${SLOT_USAGE_SURVEY_ENV} is empty` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the value: it is host-supplied, and quoting an unparseable
    // blob into the container log is how a secret in an adjacent variable
    // would end up there if the spawn path ever mis-joined two pushes.
    return { ...empty, problem: `${SLOT_USAGE_SURVEY_ENV} is not JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...empty, problem: `${SLOT_USAGE_SURVEY_ENV} is not an object` };
  }

  const maxAgeMs = opts.maxAgeMs ?? SLOT_USAGE_SURVEY_MAX_AGE_MS;
  const fresh: Record<string, SlotUsageSurveyEntry> = {};
  const staleSlots: string[] = [];
  for (const [slot, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as { fetchedAt?: unknown; rateLimits?: unknown };
    if (typeof entry.fetchedAt !== 'string') continue;
    const fetchedAt = Date.parse(entry.fetchedAt);
    if (Number.isNaN(fetchedAt)) continue;
    if (opts.now - fetchedAt > maxAgeMs) {
      staleSlots.push(slot);
      continue;
    }
    if (!entry.rateLimits || typeof entry.rateLimits !== 'object' || Array.isArray(entry.rateLimits)) continue;
    const windows: Record<string, { utilization: number; resets_at: string | null }> = {};
    for (const [name, w] of Object.entries(entry.rateLimits as Record<string, unknown>)) {
      if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
      const window = w as { utilization?: unknown; resets_at?: unknown };
      if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) continue;
      windows[name] = {
        utilization: window.utilization,
        resets_at: typeof window.resets_at === 'string' ? window.resets_at : null,
      };
    }
    fresh[slot] = { fetchedAt: entry.fetchedAt, rateLimits: windows };
  }
  return { fresh, staleSlots, problem: null };
}

/**
 * One survey entry as the `/usage` response shape `usageResponseToSamples`
 * already consumes, so the 0-100 -> 0-1 normalization stays at its single
 * seam and the rows written are byte-for-byte what #811 wrote.
 */
export function surveyEntryToUsageResponse(entry: SlotUsageSurveyEntry): OauthUsageResponse {
  return { subscription_type: null, rate_limits_available: true, rate_limits: entry.rateLimits };
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
 * Eligible: sampled, plan limits apply, `seven_day` present and below
 * `1 - SLOT_PICK_HEADROOM`, and `five_hour` (when reported) < 1.0. The
 * five-hour exclusion is not in the
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
    if (sevenDay >= 1 - SLOT_PICK_HEADROOM) return { name, sevenDay, fiveHour, skipped: 'seven_day_exhausted' };
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
