/**
 * Lightweight LLM caller for host-side tasks: memory extraction, thread
 * titles, topic classification.
 *
 * Uses the Anthropic SDK directly (not the Claude CLI shell-out that v1
 * used). Accepts either `ANTHROPIC_API_KEY` (API key) or
 * `CLAUDE_CODE_OAUTH_TOKEN` (Max-plan OAuth token) from the host env.
 * API key takes precedence when both are set.
 *
 * Keep this module small — it's for fire-and-forget fast calls with Haiku.
 * The agent container uses `@anthropic-ai/claude-agent-sdk` for the full
 * agent loop and routes through OneCLI; this module is intentionally
 * separate and host-side.
 */
import Anthropic from '@anthropic-ai/sdk';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const env = { ...process.env, ...readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) };
  const apiKey = env.ANTHROPIC_API_KEY;
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (apiKey) {
    _client = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT_MS });
  } else if (oauthToken) {
    // Max-plan OAuth token. Anthropic SDK accepts it via authToken.
    _client = new Anthropic({ authToken: oauthToken, timeout: DEFAULT_TIMEOUT_MS });
  } else {
    throw new Error(
      'Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — host-side LLM calls unavailable',
    );
  }
  return _client;
}

/**
 * Call Haiku with a single user prompt. Returns the assistant's text
 * response (joined from text content blocks).
 *
 * Throws on API errors — callers should catch + fall back (fire-and-forget
 * extraction should never crash the host).
 */
export async function callHaiku(
  prompt: string,
  opts: { maxTokens?: number; timeoutMs?: number; system?: string } = {},
): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const client = getClient();

  const response = await client.messages.create(
    {
      model: HAIKU_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      ...(opts.system ? { system: opts.system } : {}),
    },
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
  );

  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  log.debug('callHaiku', {
    promptChars: prompt.length,
    responseChars: text.length,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return text.trim();
}
