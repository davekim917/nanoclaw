import type { FactInput } from './store.js';
import { scrubSecrets } from '../../secret-scrubber.js';

export interface RedactionResult {
  shouldStore: boolean;
  redactedContent?: string;
  reason?: string;
}

// Patterns mirrored from src/secret-scrubber.ts SECRET_SHAPE_PATTERNS plus
// additional patterns for PEM keys, AWS keys, and variable assignments that
// are write-path specific (memory never needs to store these).
const BLOCK_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // PEM private keys
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i, 'pem_private_key'],
  // Authorization headers (mirrored from scrubber)
  [/Authorization:\s*(?:Bearer|Basic|Digest)\s+[^\s'"]+/gi, 'authorization_header'],
  // X-API-Key / X-Auth-Token / X-Access-Token / Api-Key / X-Token headers (mirrored from scrubber)
  [/-H\s+['"]?(?:X-API-Key|X-Auth-Token|X-Access-Token|Api-Key|X-Token)[:=]\s*[^'"\s]+['"]?/gi, 'api_header'],
  // Bearer tokens in prose (broader than header form)
  [/\bBearer\s+[A-Za-z0-9._\-+/]{16,}/g, 'bearer_token'],
  // OpenAI / Anthropic / X.AI / Google API keys (sk- prefix family)
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'api_key_sk'],
  // Stripe live secret keys
  [/\bsk_live_[A-Za-z0-9]{20,}\b/g, 'stripe_live_key'],
  // GCP API keys (AIza prefix, 35 chars)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, 'gcp_api_key'],
  // GCP OAuth access tokens (ya29 prefix)
  [/\bya29\.[A-Za-z0-9._-]{20,}\b/g, 'gcp_oauth_token'],
  // GCP service account JSON marker
  [/["']type["']\s*:\s*["']service_account["']/i, 'gcp_service_account_json'],
  // AWS Access Key IDs (AKIA = long-term, ASIA = STS temporary)
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'aws_access_key_id'],
  // JWTs (mirrored from scrubber)
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt'],
  // Slack tokens (mirrored from scrubber)
  [/\bxox[abpr]-[A-Za-z0-9-]+\b/g, 'slack_token'],
  // GitHub tokens (mirrored from scrubber)
  [/\bghp_[A-Za-z0-9]+\b/g, 'github_token'],
  // GitLab tokens (mirrored from scrubber)
  [/\bglpat-[A-Za-z0-9_-]+\b/g, 'gitlab_token'],
  // Variable assignments: password=, api_key=, secret= (shell/env style)
  [/(?:password|api[_-]?key|secret|token)\s*[=:]\s*["']?[^\s"',;]{8,}["']?/gi, 'secret_assignment'],
  // URL query param secrets (mirrored from scrubber)
  [
    /([?&])(?:api[_-]?key|token|access[_-]?token|password|passwd|pwd|auth|sig|signature)=[^&\s"'`]+/gi,
    'url_secret_param',
  ],
  // curl -u user:pass (mirrored from scrubber)
  [/(?:-u|--user)\s+[^:\s]+:[^\s]+/g, 'curl_credentials'],
];

// Bound the regex engine's per-call input. The /g patterns above are fast in
// the common case but quantifiers like `{20,}` and `[^\s]+` can degrade on
// adversarial inputs. 8KB chunks bound worst-case execution per call while
// still covering full content via sliding window. Overlap (2KB) covers any
// secret pattern that crosses a chunk boundary — comfortably exceeds the
// length of every pattern we detect (bearer/JWT/sk-keys/AWS/etc., all <2KB).
const REDACTOR_CHUNK_SIZE = 8192;
const REDACTOR_CHUNK_OVERLAP = 2048;

function* slidingChunks(content: string): Iterable<string> {
  if (content.length <= REDACTOR_CHUNK_SIZE) {
    yield content;
    return;
  }
  const step = REDACTOR_CHUNK_SIZE - REDACTOR_CHUNK_OVERLAP;
  for (let start = 0; start < content.length; start += step) {
    const end = Math.min(start + REDACTOR_CHUNK_SIZE, content.length);
    yield content.slice(start, end);
    if (end === content.length) break;
  }
}

export function redactSecrets(fact: FactInput): RedactionResult {
  // Pass 1: known-shape patterns (fast, deterministic). Scan full content via
  // sliding window so secrets past offset 8KB don't pass through unredacted
  // (regression caught by ultrareview F18 — the prior single-pass truncation
  // silently allowed secrets in long source-ingest documents).
  for (const chunk of slidingChunks(fact.content)) {
    for (const [pattern, reason] of BLOCK_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(chunk)) {
        return { shouldStore: false, reason };
      }
    }
  }

  // Pass 2: registered .env secret values — scrubSecrets handles its own input
  // length and is not regex-vulnerable (substring matching against registered
  // values), so scan the full content directly.
  if (scrubSecrets(fact.content) !== fact.content) {
    return { shouldStore: false, reason: 'registered_env_secret' };
  }

  return { shouldStore: true };
}
