import { homedir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup } from '../../types.js';
import type { ContainerConfig } from '../../container-config.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';

// child_process mock must be declared before any module imports that use it.
// The promisified execFile in binary.ts and store.ts becomes a direct async call
// wrapping this mock.
vi.mock('child_process', async () => {
  return {
    execFile: vi.fn(),
  };
});

import { applyMnemonMounts, applyMnemonEnv } from './index.js';
import { mnemonBinaryAvailable } from './binary.js';
import { ensureStore } from './store.js';
import { execFile } from 'child_process';

const mockExecFile = vi.mocked(execFile);

const testAgentGroup: AgentGroup = {
  id: 'ag-test-123',
  name: 'Test Agent',
  folder: 'test-agent',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    ...overrides,
  };
}

describe('applyMnemonMounts', () => {
  it('test_applyMnemonMounts_noop_when_disabled', () => {
    const mounts: VolumeMount[] = [];
    const containerConfig = makeConfig({ mnemon: undefined });

    applyMnemonMounts({ mounts, agentGroup: testAgentGroup, containerConfig });

    expect(mounts.length).toBe(0);
  });

  it('test_applyMnemonMounts_pushes_two_when_enabled', () => {
    const mounts: VolumeMount[] = [];
    const containerConfig = makeConfig({ mnemon: { enabled: true, embeddings: true } });

    applyMnemonMounts({ mounts, agentGroup: testAgentGroup, containerConfig });

    // Three mounts: per-store data dir (RW), prompt dir (RO), rollout JSON (RO).
    expect(mounts.length).toBe(3);

    const storeDataMount = mounts.find((m) => m.containerPath === `/home/node/.mnemon/data/${testAgentGroup.id}`);
    expect(storeDataMount).toBeDefined();
    expect(storeDataMount?.hostPath).toBe(path.join(homedir(), '.mnemon', 'data', testAgentGroup.id));
    expect(storeDataMount?.readonly).toBe(false);

    const promptMount = mounts.find((m) => m.containerPath === '/home/node/.mnemon/prompt');
    expect(promptMount).toBeDefined();
    expect(promptMount?.hostPath).toBe(path.join(homedir(), '.mnemon', 'prompt'));
    expect(promptMount?.readonly).toBe(true);

    const rolloutMount = mounts.find((m) => m.containerPath === '/workspace/agent/.mnemon-rollout.json');
    expect(rolloutMount).toBeDefined();
    expect(rolloutMount?.readonly).toBe(true);
  });

  it('test_applyMnemonMounts_no_full_mnemon_dir', () => {
    // Regression test for post-build security review S9/A6:
    // verify the full ~/.mnemon directory is NEVER bind-mounted (would expose cross-tenant data).
    const mounts: VolumeMount[] = [];
    const containerConfig = makeConfig({ mnemon: { enabled: true, embeddings: true } });

    applyMnemonMounts({ mounts, agentGroup: testAgentGroup, containerConfig });

    const fullMnemonMount = mounts.find((m) => m.containerPath === '/home/node/.mnemon');
    expect(fullMnemonMount).toBeUndefined();
  });
});

describe('applyMnemonEnv', () => {
  it('test_applyMnemonEnv_no_embed_env_when_embeddings_false', () => {
    const args: string[] = [];
    const containerConfig = makeConfig({ mnemon: { enabled: true, embeddings: false } });

    applyMnemonEnv({ args, agentGroup: testAgentGroup, containerConfig });

    expect(args).toContain('MNEMON_STORE=ag-test-123');
    expect(args.join(' ')).not.toContain('MNEMON_EMBED_ENDPOINT');
  });

  it('test_applyMnemonEnv_includes_embed_when_embeddings_true', () => {
    const args: string[] = [];
    const containerConfig = makeConfig({ mnemon: { enabled: true, embeddings: true } });

    applyMnemonEnv({ args, agentGroup: testAgentGroup, containerConfig });

    expect(args).toContain('MNEMON_STORE=ag-test-123');
    expect(args).toContain('MNEMON_EMBED_ENDPOINT=http://host.docker.internal:11434');
    expect(args).toContain('MNEMON_EMBED_MODEL=nomic-embed-text');
  });
});

describe('ensureStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_ensureStore_idempotent', async () => {
    // First call succeeds; second call throws "store already exists" but ensureStore swallows it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any)
      .mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
        cb(null, '', '');
      })
      .mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
        cb(Object.assign(new Error('store already exists'), { code: 1 }), '', '');
      });

    await expect(ensureStore('test')).resolves.toBeUndefined();
    await expect(ensureStore('test')).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('test_ensureStore_propagates_real_errors', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
      cb(Object.assign(new Error('permission denied'), { code: 1 }), '', '');
    });

    await expect(ensureStore('test')).rejects.toThrow('permission denied');
  });
});

describe('mnemonBinaryAvailable', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_mnemonBinaryAvailable_true_on_match', async () => {
    // vi.fn() lacks execFile's util.promisify.custom symbol, so promisify resolves
    // the first non-error arg. binary.ts destructures { stdout } from the result,
    // so we pass the object as the single resolved arg.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'mnemon version 0.1.2\n', stderr: '' });
    });

    const result = await mnemonBinaryAvailable();

    expect(result).toBe(true);
  });

  it('test_mnemonBinaryAvailable_false_on_error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), { stdout: '', stderr: '' });
    });

    const result = await mnemonBinaryAvailable();

    expect(result).toBe(false);
  });
});
