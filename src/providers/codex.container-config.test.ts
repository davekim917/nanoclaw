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
    agentGroupFolder: 'example-retail-codex',
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

  it('test_codex_config_drops_host_plugin_state_and_keeps_unrelated_settings', () => {
    const fn = getProviderContainerConfig('codex')!;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-sanitize-'));
    const sessionDir = path.join(home, 'session');
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(codexHome, 'plugins'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":{"access_token":"kept"}}\n');
    const hostConfig = [
      'model = "gpt-5.5"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.context7]',
      'url = "https://mcp.context7.com/mcp"',
      '',
      '[mcp_servers.gitnexus]',
      'command = "npx"',
      'args = ["-y", "gitnexus", "mcp"]',
      '',
      '[plugins.humanizer]',
      'enabled = true',
      '',
      '[plugins.gitnexus]',
      'enabled = true',
      `cache_path = "${home}/.codex/plugins/cache/gitnexus/1.0.0"`,
      '',
      '[plugin_marketplaces.gitnexus]',
      `source = "${home}/plugins/gitnexus"`,
      '',
      '[plugin_marketplaces.team_tools]',
      `source = "${home}/plugins/team-tools"`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), hostConfig);

    try {
      const contribution = fn(
        makeCtx({
          sessionDir,
          agentGroupFolder: 'sanitize',
          hostEnv: { HOME: home } as NodeJS.ProcessEnv,
        }),
      );
      const written = fs.readFileSync(path.join(sessionDir, 'codex', 'config.toml'), 'utf8');

      expect(written).not.toMatch(/gitnexus/i);
      expect(written).toContain('model = "gpt-5.5"');
      expect(written).toContain('approval_policy = "on-request"');
      expect(written).toContain('sandbox_mode = "workspace-write"');
      expect(written).toContain('[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"');
      expect(written).not.toContain('[plugins.humanizer]');
      expect(written).not.toContain('[plugin_marketplaces.team_tools]');
      expect(fs.readFileSync(path.join(sessionDir, 'codex', 'auth.json'), 'utf8')).toBe(
        '{"tokens":{"access_token":"kept"}}\n',
      );
      expect(contribution.mounts).not.toContainEqual(
        expect.objectContaining({ containerPath: '/home/node/.codex/plugins' }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('test_spawn_replaces_poisoned_runtime_entries_and_clears_stale_config_without_host_config', () => {
    const fn = getProviderContainerConfig('codex')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-poisoned-'));
    const home = path.join(root, 'home');
    const sessionDir = path.join(root, 'session');
    const runtimeHome = path.join(sessionDir, 'codex');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(path.join(outside, 'tmp', 'marketplaces'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"fresh":true}');
    fs.writeFileSync(path.join(outside, 'tmp', 'marketplaces', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'plugins', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'agents', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'config-victim'), 'keep');
    fs.writeFileSync(path.join(outside, 'auth-victim'), 'keep');
    fs.symlinkSync(path.join(outside, 'tmp'), path.join(runtimeHome, '.tmp'), 'dir');
    fs.symlinkSync(path.join(outside, 'plugins'), path.join(runtimeHome, 'plugins'), 'dir');
    fs.symlinkSync(path.join(outside, 'agents'), path.join(runtimeHome, 'agents'), 'dir');
    fs.symlinkSync(path.join(outside, 'config-victim'), path.join(runtimeHome, 'config.toml'));
    fs.symlinkSync(path.join(outside, 'auth-victim'), path.join(runtimeHome, 'auth.json'));

    try {
      fn(
        makeCtx({
          sessionDir,
          agentGroupFolder: 'poisoned',
          hostEnv: { HOME: home } as NodeJS.ProcessEnv,
        }),
      );

      expect(fs.readFileSync(path.join(outside, 'tmp', 'marketplaces', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'plugins', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'agents', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'config-victim'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'auth-victim'), 'utf8')).toBe('keep');
      expect(fs.lstatSync(path.join(runtimeHome, 'config.toml')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8')).toBe('');
      expect(fs.lstatSync(path.join(runtimeHome, 'auth.json')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(runtimeHome, 'auth.json'), 'utf8')).toBe('{"fresh":true}');
      expect(fs.existsSync(path.join(runtimeHome, '.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(runtimeHome, 'plugins'))).toBe(false);
      expect(fs.existsSync(path.join(runtimeHome, 'agents'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('test_spawn_rejects_a_symlinked_runtime_root', () => {
    const fn = getProviderContainerConfig('codex')!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-root-link-'));
    const home = path.join(root, 'home');
    const sessionDir = path.join(root, 'session');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
    fs.symlinkSync(outside, path.join(sessionDir, 'codex'), 'dir');

    try {
      expect(() =>
        fn(
          makeCtx({
            sessionDir,
            agentGroupFolder: 'root-link',
            hostEnv: { HOME: home } as NodeJS.ProcessEnv,
          }),
        ),
      ).toThrow(/Unsafe runtime directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
