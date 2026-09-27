/** Codex sanitizes env inheritance for stdio MCP servers; keep this forwarding narrow and explicit. */

import path from 'path';

const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Where GitHub credentials are FOUND, never the credentials themselves: this table is rendered into the
 * provider's on-disk MCP config, which must never hold a credential (hence no GH_TOKEN / GITHUB_TOKEN).
 */
const GITHUB_CREDENTIAL_PATH_ENV_KEYS = ['GITHUB_TOKEN_FILE', 'GIT_CONFIG_GLOBAL'] as const;

/** Absolute single-line paths only, so a token mistakenly placed in one of these variables is dropped. */
function isForwardablePath(value: string): boolean {
  return path.isAbsolute(value) && !/[\r\n\0]/.test(value);
}

export function builtInNanoclawMcpEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const nanoclawEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NANOCLAW_') && value) nanoclawEnv[key] = value;
  }
  for (const key of GIT_IDENTITY_ENV_KEYS) {
    const value = env[key];
    if (value) nanoclawEnv[key] = value;
  }
  for (const key of GITHUB_CREDENTIAL_PATH_ENV_KEYS) {
    const value = env[key];
    if (value && isForwardablePath(value)) nanoclawEnv[key] = value;
  }
  return nanoclawEnv;
}
