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
  assertIssuerMatches,
  assertResourceMatchesMcpUrl,
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

  // Round-1 review F2: metadata is fetched from the network, so an `http:`
  // endpoint in it would put the authorization code, the client secret and the
  // refresh token on the wire in cleartext.
  it.each([
    ['authorization_endpoint', { authorization_endpoint: 'http://as.x.test/auth' }],
    ['token_endpoint', { token_endpoint: 'http://as.x.test/tok' }],
    ['registration_endpoint', { registration_endpoint: 'http://as.x.test/reg' }],
    ['device_authorization_endpoint', { device_authorization_endpoint: 'http://as.x.test/da' }],
  ])('refuses a cleartext %s rather than sending credentials over it', async (label, override) => {
    const fetchImpl = routed({
      'https://mcp.x.test/mcp': json({}, 401),
      'https://mcp.x.test/.well-known/oauth-protected-resource': json({
        authorization_servers: ['https://as.x.test'],
      }),
      'https://as.x.test/.well-known/oauth-authorization-server': json({
        issuer: 'https://as.x.test',
        authorization_endpoint: 'https://as.x.test/auth',
        token_endpoint: 'https://as.x.test/tok',
        registration_endpoint: 'https://as.x.test/reg',
        ...override,
      }),
    });
    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(
      new RegExp(`${label} must be https`),
    );
  });

  // Round-3 review F1: the earlier fix gated the four ENDPOINTS and the
  // `--issuer` override, and missed the discovered issuer — which is the
  // load-bearing one. Over cleartext the metadata DOCUMENT can be substituted
  // wholesale, and every https endpoint inside a forged one passes the
  // per-endpoint check.
  it('refuses a cleartext issuer from the resource metadata, before fetching from it', async () => {
    const calls: string[] = [];
    const fetchImpl = routed(
      {
        'https://mcp.x.test/mcp': json({}, 401),
        'https://mcp.x.test/.well-known/oauth-protected-resource': json({
          authorization_servers: ['http://as.x.test'],
        }),
        'http://as.x.test/.well-known/oauth-authorization-server': json({
          issuer: 'http://as.x.test',
          authorization_endpoint: 'https://evil.x.test/auth',
          token_endpoint: 'https://evil.x.test/tok',
        }),
      },
      calls,
    );

    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(
      /authorization_servers entry must be https/,
    );
    // Before the fetch: the forged document is never even read.
    expect(calls).not.toContain('http://as.x.test/.well-known/oauth-authorization-server');
  });

  it('demands an issuer when the resource metadata lists none', async () => {
    const fetchImpl = routed({
      'https://mcp.x.test/mcp': json({}, 401),
      'https://mcp.x.test/.well-known/oauth-protected-resource': json({ resource: 'https://mcp.x.test' }),
    });
    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(/--issuer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #876 — the three bindings a discovery chain has to enforce
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three integrations live on this host, captured VERBATIM from their
 * well-known documents on 2026-09-17 with read-only GETs:
 *
 *   curl -s https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp
 *   curl -s https://www.dropbox.com/.well-known/oauth-authorization-server
 *   curl -s https://mcp.amplitude.com/.well-known/oauth-protected-resource
 *   curl -s https://mcp.amplitude.com/.well-known/oauth-authorization-server
 *   curl -s https://mcp.littlebird.ai/.well-known/oauth-protected-resource/mcp
 *   curl -s https://mcp.littlebird.ai/.well-known/oauth-authorization-server
 *
 * They are the regression oracle for every check below: each one is a real
 * refresh/re-login that must keep working, and between them they cover all
 * three shapes the new rules have to tolerate — an equal resource (Dropbox,
 * Littlebird), a resource that is only a PREFIX of the MCP URL (Amplitude), and
 * an issuer published WITH a trailing slash (Littlebird).
 */
const LIVE_SHAPES = {
  dropbox: {
    mcpUrl: 'https://mcp.dropbox.com/mcp',
    resourceDocUrl: 'https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp',
    resourceDoc: {
      resource: 'https://mcp.dropbox.com/mcp',
      authorization_servers: ['https://www.dropbox.com'],
      scopes_supported: ['account_info.read', 'files.metadata.read'],
    },
    asDocUrl: 'https://www.dropbox.com/.well-known/oauth-authorization-server',
    asDoc: {
      issuer: 'https://www.dropbox.com',
      authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
      token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
      registration_endpoint: 'https://www.dropbox.com/oauth2/register',
      code_challenge_methods_supported: ['plain', 'S256'],
    },
    expectedIssuer: 'https://www.dropbox.com',
  },
  amplitude: {
    mcpUrl: 'https://mcp.amplitude.com/mcp',
    resourceDocUrl: 'https://mcp.amplitude.com/.well-known/oauth-protected-resource',
    resourceDoc: {
      // NOT equal to the MCP URL — the origin, with MCP served under /mcp.
      resource: 'https://mcp.amplitude.com',
      authorization_servers: ['https://mcp.amplitude.com'],
      scopes_supported: ['mcp:read', 'mcp:write'],
    },
    asDocUrl: 'https://mcp.amplitude.com/.well-known/oauth-authorization-server',
    asDoc: {
      issuer: 'https://mcp.amplitude.com',
      authorization_endpoint: 'https://mcp.amplitude.com/authorize',
      token_endpoint: 'https://mcp.amplitude.com/token',
      registration_endpoint: 'https://mcp.amplitude.com/register',
      code_challenge_methods_supported: ['S256'],
    },
    expectedIssuer: 'https://mcp.amplitude.com',
  },
  littlebird: {
    mcpUrl: 'https://mcp.littlebird.ai/mcp',
    resourceDocUrl: 'https://mcp.littlebird.ai/.well-known/oauth-protected-resource/mcp',
    resourceDoc: {
      resource: 'https://mcp.littlebird.ai/mcp',
      // WITH a trailing slash, which is what makes the issuer comparison need
      // normalizing at all.
      authorization_servers: ['https://mcp.littlebird.ai/'],
      scopes_supported: ['littlebird:mcp', 'openid', 'email'],
      bearer_methods_supported: ['header'],
    },
    asDocUrl: 'https://mcp.littlebird.ai/.well-known/oauth-authorization-server',
    asDoc: {
      issuer: 'https://mcp.littlebird.ai/',
      authorization_endpoint: 'https://mcp.littlebird.ai/authorize',
      token_endpoint: 'https://mcp.littlebird.ai/token',
      registration_endpoint: 'https://mcp.littlebird.ai/register',
      code_challenge_methods_supported: ['S256'],
    },
    expectedIssuer: 'https://mcp.littlebird.ai/',
  },
} as const;

type LiveShape = (typeof LIVE_SHAPES)[keyof typeof LIVE_SHAPES];

function liveRoutes(
  shape: LiveShape,
  overrides: { resourceDoc?: Record<string, unknown>; asDoc?: Record<string, unknown> } = {},
): Record<string, Response> {
  return {
    [shape.mcpUrl]: json({}, 401, {
      'www-authenticate': `Bearer resource_metadata="${shape.resourceDocUrl}", error="invalid_token"`,
    }),
    [shape.resourceDocUrl]: json(overrides.resourceDoc ?? shape.resourceDoc),
    [shape.asDocUrl]: json(overrides.asDoc ?? shape.asDoc),
  };
}

describe('the three live integrations still pass discovery', () => {
  it.each(Object.entries(LIVE_SHAPES))('%s', async (_name, shape) => {
    const result = await discoverAuthorization(routed(liveRoutes(shape)), shape.mcpUrl);
    expect(result.issuer).toBe(shape.expectedIssuer);
    expect(result.tokenEndpoint).toBe(shape.asDoc.token_endpoint);
    expect(result.resource).toBe(shape.resourceDoc.resource);
  });
});

describe('RFC 8414 §3.3 — the AS metadata issuer must be the issuer it was fetched for', () => {
  it('refuses a document that claims a different issuer', async () => {
    const fetchImpl = routed(
      liveRoutes(LIVE_SHAPES.dropbox, {
        asDoc: { ...LIVE_SHAPES.dropbox.asDoc, issuer: 'https://evil.test' },
      }),
    );
    await expect(discoverAuthorization(fetchImpl, LIVE_SHAPES.dropbox.mcpUrl)).rejects.toThrow(
      /declares issuer "https:\/\/evil\.test"[\s\S]*fetched for[\s\S]*www\.dropbox\.com/,
    );
  });

  it('refuses a document that declares no issuer at all', async () => {
    const asDoc: Record<string, unknown> = { ...LIVE_SHAPES.dropbox.asDoc };
    delete asDoc.issuer;
    const fetchImpl = routed(liveRoutes(LIVE_SHAPES.dropbox, { asDoc }));
    await expect(discoverAuthorization(fetchImpl, LIVE_SHAPES.dropbox.mcpUrl)).rejects.toThrow(/declares no issuer/);
  });

  it('normalizes the trailing slash and NOTHING else', () => {
    // Littlebird's own shape, both ways round.
    expect(() => assertIssuerMatches('https://mcp.littlebird.ai/', 'https://mcp.littlebird.ai', 'doc')).not.toThrow();
    expect(() => assertIssuerMatches('https://mcp.littlebird.ai', 'https://mcp.littlebird.ai/', 'doc')).not.toThrow();
    // A different path, host or port is a different issuer.
    expect(() => assertIssuerMatches('https://mcp.littlebird.ai/t2', 'https://mcp.littlebird.ai', 'doc')).toThrow();
    expect(() => assertIssuerMatches('https://other.littlebird.ai', 'https://mcp.littlebird.ai', 'doc')).toThrow();
    expect(() => assertIssuerMatches('https://mcp.littlebird.ai:8443', 'https://mcp.littlebird.ai', 'doc')).toThrow();
  });
});

describe('RFC 9728 §3.3 — the protected-resource document must describe this MCP URL', () => {
  it.each(Object.values(LIVE_SHAPES))('accepts the live shape for $mcpUrl', (shape) => {
    expect(() => assertResourceMatchesMcpUrl(shape.resourceDoc.resource, shape.mcpUrl)).not.toThrow();
  });

  it('refuses a document describing another origin', () => {
    expect(() => assertResourceMatchesMcpUrl('https://evil.test/mcp', 'https://mcp.dropbox.com/mcp')).toThrow(
      /RFC 9728 §3.3/,
    );
  });

  it('refuses a sibling path, and a prefix that is not on a segment boundary', () => {
    expect(() => assertResourceMatchesMcpUrl('https://mcp.x.test/other', 'https://mcp.x.test/mcp')).toThrow();
    // "/mcp" must not be satisfied by "/mcp-admin".
    expect(() => assertResourceMatchesMcpUrl('https://mcp.x.test/mcp', 'https://mcp.x.test/mcp-admin')).toThrow();
    expect(() => assertResourceMatchesMcpUrl('https://mcp.x.test/mcp', 'https://mcp.x.test/mcp/v2')).not.toThrow();
  });

  it('fails the whole discovery when no candidate document describes this resource', async () => {
    const fetchImpl = routed(
      liveRoutes(LIVE_SHAPES.amplitude, {
        resourceDoc: { ...LIVE_SHAPES.amplitude.resourceDoc, resource: 'https://someone-else.test' },
      }),
    );
    await expect(discoverAuthorization(fetchImpl, LIVE_SHAPES.amplitude.mcpUrl)).rejects.toThrow(/RFC 9728 §3.3/);
  });

  it('lets an origin-only resource cover every path on its origin — Amplitude declares its origin and serves /mcp', () => {
    expect(() =>
      assertResourceMatchesMcpUrl('https://mcp.amplitude.com', 'https://mcp.amplitude.com/mcp'),
    ).not.toThrow();
    // Every path, by design — not just the one Amplitude uses.
    expect(() =>
      assertResourceMatchesMcpUrl('https://mcp.amplitude.com/', 'https://mcp.amplitude.com/any/other/path'),
    ).not.toThrow();
    // Still bounded by the origin.
    expect(() => assertResourceMatchesMcpUrl('https://mcp.amplitude.com', 'https://amplitude.com/mcp')).toThrow(
      /does not cover/,
    );
  });

  it('says "not a URL" for a URN-shaped resource, rather than "does not cover" (#911)', () => {
    const attempt = () => assertResourceMatchesMcpUrl('urn:example:mcp-server', 'https://mcp.x.test/mcp');
    expect(attempt).toThrow(/is not a URL/);
    expect(attempt).not.toThrow(/does not cover/);
  });

  it('tolerates a document with no resource at all — absence cannot forge a match', () => {
    expect(() => assertResourceMatchesMcpUrl(undefined, 'https://mcp.x.test/mcp')).not.toThrow();
  });
});

describe('cleartext is refused before anything is fetched (#876 P2-3)', () => {
  it('refuses an http:// MCP URL without probing it', async () => {
    const calls: string[] = [];
    await expect(discoverAuthorization(routed({}, calls), 'http://mcp.example.com/mcp')).rejects.toThrow(
      /--url must be https/,
    );
    // Nothing was probed: the bearer token would be sent to this URL.
    expect(calls).toEqual([]);
  });

  it('never fetches a cleartext resource_metadata URL from a challenge, and still tries the well-known paths', async () => {
    const calls: string[] = [];
    const fetchImpl = routed(
      {
        'https://mcp.example.com/mcp': json({}, 401, {
          'www-authenticate': 'Bearer resource_metadata="http://evil.example.net/prm"',
        }),
      },
      calls,
    );
    await expect(discoverAuthorization(fetchImpl, 'https://mcp.example.com/mcp')).rejects.toThrow(
      /resource_metadata must be https/,
    );
    // The advertised cleartext URL is named in the failure list but was never
    // requested; the https well-known candidates were.
    expect(calls).not.toContain('http://evil.example.net/prm');
    expect(calls.some((u) => u.startsWith('https://mcp.example.com/.well-known/oauth-protected-resource'))).toBe(true);
  });
});

// #905 review round 2: the probe list includes the ROOT well-known path as a
// fallback for a path-carrying issuer, and on a multi-tenant host that document
// is complete and belongs to a different tenant. Checking the issuer after the
// loop let that document end a discovery the tenant-specific candidate would
// have completed.
describe('a mismatched candidate is skipped, not fatal', () => {
  const ISSUER = 'https://as.x.test/tenant-7';

  it('keeps probing past a complete root document that belongs to another issuer', async () => {
    const calls: string[] = [];
    const fetchImpl = routed(
      {
        'https://mcp.x.test/mcp': json({}, 401),
        'https://mcp.x.test/.well-known/oauth-protected-resource/mcp': json({
          resource: 'https://mcp.x.test/mcp',
          authorization_servers: [ISSUER],
        }),
        // Candidate 1 (…/oauth-authorization-server/tenant-7) 404s.
        // Candidate 2: the host's root document — complete, and someone else's.
        'https://as.x.test/.well-known/oauth-authorization-server': json({
          issuer: 'https://as.x.test/tenant-1',
          authorization_endpoint: 'https://as.x.test/tenant-1/authorize',
          token_endpoint: 'https://as.x.test/tenant-1/token',
        }),
        // Candidate 3: the tenant's own document.
        'https://as.x.test/.well-known/openid-configuration/tenant-7': json({
          issuer: ISSUER,
          authorization_endpoint: 'https://as.x.test/tenant-7/authorize',
          token_endpoint: 'https://as.x.test/tenant-7/token',
          code_challenge_methods_supported: ['S256'],
        }),
      },
      calls,
    );

    const result = await discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp');
    expect(result.issuer).toBe(ISSUER);
    expect(result.tokenEndpoint).toBe('https://as.x.test/tenant-7/token');
    // It really did read the other tenant's document and move on.
    expect(calls).toContain('https://as.x.test/.well-known/oauth-authorization-server');
  });

  it('still fails, naming every mismatch, when NO candidate declares the right issuer', async () => {
    const fetchImpl = routed({
      'https://mcp.x.test/mcp': json({}, 401),
      'https://mcp.x.test/.well-known/oauth-protected-resource/mcp': json({
        resource: 'https://mcp.x.test/mcp',
        authorization_servers: [ISSUER],
      }),
      'https://as.x.test/.well-known/oauth-authorization-server': json({
        issuer: 'https://as.x.test/tenant-1',
        authorization_endpoint: 'https://as.x.test/tenant-1/authorize',
        token_endpoint: 'https://as.x.test/tenant-1/token',
      }),
    });

    await expect(discoverAuthorization(fetchImpl, 'https://mcp.x.test/mcp')).rejects.toThrow(
      /No authorization-server metadata for issuer[\s\S]*declares issuer "https:\/\/as\.x\.test\/tenant-1"/,
    );
  });
});
