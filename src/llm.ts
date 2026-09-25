/**
 * Lightweight Haiku calls for host-side utility tasks (thread titles,
 * topic classification, search reranking).
 *
 * Goes straight to Anthropic's `/v1/messages` over the OneCLI gateway
 * proxy — the same path `src/dashboard/session-title-sweep.ts` uses in
 * this host process, so the proxy + OAuth-token env is already
 * wired (the systemd unit sets HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN=
 * placeholder; the gateway swaps the placeholder for the vault token).
 *
 * Previously this shelled out to `claude -p --model haiku`. That spawned
 * the whole interactive CLI per call and failed ~45% of the time with
 * opaque non-zero exits (empty stderr — not timeouts, not rate limits,
 * just CLI flakiness). A single HTTP call is far lighter and its failures
 * are classifiable (429 / timeout) so we can retry the transient ones.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { readEnvFileMatching } from './env.js';
import { log } from './log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Lazy-init proxy dispatcher — mirrors session-title-sweep.ts. Resolved on
// first call so a service restart after env changes Just Works.
let _envProxyDispatcher: Dispatcher | null | undefined;
/** The OneCLI gateway proxy dispatcher for host calls to external APIs, or null without proxy env. */
export function getProxyDispatcher(): Dispatcher | null {
  if (_envProxyDispatcher !== undefined) return _envProxyDispatcher;
  const hasProxyEnv = !!(
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
  _envProxyDispatcher = hasProxyEnv ? new EnvHttpProxyAgent() : null;
  return _envProxyDispatcher;
}

export type ClaudeCredentialSlot = 'oauth:primary' | `oauth:${number}` | 'api-key:primary';

/**
 * Exported so other host-side Anthropic callers (e.g.
 * `src/dashboard/session-title-sweep.ts`) can type the credential their
 * {@link callWithCredentialRotation} `attempt` callback receives, without
 * re-deriving credential shape themselves.
 */
export interface StructuredCredential {
  slot: ClaudeCredentialSlot;
  headers: Record<string, string>;
  authEnv: {
    name: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
    value: string;
  };
}

const ONECLI_CREDENTIAL_PLACEHOLDER = 'placeholder';

function structuredCredentials(env: NodeJS.ProcessEnv, envFile: Record<string, string> = {}): StructuredCredential[] {
  const effectiveEnv = { ...env, ...envFile };
  const oauthCandidates: Array<{ slot: ClaudeCredentialSlot; value: string; order: number }> = [];
  const primaryOauth = effectiveEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? '';
  if (primaryOauth && primaryOauth !== ONECLI_CREDENTIAL_PLACEHOLDER) {
    oauthCandidates.push({ slot: 'oauth:primary', value: primaryOauth, order: 0 });
  }
  for (const [key, rawValue] of Object.entries(effectiveEnv)) {
    const match = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/.exec(key);
    const value = rawValue?.trim() ?? '';
    if (!match || !value || value === ONECLI_CREDENTIAL_PLACEHOLDER) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) continue;
    oauthCandidates.push({ slot: `oauth:${index}`, value, order: index });
  }
  oauthCandidates.sort((a, b) => a.order - b.order);
  const seenOauth = new Set<string>();
  const oauth = oauthCandidates.flatMap(({ slot, value }) => {
    if (seenOauth.has(value)) return [];
    seenOauth.add(value);
    return [
      {
        slot,
        headers: { authorization: `Bearer ${value}`, 'anthropic-beta': 'oauth-2025-04-20' },
        authEnv: { name: 'CLAUDE_CODE_OAUTH_TOKEN' as const, value },
      },
    ];
  });
  if (oauth.length > 0) return oauth;

  const directApiKey = effectiveEnv.ANTHROPIC_API_KEY?.trim() ?? '';
  return directApiKey && directApiKey !== ONECLI_CREDENTIAL_PLACEHOLDER
    ? [
        {
          slot: 'api-key:primary',
          headers: { 'x-api-key': directApiKey },
          authEnv: { name: 'ANTHROPIC_API_KEY' as const, value: directApiKey },
        },
      ]
    : [];
}

function defaultStructuredCredentialEnvFile(env: NodeJS.ProcessEnv): Record<string, string> {
  return env === process.env ? readEnvFileMatching(/^(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(?:_\d+)?$/) : {};
}

export function listClaudeStructuredCredentialSlots(
  env: NodeJS.ProcessEnv = process.env,
  envFile: Record<string, string> = defaultStructuredCredentialEnvFile(env),
): ClaudeCredentialSlot[] {
  return structuredCredentials(env, envFile).map((credential) => credential.slot);
}

/**
 * Anthropic error responses are `{ error: { type, message } }`. Used by
 * {@link anthropicCredentialHttpError} — a
 * non-JSON body still leaves status, retry timing, and request id to make
 * the failure actionable.
 */
async function parseAnthropicErrorBody(
  response: Response,
): Promise<{ providerErrorType: string | null; providerMessage: string | null }> {
  try {
    const body = (await response.json()) as {
      error?: { type?: unknown; message?: unknown };
    };
    return {
      providerErrorType: typeof body.error?.type === 'string' ? body.error.type : null,
      providerMessage: typeof body.error?.message === 'string' ? body.error.message : null,
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { providerErrorType: null, providerMessage: null };
  }
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

/** HTTP failure from {@link callHaikuOnce}. */
export class CallHaikuHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly providerMessage: string | null;

  constructor(status: number, retryAfterMs: number | null, providerMessage: string | null = null) {
    super(`callHaiku: Anthropic returned ${status}`);
    this.name = 'CallHaikuHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.providerMessage = providerMessage;
  }
}

/**
 * Builds a {@link CallHaikuHttpError} from a non-ok Anthropic response.
 * Shared by every single-credential Anthropic-messages caller that plugs
 * into {@link callWithCredentialRotation} — `callHaikuOnce` below and
 * `session-title-sweep.ts`'s `callTitleBackendOnce` — so a 429's
 * retry-after/provider-message shape is parsed identically everywhere
 * {@link classifyCredentialFailure} needs to read it.
 */
export async function anthropicCredentialHttpError(response: Response): Promise<CallHaikuHttpError> {
  const { providerMessage } = await parseAnthropicErrorBody(response);
  return new CallHaikuHttpError(
    response.status,
    parseRetryAfterMs(response.headers.get('retry-after')),
    providerMessage,
  );
}

/**
 * Single request against one resolved credential. No retry/rotation policy
 * lives here — that's {@link callHaiku}'s job. Slot vocabulary, placeholder
 * filtering, and `.env`-file merging come from the `credential` the caller
 * resolved through {@link structuredCredentials}.
 */
async function callHaikuOnce(prompt: string, timeoutMs: number, credential: StructuredCredential): Promise<string> {
  const baseUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com';

  const dispatcher = getProxyDispatcher();
  const fetchImpl: typeof fetch = dispatcher
    ? (url, init) =>
        undiciFetch(
          url as string,
          { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
        ) as unknown as Promise<Response>
    : fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credential.headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 80,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw await anthropicCredentialHttpError(resp);
    }
    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content?.find((c) => c.type === 'text')?.text ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded per-slot attempts + backoff shared by every
 * {@link callWithCredentialRotation} caller (`callHaiku` below and
 * `session-title-sweep.ts`'s title generation).
 *
 * Defaults to ONE attempt per slot. This used to be 4: a single failed call
 * could burn `4 attempts x N slots` requests (16 for a 4-slot install) before
 * giving up, and `session-title-sweep.ts` runs up to
 * {@link import('./dashboard/session-title-sweep.js').CONCURRENCY_CAP}
 * of these concurrently — ~80 req/min against a handful of accounts, enough
 * to rate-limit credentials that were otherwise healthy. Rotation across
 * slots is meant to be fast and cheap; the 60s host-sweep tick (not
 * in-process backoff) is the real retry mechanism for this background work.
 * Kept as a named, tunable constant rather than inlined `1` so a caller with
 * a genuine need for same-slot retries (none today) has an obvious knob.
 */
const CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT = 1;
const CREDENTIAL_ROTATION_BACKOFF_BASE_MS = 1000;
/**
 * Lowered from 15s to 2s alongside the attempts default above — even if a
 * caller bumps {@link CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT} above 1 for
 * a genuine same-slot-retry need (529 / network blip), a single call must
 * never sleep more than a couple of seconds in total. A long `retry-after`
 * (the "this credential is out of quota for hours" shape) is handled by
 * parking below, never by sleeping through it.
 */
const CREDENTIAL_ROTATION_BACKOFF_CAP_MS = 2_000;

/**
 * A `retry-after` at or below this means "the backend is briefly busy" —
 * cheap to retry once. Above it, the credential itself is the problem (a
 * subscription that won't refill for hours, observed as `retry-after=149184`
 * — 41 hours), and retrying it at all just burns quota for nothing.
 */
const CREDENTIAL_PARK_THRESHOLD_MS = 60_000;

/**
 * Slots parked because they returned a `retry-after` longer than
 * {@link CREDENTIAL_PARK_THRESHOLD_MS}, keyed to when they become eligible
 * again. Module-level (like {@link lastGoodCredentialSlot} below) because
 * "which slots are currently dead" is one fact shared by every
 * {@link callWithCredentialRotation} caller in this process, not something
 * `callHaiku` and the session-title sweep should each rediscover — and burn
 * a request finding out — independently against the same underlying quota.
 */
const parkedSlotUntilMs = new Map<ClaudeCredentialSlot, number>();

/**
 * A park never lasts longer than this, even when `retry-after` claims hours
 * (observed: `retry-after=149184` — 41 hours). Before the global request
 * gate (see {@link withCredentialRotationGate}) existed, a short park was
 * "safe" because every caller hammered every slot on every call anyway; now
 * that the gate serializes and spaces every request, re-probing a genuinely
 * dead slot once every 15 minutes costs nothing, and capping the park keeps
 * a SHORT-WINDOW rate limit (a few hundred seconds, misclassified as "hours
 * dead" only because the account also happened to return a long
 * `retry-after`) from blackholing an otherwise-healthy credential for the
 * rest of the day.
 */
const CREDENTIAL_PARK_CEILING_MS = 15 * 60_000;

/** True while `slot` is parked (skip it entirely) as of `nowMs`. Lazily expires the entry once its window has passed. */
function isSlotParked(slot: ClaudeCredentialSlot, nowMs: number): boolean {
  const until = parkedSlotUntilMs.get(slot);
  if (until === undefined) return false;
  if (nowMs >= until) {
    parkedSlotUntilMs.delete(slot);
    return false;
  }
  return true;
}

/**
 * Park `slot` until `nowMs + min(retryAfterMs, CREDENTIAL_PARK_CEILING_MS)`,
 * logging once for this occurrence (slot name only — never a token value).
 */
function parkSlot(slot: ClaudeCredentialSlot, retryAfterMs: number, nowMs: number, logLabel: string): void {
  const untilMs = nowMs + Math.min(retryAfterMs, CREDENTIAL_PARK_CEILING_MS);
  parkedSlotUntilMs.set(slot, untilMs);
  log.warn(`${logLabel}: parking exhausted credential slot`, { slot, untilIso: new Date(untilMs).toISOString() });
}

/** Test hook — reads a slot's current park-until timestamp (epoch ms), or undefined if it isn't currently parked. */
export function __getParkedUntilMsForTest(slot: ClaudeCredentialSlot): number | undefined {
  return parkedSlotUntilMs.get(slot);
}

/** Test hook — clears parked-slot state so tests start with every slot eligible. */
export function __resetCredentialParkingForTest(): void {
  parkedSlotUntilMs.clear();
}

/**
 * How long a slot stays "sticky" (tried first) after it last succeeded.
 * After this, rotation resets to the front of the configured list so a
 * recovered slot 1 gets used again — subscription quotas refill on a
 * schedule, they aren't permanently dead.
 */
const CREDENTIAL_ROTATION_STICKY_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two failure classes with opposite cures — conflating them is what let
 * slot 1's exhausted quota wedge every host utility call indefinitely while
 * three healthy credentials sat unused:
 *
 *  - `transient`: the backend itself is busy (529, network blip, an aborted/
 *    timed-out request, or a 429 that carries a `retry-after`). Every
 *    credential hits the same busy backend, so rotating is useless — back
 *    off and retry the SAME slot.
 *  - `quota-exhausted`: this credential specifically is out of quota (a 429
 *    with no `retry-after` at all — the shape Anthropic actually returns for
 *    this — or a body that says so explicitly). Backing off here just delays
 *    the inevitable; rotate to the next slot immediately instead.
 *  - `fatal`: anything else (4xx that isn't a rate limit, etc.) — no amount
 *    of retrying or rotating helps.
 *
 * This is {@link callWithCredentialRotation}'s default classifier — every
 * caller gets the same cure for the same failure shape unless it has a
 * genuinely different failure vocabulary to classify.
 */
type CredentialFailureClass = 'transient' | 'quota-exhausted' | 'fatal';

const QUOTA_EXHAUSTED_BODY_RE = /usage limit|quota exceeded|exceeded your (?:usage|spend(?:ing)?|token|credit) limit/i;

function classifyCredentialFailure(err: unknown): CredentialFailureClass {
  const status = (err as { status?: number }).status;
  const name = (err as Error).name;
  if (name === 'AbortError' || !status || status === 529) return 'transient';
  if (status === 429) {
    const providerMessage = (err as { providerMessage?: string | null }).providerMessage;
    if (providerMessage && QUOTA_EXHAUSTED_BODY_RE.test(providerMessage)) return 'quota-exhausted';
    const retryAfterMs = (err as { retryAfterMs?: number | null }).retryAfterMs;
    return retryAfterMs != null ? 'transient' : 'quota-exhausted';
  }
  return 'fatal';
}

/**
 * Last credential slot that answered successfully, and when — see
 * {@link CREDENTIAL_ROTATION_STICKY_MS}. Deliberately module-level (not
 * per-caller): "which credential is alive" is one concern shared by every
 * {@link callWithCredentialRotation} caller in this process, not a fact
 * `callHaiku` and the session-title sweep should each rediscover on their
 * own against the same underlying quota.
 */
let lastGoodCredentialSlot: ClaudeCredentialSlot | null = null;
let lastGoodCredentialSlotAt = 0;

/** Test hook — clears the sticky-slot cache so each test starts from the front of the list. */
export function __resetCallHaikuSlotCacheForTest(): void {
  lastGoodCredentialSlot = null;
  lastGoodCredentialSlotAt = 0;
}

/**
 * Order credentials starting from the last-known-good slot (wrapping
 * around) so a call doesn't re-fail through an already-exhausted slot 1 on
 * every single invocation. Falls back to the configured order when there's
 * no sticky slot, the sticky slot has aged out, or it's no longer present
 * in the resolved credential list.
 */
function orderCredentialsFromLastGood(credentials: StructuredCredential[], now: number): StructuredCredential[] {
  if (lastGoodCredentialSlot !== null && now - lastGoodCredentialSlotAt >= CREDENTIAL_ROTATION_STICKY_MS) {
    lastGoodCredentialSlot = null;
  }
  if (lastGoodCredentialSlot === null) return credentials;
  const stickyIndex = credentials.findIndex((credential) => credential.slot === lastGoodCredentialSlot);
  if (stickyIndex <= 0) return credentials;
  return [...credentials.slice(stickyIndex), ...credentials.slice(0, stickyIndex)];
}

/**
 * Thrown by {@link callWithCredentialRotation} when every configured
 * credential slot is currently parked (see {@link parkedSlotUntilMs}) — none
 * are even attempted. This is deliberately NOT a retryable condition from
 * this function's point of view: it fails fast, no sleep, because the caller
 * is background work (a thread/session title) and the host's 60s sweep will
 * naturally retry once a slot's park window lapses.
 */
export class AllCredentialSlotsParkedError extends Error {
  readonly nextAvailableAt: Date | null;
  constructor(logLabel: string, nextAvailableAt: Date | null) {
    super(
      `${logLabel}: every credential slot is parked` +
        (nextAvailableAt ? ` — next available at ${nextAvailableAt.toISOString()}` : ''),
    );
    this.name = 'AllCredentialSlotsParkedError';
    this.nextAvailableAt = nextAvailableAt;
  }
}

/**
 * Minimum spacing enforced between the START of consecutive
 * {@link callWithCredentialRotation} calls — see
 * {@link withCredentialRotationGate}. Named/tunable rather than inlined
 * since it is a process-wide cadence limit, not a per-caller setting.
 */
const CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS = 1000;

/**
 * A call queued behind {@link withCredentialRotationGate} for longer than
 * this fails fast instead of piling up indefinitely — background callers
 * (`callHaiku`, `session-title-sweep.ts`) simply retry on the next 60s
 * host-sweep tick, so there is no reason to let a caller sit in this queue
 * for tens of seconds.
 */
const CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS = 30_000;

/**
 * Test-only override for {@link CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS}.
 * Real spacing is 1s of wall-clock time; most tests don't care about gate
 * timing at all and would otherwise need to advance fake timers between
 * every single call. `null` means "use the real constant".
 */
let _gateMinIntervalMsOverride: number | null = null;

/** Test hook — override the gate's minimum inter-request spacing (or pass `null` to restore the real constant). */
export function __setCredentialRotationGateMinIntervalForTest(ms: number | null): void {
  _gateMinIntervalMsOverride = ms;
}

function gateMinIntervalMs(): number {
  return _gateMinIntervalMsOverride ?? CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS;
}

/** Thrown when a call sat in {@link withCredentialRotationGate}'s queue longer than {@link CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS} without getting its turn. */
export class CredentialRotationGateTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(
      `callWithCredentialRotation: queued ${waitedMs}ms without a turn (cap ${CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS}ms) — too many concurrent host utility LLM calls`,
    );
    this.name = 'CredentialRotationGateTimeoutError';
  }
}

/**
 * Process-wide serialization for every {@link callWithCredentialRotation}
 * call. This is what actually fixes the burst-parking loop: on every 60s
 * host-sweep tick, `session-title-sweep` (up to CONCURRENCY_CAP concurrent),
 * `retryPendingThreadTitles`, and any live `maybeRenameNewThread` used to
 * all fire AT ONCE, each independently rotating across credential slots —
 * enough short-window request volume to trip per-account rate limits on
 * slots that were otherwise perfectly healthy, which then got parked for
 * hours. These are cheap background calls with no latency requirement, so
 * nothing is lost serializing them: at most one in-flight `fn` at a time,
 * spaced at least {@link CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS} apart
 * (measured from the START of the previous `fn`).
 *
 * Implemented as a promise-chain mutex (`gateTail`): each call links a new
 * "release" promise onto the tail and waits for the PREVIOUS one before
 * proceeding. A call that has waited past
 * {@link CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS} rejects immediately with
 * {@link CredentialRotationGateTimeoutError} instead of running `fn` at
 * all — but it must still hand off the baton at the RIGHT time (once its
 * true predecessor actually finishes), never early, or a later caller could
 * start running while an earlier one is still in flight. `fn` itself is
 * released in `finally` so a throwing call can never deadlock callers
 * queued behind it.
 */
let gateTail: Promise<void> = Promise.resolve();
let gateLastStartMs = 0;

/** Test hook — resets gate queue/spacing state (and the interval override) between tests. */
export function __resetCredentialRotationGateForTest(): void {
  gateTail = Promise.resolve();
  gateLastStartMs = 0;
  _gateMinIntervalMsOverride = null;
}

/** Resolves 'ok' once `promise` settles, or 'timeout' after `ms` — whichever comes first. Always clears its timer so the loser never fires or leaks. */
async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<'ok' | 'timeout'> {
  if (ms <= 0) return 'timeout';
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise.then((): 'ok' => 'ok'), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function withCredentialRotationGate<T>(fn: () => Promise<T>): Promise<T> {
  const enqueuedAtMs = Date.now();
  const previousTail = gateTail;
  let releaseMine: () => void = () => {};
  const minePromise = new Promise<void>((resolve) => {
    releaseMine = resolve;
  });
  gateTail = minePromise;

  const remainingMs = CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS - (Date.now() - enqueuedAtMs);
  const outcome = await raceTimeout(previousTail, remainingMs);
  if (outcome === 'timeout') {
    // Give up from THIS caller's point of view, but only pass the baton once
    // the true predecessor actually finishes — never early, or the caller
    // behind us could start while the real predecessor is still running.
    void previousTail.then(releaseMine, releaseMine);
    throw new CredentialRotationGateTimeoutError(Date.now() - enqueuedAtMs);
  }

  // It's genuinely our turn. Enforce minimum spacing since the last request
  // started, bounded by whatever's left of the queue-wait budget.
  const sinceLastStartMs = Date.now() - gateLastStartMs;
  const spacingWaitMs = Math.max(0, gateMinIntervalMs() - sinceLastStartMs);
  if (spacingWaitMs > 0) {
    const spacingBudgetMs = CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS - (Date.now() - enqueuedAtMs);
    if (spacingWaitMs > spacingBudgetMs) {
      releaseMine();
      throw new CredentialRotationGateTimeoutError(Date.now() - enqueuedAtMs);
    }
    await sleep(spacingWaitMs);
  }

  gateLastStartMs = Date.now();
  try {
    return await fn();
  } finally {
    releaseMine();
  }
}

/**
 * Run `attempt` against every configured Anthropic credential slot
 * (`CLAUDE_CODE_OAUTH_TOKEN[_2..4]` / `ANTHROPIC_API_KEY`, resolved via the
 * {@link structuredCredentials}) rather
 * than pinning to whichever slot the caller happened to read first.
 *
 * This is the ONE place the credential-rotation policy lives — every host
 * caller that talks to Anthropic through a rotatable credential list
 * (`callHaiku` below, and `session-title-sweep.ts`'s title generation) goes
 * through this function rather than each keeping its own copy. A second
 * copy of this loop is exactly what let slot 1's exhausted quota wedge one
 * caller forever while another had already rotated past it.
 *
 * Every call is additionally serialized process-wide by
 * {@link withCredentialRotationGate} — see its doc comment for why.
 *
 * `attempt` performs ONE request against a single resolved credential and
 * should reject on failure. A failure with a `retry-after` longer than
 * {@link CREDENTIAL_PARK_THRESHOLD_MS} means the CREDENTIAL is the problem
 * (observed: `retry-after=149184` — 41 hours) rather than a momentary busy
 * backend — that slot is parked (see {@link parkSlot}, capped at
 * {@link CREDENTIAL_PARK_CEILING_MS}) and skipped for the rest of this call
 * AND every subsequent call until its window lapses; without this a caller
 * would retry an hours-dead slot on every single invocation forever. If
 * parking empties the available list before any attempt is made, this
 * throws {@link AllCredentialSlotsParkedError} immediately — no sleep. A
 * slot that succeeds after having been parked has its park cleared (and
 * logged) immediately — see the success branch below.
 *
 * Otherwise, failures are classified by `classify` (default
 * {@link classifyCredentialFailure}) into two classes with opposite cures:
 * transient/server-overload backs off and retries the SAME slot (up to
 * {@link CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT} attempts — 1 by default,
 * so no backoff happens unless a caller opts into more; when it does, honors
 * `retry-after` when present, otherwise capped-exponential with up to 20%
 * jitter, and never sleeps more than {@link CREDENTIAL_ROTATION_BACKOFF_CAP_MS}
 * per attempt); quota-exhaustion rotates to the NEXT slot immediately with no
 * sleep. Only after every slot is exhausted does this throw — the last error
 * seen. The last slot to succeed is cached (see
 * {@link orderCredentialsFromLastGood}) so the next call — from ANY caller —
 * starts there instead of re-failing through slot 1 first.
 *
 * Fatal (non-transient, non-quota) errors throw immediately — no point
 * retrying or rotating on a 4xx that isn't a rate limit.
 *
 * `logLabel` prefixes log lines so they're attributable to the calling
 * module; only the credential's `slot` name (e.g. `oauth:2`) is ever
 * logged, never a token value.
 */
export async function callWithCredentialRotation<T>(options: {
  attempt: (credential: StructuredCredential) => Promise<T>;
  logLabel: string;
  noCredentialsMessage: string;
  classify?: (err: unknown) => CredentialFailureClass;
  env?: NodeJS.ProcessEnv;
  envFile?: Record<string, string>;
}): Promise<{ value: T; slot: ClaudeCredentialSlot }> {
  return withCredentialRotationGate(() => callWithCredentialRotationAttempt(options));
}

async function callWithCredentialRotationAttempt<T>(options: {
  attempt: (credential: StructuredCredential) => Promise<T>;
  logLabel: string;
  noCredentialsMessage: string;
  classify?: (err: unknown) => CredentialFailureClass;
  env?: NodeJS.ProcessEnv;
  envFile?: Record<string, string>;
}): Promise<{ value: T; slot: ClaudeCredentialSlot }> {
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? defaultStructuredCredentialEnvFile(env);
  const classify = options.classify ?? classifyCredentialFailure;
  const credentials = structuredCredentials(env, envFile);
  if (credentials.length === 0) {
    throw new Error(options.noCredentialsMessage);
  }
  const ordered = orderCredentialsFromLastGood(credentials, Date.now());
  const startMs = Date.now();
  // Snapshot BEFORE isSlotParked's lazy-expiry side effect deletes any entry
  // whose window has already passed — that snapshot is what lets the success
  // branch below tell "this slot just recovered from a park" apart from "this
  // slot was never parked", even though by the time an attempt actually runs
  // the map entry may already be gone.
  const wasParkedAtStart = new Set(ordered.filter((c) => parkedSlotUntilMs.has(c.slot)).map((c) => c.slot));
  const available = ordered.filter((credential) => !isSlotParked(credential.slot, startMs));
  if (available.length === 0) {
    const nextAvailableMs = ordered.reduce<number | null>((min, credential) => {
      const until = parkedSlotUntilMs.get(credential.slot);
      if (until === undefined) return min;
      return min === null ? until : Math.min(min, until);
    }, null);
    throw new AllCredentialSlotsParkedError(
      options.logLabel,
      nextAvailableMs !== null ? new Date(nextAvailableMs) : null,
    );
  }

  let lastErr: unknown;
  for (let slotPos = 0; slotPos < available.length; slotPos++) {
    const credential = available[slotPos]!;
    for (let attempt = 1; attempt <= CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT; attempt++) {
      try {
        const value = await options.attempt(credential);
        lastGoodCredentialSlot = credential.slot;
        lastGoodCredentialSlotAt = Date.now();
        if (wasParkedAtStart.has(credential.slot)) {
          parkedSlotUntilMs.delete(credential.slot);
          log.info(`${options.logLabel}: credential slot recovered, clearing park`, { slot: credential.slot });
        }
        return { value, slot: credential.slot };
      } catch (err) {
        lastErr = err;
        const failureClass = classify(err);
        if (failureClass === 'fatal') throw err;

        const retryAfterMs = (err as { retryAfterMs?: number | null }).retryAfterMs;
        if (retryAfterMs != null && retryAfterMs > CREDENTIAL_PARK_THRESHOLD_MS) {
          parkSlot(credential.slot, retryAfterMs, Date.now(), options.logLabel);
          break; // next slot immediately — this credential won't recover before the sweep's next tick anyway
        }

        if (failureClass === 'quota-exhausted') {
          log.warn(`${options.logLabel}: credential slot quota exhausted, rotating`, {
            fromSlot: credential.slot,
            toSlot: available[slotPos + 1]?.slot ?? null,
            status: (err as { status?: number }).status,
          });
          break; // next slot immediately — no backoff, quota won't recover by waiting
        }

        // transient: back off and retry the SAME slot (bounded — see
        // CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT / _BACKOFF_CAP_MS above).
        if (attempt === CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT) {
          log.warn(`${options.logLabel}: slot exhausted its transient-retry budget, trying next slot`, {
            slot: credential.slot,
            nextSlot: available[slotPos + 1]?.slot ?? null,
            status: (err as { status?: number }).status,
          });
          break;
        }
        const backoff =
          retryAfterMs != null
            ? Math.min(retryAfterMs, CREDENTIAL_ROTATION_BACKOFF_CAP_MS)
            : Math.min(CREDENTIAL_ROTATION_BACKOFF_CAP_MS, CREDENTIAL_ROTATION_BACKOFF_BASE_MS * 2 ** (attempt - 1));
        const delayMs = Math.round(backoff + Math.random() * backoff * 0.2);
        log.debug(`${options.logLabel}: transient failure, backing off`, {
          slot: credential.slot,
          attempt,
          status: (err as { status?: number }).status,
          name: (err as Error).name,
          retryAfterMs,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

/**
 * Call Haiku, rotating across every configured Anthropic credential slot via
 * {@link callWithCredentialRotation} rather than pinning to slot 1.
 *
 * Previously this retried up to {@link CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT}
 * times against a single credential read straight off `process.env`. That
 * silently lost titles under sustained rate-limit pressure (both attempts
 * landing in the same 429 window — see src/topic-title.ts and migration 062
 * for the durable fix on that side) — and once slot 1's quota was actually
 * exhausted, it failed forever while other configured credentials sat idle.
 */
export async function callHaiku(prompt: string, timeoutMs = 15_000): Promise<string> {
  const { value } = await callWithCredentialRotation({
    attempt: (credential) => callHaikuOnce(prompt, timeoutMs, credential),
    logLabel: 'callHaiku',
    noCredentialsMessage:
      'callHaiku: no Anthropic credentials configured (set ANTHROPIC_API_KEY or a CLAUDE_CODE_OAUTH_TOKEN slot)',
  });
  return value;
}
