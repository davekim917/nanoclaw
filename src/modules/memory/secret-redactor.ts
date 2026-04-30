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

// Bound the input length sent to the regex engine. The /g patterns above are
// fast in the common case but `.{8,}` and similar can exhibit superlinear
// backtracking on adversarial inputs. 8KB is well above any plausible fact
// content length and bounds worst-case regex execution time.
const MAX_REDACTOR_INPUT_LENGTH = 8192;

export function redactSecrets(fact: FactInput): RedactionResult {
  const content =
    fact.content.length > MAX_REDACTOR_INPUT_LENGTH ? fact.content.slice(0, MAX_REDACTOR_INPUT_LENGTH) : fact.content;

  // Pass 1: known-shape patterns (fast, deterministic)
  for (const [pattern, reason] of BLOCK_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      return { shouldStore: false, reason };
    }
  }

  // Pass 2: registered .env secret values — scrubSecrets returns text with
  // [REDACTED] markers when any registered credential is found. Block storage
  // when the scrubber detects an actual env-registered secret.
  if (scrubSecrets(content) !== content) {
    return { shouldStore: false, reason: 'registered_env_secret' };
  }

  return { shouldStore: true };
}
