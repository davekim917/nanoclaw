/**
 * Lightweight Haiku calls for host-side utility tasks (titles, classification, reranking), straight to
 * `/v1/messages` over the OneCLI gateway proxy; the systemd unit's placeholder token is swapped by the gateway.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { readEnvFileMatching } from './env.js';
import { log } from './log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let _envProxyDispatcher: Dispatcher | null | undefined;
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

/** Anthropic errors are `{ error: { type, message } }`; a non-JSON body still yields status and retry timing. */
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

const PROVIDER_MESSAGE_LOG_MAX_CHARS = 300;

function truncateProviderMessage(message: string | null): string | null {
  if (message === null || message.length <= PROVIDER_MESSAGE_LOG_MAX_CHARS) return message;
  return `${message.slice(0, PROVIDER_MESSAGE_LOG_MAX_CHARS)}...`;
}

const RATE_LIMIT_UNIFIED_HEADER_PREFIX = 'anthropic-ratelimit-unified-';

function rateLimitUnifiedHeaders(headers: Headers): Record<string, string> | null {
  const found: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(RATE_LIMIT_UNIFIED_HEADER_PREFIX)) found[name] = value;
  });
  return Object.keys(found).length > 0 ? found : null;
}

export interface CallHaikuHttpErrorDetails {
  providerErrorType?: string | null;
  retryAfterHeader?: string | null;
  rateLimitUnifiedHeaders?: Record<string, string> | null;
}

export class CallHaikuHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly providerMessage: string | null;
  readonly providerErrorType: string | null;
  readonly retryAfterHeader: string | null;
  readonly rateLimitUnifiedHeaders: Record<string, string> | null;

  constructor(
    status: number,
    retryAfterMs: number | null,
    providerMessage: string | null = null,
    details: CallHaikuHttpErrorDetails = {},
  ) {
    const providerErrorType = details.providerErrorType ?? null;
    const shownMessage = truncateProviderMessage(providerMessage);
    super(
      `callHaiku: Anthropic returned ${status}` +
        (providerErrorType ? ` ${providerErrorType}` : '') +
        (shownMessage ? `: ${shownMessage}` : ''),
    );
    this.name = 'CallHaikuHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.providerMessage = providerMessage;
    this.providerErrorType = providerErrorType;
    this.retryAfterHeader = details.retryAfterHeader ?? null;
    this.rateLimitUnifiedHeaders = details.rateLimitUnifiedHeaders ?? null;
  }
}

/** Shared by every single-credential Anthropic caller so a 429 is parsed identically for the classifier. */
export async function anthropicCredentialHttpError(response: Response): Promise<CallHaikuHttpError> {
  const { providerErrorType, providerMessage } = await parseAnthropicErrorBody(response);
  const retryAfterHeader = response.headers.get('retry-after');
  return new CallHaikuHttpError(response.status, parseRetryAfterMs(retryAfterHeader), providerMessage, {
    providerErrorType,
    retryAfterHeader,
    rateLimitUnifiedHeaders: rateLimitUnifiedHeaders(response.headers),
  });
}

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
 * One attempt per slot: more multiplies requests across slots and concurrent title-sweep callers enough to
 * rate-limit healthy credentials. The 60s host sweep is the real retry mechanism for this background work.
 */
const CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT = 1;
const CREDENTIAL_ROTATION_BACKOFF_BASE_MS = 1000;
/** Caps any same-slot backoff sleep; a long `retry-after` is handled by parking, never by sleeping. */
const CREDENTIAL_ROTATION_BACKOFF_CAP_MS = 2_000;

/** A `retry-after` above this means the credential itself is out (seen: 41 hours), not a busy backend. */
const CREDENTIAL_PARK_THRESHOLD_MS = 60_000;

/** Parked slots → eligible-again time. Module-level: shared by every rotation caller in this process. */
const parkedSlotUntilMs = new Map<ClaudeCredentialSlot, number>();

/**
 * Parks never exceed this even when `retry-after` claims hours: behind the request gate a 15-minute re-probe is
 * cheap, and the cap keeps a misread short-window limit from blackholing a healthy credential all day.
 */
const CREDENTIAL_PARK_CEILING_MS = 15 * 60_000;

function isSlotParked(slot: ClaudeCredentialSlot, nowMs: number): boolean {
  const until = parkedSlotUntilMs.get(slot);
  if (until === undefined) return false;
  if (nowMs >= until) {
    parkedSlotUntilMs.delete(slot);
    return false;
  }
  return true;
}

/** Logs the slot name and response-side diagnostics only, never a request header or token value. */
function parkSlot(
  slot: ClaudeCredentialSlot,
  retryAfterMs: number,
  nowMs: number,
  logLabel: string,
  err: unknown,
): void {
  const untilMs = nowMs + Math.min(retryAfterMs, CREDENTIAL_PARK_CEILING_MS);
  parkedSlotUntilMs.set(slot, untilMs);
  const failure = err as Partial<CallHaikuHttpError>;
  log.warn(`${logLabel}: parking exhausted credential slot`, {
    slot,
    untilIso: new Date(untilMs).toISOString(),
    status: failure.status ?? null,
    retryAfterMs,
    retryAfterHeader: failure.retryAfterHeader ?? null,
    providerErrorType: failure.providerErrorType ?? null,
    providerMessage: truncateProviderMessage(failure.providerMessage ?? null),
    rateLimitUnifiedHeaders: failure.rateLimitUnifiedHeaders ?? null,
  });
}

export function __getParkedUntilMsForTest(slot: ClaudeCredentialSlot): number | undefined {
  return parkedSlotUntilMs.get(slot);
}

export function __resetCredentialParkingForTest(): void {
  parkedSlotUntilMs.clear();
}

/** How long the last good slot is tried first; after it, rotation resets so a refilled slot 1 is used again. */
const CREDENTIAL_ROTATION_STICKY_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Failure classes with opposite cures:
 *  - `transient`: busy backend (529, network, abort/timeout, 429 WITH `retry-after`) — every credential hits it,
 *    so back off and retry the SAME slot.
 *  - `quota-exhausted`: this credential is out (429 with NO `retry-after`, Anthropic's actual shape, or an explicit
 *    body) — rotate immediately.
 *  - `fatal`: anything else.
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

/** Module-level: "which credential is alive" is shared by every rotation caller in this process. */
let lastGoodCredentialSlot: ClaudeCredentialSlot | null = null;
let lastGoodCredentialSlotAt = 0;

export function __resetCallHaikuSlotCacheForTest(): void {
  lastGoodCredentialSlot = null;
  lastGoodCredentialSlotAt = 0;
}

function orderCredentialsFromLastGood(credentials: StructuredCredential[], now: number): StructuredCredential[] {
  if (lastGoodCredentialSlot !== null && now - lastGoodCredentialSlotAt >= CREDENTIAL_ROTATION_STICKY_MS) {
    lastGoodCredentialSlot = null;
  }
  if (lastGoodCredentialSlot === null) return credentials;
  const stickyIndex = credentials.findIndex((credential) => credential.slot === lastGoodCredentialSlot);
  if (stickyIndex <= 0) return credentials;
  return [...credentials.slice(stickyIndex), ...credentials.slice(0, stickyIndex)];
}

/** Every slot is parked; fails fast with no sleep, since the 60s sweep retries once a park lapses. */
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

/** Minimum spacing between the STARTS of consecutive gated calls. */
const CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS = 1000;

/** Queue-wait budget: background callers retry on the next sweep tick rather than pile up. */
const CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS = 30_000;

/** Max time one call may hold the gate; past it the call is treated as hung so it cannot starve later callers. */
const CREDENTIAL_ROTATION_GATE_MAX_HOLD_MS = 120_000;

/** `null` means the real constant. */
let _gateMinIntervalMsOverride: number | null = null;

export function __setCredentialRotationGateMinIntervalForTest(ms: number | null): void {
  _gateMinIntervalMsOverride = ms;
}

function gateMinIntervalMs(): number {
  return _gateMinIntervalMsOverride ?? CREDENTIAL_ROTATION_GATE_MIN_INTERVAL_MS;
}

export class CredentialRotationGateTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(
      `callWithCredentialRotation: queued ${waitedMs}ms without a turn (cap ${CREDENTIAL_ROTATION_GATE_MAX_WAIT_MS}ms) — too many concurrent host utility LLM calls`,
    );
    this.name = 'CredentialRotationGateTimeoutError';
  }
}

export class CredentialRotationGateHoldTimeoutError extends Error {
  constructor(logLabel: string) {
    super(`${logLabel}: held the host LLM gate past ${CREDENTIAL_ROTATION_GATE_MAX_HOLD_MS}ms — abandoned as hung`);
    this.name = 'CredentialRotationGateHoldTimeoutError';
  }
}

/**
 * Process-wide serialization of every rotation call (at most one in flight, starts spaced by the min interval):
 * concurrent background callers bursting on each sweep tick tripped per-account rate limits on healthy slots.
 * Promise-chain mutex: a caller that times out in the queue must still pass the baton only once its true
 * predecessor finishes, never early. `fn` releases in `finally` and is raced against the max hold, so neither a
 * throw nor a hang deadlocks the queue.
 */
let gateTail: Promise<void> = Promise.resolve();
let gateLastStartMs = 0;

export function __resetCredentialRotationGateForTest(): void {
  gateTail = Promise.resolve();
  gateLastStartMs = 0;
  _gateMinIntervalMsOverride = null;
}

/** Always clears its timer so the loser never fires or leaks. */
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

async function withCredentialRotationGate<T>(logLabel: string, fn: () => Promise<T>): Promise<T> {
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
    // Pass the baton only once the true predecessor finishes, never early.
    void previousTail.then(releaseMine, releaseMine);
    throw new CredentialRotationGateTimeoutError(Date.now() - enqueuedAtMs);
  }

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

  const startedAtMs = Date.now();
  gateLastStartMs = startedAtMs;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const holdExpired = new Promise<never>((_, reject) => {
    holdTimer = setTimeout(() => {
      log.warn('Host LLM gate: call exceeded max hold — releasing the gate', {
        logLabel,
        heldMs: Date.now() - startedAtMs,
      });
      reject(new CredentialRotationGateHoldTimeoutError(logLabel));
    }, CREDENTIAL_ROTATION_GATE_MAX_HOLD_MS);
  });
  try {
    return await Promise.race([fn(), holdExpired]);
  } finally {
    clearTimeout(holdTimer);
    releaseMine();
  }
}

/**
 * The ONE credential-rotation policy for host Anthropic callers: `attempt` runs one request against one
 * credential, serialized by {@link withCredentialRotationGate}.
 *  - `retry-after` above {@link CREDENTIAL_PARK_THRESHOLD_MS}: the slot is parked for this and later calls. Only
 *    when every slot is already parked at the start does it throw {@link AllCredentialSlotsParkedError} (no sleep);
 *    slots parked during the call end in the last request error.
 *  - transient: retry the SAME slot (default one attempt; backoff honors `retry-after`, else capped exponential
 *    with jitter, never over the cap).
 *  - quota-exhausted: next slot, no sleep. fatal: throw at once.
 * Throws the last error once every slot is exhausted. The last good slot is shared with every caller. Logs slot
 * names only, never token values.
 */
export async function callWithCredentialRotation<T>(options: {
  attempt: (credential: StructuredCredential) => Promise<T>;
  logLabel: string;
  noCredentialsMessage: string;
  classify?: (err: unknown) => CredentialFailureClass;
  env?: NodeJS.ProcessEnv;
  envFile?: Record<string, string>;
}): Promise<{ value: T; slot: ClaudeCredentialSlot }> {
  return withCredentialRotationGate(options.logLabel, () => callWithCredentialRotationAttempt(options));
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
  // Snapshot BEFORE isSlotParked's lazy expiry deletes lapsed entries, so success can log a recovery.
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
          parkSlot(credential.slot, retryAfterMs, Date.now(), options.logLabel, err);
          break;
        }

        if (failureClass === 'quota-exhausted') {
          log.warn(`${options.logLabel}: credential slot quota exhausted, rotating`, {
            fromSlot: credential.slot,
            toSlot: available[slotPos + 1]?.slot ?? null,
            status: (err as { status?: number }).status,
          });
          break;
        }

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

/** One request per configured key, in order; the first success wins. Deliberately outside the shared gate and parking. */
export async function callHaiku(prompt: string, timeoutMs = 15_000): Promise<string> {
  const credentials = structuredCredentials(process.env, defaultStructuredCredentialEnvFile(process.env));
  if (credentials.length === 0) {
    throw new Error(
      'callHaiku: no Anthropic credentials configured (set ANTHROPIC_API_KEY or a CLAUDE_CODE_OAUTH_TOKEN slot)',
    );
  }
  let lastErr: unknown;
  for (const credential of credentials) {
    try {
      return await callHaikuOnce(prompt, timeoutMs, credential);
    } catch (err) {
      lastErr = err;
      log.warn('callHaiku: key failed, trying the next one', { slot: credential.slot, err: (err as Error).message });
    }
  }
  throw lastErr;
}
