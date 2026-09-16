import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { dropRetiredMcpServers } from './retired-mcp-servers.js';

describe('dropRetiredMcpServers', () => {
  it('drops a stale slack-user-token entry and keeps every other server', () => {
    const logs: string[] = [];
    const servers: Record<string, unknown> = {
      nanoclaw: { type: 'stdio', command: 'bun' },
      'slack-user-token': { type: 'stdio', command: 'slack-mcp-server', args: ['--transport', 'stdio'] },
      amplitude: { type: 'http', url: 'https://example.invalid/mcp' },
    };

    dropRetiredMcpServers(servers, (m) => logs.push(m));

    expect(Object.keys(servers)).toEqual(['nanoclaw', 'amplitude']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('slack-user-token');
  });

  it('is applied in the runner after both MCP sources merge and before any provider consumes the map', () => {
    // index.ts is the process entry and cannot be imported in a test, so pin
    // the call's position in its source: after the container.json loop and the
    // NANOCLAW_MCP_SERVERS merge, before the first consumer of the map.
    const source = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf8');
    const call = source.indexOf('dropRetiredMcpServers(mcpServers, log);');
    expect(call).toBeGreaterThan(
      source.indexOf('for (const [name, serverConfig] of Object.entries(config.mcpServers))'),
    );
    expect(call).toBeGreaterThan(source.indexOf('JSON.parse(process.env.NANOCLAW_MCP_SERVERS)'));
    expect(call).toBeLessThan(source.indexOf('setupCodexRuntime(mcpServers'));
    expect(source.indexOf('dropRetiredMcpServers(mcpServers, log);', call + 1)).toBe(-1);
  });

  it('is silent when nothing retired is present', () => {
    const logs: string[] = [];
    const servers: Record<string, unknown> = { nanoclaw: {} };
    dropRetiredMcpServers(servers, (m) => logs.push(m));
    expect(Object.keys(servers)).toEqual(['nanoclaw']);
    expect(logs).toEqual([]);
  });
});
