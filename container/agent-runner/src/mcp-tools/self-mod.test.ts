import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';

const registeredToolNames: string[][] = [];
mock.module('./server.js', () => ({
  registerTools: (tools: Array<{ tool: { name: string } }>) =>
    registeredToolNames.push(tools.map((tool) => tool.tool.name)),
}));

// NOTE: do NOT mock.module('../db/messages-out.js') here. bun runs every test
// file sequentially in ONE process and mock.module is process-global and
// permanent, so stubbing writeMessageOut sends every later file's outbound
// writes nowhere — see the same warning at the top of agents.test.ts. Assert
// against the real in-memory session DB instead.
const { unavailableModelInventory, registerProviderSpecificSelfModTools, addMcpServer } = await import('./self-mod.js');

/** The most recent system action add_mcp_server wrote to the outbound DB. */
function lastSystemAction(): Record<string, unknown> | undefined {
  const row = getOutboundDb()
    .prepare(`SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1`)
    .get() as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as Record<string, unknown>) : undefined;
}

/** Run the tool and return either the submitted payload or the error text. */
async function submit(args: Record<string, unknown>): Promise<{ payload?: Record<string, unknown>; error?: string }> {
  const result = await addMcpServer.handler(args);
  if (result.isError) return { error: result.content[0]?.text ?? '' };
  return { payload: lastSystemAction() };
}

beforeEach(() => {
  registeredToolNames.length = 0;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('list_models', () => {
  it('does not present an OpenCode inventory as a Codex catalog', () => {
    const result = unavailableModelInventory('codex')!;
    expect(result.content[0]?.text).toContain('codex model catalog');
    expect(result.content[0]?.text).toContain('set_channel_model');
  });

  it('does not expose the OpenCode inventory tool to Codex agents', () => {
    registerProviderSpecificSelfModTools('codex');
    expect(registeredToolNames.flat()).not.toContain('list_models');
  });
});

/**
 * The container-side parser mirrors the host's `parseMcpServerConfig`
 * (src/container-config.ts) so the agent hears about a bad config
 * immediately instead of after an approval round-trip. These pin the shared
 * rules on this side; the host side is pinned in src/modules/self-mod/request.test.ts.
 */
describe('add_mcp_server remote Streamable HTTP', () => {
  it('submits a remote https server as an http payload', async () => {
    const { payload } = await submit({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' });
    expect(payload).toEqual({
      action: 'add_mcp_server',
      name: 'deepwiki',
      type: 'http',
      url: 'https://mcp.deepwiki.com/mcp',
    });
  });

  it('still submits a local stdio server without a type field', async () => {
    const { payload } = await submit({ name: 'fs', command: 'mcp-fs', args: ['/data'] });
    expect(payload).toEqual({
      action: 'add_mcp_server',
      name: 'fs',
      command: 'mcp-fs',
      args: ['/data'],
      env: {},
    });
  });

  it('carries OneCLI placeholder headers and rejects a real credential', async () => {
    const ok = await submit({
      name: 'datafold',
      url: 'https://app.datafold.com/mcp/',
      headers: { Authorization: 'Key onecli-managed' },
    });
    expect(ok.payload?.headers).toEqual({ Authorization: 'Key onecli-managed' });

    const bad = await submit({
      name: 'leaky',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer real-token' },
    });
    expect(bad.error).toContain('onecli-managed');

    // A substring test accepted this, persisting the real secret alongside
    // the sentinel.
    const smuggled = await submit({
      name: 'smuggle',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer actual-secret onecli-managed' },
    });
    expect(smuggled.error).toContain('must be exactly');

    // The gate is on the value, so a header name no list anticipates is
    // covered too — `X-Functions-Key` matched nothing in the name list.
    // The gate is an allowlist of configuration headers, so a vendor key
    // header is covered whatever its value looks like — `abc123` is a fine
    // API key and no length or character-mix rule catches it.
    for (const value of ['aB3xY9kLmN2pQ7rS8t', 'abc123']) {
      const customKey = await submit({
        name: 'custom',
        url: 'https://example.com/mcp',
        headers: { 'X-Functions-Key': value },
      });
      expect(customKey.error).toContain('not a known configuration header');
    }
    expect(
      (await submit({ name: 'ok', url: 'https://example.com/mcp', headers: { 'Content-Type': 'application/json' } }))
        .payload,
    ).toBeDefined();

    const raw = await submit({ name: 'leaky', url: 'https://example.com/mcp', headers: { 'X-A': 'ghp_deadbeef1234' } });
    expect(raw.error).toContain('raw credential');
  });

  it('rejects plain http off-loopback but allows localhost and host.docker.internal', async () => {
    expect((await submit({ name: 'insecure', url: 'http://example.com/mcp' })).error).toContain('HTTPS');
    expect((await submit({ name: 'local', url: 'http://localhost:8080/mcp' })).payload?.url).toBe(
      'http://localhost:8080/mcp',
    );
    expect((await submit({ name: 'hostgw', url: 'http://host.docker.internal:8080/mcp' })).payload?.url).toBe(
      'http://host.docker.internal:8080/mcp',
    );
  });

  it('rejects credentials, fragments, and credential-shaped query keys', async () => {
    for (const url of [
      'https://user:pass@example.com/mcp',
      'https://example.com/mcp#frag',
      'https://example.com/mcp?authToken=abc',
    ]) {
      expect((await submit({ name: 'bad', url })).error).toBeDefined();
    }
    // Credential nouns, not a list of names: accessKey/clientKey/subscriptionKey
    // all signal a credential even though none of them is `apiKey`.
    for (const key of ['accessKey', 'clientKey', 'subscriptionKey', 'apikey', 'accesskey', 'authtoken']) {
      expect((await submit({ name: 'q', url: `https://example.com/mcp?${key}=abc123` })).error).toContain(
        'looks like a credential',
      );
    }
    // A non-credential query string is legitimate endpoint config.
    expect((await submit({ name: 'exa', url: 'https://mcp.exa.ai/mcp?tools=web_search_exa' })).payload).toBeDefined();
    expect((await submit({ name: 'kw', url: 'https://example.com/mcp?keyword=v' })).payload).toBeDefined();
  });

  it('rejects a raw credential in the url path or a query value', async () => {
    expect((await submit({ name: 'zapier', url: 'https://hooks.example.com/s/sk-abc123/mcp' })).error).toContain(
      'url path carries a raw credential',
    );
    expect((await submit({ name: 'q', url: 'https://example.com/mcp?tools=ghp_deadbeef1234' })).error).toContain(
      'carries a raw credential',
    );
    // An opaque segment matching no known credential shape stays legal.
    expect((await submit({ name: 'ok', url: 'https://hooks.example.com/s/abc123/mcp' })).payload).toBeDefined();
  });

  it('rejects a JWT in a neutral-named query param or the url path', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect((await submit({ name: 'q', url: `https://example.com/mcp?code=${jwt}` })).error).toContain('raw credential');
    expect((await submit({ name: 'q', url: `https://example.com/callback/${jwt}` })).error).toContain('raw credential');
  });

  it('rejects a declared transport that contradicts the fields', async () => {
    expect((await submit({ name: 'x', type: 'stdio', url: 'https://example.com/mcp' })).error).toContain(
      'cannot be used with url',
    );
    expect((await submit({ name: 'x', type: 'http', command: 'node' })).error).toContain('cannot be used with command');
    // The alias still works where it agrees with the fields.
    expect(
      (await submit({ name: 'x', type: 'streamable-http', url: 'https://example.com/mcp' })).payload,
    ).toBeDefined();
  });

  it('rejects a bad server name, both transports at once, and cross-transport fields', async () => {
    expect((await submit({ name: 'bad name!', url: 'https://example.com/mcp' })).error).toContain('1-64 characters');
    expect((await submit({ name: 'both', command: 'node', url: 'https://example.com/mcp' })).error).toContain(
      'exactly one of command or url',
    );
    expect((await submit({ name: 'mixed', url: 'https://example.com/mcp', env: { K: 'v' } })).error).toContain(
      'only valid with command',
    );
    expect((await submit({ name: 'mixed', command: 'node', headers: { 'X-A': 'b' } })).error).toContain(
      'headers are only valid with url',
    );
    expect((await submit({ name: 'neither' })).error).toContain('exactly one of command or url');
  });

  it('rejects a server name that would hit Object.prototype on plain assignment', async () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect((await submit({ name: reserved, url: 'https://example.com/mcp' })).error).toContain('reserved');
    }
  });

  it('rejects control characters in a header value, allowlisted or not', async () => {
    expect(
      (
        await submit({
          name: 'inject',
          url: 'https://example.com/mcp',
          headers: { 'Content-Type': 'application/json\r\nX-Injected: yes' },
        })
      ).error,
    ).toContain('control character');
    expect(
      (await submit({ name: 'auth', url: 'https://example.com/mcp', headers: { Authorization: 'onecli-managed\0' } }))
        .error,
    ).toContain('control character');
  });
});
