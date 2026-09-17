/**
 * Discovery: the challenge header, the two well-known path RULES (which are
 * deliberately different shapes), and the full chain against fixtures captured
 * from the live Dropbox and Amplitude endpoints on 2026-09-17.
 *
 * Hermetic: every `fetch` is a local stub. Nothing here touches the network.
 */
import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../../test-hermeticity.js';
import {
  authorizationServerMetadataUrls,
  discoverAuthorization,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
  type FetchLike,
} from './discovery.js';

enforceHermeticity();

/** Minimal Response stand-in — only what discovery.ts reads. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function routed(routes: Record<string, Response>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return json({ error: 'not found' }, 404);
    return hit;
  };
}

describe('parseWwwAuthenticate', () => {
  it('reads resource_metadata out of the live Dropbox challenge', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer resource_metadata="https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="missing bearer token"',
      ),
    ).toBe('https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp');
  });

  it('reads it when it is not the first parameter (the live Amplitude challenge)', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="OAuth", resource_metadata="https://mcp.amplitude.com/.well-known/oauth-protected-resource", error="invalid_request", error_description="Missing authorization header"',
      ),
    ).toBe('https://mcp.amplitude.com/.well-known/oauth-protected-resource');
  });

  it('accepts an unquoted value and rejects an absent one', () => {
    expect(parseWwwAuthenticate('Bearer resource_metadata=https://x/.well-known/a, error="x"')).toBe(
      'https://x/.well-known/a',
    );
    expect(parseWwwAuthenticate('Bearer realm="OAuth"')).toBeUndefined();
    expect(parseWwwAuthenticate(null)).toBeUndefined();
    expect(parseWwwAuthenticate(undefined)).toBeUndefined();
  });
});

describe('well-known URL rules', () => {
  it('APPENDS the resource path for a protected resource (RFC 9728), most specific first', () => {
    expect(protectedResourceMetadataUrls('https://mcp.dropbox.com/mcp')).toEqual([
      'https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp',
      'https://mcp.dropbox.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('offers only the bare form when the MCP URL has no path', () => {
    expect(protectedResourceMetadataUrls('https://mcp.amplitude.com/')).toEqual([
      'https://mcp.amplitude.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('INSERTS the issuer path for an authorization server (RFC 8414) — the opposite rule', () => {
    expect(authorizationServerMetadataUrls('https://auth.example.com/tenant-7')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant-7',
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration/tenant-7',
      'https://auth.example.com/tenant-7/.well-known/openid-configuration',
    ]);
  });

  it('dedupes a path-less issuer down to two probes', () => {
    expect(authorizationServerMetadataUrls('https://www.dropbox.com')).toEqual([
      'https://www.dropbox.com/.well-known/oauth-authorization-server',
      'https://www.dropbox.com/.well-known/openid-configuration',
    ]);
  });
});

describe('discoverAuthorization', () => {
  it('walks challenge → resource metadata → AS metadata (Dropbox shape)', async () => {
    const calls: string[] = [];
    const fetchImpl = routed(
      {
        'https://mcp.dropbox.com/mcp': json({}, 401, {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
        }),
        'https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp': json({
          resource: 'https://mcp.dropbox.com/mcp',
          authorization_servers: ['https://www.dropbox.com'],
          scopes_supported: ['account_info.read', 'files.metadata.read'],
        }),
        'https://www.dropbox.com/.well-known/oauth-authorization-server': json({
          issuer: 'https://www.dropbox.com',
          authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
          token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
          registration_endpoint: 'https://www.dropbox.com/oauth2/register',
          code_challenge_methods_supported: ['plain', 'S256'],
          grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token', 'device_code'],
          // 39 scopes live; two here stand in for "the AS list is wider than
          // the resource's" — the assertion below is that the resource wins.
          scopes_supported: ['account_info.read', 'team_info.read'],
        }),
      },
      calls,
    );

    const result = await discoverAuthorization(fetchImpl, 'https://mcp.dropbox.com/mcp');

    expect(result).toEqual({
      resource: 'https://mcp.dropbox.com/mcp',
      issuer: 'https://www.dropbox.com',
      authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
      // The token endpoint is on a DIFFERENT host from the issuer; deriving it
      // from the issuer would have produced the wrong URL.
      tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
      registrationEndpoint: 'https://www.dropbox.com/oauth2/register',
      // Advertises the device_code GRANT but publishes no endpoint to start it
      // at — the live metadata really is like this, and it is why `--device`
      // refuses Dropbox instead of guessing a URL.
      deviceAuthorizationEndpoint: undefined,
      grantTypesSupported: ['authorization_code', 'client_credentials', 'refresh_token', 'device_code'],
      scopesSupported: ['account_info.read', 'files.metadata.read'],
      codeChallengeMethods: ['plain', 'S256'],
    });
    expect(calls[0]).toBe('https://mcp.dropbox.com/mcp');
  });

  it('falls back to the bare well-known path when the server sends no challenge (Amplitude shape)', async () => {
    const calls: string[] = [];
    const fetchImpl = routed(
      {
        'https://mcp.amplitude.com/mcp': json({}, 401),
        'https://mcp.amplitude.com/.well-known/oauth-protected-resource': json({
          resource: 'https://mcp.amplitude.com',
          authorization_servers: ['https://mcp.amplitude.com'],
          scopes_supported: ['mcp:read', 'mcp:write'],
        }),
        'https://mcp.amplitude.com/.well-known/oauth-authorization-server': json({
          issuer: 'https://mcp.amplitude.com',
          authorization_endpoint: 'https://mcp.amplitude.com/authorize',
          token_endpoint: 'https://mcp.amplitude.com/token',
          registration_endpoint: 'https://mcp.amplitude.com/register',
          code_challenge_methods_supported: ['S256'],
        }),
      },
      calls,
    );

    const result = await discoverAuthorization(fetchImpl, 'https://mcp.amplitude.com/mcp');
    expect(result.tokenEndpoint).toBe('https://mcp.amplitude.com/token');
    // The path-suffixed candidate is tried first and 404s; the bare one wins.
    expect(calls).toContain('https://mcp.amplitude.com/.well-known/oauth-protected-resource/mcp');
    expect(calls).toContain('https://mcp.amplitude.com/.well-known/oauth-protected-resource');
  });

  it('skips an AS document that has no token endpoint and keeps probing', async () => {
    const fetchImpl = routed({
      'https://mcp.x.test/mcp': json({}, 401),
      'https://mcp.x.test/.well-known/oauth-protected-resource': json({
        authorization_servers: ['https://as.x.test'],
      }),
      'https://as.x.test/.well-known/oauth-authorization-server': json({ issuer: 'https://as.x.test' }),
      'https://as.x.test/.well-known/openid-configuration': json({
        issuer: 'https://as.x.test',
        authorization_endpoint: 'https://as.x.test/auth',
        token_endpoint: 'https://as.x.test/tok',
      }),
    });

    const result = await discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp');
    expect(result.tokenEndpoint).toBe('https://as.x.test/tok');
  });

  it('names every URL it tried when nothing answers', async () => {
    const fetchImpl = routed({});
    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(
      /No OAuth protected-resource metadata[\s\S]*oauth-protected-resource\/mcp[\s\S]*oauth-protected-resource/,
    );
  });

  it('demands an issuer when the resource metadata lists none', async () => {
    const fetchImpl = routed({
      'https://mcp.x.test/mcp': json({}, 401),
      'https://mcp.x.test/.well-known/oauth-protected-resource': json({ resource: 'https://mcp.x.test' }),
    });
    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(/--issuer/);
  });
});
