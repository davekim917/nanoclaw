import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = '/tmp/nanoclaw-capabilities-test';
  return {
    TEST_ROOT: testRoot,
    GROUPS_DIR: '/tmp/nanoclaw-capabilities-test/groups',
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
}));

import { buildSessionServicesSnapshot, getHostCapabilities, renderSessionCapabilities } from './capabilities.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { writeContainerConfig } from './container-config.js';
import { SIBLING_BOUND_FIELDS } from './sibling-parity.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function insertWorkgroup(id: string, onecliSecrets: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, id, JSON.stringify(onecliSecrets), `ag-${id}`);
}

function createGroupInWorkgroup(agentGroup: AgentGroup, workgroupId: string): void {
  createAgentGroup(agentGroup);
  getDb().prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, agentGroup.id);
  writeContainerConfig(agentGroup.folder, {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
  });
}

beforeEach(() => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(dirs.GROUPS_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
});

describe('buildSessionServicesSnapshot', () => {
  it('resolves Atlassian and SELECT configuration per folder without cross-folder leakage', () => {
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
      createGroupInWorkgroup(alpha, 'tenant-alpha');
      writeContainerConfig(alpha.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        tools: ['atlassian'],
      });

      insertWorkgroup('tenant-beta', ['Select-Example']);
      const beta = group('ag-tenant-beta', 'tenant-beta');
      createGroupInWorkgroup(beta, 'tenant-beta');
      writeContainerConfig(beta.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        tools: ['atlassian'],
      });

      const alphaSnapshot = buildSessionServicesSnapshot(alpha.id);
      const alphaAtlassian = alphaSnapshot.services.find((service) => service.name.startsWith('Atlassian'));
      const alphaSelect = alphaSnapshot.services.find((service) => service.name.startsWith('SELECT'));
      expect(alphaAtlassian?.useFor).toContain('https://example.atlassian.net');
      expect(alphaSelect?.useFor).toContain('/api/example-organization/');

      const betaSnapshot = buildSessionServicesSnapshot(beta.id);
      const betaAtlassian = betaSnapshot.services.find((service) => service.name.startsWith('Atlassian'));
      const betaSelect = betaSnapshot.services.find((service) => service.name.startsWith('SELECT'));
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

  it('surfaces Cloudflare when the workgroup secret and MCP server are both wired', () => {
    insertWorkgroup('example-beverage', ['Cloudflare-ExampleBeverage']);
    const ag = group('ag-example-beverage', 'example-beverage');
    createGroupInWorkgroup(ag, 'example-beverage');
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

    const service = snapshot.services.find((s) => s.name === 'Cloudflare');
    expect(service).toBeDefined();
    expect(service?.mcpNamespace).toBe('mcp__cloudflare-api__*');
    expect(service?.scopes).toEqual(['example-beverage']);
    expect(service?.useFor).toContain('mcp.cloudflare.com/mcp');
    expect(service?.useFor).toContain('mcp__cloudflare-api__search');
    expect(service?.useFor).toContain('mcp__cloudflare-api__execute');
    expect(service?.useFor).toContain('S3-compatible access-key/secret pair is not exposed');

    const rendered = renderSessionCapabilities(snapshot);
    expect(rendered).toContain('**Cloudflare**');
    expect(rendered).toContain('MCP `mcp__cloudflare-api__*`');
  });

  it('does not surface Cloudflare unless both its secret and MCP server are wired', () => {
    insertWorkgroup('example-beverage', ['Cloudflare-ExampleBeverage']);
    const secretOnly = group('ag-secret-only', 'example-beverage-secret-only');
    createGroupInWorkgroup(secretOnly, 'example-beverage');

    const noSecretWorkgroup = 'example-beverage-no-secret';
    insertWorkgroup(noSecretWorkgroup, []);
    const mcpOnly = group('ag-mcp-only', 'example-beverage-mcp-only');
    createGroupInWorkgroup(mcpOnly, noSecretWorkgroup);
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

    expect(buildSessionServicesSnapshot(secretOnly.id).services.some((s) => s.name === 'Cloudflare')).toBe(false);
    expect(buildSessionServicesSnapshot(mcpOnly.id).services.some((s) => s.name === 'Cloudflare')).toBe(false);
  });

  it('surfaces Profound when the workgroup declares the Profound OneCLI secret', () => {
    insertWorkgroup('example-retail', ['Profound']);
    const ag = group('ag-retail', 'example-retail');
    createGroupInWorkgroup(ag, 'example-retail');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    const service = snapshot.services.find((s) => s.name === 'Profound');
    expect(service).toBeDefined();
    expect(service?.cli).toBe('curl');
    expect(service?.scopes).toEqual(['example-retail']);
    expect(service?.useFor).toContain('api.tryprofound.com');
    expect(service?.useFor).toContain('X-API-Key');
    expect(service?.useFor).not.toContain('/app/skills/profound/SKILL.md');

    const rendered = renderSessionCapabilities(snapshot);
    expect(rendered).toContain('**Profound**');
    expect(rendered).toContain('Profound REST/reporting API');
  });

  it('does not surface Profound without the Profound OneCLI secret', () => {
    insertWorkgroup('example-labs', []);
    const ag = group('ag-example-labs', 'example-labs');
    createGroupInWorkgroup(ag, 'example-labs');

    const snapshot = buildSessionServicesSnapshot(ag.id);

    expect(snapshot.services.some((s) => s.name === 'Profound')).toBe(false);
  });

  it('does not advertise universal MCPs excluded from the effective container config', () => {
    insertWorkgroup('restricted', []);
    const ag = group('ag-restricted', 'restricted');
    createGroupInWorkgroup(ag, 'restricted');
    writeContainerConfig(ag.folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
      excludeMcpServers: ['exa', 'deepwiki', 'context7', 'pocket', 'granola'],
    });

    const names = buildSessionServicesSnapshot(ag.id).services.map((service) => service.name);

    expect(names).not.toContain('Exa');
    expect(names).not.toContain('DeepWiki');
    expect(names).not.toContain('Context7');
    expect(names).not.toContain('Pocket');
    expect(names).not.toContain('Granola');
  });

  it('test_capability_and_parity_output_omit_legacy_gitnexus_field', () => {
    fs.mkdirSync(`${dirs.TEST_ROOT}/container/nanoclaw-plugin`, { recursive: true });
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/gitnexus`, { recursive: true });
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/ordinary-plugin`, { recursive: true });
    insertWorkgroup('legacy', []);
    const ag = group('ag-legacy', 'legacy');
    createGroupInWorkgroup(ag, 'legacy');
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
      const capabilityGroup = capabilities.agentGroups.find((candidate) => candidate.id === ag.id);
      expect(capabilityGroup).toBeDefined();
      expect(capabilityGroup).not.toHaveProperty('gitnexusInjectAgentsMd');
      expect(capabilities.plugins.builtin).not.toContain('nanoclaw-hooks');
      expect(capabilities.plugins.installed).not.toContain('gitnexus');
      expect(capabilities.plugins.installed).toContain('ordinary-plugin');
      expect(SIBLING_BOUND_FIELDS.has('gitnexusInjectAgentsMd')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
