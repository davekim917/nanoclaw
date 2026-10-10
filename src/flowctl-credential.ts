/**
 * flowctl exchanges `FLOW_AUTH_TOKEN` (a refresh token or service-account API key) for an access token by posting it
 * in a request BODY; the OneCLI gateway injects headers only, so the key is a scoped host credential instead.
 */

/** Hosts flowctl reaches. Its HTTP client trusts only bundled roots, so OneCLI's re-signed TLS would fail it. */
export const FLOWCTL_NO_PROXY_HOSTS = ['estuary.dev', 'estuary-data.com', 'eyrcnmuzzyriypdajwdk.supabase.co'];

export function flowctlDeclared(tools: string[] | undefined): boolean {
  return tools?.includes('flowctl') ?? false;
}

export function flowctlTokenEnvName(credentialFolder: string): string {
  return `FLOW_AUTH_TOKEN_${credentialFolder.toUpperCase().replace(/-/g, '_')}`;
}

/** The key to forward as `FLOW_AUTH_TOKEN`, or undefined when the group is not entitled to one. */
export function resolveFlowctlToken(
  tools: string[] | undefined,
  credentialFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!flowctlDeclared(tools)) return undefined;
  return env[flowctlTokenEnvName(credentialFolder)] || undefined;
}
