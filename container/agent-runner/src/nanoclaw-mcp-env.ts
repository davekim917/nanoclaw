/**
 * The Codex CLI sanitizes environment inheritance for stdio MCP servers.
 * Keep the built-in NanoClaw MCP's forwarding narrow and explicit.
 */

import path from 'path';

const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Where GitHub credentials are FOUND, never the credentials themselves.
 *
 * - `GITHUB_TOKEN_FILE`: the host delivers the token as a read-only mounted
 *   file and sets only this path (src/github-token-file.ts: "a path, never
 *   a credential"). The git credential helper and the gh shim both resolve
 *   the token from it at call time (container/entrypoint.sh) and
 *   have nothing else to read in file mode, so without it every git/gh network
 *   call made by an MCP tool fails with "could not read Username".
 * - `GIT_CONFIG_GLOBAL`: set only when $HOME is not writable, in which case the
 *   helper entry lives in that file instead of ~/.gitconfig.
 *
 * Nothing else is needed: Codex passes HOME and PATH to stdio MCP children by
 * default (openai/codex rust-v0.154.0, codex-rs/rmcp-client),
 * so ~/.gitconfig and the /tmp/bin gh shim are already reachable.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` are deliberately absent — this table is rendered
 * into the provider's on-disk MCP config, which must never hold a credential.
 */
const GITHUB_CREDENTIAL_PATH_ENV_KEYS = ['GITHUB_TOKEN_FILE', 'GIT_CONFIG_GLOBAL'] as const;

/**
 * True for an absolute, single-line path. Makes "only paths cross" a checked
 * property rather than a trusted one: a token value mistakenly placed in one of
 * these variables is not absolute and is dropped.
 */
function isForwardablePath(value: string): boolean {
  return path.isAbsolute(value) && !/[\r\n\0]/.test(value);
}

/**
 * Environment passed to the built-in NanoClaw MCP process. Existing
 * NANOCLAW_* propagation is unchanged. The host sends Git identity either
 * from its established credentialFolder-scoped values or from an explicit
 * per-agent declaration, so each present attribution variable must cross the
 * provider boundary unchanged. GitHub credential *locations* cross too; see
 * GITHUB_CREDENTIAL_PATH_ENV_KEYS.
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
  for (const key of GITHUB_CREDENTIAL_PATH_ENV_KEYS) {
    const value = env[key];
    if (value && isForwardablePath(value)) nanoclawEnv[key] = value;
  }
  return nanoclawEnv;
}
