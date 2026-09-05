import { describe, it, expect } from 'bun:test';

import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

describe('mcpServersToOpenCodeConfig', () => {
  it('maps nanoclaw + extra server like v2 index.ts merge', () => {
    const servers = {
      nanoclaw: {
        command: 'node',
        args: ['/app/src/mcp-tools/index.js'],
        env: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        },
      },
      extra: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { FOO: 'bar' },
      },
    };

    const mcp = mcpServersToOpenCodeConfig(servers);

    expect(mcp.nanoclaw).toEqual({
      type: 'local',
      command: ['node', '/app/src/mcp-tools/index.js'],
      environment: {
        SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
      },
      enabled: true,
    });

    expect(mcp.extra).toEqual({
      type: 'local',
      command: ['npx', '-y', 'some-mcp'],
      environment: { FOO: 'bar' },
      enabled: true,
    });
  });

  it('omits environment when env is empty', () => {
    const mcp = mcpServersToOpenCodeConfig({
      x: { command: 'true', args: [], env: {} },
    });
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });

  it('maps http MCP entries to remote with headers', () => {
    const mcp = mcpServersToOpenCodeConfig({
      granola: {
        type: 'http',
        url: 'https://api.granola.ai/mcp',
        headers: { 'X-API-Key': 'placeholder' },
      },
    });
    expect(mcp.granola).toEqual({
      type: 'remote',
      url: 'https://api.granola.ai/mcp',
      headers: { 'X-API-Key': 'placeholder' },
      enabled: true,
    });
  });

  it('wraps a cwd-bearing stdio server through /bin/sh (OpenCode has no native cwd field)', () => {
    const mcp = mcpServersToOpenCodeConfig({
      plugged: {
        command: 'node',
        args: ['server.js', '--flag'],
        cwd: '/workspace/agent/plugins/sales-sdr',
      },
    });
    expect(mcp.plugged).toEqual({
      type: 'local',
      command: [
        '/bin/sh',
        '-c',
        'cd "$0" && exec "$@"',
        '/workspace/agent/plugins/sales-sdr',
        'node',
        'server.js',
        '--flag',
      ],
      enabled: true,
    });
  });

  it('leaves a cwd-less stdio server as a plain argv array', () => {
    const mcp = mcpServersToOpenCodeConfig({
      plain: { command: 'node', args: ['server.js'] },
    });
    expect(mcp.plain).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      enabled: true,
    });
  });

  it('rejects deprecated SSE MCP entries', () => {
    expect(() =>
      mcpServersToOpenCodeConfig({
        stream: { type: 'sse', url: 'https://example.com/sse' },
      }),
    ).toThrow(/deprecated SSE transport/);
  });
});
