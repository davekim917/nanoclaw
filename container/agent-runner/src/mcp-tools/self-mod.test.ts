import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { _resetConfig, _setConfigForTest } from '../config.js';
import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getStickyEffort, getStickyModel } from '../modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import type { McpToolDefinition } from './types.js';

const registeredToolNames: string[][] = [];
/** Every tool definition self-mod.ts has registered, by name — change_model and list_models are not exported. */
const registeredTools = new Map<string, McpToolDefinition>();
mock.module('./server.js', () => ({
  registerTools: (tools: McpToolDefinition[]) => {
    registeredToolNames.push(tools.map((tool) => tool.tool.name));
    for (const tool of tools) registeredTools.set(tool.tool.name, tool);
  },
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
  _resetConfig();
});

/** Text of a tool result, for either outcome. */
function text(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

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
 * The container is untrusted, so these tools only shape the request; the host
 * validates it (src/modules/self-mod/request.ts, pinned by request.test.ts).
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

  it('forwards the fields an approval card can show, and drops the rest', async () => {
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
      instructions: 'Use for file reads.',
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

describe('change_model sets the session-sticky model like the -m flag', () => {
  const changeModel = () => registeredTools.get('change_model')!;

  it('requires a slug and a known effort before touching session state', async () => {
    _setConfigForTest({ provider: 'claude' });
    expect(text(await changeModel().handler({}))).toContain('slug is required');
    expect(text(await changeModel().handler({ slug: '   ' }))).toContain('slug is required');
    expect(text(await changeModel().handler({ slug: 'opus', effort: 'extreme' }))).toContain(
      'effort must be one of: low, medium, high, max',
    );
    expect(getStickyModel()).toBeUndefined();
    expect(getStickyEffort()).toBeUndefined();
  });

  it('refuses an OpenCode slug without a provider prefix', async () => {
    _setConfigForTest({ provider: 'opencode' });
    for (const slug of ['kimi-k2.6', 'opencode-go/', '/kimi']) {
      const result = await changeModel().handler({ slug });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('is not a valid opencode model slug');
    }
    expect(getStickyModel()).toBeUndefined();
  });

  it('stores the trimmed slug and the effort for the next turn', async () => {
    _setConfigForTest({ provider: 'opencode' });
    const result = await changeModel().handler({ slug: '  opencode-go/kimi-k2.6 ', effort: 'max' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Switched to `opencode-go/kimi-k2.6` (effort `max`)');
    expect(getStickyModel()).toBe('opencode-go/kimi-k2.6');
    expect(getStickyEffort()).toBe('max');
  });

  it('leaves the effort alone when none is given, and does not apply the OpenCode slug rule elsewhere', async () => {
    _setConfigForTest({ provider: 'claude' });
    await changeModel().handler({ slug: 'opus', effort: 'high' });
    await changeModel().handler({ slug: 'sonnet' });
    expect(getStickyModel()).toBe('sonnet');
    expect(getStickyEffort()).toBe('high');
  });
});

describe('list_models inventories OpenCode slugs', () => {
  registerProviderSpecificSelfModTools('opencode');
  const listModels = () => registeredTools.get('list_models')!;

  /** Stand in for `opencode models`; the suite never runs a real subprocess. */
  function fakeOpencode(stdout: string, exitCode = 0, stderr = '') {
    return spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          stdout: new Response(stdout).body,
          stderr: new Response(stderr).body,
          exited: Promise.resolve(exitCode),
        }) as unknown as ReturnType<typeof Bun.spawn>,
    );
  }

  it('answers a non-OpenCode session without running anything', async () => {
    _setConfigForTest({ provider: 'codex' });
    const spawn = fakeOpencode('');
    try {
      expect(text(await listModels().handler({}))).toContain('codex model catalog');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  it('groups slugs by their first path segment and skips blanks and comments', async () => {
    _setConfigForTest({ provider: 'opencode', agentGroupId: 'ag-1' });
    const spawn = fakeOpencode(
      '# reachable models\nopencode-go/kimi-k2.6\n\nnvidia/deepseek-ai/deepseek-v4-pro\nopencode-go/glm-5\nbare\n',
    );
    try {
      const inventory = JSON.parse(text(await listModels().handler({}))) as Record<string, unknown>;
      expect(spawn.mock.calls[0]?.[0]).toEqual(['opencode', 'models']);
      expect(inventory.total).toBe(4);
      expect(inventory.denied).toBe(0);
      expect(inventory.grouped).toEqual({
        'opencode-go': ['opencode-go/kimi-k2.6', 'opencode-go/glm-5'],
        nvidia: ['nvidia/deepseek-ai/deepseek-v4-pro'],
        '(unknown)': ['bare'],
      });
    } finally {
      spawn.mockRestore();
    }
  });

  it('reports a failed or unrunnable opencode as an error', async () => {
    _setConfigForTest({ provider: 'opencode', agentGroupId: 'ag-1' });
    let spawn = fakeOpencode('', 2, 'not logged in\n');
    try {
      const result = await listModels().handler({});
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('opencode models exited 2: not logged in');
    } finally {
      spawn.mockRestore();
    }
    spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    try {
      expect(text(await listModels().handler({}))).toContain('Failed to run opencode models: ENOENT');
    } finally {
      spawn.mockRestore();
    }
  });

  it('refuses to inventory without an agent group', async () => {
    _setConfigForTest({ provider: 'opencode' });
    const spawn = fakeOpencode('opencode-go/kimi-k2.6\n');
    try {
      expect(text(await listModels().handler({}))).toContain('No agent group ID');
    } finally {
      spawn.mockRestore();
    }
  });
});
