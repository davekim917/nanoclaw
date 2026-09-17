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

/**
 * Every URL this flow will FETCH, or hand to a human to open, must be HTTPS.
 *
 * Three rounds of review found this one invariant at three different sites — the
 * discovered endpoints, then `--device-endpoint`, then the discovered issuer —
 * so it is enforced once, where a URL is SELECTED, rather than once per caller:
 *
 *   - `discoverAuthorization` gates the issuer it is about to fetch metadata
 *     from, whichever way that issuer arrived (`--issuer` or
 *     `authorization_servers[0]`). That is the load-bearing one: metadata
 *     fetched over cleartext can be substituted wholesale, and every https
 *     endpoint inside a forged document would then pass a per-endpoint check.
 *   - `discoverAuthorization` gates the four endpoints it returns, so nothing
 *     downstream can receive an http one.
 *   - `device.ts` gates the verification URI it prints, because that is a URL a
 *     human is being told to open.
 *   - `service.ts` gates `--device-endpoint`, the one URL that does not pass
 *     through discovery at all.
 *
 * RFC 8414 §2 requires https for all of them. There is deliberately no loopback
 * exemption: the only loopback URL in this flow is the REDIRECT, which the
 * operator's browser resolves and this host never issues a request to.
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

/** Loopback: traffic to these never leaves this host, so cleartext cannot be
 *  observed or substituted by a network attacker. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * The same https demand as {@link assertHttpsEndpoint}, with ONE exemption:
 * http on a loopback host.
 *
 * Used for the two URLs that describe the RESOURCE rather than the
 * authorization server — the MCP endpoint itself and the `resource_metadata`
 * URL its challenge advertises. Both were previously ungated (the MCP URL
 * arrived straight from `--url`, and the advertised metadata URL was fetched
 * without a check at all), which is how `--url http://…` reached the network:
 * the 401 probe and the metadata GET both went out in cleartext, and a network
 * attacker owned every URL the rest of the chain was read out of.
 *
 * The exemption exists because a locally-hosted MCP server over
 * `http://127.0.0.1:…` is a real configuration and nothing about it crosses a
 * wire. It is deliberately NOT extended to the authorization server: RFC 8414 §2
 * requires https there, and that is the document the token endpoint is read out
 * of.
 */
export function assertResourceUrlIsSecure(label: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`${label} is not a valid URL: ${url}`, { cause: err });
  }
  if (parsed.protocol === 'https:') return url;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return url;
  throw new Error(
    `${label} must be https (http is allowed only on 127.0.0.1/localhost), got ${parsed.protocol}//${parsed.host} — ` +
      'refusing to send credentials in cleartext.',
  );
}

/**
 * RFC 9728 §3.3: the `resource` in a protected-resource document must identify
 * the resource the document was fetched FOR. Without this check, any document
 * we can be pointed at — a `resource_metadata` URL from an unauthenticated 401
 * challenge, or a generic well-known doc on a shared origin — can name any
 * authorization server it likes, and the login proceeds against it.
 *
 * Matched by ORIGIN + PATH PREFIX rather than string equality, because the live
 * servers disagree on how specific the value is:
 *
 *   Dropbox     resource `https://mcp.dropbox.com/mcp`    MCP URL …/mcp   (equal)
 *   Littlebird  resource `https://mcp.littlebird.ai/mcp`  MCP URL …/mcp   (equal)
 *   Amplitude   resource `https://mcp.amplitude.com`      MCP URL …/mcp   (prefix)
 *
 * (All three verified against the live well-known documents on 2026-09-17.)
 * Amplitude names the ORIGIN as its resource while serving MCP under `/mcp`, so
 * an equality check would refuse an integration that is live on this host today.
 * A prefix is still a binding: it says the document belongs to a resource this
 * URL is part of, which is exactly what a substituted document cannot claim.
 *
 * An ABSENT `resource` is not an error here. RFC 9728 requires the field, but
 * omitting it cannot forge a match — it only means no RFC 8707 resource
 * indicator is sent — and the transport gate above is what keeps the document
 * authentic. Refusing it would add a failure mode without closing a hole.
 */
/**
 * RFC 8414 §3.3: the `issuer` in an authorization-server metadata document MUST
 * be identical to the issuer URL the document was fetched for.
 *
 * Without it, whoever controls `authorization_servers[0]` — or a well-known
 * document on that origin — can hand back a document claiming to speak for a
 * different issuer, and the value is then stored on the row and used as the
 * client-reuse key (`service.ts`, `existingRow.issuer === discovered.issuer`).
 * The check is what makes "this client id belongs to this issuer" true.
 *
 * NORMALIZED ON THE TRAILING SLASH ONLY, because the live documents disagree
 * about it and nothing else (verified 2026-09-17):
 *
 *   Dropbox     asked `https://www.dropbox.com`    declared the same
 *   Amplitude   asked `https://mcp.amplitude.com`  declared the same
 *   Littlebird  asked `https://mcp.littlebird.ai/` declared `https://mcp.littlebird.ai/`
 *
 * Littlebird's resource document lists its authorization server WITH the
 * trailing slash and its metadata declares it the same way, so all three match
 * exactly today; the normalization is there so the one that publishes
 * `https://host` while being discovered as `https://host/` does not become a
 * support ticket. No other normalization is applied — case, port and path are
 * compared verbatim, because each of those is a different server as far as RFC
 * 8414 is concerned.
 *
 * A MISSING `issuer` is refused. RFC 8414 §2 makes it REQUIRED, all three live
 * servers send it, and treating absence as "fine" would make the check
 * opt-out-able by the very document it is checking.
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

export class ResourceBindingError extends Error {}

export function assertResourceMatchesMcpUrl(resource: string | undefined, mcpUrl: string): void {
  if (resource === undefined) return;
  let declared: URL;
  try {
    declared = new URL(resource);
  } catch (err) {
    throw new ResourceBindingError(`Protected-resource metadata declares an invalid resource "${resource}"`, {
      cause: err,
    });
  }
  const target = new URL(mcpUrl);
  const trim = (p: string) => p.replace(/\/+$/, '');
  const declaredPath = trim(declared.pathname);
  const targetPath = trim(target.pathname);
  const pathMatches = declaredPath === '' || targetPath === declaredPath || targetPath.startsWith(`${declaredPath}/`);
  if (declared.origin !== target.origin || !pathMatches) {
    throw new ResourceBindingError(
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
  // Before the probe: this is the first request of the whole flow, and an
  // http MCP URL means the 401 challenge that names every later document is
  // itself attacker-writable.
  assertResourceUrlIsSecure('MCP URL', mcpUrl);

  const candidates: string[] = [];
  let advertised: string | undefined;
  try {
    advertised = await probeResourceMetadataUrl(fetchImpl, mcpUrl);
  } catch {
    // The probe is an optimization: a server that refuses the bare POST (or is
    // briefly unreachable) still has well-known paths worth trying, and their
    // failure produces the better error message below.
  }
  if (advertised) {
    // OUTSIDE the catch above, deliberately. An http `resource_metadata` is not
    // a transport hiccup to fall back from — it is a document we were told to
    // fetch in cleartext, and silently using the well-known path instead would
    // hide that. The only URL in this chain that gets a loopback exemption is
    // one pointing at this machine.
    candidates.push(assertResourceUrlIsSecure('resource_metadata URL from WWW-Authenticate', advertised));
  }
  for (const url of protectedResourceMetadataUrls(mcpUrl)) {
    if (!candidates.includes(url)) candidates.push(url);
  }

  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const metadata = await getJson<ProtectedResourceMetadata>(fetchImpl, url);
      // Binding check, not a fetch failure: a document that answers but
      // describes another resource is refused outright rather than falling
      // through to the next candidate.
      assertResourceMatchesMcpUrl(metadata.resource, mcpUrl);
      return { url, metadata };
    } catch (err) {
      if (err instanceof ResourceBindingError) throw err;
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
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        // RFC 8414 §3.3 is an ACCEPTANCE test for a candidate, not a verdict on
        // the whole probe (#905 review round 2). The probe list deliberately
        // includes the ROOT well-known path as a fallback for a path-carrying
        // issuer, and on a multi-tenant host that document is complete and
        // belongs to somebody else. Checking it after the loop let that
        // document abort a discovery the issuer-specific candidate two entries
        // later would have completed.
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

  // BEFORE the fetch, and for the discovered value as much as the override:
  // this is the document every endpoint below is read out of.
  assertHttpsEndpoint(issuerOverride ? '--issuer' : 'authorization_servers entry', issuer);

  // The issuer match is enforced INSIDE `discoverAuthorizationServer`, as a
  // candidate acceptance test — a document that fails it is skipped and the
  // next candidate is tried, rather than ending the probe.
  const asDoc = await discoverAuthorizationServer(fetchImpl, issuer);
  return {
    resource: resourceDoc.metadata.resource,
    // The metadata value, not the one we asked for: they are now known to be
    // equal up to a trailing slash, and storing the server's own spelling keeps
    // every already-stored row (`mcp_oauth_integrations.issuer`) byte-identical
    // to what a re-login computes — which is what the client-reuse predicate in
    // `service.ts` compares.
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
    // The resource's own list wins: it is the subset that means anything at
    // THIS endpoint. Dropbox's AS advertises 39 scopes, of which its MCP
    // resource accepts 8.
    scopesSupported: resourceDoc.metadata.scopes_supported ?? asDoc.metadata.scopes_supported ?? [],
    codeChallengeMethods: asDoc.metadata.code_challenge_methods_supported ?? [],
  };
}
