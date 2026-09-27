/**
 * Fork-only: the host's `plugin` ownership marker (stamped by
 * `withPluginOwner`, T5 PR 3) guards host-side mutations and must never reach
 * a provider's server map. Kept out of the upstream-owned `plugin-mcp.test.ts`
 * so that file stays byte-identical for the ratchet.
 */
import { describe, expect, it } from 'bun:test';

import { resolvePluginServer } from './plugin-mcp.js';

const ROOT = '/workspace/agent/plugins/sdr';

describe('resolvePluginServer — the ownership marker', () => {
  it("strips the host's `plugin` ownership marker from stdio and http servers (#500)", () => {
    // The marker guards host-side mutations (`assertMcpServerNotPluginOwned`
    // reads container.json); no provider may ever see it in its server map.
    const stdio = resolvePluginServer({
      command: 'node',
      args: ['${PLUGIN_ROOT}/index.js'],
      env: {},
      pluginRoot: ROOT,
      plugin: 'sdr',
    } as Parameters<typeof resolvePluginServer>[0]);
    expect(stdio).not.toHaveProperty('plugin');
    expect(stdio).not.toHaveProperty('pluginRoot');

    const http = resolvePluginServer({
      type: 'http',
      url: 'https://example.com/mcp',
      plugin: 'sdr',
    } as Parameters<typeof resolvePluginServer>[0]);
    expect(http).not.toHaveProperty('plugin');
    expect(http).toMatchObject({ type: 'http', url: 'https://example.com/mcp' });
  });

  it('an unmarked stdio server passes through unchanged', () => {
    const server = { command: 'node', args: ['a.js'], env: {} };
    expect(resolvePluginServer({ ...server })).toEqual(server);
  });

  it('strips the host-only displayName and description from a plugin-rooted server', () => {
    const resolved = resolvePluginServer({
      command: './bin/server',
      args: [],
      env: {},
      pluginRoot: ROOT,
      displayName: 'SDR',
      description: 'Sales tools',
    } as Parameters<typeof resolvePluginServer>[0]);
    expect(resolved).not.toHaveProperty('displayName');
    expect(resolved).not.toHaveProperty('description');
    expect(resolved).toMatchObject({ command: `${ROOT}/bin/server`, env: { PLUGIN_ROOT: ROOT } });
  });

  it('strips them from an http server too, keeping the rest', () => {
    const resolved = resolvePluginServer({
      type: 'http',
      url: 'https://example.com/mcp',
      displayName: 'Docs',
      instructions: 'kept',
    } as Parameters<typeof resolvePluginServer>[0]);
    expect(resolved).toEqual({ type: 'http', url: 'https://example.com/mcp', instructions: 'kept' });
  });
});
