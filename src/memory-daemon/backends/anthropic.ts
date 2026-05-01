/**
 * Anthropic backend for the classifier-client facade. Refactored from the
 * original anthropic-client.ts; behavior identical when constructed with
 * { model: 'haiku-4-5', effort: 'default' } (the daemon's pre-existing
 * configuration).
 *
 * Adds: model parameterization (haiku-4-5 / sonnet-4-6 / opus-4-7) + effort
 * knob mapping (low/medium/high → extended-thinking budget_tokens for models
 * that support it).
 */
import type { Dispatcher } from 'undici';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

import type { ClassifierBackend, CallClassifierOpts, Effort } from '../classifier-client.js';
import { ClassifierParseError, stripCodeFence, validateClassifierOutput } from '../classifier-client.js';

export interface AnthropicBackendOpts {
  model: string;
  effort: Effort;
}

// Map short alias → full Anthropic model id. Adding a new model = one line.
const MODEL_ALIAS_MAP: Record<string, string> = {
  'haiku-4-5': 'claude-haiku-4-5-20251001',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'opus-4-7': 'claude-opus-4-7',
};

// Models that support extended thinking. Haiku does not.
const SUPPORTS_THINKING = new Set(['claude-sonnet-4-6', 'claude-opus-4-7']);

// Map effort level → thinking budget_tokens for models that support it.
// "default"/"low" → no extended thinking; "medium" → modest budget;
// "high" → generous budget for the kind of reasoning a tighter classifier
// model wouldn't manage. Tuned for memory extraction scale (per-pair calls,
// each ~5K input tokens), not deep multi-turn reasoning.
function effortToThinkingBudget(effort: Effort, model: string): number | null {
  if (!SUPPORTS_THINKING.has(model)) return null;
  switch (effort) {
    case 'default':
    case 'low':
      return null;
    case 'medium':
      return 5_000;
    case 'high':
      return 16_000;
  }
}

// Lazy-init proxy dispatcher (resolved on first call so tests don't pick up
// stale state from earlier proxy env, and so a daemon restart after env
// changes Just Works without code path changes).
let _envProxyDispatcher: Dispatcher | null | undefined;
function getProxyDispatcher(): Dispatcher | null {
  if (_envProxyDispatcher !== undefined) return _envProxyDispatcher;
  const hasProxyEnv = !!(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
  _envProxyDispatcher = hasProxyEnv ? new EnvHttpProxyAgent() : null;
  return _envProxyDispatcher;
}

/** Test-only seam: clear the cached dispatcher between tests. */
export function _resetProxyDispatcherForTest(): void {
  _envProxyDispatcher = undefined;
}

export function makeAnthropicBackend(opts: AnthropicBackendOpts): ClassifierBackend {
  const fullModelId = MODEL_ALIAS_MAP[opts.model] ?? opts.model;
  if (!fullModelId.startsWith('claude-')) {
    throw new Error(
      `Anthropic backend: unknown model alias "${opts.model}" (known: ${Object.keys(MODEL_ALIAS_MAP).join(', ')})`,
    );
  }
  const thinkingBudget = effortToThinkingBudget(opts.effort, fullModelId);

  return async function callClassifierAnthropic(
    systemPrompt: string,
    userPrompt: string,
    callOpts?: CallClassifierOpts,
  ) {
    // The daemon runs wrapped in `onecli run` (see
    // data/systemd/nanoclaw-memory-daemon.service ExecStart), which sets
    // HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN=placeholder. The undici
    // EnvHttpProxyAgent routes the request through the OneCLI gateway at
    // 127.0.0.1:10255; the gateway substitutes the literal "placeholder"
    // Bearer with the real OAuth token from the operator's vault at
    // request time. ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY overrides remain
    // for non-OneCLI deployments (openlimits, direct API key auth).
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    const directApiKey = process.env.ANTHROPIC_API_KEY ?? '';
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    const useOauth = !directApiKey && oauthToken;
    const timeoutMs = callOpts?.timeoutMs ?? 10_000;

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Stash the listener fn so we can remove it in finally. `once: true`
    // self-cleans after firing; the explicit removeEventListener handles the
    // no-fire case (request completes / times out before outer abort).
    let onOuterAbort: (() => void) | undefined;
    if (callOpts?.signal) {
      const outer = callOpts.signal;
      onOuterAbort = () => controller.abort(outer.reason);
      outer.addEventListener('abort', onOuterAbort, { once: true });
    }

    timeoutId = setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'AbortError')),
      timeoutMs,
    );

    const dispatcher = getProxyDispatcher();
    const fetchImpl = dispatcher
      ? (url: string, init: Parameters<typeof fetch>[1]) =>
          undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
      : fetch;

    let response: Response;
    try {
      const authHeaders: Record<string, string> = useOauth
        ? { authorization: `Bearer ${oauthToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
        : { 'x-api-key': directApiKey };

      // Build request body. system prompt always wrapped in a cacheable block
      // (>2048 tokens triggers Haiku's prompt cache; same threshold for
      // Sonnet/Opus). thinking is only added when the model supports it AND
      // the effort knob requested a non-zero budget.
      const body: Record<string, unknown> = {
        model: fullModelId,
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      };
      if (thinkingBudget !== null) {
        body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
        // When extended thinking is on, max_tokens must be > budget_tokens
        // (per Anthropic API contract — the response budget is on top of
        // thinking). Bump max_tokens to leave room for the actual output.
        body.max_tokens = thinkingBudget + 4096;
      }

      response = (await fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })) as Response;
    } finally {
      clearTimeout(timeoutId);
      if (onOuterAbort && callOpts?.signal) {
        callOpts.signal.removeEventListener('abort', onOuterAbort);
      }
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    // When extended thinking is on, the response has a "thinking" content
    // block followed by the "text" block. We always want the text block.
    const textBlock = data.content?.find((b) => b.type === 'text');
    if (!textBlock || typeof textBlock.text !== 'string') {
      throw new ClassifierParseError('No text content block in response');
    }

    const cleaned = stripCodeFence(textBlock.text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new ClassifierParseError(`Response text is not valid JSON: ${cleaned.slice(0, 200)}`);
    }

    return validateClassifierOutput(parsed);
  };
}
