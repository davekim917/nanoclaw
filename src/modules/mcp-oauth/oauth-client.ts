/**
 * The OAuth 2.0 half of an MCP "connect": dynamic client registration
 * (RFC 7591), the PKCE authorization-code request, and the token grants.
 *
 * Plain host `fetch` does NOT traverse the OneCLI gateway proxy, which matters:
 * a token request routed through the gateway would get the dead bearer
 * injected over its own Authorization header.
 */
import type { FetchLike } from './discovery.js';

const TOKEN_TIMEOUT_MS = 15_000;

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  /** What the server actually stored; may differ from what we asked for. */
  redirectUris: string[];
}

export interface TokenResponse {
  accessToken: string;
  /** Absent when the server does not issue one — the caller must notice. */
  refreshToken?: string;
  /** Seconds. Absent when the server does not say. */
  expiresIn?: number;
  scope?: string;
  tokenType: string;
}

/**
 * A token-endpoint error (RFC 6749 §5.2) with its `error` code preserved: the
 * refresher keys on `invalid_grant` to tell a dead refresh token from a transient failure.
 */
export class OAuthTokenError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'OAuthTokenError';
  }
}

/** True when the grant is dead and only a fresh human login can fix it. */
export function isUnrecoverableGrantError(err: unknown): boolean {
  return (
    err instanceof OAuthTokenError &&
    (err.code === 'invalid_grant' || err.code === 'invalid_client' || err.code === 'unauthorized_client')
  );
}

/**
 * Dynamic client registration (RFC 7591). Public client: PKCE is the proof, but
 * a secret the server insists on issuing is still stored.
 */
export async function registerClient(
  fetchImpl: FetchLike,
  registrationEndpoint: string,
  input: { clientName: string; redirectUri: string; scopes?: string },
): Promise<RegisteredClient> {
  const body = {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(input.scopes ? { scope: input.scopes } : {}),
  };
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `Dynamic client registration at ${registrationEndpoint} returned ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as {
    client_id?: unknown;
    client_secret?: unknown;
    redirect_uris?: unknown;
  };
  if (typeof parsed.client_id !== 'string' || !parsed.client_id) {
    throw new Error(`Dynamic client registration at ${registrationEndpoint} returned no client_id`);
  }
  return {
    clientId: parsed.client_id,
    clientSecret: typeof parsed.client_secret === 'string' ? parsed.client_secret : undefined,
    redirectUris: Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris.map(String) : [input.redirectUri],
  };
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: string;
  state: string;
  codeChallenge: string;
  /** RFC 8707 resource indicator; omitted when the resource metadata had none. */
  resource?: string;
  /**
   * Non-standard authorize parameters, for a server that issues a refresh token
   * only when asked (e.g. `token_access_type=offline`) without saying so in metadata.
   */
  extraParams?: Record<string, string>;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('state', input.state);
  params.set('code_challenge', input.codeChallenge);
  params.set('code_challenge_method', 'S256');
  if (input.scopes) params.set('scope', input.scopes);
  if (input.resource) params.set('resource', input.resource);
  for (const [k, v] of Object.entries(input.extraParams ?? {})) params.set(k, v);
  return url.toString();
}

/**
 * Pull `code` and `state` out of what the operator pasted back: the whole
 * redirect URL from the address bar (the loopback target fails to load on
 * their machine), a bare query string, or just the code.
 */
export function parseRedirectResponse(pasted: string): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  const trimmed = pasted.trim();
  const queryStart = trimmed.indexOf('?');
  const candidate = queryStart >= 0 ? trimmed.slice(queryStart + 1) : trimmed;
  // A BARE CODE IS NOT A QUERY STRING, even with `=` in it (base64 padding):
  // decide on the presence of a parameter this flow actually uses.
  if (!/(^|&)(code|state|error|error_description)=/.test(candidate)) {
    return { code: trimmed || undefined };
  }
  const query = candidate;
  // Strip a fragment: some servers append one, and it is never part of the query.
  const params = new URLSearchParams(query.split('#')[0]);
  return {
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    error: params.get('error') ?? undefined,
    errorDescription: params.get('error_description') ?? undefined,
  };
}

async function postToken(fetchImpl: FetchLike, tokenEndpoint: string, form: URLSearchParams): Promise<TokenResponse> {
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A non-JSON body goes through the status path below, and its text is NOT
    // echoed: a token endpoint's error body can contain the credential sent to it.
  }
  if (!res.ok) {
    const code = typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`;
    const description = typeof parsed.error_description === 'string' ? parsed.error_description : undefined;
    throw new OAuthTokenError(code, res.status, description);
  }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new Error(`Token endpoint ${tokenEndpoint} returned no access_token`);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
  };
}

export async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource?: string;
  },
): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) form.set('client_secret', input.clientSecret);
  if (input.resource) form.set('resource', input.resource);
  return postToken(fetchImpl, input.tokenEndpoint, form);
}

export async function refreshAccessToken(
  fetchImpl: FetchLike,
  input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scopes?: string;
    resource?: string;
  },
): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  if (input.clientSecret) form.set('client_secret', input.clientSecret);
  // Re-send the scopes the grant already has: never widening (RFC 6749 §6), and
  // some servers read an omitted scope as "none".
  if (input.scopes) form.set('scope', input.scopes);
  if (input.resource) form.set('resource', input.resource);
  return postToken(fetchImpl, input.tokenEndpoint, form);
}
