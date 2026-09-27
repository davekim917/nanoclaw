/** Shapes follow codex-cli 0.154.0's app-server schema, where every optional field may be `null`. */
import type { AccountIdentity, RateLimitSample, RateLimitSampleSource } from '../modules/mailbox/index.js';

interface CodexRateLimitWindow {
  /** Integer 0-100 (required by the schema). */
  usedPercent: number;
  /** Epoch seconds. */
  resetsAt?: number | null;
  /** Nullable; 300 = five-hour window, 10080 = seven-day window. */
  windowDurationMins?: number | null;
}

/** Any non-null value, including one a newer app-server adds, counts as reached. */
type CodexRateLimitReachedType =
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

const FIVE_HOUR_MINS = 300;
const SEVEN_DAY_MINS = 7 * 24 * 60;

// Park at 95%, not 100%: a wall mid-turn aborts and replays the whole turn, costing more than the last 5%.
export const CODEX_PARK_USED_PERCENT = 95;

export interface ClassifiedCodexWindow {
  /** `five_hour` | `seven_day` (Claude's vocabulary, so one query spans both providers) | `window_<mins>m`. */
  limitType: string;
  usedPercent: number;
  /** ISO-8601 UTC, or null when the window states no reset. */
  resetsAt: string | null;
  /** True when `windowDurationMins` was null and the type was inferred from position. */
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

/** Epoch seconds → ISO; epoch milliseconds are tolerated too. */
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

/** Classified by `windowDurationMins`; position is the fallback only when the server omits it. */
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
 * Keys `mergeCodexRateLimitSnapshot` would overwrite: present, non-null, and for `primary`/`secondary` a valid
 * window (a malformed window is not a reading).
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
 * Null in an update means "not stated", not "cleared" (the notification's contract), so a reached limit stays
 * parked until a full re-read replaces the snapshot.
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

/** A snapshot with no window still yields one `no_window` row: never sampling differs from sampling nothing. */
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
  reason: 'seven_day_threshold' | 'rate_limit_reached';
  reachedType: string | null;
  limitType: string | null;
  usedPercent: number | null;
  /** ISO reset the host should park until; null → the host's backoff schedule. */
  resetsAt: string | null;
  message: string;
}

/**
 * For a reached limit, `resetsAt` is the earliest reset among exhausted windows, else the earliest stated;
 * null (depleted credits state none) hands the host its bounded backoff.
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

/** The weekly window wins when present: it is the binding constraint. */
export function codexTurnRateLimit(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): { type: string | null; utilization: number | null; resetsAt: string | null } | null {
  const windows = classifyCodexRateLimitWindows(snapshot);
  const pick =
    windows.find((w) => w.limitType === 'seven_day') ?? windows.find((w) => w.limitType === 'five_hour') ?? windows[0];
  if (!pick) return null;
  return { type: pick.limitType, utilization: pick.usedPercent / 100, resetsAt: pick.resetsAt };
}

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

export function parseCodexRateLimitsUpdated(params: unknown): CodexRateLimitSnapshot | null {
  if (!params || typeof params !== 'object') return null;
  const rl = (params as { rateLimits?: unknown }).rateLimits;
  return rl && typeof rl === 'object' ? (rl as CodexRateLimitSnapshot) : null;
}

/** Null for an API-key login, whose auth.json has no `tokens`; the sample is then written unattributed. */
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
