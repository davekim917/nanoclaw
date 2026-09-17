/**
 * `startLogin` / `completeLogin` — the two round-1 findings that live on the
 * login side rather than the refresh side:
 *
 *   F3  a registration is only reusable while it still binds to this issuer and
 *       this redirect URI, and was not rejected by the server.
 *   F4  on a NEW grant, an absent refresh token means absent — it must not fall
 *       back to the token the grant just replaced.
 *
 * Hermetic: migrated in-memory DB, `DATA_DIR` in a per-run temp dir, the OneCLI
 * writer and the `container.json` writer mocked at their module boundaries, and
 * every HTTP call an injected stub.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-login-'));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return tmpRoot;
    },
  };
});

vi.mock('../../log.js', () => ({
  log: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
  },
  setLogScrubber: () => undefined,
  isSurvivableIoError: () => false,
}));

// `ensureSecretDeclared` writes `groups/<folder>/container.json`, which is a
// real repo path the hermeticity guard denylists — and it is not what these
// cases are about.
const declared: string[] = [];
vi.mock('../../container-config.js', () => ({
  updateContainerConfig: async (folder: string, mutate: (c: { onecliSecrets?: string[] }) => void) => {
    const config: { onecliSecrets?: string[] } = { onecliSecrets: [...declared] };
    mutate(config);
    declared.length = 0;
    declared.push(...(config.onecliSecrets ?? []));
    return { folder, ...config };
  },
}));

vi.mock('./onecli-secret-writer.js', () => ({
  putOnecliBearerSecret: async (spec: { name: string }) => ({ id: 'secret-uuid-1', name: spec.name }),
  findOnecliSecretByName: async () => undefined,
  deleteOnecliSecret: async () => true,
}));

import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import { getMcpOAuthIntegration, markMcpOAuthIntegration } from '../../db/mcp-oauth-integrations.js';
import { enforceHermeticity } from '../../test-hermeticity.js';
import type { FetchLike } from './discovery.js';
import { completeLogin, refreshExpiringMcpOAuthIntegrations, removeIntegration, startLogin } from './service.js';
import { readMcpOAuthBundle, writeMcpOAuthBundle } from './store.js';

enforceHermeticity();

const MCP_URL = 'https://mcp.example.test/mcp';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Discovery + registration + token endpoint, with registrations recorded. */
function server(options: { registrations: string[]; tokenBody?: unknown; issuer?: string }): FetchLike {
  const issuer = options.issuer ?? 'https://as.example.test';
  return async (url, init) => {
    if (url === MCP_URL) return json({}, 401);
    if (url === 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: MCP_URL, authorization_servers: [issuer], scopes_supported: ['a.read'] });
    }
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === `${issuer}/register`) {
      const id = `client-${options.registrations.length + 1}`;
      options.registrations.push(
        String((JSON.parse(String(init?.body)) as { redirect_uris: string[] }).redirect_uris[0]),
      );
      return json({ client_id: id, redirect_uris: ['x'] }, 201);
    }
    if (url === `${issuer}/token`) {
      return json(
        options.tokenBody ?? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' },
      );
    }
    return json({ error: 'not found' }, 404);
  };
}

async function login(over: Partial<Parameters<typeof startLogin>[0]> = {}, fetchImpl?: FetchLike) {
  const registrations: string[] = [];
  return {
    registrations,
    result: await startLogin(
      { name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1', ...over },
      fetchImpl ?? server({ registrations }),
    ),
  };
}

beforeEach(async () => {
  await initMigratedTestDb();
  declared.length = 0;
  fs.rmSync(path.join(tmpRoot, 'mcp-oauth'), { recursive: true, force: true });
  await createAgentGroup({
    id: 'ag-1',
    name: 'Example',
    folder: 'example',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('startLogin — when a registration may be reused (round-1 F3)', () => {
  it('registers once and reuses the client on an identical re-login', async () => {
    const registrations: string[] = [];
    const fetchImpl = server({ registrations });

    const first = await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect(first.registered).toBe('dynamic');

    const second = await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect(second.registered).toBe('reused');
    // One client at the provider, not one per abandoned attempt.
    expect(registrations).toHaveLength(1);
  });

  it('registers again when the redirect URI moves, because the server stored the old one', async () => {
    const registrations: string[] = [];
    const fetchImpl = server({ registrations });

    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    const second = await startLogin(
      { name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1', port: 9999 },
      fetchImpl,
    );

    expect(second.registered).toBe('dynamic');
    expect(second.redirectUri).toBe('http://127.0.0.1:9999/callback');
    expect(registrations).toEqual(['http://127.0.0.1:8765/callback', 'http://127.0.0.1:9999/callback']);
  });

  it('registers again when the issuer moves, because a client id means nothing at another AS', async () => {
    const registrations: string[] = [];
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, server({ registrations }));

    const moved = await startLogin(
      { name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' },
      server({ registrations, issuer: 'https://as2.example.test' }),
    );
    expect(moved.registered).toBe('dynamic');
    expect(registrations).toHaveLength(2);
  });

  it('registers again after the server rejected the client, which is what makes "run login again" true', async () => {
    const registrations: string[] = [];
    const fetchImpl = server({ registrations });
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);

    // What the refresher records on `invalid_client` / `unauthorized_client`.
    const bundle = readMcpOAuthBundle('example-int')!;
    writeMcpOAuthBundle({ ...bundle, clientRejectedAt: new Date().toISOString() });

    const again = await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect(again.registered).toBe('dynamic');
    expect(registrations).toHaveLength(2);
    // And the new registration starts clean.
    expect(readMcpOAuthBundle('example-int')!.clientRejectedAt).toBeUndefined();
  });
});

describe('startLogin — overrides go through the same HTTPS gate (round-2 F4)', () => {
  it('refuses a cleartext --issuer, which would have the AS metadata fetched in the clear', async () => {
    await expect(
      startLogin(
        { name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1', issuer: 'http://as.example.test' },
        server({ registrations: [] }),
      ),
    ).rejects.toThrow(/--issuer must be https/);
  });

  it('refuses a cleartext --device-endpoint, which would hand an attacker the verification URL', async () => {
    await expect(
      startLogin(
        {
          name: 'example-int',
          mcpUrl: MCP_URL,
          agentGroupId: 'ag-1',
          device: true,
          deviceEndpoint: 'http://as.example.test/device',
        },
        server({ registrations: [] }),
      ),
    ).rejects.toThrow(/--device-endpoint must be https/);
  });
});

describe('completeLogin — a new grant owns its own refresh token (round-1 F4)', () => {
  it('stores the refresh token the exchange returned and declares the secret', async () => {
    const { result } = await login();
    const done = await completeLogin(
      { name: 'example-int', redirectResponse: `http://127.0.0.1:8765/callback?code=c&state=${result.state}` },
      server({ registrations: [] }),
    );

    expect(done.hasRefreshToken).toBe(true);
    expect(readMcpOAuthBundle('example-int')!.refreshToken).toBe('rt-1');
    expect(declared).toEqual([result.bearerSecretName]);
    expect((await getMcpOAuthIntegration('example-int'))!.status).toBe('active');
  });

  it('does NOT resurrect the previous refresh token when the new grant returns none', async () => {
    const { result } = await login();
    // A grant that predates this login — after an invalid_grant re-login this is
    // exactly the token the server already refused.
    const bundle = readMcpOAuthBundle('example-int')!;
    writeMcpOAuthBundle({ ...bundle, refreshToken: 'rt-dead' });

    const done = await completeLogin(
      { name: 'example-int', redirectResponse: `?code=c&state=${result.state}` },
      server({ registrations: [], tokenBody: { access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' } }),
    );

    expect(done.hasRefreshToken).toBe(false);
    expect(readMcpOAuthBundle('example-int')!.refreshToken).toBeUndefined();
    const row = await getMcpOAuthIntegration('example-int');
    expect(row!.status_detail).toMatch(/no refresh token issued/);
  });

  // Round-2 review F3: a background device poll is identified by name alone, so
  // a late result from a superseded attempt could install a token minted for the
  // old client over the newer grant.
  it('discards a device result whose attempt has been superseded by a newer login', async () => {
    const { result: first } = await login({ name: 'example-int' });
    // A second login supersedes it: new state, new client binding.
    const { result: second } = await login({ name: 'example-int', port: 9999 });
    expect(second.state).not.toBe(first.state);

    // The superseded attempt's code is refused on its state, which is the same
    // guard `finishInBackground` applies to a device poll.
    await expect(
      completeLogin(
        { name: 'example-int', redirectResponse: `?code=c&state=${first.state}` },
        server({ registrations: [] }),
      ),
    ).rejects.toThrow(/State mismatch/);

    // …and the current attempt still completes.
    const done = await completeLogin(
      { name: 'example-int', redirectResponse: `?code=c&state=${second.state}` },
      server({ registrations: [] }),
    );
    expect(done.hasRefreshToken).toBe(true);
  });

  it('refuses a redirect whose state belongs to a different login', async () => {
    await login();
    await expect(
      completeLogin(
        { name: 'example-int', redirectResponse: '?code=c&state=someone-elses' },
        server({ registrations: [] }),
      ),
    ).rejects.toThrow(/State mismatch/);
  });
});

describe('one writer per integration (round-3 F2)', () => {
  it('a remove that lands mid-refresh is not undone by the refresh finishing', async () => {
    const { result } = await login();
    await completeLogin(
      { name: 'example-int', redirectResponse: `?code=c&state=${result.state}` },
      server({ registrations: [] }),
    );
    // Due on the next tick, whatever the expiry says.
    await markMcpOAuthIntegration('example-int', { status: 'error' });

    // Hold the token endpoint open, start the refresh, then remove underneath it.
    let releaseToken: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const refreshing = refreshExpiringMcpOAuthIntegrations(async () => {
      await held;
      return json({ access_token: 'at-late', refresh_token: 'rt-late', expires_in: 3600, token_type: 'Bearer' });
    });

    // `remove` queues behind the in-flight refresh rather than interleaving with
    // it, which is the property under test: whichever order they run in, the
    // removal is the last word.
    releaseToken!();
    await refreshing;
    const removed = await removeIntegration('example-int');

    expect(removed.removedRow).toBe(true);
    expect(removed.removedBundle).toBe(true);
    expect(await getMcpOAuthIntegration('example-int')).toBeUndefined();
    expect(readMcpOAuthBundle('example-int')).toBeUndefined();
  });

  it('a refresh queued behind a remove finds nothing and writes nothing', async () => {
    const { result } = await login();
    await completeLogin(
      { name: 'example-int', redirectResponse: `?code=c&state=${result.state}` },
      server({ registrations: [] }),
    );
    await markMcpOAuthIntegration('example-int', { status: 'error' });
    await removeIntegration('example-int');

    let asked = false;
    const outcome = await refreshExpiringMcpOAuthIntegrations(async () => {
      asked = true;
      return json({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' });
    });

    expect(asked).toBe(false);
    expect(outcome.refreshed).toEqual([]);
    // Nothing recreated the bundle the removal deleted.
    expect(readMcpOAuthBundle('example-int')).toBeUndefined();
  });
});

describe('an integration belongs to one group (round-3 F3)', () => {
  it('refuses a re-login under a different group, and names the two-step move', async () => {
    await createAgentGroup({
      id: 'ag-2',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await login();

    await expect(
      startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-2' }, server({ registrations: [] })),
    ).rejects.toThrow(/belongs to agent group ag-1[\s\S]*ncl integrations remove/);

    // The original binding is untouched.
    expect((await getMcpOAuthIntegration('example-int'))!.agent_group_id).toBe('ag-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #876 P3(d) and P3(f) — two ways `login` used to leave debris behind.
// ─────────────────────────────────────────────────────────────────────────────

describe('startLogin — a duplicate (group, URL) is refused BEFORE registration (P3f)', () => {
  it('does not mint a client at the provider for a login the unique index will reject', async () => {
    const registrations: string[] = [];
    const fetchImpl = server({ registrations });

    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect(registrations).toHaveLength(1);

    // Same group, same MCP URL, different handle: UNIQUE(agent_group_id,
    // mcp_url) (migration 082:66) will refuse the row. The point of the check
    // is WHERE it happens — a client minted here would be unreachable
    // afterwards, and no provider in this flow collects them.
    await expect(
      startLogin({ name: 'example-dupe', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl),
    ).rejects.toThrow(/already has an integration for https:\/\/mcp\.example\.test\/mcp: "example-int"/);

    expect(registrations).toHaveLength(1);
    expect(await getMcpOAuthIntegration('example-dupe')).toBeUndefined();
    expect(readMcpOAuthBundle('example-dupe')).toBeUndefined();
  });

  it('still lets the SAME integration re-login against its own URL', async () => {
    const registrations: string[] = [];
    const fetchImpl = server({ registrations });
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    const again = await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect(again.registered).toBe('reused');
  });
});

describe('startLogin — the bearer secret id follows the NAME (P3d)', () => {
  it('drops a stale id when --secret points at a different secret', async () => {
    const fetchImpl = server({ registrations: [] });
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    await completeLogin({ name: 'example-int', redirectResponse: 'code=c1' }, fetchImpl);

    const connected = await getMcpOAuthIntegration('example-int');
    expect(connected!.bearer_secret_id).toBe('secret-uuid-1');

    // A re-login that adopts a DIFFERENT vault secret. Keeping the old id here
    // is what made `remove --delete-secret` delete the wrong secret: it prefers
    // `bearer_secret_id` over the name (`removeIntegrationLocked`).
    await startLogin(
      { name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1', secretName: 'Other-Secret' },
      fetchImpl,
    );
    const after = await getMcpOAuthIntegration('example-int');
    expect(after!.bearer_secret_name).toBe('Other-Secret');
    expect(after!.bearer_secret_id).toBeNull();
  });

  it('keeps the id when the secret name is unchanged', async () => {
    const fetchImpl = server({ registrations: [] });
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    await completeLogin({ name: 'example-int', redirectResponse: 'code=c1' }, fetchImpl);
    await startLogin({ name: 'example-int', mcpUrl: MCP_URL, agentGroupId: 'ag-1' }, fetchImpl);
    expect((await getMcpOAuthIntegration('example-int'))!.bearer_secret_id).toBe('secret-uuid-1');
  });
});
