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

describe('readContainerConfig — mnemon block', () => {
  it('test_mnemon_block_round_trips', () => {
    writeGroupConfig('test-group', {
      mnemon: { enabled: true, embeddings: true },
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group');

    expect(result.mnemon).toEqual({ enabled: true, embeddings: true });
  });

  it('test_no_mnemon_block_reads_undefined', () => {
    writeGroupConfig('test-group2', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group2');

    expect(result.mnemon).toBeUndefined();
  });

  it('test_partial_mnemon_block_drops', () => {
    writeGroupConfig('test-group3', {
      mnemon: { enabled: true },
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-group3');

    expect(result.mnemon).toEqual({ enabled: true });
  });

  it('round-trip: writeContainerConfig then readContainerConfig preserves mnemon block', () => {
    const folder = 'test-group4';
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });

    writeContainerConfig(folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      mnemon: { enabled: true, embeddings: false },
    });

    const result = readContainerConfig(folder);

    expect(result.mnemon).toEqual({ enabled: true, embeddings: false });
  });
});
