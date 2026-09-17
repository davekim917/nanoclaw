/**
 * MCP authorization discovery — the chain an MCP client walks before it can
 * ask for a token.
 *
 *   POST <mcp-url> (unauthenticated)
 *     → 401 + `WWW-Authenticate: Bearer resource_metadata="…"`   [RFC 9728 §5.1]
 *   GET  <resource metadata>
 *     → { resource, authorization_servers[], scopes_supported[] } [RFC 9728 §3]
 *   GET  <authorization server metadata>
 *     → { authorization_endpoint, token_endpoint, registration_endpoint, … }
 *                                                                 [RFC 8414 §3]
 *
 * Parsing is split from fetching so the whole chain is testable without a
 * network: `parseWwwAuthenticate`, `protectedResourceMetadataUrls` and
 * `authorizationServerMetadataUrls` are pure, and the three `discover*`
 * functions take an injected fetch.
 *
 * Verified live on 2026-09-17 against both first targets:
 *   mcp.dropbox.com  → resource_metadata .../oauth-protected-resource/mcp,
 *                      AS https://www.dropbox.com (token endpoint on
 *                      api.dropboxapi.com — a DIFFERENT host from the issuer,
 *                      which is why every endpoint is stored separately rather
 *                      than derived from the issuer at refresh time)
 *   mcp.amplitude.com → resource_metadata .../oauth-protected-resource,
 *                      AS is the MCP server itself.
 */

/** Injected so tests never reach the network. Matches the global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  /** RFC 8628 §4. Neither first target publishes one; see device.ts. */
  device_authorization_endpoint?: string;
  scopes_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Pull `resource_metadata` out of a `WWW-Authenticate` challenge.
 *
 * Deliberately a scan for the one parameter rather than a full RFC 7235
 * challenge parser: both live servers emit extra parameters in different
 * orders (`Bearer resource_metadata="…", error="invalid_token", …` on Dropbox;
 * `Bearer realm="OAuth", resource_metadata="…", …` on Amplitude), and the
 * parameter we want is unambiguous by name. Returns undefined when the header
 * is absent or carries no such parameter — the caller then falls back to the
 * RFC 9728 well-known paths, which is also the path for a server that answers
 * 401 with no challenge at all.
 */
export function parseWwwAuthenticate(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(header);
  const value = match?.[1] ?? match?.[2];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Well-known URLs for a protected resource, most-specific first (RFC 9728 §3.1).
 *
 * The path-suffixed form comes first because that is what a server hosting
 * several resources under one origin uses — Dropbox's own challenge points at
 * `/.well-known/oauth-protected-resource/mcp`, i.e. the resource path appended
 * to the well-known segment, NOT inserted before it the way RFC 8414 does for
 * authorization servers. The bare form is the fallback and is what Amplitude
 * serves.
 */
export function protectedResourceMetadataUrls(mcpUrl: string): string[] {
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/\/$/, '');
  const urls = [`${url.origin}/.well-known/oauth-protected-resource`];
  if (path && path !== '/') urls.unshift(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  return urls;
}

/**
 * Well-known URLs for an authorization server, in probe order (RFC 8414 §3.1,
 * OpenID Discovery 1.0 §4).
 *
 * RFC 8414 INSERTS the well-known segment between origin and issuer path
 * (`https://host/.well-known/oauth-authorization-server/tenant`), which is the
 * opposite of the protected-resource rule above; getting these two the same way
 * round is the classic discovery bug. An issuer with no path (both first
 * targets) collapses the first two entries, which is why the list is deduped.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/oauth-authorization-server`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
  return [...new Set(candidates)];
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Probe the MCP endpoint unauthenticated and read its challenge.
 *
 * A bare POST is used rather than a real `initialize` request: the servers
 * answer 401 before they parse a body, and an empty body keeps this from
 * looking like a half-finished MCP session to a server that tracks them.
 * A non-401 answer is not an error here — it means the endpoint did not
 * challenge us, and the caller falls back to the well-known paths.
 */
export async function probeResourceMetadataUrl(fetchImpl: FetchLike, mcpUrl: string): Promise<string | undefined> {
  const res = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  return parseWwwAuthenticate(res.headers.get('www-authenticate'));
}

export async function discoverProtectedResource(
  fetchImpl: FetchLike,
  mcpUrl: string,
): Promise<{ url: string; metadata: ProtectedResourceMetadata }> {
  const candidates: string[] = [];
  try {
    const advertised = await probeResourceMetadataUrl(fetchImpl, mcpUrl);
    if (advertised) candidates.push(advertised);
  } catch {
    // The probe is an optimization: a server that refuses the bare POST (or is
    // briefly unreachable) still has well-known paths worth trying, and their
    // failure produces the better error message below.
  }
  for (const url of protectedResourceMetadataUrls(mcpUrl)) {
    if (!candidates.includes(url)) candidates.push(url);
  }

  const failures: string[] = [];
  for (const url of candidates) {
    try {
      return { url, metadata: await getJson<ProtectedResourceMetadata>(fetchImpl, url) };
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `No OAuth protected-resource metadata for ${mcpUrl}. Tried:\n  ${failures.join('\n  ')}\n` +
      'If this server is not an OAuth-protected MCP server, keep using a static OneCLI secret instead.',
  );
}

export async function discoverAuthorizationServer(
  fetchImpl: FetchLike,
  issuer: string,
): Promise<{ url: string; metadata: AuthorizationServerMetadata }> {
  const failures: string[] = [];
  for (const url of authorizationServerMetadataUrls(issuer)) {
    try {
      const metadata = await getJson<AuthorizationServerMetadata>(fetchImpl, url);
      if (metadata.authorization_endpoint && metadata.token_endpoint) return { url, metadata };
      failures.push(`${url}: no authorization_endpoint/token_endpoint`);
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No authorization-server metadata for issuer ${issuer}. Tried:\n  ${failures.join('\n  ')}`);
}

export interface DiscoveredAuthorization {
  resource: string | undefined;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | undefined;
  deviceAuthorizationEndpoint: string | undefined;
  grantTypesSupported: string[];
  scopesSupported: string[];
  codeChallengeMethods: string[];
}

/**
 * The whole chain. `authorization_servers[0]` is taken when the resource lists
 * several: RFC 9728 gives the array no ordering semantics, and neither target
 * lists more than one, so picking the first is honest about what we know —
 * an operator who needs another can point `--issuer` at it.
 */
export async function discoverAuthorization(
  fetchImpl: FetchLike,
  mcpUrl: string,
  issuerOverride?: string,
): Promise<DiscoveredAuthorization> {
  const resourceDoc = await discoverProtectedResource(fetchImpl, mcpUrl);
  const issuer = issuerOverride ?? resourceDoc.metadata.authorization_servers?.[0];
  if (!issuer) {
    throw new Error(
      `Protected-resource metadata at ${resourceDoc.url} lists no authorization_servers — pass --issuer explicitly.`,
    );
  }

  const asDoc = await discoverAuthorizationServer(fetchImpl, issuer);
  return {
    resource: resourceDoc.metadata.resource,
    issuer: asDoc.metadata.issuer ?? issuer,
    authorizationEndpoint: asDoc.metadata.authorization_endpoint!,
    tokenEndpoint: asDoc.metadata.token_endpoint!,
    registrationEndpoint: asDoc.metadata.registration_endpoint,
    deviceAuthorizationEndpoint: asDoc.metadata.device_authorization_endpoint,
    grantTypesSupported: asDoc.metadata.grant_types_supported ?? [],
    // The resource's own list wins: it is the subset that means anything at
    // THIS endpoint. Dropbox's AS advertises 39 scopes, of which its MCP
    // resource accepts 8.
    scopesSupported: resourceDoc.metadata.scopes_supported ?? asDoc.metadata.scopes_supported ?? [],
    codeChallengeMethods: asDoc.metadata.code_challenge_methods_supported ?? [],
  };
}
