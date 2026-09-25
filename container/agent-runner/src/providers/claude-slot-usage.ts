/**
 * Per-slot OAuth plan-utilization telemetry at session start.
 *
 * The host surveys `/api/oauth/usage` for every ring slot on its own clock
 * (`src/slot-usage-survey.ts`) and hands each spawn the readings in
 * `NANOCLAW_SLOT_USAGE_SURVEY`. This module parses that; the provider records
 * one `usage_pull` sample row per slot per window so idle slots do not go dark
 * in `rate_limit_samples`. It makes no network call.
 *
 * Telemetry ONLY — the readings never choose a credential. Slot order is the
 * operator's priority: the ring is `CLAUDE_CODE_OAUTH_TOKEN`, then `_2`, `_3`,
 * … in numeric order, and it advances only when a slot hits a rate-limit or
 * quota wall (`ClaudeProvider.rotateApiKey`). Quota-burn 0.6 moved
 * each session onto the most-used slot with headroom; the operator reversed
 * that on 2026-09-16 in favour of numbered order.
 *
 * Pure functions only — no IO, no clock of its own.
 */
import type { RateLimitSample } from '../modules/mailbox/index.js';

/** Structural mirror of the `/api/oauth/usage` response — only what we read. */
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
 * How old a host reading may be and still be recorded as a sample.
 *
 * The host refreshes each slot every 10 minutes, but parks a slot for as long
 * as the server's own `retry-after` when it is rate limited (~53 minutes
 * observed). Past this age a reading stops being evidence: the slot is left
 * unsampled rather than filed under a timestamp that misstates it.
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
 * a missing reading as unsampled: no sample row.
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
 * seam.
 */
export function surveyEntryToUsageResponse(entry: SlotUsageSurveyEntry): OauthUsageResponse {
  return { subscription_type: null, rate_limits_available: true, rate_limits: entry.rateLimits };
}
