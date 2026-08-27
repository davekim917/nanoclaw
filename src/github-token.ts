import type { ContainerConfig } from './container-config.js';
import { GITHUB_APP_SENTINEL, resolveGitHubAppToken } from './github-app-token.js';

/**
 * Resolve the GitHub credential shared by host callers and container spawns.
 * Lookup order is `githubTokenEnv`, folder-scoped token, then global token.
 */
export async function resolveGitHubToken(
  folder: string,
  cfg: Pick<ContainerConfig, 'githubTokenEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let value: string | undefined;
  if (cfg.githubTokenEnv) {
    const configured = env[cfg.githubTokenEnv];
    if (configured) value = configured;
  }
  value ??= resolveScopedGitHubToken(folder, env);
  return value === GITHUB_APP_SENTINEL ? resolveGitHubAppToken(env) : value;
}

function resolveScopedGitHubToken(folder: string, env: NodeJS.ProcessEnv): string | undefined {
  const scopedName = `GITHUB_TOKEN_${folder.toUpperCase().replace(/-/g, '_')}`;
  return env[scopedName] ?? env.GITHUB_TOKEN;
}
