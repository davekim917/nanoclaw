import type { Dispatcher } from 'undici';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

// Node 20's native fetch ignores HTTPS_PROXY (Node 24+ adds NODE_USE_ENV_PROXY
// support). The daemon runs wrapped in `onecli run` which sets HTTPS_PROXY to
// route through the OneCLI gateway — without a manual proxy dispatcher,
// requests bypass the proxy entirely and never get auth injected.
//
// EnvHttpProxyAgent (vs ProxyAgent) honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY
// the same way curl does, so an operator running a non-OneCLI ANTHROPIC_BASE_URL
// (e.g., openlimits) can set NO_PROXY to bypass the gateway without overriding
// ExecStart.
//
// Resolved lazily inside callClassifier (not at module load) so tests don't pick
// up stale dispatcher state from an earlier proxy env, and so a daemon restart
// after env changes Just Works without a code path change.
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
// Test-only seam: clear the cached dispatcher so unit tests can stub fetch
// without inheriting a real proxy from the surrounding shell.
export function _resetProxyDispatcherForTest(): void {
  _envProxyDispatcher = undefined;
}
export const CLASSIFIER_VERSION = 'v1';
// v2 — added grounding-discipline section to CLASSIFIER_SYSTEM_PROMPT and
// EXTRACTOR_SYSTEM_PROMPT to prevent confabulation (acronym expansion,
// invented aliases, unsourced parentheticals). Bumping invalidates the
// processed_pairs / processed_sources idempotency cache so prior turns get
// re-classified under the new rules. Underlying extractor schema unchanged
// (Plan B span-grounding is a separate follow-up).
export const PROMPT_VERSION = 'v2';
// EXTRACTOR_VERSION lives here alongside the other version constants so a
// reviewer bumping CLASSIFIER_VERSION on a prompt change will see this and
// know to bump it too if the source-ingest extractor prompt also changes.
// processed_sources rows are scoped by EXTRACTOR_VERSION; failing to bump it
// on a prompt change causes silent re-processing skips.
// v2 — same grounding-discipline addition as PROMPT_VERSION above.
export const EXTRACTOR_VERSION = 'v2';

export interface ClassifierOutput {
  worth_storing: boolean;
  facts: Array<{
    content: string;
    category: 'preference' | 'decision' | 'insight' | 'fact' | 'context';
    importance: number;
    entities: string[];
    source_role: 'user' | 'assistant' | 'joint' | 'external';
  }>;
}

export class ClassifierParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierParseError';
  }
}

const VALID_CATEGORIES = new Set(['preference', 'decision', 'insight', 'fact', 'context']);
const VALID_SOURCE_ROLES = new Set(['user', 'assistant', 'joint', 'external']);

function validateClassifierOutput(value: unknown): ClassifierOutput {
  if (typeof value !== 'object' || value === null) {
    throw new ClassifierParseError('Response is not an object');
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.worth_storing !== 'boolean') {
    throw new ClassifierParseError('worth_storing must be a boolean');
  }

  if (!Array.isArray(obj.facts)) {
    throw new ClassifierParseError('facts must be an array');
  }

  for (const fact of obj.facts) {
    if (typeof fact !== 'object' || fact === null) {
      throw new ClassifierParseError('Each fact must be an object');
    }
    const f = fact as Record<string, unknown>;
    if (typeof f.content !== 'string') throw new ClassifierParseError('fact.content must be a string');
    if (!VALID_CATEGORIES.has(f.category as string)) throw new ClassifierParseError('fact.category is invalid');
    if (typeof f.importance !== 'number') throw new ClassifierParseError('fact.importance must be a number');
    if (!Array.isArray(f.entities)) throw new ClassifierParseError('fact.entities must be an array');
    if (!VALID_SOURCE_ROLES.has(f.source_role as string)) throw new ClassifierParseError('fact.source_role is invalid');
  }

  return obj as unknown as ClassifierOutput;
}

export async function callClassifier(
  systemPrompt: string,
  userPrompt: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ClassifierOutput> {
  // Default to direct Anthropic endpoint. The daemon runs wrapped in `onecli run`
  // (see data/systemd/nanoclaw-memory-daemon.service ExecStart), which sets
  // HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN=placeholder. The undici ProxyAgent
  // routes the request through the OneCLI gateway at 127.0.0.1:10255; the
  // gateway detects the literal "placeholder" Bearer value and substitutes
  // the real OAuth token from the operator's default agent vault. End-to-end
  // smoke-tested against api.anthropic.com — returns 200 with the substituted
  // token. ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY overrides remain for non-OneCLI
  // deployments (openlimits, direct API key auth).
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const directApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  // Prefer x-api-key auth when ANTHROPIC_API_KEY is set explicitly (direct/
  // openlimits path). Fall back to OAuth Bearer when CLAUDE_CODE_OAUTH_TOKEN
  // is set (OneCLI gateway path — the placeholder string is what the proxy
  // substitutes at request time).
  const useOauth = !directApiKey && oauthToken;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (opts?.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason));
  }

  timeoutId = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'AbortError')),
    timeoutMs,
  );

  // Use undici fetch + EnvHttpProxyAgent when proxy env is set so requests
  // route through the OneCLI gateway (and honor NO_PROXY for opt-out hosts).
  // Falls back to native fetch when no proxy env is present, which keeps
  // unit tests that stub global fetch working without extra setup.
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
    response = (await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 4096,
        // Wrap the system prompt in a cacheable content block. Both
        // CLASSIFIER_SYSTEM_PROMPT and EXTRACTOR_SYSTEM_PROMPT are >2048
        // tokens (Haiku's prompt-cache minimum) so this triggers a real
        // cache hit on every call after the first within the 5-minute
        // ephemeral TTL — ~80% input-token reduction on the system block.
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    })) as Response;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new ClassifierParseError('No text content block in response');
  }

  // Haiku 4.5 sometimes wraps the JSON in a markdown code fence even when
  // the system prompt asks for raw JSON. Strip a leading ```json (or ```)
  // and a trailing ``` before parsing so we don't dead-letter perfectly
  // valid responses. Production observation: 52 of 52 dead_letters from
  // the daemon's first sweep against existing chat history failed for this
  // exact reason. The strip is permissive — if no fence is present, the
  // string is parsed as-is.
  const cleaned = stripCodeFence(textBlock.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClassifierParseError(`Response text is not valid JSON: ${cleaned.slice(0, 200)}`);
  }

  return validateClassifierOutput(parsed);
}

/**
 * Extract the JSON payload from an LLM response that may be wrapped in a
 * markdown code fence and/or followed by free-form prose ("**Reasoning:** …"
 * being a particularly common Haiku trailer).
 *
 * Strategy:
 *   1. If the trimmed input starts with a fence, return the first fenced
 *      block's contents — anything after the closing ``` is ignored.
 *   2. If no leading fence is present, fall back to extracting the first
 *      balanced { ... } block (handles "Sure, here's the JSON: { ... }").
 *   3. Otherwise return the trimmed input as-is.
 *
 * Production observation: Haiku 4.5 emits both `\`\`\`json … \`\`\`` and
 * `\`\`\`json … \`\`\` **Reasoning:** …` shapes routinely; an earlier strict
 * "fence at end-of-string" regex dead-lettered ~52 of illysium's chat
 * turn-pairs on the daemon's first sweep.
 */
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  // (1) Leading fence — match the FIRST closing ``` after content; ignore
  // anything (prose, more fences) that follows.
  const fenceMatch = /^```(?:[a-zA-Z0-9]+)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenceMatch) return fenceMatch[1];
  // (2) No fence but maybe prose-prefixed — extract the first balanced
  // top-level JSON object. Cheap implementation: find first '{', scan
  // forward counting braces, stop at the matching '}'. Bail back to (3)
  // if no balanced object is found.
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return trimmed.slice(firstBrace, i + 1);
      }
    }
  }
  // (3) Fallback — let JSON.parse decide.
  return trimmed;
}
