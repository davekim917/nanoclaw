/**
 * Outbound secret scrubber for text that might reach a user or a log. Defense in depth only: OneCLI keeps
 * credentials out of agents; this catches one that reached agent context anyway and is echoed outbound.
 */
import fs from 'fs';
import path from 'path';

import { log, setLogScrubber } from './log.js';

const secretValues = new Set<string>();

/** Shorter values are not registered, to avoid false-positive redactions. */
const MIN_LENGTH = 8;

export function registerSecrets(secrets: Record<string, string>): void {
  for (const value of Object.values(secrets)) {
    if (value && value.length >= MIN_LENGTH) {
      secretValues.add(value);
    }
  }
}

/**
 * Register `.env` values whose KEYS match credential-name patterns. An allowlist, not a blacklist: short config
 * values (e.g. NANOCLAW_DEFAULT_* slugs) would otherwise be redacted out of every message.
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /_TOKEN(_|$)/,
  /_KEY(_|$)/,
  /_SECRET(_|$)/,
  /_PASSWORD(_|$)/,
  /_CREDENTIALS(_|$)/,
  /_OAUTH/,
  /_SIGNING/,
  /_PG_/,
  /_POSTGRES/,
  /_REDIS_URL/,
  /_DB_URL/,
  /_DATABASE_URL/,
];

function isLikelySecretKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const pattern of SECRET_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
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

/** Credentials recognizable only with the surrounding text (header, CLI flag, query key); useless on a bare value. */
const CONTEXTUAL_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Authorization:\s*(?:Bearer|Basic|Digest)\s+[^\s'"]+/gi, 'Authorization: [REDACTED]'],
  [/-H\s+['"]?(?:X-API-Key|X-Auth-Token|X-Access-Token|Api-Key|X-Token)[:=]\s*[^'"\s]+['"]?/gi, '-H [REDACTED]'],
  [/(?:-u|--user)\s+[^:\s]+:[^\s]+/g, '-u [REDACTED]'],
  [/([?&])(api[_-]?key|token|access[_-]?token|password|passwd|pwd|auth|sig|signature)=[^&\s"'`]+/gi, '$1$2=[REDACTED]'],
];

/**
 * Token shapes recognizable from the value alone, safe on an isolated string. Exported so MCP config intake
 * (container-config.ts) rejects the same shapes this scrubs.
 */
export const TOKEN_SHAPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]'],
  [/\bxox[abpr]-[A-Za-z0-9-]+\b/g, '[REDACTED]'],
  [/\bghp_[A-Za-z0-9]+\b/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
];

/** Catches tokens absent from `.env`: OneCLI-injected, runtime OAuth, echoed bearer tokens, inlined literals. */
const SECRET_SHAPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [...CONTEXTUAL_SECRET_PATTERNS, ...TOKEN_SHAPE_PATTERNS];

/**
 * Deliberately no high-entropy catch-all: every heuristic destroyed legitimate identifiers (model and table names,
 * digests, trace IDs). A novel vendor's token needs a one-line prefix addition.
 */
function scrubSecretShapes(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_SHAPE_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

/** Replace registered `.env` secrets and secret-shaped tokens with `[REDACTED]`. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  if (secretValues.size > 0) {
    for (const secret of secretValues) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, '[REDACTED]');
      }
    }
  }
  result = scrubSecretShapes(result);
  return result;
}

export function _clearSecretsForTest(): void {
  secretValues.clear();
}

// Every log line is scrubbed too.
setLogScrubber(scrubSecrets);
