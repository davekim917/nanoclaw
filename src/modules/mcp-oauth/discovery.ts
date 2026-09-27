/**
 * MCP authorization discovery:
 *
 *   POST <mcp-url> (unauthenticated)
 *     → 401 + `WWW-Authenticate: Bearer resource_metadata="…"`   [RFC 9728 §5.1]
 *   GET  <resource metadata>
 *     → { resource, authorization_servers[], scopes_supported[] } [RFC 9728 §3]
 *   GET  <authorization server metadata>
 *     → { authorization_endpoint, token_endpoint, registration_endpoint, … }
 *                                                                 [RFC 8414 §3]
 *
 * Every endpoint is stored separately rather than derived from the issuer: a
 * token endpoint can live on a different host from its issuer.
 */

/** Matches the global `fetch`; injected so tests never reach the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DISCOVERY_TIMEOUT_MS = 10_000;

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
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
 * Pull `resource_metadata` out of a `WWW-Authenticate` challenge — a scan for
 * the one parameter, not an RFC 7235 parser, since servers emit extra
 * parameters in varying orders. Undefined sends the caller to the well-known paths.
 */
export function parseWwwAuthenticate(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(header);
  const value = match?.[1] ?? match?.[2];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Well-known URLs for a protected resource, most-specific first (RFC 9728 §3.1):
 * the resource path is APPENDED after the well-known segment, not inserted
 * before it as RFC 8414 does for authorization servers.
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
 * OpenID Discovery 1.0 §4). RFC 8414 INSERTS the well-known segment between
 * origin and issuer path — the opposite of the protected-resource rule above.
 * Deduped because a path-less issuer collapses the first two entries.
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

/**
 * Every URL this flow will FETCH, or hand to a human to open, must be HTTPS
 * (RFC 8414 §2), enforced where a URL is SELECTED: the issuer before its
 * metadata is fetched (cleartext metadata can be forged wholesale), the
 * endpoints discovery returns, the device verification URI, and
 * `--device-endpoint`. No loopback exemption: the only loopback URL is the
 * REDIRECT, which this host never requests.
 */
export function assertHttpsEndpoint(label: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`${label} is not a valid URL: ${url}`, { cause: err });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must be https, got ${parsed.protocol}//… — refusing to send credentials in cleartext.`);
  }
  return url;
}

/**
 * RFC 8414 §3.3: the metadata's `issuer` MUST equal the issuer it was fetched
 * for, or a document could speak for a different issuer and poison the
 * client-reuse key. Normalized on the trailing slash ONLY (live servers
 * disagree about it); case, port and path compare verbatim. A MISSING
 * `issuer` is refused, or the check would be opt-out-able by the document.
 */
export function assertIssuerMatches(declared: string | undefined, requested: string, documentUrl: string): void {
  const normalize = (u: string) => u.replace(/\/+$/, '');
  if (declared === undefined) {
    throw new Error(
      `Authorization-server metadata at ${documentUrl} declares no issuer (RFC 8414 §2 requires one). ` +
        'Refusing: there is nothing to bind the document to ' +
        `${requested}.`,
    );
  }
  if (normalize(declared) !== normalize(requested)) {
    throw new Error(
      `Authorization-server metadata at ${documentUrl} declares issuer "${declared}", but it was fetched for ` +
        `"${requested}" (RFC 8414 §3.3 requires them to be identical). Refusing.`,
    );
  }
}

/**
 * RFC 9728 §3.3: the protected-resource document's `resource` must cover the
 * MCP URL — same origin, and a path that is equal to or a segment-boundary
 * prefix of it.
/**
 * RFC 9728 §3.3: the document's `resource` must cover the MCP URL — same origin
 * and a segment-boundary path prefix. An origin-only `resource` deliberately
 * covers every path (a live server declares its origin while serving `/mcp`).
 */
export function assertResourceMatchesMcpUrl(resource: string | undefined, mcpUrl: string): void {
  if (resource === undefined) return;
  let declared: URL;
  try {
    declared = new URL(resource);
  } catch (err) {
    throw new Error(`Protected-resource metadata declares an invalid resource "${resource}"`, { cause: err });
  }
  // `new URL` accepts any scheme; reject a URN here rather than misreport it as an origin mismatch.
  if (declared.protocol !== 'https:' && declared.protocol !== 'http:') {
    throw new Error(
      `Protected-resource metadata declares resource "${resource}", which is not a URL ` +
        '(RFC 9728 §2 requires an https URL). Refusing: it cannot be matched against ' +
        `${mcpUrl}.`,
    );
  }
  const target = new URL(mcpUrl);
  const trim = (p: string) => p.replace(/\/+$/, '');
  const declaredPath = trim(declared.pathname);
  const targetPath = trim(target.pathname);
  const pathMatches = declaredPath === '' || targetPath === declaredPath || targetPath.startsWith(`${declaredPath}/`);
  if (declared.origin !== target.origin || !pathMatches) {
    throw new Error(
      `Protected-resource metadata declares resource "${resource}", which does not cover ${mcpUrl} ` +
        '(RFC 9728 §3.3). Refusing: this document describes a different resource.',
    );
  }
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
 * Probe the MCP endpoint unauthenticated and read its challenge. A bare POST,
 * not `initialize`: servers answer 401 before parsing, and an empty body does
 * not look like a half-open session. A non-401 means "use the well-known paths".
 */
async function probeResourceMetadataUrl(fetchImpl: FetchLike, mcpUrl: string): Promise<string | undefined> {
  const res = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  return parseWwwAuthenticate(res.headers.get('www-authenticate'));
}

async function discoverProtectedResource(
  fetchImpl: FetchLike,
  mcpUrl: string,
): Promise<{ url: string; metadata: ProtectedResourceMetadata }> {
  // The bearer goes to this URL on every request, so cleartext is refused before probing.
  assertHttpsEndpoint('--url', mcpUrl);
  const candidates: string[] = [];
  try {
    const advertised = await probeResourceMetadataUrl(fetchImpl, mcpUrl);
    if (advertised) candidates.push(advertised);
  } catch {
    // The probe is an optimization; the well-known paths still get tried.
  }
  for (const url of protectedResourceMetadataUrls(mcpUrl)) {
    if (!candidates.includes(url)) candidates.push(url);
  }

  const failures: string[] = [];
  for (const url of candidates) {
    try {
      // `advertised` came off the network; refused per candidate so a good
      // well-known path still gets its turn.
      assertHttpsEndpoint('resource_metadata', url);
      const metadata = await getJson<ProtectedResourceMetadata>(fetchImpl, url);
      // A per-candidate ACCEPTANCE test: a generic document on a shared origin
      // is skipped rather than ending a discovery a later candidate completes.
      assertResourceMatchesMcpUrl(metadata.resource, mcpUrl);
      return { url, metadata };
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `No OAuth protected-resource metadata for ${mcpUrl}. Tried:\n  ${failures.join('\n  ')}\n` +
      'If this server is not an OAuth-protected MCP server, keep using a static OneCLI secret instead.',
  );
}

async function discoverAuthorizationServer(
  fetchImpl: FetchLike,
  issuer: string,
): Promise<{ url: string; metadata: AuthorizationServerMetadata }> {
  const failures: string[] = [];
  for (const url of authorizationServerMetadataUrls(issuer)) {
    try {
      const metadata = await getJson<AuthorizationServerMetadata>(fetchImpl, url);
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        // Per-candidate, like the resource check: the root well-known fallback
        // on a multi-tenant host belongs to somebody else and must not abort
        // the discovery.
        assertIssuerMatches(metadata.issuer, issuer, url);
        return { url, metadata };
      }
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
 * The whole chain. `authorization_servers[0]` is taken: RFC 9728 gives the
 * array no ordering, and `--issuer` selects another.
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

  // BEFORE the fetch, for the discovered value as much as the override.
  assertHttpsEndpoint(issuerOverride ? '--issuer' : 'authorization_servers entry', issuer);

  const asDoc = await discoverAuthorizationServer(fetchImpl, issuer);
  return {
    resource: resourceDoc.metadata.resource,
    // The server's own spelling, so stored rows stay byte-identical to what a
    // re-login computes for the client-reuse comparison.
    issuer: asDoc.metadata.issuer ?? issuer,
    authorizationEndpoint: assertHttpsEndpoint('authorization_endpoint', asDoc.metadata.authorization_endpoint!),
    tokenEndpoint: assertHttpsEndpoint('token_endpoint', asDoc.metadata.token_endpoint!),
    registrationEndpoint: asDoc.metadata.registration_endpoint
      ? assertHttpsEndpoint('registration_endpoint', asDoc.metadata.registration_endpoint)
      : undefined,
    deviceAuthorizationEndpoint: asDoc.metadata.device_authorization_endpoint
      ? assertHttpsEndpoint('device_authorization_endpoint', asDoc.metadata.device_authorization_endpoint)
      : undefined,
    grantTypesSupported: asDoc.metadata.grant_types_supported ?? [],
    // The resource's own list wins: it is the subset meaningful at THIS endpoint.
    scopesSupported: resourceDoc.metadata.scopes_supported ?? asDoc.metadata.scopes_supported ?? [],
    codeChallengeMethods: asDoc.metadata.code_challenge_methods_supported ?? [],
  };
}
