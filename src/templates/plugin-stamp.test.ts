/**
 * T5 PR 3 acceptance cases — the fork-only half.
 *
 * Named cases 12, 13, 17, 18, 19, 20 and 21 of the templates/Agent-Plugins
 * scope report, plus the containment gate for risk 7 (`fs.cpSync` must have no
 * callers under `src/templates/`). Kept out of `parse.test.ts` and
 * `create-agent.test.ts` on purpose: those two are upstream-owned files whose
 * ratchet residue this PR is shrinking, and a fork-only case appended to either
 * would grow it back.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('plugin-stamp-test') }));
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: `${TEST_ROOT}/groups`,
  DATA_DIR: `${TEST_ROOT}/data`,
  TEMPLATES_DIR: `${TEST_ROOT}/templates`,
  WORKGROUP_SHARED_FS: false,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers at module scope, which importOriginal() would install in this
// worker. A complete stub instead.
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import { CONTAINER_PLUGINS_DIR, type ContainerConfig } from '../container-config.js';
import { buildMounts } from '../container-runner.js';
import { closeDb, createAgentGroup, getDb, initMigratedTestDb } from '../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../db/container-configs.js';
import { initGroupFilesystem } from '../group-init.js';
import { STANDING_INSTRUCTIONS_FILE } from '../group-persona.js';
import type { AgentGroup, Session } from '../types.js';
import { createAgentFromTemplate, markPluginServers, withPluginOwner } from './create-agent.js';
import { assertMcpServerNotPluginOwned } from '../container-config.js';
import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from './manifest.js';
import { parseTemplate } from './parse.js';

const REF = 'acme/plugin';
const PLUGIN_DIR = path.join(TEMPLATES_DIR, 'acme', 'plugin');

function write(rel: string, content: string): void {
  const full = path.join(PLUGIN_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeManifest(overrides: Record<string, unknown> = {}): void {
  write('plugin.json', JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'acme', ...overrides }));
}

function writeMcp(servers: Record<string, unknown>): void {
  write('mcp.json', JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: servers }));
}

function writeSkill(name: string): void {
  write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: does ${name} things\n---\n\nBody.\n`);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('T5 PR 3 — the plugin reader and the stamp path', () => {
  it('case 12: a plain conformant plugin with no NanoClaw extension stamps skills and MCP only', async () => {
    writeManifest();
    writeSkill('greet');
    writeMcp({ docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } });

    const { group, report } = await createAgentFromTemplate(REF);

    // Folder-derived display name: no --name option and no manifest agentName.
    expect(group.name).toBe('plugin');
    expect(group.id.startsWith('ag-')).toBe(true);
    expect(report).toEqual([]);
    // No persona, no tasks.
    const groupDir = path.join(GROUPS_DIR, group.folder);
    expect(fs.existsSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE))).toBe(false);
    expect(await getDb().all('SELECT id FROM sessions WHERE agent_group_id = ?', group.id)).toEqual([]);
    // Skills and MCP did land.
    expect(
      fs.existsSync(path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared', 'skills', 'greet', 'SKILL.md')),
    ).toBe(true);
    expect(JSON.parse((await getContainerConfig(group.id))!.mcp_servers)).toHaveProperty('docs');
  });

  it('case 12: the manifest agentName wins over the folder leaf and loses to an explicit --name', async () => {
    writeManifest({ extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'Acme Concierge' } } });

    const fromManifest = await createAgentFromTemplate(REF);
    expect(fromManifest.group.name).toBe('Acme Concierge');

    const explicit = await createAgentFromTemplate(REF, { name: 'Operator Choice' });
    expect(explicit.group.name).toBe('Operator Choice');
  });

  it('case 13: a pre-plugin template folder produces the migration error, not a fallback parse', async () => {
    // Exactly the old layout: context/instructions.md and a .mcp.json, no manifest.
    write('context/instructions.md', 'You are an SDR agent.\n');
    write('.mcp.json', JSON.stringify({ mcpServers: { hubspot: { command: 'npx' } } }));

    expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/predates the plugin format.*re-fetch/s);
    await expect(createAgentFromTemplate(REF)).rejects.toThrow(/predates the plugin format/);
    // Nothing was stamped on the way to the error.
    expect(await getDb().all('SELECT id FROM agent_groups')).toEqual([]);
  });

  it('case 17: the whole plugin lands under plugins/<name> and plugin-data/<name> incl. declared subpaths', async () => {
    writeManifest();
    write('server/run.js', 'console.log("hi");\n');
    write('README.md', '# Acme\n');
    writeMcp({
      cache: { type: 'stdio', command: './server/run.js', cwd: '${PLUGIN_DATA}/cache/v1' },
      bare: { type: 'stdio', command: 'server', cwd: '${PLUGIN_DATA}' },
    });

    const { group } = await createAgentFromTemplate(REF);
    const groupDir = path.join(GROUPS_DIR, group.folder);

    // Whole plugin, verbatim, under the manifest name (not the ref leaf).
    expect(fs.readFileSync(path.join(groupDir, 'plugins', 'acme', 'server', 'run.js'), 'utf-8')).toBe(
      'console.log("hi");\n',
    );
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'acme', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'acme', 'README.md'))).toBe(true);
    // Writable sibling, plus every declared ${PLUGIN_DATA} subpath — a server
    // whose cwd does not exist fails its `cd` and never boots.
    expect(fs.statSync(path.join(groupDir, 'plugin-data', 'acme')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(groupDir, 'plugin-data', 'acme', 'cache', 'v1')).isDirectory()).toBe(true);
  });

  it('case 18: a stdio server that omits cwd is stamped with ${PLUGIN_ROOT}, and a declared cwd is kept', async () => {
    writeManifest();
    writeMcp({
      omits: { type: 'stdio', command: 'server' },
      declares: { type: 'stdio', command: 'server', cwd: './work' },
      remote: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    });

    const { group } = await createAgentFromTemplate(REF);
    const file = JSON.parse(
      fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'container.json'), 'utf8'),
    ) as ContainerConfig;
    const servers = file.mcpServers!;

    expect(servers.omits).toMatchObject({ cwd: '${PLUGIN_ROOT}', pluginRoot: `${CONTAINER_PLUGINS_DIR}/acme` });
    expect(servers.declares).toMatchObject({ cwd: './work', pluginRoot: `${CONTAINER_PLUGINS_DIR}/acme` });
    // http servers get no cwd and no pluginRoot — there is nothing to launch.
    expect(servers.remote).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'acme' });
    // The ownership marker rides BOTH stores — every mutation guard reads the
    // file (Codex on #500); the runner strips it before any provider sees it.
    expect(servers.omits).toMatchObject({ plugin: 'acme' });
    expect(servers.declares).toMatchObject({ plugin: 'acme' });
    const row = JSON.parse((await getContainerConfig(group.id))!.mcp_servers) as Record<string, { plugin?: string }>;
    expect(row.omits.plugin).toBe('acme');
    expect(row.remote.plugin).toBe('acme');
  });

  it('case 19: a smuggled credential in mcp.json env rejects the whole plugin', async () => {
    writeManifest();
    writeSkill('greet');
    writeMcp({ crm: { type: 'stdio', command: 'server', env: { API_KEY: 'sk-live-1234567890' } } });

    await expect(createAgentFromTemplate(REF)).rejects.toThrow(/looks like a real credential/);
    expect(await getDb().all('SELECT id FROM agent_groups')).toEqual([]);
  });

  it('case 19: a "Bearer sk-…" header rejects the whole plugin even though the header rule would only skip it', async () => {
    writeManifest();
    writeMcp({
      api: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer sk-proj-AbC123RealLookingKey456' },
      },
    });

    // The fork's header allowlist would refuse this value as a per-server skip;
    // the stamp-time lint runs first precisely so a real credential is fatal.
    expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/looks like a real credential/);
  });

  it('case 19: the literal "placeholder" is accepted in an env value', () => {
    writeManifest();
    writeMcp({ crm: { type: 'stdio', command: 'server', env: { PRIVATE_APP_ACCESS_TOKEN: 'placeholder' } } });

    const tpl = parseTemplate(PLUGIN_DIR);

    expect(tpl.mcpServers.crm).toMatchObject({ env: { PRIVATE_APP_ACCESS_TOKEN: 'placeholder' } });
    expect(tpl.report).toEqual([]);
  });

  it('case 20: the fork URL rules still bite — path-segment credential, credential query key, loopback placeholder', () => {
    writeManifest();
    writeMcp({
      pathSecret: { type: 'streamable-http', url: 'https://mcp.example.com/s/ghp_abcdefghijklmnop/mcp' },
      queryKey: { type: 'streamable-http', url: 'https://mcp.example.com/mcp?apikey=abc123' },
      loopbackPlaceholder: {
        type: 'streamable-http',
        url: 'http://127.0.0.1:9000/mcp',
        headers: { Authorization: 'onecli-managed' },
      },
      good: { type: 'stdio', command: 'server' },
    });

    const tpl = parseTemplate(PLUGIN_DIR);

    expect(Object.keys(tpl.mcpServers)).toEqual(['good']);
    const report = tpl.report.join('\n');
    expect(report).toMatch(/server "pathSecret" skipped:.*url path carries a raw credential/);
    expect(report).toMatch(/server "queryKey" skipped:.*query parameter "apikey" looks like a credential/);
    expect(report).toMatch(/server "loopbackPlaceholder" skipped:.*placeholder headers are not allowed for local/);
  });

  it('case 20: the Agent Plugins literal "placeholder" is refused as a credential header value', () => {
    writeManifest();
    writeMcp({
      api: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'placeholder' } },
    });

    const tpl = parseTemplate(PLUGIN_DIR);

    // The OneCLI gateway substitutes "onecli-managed", not "placeholder" — a
    // server stamped with the latter would 401 on first use.
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.report.join('\n')).toMatch(/server "api" skipped:.*must be exactly "onecli-managed"/);
  });

  it('case 21: the plugins mount is read-only and exists for a group that carries no plugin', async () => {
    const group: AgentGroup = {
      id: 'ag-no-plugin',
      name: 'No Plugin',
      folder: 'no-plugin',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(group);
    // buildMounts fail-closes on a NULL workgroup_id; give the group a
    // workgroup-of-1 the way reconcileWorkgroupAtSpawn would have.
    await getDb().run(
      `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
       VALUES (?, ?, '[]', ?, ?)`,
      group.folder,
      group.folder,
      group.id,
      new Date().toISOString(),
    );
    await getDb().run('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?', group.folder, group.id);
    await ensureContainerConfig(group.id);

    initGroupFilesystem(group);
    // Unconditional mkdir: without it Docker creates the nested mount's
    // destination root-owned inside the group folder.
    expect(fs.statSync(path.join(GROUPS_DIR, group.folder, 'plugins')).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(GROUPS_DIR, group.folder, 'plugins'))).toEqual([]);

    const session = { id: 's-no-plugin', agent_group_id: group.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(group, session, config, 'claude', {}, group.folder);

    const mount = mounts.find((m) => m.containerPath === CONTAINER_PLUGINS_DIR);
    expect(mount).toBeDefined();
    expect(mount!.readonly).toBe(true);
    expect(mount!.hostPath).toBe(path.join(GROUPS_DIR, group.folder, 'plugins'));
  });

  it('a stamped server is refused by every mutation guard (marker → guard contract, #500)', () => {
    // The three guard sites all read container.json, so this is the entry the
    // guard actually sees after a stamp.
    const stamped = withPluginOwner(
      markPluginServers({ hubspot: { command: 'npx', args: [], env: {} } }, 'sdr'),
      'sdr',
    ).hubspot;
    expect(() => assertMcpServerNotPluginOwned(stamped, 'hubspot', 'sdr-group')).toThrow(/managed by plugin "sdr"/);
    // An operator-added server carries no marker and stays editable.
    expect(() =>
      assertMcpServerNotPluginOwned({ command: 'npx', args: [], env: {} }, 'mine', 'sdr-group'),
    ).not.toThrow();
  });

  it('a smuggled credential is fatal even when the server is otherwise skippable (#500 round 2)', () => {
    // A skipped server is still copied verbatim into the agent-readable
    // plugins/ tree, so the credential decides the outcome — not the other
    // defect that used to return before the lint ran.
    const secret = { API_KEY: 'sk-live-AbC123RealLookingKey456' };
    for (const servers of [
      { 'bad name!': { type: 'stdio', command: 'server', env: secret } },
      { ok: { type: 'stdio', command: 'server', nope: 1, env: secret } },
      { ok: { type: 'ftp', command: 'server', env: secret } },
    ]) {
      writeManifest();
      writeMcp(servers as Parameters<typeof writeMcp>[0]);
      expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/looks like a real credential/);
    }
  });

  it('a smuggled credential is fatal even when the whole MCP component is skippable (#500 round 3)', () => {
    // The component-level skips ($schema, unknown top-level key) return before
    // any entry is read, but the plugin directory still ships to the agent.
    const secret = { API_KEY: 'sk-live-AbC123RealLookingKey456' };
    const entry = { crm: { type: 'stdio', command: 'server', env: secret } };
    for (const doc of [
      { $schema: 'https://example.com/wrong', mcpServers: entry },
      { $schema: MCP_SCHEMA_URL, mcpServers: entry, extra: true },
    ]) {
      writeManifest();
      fs.writeFileSync(path.join(PLUGIN_DIR, 'mcp.json'), JSON.stringify(doc));
      expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/looks like a real credential/);
    }
  });

  it('an mcp.json that cannot be linted at all refuses the plugin (#500 round 4)', () => {
    // Closing the class rather than the leaf: the whole plugin directory ships
    // to the agent, so a file that cannot be PROVEN credential-free must not
    // be stamped. A trailing comma beside a real key used to degrade to a
    // component skip and carry the credential through.
    writeManifest();
    fs.writeFileSync(
      path.join(PLUGIN_DIR, 'mcp.json'),
      '{"mcpServers":{"crm":{"type":"stdio","command":"server","env":{"API_KEY":"sk-live-AbC123RealLookingKey456"},}}}',
    );
    expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/not valid JSON/);

    writeManifest();
    fs.writeFileSync(path.join(PLUGIN_DIR, 'mcp.json'), '["not","an","object"]');
    expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/not a JSON object/);
  });

  it('a value the lint cannot read refuses the plugin (#500 round 5)', () => {
    // Same invariant, one level down: stringValues drops non-strings, so a
    // nested object would pass the lint, fail the shape check later, and still
    // ship inside the copied plugin directory.
    for (const entry of [
      { crm: { type: 'stdio', command: 'server', env: { API_KEY: { value: 'sk-live-AbC123RealLooking' } } } },
      {
        crm: { type: 'streamable-http', url: 'https://x.example.com/mcp', headers: { Authorization: ['Bearer', 'x'] } },
      },
      { crm: { type: 'stdio', command: 'server', env: 'not-an-object' } },
    ]) {
      writeManifest();
      fs.writeFileSync(
        path.join(PLUGIN_DIR, 'mcp.json'),
        JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: entry }),
      );
      expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/cannot be checked for credentials/);
    }
  });

  it('scans every string in an entry, not an enumerated field list (#500 round 6)', () => {
    // Enumerating one more field per review round is how this class recurs.
    // args, a nested object, and an arbitrary auth scheme all reach the copied
    // mcp.json and container.json, so all of them are scanned.
    for (const entry of [
      { crm: { type: 'stdio', command: 'server', args: ['--token', 'sk-live-AbC123RealLooking'] } },
      {
        crm: {
          type: 'streamable-http',
          url: 'https://x.example.com/mcp',
          headers: { Authorization: 'Key sk-live-AbC123RealLooking' },
        },
      },
      {
        crm: {
          type: 'streamable-http',
          url: 'https://x.example.com/mcp',
          headers: { Authorization: 'Bearer sk-live-AbC123RealLooking' },
        },
      },
    ]) {
      writeManifest();
      fs.writeFileSync(
        path.join(PLUGIN_DIR, 'mcp.json'),
        JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: entry }),
      );
      expect(() => parseTemplate(PLUGIN_DIR)).toThrow(/looks like a real credential/);
    }
  });

  it('the documented mcp.json examples parse and stamp (#500 round 4)', () => {
    // The authoring examples are executable here, so a doc that drifts from
    // the reader's requirements fails the suite instead of a user's stamp.
    writeManifest();
    fs.writeFileSync(
      path.join(PLUGIN_DIR, 'mcp.json'),
      JSON.stringify({
        $schema: MCP_SCHEMA_URL,
        mcpServers: {
          hubspot: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server'] },
          datafold: {
            type: 'streamable-http',
            url: 'https://app.datafold.com/mcp/',
            headers: { Authorization: 'Key onecli-managed' },
          },
          acme: { type: 'stdio', command: 'npx', args: [], env: { ACME_API_KEY: 'placeholder' } },
        },
      }),
    );
    const tpl = parseTemplate(PLUGIN_DIR);
    expect(Object.keys(tpl.mcpServers).sort()).toEqual(['acme', 'datafold', 'hubspot']);
    expect(tpl.report.filter((line) => line.includes('mcp.json'))).toEqual([]);
  });
});

/**
 * Risk 7 — plugin content is DATA on the host. `plugin-dir.ts` is the
 * containment boundary (it refuses symlinks, special files, path escapes, and
 * caps size/depth/count); `fs.cpSync` follows symlinks and enforces none of
 * that. Any future stamp path that reaches for `cpSync` on plugin content
 * reopens that hole silently, so the module tree is pinned instead.
 */
describe('the templates module never copies plugin content with fs.cpSync', () => {
  /** Comments name the identifier on purpose (plugin-dir.ts says so twice). */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);

  const CALL_SITE_RE = /\bcpSync\b/;

  const callers = (): string[] => {
    const dir = path.resolve(__dirname);
    return (
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        // This file names the identifier in its own matcher and its fixture.
        .filter((f) => f !== path.basename(__filename))
        .filter((f) => CALL_SITE_RE.test(stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))))
    );
  };

  it('cpSync has no callers under src/templates/', () => {
    expect(
      callers(),
      'plugin content must leave a plugin only through copyPluginDir (src/templates/plugin-dir.ts); ' +
        'fs.cpSync follows symlinks and enforces none of the containment caps',
    ).toEqual([]);
  });

  it('bites when a caller is planted', () => {
    // Proves the scan is not vacuous: the same predicate, over a source that
    // really calls it outside a comment, reports the call.
    const planted = 'import fs from "fs";\n// fs.cpSync in a comment is fine\nfs.cpSync(src, dest);\n';
    expect(CALL_SITE_RE.test(stripComments(planted))).toBe(true);
    const commentOnly = '/** never through raw fs.cpSync */\nexport const x = 1;\n';
    expect(CALL_SITE_RE.test(stripComments(commentOnly))).toBe(false);
  });
});
