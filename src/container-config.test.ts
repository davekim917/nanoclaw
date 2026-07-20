import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readContainerConfig, writeContainerConfig } from './container-config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Stub GROUPS_DIR by writing container.json directly into a subfolder of tmpDir
// readContainerConfig takes a folder name and resolves it against GROUPS_DIR.
// Since we can't easily override GROUPS_DIR, we use vi.mock below to redirect it.

import { vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-cc-test-groups' };
});

const GROUPS_DIR = '/tmp/nanoclaw-cc-test-groups';

function writeGroupConfig(folder: string, content: object): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(content, null, 2) + '\n');
}

describe('workgroup and capability config', () => {
  it('test_workgroup_id_round_trip', () => {
    // writeContainerConfig + readContainerConfig must preserve workgroup_id
    const folder = 'test-wg-roundtrip';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      workgroup_id: 'my-workgroup-123',
    };
    writeContainerConfig(folder, config);
    const result = readContainerConfig(folder);
    expect(result.workgroup_id).toBe('my-workgroup-123');
  });

  it('test_slack_user_token_round_trip', () => {
    // writeContainerConfig + readContainerConfig must preserve slack_user_token
    // (enabled flag + override allow-list)
    const folder = 'test-slack-user-token-roundtrip';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      slack_user_token: {
        enabled: true,
        also_allowed_in: ['mg-channel-eng-leads-private'],
      },
    };
    writeContainerConfig(folder, config);
    const result = readContainerConfig(folder);
    expect(result.slack_user_token?.enabled).toBe(true);
    expect(result.slack_user_token?.also_allowed_in).toEqual(['mg-channel-eng-leads-private']);
  });

  it('test_slack_user_token_undefined_when_absent', () => {
    const folder = 'test-slack-user-token-absent';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    writeContainerConfig(folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
    });
    const result = readContainerConfig(folder);
    expect(result.slack_user_token).toBeUndefined();
  });
});

describe('readContainerConfig — resource block', () => {
  it('test_container_resources_round_trip', () => {
    writeGroupConfig('test-resources', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: {
        memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
        cpus: 2,
        pidsLimit: 768,
      },
    });

    expect(readContainerConfig('test-resources').resources).toEqual({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });
  });

  it('test_container_resources_invalid_file_fails_closed', () => {
    writeGroupConfig('test-invalid-resources', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: {
        memory: { requestMb: 5120, limitMb: 3072, memorySwapLimitMb: 5120 },
      },
    });

    expect(() => readContainerConfig('test-invalid-resources')).toThrow(/requestMb.*limitMb/);
  });
});

describe('MCP server transport validation', () => {
  it('preserves stdio and Streamable HTTP MCP server configs', () => {
    writeGroupConfig('test-mcp-transports', {
      mcpServers: {
        local: { command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } },
        exa: {
          type: 'http',
          url: 'https://mcp.exa.ai/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-mcp-transports');

    expect(result.mcpServers.local).toEqual({ command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } });
    expect(result.mcpServers.exa).toEqual({
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { Authorization: 'Bearer placeholder' },
    });
  });

  it('readContainerConfig rejects deprecated SSE MCP servers', () => {
    writeGroupConfig('test-mcp-sse-read', {
      mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    expect(() => readContainerConfig('test-mcp-sse-read')).toThrow(/deprecated SSE transport/);
  });

  it('writeContainerConfig rejects deprecated SSE MCP servers', () => {
    expect(() =>
      writeContainerConfig('test-mcp-sse-write', {
        mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } },
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      }),
    ).toThrow(/deprecated SSE transport/);
  });
});
