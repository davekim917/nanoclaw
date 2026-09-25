/**
 * Credential env-var patterns, plus the one list still stripped from child envs.
 *
 * SDK-FREE by design: this module MUST NOT import
 * `@anthropic-ai/claude-agent-sdk` (or anything that transitively pulls it in).
 * It is imported by the Claude provider, by sibling adapters (e.g. the OpenCode
 * guard) that have no SDK on their path, and by the in-container `claude` review
 * launcher — keeping it dependency-free is the single-source contract.
 *
 * ── Credential model for container shells ──
 *
 * A container's shell inherits the provider credential the container itself
 * runs on. That was already true for Codex and OpenCode, whose credentials sit
 * in an on-disk `auth.json` any subprocess can read; it is now true for Claude
 * too — ANTHROPIC_API_KEY* / CLAUDE_CODE_OAUTH_TOKEN* stay in the env of Bash
 * subprocesses, so `claude -p`, `codex exec` and `opencode run` all work
 * headless inside an agent's session under the same identity that agent runs on.
 *
 * The credential boundary is SCOPE, not the bash env:
 *   - per-group credential rings — a group only ever holds its own keys;
 *   - the URL-scoped git credential helper — a token useless outside the
 *     allowlisted orgs (which is why NANOCLAW_GH_TOKEN / GH_TOKEN /
 *     GITHUB_TOKEN were never stripped here either);
 *   - OneCLI's per-request injection at the proxy boundary, where the
 *     container-side value is frequently only the `placeholder` sentinel
 *     (src/container-runner.ts).
 *
 * Unsetting the Anthropic vars per Bash command was a v1 port whose premise —
 * "a Bash subprocess must not be able to `printenv` a live secret" — this file
 * already abandoned for the GitHub tokens, and which the Codex/OpenCode on-disk
 * auth files contradict outright. It bought no containment (the agent process
 * holds the same credential and can spend it) and cost every agent the ability
 * to drive a headless Claude.
 *
 * GMAIL_OAUTH_PATH / GMAIL_CREDENTIALS_PATH went with them, for a different
 * reason: nothing in `src/` or `container/` sets either one in the container
 * env. `.claude/skills/add-gmail-tool/SKILL.md` sets both — on the gmail MCP
 * server's OWN env, not the container's — so the old unset never matched them,
 * and their values are file paths, not secrets. Two names that could never
 * match.
 *
 * Still stripped: MCP_HEADER_ONLY_SECRET_VARS below — credentials a shell
 * genuinely never needs, because they are registration-time HTTP headers.
 */

// ANTHROPIC_API_KEY and its _N fallback variants (_2, _5, ...).
export const ANTHROPIC_KEY_RE = /^ANTHROPIC_API_KEY(_\d+)?$/;

// CLAUDE_CODE_OAUTH_TOKEN (Claude Max subscription) + _N fallback variants.
export const OAUTH_KEY_RE = /^CLAUDE_CODE_OAUTH_TOKEN(_\d+)?$/;

/**
 * MCP / header-only secrets: passed to MCP servers as registration-time HTTP
 * headers (Exa, Braintrust) or short-lived rotating tokens (Granola), and never
 * needed by a Bash/tool subprocess. BOTH providers must strip these from any
 * child env they spawn so an unguarded `bash`/`printenv` can't read them — this
 * is the cross-provider env-hygiene parity bar (Claude via filterSdkEnv, OpenCode
 * via buildOpencodeServerEnv, scheduled task scripts via scriptEnv).
 *
 * Deliberately NOT here: the provider credentials above (see the module header),
 * nor data-tool secrets that bash tools legitimately consume from env
 * (SNOWFLAKE_PASSWORD, DBT_* tokens, OPENAI_API_KEY, …) — stripping those would
 * break `snow`/`dbt`/etc. on BOTH providers. Single source of truth; do not fork
 * this list into an adapter.
 */
export const MCP_HEADER_ONLY_SECRET_VARS: readonly string[] = [
  'GRANOLA_ACCESS_TOKEN',
  'EXA_API_KEY',
  'BRAINTRUST_API_KEY',
];
