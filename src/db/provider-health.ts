/**
 * Provider availability per agent group. An account can go unavailable for hours or days (usage limit, suspended
 * key), and spawning onto it produces a guaranteed-failing turn per wake. The container reports the failure; the host
 * records the window here and routes spawns to the group's declared fallback until it expires. Recovery needs no
 * probe: the row ages out.
 * Cooldown: the provider's stated reset time when it gives one, else exponential backoff on the failure streak, both
 * clamped.
 */
import { centralTransaction } from './central-lease.js';
import { getDb } from './connection.js';

/** Never trust an unbounded reset promise from a provider. */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const MIN_COOLDOWN_MS = 60_000;
/** Used when the provider gave no reset time: 15m, 30m, 1h, … capped. */
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

export type ProviderErrorClass = 'quota' | 'auth' | 'unavailable';

export interface ProviderHealthRow {
  agent_group_id: string;
  provider: string;
  unavailable_until: string | null;
  consecutive_failures: number;
  last_error_class: string | null;
  last_error_message: string | null;
  updated_at: string;
}

function clampCooldown(ms: number): number {
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
}

function cooldownMs(
  consecutiveFailures: number,
  resetAtMs: number | null,
  nowMs: number,
  options: { honorResetAt?: boolean; maxCooldownMs?: number } = {},
): number {
  const cap = Math.min(MAX_COOLDOWN_MS, options.maxCooldownMs ?? MAX_COOLDOWN_MS);
  const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
  // A MEASURED reset (the provider's own rate-limit snapshot) is the schedule, not an upper bound: nothing restores a
  // usage window early. Still clamped.
  if (options.honorResetAt && resetAtMs !== null && Number.isFinite(resetAtMs)) {
    return Math.min(cap, clampCooldown(resetAtMs - nowMs));
  }
  // A reset stated in error prose is an UPPER BOUND, never the schedule: accounts are often restored early, and
  // pinning to the quote would strand a group on its fallback for days. The minimum still honors a short stated
  // reset. Retries are cheap: a probe is one suppressed, immediately rerouted turn.
  if (resetAtMs !== null && Number.isFinite(resetAtMs)) {
    return Math.min(cap, clampCooldown(Math.min(resetAtMs - nowMs, backoff)));
  }
  return Math.min(cap, clampCooldown(backoff));
}

export async function getProviderHealth(
  agentGroupId: string,
  provider: string,
): Promise<ProviderHealthRow | undefined> {
  return getDb().get<ProviderHealthRow>(
    `SELECT * FROM provider_health WHERE agent_group_id = ? AND provider = ?`,
    agentGroupId,
    provider,
  );
}

/**
 * Must fail OPEN: no row (the normal case) is always available, or a bookkeeping gap would strand every group on its
 * fallback.
 */
export async function isProviderUnavailable(
  agentGroupId: string,
  provider: string,
  options: { nowMs?: number } = {},
): Promise<boolean> {
  const row = await getProviderHealth(agentGroupId, provider);
  if (!row?.unavailable_until) return false;
  const until = Date.parse(row.unavailable_until);
  if (!Number.isFinite(until)) return false;
  return (options.nowMs ?? Date.now()) < until;
}

/**
 * Records a provider as unavailable and returns the window end. `honorResetAt` means `resetAt` was MEASURED, not
 * parsed from prose; `maxCooldownMs` bounds the window below the global cap. The read-then-upsert is one central
 * transaction so the failure streak cannot race itself.
 */
export async function markProviderUnavailable(
  agentGroupId: string,
  provider: string,
  errorClass: ProviderErrorClass,
  options: {
    nowMs?: number;
    resetAt?: string | null;
    message?: string | null;
    honorResetAt?: boolean;
    maxCooldownMs?: number;
  } = {},
): Promise<string> {
  if (!agentGroupId) throw new Error('agent group id is required');
  if (!provider) throw new Error('provider is required');
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const resetAtMs = options.resetAt ? Date.parse(options.resetAt) : null;
  return centralTransaction(async () => {
    const prior = await getProviderHealth(agentGroupId, provider);
    const consecutiveFailures = (prior?.consecutive_failures ?? 0) + 1;
    const unavailableUntil = new Date(
      nowMs +
        cooldownMs(consecutiveFailures, Number.isFinite(resetAtMs as number) ? resetAtMs : null, nowMs, {
          honorResetAt: options.honorResetAt,
          maxCooldownMs: options.maxCooldownMs,
        }),
    ).toISOString();
    await getDb().run(
      `INSERT INTO provider_health
         (agent_group_id, provider, unavailable_until, consecutive_failures,
          last_error_class, last_error_message, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, provider) DO UPDATE SET
         unavailable_until = excluded.unavailable_until,
         consecutive_failures = excluded.consecutive_failures,
         last_error_class = excluded.last_error_class,
         last_error_message = excluded.last_error_message,
         updated_at = excluded.updated_at`,
      agentGroupId,
      provider,
      unavailableUntil,
      consecutiveFailures,
      errorClass,
      options.message ? options.message.slice(0, 500) : null,
      now,
    );
    return unavailableUntil;
  }, 'markProviderUnavailable');
}

/**
 * Clears a cooldown after a successful turn. A CONDITIONAL update keyed on `updated_at` (every writer bumps it), so a
 * newer `markProviderUnavailable` committed between the read and the write is not clobbered by an older success.
 * Returns whether it applied.
 */
export async function markProviderAvailable(
  agentGroupId: string,
  provider: string,
  options: { nowMs?: number } = {},
): Promise<boolean> {
  if (!agentGroupId || !provider) return false;
  const row = await getProviderHealth(agentGroupId, provider);
  // A healthy provider must not cause a DB write on every turn.
  if (!row || (row.unavailable_until === null && row.consecutive_failures === 0)) return false;
  const result = await getDb().run(
    `UPDATE provider_health
          SET unavailable_until = NULL, consecutive_failures = 0, updated_at = ?
        WHERE agent_group_id = ? AND provider = ?
          AND updated_at = ?
          AND unavailable_until IS ?
          AND consecutive_failures = ?`,
    new Date(options.nowMs ?? Date.now()).toISOString(),
    agentGroupId,
    provider,
    row.updated_at,
    row.unavailable_until,
    row.consecutive_failures,
  );
  return result.changes > 0;
}

/**
 * Parses a stated recovery time from the provider's error text ("try again at Aug 8th, 2026 12:42 AM"). Ordinal
 * suffixes are stripped because `Date` cannot parse them. Null when nothing usable is present (the caller backs off).
 */
export function parseProviderResetAt(message: string | null | undefined, nowMs = Date.now()): string | null {
  if (!message) return null;
  const match = /try again (?:at|on|after)\s+([^.]+?)(?:\.|$)/i.exec(message);
  if (!match) return null;
  const cleaned = match[1]
    .replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const parsed = Date.parse(cleaned);
  if (!Number.isFinite(parsed)) return null;
  // A past reset (clock skew, stale message) is not a usable window.
  if (parsed <= nowMs) return null;
  return new Date(parsed).toISOString();
}
