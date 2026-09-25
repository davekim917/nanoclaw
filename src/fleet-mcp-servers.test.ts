import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const root = uniqueTmpRoot('fleet-mcp-servers');
  return { TEST_ROOT: root, DATA_DIR: `${root}/data` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: dirs.DATA_DIR,
}));

import {
  DEFAULT_FLEET_MCP_SERVERS,
  RETIRED_MCP_SERVER_NAMES,
  FLEET_MCP_SERVERS_PATH,
  effectiveMcpServers,
  readFleetMcpServers,
  updateFleetMcpServers,
} from './fleet-mcp-servers.js';

beforeEach(() => {
  fs.mkdirSync(dirs.DATA_DIR, { recursive: true });
  fs.rmSync(FLEET_MCP_SERVERS_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(dirs.TEST_ROOT, { recursive: true, force: true });
});

describe('the shipped fleet defaults', () => {
  it('describe every entry and reach only HTTPS remotes', () => {
    for (const [name, server] of Object.entries(DEFAULT_FLEET_MCP_SERVERS)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      // Without a description the agent gets the generic transport line, which
      // for a shipped default is a regression in what the fleet is told it has.
      expect(server.description, `${name} description`).toBeTruthy();
      expect(server.displayName, `${name} displayName`).toBeTruthy();
      if (server.type === 'http' || server.type === 'sse') {
        expect(new URL(server.url).protocol, `${name} url`).toBe('https:');
      } else {
        expect(server.command, `${name} command`).toBeTruthy();
      }
    }
  });

  it('carry Littlebird as a fleet-wide remote', () => {
    expect(DEFAULT_FLEET_MCP_SERVERS.littlebird).toMatchObject({
      type: 'http',
      url: 'https://mcp.littlebird.ai/mcp',
      displayName: 'Littlebird',
    });
  });

  it('apply when no file has been written yet', () => {
    expect(fs.existsSync(FLEET_MCP_SERVERS_PATH)).toBe(false);
    expect(readFleetMcpServers()).toEqual(DEFAULT_FLEET_MCP_SERVERS);
  });
});

describe('the fleet file', () => {
  it('replaces the defaults once written, and survives a round trip', () => {
    updateFleetMcpServers((servers) => {
      delete servers.pocket;
      servers.acme = { type: 'http', url: 'https://mcp.acme.test/mcp', description: 'Acme things.' };
    });

    const read = readFleetMcpServers();
    expect(read.pocket).toBeUndefined();
    expect(read.acme).toMatchObject({ type: 'http', url: 'https://mcp.acme.test/mcp' });
    expect(read.exa).toBeDefined();
    expect(JSON.parse(fs.readFileSync(FLEET_MCP_SERVERS_PATH, 'utf-8')).version).toBe(1);
  });

  it('refuses a malformed file rather than silently dropping every group’s tools', () => {
    fs.writeFileSync(FLEET_MCP_SERVERS_PATH, '{"version":2,"mcpServers":{}}');
    expect(() => readFleetMcpServers()).toThrow(/version must be 1/);

    fs.writeFileSync(FLEET_MCP_SERVERS_PATH, 'not json');
    expect(() => readFleetMcpServers()).toThrow(/JSON parse failed/);

    fs.writeFileSync(FLEET_MCP_SERVERS_PATH, '{"version":1,"mcpServers":[]}');
    expect(() => readFleetMcpServers()).toThrow(/mcpServers must be an object/);
  });

  it('refuses the deprecated SSE transport, like the per-group file does', () => {
    fs.writeFileSync(
      FLEET_MCP_SERVERS_PATH,
      JSON.stringify({ version: 1, mcpServers: { legacy: { type: 'sse', url: 'https://x.test/sse' } } }),
    );
    expect(() => readFleetMcpServers()).toThrow(/SSE/);
  });
});

describe('entry validation', () => {
  const write = (servers: Record<string, unknown>): void =>
    fs.writeFileSync(FLEET_MCP_SERVERS_PATH, JSON.stringify({ version: 1, mcpServers: servers }));

  it('refuses a null entry rather than crashing the capability snapshot', () => {
    write({ oops: null });
    expect(() => readFleetMcpServers()).toThrow(/must be an object/);
  });

  it('refuses an entry with neither url nor command, and one with both', () => {
    write({ half: { type: 'http' } });
    expect(() => readFleetMcpServers()).toThrow(/exactly one of url/);

    write({ both: { url: 'https://x.test/mcp', command: 'bun' } });
    expect(() => readFleetMcpServers()).toThrow(/exactly one of url/);
  });

  it('refuses a cleartext or malformed url', () => {
    write({ plain: { type: 'http', url: 'http://mcp.example.test/mcp' } });
    expect(() => readFleetMcpServers()).toThrow(/must use HTTPS/);

    write({ broken: { type: 'http', url: 'not-a-url' } });
    expect(() => readFleetMcpServers()).toThrow(/not a valid URL/);

    // Loopback over plain HTTP is allowed, exactly as the per-group intake
    // allows it — the gateway never sees that request.
    write({ local: { type: 'http', url: 'http://127.0.0.1:8080/mcp' } });
    expect(readFleetMcpServers().local).toBeDefined();
  });

  it('refuses a reserved or malformed server name', () => {
    write({ nanoclaw: { type: 'http', url: 'https://x.test/mcp' } });
    expect(() => readFleetMcpServers()).toThrow(/reserved/);

    write({ 'bad name': { type: 'http', url: 'https://x.test/mcp' } });
    expect(() => readFleetMcpServers()).toThrow(/letters, digits/);
  });

  it('refuses every wrong field shape, not just the transport', () => {
    // A string `args` clears `args.length > 0` and then throws on `.map` while
    // Codex writes its TOML
    // (container/agent-runner/src/providers/codex-app-server.ts:806-807) — in
    // every group, since a fleet entry is inherited fleet-wide.
    write({ srv: { command: 'bun', args: '--serve' } });
    expect(() => readFleetMcpServers()).toThrow(/args must be an array of strings/);

    write({ srv: { command: 'bun', env: { OK: 1 } } });
    expect(() => readFleetMcpServers()).toThrow(/env must be an object with string values/);

    write({ srv: { command: 'bun', env: { 'not an env name': 'x' } } });
    expect(() => readFleetMcpServers()).toThrow(/is not a valid env name/);

    write({ srv: { type: 'http', url: 'https://x.test/mcp', headers: { 'Bad Header': 'x' } } });
    expect(() => readFleetMcpServers()).toThrow(/is not a valid headers name/);

    write({ srv: { type: 'http', url: 'https://x.test/mcp', description: 42 } });
    expect(() => readFleetMcpServers()).toThrow(/description must be a string/);

    write({ srv: { type: 'http', url: 'https://x.test/mcp', displayName: '  ' } });
    expect(() => readFleetMcpServers()).toThrow(/displayName must be a non-empty string/);

    // A field that belongs to per-group plugin provenance, which a fleet-wide
    // entry has no way to mean.
    write({ srv: { command: 'bun', pluginRoot: '/workspace/agent/plugins/x' } });
    expect(() => readFleetMcpServers()).toThrow(/unsupported field/);

    write({ srv: { type: 'http', url: 'https://x.test/mcp', env: { A: 'b' } } });
    expect(() => readFleetMcpServers()).toThrow(/unsupported field/);
  });

  it('refuses a retired name the runner would delete anyway', () => {
    write({ 'slack-user-token': { type: 'http', url: 'https://slack.test/mcp' } });
    expect(() => readFleetMcpServers()).toThrow(/retired/);
    expect(() =>
      updateFleetMcpServers((s) => (s['slack-user-token'] = { type: 'http', url: 'https://x.test/mcp' })),
    ).toThrow(/retired/);
  });

  it('holds the same retired set as the runner', () => {
    // Two copies of one fact across the host/container boundary (no shared
    // modules). This fails the moment they disagree.
    const source = fs.readFileSync('container/agent-runner/src/retired-mcp-servers.ts', 'utf-8');
    const literal = source.match(/RETIRED_MCP_SERVER_NAMES[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(literal, 'runner retired-set literal').not.toBeNull();
    const runnerNames = [...literal![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect([...RETIRED_MCP_SERVER_NAMES].sort()).toEqual(runnerNames);
  });
});

describe('effectiveMcpServers', () => {
  it('gives a group every fleet default it has not opted out of', () => {
    const servers = effectiveMcpServers({ mcpServers: {} });
    for (const name of Object.keys(DEFAULT_FLEET_MCP_SERVERS)) expect(servers[name]).toBeDefined();
  });

  it('lets the group’s own entry win over the fleet entry of the same name', () => {
    const own = { type: 'http' as const, url: 'https://mcp.littlebird.ai/mcp', description: 'mine' };
    expect(effectiveMcpServers({ mcpServers: { littlebird: own } }).littlebird).toBe(own);
  });

  it('drops a fleet entry the group excludes, and keeps one it declares itself', () => {
    const excludedOnly = effectiveMcpServers({ mcpServers: {}, excludeMcpServers: ['pocket', 'littlebird'] });
    expect(excludedOnly.pocket).toBeUndefined();
    expect(excludedOnly.littlebird).toBeUndefined();
    expect(excludedOnly.exa).toBeDefined();

    // Excluding a name the group ALSO declares itself is not a way to lose it:
    // the exclusion only ever withholds the inherited entry.
    const declared = effectiveMcpServers({
      mcpServers: { pocket: { type: 'http', url: 'https://public.heypocketai.com/mcp' } },
      excludeMcpServers: ['pocket'],
    });
    expect(declared.pocket).toBeDefined();
  });

  it('handles a group with no container config at all', () => {
    expect(Object.keys(effectiveMcpServers(undefined)).sort()).toEqual(Object.keys(DEFAULT_FLEET_MCP_SERVERS).sort());
  });
});
