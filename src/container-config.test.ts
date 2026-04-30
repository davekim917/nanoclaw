import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readContainerConfig, type MemoryConfig } from './container-config.js';

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
