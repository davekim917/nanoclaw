/**
 * Regression tests for the codex provider's container-config contribution.
 *
 * Contract: host coupling is credential-only. auth.json comes from the
 * scoped `~/.codex-<folder>` (else the shared-account `~/.codex`) — but
 * config.toml is GENERATED (never copied from any host home) and the named
 * subagent roles (`$CODEX_HOME/agents/*.toml`) come exclusively from the
 * group-owned `groups/<folder>/.codex/agents/`. A host `~/.codex/agents/`
 * dir must never reach a container, even when it exists.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';
// Importing the module registers the 'codex' container-config callback.
import './codex.js';
import { buildContainerCodexConfig } from './codex.js';

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
  it('test_mounts_group_owned_agents_dir_readonly_never_host', () => {
    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();

    // Group-owned defs exist AND a host ~/.codex/agents exists (beforeAll) —
    // the group dir must win and the host dir must be ignored entirely.
    const groupDir = path.join(TEST_HOME, 'group');
    fs.mkdirSync(path.join(groupDir, '.codex', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.codex', 'agents', 'qa-worker.toml'), 'name = "qa-worker"\n');

    const contribution = fn!(makeCtx({ groupDir }));
    const agentsMount = (contribution.mounts ?? []).find((m) => m.containerPath === '/home/node/.codex/agents');

    expect(agentsMount).toBeDefined();
    expect(agentsMount!.readonly).toBe(true);
    expect(agentsMount!.hostPath).toBe(path.join(groupDir, '.codex', 'agents'));
  });

  it('test_no_agents_mount_when_group_dir_absent_even_with_host_agents', () => {
    const fn = getProviderContainerConfig('codex')!;
    // Host home HAS an agents/ dir (beforeAll), but the group owns none —
    // no mount. Host defs must never fall through to a container.
    const emptyGroupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-nogroup-'));
    try {
      const contribution = fn(makeCtx({ groupDir: emptyGroupDir }));
      const agentsMount = (contribution.mounts ?? []).find((m) => m.containerPath === '/home/node/.codex/agents');
      expect(agentsMount).toBeUndefined();
    } finally {
      fs.rmSync(emptyGroupDir, { recursive: true, force: true });
    }
  });

  it('test_codex_config_is_generated_never_copied_from_host', () => {
    const fn = getProviderContainerConfig('codex')!;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-codex-sanitize-'));
    const sessionDir = path.join(home, 'session');
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":{"access_token":"kept"}}\n');
    // A maximally leaky host config: personal model pin, personality, project
    // trust table, TUI/hook state, plugins. NONE of it may reach the session.
    const hostConfig = [
      'model = "gpt-5.5"',
      'personality = "pragmatic"',
      '',
      '[projects."/home/hostuser/secret-repo"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state."/home/hostuser/.codex/hooks.json:stop:0:0"]',
      'acknowledged = true',
      '',
      '[plugins.humanizer]',
      'enabled = true',
      '',
      '[tui.model_availability_nux]',
      '"gpt-5.5" = 4',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), hostConfig);

    try {
      fn(
        makeCtx({
          sessionDir,
          agentGroupFolder: 'sanitize',
          hostEnv: { HOME: home } as NodeJS.ProcessEnv,
        }),
      );
      const written = fs.readFileSync(path.join(sessionDir, 'codex', 'config.toml'), 'utf8');

      // Exactly the generated container base.
      expect(written).toBe(buildContainerCodexConfig());
      expect(written).not.toContain('gpt-5.5');
      expect(written).not.toContain('personality');
      expect(written).not.toContain('secret-repo');
      expect(written).not.toContain('hooks.state');
      expect(written).not.toContain('[plugins.humanizer]');
      // Load-bearing container settings are present.
      expect(written).toContain('sandbox_mode = "workspace-write"');
      expect(written).toContain('approval_policy = "on-request"');
      expect(written).toContain('[features]');
      expect(written).toContain('[features.multi_agent_v2]');
      expect(written).toContain('[projects."/workspace/agent"]');
      // Credentials still flow.
      expect(fs.readFileSync(path.join(sessionDir, 'codex', 'auth.json'), 'utf8')).toBe(
        '{"tokens":{"access_token":"kept"}}\n',
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
          groupDir: path.join(root, 'group'), // no .codex/agents → entry removed
          hostEnv: { HOME: home } as NodeJS.ProcessEnv,
        }),
      );

      expect(fs.readFileSync(path.join(outside, 'tmp', 'marketplaces', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'plugins', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'agents', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'config-victim'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'auth-victim'), 'utf8')).toBe('keep');
      expect(fs.lstatSync(path.join(runtimeHome, 'config.toml')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8')).toBe(buildContainerCodexConfig());
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
