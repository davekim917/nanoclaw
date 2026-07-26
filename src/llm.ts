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

import { log } from './log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Lazy-init proxy dispatcher — mirrors session-title-sweep.ts. Resolved on
// first call so a service restart after env changes Just Works.
let _envProxyDispatcher: Dispatcher | null | undefined;
function getProxyDispatcher(): Dispatcher | null {
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

export interface ClaudeStructuredRequest {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ClaudeCredentialSlot = 'oauth:primary' | `oauth:${number}` | 'api-key:primary';

export interface ClaudeStructuredResult<T> {
  value: T;
  model: string;
  credentialSlot: ClaudeCredentialSlot;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export type ClaudeFetch = (url: string, init: RequestInit) => Promise<Response>;

interface StructuredCredential {
  slot: ClaudeCredentialSlot;
  headers: Record<string, string>;
}

function structuredCredentials(env: NodeJS.ProcessEnv): StructuredCredential[] {
  const oauthCandidates: Array<{ slot: ClaudeCredentialSlot; value: string; order: number }> = [];
  const primaryOauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? '';
  if (primaryOauth) oauthCandidates.push({ slot: 'oauth:primary', value: primaryOauth, order: 0 });
  for (const [key, rawValue] of Object.entries(env)) {
    const match = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/.exec(key);
    const value = rawValue?.trim() ?? '';
    if (!match || !value) continue;
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
      },
    ];
  });
  if (oauth.length > 0) return oauth;

  const directApiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  return directApiKey ? [{ slot: 'api-key:primary', headers: { 'x-api-key': directApiKey } }] : [];
}

export function listClaudeStructuredCredentialSlots(env: NodeJS.ProcessEnv = process.env): ClaudeCredentialSlot[] {
  return structuredCredentials(env).map((credential) => credential.slot);
}

function resolveStructuredCredential(
  env: NodeJS.ProcessEnv,
  requestedSlot?: ClaudeCredentialSlot,
): StructuredCredential {
  const credentials = structuredCredentials(env);
  if (credentials.length === 0) {
    throw new Error('structured Claude call has no configured Anthropic credential');
  }
  if (!requestedSlot) return credentials[0]!;
  const selected = credentials.find((credential) => credential.slot === requestedSlot);
  if (!selected) {
    throw new Error(`structured Claude credential slot is unavailable: ${requestedSlot}`);
  }
  return selected;
}

export class ClaudeStructuredHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`structured Claude call returned ${status}`);
    this.name = 'ClaudeStructuredHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

/**
 * Stateless schema-constrained Claude call for host background work.
 * No tools or provider session are involved. The caller owns retry policy.
 */
export async function callClaudeStructured<T>(
  request: ClaudeStructuredRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: ClaudeFetch;
    credentialSlot?: ClaudeCredentialSlot;
  } = {},
): Promise<ClaudeStructuredResult<T>> {
  const env = options.env ?? process.env;
  const credential = resolveStructuredCredential(env, options.credentialSlot);
  const baseUrl = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const dispatcher = options.fetch ? null : getProxyDispatcher();
  const fetchImpl: ClaudeFetch =
    options.fetch ??
    ((url, init) =>
      dispatcher
        ? (undiciFetch(url, {
            ...init,
            dispatcher,
          } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
        : fetch(url, init));
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...credential.headers,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: request.effort,
          format: { type: 'json_schema', schema: request.schema },
        },
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ClaudeStructuredHttpError(response.status, parseRetryAfterMs(response.headers.get('retry-after')));
    }
    const data = (await response.json()) as {
      model?: string;
      stop_reason?: string;
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    if (data.model !== request.model) {
      throw new Error(`structured Claude model mismatch: requested ${request.model}, received ${data.model ?? 'none'}`);
    }
    if (data.stop_reason === 'refusal') throw new Error('structured Claude call was refused');
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('structured Claude call returned no text result');
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch (error) {
      throw new Error('structured Claude call returned invalid JSON', { cause: error });
    }
    return {
      value,
      model: data.model,
      credentialSlot: credential.slot,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadInputTokens: data.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: data.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

async function callHaikuOnce(prompt: string, timeoutMs: number): Promise<string> {
  const baseUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com';
  const directApiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '';
  const useOauth = !directApiKey && oauthToken;
  if (!directApiKey && !useOauth) {
    throw new Error(
      'callHaiku: no Anthropic credentials (set ANTHROPIC_API_KEY or wire HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN)',
    );
  }

  const dispatcher = getProxyDispatcher();
  const fetchImpl: typeof fetch = dispatcher
    ? (url, init) =>
        undiciFetch(
          url as string,
          { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
        ) as unknown as Promise<Response>
    : fetch;

  const authHeaders: Record<string, string> = useOauth
    ? { authorization: `Bearer ${oauthToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
    : { 'x-api-key': directApiKey };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 80,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = new Error(`callHaiku: Anthropic returned ${resp.status}`) as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }
    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content?.find((c) => c.type === 'text')?.text ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call Haiku with a single retry on transient failures (HTTP 429 or an
 * aborted/timed-out/network blip). The sweep's data shows these two classes
 * account for essentially all direct-API failures; a single retry clears the
 * overwhelming majority. Title generation is fire-and-forget background work,
 * so the extra latency on the retry path is irrelevant.
 */
export async function callHaiku(prompt: string, timeoutMs = 15_000): Promise<string> {
  try {
    return await callHaikuOnce(prompt, timeoutMs);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const transient = status === 429 || status === 529 || (err as Error).name === 'AbortError' || !status;
    if (!transient) throw err;
    log.debug('callHaiku: transient failure, retrying once', { status, name: (err as Error).name });
    return await callHaikuOnce(prompt, timeoutMs);
  }
}
