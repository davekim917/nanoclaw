import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readContainerConfig,
  writeContainerConfig,
  isFeedbackEnabled,
  getQueryStrategy,
  getRecallScope,
  type MemoryConfig,
  type RecallScope,
} from './container-config.js';

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

describe('MemoryConfig resolvers', () => {
  it('test_isFeedbackEnabled_default_true', () => {
    const cfg: MemoryConfig = { enabled: true };
    expect(isFeedbackEnabled(cfg)).toBe(true);
  });

  it('test_isFeedbackEnabled_explicit_opt_out', () => {
    const cfg: MemoryConfig = { enabled: true, feedback_enabled: false };
    expect(isFeedbackEnabled(cfg)).toBe(false);
  });

  it('test_isFeedbackEnabled_memory_disabled', () => {
    const cfg: MemoryConfig = { enabled: false, feedback_enabled: true };
    expect(isFeedbackEnabled(cfg)).toBe(false);
  });

  it('test_isFeedbackEnabled_undefined_cfg', () => {
    expect(isFeedbackEnabled(undefined)).toBe(false);
  });

  it('test_getQueryStrategy_default', () => {
    const cfg: MemoryConfig = { enabled: true };
    expect(getQueryStrategy(cfg)).toBe('raw');
  });

  it('test_getQueryStrategy_undefined', () => {
    expect(getQueryStrategy(undefined)).toBe('raw');
  });

  it('test_getQueryStrategy_llm', () => {
    const cfg: MemoryConfig = { enabled: true, query_strategy: 'llm' };
    expect(getQueryStrategy(cfg)).toBe('llm');
  });

  it('test_getQueryStrategy_heuristic', () => {
    const cfg: MemoryConfig = { enabled: true, query_strategy: 'heuristic' };
    expect(getQueryStrategy(cfg)).toBe('heuristic');
  });

  it('test_getRecallScope_default', () => {
    const cfg: MemoryConfig = { enabled: true };
    expect(getRecallScope(cfg)).toBe('workgroup');
  });

  it('test_getRecallScope_undefined', () => {
    expect(getRecallScope(undefined)).toBe('workgroup');
  });

  it('test_getRecallScope_all_groups', () => {
    const cfg: MemoryConfig = { enabled: true, recall_scope: 'all-groups' };
    expect(getRecallScope(cfg)).toBe('all-groups');
  });

  it('test_getRecallScope_array', () => {
    const cfg: MemoryConfig = { enabled: true, recall_scope: ['axie-dev', 'madison-reed'] };
    expect(getRecallScope(cfg)).toEqual(['axie-dev', 'madison-reed']);
  });
});

describe('RecallScope type + getRecallScope (B1)', () => {
  it('test_recall_scope_default_is_workgroup', () => {
    // Default flipped 2026-05-19 — workgroups feature exists to widen recall,
    // so the default IS the wider behavior. Standalone agents (no workgroup_id)
    // fall back to 'self' in resolveRecallScope (see scope-resolver tests).
    expect(getRecallScope(undefined)).toBe('workgroup');
    const cfg: MemoryConfig = { enabled: true };
    expect(getRecallScope(cfg)).toBe('workgroup');
  });

  it('test_recall_scope_accepts_workgroup', () => {
    // 'workgroup' is now a valid RecallScope value (type narrowing should pass)
    const scope: RecallScope = 'workgroup';
    const cfg: MemoryConfig = { enabled: true, recall_scope: scope };
    expect(getRecallScope(cfg)).toBe('workgroup');
  });

  it('test_recall_scope_accepts_string_array', () => {
    const scope: RecallScope = ['axie-dev', 'madison-reed'];
    const cfg: MemoryConfig = { enabled: true, recall_scope: scope };
    expect(getRecallScope(cfg)).toEqual(['axie-dev', 'madison-reed']);
  });

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

describe('readContainerConfig — memory block', () => {
  it('test_readContainerConfig_no_memory', () => {
    writeGroupConfig('test-group', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group');

    expect(result.memory).toBeUndefined();
  });

  it('test_readContainerConfig_memory_enabled', () => {
    writeGroupConfig('test-group2', {
      memory: { enabled: true },
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group2');

    expect(result.memory).toEqual({ enabled: true } satisfies MemoryConfig);
  });

  it('test_readContainerConfig_drops_legacy_mnemon_field', () => {
    // Legacy mnemon field with embeddings — should be silently dropped (not mapped to memory)
    writeGroupConfig('test-group3', {
      mnemon: { enabled: true, embeddings: true },
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group3');

    expect(result.memory).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).mnemon).toBeUndefined();
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
