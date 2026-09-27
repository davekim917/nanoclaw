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

interface StructuredCredential {
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
  readonly providerMessage: string | null;
  readonly providerErrorType: string | null;
  readonly retryAfterHeader: string | null;
  readonly rateLimitUnifiedHeaders: Record<string, string> | null;

  constructor(status: number, providerMessage: string | null = null, details: CallHaikuHttpErrorDetails = {}) {
    const providerErrorType = details.providerErrorType ?? null;
    const shownMessage = truncateProviderMessage(providerMessage);
    super(
      `callHaiku: Anthropic returned ${status}` +
        (providerErrorType ? ` ${providerErrorType}` : '') +
        (shownMessage ? `: ${shownMessage}` : ''),
    );
    this.name = 'CallHaikuHttpError';
    this.status = status;
    this.providerMessage = providerMessage;
    this.providerErrorType = providerErrorType;
    this.retryAfterHeader = details.retryAfterHeader ?? null;
    this.rateLimitUnifiedHeaders = details.rateLimitUnifiedHeaders ?? null;
  }
}

async function anthropicCredentialHttpError(response: Response): Promise<CallHaikuHttpError> {
  const { providerErrorType, providerMessage } = await parseAnthropicErrorBody(response);
  const retryAfterHeader = response.headers.get('retry-after');
  return new CallHaikuHttpError(response.status, providerMessage, {
    providerErrorType,
    retryAfterHeader,
    rateLimitUnifiedHeaders: rateLimitUnifiedHeaders(response.headers),
  });
}

async function callHaikuOnce(
  prompt: string,
  options: Required<Pick<CallHaikuOptions, 'timeoutMs' | 'model'>> & Pick<CallHaikuOptions, 'system'>,
  credential: StructuredCredential,
): Promise<string> {
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
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credential.headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 80,
        temperature: 0,
        ...(options.system ? { system: options.system } : {}),
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

export interface CallHaikuOptions {
  system?: string;
  timeoutMs?: number;
  model?: string;
}

/** One request per configured key, in order; the first success wins. The caller owns any retry or throttling. */
export async function callHaiku(prompt: string, options: CallHaikuOptions = {}): Promise<string> {
  const resolved = {
    system: options.system,
    timeoutMs: options.timeoutMs ?? 15_000,
    model: options.model ?? HAIKU_MODEL,
  };
  const credentials = structuredCredentials(process.env, defaultStructuredCredentialEnvFile(process.env));
  if (credentials.length === 0) {
    throw new Error(
      'callHaiku: no Anthropic credentials configured (set ANTHROPIC_API_KEY or a CLAUDE_CODE_OAUTH_TOKEN slot)',
    );
  }
  let lastErr: unknown;
  let rateLimitErr: unknown;
  for (const credential of credentials) {
    try {
      return await callHaikuOnce(prompt, resolved, credential);
    } catch (err) {
      lastErr = err;
      if (err instanceof CallHaikuHttpError && err.status === 429) rateLimitErr = err;
      log.info('callHaiku: key failed, trying the next one', {
        slot: credential.slot,
        err: (err as Error).message,
        ...(err instanceof CallHaikuHttpError
          ? { retryAfterHeader: err.retryAfterHeader, rateLimitUnifiedHeaders: err.rateLimitUnifiedHeaders }
          : {}),
      });
    }
  }
  // A 429 from any key outranks a later different failure: callers' rate-limit handling keys on it.
  throw rateLimitErr ?? lastErr;
}
