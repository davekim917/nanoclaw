import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = uniqueTmpRoot('capabilities-test');
  return {
    TEST_ROOT: testRoot,
    GROUPS_DIR: `${testRoot}/groups`,
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
}));

import { buildSessionServicesSnapshot, getHostCapabilities, renderSessionCapabilities } from './capabilities.js';
import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from './db/index.js';
import { writeContainerConfig } from './container-config.js';
import { SIBLING_BOUND_FIELDS } from './sibling-parity.js';
import { PRE_TURN_BOUNDS } from './modules/memory/pre-turn-context.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function insertWorkgroup(id: string, onecliSecrets: string[]): void {
  getRawDb()
    .prepare(
      `INSERT INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, id, JSON.stringify(onecliSecrets), `ag-${id}`);
}

async function createGroupInWorkgroup(agentGroup: AgentGroup, workgroupId: string): Promise<void> {
  await createAgentGroup(agentGroup);
  getRawDb().prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, agentGroup.id);
  writeContainerConfig(agentGroup.folder, {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
  });
}

beforeEach(async () => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(dirs.GROUPS_DIR, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
  // vitest.config.ts sets no `unstubEnvs`, so it defaults to false and
  // vi.stubEnv survives the test — leaking into later tests in this file and,
  // since process.env is per worker process, into later files in the same
  // worker. The GitHub capability gate keys off GITHUB_TOKEN, so a leaked stub
  // silently flips other tests into a token-present configuration.
  vi.unstubAllEnvs();
});

describe('buildSessionServicesSnapshot', () => {
  it('resolves Atlassian and SELECT configuration per folder without cross-folder leakage', async () => {
    const envNames = [
      'ATLASSIAN_BASE_URL',
      'ATLASSIAN_BASE_URL_TENANT_ALPHA',
      'ATLASSIAN_BASE_URL_TENANT_BETA',
      'SELECT_ORGANIZATION_ID',
      'SELECT_ORGANIZATION_ID_TENANT_ALPHA',
      'SELECT_ORGANIZATION_ID_TENANT_BETA',
    ];
    const original = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) delete process.env[name];
    process.env.ATLASSIAN_BASE_URL_TENANT_ALPHA = 'https://example.atlassian.net';
    process.env.SELECT_ORGANIZATION_ID_TENANT_ALPHA = 'example-organization';

    try {
      insertWorkgroup('tenant-alpha', ['Select-Example']);
      const alpha = group('ag-tenant-alpha', 'tenant-alpha');
      await createGroupInWorkgroup(alpha, 'tenant-alpha');
      writeContainerConfig(alpha.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        tools: ['atlassian'],
      });

      insertWorkgroup('tenant-beta', ['Select-Example']);
      const beta = group('ag-tenant-beta', 'tenant-beta');
      await createGroupInWorkgroup(beta, 'tenant-beta');
      writeContainerConfig(beta.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        tools: ['atlassian'],
      });

      const alphaSnapshot = buildSessionServicesSnapshot(alpha.id);
      const alphaAtlassian = (await alphaSnapshot).services.find((service) => service.name.startsWith('Atlassian'));
      const alphaSelect = (await alphaSnapshot).services.find((service) => service.name.startsWith('SELECT'));
      expect(alphaAtlassian?.useFor).toContain('https://example.atlassian.net');
      expect(alphaSelect?.useFor).toContain('/api/example-organization/');

      const betaSnapshot = buildSessionServicesSnapshot(beta.id);
      const betaAtlassian = (await betaSnapshot).services.find((service) => service.name.startsWith('Atlassian'));
      const betaSelect = (await betaSnapshot).services.find((service) => service.name.startsWith('SELECT'));
      expect(betaAtlassian?.useFor).toContain('ATLASSIAN_BASE_URL is not configured');
      expect(betaAtlassian?.useFor).not.toContain('https://example.atlassian.net');
      expect(betaSelect?.useFor).toContain('/api/<organization_id>/');
      expect(betaSelect?.useFor).toContain('SELECT_ORGANIZATION_ID is not configured');
      expect(betaSelect?.useFor).not.toContain('example-organization');
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('surfaces Cloudflare when the workgroup secret and MCP server are both wired', async () => {
    insertWorkgroup('example-beverage', ['Cloudflare-ExampleBeverage']);
    const ag = group('ag-example-beverage', 'example-beverage');
    await createGroupInWorkgroup(ag, 'example-beverage');
    writeContainerConfig(ag.folder, {
      mcpServers: {
        'cloudflare-api': {
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.cloudflare.com/mcp'],
          env: {
            REMOTE_MCP_NAME: 'cloudflare-api',
            REMOTE_MCP_AUTHORIZATION: 'Bearer placeholder',
          },
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
    });

    const snapshot = buildSessionServicesSnapshot(ag.id);

    const service = (await snapshot).services.find((s) => s.name === 'Cloudflare');
    expect(service).toBeDefined();
    expect(service?.mcpNamespace).toBe('mcp__cloudflare-api__*');
    expect(service?.scopes).toEqual(['example-beverage']);
    expect(service?.useFor).toContain('mcp.cloudflare.com/mcp');
    expect(service?.useFor).toContain('mcp__cloudflare-api__search');
    expect(service?.useFor).toContain('mcp__cloudflare-api__execute');
    expect(service?.useFor).toContain('S3-compatible access-key/secret pair is not exposed');

    const rendered = renderSessionCapabilities(await snapshot);
    expect(rendered).toContain('**Cloudflare**');
    expect(rendered).toContain('MCP `mcp__cloudflare-api__*`');
  });

  it('keeps every authored capability detail inside the pre-turn truncation bound', async () => {
    // boundedCapabilities clips `useFor`/`activation` at
    // PRE_TURN_BOUNDS.capabilityDetailChars, and it clips from the END. These
    // strings exist to stop the agent denying an ability it has, and the
    // operative sentence — "never tell the owner you can't X without first
    // trying Y" — is written last, so silent truncation removes exactly the
    // part that does the work. Fail here instead: tighten the prose or raise
    // the bound deliberately.
    //
    // Exercised through an OWNER-SAFE session, not a bare group-level snapshot.
    // Without a messaging group `sessionKnown` is false, which routes Slack to
    // a short "withheld in this snapshot" string and skips the long
    // file-attachment prose entirely — the branch most at risk would never be
    // measured, and the guard would pass while the real string overflowed.
    insertWorkgroup('example-retail', [
      'Slack-User-Token-ExampleRetail',
      'Cloudflare-ExampleRetail',
      'Wix-ExampleRetail',
    ]);
    const ag = group('ag-wide', 'example-retail-wide');
    await createGroupInWorkgroup(ag, 'example-retail');
    const OWNER_SAFE_MG = 'mg-owner-dm';
    writeContainerConfig(ag.folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
      slack_user_token: { enabled: true, also_allowed_in: [OWNER_SAFE_MG] },
    } as Parameters<typeof writeContainerConfig>[1]);
    vi.stubEnv('GITHUB_TOKEN', 'dummy');

    const snapshot = buildSessionServicesSnapshot(ag.id, OWNER_SAFE_MG);
    expect((await snapshot).services.length).toBeGreaterThan(0);

    // Guard the guard: prove we actually took the owner-safe branch, so this
    // test can never silently regress into measuring the short string again.
    const slack = (await snapshot).services.find((s) => s.name === 'Slack (read)');
    expect(slack?.useFor).toContain('FILE ATTACHMENTS');

    const oversized = (await snapshot).services.flatMap((s) =>
      (['useFor', 'activation'] as const)
        .filter((f) => (s[f]?.length ?? 0) > PRE_TURN_BOUNDS.capabilityDetailChars)
        .map((f) => `${s.name}.${f}=${s[f]?.length}`),
    );
    expect(oversized).toEqual([]);
    expect((await snapshot).services.length).toBeLessThanOrEqual(PRE_TURN_BOUNDS.capabilityServices);
  });

  it('does not surface Cloudflare unless both its secret and MCP server are wired', async () => {
    insertWorkgroup('example-beverage', ['Cloudflare-ExampleBeverage']);
    const secretOnly = group('ag-secret-only', 'example-beverage-secret-only');
    await createGroupInWorkgroup(secretOnly, 'example-beverage');

    const noSecretWorkgroup = 'example-beverage-no-secret';
    insertWorkgroup(noSecretWorkgroup, []);
    const mcpOnly = group('ag-mcp-only', 'example-beverage-mcp-only');
    await createGroupInWorkgroup(mcpOnly, noSecretWorkgroup);
    writeContainerConfig(mcpOnly.folder, {
      mcpServers: {
        'cloudflare-api': {
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.cloudflare.com/mcp'],
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
    });

    expect((await buildSessionServicesSnapshot(secretOnly.id)).services.some((s) => s.name === 'Cloudflare')).toBe(
      false,
    );
    expect((await buildSessionServicesSnapshot(mcpOnly.id)).services.some((s) => s.name === 'Cloudflare')).toBe(false);
  });

  it('surfaces Profound when the workgroup declares the Profound OneCLI secret', async () => {
    insertWorkgroup('example-retail', ['Profound']);
    const ag = group('ag-retail', 'example-retail');
    await createGroupInWorkgroup(ag, 'example-retail');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    const service = (await snapshot).services.find((s) => s.name === 'Profound');
    expect(service).toBeDefined();
    expect(service?.cli).toBe('curl');
    expect(service?.scopes).toEqual(['example-retail']);
    expect(service?.useFor).toContain('api.tryprofound.com');
    expect(service?.useFor).toContain('X-API-Key');
    expect(service?.useFor).not.toContain('/app/skills/profound/SKILL.md');

    const rendered = renderSessionCapabilities(await snapshot);
    expect(rendered).toContain('**Profound**');
    expect(rendered).toContain('Profound REST/reporting API');
  });

  it('does not surface Profound without the Profound OneCLI secret', async () => {
    insertWorkgroup('example-labs', []);
    const ag = group('ag-example-labs', 'example-labs');
    await createGroupInWorkgroup(ag, 'example-labs');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    expect((await snapshot).services.some((s) => s.name === 'Profound')).toBe(false);
  });

  it('does not advertise universal MCPs excluded from the effective container config', async () => {
    insertWorkgroup('restricted', []);
    const ag = group('ag-restricted', 'restricted');
    await createGroupInWorkgroup(ag, 'restricted');
    writeContainerConfig(ag.folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
      excludeMcpServers: ['exa', 'deepwiki', 'context7', 'pocket', 'granola'],
    });

    const names = (await buildSessionServicesSnapshot(ag.id)).services.map((service) => service.name);

    expect(names).not.toContain('Exa');
    expect(names).not.toContain('DeepWiki');
    expect(names).not.toContain('Context7');
    expect(names).not.toContain('Pocket');
    expect(names).not.toContain('Granola');
  });

  it('test_capability_and_parity_output_omit_legacy_gitnexus_field', async () => {
    fs.mkdirSync(`${dirs.TEST_ROOT}/container/nanoclaw-plugin`, { recursive: true });
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/gitnexus`, { recursive: true });
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/ordinary-plugin`, { recursive: true });
    insertWorkgroup('legacy', []);
    const ag = group('ag-legacy', 'legacy');
    await createGroupInWorkgroup(ag, 'legacy');
    writeContainerConfig(ag.folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
      gitnexusInjectAgentsMd: true,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = dirs.TEST_ROOT;
    try {
      const capabilities = getHostCapabilities();
      const capabilityGroup = (await capabilities).agentGroups.find((candidate) => candidate.id === ag.id);
      expect(capabilityGroup).toBeDefined();
      expect(capabilityGroup).not.toHaveProperty('gitnexusInjectAgentsMd');
      expect((await capabilities).plugins.builtin).not.toContain('nanoclaw-hooks');
      expect((await capabilities).plugins.installed).not.toContain('gitnexus');
      expect((await capabilities).plugins.installed).toContain('ordinary-plugin');
      expect(SIBLING_BOUND_FIELDS.has('gitnexusInjectAgentsMd')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe('GitHub App sentinel scoping', () => {
  // Fills the host-level App token cache WITHOUT network: write a throwaway
  // RSA key, stub fetch to a mint response, mint once via the module under
  // the same key the capabilities builder reads.
  async function warmAppCache(env: NodeJS.ProcessEnv): Promise<void> {
    const { clearGitHubAppTokenCache, resolveGitHubAppToken } = await import('./github-app-token.js');
    clearGitHubAppTokenCache();
    // Real RSA key so the RS256 signing path runs and the mint succeeds —
    // without it resolveGitHubAppToken fail-closes and the cache stays cold.
    const keyDir = uniqueTmpRoot('cap-gh');
    fs.mkdirSync(keyDir, { recursive: true });
    const keyPath = `${keyDir}/key.pem`;
    const crypto = await import('crypto');
    fs.writeFileSync(
      keyPath,
      crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    );
    env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await resolveGitHubAppToken(env);
  }

  it('a PAT group never receives App-cache expiry or App-shape guidance', async () => {
    insertWorkgroup('example-pat', []);
    const ag = group('ag-pat-group', 'example-pat');
    await createGroupInWorkgroup(ag, 'example-pat');
    // Host happens to hold App config + warm cache from ANOTHER group's use.
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_INSTALLATION_ID = '42';
    await warmAppCache(process.env);

    vi.stubEnv('GITHUB_TOKEN', 'ghp_static_pat');
    const snapshot = buildSessionServicesSnapshot(ag.id);
    const gh = (await snapshot).services.find((s) => s.name === 'GitHub');
    expect(gh).toBeDefined();
    expect(gh?.expiresAt).toBeUndefined();
    expect(gh?.activation ?? '').not.toContain('HEALTHY App installation token');
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
  });

  it('a sentinel group gets expiresAt matching the cache plus the App-shape guidance', async () => {
    insertWorkgroup('example-app', []);
    const ag = group('ag-app-group', 'example-app');
    await createGroupInWorkgroup(ag, 'example-app');
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_INSTALLATION_ID = '42';
    await warmAppCache(process.env);

    vi.stubEnv('GITHUB_TOKEN', 'app:github');
    const snapshot = buildSessionServicesSnapshot(ag.id);
    const gh = (await snapshot).services.find((s) => s.name === 'GitHub');
    expect(gh?.expiresAt).toBeDefined();
    expect(Number.isFinite(Date.parse(gh!.expiresAt!))).toBe(true);
    expect(gh?.activation ?? '').toContain('HEALTHY App installation token');
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
  });
});
