/**
 * Outbound secret scrubber.
 *
 * Registers credential values from `.env` at host startup. Callers run
 * `scrubSecrets()` on any text that might leak to a user (channel
 * messages, logs) to replace known secret values with `[REDACTED]`.
 *
 * Defense-in-depth only — v2's primary credential isolation is OneCLI
 * (HTTPS_PROXY interception so agents never see api keys). This catches
 * the narrow case of a secret reaching agent context anyway (e.g. the
 * agent reads a file that contains a token) and echoing it outbound.
 *
 * Ported from v1's `src/secret-scrubber.ts`.
 */
import fs from 'fs';
import path from 'path';

import { log, setLogScrubber } from './log.js';

const secretValues = new Set<string>();

/** Minimum length to register — avoids false-positive redactions on short values. */
const MIN_LENGTH = 8;

/**
 * Register secret values for scrubbing. Idempotent; duplicates are no-ops.
 */
export function registerSecrets(secrets: Record<string, string>): void {
  for (const value of Object.values(secrets)) {
    if (value && value.length >= MIN_LENGTH) {
      secretValues.add(value);
    }
  }
}

/**
 * Parse `.env` at `cwd/.env` and register every value that looks
 * credential-ish. Keys that explicitly flag themselves as non-secrets
 * (WEB_UI_ORIGINS, *_URL, *_PORT, *_ID where length is small, etc.) are
 * skipped — registering them would over-redact innocuous text.
 */
const NON_SECRET_KEY_PATTERNS: RegExp[] = [
  /_URL$/,
  /_URI$/,
  /_PORT$/,
  /_ORIGINS$/,
  /_DIR$/,
  /_PATH$/,
  /^NODE_ENV$/,
  /^LOG_LEVEL$/,
  /_SENDER_NAME$/,
  /_JID$/,
  /_CHANNEL_ID$/,
  /_CHANNEL_IDS$/,
  /_NOTIFY_JID$/,
  /_IDLE_RESET_HOURS$/,
  /^ASSISTANT_NAME$/,
  /^TZ$/,
];

function isLikelySecretKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const pattern of NON_SECRET_KEY_PATTERNS) {
    if (pattern.test(key)) return false;
  }
  return true;
}

export function registerSecretsFromEnv(envPath?: string): number {
  const filePath = envPath ?? path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  let count = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!isLikelySecretKey(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value && value.length >= MIN_LENGTH) {
      secretValues.add(value);
      count++;
    }
  }
  log.info('Registered secrets for scrubbing', { count });
  return count;
}

/**
 * Replace any registered secret values in text with `[REDACTED]`.
 * Fast no-op when nothing is registered.
 */
export function scrubSecrets(text: string): string {
  if (secretValues.size === 0 || !text) return text;
  let result = text;
  for (const secret of secretValues) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  return result;
}

/** For tests: reset registry. */
export function _clearSecretsForTest(): void {
  secretValues.clear();
}

// Wire the scrubber into the logger on module load — any log line with a
// registered secret gets redacted before hitting stdout/stderr.
setLogScrubber(scrubSecrets);
