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
import { execFile, type ChildProcess, type ExecFileException } from 'child_process';

import { readEnvFileMatching } from './env.js';
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

function resolveStructuredCredential(
  env: NodeJS.ProcessEnv,
  requestedSlot?: ClaudeCredentialSlot,
  envFile: Record<string, string> = defaultStructuredCredentialEnvFile(env),
): StructuredCredential {
  const credentials = structuredCredentials(env, envFile);
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
  readonly providerErrorType: string | null;
  readonly requestId: string | null;

  constructor(
    status: number,
    retryAfterMs: number | null,
    options: { providerErrorType?: string | null; providerMessage?: string | null; requestId?: string | null } = {},
  ) {
    const providerErrorType = options.providerErrorType?.trim() || null;
    const providerMessage = options.providerMessage?.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    const detail = [providerErrorType, providerMessage].filter(Boolean).join(': ');
    super(`structured Claude call returned ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'ClaudeStructuredHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.providerErrorType = providerErrorType;
    this.requestId = options.requestId?.trim() || null;
  }
}

export class ClaudeStructuredCliError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null = null;

  constructor(message: string, status: number | null = null, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'ClaudeStructuredCliError';
    this.status = status;
  }
}

export interface ClaudeCliExecOptions {
  env: NodeJS.ProcessEnv;
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export type ClaudeCliExecFile = (
  command: string,
  args: string[],
  options: ClaudeCliExecOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

interface ClaudeCliResultEnvelope {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  api_error_status?: unknown;
  structured_output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  modelUsage?: Record<string, unknown>;
}

const CLAUDE_CLI_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function claudeCliStatus(envelope: ClaudeCliResultEnvelope | null, diagnostic: string): number | null {
  const explicit = envelope?.api_error_status;
  if (typeof explicit === 'number' && Number.isInteger(explicit)) return explicit;
  if (typeof explicit === 'string' && /^\d{3}$/.test(explicit)) return Number(explicit);
  const statusMatch = /\b(401|403|429)\b/.exec(diagnostic);
  if (statusMatch) return Number(statusMatch[1]);
  if (/rate[\s_-]*limit|usage limit|out of usage|quota/i.test(diagnostic)) return 429;
  if (/authentication|unauthori[sz]ed|invalid (?:api )?key|invalid token/i.test(diagnostic)) return 401;
  return null;
}

function parseClaudeCliEnvelope(stdout: string): ClaudeCliResultEnvelope | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ClaudeCliResultEnvelope) : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function isolatedClaudeCliEnv(
  env: NodeJS.ProcessEnv,
  credential: StructuredCredential,
  maxTokens: number,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^CLAUDE_CODE_OAUTH_TOKEN(?:_\d+)?$/.test(key) || /^ANTHROPIC_API_KEY(?:_\d+)?$/.test(key)) {
      delete childEnv[key];
    }
  }
  childEnv[credential.authEnv.name] = credential.authEnv.value;
  childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  let anthropicHost: string;
  try {
    anthropicHost = new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').hostname;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ClaudeStructuredCliError('structured Claude CLI has an invalid ANTHROPIC_BASE_URL', null, {
      cause: error,
    });
  }
  const noProxy = new Set(
    [childEnv.NO_PROXY, childEnv.no_proxy]
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  noProxy.add(anthropicHost);
  childEnv.NO_PROXY = [...noProxy].join(',');
  childEnv.no_proxy = childEnv.NO_PROXY;
  return childEnv;
}

async function runClaudeCli(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  execFileImpl: ClaudeCliExecFile,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = execFileImpl(
        command,
        args,
        {
          env,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: CLAUDE_CLI_MAX_CAPTURE_BYTES,
          signal,
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          });
        },
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reject(new ClaudeStructuredCliError('failed to start structured Claude CLI', null, { cause: error }));
      return;
    }
    if (!child.stdin) {
      settled = true;
      child.kill();
      reject(new ClaudeStructuredCliError('structured Claude CLI has no stdin'));
      return;
    }
    child.stdin.on('error', (error) => {
      if (settled || (error as NodeJS.ErrnoException).code === 'EPIPE') return;
      settled = true;
      child.kill();
      reject(new ClaudeStructuredCliError('failed to write structured Claude CLI input', null, { cause: error }));
    });
    child.stdin.end(input);
  });
}

/**
 * Subscription-aware structured Claude call for host background work.
 *
 * Unlike the raw Messages API path, Claude Code applies the subscription
 * entitlement and usage state associated with each OAuth token. The selected
 * slot is isolated as the child's only Anthropic credential, the untrusted
 * user payload travels over stdin, and safe mode removes project/user
 * customizations from the stateless call.
 */
export async function callClaudeCliStructured<T>(
  request: ClaudeStructuredRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    credentialSlot?: ClaudeCredentialSlot;
    execFile?: ClaudeCliExecFile;
    envFile?: Record<string, string>;
  } = {},
): Promise<ClaudeStructuredResult<T>> {
  const env = options.env ?? process.env;
  const credential = resolveStructuredCredential(env, options.credentialSlot, options.envFile);
  const childEnv = isolatedClaudeCliEnv(env, credential, request.maxTokens);
  const args = [
    '-p',
    '--model',
    request.model,
    '--effort',
    request.effort,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--tools',
    '',
    '--safe-mode',
    '--no-session-persistence',
    '--prompt-suggestions',
    'false',
    '--system-prompt',
    request.system,
  ];
  const result = await runClaudeCli(
    env.CLAUDE_BIN?.trim() || 'claude',
    args,
    request.user,
    childEnv,
    request.timeoutMs,
    request.signal,
    options.execFile ??
      ((command, childArgs, execOptions, callback) => execFile(command, childArgs, execOptions, callback)),
  );
  const envelope = parseClaudeCliEnvelope(result.stdout);
  if (
    result.exitCode !== 0 ||
    envelope?.type !== 'result' ||
    envelope.subtype !== 'success' ||
    envelope.is_error === true
  ) {
    const diagnostic = [typeof envelope?.result === 'string' ? envelope.result : '', result.stderr.slice(0, 1000)]
      .filter(Boolean)
      .join(' ');
    log.warn('structured Claude CLI nonzero exit', {
      exitCode: result.exitCode,
      model: request.model,
      diagnostic: diagnostic.slice(0, 500),
    });
    throw new ClaudeStructuredCliError(
      `structured Claude CLI call failed with exit ${result.exitCode}`,
      claudeCliStatus(envelope, diagnostic),
    );
  }
  if (!envelope.modelUsage || !Object.hasOwn(envelope.modelUsage, request.model)) {
    throw new ClaudeStructuredCliError(
      `structured Claude CLI model mismatch: requested ${request.model}, received no matching usage`,
    );
  }
  if (!Object.hasOwn(envelope, 'structured_output')) {
    throw new ClaudeStructuredCliError('structured Claude CLI returned no structured output');
  }
  return {
    value: envelope.structured_output as T,
    model: request.model,
    credentialSlot: credential.slot,
    usage: {
      inputTokens: finiteTokenCount(envelope.usage?.input_tokens),
      outputTokens: finiteTokenCount(envelope.usage?.output_tokens),
      cacheReadInputTokens: finiteTokenCount(envelope.usage?.cache_read_input_tokens),
      cacheCreationInputTokens: finiteTokenCount(envelope.usage?.cache_creation_input_tokens),
    },
  };
}

async function claudeHttpError(response: Response): Promise<ClaudeStructuredHttpError> {
  let providerErrorType: string | null = null;
  let providerMessage: string | null = null;
  try {
    const body = (await response.json()) as {
      error?: { type?: unknown; message?: unknown };
    };
    providerErrorType = typeof body.error?.type === 'string' ? body.error.type : null;
    providerMessage = typeof body.error?.message === 'string' ? body.error.message : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Status, retry timing, and request id still make a non-JSON failure actionable.
  }
  return new ClaudeStructuredHttpError(response.status, parseRetryAfterMs(response.headers.get('retry-after')), {
    providerErrorType,
    providerMessage,
    requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id'),
  });
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
      throw await claudeHttpError(response);
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
