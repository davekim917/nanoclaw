/**
 * PKCE, the authorize URL, the paste-back parser, and the two token grants —
 * including the one error code the refresher's whole control flow keys on.
 */
import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../../test-hermeticity.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isUnrecoverableGrantError,
  OAuthTokenError,
  parseRedirectResponse,
  refreshAccessToken,
} from './oauth-client.js';
import { createPkcePair, createState, pkceChallenge } from './pkce.js';

enforceHermeticity();

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    // verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" →
    // challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" (RFC 7636 §B).
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('mints a 43-character base64url verifier (RFC 7636 §4.1 minimum) and a matching challenge', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(pair.method).toBe('S256');
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
  });

  it('never repeats a state', () => {
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(states.size).toBe(50);
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1:8765/callback',
    state: 'st-1',
    codeChallenge: 'ch-1',
  };

  it('carries the full PKCE + resource-indicator request', () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...base,
        scopes: 'files.metadata.read sharing.read',
        resource: 'https://mcp.dropbox.com/mcp',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      state: 'st-1',
      code_challenge: 'ch-1',
      code_challenge_method: 'S256',
      scope: 'files.metadata.read sharing.read',
      resource: 'https://mcp.dropbox.com/mcp',
    });
  });

  it('omits scope and resource when there are none, and appends provider quirks', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, extraParams: { token_access_type: 'offline' } }));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('resource')).toBeNull();
    // Dropbox issues no refresh token without this.
    expect(url.searchParams.get('token_access_type')).toBe('offline');
  });
});

describe('parseRedirectResponse', () => {
  it('takes the whole URL the browser landed on', () => {
    expect(parseRedirectResponse('http://127.0.0.1:8765/callback?code=abc123&state=st-1')).toEqual({
      code: 'abc123',
      state: 'st-1',
      error: undefined,
      errorDescription: undefined,
    });
  });

  it('takes a bare query string, and a bare code', () => {
    expect(parseRedirectResponse('code=abc&state=st').code).toBe('abc');
    expect(parseRedirectResponse('  abc123  ')).toEqual({ code: 'abc123' });
  });

  it('drops a trailing fragment rather than folding it into the state', () => {
    expect(parseRedirectResponse('http://127.0.0.1/cb?code=a&state=b#_=_').state).toBe('b');
  });

  it('surfaces a denial instead of pretending there is a code', () => {
    const parsed = parseRedirectResponse('http://127.0.0.1/cb?error=access_denied&error_description=User+said+no');
    expect(parsed.code).toBeUndefined();
    expect(parsed.error).toBe('access_denied');
    expect(parsed.errorDescription).toBe('User said no');
  });
});

describe('token grants', () => {
  it('posts the authorization-code grant as form-encoded with the verifier', async () => {
    let seen: { url: string; body: string; contentType: string } | undefined;
    const token = await exchangeAuthorizationCode(
      async (url, init) => {
        seen = {
          url,
          body: String(init?.body),
          contentType: (init?.headers as Record<string, string>)['content-type'],
        };
        return response({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'a b',
        });
      },
      {
        tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
        clientId: 'client-1',
        code: 'code-1',
        codeVerifier: 'ver-1',
        redirectUri: 'http://127.0.0.1:8765/callback',
        resource: 'https://mcp.dropbox.com/mcp',
      },
    );

    expect(token).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 3600,
      scope: 'a b',
      tokenType: 'Bearer',
    });
    expect(seen!.contentType).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(seen!.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('ver-1');
    expect(form.get('resource')).toBe('https://mcp.dropbox.com/mcp');
    expect(form.get('client_secret')).toBeNull();
  });

  it('sends client_secret only for a confidential client', async () => {
    let body = '';
    await refreshAccessToken(
      async (_url, init) => {
        body = String(init?.body);
        return response({ access_token: 'at-2', token_type: 'Bearer' });
      },
      {
        tokenEndpoint: 'https://mcp.amplitude.com/token',
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
        scopes: 'mcp:read',
      },
    );
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('client_secret')).toBe('s');
    expect(form.get('scope')).toBe('mcp:read');
  });

  it('preserves the RFC 6749 §5.2 error code so the refresher can act on it', async () => {
    const err = await refreshAccessToken(
      async () => response({ error: 'invalid_grant', error_description: 'expired' }, 400),
      {
        tokenEndpoint: 'https://t.test/token',
        clientId: 'c',
        refreshToken: 'rt',
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OAuthTokenError);
    expect((err as OAuthTokenError).code).toBe('invalid_grant');
    expect((err as OAuthTokenError).status).toBe(400);
    expect(isUnrecoverableGrantError(err)).toBe(true);
  });

  it('treats a 5xx as retryable, not as a dead grant', async () => {
    const err = await refreshAccessToken(async () => response('upstream exploded', 503), {
      tokenEndpoint: 'https://t.test/token',
      clientId: 'c',
      refreshToken: 'rt',
    }).catch((e: unknown) => e);

    expect((err as OAuthTokenError).code).toBe('http_503');
    expect(isUnrecoverableGrantError(err)).toBe(false);
    // A non-JSON error body is never echoed: it can contain what was sent to it.
    expect((err as Error).message).not.toContain('upstream exploded');
  });

  it('rejects a 200 that carries no access token', async () => {
    await expect(
      refreshAccessToken(async () => response({ token_type: 'Bearer' }), {
        tokenEndpoint: 'https://t.test/token',
        clientId: 'c',
        refreshToken: 'rt',
      }),
    ).rejects.toThrow(/no access_token/);
  });
});

// Issue #876 P3(e): the old test for "is this a query string?" was
// `trimmed.includes('=')`, so a bare base64 code carrying its padding was
// parsed as a parameter list — `URLSearchParams('AbC9==')` yields a parameter
// NAMED `AbC9`, no `code`, and the operator was told their code was missing.
describe('parseRedirectResponse — a bare code is not a query string', () => {
  it('accepts a base64-padded code pasted on its own', () => {
    expect(parseRedirectResponse('bDRkaXNwbGF5X25hbWU9dGVzdA==')).toEqual({ code: 'bDRkaXNwbGF5X25hbWU9dGVzdA==' });
    expect(parseRedirectResponse('  QUJD=  ')).toEqual({ code: 'QUJD=' });
  });

  it('still reads a real query string, with or without a URL around it', () => {
    expect(parseRedirectResponse('code=abc&state=st')).toMatchObject({ code: 'abc', state: 'st' });
    expect(parseRedirectResponse('?code=abc&state=st')).toMatchObject({ code: 'abc', state: 'st' });
    expect(parseRedirectResponse('http://127.0.0.1:8765/callback?code=abc&state=st')).toMatchObject({
      code: 'abc',
      state: 'st',
    });
    expect(parseRedirectResponse('http://127.0.0.1:8765/callback?error=access_denied')).toMatchObject({
      error: 'access_denied',
    });
  });

  it('does not mistake a code that merely CONTAINS an oauth-ish word for a query', () => {
    // `code` only counts at the start or after an `&`.
    expect(parseRedirectResponse('xcode=abc')).toEqual({ code: 'xcode=abc' });
  });
});
