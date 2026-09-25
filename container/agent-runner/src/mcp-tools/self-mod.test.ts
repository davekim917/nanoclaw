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
const { unavailableModelInventory, registerProviderSpecificSelfModTools, addMcpServer, installPackages } =
  await import('./self-mod.js');

/** The most recent system action add_mcp_server wrote to the outbound DB. */
function lastSystemAction(): Record<string, unknown> | undefined {
  const row = getOutboundDb()
    .prepare(`SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1`)
    .get() as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as Record<string, unknown>) : undefined;
}

/** Run a tool and return either the submitted payload or the error text. */
async function submit(
  args: Record<string, unknown>,
  tool: { handler: typeof addMcpServer.handler } = addMcpServer,
): Promise<{ payload?: Record<string, unknown>; error?: string }> {
  const result = await tool.handler(args);
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
describe('add_mcp_server forwards the request for the host to validate', () => {
  it('requires a name and nothing else', async () => {
    expect((await submit({ url: 'https://example.com/mcp' })).error).toContain('name is required');
    // Validation is the host's: an input the host will reject still reaches it.
    expect((await submit({ name: 'bad name!', url: 'http://example.com/mcp' })).payload).toEqual({
      action: 'add_mcp_server',
      name: 'bad name!',
      url: 'http://example.com/mcp',
    });
  });

  it('forwards every field the host accepts, including the ones it used to drop', async () => {
    const { payload } = await submit({
      name: 'fs',
      type: 'stdio',
      command: 'mcp-fs',
      args: ['/data'],
      env: { ROOT: '/data' },
      cwd: '/workspace/agent',
      instructions: 'Use for file reads.',
      displayName: 'Files',
      description: 'Local file server',
      unrelated: 'dropped',
    });
    expect(payload).toEqual({
      action: 'add_mcp_server',
      name: 'fs',
      type: 'stdio',
      command: 'mcp-fs',
      args: ['/data'],
      env: { ROOT: '/data' },
      cwd: '/workspace/agent',
      instructions: 'Use for file reads.',
      displayName: 'Files',
      description: 'Local file server',
    });
    expect(
      (
        await submit({
          name: 'deepwiki',
          url: 'https://mcp.deepwiki.com/mcp',
          headers: { Authorization: 'Bearer onecli-managed' },
        })
      ).payload,
    ).toEqual({
      action: 'add_mcp_server',
      name: 'deepwiki',
      url: 'https://mcp.deepwiki.com/mcp',
      headers: { Authorization: 'Bearer onecli-managed' },
    });
  });
});

describe('install_packages forwards the request for the host to validate', () => {
  it('requires at least one package array', async () => {
    expect((await submit({}, installPackages)).error).toContain('at least one package');
    expect((await submit({ apt: [], npm: [] }, installPackages)).error).toContain('at least one package');
    expect((await submit({ apt: 'curl' }, installPackages)).error).toContain('at least one package');
  });

  it('forwards names as given', async () => {
    expect((await submit({ apt: ['curl'], npm: ['Bad Name'], reason: 'why' }, installPackages)).payload).toEqual({
      action: 'install_packages',
      apt: ['curl'],
      npm: ['Bad Name'],
      reason: 'why',
    });
  });
});
