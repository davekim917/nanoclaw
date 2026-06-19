/**
 * Regression test for the codex provider's container-config contribution —
 * specifically that synced named subagent role definitions
 * (`$CODEX_HOME/agents/*.toml`) reach codex-primary containers.
 *
 * The `multi_agent` feature (stable, default-on in Codex 0.140) gives the
 * spawn_agent tool unconditionally, so GENERIC subagents work without any of
 * this. What this guards is the NAMED role layer: Codex reads `[agents.*]`
 * roles from `$CODEX_HOME/agents/*.toml`, and the host writes them (via
 * src/codex-sync.ts) into the per-group / global codex home. The session-local
 * `/home/node/.codex` must surface that dir or codex-primary groups silently
 * lose every custom role.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';
// Importing the module registers the 'codex' container-config callback.
import './codex.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-cc-'));
const SESSION_DIR = path.join(TEST_HOME, 'session');

function makeCtx(overrides: Partial<ProviderContainerContext> = {}): ProviderContainerContext {
  return {
    sessionDir: SESSION_DIR,
    agentGroupId: 'grp-1',
    agentGroupFolder: 'madison-reed-codex',
    groupDir: path.join(TEST_HOME, 'group'),
    selectedSkills: [],
    hostEnv: { HOME: TEST_HOME } as NodeJS.ProcessEnv,
    ...overrides,
  };
}

beforeAll(() => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  // Minimal global codex home: auth.json + one named role definition.
  const codexDir = path.join(TEST_HOME, '.codex');
  fs.mkdirSync(path.join(codexDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'auth.json'), '{}');
  fs.writeFileSync(
    path.join(codexDir, 'agents', 'code-review-specialist.toml'),
    '# managed by nanoclaw codex-sync\ndescription = "review"\n',
  );
});

afterAll(() => {
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('codex provider container-config: agents/ mount', () => {
  it('test_mounts_global_agents_dir_readonly', () => {
    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();

    const contribution = fn!(makeCtx());
    const agentsMount = (contribution.mounts ?? []).find((m) => m.containerPath === '/home/node/.codex/agents');

    expect(agentsMount).toBeDefined();
    expect(agentsMount!.readonly).toBe(true);
    expect(agentsMount!.hostPath).toBe(path.join(TEST_HOME, '.codex', 'agents'));
  });

  it('test_no_agents_mount_when_dir_absent', () => {
    const fn = getProviderContainerConfig('codex')!;
    // Point HOME at a codex home with auth but no agents/ dir.
    const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-bare-'));
    try {
      fs.mkdirSync(path.join(bareHome, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(bareHome, '.codex', 'auth.json'), '{}');

      const contribution = fn(makeCtx({ hostEnv: { HOME: bareHome } as NodeJS.ProcessEnv }));
      const agentsMount = (contribution.mounts ?? []).find((m) => m.containerPath === '/home/node/.codex/agents');
      expect(agentsMount).toBeUndefined();
    } finally {
      fs.rmSync(bareHome, { recursive: true, force: true });
    }
  });
});
