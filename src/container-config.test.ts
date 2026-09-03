import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configFromDb,
  readContainerConfig,
  readContainerConfigForSpawn,
  readContainerConfigStrict,
  resolveGroupTimezone,
  writeContainerConfig,
} from './container-config.js';
import { TIMEZONE } from './config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

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
  return { ...actual, GROUPS_DIR: GROUPS_DIR };
});

const { GROUPS_DIR } = vi.hoisted(() => ({ GROUPS_DIR: uniqueTmpRoot('cc-test-groups') }));

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

describe('readContainerConfigStrict', () => {
  it('returns the same normalized snapshot for a valid regular file', () => {
    writeGroupConfig('test-strict-valid', { workgroup_id: 'workgroup-a' });
    expect(readContainerConfigStrict('test-strict-valid').workgroup_id).toBe('workgroup-a');
  });

  it('rejects a missing config instead of falling back to empty defaults', () => {
    expect(() => readContainerConfigStrict('test-strict-missing')).toThrow();
    expect(() => readContainerConfigForSpawn('test-strict-missing', true)).toThrow();
    expect(readContainerConfigForSpawn('test-strict-missing', false).mcpServers).toEqual({});
  });

  it('rejects malformed JSON instead of falling back to empty defaults', () => {
    const dir = path.join(GROUPS_DIR, 'test-strict-malformed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'container.json'), '{not-json\n');
    expect(() => readContainerConfigStrict('test-strict-malformed')).toThrow();
    expect(() => readContainerConfigForSpawn('test-strict-malformed', true)).toThrow();
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

/**
 * Group-timezone resolution (per-agent-group timezone feature).
 *
 * The chain is: valid per-group override → install-global TIMEZONE. An
 * invalid stored value (hand-edited DB — the ncl write path validates) must
 * fall back to the global timezone, not silently become UTC, and must never
 * be materialized into container.json.
 */
const TZ_GROUP: AgentGroup = {
  id: 'ag-tz',
  name: 'tz',
  folder: 'tz',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('resolveGroupTimezone', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup(TZ_GROUP);
    ensureContainerConfig(TZ_GROUP.id);
  });
  afterEach(() => {
    closeDb();
  });

  it('returns the install-global timezone when no override is set', () => {
    expect(resolveGroupTimezone(TZ_GROUP.id)).toBe(TIMEZONE);
    expect(resolveGroupTimezone('ag-no-such-group')).toBe(TIMEZONE);
  });

  it('returns a valid override, and falls back to global on an invalid stored value', () => {
    updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(resolveGroupTimezone(TZ_GROUP.id)).toBe('Asia/Tokyo');

    updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Not/AZone' });
    expect(resolveGroupTimezone(TZ_GROUP.id)).toBe(TIMEZONE);
  });

  it('configFromDb ships a valid timezone to the container and drops an invalid one', () => {
    updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(configFromDb(getContainerConfig(TZ_GROUP.id)!, TZ_GROUP).timezone).toBe('Asia/Tokyo');

    updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Not/AZone' });
    expect(configFromDb(getContainerConfig(TZ_GROUP.id)!, TZ_GROUP).timezone).toBeUndefined();
  });

  it('round-trips through container.json so the spawn path sees the override', () => {
    writeContainerConfig('tz-file', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      timezone: 'Asia/Tokyo',
    });
    expect(readContainerConfig('tz-file').timezone).toBe('Asia/Tokyo');
  });
});
