/**
 * The Codex CLI sanitizes environment inheritance for stdio MCP servers.
 * Keep the built-in NanoClaw MCP's forwarding narrow and explicit.
 */

const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Environment passed to the built-in NanoClaw MCP process. Existing
 * NANOCLAW_* propagation is unchanged. The host sends Git identity either
 * from its established credentialFolder-scoped values or from an explicit
 * per-agent declaration, so each present attribution variable must cross the
 * provider boundary unchanged.
 */
export function builtInNanoclawMcpEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const nanoclawEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NANOCLAW_') && value) nanoclawEnv[key] = value;
  }
  for (const key of GIT_IDENTITY_ENV_KEYS) {
    const value = env[key];
    if (value) nanoclawEnv[key] = value;
  }
  return nanoclawEnv;
}
