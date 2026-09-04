/**
 * Provider availability per agent group.
 *
 * A provider account can go hard-unavailable for hours or days (a weekly
 * usage limit, a suspended key). Spawning a container onto it in that window
 * produces one guaranteed-failing turn per wake — visible to users as an
 * error, and for a scheduled agent, silently repeated forever.
 *
 * The container observes the failure (only it talks to the provider) and
 * reports it; the host records the window here and routes later spawns to the
 * group's declared fallback until the window expires. Recovery needs no
 * probe, no cron, and no operator action: the row simply ages out, and the
 * next spawn returns to the primary provider.
 *
 * Cooldown precedence:
 *   1. the provider's own reset time, when it tells us one ("try again at X")
 *   2. otherwise exponential backoff on the failure streak
 * Both are clamped — a provider claiming a year-long lockout should not
 * outlive an operator fixing the account, and a one-second reset should not
 * produce a hot loop.
 */
import { getRawDb } from './connection.js';

/** Never trust an unbounded reset promise from a provider. */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const MIN_COOLDOWN_MS = 60_000;
/** Backoff when the provider gave us no reset time: 15m, 30m, 1h … capped. */
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

function cooldownMs(consecutiveFailures: number, resetAtMs: number | null, nowMs: number): number {
  const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
  // A provider's stated reset is an UPPER BOUND, never the schedule. Accounts
  // are often restored before the quoted time, and a window pinned to that
  // quote would keep a group on its fallback for days after the primary came
  // back — the exact hard-lock this mechanism exists to avoid. Taking the
  // minimum still honors a SHORT stated reset ("try again in 5 minutes")
  // while retrying a long one on the backoff schedule instead.
  //
  // Retries are cheap because spawns are demand-driven: a probe costs one
  // container start and a turn that dies immediately, it is suppressed from
  // chat, and it reroutes to the fallback in the same breath.
  if (resetAtMs !== null && Number.isFinite(resetAtMs)) {
    return clampCooldown(Math.min(resetAtMs - nowMs, backoff));
  }
  return clampCooldown(backoff);
}

export function getProviderHealth(agentGroupId: string, provider: string): ProviderHealthRow | undefined {
  return getRawDb()
    .prepare(`SELECT * FROM provider_health WHERE agent_group_id = ? AND provider = ?`)
    .get(agentGroupId, provider) as ProviderHealthRow | undefined;
}

/**
 * True while the group's provider is inside a recorded cooldown window.
 * Absence of a row — the normal case — is always "available": this must fail
 * OPEN, or a bookkeeping gap would strand every group on its fallback.
 */
export function isProviderUnavailable(
  agentGroupId: string,
  provider: string,
  options: { nowMs?: number } = {},
): boolean {
  const row = getProviderHealth(agentGroupId, provider);
  if (!row?.unavailable_until) return false;
  const until = Date.parse(row.unavailable_until);
  if (!Number.isFinite(until)) return false;
  return (options.nowMs ?? Date.now()) < until;
}

/**
 * Record a provider as unavailable and return the window end.
 * `resetAt` is the provider's own stated recovery time when it gave one.
 */
export function markProviderUnavailable(
  agentGroupId: string,
  provider: string,
  errorClass: ProviderErrorClass,
  options: { nowMs?: number; resetAt?: string | null; message?: string | null } = {},
): string {
  if (!agentGroupId) throw new Error('agent group id is required');
  if (!provider) throw new Error('provider is required');
  const db = getRawDb();
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const resetAtMs = options.resetAt ? Date.parse(options.resetAt) : null;
  return db.transaction(() => {
    const prior = getProviderHealth(agentGroupId, provider);
    const consecutiveFailures = (prior?.consecutive_failures ?? 0) + 1;
    const unavailableUntil = new Date(
      nowMs + cooldownMs(consecutiveFailures, Number.isFinite(resetAtMs as number) ? resetAtMs : null, nowMs),
    ).toISOString();
    db.prepare(
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
    ).run(
      agentGroupId,
      provider,
      unavailableUntil,
      consecutiveFailures,
      errorClass,
      options.message ? options.message.slice(0, 500) : null,
      now,
    );
    return unavailableUntil;
  })();
}

/** Clear a cooldown — a turn completed on this provider, so it works. */
export function markProviderAvailable(agentGroupId: string, provider: string, options: { nowMs?: number } = {}): void {
  if (!agentGroupId || !provider) return;
  const row = getProviderHealth(agentGroupId, provider);
  // Only write when there is something to clear: a healthy provider must not
  // generate a DB write on every successful turn.
  if (!row || (row.unavailable_until === null && row.consecutive_failures === 0)) return;
  getRawDb()
    .prepare(
      `UPDATE provider_health
          SET unavailable_until = NULL, consecutive_failures = 0, updated_at = ?
        WHERE agent_group_id = ? AND provider = ?`,
    )
    .run(new Date(options.nowMs ?? Date.now()).toISOString(), agentGroupId, provider);
}

/**
 * Parse a provider's stated recovery time out of its own error text.
 *
 * Codex says: "You've hit your usage limit. … try again at Aug 8th, 2026
 * 12:42 AM." The ordinal suffix ("8th") is not parseable by `Date`, so it is
 * stripped first. Returns null when nothing usable is present — the caller
 * then falls back to backoff, which is the safe direction.
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
  // A reset in the past (clock skew, a stale message) is not a usable window.
  if (parsed <= nowMs) return null;
  return new Date(parsed).toISOString();
}
