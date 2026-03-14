import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Cached Anthropic API key reader.
 * Shared by topic-classifier.ts and thread-search.ts to avoid
 * duplicate caching logic.
 */
let cachedApiKey: string | undefined;
export function getAnthropicApiKey(): string {
  if (!cachedApiKey) {
    cachedApiKey = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;
  }
  if (!cachedApiKey) throw new Error('ANTHROPIC_API_KEY not found in .env');
  return cachedApiKey;
}

/**
 * Returns HTTP auth headers for direct Anthropic API calls.
 * Supports both API key mode (ANTHROPIC_API_KEY → x-api-key) and
 * OAuth mode (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN → exchange for
 * a temporary API key via /api/oauth/claude_cli/create_api_key, same as
 * the credential proxy does for containers).
 * Throws if neither credential is available in .env.
 * Note: a process restart is required after changing credential type in .env.
 */
const OAUTH_KEY_TTL_MS = 50 * 60 * 1000; // 50 min (temp keys expire after 1 h)

let cachedAuthHeaders: Record<string, string> | undefined;
let cachedAuthHeadersExpiry = 0;
let inflightExchange: Promise<Record<string, string>> | undefined;
let cacheGeneration = 0; // incremented on invalidation to discard in-flight results

export async function getAnthropicAuthHeaders(): Promise<Record<string, string>> {
  if (cachedAuthHeaders && Date.now() < cachedAuthHeadersExpiry)
    return cachedAuthHeaders;

  if (inflightExchange) return inflightExchange;

  inflightExchange = (async () => {
    const gen = cacheGeneration;
    const secrets = readEnvFile([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]);

    if (secrets.ANTHROPIC_API_KEY) {
      if (gen === cacheGeneration) {
        cachedAuthHeaders = { 'x-api-key': secrets.ANTHROPIC_API_KEY };
        cachedAuthHeadersExpiry = Infinity;
      }
      return cachedAuthHeaders!;
    }

    const oauthToken =
      secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
    if (!oauthToken) throw new Error('No Anthropic credentials found in .env');

    // OAuth mode: exchange the refresh token for a temporary API key.
    // Passing the OAuth token directly to /v1/messages does not work —
    // it must first be exchanged here (mirrors the credential proxy flow).
    const baseUrl =
      secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const exchangeUrl = `${baseUrl}/api/oauth/claude_cli/create_api_key`;

    const resp = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${oauthToken}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `OAuth key exchange failed: HTTP ${resp.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const tempKey = (
      data['api_key'] ??
      data['raw_key'] ??
      data['key']
    ) as string | undefined;
    if (!tempKey || typeof tempKey !== 'string')
      throw new Error('OAuth key exchange: no api_key in response');

    if (gen === cacheGeneration) {
      cachedAuthHeaders = { 'x-api-key': tempKey };
      cachedAuthHeadersExpiry = Date.now() + OAUTH_KEY_TTL_MS;
    }
    return cachedAuthHeaders!;
  })().finally(() => {
    inflightExchange = undefined;
  });

  return inflightExchange;
}

/** Force re-exchange on next call. Call this when a caller receives a 401. */
export function invalidateAnthropicAuthCache(): void {
  cacheGeneration++;
  cachedAuthHeaders = undefined;
  cachedAuthHeadersExpiry = 0;
  inflightExchange = undefined;
}
