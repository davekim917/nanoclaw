/**
 * Lightweight Haiku calls for host-side utility tasks (thread titles,
 * topic classification, search reranking).
 *
 * Goes straight to Anthropic's `/v1/messages` over the OneCLI gateway
 * proxy — the same path `src/dashboard/session-title-sweep.ts` and
 * `src/memory-daemon/backends/anthropic.ts` use, both of which run in
 * this same host process so the proxy + OAuth-token env is already
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
