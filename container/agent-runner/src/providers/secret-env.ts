/**
 * Credential env-var patterns, plus the one list still stripped from child envs.
 *
 * SDK-FREE: must not import `@anthropic-ai/claude-agent-sdk`, even transitively; sibling adapters and the
 * in-container `claude` review launcher import this without the SDK on their path.
 *
 * Container shells deliberately inherit the provider credential the container runs on (so headless `claude -p`,
 * `codex exec` and `opencode run` work). The credential boundary is scope (per-group rings, the URL-scoped git
 * helper, OneCLI proxy injection), not the bash env.
 */

export const ANTHROPIC_KEY_RE = /^ANTHROPIC_API_KEY(_\d+)?$/;

export const OAUTH_KEY_RE = /^CLAUDE_CODE_OAUTH_TOKEN(_\d+)?$/;

/**
 * Registration-time MCP header secrets a Bash/tool subprocess never needs. Every provider must strip these from
 * any child env it spawns (Claude filterSdkEnv, OpenCode buildOpencodeServerEnv, task scriptEnv). Never add
 * data-tool secrets (SNOWFLAKE_PASSWORD, DBT_*, …): bash tools read those from env. Single source of truth; do not
 * fork this list into an adapter.
 */
export const MCP_HEADER_ONLY_SECRET_VARS: readonly string[] = [
  'GRANOLA_ACCESS_TOKEN',
  'EXA_API_KEY',
  'BRAINTRUST_API_KEY',
];
