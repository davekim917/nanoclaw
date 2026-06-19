/**
 * Secret env-var list for the Bash sanitize hook.
 *
 * SDK-FREE by design: this module MUST NOT import
 * `@anthropic-ai/claude-agent-sdk` (or anything that transitively pulls it in).
 * It is imported both by the Claude provider (claude.ts createSanitizeBashHook)
 * and by sibling adapters (e.g. the OpenCode guard) that have no SDK on their
 * path — keeping it dependency-free is the single-source contract.
 *
 * This is the SINGLE SOURCE OF TRUTH for "which env vars get `unset` before a
 * Bash subprocess runs". Do not fork the list into an adapter.
 */

// ANTHROPIC_API_KEY and its _N fallback variants (_2, _5, ...).
export const ANTHROPIC_KEY_RE = /^ANTHROPIC_API_KEY(_\d+)?$/;

// CLAUDE_CODE_OAUTH_TOKEN (Claude Max subscription) + _N fallback variants.
export const OAUTH_KEY_RE = /^CLAUDE_CODE_OAUTH_TOKEN(_\d+)?$/;

/**
 * Secrets the SDK needs for API auth but that Bash subprocesses must not see.
 * Built lazily (reads `process.env` at call time) so late-bound env additions
 * — e.g. a key rotation that mirrors a new value into process.env — are
 * covered on the next Bash invocation.
 *
 * NANOCLAW_GH_TOKEN / GH_TOKEN / GITHUB_TOKEN are deliberately NOT in this
 * list. Stripping them would break the very thing the URL-scoped credential
 * helper is trying to enable: git invokes its helper via a subprocess that
 * inherits the Bash env, and the helper reads NANOCLAW_GH_TOKEN from there
 * to hand back to git. An agent that wants to exfiltrate the token can
 * `printenv` it — the mitigation is at the URL-scoped helper (token is
 * useless outside the allowlisted orgs) and at auth-level controls on
 * GitHub's side, not at the bash-env boundary.
 */
export function buildSecretEnvVarList(): string[] {
  return [
    ...Object.keys(process.env).filter((k) => ANTHROPIC_KEY_RE.test(k)),
    ...Object.keys(process.env).filter((k) => OAUTH_KEY_RE.test(k)),
    'GMAIL_OAUTH_PATH',
    'GMAIL_CREDENTIALS_PATH',
  ];
}
