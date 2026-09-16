/**
 * Codex (ChatGPT / OpenAI) account rate-limit snapshot handling.
 *
 * Pure functions over the app-server's `account/rateLimits/read` response
 * and `account/rateLimits/updated` notification — no I/O, so every branch is
 * unit-testable against fixtures without a network or a `codex` binary.
 * The RPC itself lives in codex-app-server.ts (`readCodexAccountRateLimits`);
 * the lifecycle (when to read, when to park) is in codex.ts.
 *
 * Shapes are from `codex app-server generate-json-schema` (codex-cli 0.154.0,
 * `codex_app_server_protocol.v2.schemas.json` definitions
 * `GetAccountRateLimitsResponse`, `RateLimitSnapshot`, `RateLimitWindow`,
 * `RateLimitReachedType`, `AccountRateLimitsUpdatedNotification`). Typed
 * structurally and read defensively: only the fields used below are declared,
 * and every optional field tolerates `null` because the schema marks them
 * nullable.
 *
 * Why this mirrors the Claude `usage_pull` path (providers/claude.ts): Codex
 * turns had zero rate-limit visibility — 561 turns in a week with every
 * `turn_usage.rate_limit_*` NULL, the only signal a post-hoc `systemError`
 * once the wall was already hit. The protocol exposes the data; this asks.
 */
import type { AccountIdentity, RateLimitSample, RateLimitSampleSource } from '../modules/mailbox/index.js';

export interface CodexRateLimitWindow {
  /** Integer 0-100 (required by the schema). */
  usedPercent: number;
  /** Epoch seconds (int64). Nullable. */
  resetsAt?: number | null;
  /** Nullable; 300 = five-hour window, 10080 = seven-day window. */
  windowDurationMins?: number | null;
}

/**
 * `RateLimitReachedType` enum. Kept as a string union so an unknown value a
 * newer app-server adds still parks (any non-null value is "reached") and is
 * recorded verbatim rather than dropped.
 */
export type CodexRateLimitReachedType =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached'
  | (string & {});

export interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: CodexRateLimitReachedType | null;
  spendControlReached?: boolean | null;
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  normalModelSlug?: string | null;
}

export interface CodexRateLimitsReadResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  accountId?: string | null;
}

export const CODEX_RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';
export const CODEX_RATE_LIMITS_UPDATED_METHOD = 'account/rateLimits/updated';

/** `windowDurationMins` values that name a window the fleet already tracks for Claude. */
const FIVE_HOUR_MINS = 300;
const SEVEN_DAY_MINS = 7 * 24 * 60;

/**
 * Weekly utilization at or above which the group's Codex is parked on its
 * fallback BEFORE the wall, so the last turns of the week land somewhere that
 * can answer them. Spec: docs/specs/quota-burn/plan.md item 0.7.
 */
// Park at 95% used, not 100%: leaves headroom for the in-flight turn to finish before the wall. A wall mid-turn aborts and replays the whole turn, which costs more than the last 5% of a weekly bucket. Tune from measurement.
export const CODEX_PARK_USED_PERCENT = 95;

export interface ClassifiedCodexWindow {
  /** `five_hour` | `seven_day` (Claude's vocabulary, so one query spans both providers) | `window_<mins>m`. */
  limitType: string;
  usedPercent: number;
  /** ISO-8601 UTC, or null when the window states no reset. */
  resetsAt: string | null;
  /**
   * True when `windowDurationMins` was null and the type was inferred from
   * position (primary → five_hour, secondary → seven_day). Logged by the
   * caller; a reader of the table cannot otherwise tell a measured window
   * from an assumed one.
   */
  assumed: boolean;
}

function isWindow(value: unknown): value is CodexRateLimitWindow {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { usedPercent?: unknown }).usedPercent === 'number' &&
    Number.isFinite((value as { usedPercent: number }).usedPercent)
  );
}

/** Epoch seconds → ISO. Tolerates epoch milliseconds the way claude.ts's resetsAtIso does. */
export function codexResetsAtIso(resetsAt: number | null | undefined): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return new Date(ms).toISOString();
}

function classifyOne(
  window: CodexRateLimitWindow | null | undefined,
  positionalType: 'five_hour' | 'seven_day',
): ClassifiedCodexWindow | null {
  if (!isWindow(window)) return null;
  const mins = window.windowDurationMins;
  let limitType: string;
  let assumed = false;
  if (mins === FIVE_HOUR_MINS) limitType = 'five_hour';
  else if (mins === SEVEN_DAY_MINS) limitType = 'seven_day';
  else if (typeof mins === 'number' && Number.isFinite(mins) && mins > 0) limitType = `window_${mins}m`;
  else {
    limitType = positionalType;
    assumed = true;
  }
  return { limitType, usedPercent: window.usedPercent, resetsAt: codexResetsAtIso(window.resetsAt), assumed };
}

/**
 * Name the snapshot's windows. `primary`/`secondary` are the 5-hour/7-day
 * pair in different clothes; classification is by `windowDurationMins` and
 * falls back to position only when the server omits the duration.
 */
export function classifyCodexRateLimitWindows(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): ClassifiedCodexWindow[] {
  if (!snapshot) return [];
  const out: ClassifiedCodexWindow[] = [];
  const primary = classifyOne(snapshot.primary, 'five_hour');
  const secondary = classifyOne(snapshot.secondary, 'seven_day');
  if (primary) out.push(primary);
  if (secondary) out.push(secondary);
  return out;
}

/**
 * Which top-level keys an update would actually overwrite in
 * `mergeCodexRateLimitSnapshot`: present, non-null, and — for `primary`/
 * `secondary` — a valid window (usedPercent is required, so a malformed
 * window is not a reading). Exported so the tracker can stamp per-field
 * freshness (a read in flight must know, per field, whether a push that
 * landed mid-read actually touched that field) without duplicating this
 * eligibility rule.
 */
export function codexRateLimitSnapshotUpdatedKeys(
  update: CodexRateLimitSnapshot | null | undefined,
): (keyof CodexRateLimitSnapshot)[] {
  if (!update || typeof update !== 'object') return [];
  const keys: (keyof CodexRateLimitSnapshot)[] = [];
  for (const key of Object.keys(update) as (keyof CodexRateLimitSnapshot)[]) {
    const value = update[key];
    if (value === null || value === undefined) continue;
    if ((key === 'primary' || key === 'secondary') && !isWindow(value)) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * Sparse merge per the notification's own contract: "merge available values
 * into the most recent read response … nullable account metadata may be
 * unavailable in a rolling update and does not clear a previously observed
 * value". A window present in the update replaces the prior window wholesale
 * (usedPercent is required, so a present window is a complete reading);
 * every null/absent field keeps what the last read said.
 *
 * `rateLimitReachedType` follows the same rule: null in an update means
 * "not stated", NOT "cleared". A reached limit therefore stays parked until
 * a full re-read replaces the snapshot — the next session start does that.
 */
export function mergeCodexRateLimitSnapshot(
  prev: CodexRateLimitSnapshot | null,
  update: CodexRateLimitSnapshot | null | undefined,
): CodexRateLimitSnapshot | null {
  if (!update || typeof update !== 'object') return prev;
  const merged: CodexRateLimitSnapshot = { ...(prev ?? {}) };
  for (const key of codexRateLimitSnapshotUpdatedKeys(update)) {
    (merged as Record<string, unknown>)[key] = update[key];
  }
  return merged;
}

/**
 * Translate a snapshot into `rate_limit_samples` rows, one per window, in the
 * exact shape the Claude provider writes (`usageResponseToSamples`,
 * providers/claude.ts) so one query reads both providers:
 * `utilization` is the 0-1 fraction, `limit_type` is `five_hour`/`seven_day`.
 * A snapshot with no window still records that the pull happened
 * (`status: 'no_window'`) — never sampling is a different state from
 * sampling nothing.
 */
export function codexSnapshotToSamples(
  snapshot: CodexRateLimitSnapshot | null | undefined,
  who: AccountIdentity,
  source: RateLimitSampleSource,
): RateLimitSample[] {
  const base = {
    source,
    ...who,
    subscriptionType: snapshot?.planType ?? null,
    available: true,
  };
  const windows = classifyCodexRateLimitWindows(snapshot);
  // `status` explains the row (schema.ts): the reached-limit enum is the one
  // fact a percentage cannot carry, so it rides here on every window row —
  // and on the no-window row, where a sparse push may carry nothing else.
  const status = snapshot?.rateLimitReachedType ?? null;
  if (windows.length === 0) {
    return [{ ...base, limitType: null, utilization: null, resetsAt: null, status: status ?? 'no_window' }];
  }
  return windows.map((w) => ({
    ...base,
    limitType: w.limitType,
    utilization: w.usedPercent / 100,
    resetsAt: w.resetsAt,
    status,
  }));
}

export interface CodexRateLimitPark {
  /** Which rule fired. */
  reason: 'seven_day_threshold' | 'rate_limit_reached';
  /** The `RateLimitReachedType` value when `reason === 'rate_limit_reached'`. */
  reachedType: string | null;
  /** Window the decision rests on, when one does. */
  limitType: string | null;
  usedPercent: number | null;
  /** ISO reset the host should park until; null → the host's backoff schedule. */
  resetsAt: string | null;
  /** One line for `provider_health.last_error_message` and the chat log. */
  message: string;
}

/**
 * Park rule (plan item 0.7): park when the weekly window is at or past
 * CODEX_PARK_USED_PERCENT, or when the server says a limit is reached
 * (any `rateLimitReachedType`). The enum distinguishes a plain rate limit
 * from workspace credit/usage exhaustion; the message names which so the
 * `provider_health` row does too.
 *
 * `resetsAt` selection: the seven-day window's reset for the threshold rule.
 * For a reached limit, the earliest reset among windows already at 100%,
 * else the earliest reset stated at all — a depleted-credits state states no
 * reset, and null hands the host its bounded backoff, the safe direction.
 */
export function decideCodexRateLimitPark(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): CodexRateLimitPark | null {
  if (!snapshot) return null;
  const windows = classifyCodexRateLimitWindows(snapshot);
  const sevenDay = windows.find((w) => w.limitType === 'seven_day');
  const reached = snapshot.rateLimitReachedType ?? null;

  if (reached) {
    const exhausted = windows.filter((w) => w.usedPercent >= 100 && w.resetsAt);
    const stated = (exhausted.length > 0 ? exhausted : windows.filter((w) => w.resetsAt)).sort((a, b) =>
      (a.resetsAt as string).localeCompare(b.resetsAt as string),
    );
    const pivot = exhausted[0] ?? sevenDay ?? windows[0] ?? null;
    const resetsAt = stated[0]?.resetsAt ?? null;
    return {
      reason: 'rate_limit_reached',
      reachedType: reached,
      limitType: pivot?.limitType ?? null,
      usedPercent: pivot?.usedPercent ?? null,
      resetsAt,
      message:
        `Codex rate limit reached (${reached})` +
        (pivot ? ` [${pivot.limitType}] ${pivot.usedPercent}% used` : '') +
        (resetsAt ? ` (resets ${resetsAt})` : ''),
    };
  }

  if (sevenDay && sevenDay.usedPercent >= CODEX_PARK_USED_PERCENT) {
    return {
      reason: 'seven_day_threshold',
      reachedType: null,
      limitType: 'seven_day',
      usedPercent: sevenDay.usedPercent,
      resetsAt: sevenDay.resetsAt,
      message:
        `Codex rate limit [seven_day] ${sevenDay.usedPercent}% used, at or past the ${CODEX_PARK_USED_PERCENT}% park threshold` +
        (sevenDay.resetsAt ? ` (resets ${sevenDay.resetsAt})` : ''),
    };
  }
  return null;
}

/**
 * The single window stamped onto `turn_usage.rate_limit_*` for a Codex turn.
 * One row holds one window; the weekly one is the binding constraint the
 * quota-burn plan tracks, so it wins when present. Falls back to the
 * five-hour window, then whatever the snapshot has.
 */
export function codexTurnRateLimit(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): { type: string | null; utilization: number | null; resetsAt: string | null } | null {
  const windows = classifyCodexRateLimitWindows(snapshot);
  const pick =
    windows.find((w) => w.limitType === 'seven_day') ?? windows.find((w) => w.limitType === 'five_hour') ?? windows[0];
  if (!pick) return null;
  return { type: pick.limitType, utilization: pick.usedPercent / 100, resetsAt: pick.resetsAt };
}

/** Parse a `GetAccountRateLimitsResponse`; null when the shape is not one. */
export function parseCodexRateLimitsReadResponse(result: unknown): CodexRateLimitsReadResponse | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (!r.rateLimits || typeof r.rateLimits !== 'object') return null;
  const byId = r.rateLimitsByLimitId;
  return {
    rateLimits: r.rateLimits as CodexRateLimitSnapshot,
    rateLimitsByLimitId: byId && typeof byId === 'object' ? (byId as Record<string, CodexRateLimitSnapshot>) : null,
    accountId: typeof r.accountId === 'string' && r.accountId ? r.accountId : null,
  };
}

/** Parse an `account/rateLimits/updated` notification's params; null when not one. */
export function parseCodexRateLimitsUpdated(params: unknown): CodexRateLimitSnapshot | null {
  if (!params || typeof params !== 'object') return null;
  const rl = (params as { rateLimits?: unknown }).rateLimits;
  return rl && typeof rl === 'object' ? (rl as CodexRateLimitSnapshot) : null;
}

/**
 * Codex account identity for the `account` column, read from the active
 * CODEX_HOME's `auth.json` (`tokens.account_id` — the ChatGPT account id,
 * the same namespace `GetAccountRateLimitsResponse.accountId` reports).
 * Null for an API-key login (`auth_mode: 'apikey'` has no `tokens`) or an
 * unreadable file — the sample is still written, unattributed, the way an
 * API-key Claude session's is.
 */
export function readCodexAccountIdFromAuthJson(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tokens?: { account_id?: unknown } | null };
    const id = parsed?.tokens?.account_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}
