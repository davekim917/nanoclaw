/**
 * Lightweight LLM caller for host-side tasks: memory extraction, thread
 * titles, topic classification.
 *
 * Uses the Anthropic SDK directly (not the Claude CLI shell-out that v1
 * used). Requires `ANTHROPIC_API_KEY` in the host env.
 *
 * Keep this module small — it's for fire-and-forget fast calls with Haiku.
 * The agent container uses `@anthropic-ai/claude-agent-sdk` for the full
 * agent loop; this module is intentionally separate.
 */
import Anthropic from '@anthropic-ai/sdk';

import { log } from './log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — host-side LLM calls unavailable');
  }
  _client = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT_MS });
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
