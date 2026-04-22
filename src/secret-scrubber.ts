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
 * Parse `.env` at `cwd/.env` and register values whose keys match known
 * credential-name patterns. Previously this used a blacklist (register
 * everything except a few hand-picked non-secrets) but that caused
 * over-redaction as new NANOCLAW_DEFAULT_* config knobs and per-workspace
 * identifier keys were added — e.g. NANOCLAW_DEFAULT_AGENT_GROUP_SLACK_*
 * values are short config strings like "illysium" that the scrubber then
 * wiped out of every message. Allowlist is safer here: defense-in-depth
 * only (OneCLI is the primary isolation), and every real credential in
 * the canonical .env template follows one of these naming patterns.
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

/**
 * Secret-shape patterns. Catches tokens that aren't in `.env`:
 * OneCLI-injected API tokens (never touch disk), runtime-fetched OAuth,
 * bearer tokens appearing in response bodies that an agent echoes back,
 * literal secrets inlined into SQL/URL strings.
 *
 * Mirrored in container/agent-runner/src/providers/bash-label.ts
 * (the container is Bun and can't import host code). When updating one
 * list, update the other — the two form the label-vs-outbound defense
 * pair: bash-label sanitizes at the source, scrubSecrets backstops at
 * delivery.
 */
const SECRET_SHAPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Authorization:\s*(?:Bearer|Basic|Digest)\s+[^\s'"]+/gi, 'Authorization: [REDACTED]'],
  [/-H\s+['"]?(?:X-API-Key|X-Auth-Token|X-Access-Token|Api-Key|X-Token)[:=]\s*[^'"\s]+['"]?/gi, '-H [REDACTED]'],
  [/(?:-u|--user)\s+[^:\s]+:[^\s]+/g, '-u [REDACTED]'],
  [/([?&])(api[_-]?key|token|access[_-]?token|password|passwd|pwd|auth|sig|signature)=[^&\s"'`]+/gi, '$1$2=[REDACTED]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'],
  [/\bxox[abpr]-[A-Za-z0-9-]+\b/g, '[REDACTED]'],
  [/\bghp_[A-Za-z0-9]+\b/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
];

/**
 * No high-entropy catch-all — every iteration of length/composition
 * heuristics destroyed legitimate identifiers (dbt models, Snowflake
 * tables, content-addressed digests, trace IDs). Scrubbing is
 * structural: prefixes + contextual patterns + .env values. Novel-vendor
 * tokens are an accepted residual risk; the fix is a one-line prefix
 * addition, not a heuristic. See bash-label.ts for the mirrored rationale.
 */
function scrubSecretShapes(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_SHAPE_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Replace registered .env secrets AND generic secret-shaped tokens
 * (bearer headers, known vendor prefixes, JWTs, high-entropy opaque
 * tokens). Fast no-op when text is empty.
 */
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

/** For tests: reset registry. */
export function _clearSecretsForTest(): void {
  secretValues.clear();
}

// Wire the scrubber into the logger on module load — any log line with a
// registered secret gets redacted before hitting stdout/stderr.
setLogScrubber(scrubSecrets);
