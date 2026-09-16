/**
 * Fleet-wide `/api/oauth/usage` survey for the Claude OAuth ring (quota-burn
 * 0.6 follow-up; fixes the storm PR #811 shipped).
 *
 * WHY THIS LIVES ON THE HOST
 *
 * #811 put the survey in the agent-runner: its slot pick fired one
 * `/api/oauth/usage` request per ring slot at every session start, exactly
 * once per container boot, so the request rate
 * seen by EACH token equals the fleet's Claude session-start rate — ~25
 * spawns/hour here, bursting 4-8 in a single minute. Measured 2026-09-15
 * 03:53Z: every slot answered `HTTP 429 rate_limit_error` with
 * `retry-after: 3166`, and the three slots of one credential set reported
 * windows ending at the same *second* (04:45:48Z) while a slot from a
 * different credential set on the same host IP ended at 04:30:57Z — the
 * signature of a per-identity limiter driven in lockstep by one six-way
 * parallel pull, not of an IP limiter. An invalid bearer from the same IP in
 * the same second answered 401, not 429, which places the limiter after
 * authentication.
 *
 * No throttle inside the container can fix that: the container process does
 * the pull once and exits, so a per-process interval is a no-op. The limit is
 * per credential, fleet-wide, and the only process that sees the whole fleet
 * is this one. So the host surveys on its own clock and each spawn carries the
 * readings in `NANOCLAW_SLOT_USAGE_SURVEY`; the runner records them as
 * `usage_pull` sample rows (`ClaudeProvider.recordSlotUsageSurvey`), with no
 * network call of its own.
 *
 * TELEMETRY ONLY. Since 2026-09-16 (operator decision) the readings never
 * choose a credential: slots run in numbered order and advance on a wall. The
 * usage-maximizing pick this survey was built to feed is gone.
 *
 * Request volume is therefore a function of wall-clock time and ring size
 * ALONE — `SLOT_USAGE_SURVEY_MIN_INTERVAL_MS` per slot — and completely
 * independent of how many containers spawn.
 *
 * PROXY: this uses the global `fetch` deliberately. Node's global fetch
 * ignores `HTTPS_PROXY`/`HTTP_PROXY` (see `src/backlog-canvas.ts:96-113`,
 * which has to opt IN with an `EnvHttpProxyAgent` for exactly that reason), so
 * the request goes direct to api.anthropic.com and the OneCLI gateway never
 * substitutes its own vault credential over our `Authorization` header. That
 * mirrors what the container gets from the `mergeNoProxy(args,
 * 'api.anthropic.com')` call in `src/container-runner.ts`. Do not give this
 * module a dispatcher.
 *
 * SECRETS: no token value is ever logged, thrown, or used as a map key. Every
 * error leaving `fetchSlotUsage` is built here from a status code or an error
 * CLASS NAME, because a malformed slot value makes `fetch()` throw a TypeError
 * whose message quotes the whole `Authorization: Bearer <token>` header
 * (PR #811 review F1, `docs/review-notes/811.md`).
 */
import { createHash } from 'crypto';

import { log } from './log.js';

/** One rate-limit window as the endpoint reports it: `utilization` is 0-100. */
export interface SlotUsageWindowReading {
  utilization: number;
  resets_at: string | null;
}

/** One slot's last successful reading. */
export interface SlotUsageEntry {
  /** ISO-8601 UTC instant the reading was fetched. */
  fetchedAt: string;
  /** Window name -> reading. Only windows carrying a numeric utilization. */
  rateLimits: Record<string, SlotUsageWindowReading>;
}

/** Slot name (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_3`, …) -> reading. */
export type SlotUsageSurvey = Record<string, SlotUsageEntry>;

/** One ring slot as the spawn path already resolved it. */
export interface RingSlot {
  name: string;
  value: string;
}

/**
 * The ring the runner will build, derived from what the spawn path resolved.
 *
 * Must match `ClaudeProvider`'s constructor exactly
 * (`container/agent-runner/src/providers/claude.ts:2224-2231`): primary at
 * position 0 under the name `CLAUDE_CODE_OAUTH_TOKEN`, numbered fallbacks
 * after it in index order, the OneCLI `placeholder` sentinel refused, and
 * duplicates dropped BY VALUE keeping the first name. A slot surveyed under a
 * name the ring does not carry is a wasted request, and a ring slot missing
 * from the survey is a slot with no telemetry.
 */
export function ringSlotsForSurvey(
  primary: string | undefined,
  fallbacks: readonly { index: number; value: string }[],
): RingSlot[] {
  if (!primary || primary === 'placeholder') return [];
  const slots: RingSlot[] = [];
  const seen = new Set<string>();
  for (const entry of [
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: primary },
    ...[...fallbacks]
      .sort((a, b) => a.index - b.index)
      .map((fb) => ({ name: `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}`, value: fb.value })),
  ]) {
    if (!entry.value || entry.value === 'placeholder' || seen.has(entry.value)) continue;
    seen.add(entry.value);
    slots.push(entry);
  }
  return slots;
}

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/**
 * How often ONE slot may be pulled. This is the whole rate control: with a
 * 6-slot ring the fleet issues 6 requests per interval no matter how many
 * containers start.
 *
 * 10 minutes = 6 requests/hour/token. Chosen against the measurement in the
 * header comment: the endpoint blocked this fleet for a ~53-minute window
 * after a burst, so single digits per hour is the safe order of magnitude,
 * and utilization does not move faster than this anyway (the in-turn pull next
 * to it has used a 5-minute floor since before #811 —
 * `container/agent-runner/src/providers/claude.ts` `USAGE_PULL_MIN_INTERVAL_MS`).
 *
 * This endpoint is aggressively limited for everyone, not just for us:
 * anthropics/claude-code#31021, #30930 and #31637 report statusline tools
 * polling it every 30-60s falling into a permanent 429 loop. So treat this
 * constant as a starting point, and treat widening it as the FIRST answer if
 * 429s persist — never retrying harder. Tune from measurement: 429s still in
 * the host log -> widen.
 */
export const SLOT_USAGE_SURVEY_MIN_INTERVAL_MS = 10 * 60_000;

/** Deadline for one pull. Same reasoning as the runner's `USAGE_PULL_TIMEOUT_MS`. */
export const SLOT_USAGE_PULL_TIMEOUT_MS = 10_000;

/**
 * Backoff applied to a 429 that arrives without a usable `retry-after`.
 * Deliberately much longer than the ordinary interval: a 429 with no hint is
 * the case we know least about, so it fails toward silence, not toward
 * another request.
 */
export const SLOT_USAGE_429_DEFAULT_BACKOFF_MS = 30 * 60_000;

/** Ceiling on an honoured `retry-after`, so a hostile or absurd value can't park a slot forever. */
export const SLOT_USAGE_429_MAX_BACKOFF_MS = 2 * 60 * 60_000;

interface SlotState {
  /**
   * Which CREDENTIAL this state describes — see `credentialFingerprint`. A slot
   * NAME is not an identity: the spawn path re-reads `.env` on every spawn
   * (`src/container-runner.ts`, the `readEnvFileMatching` argument to
   * `resolveAnthropicAuth`, added so per-group token edits take effect on the
   * next respawn rather than the next host restart), so the token behind
   * `CLAUDE_CODE_OAUTH_TOKEN_2` can become a different Anthropic account
   * between two spawns with nothing else changing.
   */
  fingerprint: string;
  /** Epoch ms of the last ATTEMPT (success or failure). */
  lastAttemptAt: number;
  /** Epoch ms before which no attempt may be made at all (429 backoff). */
  blockedUntil: number;
  entry?: SlotUsageEntry;
}

/**
 * Keyed by a JSON `[credential set, slot name]` pair — NOT by token value. The same
 * slot NAME in two credential sets is two different Anthropic accounts whose
 * windows share no denominator (`src/container-runner.ts`, the
 * `NANOCLAW_OAUTH_CREDENTIAL_SET` push), and a secret must never become a map
 * key that a heap dump or a debug print could surface.
 *
 * JSON rather than a `<set><sep><name>` string so there is no separator that
 * could appear inside either half and collide two different slots onto one
 * throttle.
 *
 * One entry per slot, carrying the fingerprint of the credential it describes.
 * Keying on the fingerprint instead would grow an entry per token ever seen and
 * would keep a replaced account's park alive for a slot nothing uses any more.
 */
const slotStates = new Map<string, SlotState>();
const inFlight = new Map<string, Promise<void>>();

function stateKey(credentialSet: string, slotName: string): string {
  return JSON.stringify([credentialSet, slotName]);
}

/**
 * A stable, non-reversible handle for one token value.
 *
 * NEVER the token itself — not as a map key, not in a log line, not in the
 * payload handed to a container. A sha256 prefix is enough to answer the only
 * question asked of it ("is this the same credential the reading came from?"),
 * and 64 bits of a hash over a high-entropy secret collides with nothing.
 *
 * Why this exists: a cached reading that outlives its credential is worse than
 * no reading: `recordRateLimitSamples` would file the OLD account's
 * numbers under the new one — poisoning the very telemetry quota-burn reads.
 * The 45-minute age guard cannot see that, because the reading is young; only
 * identity can. (PR #821 review r1.)
 */
export function credentialFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/** The error's class name only (`TypeError`, `AbortError`, …) — never its message. */
export function sanitizedErrorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'unknown';
}

/** A 429 carries this; anything unparseable is treated as absent. */
export class SlotUsageRateLimited extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('usage pull HTTP 429');
    this.name = 'SlotUsageRateLimited';
  }
}

/** `retry-after` in seconds, or an HTTP-date. Returns ms, or null when unusable. */
export function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  // A number-shaped value that is not delta-seconds (`-5`, `+5`, `1.5`) is
  // refused rather than handed to Date.parse: V8 reads `-5` as the year 5 BC's
  // neighbourhood (988675200000 — 2001-05-01), which would come back as "the
  // window is already over" and retry a rate-limited slot immediately. That is
  // the fail-open direction; an unreadable header must back off, not rush.
  if (/^[+-]?\d*\.?\d+$/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? delta : 0;
}

export interface FetchSlotUsageOptions {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  url?: string;
  now?: () => number;
}

/**
 * One `/api/oauth/usage` round-trip authenticated as `token`. Resolves to the
 * windows that carry a numeric utilization; rejects on a non-2xx status, an
 * unreadable body, or the deadline. A 429 rejects as `SlotUsageRateLimited`
 * so the caller can park the slot for the window the server named.
 *
 * Non-window keys the endpoint returns (`limits`, `extra_usage`, …) are
 * dropped HERE rather than forwarded: this result is serialized into a
 * container's environment, so it carries only what the sample rows need.
 */
export async function fetchSlotUsage(
  token: string,
  opts: FetchSlotUsageOptions,
): Promise<Record<string, SlotUsageWindowReading>> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(opts.url ?? OAUTH_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // No `cause` on purpose — here the cause IS the leak. fetch()'s TypeError
      // for a malformed header value quotes that value, and the value is
      // `Bearer <token>`; an attached cause travels with the error into every
      // logger and stack print. The class name is all a caller can act on.
      // PR #811 review F1.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`usage pull transport error: ${sanitizedErrorName(err)}`);
    }
    if (res.status === 429) {
      throw new SlotUsageRateLimited(parseRetryAfterMs(res.headers.get('retry-after'), now()));
    }
    if (!res.ok) throw new Error(`usage pull HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // Same reason as above: a JSON parse error quotes the body it choked on,
      // and this response was fetched under a bearer token; nothing but the
      // class name may escape.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`usage pull body unreadable: ${sanitizedErrorName(err)}`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('usage pull returned a non-object body');
    }
    const windows: Record<string, SlotUsageWindowReading> = {};
    for (const [name, raw] of Object.entries(body as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const w = raw as { utilization?: unknown; resets_at?: unknown };
      if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
      windows[name] = {
        utilization: w.utilization,
        resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
      };
    }
    return windows;
  } finally {
    clearTimeout(timer);
  }
}

export interface SlotUsageSurveyDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Refresh every slot that is due. Sequential on purpose: these are background
 * requests with no latency budget, and serializing them keeps the fleet from
 * presenting six simultaneous connections for six different identities.
 *
 * Never rejects. Never throws. A slot that fails keeps its previous reading
 * (the consumer ages it out) and is retried after the ordinary interval; a
 * slot that is 429'd is parked for the window the server named.
 *
 * A slot whose CREDENTIAL has changed since the last pass starts over: the
 * reading, the interval and the 429 park all belong to the account that earned
 * them. Inheriting them would make a freshly-installed account serve the old
 * one's utilization and sit out the old one's penalty, and the rate limit is
 * per identity (see the header), so a new identity genuinely has its own
 * budget. The reset is bounded by how often an operator edits `.env`, which is
 * human-scale — not by the spawn rate this whole module exists to decouple
 * from.
 */
export async function refreshSlotUsageSurvey(
  credentialSet: string,
  slots: readonly RingSlot[],
  deps: SlotUsageSurveyDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SLOT_USAGE_PULL_TIMEOUT_MS;
  for (const slot of slots) {
    const key = stateKey(credentialSet, slot.name);
    const fingerprint = credentialFingerprint(slot.value);
    const at = now();
    const existing = slotStates.get(key);
    const state: SlotState =
      existing && existing.fingerprint === fingerprint ? existing : { fingerprint, lastAttemptAt: 0, blockedUntil: 0 };
    if (at < state.blockedUntil) continue;
    if (at - state.lastAttemptAt < SLOT_USAGE_SURVEY_MIN_INTERVAL_MS) continue;
    // Advance BEFORE awaiting, so a slow pull cannot let a second one stack up
    // behind it (same reason the in-turn pull does).
    state.lastAttemptAt = at;
    slotStates.set(key, state);
    try {
      const rateLimits = await fetchSlotUsage(slot.value, { fetchImpl: deps.fetchImpl, timeoutMs, now });
      // The result belongs to the credential it was fetched WITH, which is the
      // one `state.fingerprint` names — so publishing it here can never attach
      // A's numbers to B's slot even if `.env` was swapped mid-flight: a reader
      // holding B's token compares fingerprints and sees nothing. What must not
      // happen is this pass writing back over a state some LATER pass already
      // replaced, which is the check-then-act shape #812 recorded. So write only
      // while we are still the state this key holds.
      if (slotStates.get(key) !== state) continue;
      state.entry = { fetchedAt: new Date(now()).toISOString(), rateLimits };
      state.blockedUntil = 0;
    } catch (err) {
      // Same rule as the success path: a park earned by THIS credential must
      // not be written back over a state a later pass installed for a different
      // one, or a replaced account's penalty would land on its successor.
      if (slotStates.get(key) !== state) continue;
      if (err instanceof SlotUsageRateLimited) {
        const backoff =
          err.retryAfterMs === null
            ? SLOT_USAGE_429_DEFAULT_BACKOFF_MS
            : Math.min(Math.max(err.retryAfterMs, SLOT_USAGE_SURVEY_MIN_INTERVAL_MS), SLOT_USAGE_429_MAX_BACKOFF_MS);
        state.blockedUntil = now() + backoff;
        log.warn('Slot usage pull rate limited — parking the slot', {
          credentialSet,
          slot: slot.name,
          backoffMs: backoff,
        });
      } else {
        log.warn('Slot usage pull failed', {
          credentialSet,
          slot: slot.name,
          // Sanitized at the source; see fetchSlotUsage.
          err: err instanceof Error ? err.message : sanitizedErrorName(err),
        });
      }
      slotStates.set(key, state);
    }
  }
}

/**
 * The survey a spawning container should carry, plus the background refresh
 * that fills it in for the NEXT spawn.
 *
 * Reads are never blocked on the network: the first Claude spawn after a host
 * restart gets `{}` and keeps the slot it restored (pre-0.6 behaviour), and
 * the refresh it kicks off is in place well before the interval elapses.
 * `refreshed` never rejects, so callers may ignore it; tests await it.
 */
export function slotUsageSurveyForSpawn(
  credentialSet: string,
  slots: readonly RingSlot[],
  deps: SlotUsageSurveyDeps = {},
): { survey: SlotUsageSurvey; refreshed: Promise<void> } {
  const survey: SlotUsageSurvey = {};
  for (const slot of slots) {
    const state = slotStates.get(stateKey(credentialSet, slot.name));
    // A reading is evidence about a CREDENTIAL, not about a slot name. The
    // caller has just re-resolved this slot's token from `.env`, so if the
    // fingerprints differ the account behind the name was replaced and the
    // reading describes somebody else: absent, not stale-but-usable. Handing it
    // over would rank the new account on the old one's utilization and file the
    // old one's numbers against the new one's slot. (PR #821 review r1.)
    if (!state || state.fingerprint !== credentialFingerprint(slot.value)) continue;
    if (state.entry) survey[slot.name] = state.entry;
  }

  // One refresh per credential set at a time. Without this a burst of spawns
  // would each start their own pass; the per-slot interval would still bound
  // the REQUESTS, but the passes would interleave for no reason.
  //
  // A joiner rides the in-flight pass, which means it rides the FIRST caller's
  // `slots` and `deps`. That is sound because the key is the credential set and
  // every spawn on one set resolves the same ring from the same `.env`
  // (`resolveAnthropicAuth` -> `ringSlotsForSurvey`); if that ever stops being
  // true, key this map on the ring as well, not just the set.
  let refreshed = inFlight.get(credentialSet);
  if (!refreshed) {
    refreshed = refreshSlotUsageSurvey(credentialSet, slots, deps)
      .catch((err: unknown) => {
        // refreshSlotUsageSurvey already swallows per-slot failures; this is
        // the belt for anything structural. A telemetry refresh must never
        // become an unhandled rejection that takes the host down.
        log.warn('Slot usage survey refresh failed', { credentialSet, err: sanitizedErrorName(err) });
      })
      .finally(() => {
        inFlight.delete(credentialSet);
      });
    inFlight.set(credentialSet, refreshed);
  }
  return { survey, refreshed };
}

/** JSON for `NANOCLAW_SLOT_USAGE_SURVEY`. Always a valid object, `{}` when cold. */
export function encodeSlotUsageSurvey(survey: SlotUsageSurvey): string {
  return JSON.stringify(survey);
}

/** Test-only: drop every cached reading, backoff and in-flight pass. */
export function _resetSlotUsageSurveyForTesting(): void {
  slotStates.clear();
  inFlight.clear();
}
