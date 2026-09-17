import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const testRoot = uniqueTmpRoot('capabilities-test');
  return {
    TEST_ROOT: testRoot,
    GROUPS_DIR: `${testRoot}/groups`,
    DATA_DIR: `${testRoot}/data`,
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: dirs.GROUPS_DIR,
  // Hermetic: the plugin scope policy (src/plugin-scopes.ts) must never be read from the host.
  DATA_DIR: dirs.DATA_DIR,
}));

import { buildSessionServicesSnapshot, getHostCapabilities, renderSessionCapabilities } from './capabilities.js';
import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from './db/index.js';
import { writeContainerConfig } from './container-config.js';
import { SIBLING_BOUND_FIELDS } from './sibling-parity.js';
import { PRE_TURN_BOUNDS, boundedCapabilities, type ContextNotice } from './modules/memory/pre-turn-context.js';
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
    const slack = (await snapshot).services.find((s) => s.name === 'Slack');
    expect(slack?.useFor).toContain('LIVE in THIS session');

    const oversized = (await snapshot).services.flatMap((s) =>
      (['useFor', 'activation'] as const)
        .filter((f) => (s[f]?.length ?? 0) > PRE_TURN_BOUNDS.capabilityDetailChars)
        .map((f) => `${s.name}.${f}=${s[f]?.length}`),
    );
    expect(oversized).toEqual([]);
    expect((await snapshot).services.length).toBeLessThanOrEqual(PRE_TURN_BOUNDS.capabilityServices);
  });

  describe('Slack', () => {
    const OWNER_SAFE_MG = 'mg-owner-safe';

    async function slackGroup(opts: { secret: boolean; enabled?: boolean }): Promise<AgentGroup> {
      insertWorkgroup('example-retail', opts.secret ? ['Slack-User-Token-ExampleRetail'] : ['Anthropic']);
      const ag = group('ag-slack', 'example-retail-slack');
      await createGroupInWorkgroup(ag, 'example-retail');
      writeContainerConfig(ag.folder, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        tools: [],
        slack_user_token: {
          ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
          also_allowed_in: [OWNER_SAFE_MG],
        },
      } as Parameters<typeof writeContainerConfig>[1]);
      return ag;
    }

    async function slackEntry(agentGroupId: string, messagingGroupId?: string | null) {
      return (await buildSessionServicesSnapshot(agentGroupId, messagingGroupId)).services.find(
        (s) => s.name === 'Slack',
      );
    }

    it('owner-safe: states curl is the whole surface, how to read a permalink, and never mentions an MCP', async () => {
      const ag = await slackGroup({ secret: true, enabled: true });
      const slack = await slackEntry(ag.id, OWNER_SAFE_MG);

      expect(slack?.cli).toBe('curl');
      expect(slack?.useFor).toContain('curl https://slack.com/api/<method>');
      expect(slack?.useFor).toContain('NO auth header');
      for (const method of [
        'conversations.history',
        'conversations.replies',
        'search.messages',
        'users.info',
        'chat.postMessage',
      ]) {
        expect(slack?.useFor).toContain(method);
      }
      expect(slack?.useFor).toContain('p1789080120758779');
      expect(slack?.useFor).toContain('1789080120.758779');
      expect(slack?.useFor).not.toMatch(/mcp__slack|user-token MCP|MCP \(if loaded\)/);
      // Posting needs an optional scope; the entry must not promise it unconditionally.
      expect(slack?.useFor).toContain('chat:write');
    });

    it('owner-safe: the permalink recipe survives the runner fallback’s per-string clip', async () => {
      // The runner's fresh-context bootstrap keeps only the first
      // MAX_CAPABILITY_STRING_CHARS (600) minus its marker of every string
      // (container/agent-runner/src/memory/bootstrap.ts:8, :13, :20-24). The
      // host bound is 2,500, so the operative recipe has to be authored first.
      const ag = await slackGroup({ secret: true });
      const slack = await slackEntry(ag.id, OWNER_SAFE_MG);
      const kept = slack!.useFor!.slice(0, 600 - '[truncated:fresh-context-bootstrap]'.length);

      expect(kept).toContain('curl https://slack.com/api/<method>');
      expect(kept).toContain('NO auth header');
      expect(kept).toContain('1789080120.758779');
      expect(kept).toContain('conversations.replies?channel=C0123&ts=');
    });

    it('owner-safe: the files.slack.com fix does not rely on the naming convention alone', async () => {
      // An explicit onecli_secret_names list is authoritative
      // (src/onecli-secrets.ts:589-592), so "name it slack+user" would leave an
      // unlisted file credential injected in shared channels.
      const ag = await slackGroup({ secret: true });
      const slack = await slackEntry(ag.id, OWNER_SAFE_MG);
      expect(slack?.useFor).toContain('files.slack.com');
      expect(slack?.useFor).not.toContain('with `slack` and `user` in its name');
    });

    it('non-owner-safe: keeps the WITHHELD text and drops the MCP mention', async () => {
      const ag = await slackGroup({ secret: true, enabled: true });
      const slack = await slackEntry(ag.id, 'mg-some-shared-channel');

      expect(slack?.useFor).toMatch(/^WITHHELD IN THIS SESSION/);
      expect(slack?.useFor).toContain('slack_user_token.also_allowed_in');
      expect(slack?.useFor).not.toMatch(/MCP/);
    });

    it('group-level (no session): describes the scoping without claiming access here', async () => {
      const ag = await slackGroup({ secret: true });
      const slack = await slackEntry(ag.id);

      expect(slack?.useFor).toContain('withheld everywhere else');
      expect(slack?.useFor).not.toContain('LIVE in THIS session');
      expect(slack?.useFor).not.toMatch(/mcp__slack/);
    });

    it('is marked to survive the pre-turn capability budget in every branch', async () => {
      const ag = await slackGroup({ secret: true });
      for (const mg of [OWNER_SAFE_MG, 'mg-some-shared-channel', undefined]) {
        expect((await slackEntry(ag.id, mg))?.retainUnderBudget).toBe(true);
      }
    });

    it('retired `enabled` flag: neither grants an entry without the secret nor withholds one with it', async () => {
      const enabledNoSecret = await slackGroup({ secret: false, enabled: true });
      expect(await slackEntry(enabledNoSecret.id, OWNER_SAFE_MG)).toBeUndefined();

      await closeDb();
      fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
      fs.mkdirSync(dirs.GROUPS_DIR, { recursive: true });
      await initTestDb();
      runMigrations(getRawDb());

      const disabledWithSecret = await slackGroup({ secret: true, enabled: false });
      expect((await slackEntry(disabledWithSecret.id, OWNER_SAFE_MG))?.useFor).toContain('LIVE in THIS session');
    });
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

  it('describes every MCP server the container gets, including one only the group declares', async () => {
    insertWorkgroup('derived', []);
    const ag = group('ag-derived', 'derived');
    await createGroupInWorkgroup(ag, 'derived');
    writeContainerConfig(ag.folder, {
      mcpServers: {
        acme: { type: 'http', url: 'https://mcp.acme.test/mcp', description: 'Acme widgets.' },
        plainly: { type: 'http', url: 'https://mcp.plain.test/mcp' },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
    });

    const services = (await buildSessionServicesSnapshot(ag.id)).services;

    // Fleet default, inherited by every group with no per-group wiring at all.
    const littlebird = services.find((s) => s.name === 'Littlebird');
    expect(littlebird?.mcpNamespace).toBe('mcp__littlebird__*');
    expect(littlebird?.useFor).toContain('Littlebird workspace');

    // The group's own entry, described by its own `description`.
    const acme = services.find((s) => s.name === 'Acme');
    expect(acme?.mcpNamespace).toBe('mcp__acme__*');
    expect(acme?.useFor).toBe('Acme widgets.');

    // No description: a generic line that names the transport and claims
    // nothing about what the server does.
    const plainly = services.find((s) => s.name === 'Plainly');
    expect(plainly?.useFor).toContain('https://mcp.plain.test/mcp');
    expect(plainly?.useFor).toContain('mcp__plainly__*');
  });

  it('never advertises a retired server, or trips over a malformed one', async () => {
    insertWorkgroup('stale', []);
    const ag = group('ag-stale', 'stale');
    await createGroupInWorkgroup(ag, 'stale');
    writeContainerConfig(ag.folder, {
      mcpServers: {
        // The documented stale entry: the runner deletes it from the merged
        // map on every spawn, so a capability line for it would be a promise
        // of a tool that cannot exist.
        'slack-user-token': { type: 'http', url: 'https://slack.test/mcp' },
        broken: null as never,
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [],
    });

    const names = (await buildSessionServicesSnapshot(ag.id)).services.map((service) => service.name);

    expect(names).not.toContain('Slack-user-token');
    expect(names.some((n) => /slack-user-token/i.test(n))).toBe(false);
    expect(names).not.toContain('Broken');
    // The rest of the snapshot still builds.
    expect(names).toContain('Littlebird');
  });

  it('survives the capability budget on a widest-wired group, universals intact', async () => {
    // The regression this pins: the derived MCP entries are appended to the
    // services array, and BOTH capability budgets evict from the END
    // (`evictCapability`, src/modules/memory/pre-turn-context.ts:1590-1595).
    // Appended, the migrated universals would be first out on exactly the
    // groups that have the most wired — the widest group on this install
    // measures 19 services / 8,954 chars before this PR and 22 / 9,773 after,
    // against a 10,000-char budget. So they are spliced in where the five hardcoded blocks used to sit,
    // and marked `retainUnderBudget` because a fleet default is the fleet's
    // baseline, not a group's extra.
    insertWorkgroup('wide-shop', ['Slack-User-Token-WideShop']);
    const ag = group('ag-wide-shop', 'wide-shop');
    await createGroupInWorkgroup(ag, 'wide-shop');
    const OWNER_SAFE_MG = 'mg-owner-dm-wide';
    // The widest-wired group's real container.json shape, trimmed to what this
    // file can build: its tool list, its three mcpServers (two
    // remote-mcp-bridge stdio servers and one http), and owner-safe Slack.
    writeContainerConfig(ag.folder, {
      mcpServers: {
        dropbox: {
          type: 'stdio',
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.dropbox.com/mcp'],
          env: { REMOTE_MCP_NAME: 'dropbox', REMOTE_MCP_AUTHORIZATION: 'Bearer onecli-managed' },
        },
        amplitude: {
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', 'https://mcp.amplitude.com/mcp'],
          env: { REMOTE_MCP_NAME: 'amplitude', REMOTE_MCP_AUTHORIZATION: 'Bearer onecli-managed' },
        },
        littlebird: { type: 'http', url: 'https://mcp.littlebird.ai/mcp' },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      tools: [
        'granola',
        'pocket',
        'google-workspace:wide-shop',
        'exa',
        'snowflake:ws',
        'github',
        'looker',
        'hex',
        'atlassian',
        'dbt-mcp',
        'dbt:wide_shop_analytics',
        'datafold',
        'dropbox',
        'aws:ws-a',
        'aws:ws-b',
      ],
      slack_user_token: { enabled: true, also_allowed_in: [OWNER_SAFE_MG] },
    } as Parameters<typeof writeContainerConfig>[1]);

    const snapshot = await buildSessionServicesSnapshot(ag.id, OWNER_SAFE_MG);
    const universals = ['Pocket', 'Exa', 'Context7', 'DeepWiki', 'Granola', 'Littlebird'];

    // Structure first: the fleet universals are marked retained, a
    // group-specific server is not, and the derived block sits BEFORE the
    // tool-gated entries that follow it — the position the hardcoded blocks
    // held, so eviction order for everything else is unchanged.
    for (const name of universals) {
      expect(snapshot.services.find((service) => service.name === name)?.retainUnderBudget, name).toBe(true);
    }
    expect(snapshot.services.find((service) => service.name === 'Dropbox')?.retainUnderBudget).toBeUndefined();
    const names = snapshot.services.map((service) => service.name);
    for (const later of ['Datafold', 'Looker', 'Hex', 'Slack']) {
      if (names.includes(later)) expect(names.indexOf('Pocket')).toBeLessThan(names.indexOf(later));
    }

    // Then under real pressure. This hermetic fixture measures 19 services /
    // ~7.6k chars, under `capabilityTotalChars`; the live group it is modelled
    // on measures 22 / 9,773 — 227 chars of headroom, which one more wired
    // service spends. Padding every entry reproduces that pressure here without
    // pinning this test to one production group's text, and drives the same
    // `evictCapability` the live path uses.
    const pressured = {
      ...snapshot,
      services: snapshot.services.map((service) => ({
        ...service,
        useFor: `${service.useFor ?? ''}${'x'.repeat(600)}`,
      })),
    };
    const notices: ContextNotice[] = [];
    const bounded = boundedCapabilities(pressured, notices);
    const survived = bounded.services.map((service) => service.name);

    expect(JSON.stringify(bounded.services).length).toBeLessThanOrEqual(PRE_TURN_BOUNDS.capabilityTotalChars);
    // Something HAD to go, or this is not a budget test at all.
    expect(survived.length).toBeLessThan(snapshot.services.length);
    // ...and none of it was a fleet universal.
    for (const name of universals) {
      expect(survived, `${name} evicted by the capability budget`).toContain(name);
    }
    const droppedDetail = notices
      .filter((notice) => notice.code === 'capability-total-budget' || notice.code === 'capability-count')
      .map((notice) => notice.detail ?? '')
      .join(' ');
    for (const name of universals) expect(droppedDetail).not.toContain(name);

    // A bridge-backed stdio server names the endpoint it dials, not `bun`.
    const dropbox = snapshot.services.find((service) => service.name === 'Dropbox');
    expect(dropbox?.useFor).toContain('https://mcp.dropbox.com/mcp');
    expect(dropbox?.useFor).not.toContain('(bun)');
    expect(dropbox?.useFor?.length ?? 0).toBeLessThanOrEqual(120);
  });

  it('keeps the migrated universal text verbatim and never doubles an entry', async () => {
    insertWorkgroup('universal', []);
    const ag = group('ag-universal', 'universal');
    await createGroupInWorkgroup(ag, 'universal');

    const services = (await buildSessionServicesSnapshot(ag.id)).services;

    expect(services.filter((s) => s.name === 'Pocket')).toHaveLength(1);
    expect(services.find((s) => s.name === 'Pocket')?.useFor).toBe(
      'Personal knowledge / memory via https://public.heypocketai.com/mcp. Auth pre-injected (Authorization: Bearer). Use Pocket tools to save references, recall prior context, search personal knowledge.',
    );
    expect(services.find((s) => s.name === 'Exa')?.useFor).toContain(
      'Web search, research, and code context. Prefer exa over ad-hoc WebSearch/WebFetch',
    );
    expect(services.find((s) => s.name === 'DeepWiki')?.mcpNamespace).toBe('mcp__deepwiki__*');
    expect(services.find((s) => s.name === 'Granola')?.useFor).toContain('Meeting transcripts + notes');
    expect(services.find((s) => s.name === 'Context7')?.useFor).toContain('Live library / framework / SDK / API docs');
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

  it('names a workgroup-scoped plugin only to groups in its workgroups (src/plugin-scopes.ts)', async () => {
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/client-plugin`, { recursive: true });
    fs.mkdirSync(`${dirs.TEST_ROOT}/plugins/shared-plugin`, { recursive: true });
    fs.mkdirSync(dirs.DATA_DIR, { recursive: true });
    fs.writeFileSync(
      `${dirs.DATA_DIR}/plugin-scopes.json`,
      JSON.stringify({ version: 1, plugins: { 'client-plugin': ['client-wg'] } }),
    );
    insertWorkgroup('client-wg', []);
    insertWorkgroup('other-wg', []);
    const member = group('ag-caps-member', 'caps-member');
    const outsider = group('ag-caps-outsider', 'caps-outsider');
    await createGroupInWorkgroup(member, 'client-wg');
    await createGroupInWorkgroup(outsider, 'other-wg');

    const previousHome = process.env.HOME;
    process.env.HOME = dirs.TEST_ROOT;
    try {
      const memberInstalled = (await getHostCapabilities(member.id, undefined, 'client-wg')).plugins.installed;
      const outsiderInstalled = (await getHostCapabilities(outsider.id, undefined, 'other-wg')).plugins.installed;
      const unresolved = (await getHostCapabilities(member.id)).plugins.installed;
      const hostWide = (await getHostCapabilities()).plugins.installed;
      expect(memberInstalled).toEqual(expect.arrayContaining(['client-plugin', 'shared-plugin']));
      expect(outsiderInstalled).toContain('shared-plugin');
      expect(outsiderInstalled).not.toContain('client-plugin');
      expect(unresolved).not.toContain('client-plugin');
      expect(hostWide).toEqual(expect.arrayContaining(['client-plugin', 'shared-plugin']));
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
