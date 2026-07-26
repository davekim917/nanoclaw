import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import {
  DATAFOLD_MCP_SERVER,
  dockerResourceLimitArgs,
  graphifyContainerArgs,
  resolveMemoryAdmissionBudgetMb,
  serializeMcpServersEnv,
  resolveAnthropicAuth,
  resolveCodexAuthFallbacks,
  materializeCodexFallbackRuntime,
  resolveProviderName,
  resolveWorkgroupMemoryLockMount,
  resolveWorkgroupMemoryMount,
  WORKGROUP_MEMORY_LOCK_CONTAINER_PATH,
  replaceClaudeNativeMemoryMount,
  reconcileWorkgroupAtSpawn,
} from './container-runner.js';
import { formatMemoryMb, resolveContainerResources } from './container-resources.js';
import { mergeWorkgroupAndGroupSecrets } from './onecli-secrets.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('dockerResourceLimitArgs', () => {
  it('adds the configured install-wide resource ceilings', () => {
    const configured = resolveContainerResources();
    const expected = [
      '--memory',
      formatMemoryMb(configured.memory.limitMb),
      '--memory-reservation',
      formatMemoryMb(configured.memory.requestMb),
      '--memory-swap',
      formatMemoryMb(configured.memory.memorySwapLimitMb),
    ];
    if (configured.cpus !== undefined) expected.push('--cpus', String(configured.cpus));
    expected.push('--pids-limit', String(configured.pidsLimit));

    expect(dockerResourceLimitArgs()).toEqual(expected);
  });

  it('test_docker_resource_args_apply_group_override_once', () => {
    const args = dockerResourceLimitArgs({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });

    expect(args).toEqual([
      '--memory',
      '5g',
      '--memory-reservation',
      '5g',
      '--memory-swap',
      '5g',
      '--cpus',
      '2',
      '--pids-limit',
      '768',
    ]);
  });
});

describe('Graphify container runtime contract', () => {
  it('test_graphify_runtime_args_are_universal_and_bounded', () => {
    const args = graphifyContainerArgs();

    expect(args).toEqual([
      '-e',
      'NANOCLAW_CONTAINER=1',
      '--tmpfs',
      '/workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001',
    ]);
    expect(args.filter((arg) => arg === 'NANOCLAW_CONTAINER=1')).toHaveLength(1);
    expect(args.filter((arg) => arg.startsWith('/workspace/.graphify-stage:'))).toHaveLength(1);
  });
});

describe('canonical workgroup memory mount', () => {
  it('resolves the trusted DB workgroup id to one provider-neutral canonical host path', () => {
    expect(resolveWorkgroupMemoryMount('wg-alpha', '/srv/nanoclaw/data')).toEqual({
      hostPath: '/srv/nanoclaw/data/workgroups/wg-alpha/memory',
      containerPath: '/workspace/workgroup/memory',
      readonly: false,
    });
  });

  it.each(['claude', 'codex', 'opencode'])(
    'maps the %s native loader to the same canonical host path read-only and after the RW neutral mount',
    (provider) => {
      const dataDir = '/srv/nanoclaw/data';
      const agentGroupId = 'ag-alpha';
      const workgroupId = 'wg-alpha';
      const nativeContainerPath = '/home/node/.claude/projects/-workspace-agent/memory';
      const claudeMounts = [
        {
          hostPath: `${dataDir}/v2-sessions/${agentGroupId}/.claude-shared`,
          containerPath: '/home/node/.claude',
          readonly: false,
        },
        {
          hostPath: '/srv/nanoclaw/container/skills',
          containerPath: '/home/node/.claude/skills',
          readonly: true,
        },
        {
          hostPath: `${dataDir}/v2-sessions/${agentGroupId}/session/.claude-projects/-workspace-agent`,
          containerPath: '/home/node/.claude/projects/-workspace-agent',
          readonly: false,
        },
        {
          hostPath: `${dataDir}/v2-sessions/${agentGroupId}/.claude-shared/projects/-workspace-agent/memory`,
          containerPath: nativeContainerPath,
          readonly: false,
        },
      ];

      const resolved = replaceClaudeNativeMemoryMount(claudeMounts, {
        provider,
        agentGroupId,
        workgroupId,
        dataDir,
      });
      const neutral = resolveWorkgroupMemoryMount(workgroupId, dataDir);
      const plan = [neutral, ...resolved];
      const native = plan.find((mount) => mount.containerPath === nativeContainerPath);

      expect(resolved.slice(0, -1)).toEqual(claudeMounts.slice(0, -1));
      expect(native).toEqual({
        hostPath: neutral.hostPath,
        containerPath: nativeContainerPath,
        readonly: true,
      });
      expect(plan.indexOf(neutral)).toBeLessThan(plan.indexOf(native!));
      expect(neutral.readonly).toBe(false);
    },
  );

  it('rejects a changed final Claude native-memory mount contract instead of suffix-matching it', () => {
    expect(() =>
      replaceClaudeNativeMemoryMount(
        [
          {
            hostPath: '/srv/nanoclaw/data/unrecognized/memory',
            containerPath: '/home/node/.claude/projects/-workspace-agent/memory',
            readonly: false,
          },
        ],
        {
          provider: 'claude',
          agentGroupId: 'ag-alpha',
          workgroupId: 'wg-alpha',
          dataDir: '/srv/nanoclaw/data',
        },
      ),
    ).toThrow(/exact final Claude native-memory mount contract/);
  });

  it('creates one host-shared lock sidecar beside the canon at mode 0600', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-lock-'));
    try {
      const mount = resolveWorkgroupMemoryLockMount('wg-alpha', dataDir);
      const expected = path.join(dataDir, 'workgroups', 'wg-alpha', '.memory-write.lock');

      expect(mount).toEqual({
        hostPath: expected,
        containerPath: '/workspace/workgroup/.memory-write.lock',
        readonly: false,
      });
      expect(WORKGROUP_MEMORY_LOCK_CONTAINER_PATH).toBe('/workspace/workgroup/.memory-write.lock');
      const stat = fs.lstatSync(expected);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an untrusted workgroup id before constructing the host lock path', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-lock-'));
    try {
      expect(() => resolveWorkgroupMemoryLockMount('../escape', dataDir)).toThrow(/Invalid workgroup id/);
      expect(fs.existsSync(path.join(dataDir, 'workgroups', 'escape', '.memory-write.lock'))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('is idempotent and never truncates an existing regular lock file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-lock-'));
    try {
      const first = resolveWorkgroupMemoryLockMount('wg-alpha', dataDir);
      fs.writeFileSync(first.hostPath, 'owner-metadata');
      const before = fs.lstatSync(first.hostPath);

      const second = resolveWorkgroupMemoryLockMount('wg-alpha', dataDir);
      const after = fs.lstatSync(second.hostPath);

      expect(second).toEqual(first);
      expect(fs.readFileSync(second.hostPath, 'utf8')).toBe('owner-metadata');
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['symlink', (lockPath: string) => fs.symlinkSync('/tmp', lockPath)],
    ['directory', (lockPath: string) => fs.mkdirSync(lockPath)],
  ])('fails closed when the existing lock path is a %s', (_kind, createInvalid) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-lock-'));
    try {
      const workgroupDir = path.join(dataDir, 'workgroups', 'wg-alpha');
      fs.mkdirSync(workgroupDir, { recursive: true });
      createInvalid(path.join(workgroupDir, '.memory-write.lock'));

      expect(() => resolveWorkgroupMemoryLockMount('wg-alpha', dataDir)).toThrow();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('memory admission budget', () => {
  it('test_memory_budget_defaults_to_80_percent_of_docker_visible_ram', () => {
    expect(resolveMemoryAdmissionBudgetMb(24 * 1024, '')).toBe(19_660);
  });

  it('test_memory_budget_accepts_explicit_docker_size_override', () => {
    expect(resolveMemoryAdmissionBudgetMb(24 * 1024, '18g')).toBe(18_432);
  });
});

describe('serializeMcpServersEnv', () => {
  it('serializes Datafold as native Streamable HTTP without the bridge', () => {
    const env = serializeMcpServersEnv({ datafold: DATAFOLD_MCP_SERVER });
    expect(env).not.toBeNull();
    expect(env).not.toContain('remote-mcp-bridge');

    const payload = env!.replace(/^NANOCLAW_MCP_SERVERS=/, '');
    const servers = JSON.parse(payload);
    expect(servers.datafold).toEqual({
      type: 'http',
      url: 'https://app.datafold.com/mcp/',
      headers: { Authorization: 'Key onecli-managed' },
    });
  });

  it('rejects deprecated SSE before serializing the container env var', () => {
    expect(() => serializeMcpServersEnv({ legacy: { type: 'sse', url: 'https://example.test/sse' } })).toThrow(
      /deprecated SSE transport/,
    );
  });
});

describe('resolveAnthropicAuth', () => {
  it('returns globals when no per-group token is set', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
      ANTHROPIC_API_KEY: 'global-key',
      ANTHROPIC_API_KEY_5: 'global-key-5',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'global-oauth-2' },
      { index: 3, value: 'global-oauth-3' },
    ]);
    expect(auth.apiKeyPrimary).toBe('global-key');
    expect(auth.apiKeyFallbacks).toEqual([{ index: 5, value: 'global-key-5' }]);
  });

  it('returns nothing when neither global nor per-group is set', () => {
    expect(resolveAnthropicAuth('madison-reed', {})).toEqual({
      oauthPrimary: undefined,
      oauthFallbacks: [],
      apiKeyPrimary: undefined,
      apiKeyFallbacks: [],
    });
  });

  it('per-group OAuth wins for the matching folder, ignoring globals entirely', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_3: 'mr-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('mr-oauth');
    // critical: no leakage from global rotation siblings into the workplace set
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'mr-oauth-2' },
      { index: 3, value: 'mr-oauth-3' },
    ]);
  });

  it('filters the OneCLI "placeholder" sentinel from globals', () => {
    // When the host service is wrapped in `onecli run --`, the wrapper
    // injects CLAUDE_CODE_OAUTH_TOKEN=placeholder as a sentinel that its
    // own proxy substitutes at request time. The literal string is never
    // a real bearer credential — forwarding it into a container that
    // takes the Claude Max OAuth-bypass path strips OneCLI's
    // container-side substitution and emits `401 Invalid bearer token`.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      ANTHROPIC_API_KEY: 'placeholder',
    };
    const auth = resolveAnthropicAuth('any-folder', env);
    // Placeholder filtered; nothing real to promote → both fully empty.
    expect(auth.oauthPrimary).toBeUndefined();
    expect(auth.apiKeyPrimary).toBeUndefined();
    expect(auth.oauthFallbacks).toEqual([]);
    expect(auth.apiKeyFallbacks).toEqual([]);
  });

  it('promotes first real fallback to primary when global slot is placeholder', () => {
    // Production layout when host service is wrapped in `onecli run --`:
    // the wrapper sets CLAUDE_CODE_OAUTH_TOKEN=placeholder; real values
    // for `_2`/`_3` come from .env. Without promotion, container-runner's
    // `if (hostOauth)` gate would skip forwarding the fallbacks entirely,
    // collapsing non-scoped groups' rotation pool to zero.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'real-rotation-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'real-rotation-3',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('real-rotation-2');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'real-rotation-3' }]);
  });

  it('recovers the real global primary from .env over promoting a fallback (incident 2026-06-25)', () => {
    // Production reality: OneCLI sets process.env CLAUDE_CODE_OAUTH_TOKEN=
    // placeholder, which dotenv-style loading does NOT override — so the real
    // primary in `.env` is shadowed and invisible in `env`. Passing the .env
    // file values lets us recover it as primary INSTEAD of promoting `_2`
    // (which had hit a monthly spend cap and broke the whole global pool).
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'capped-fallback-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'fallback-3',
    };
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN: 'real-working-primary' };
    const auth = resolveAnthropicAuth('illysium', env, envFile);
    expect(auth.oauthPrimary).toBe('real-working-primary');
    // Numbered fallbacks stay as fallbacks — NOT promoted.
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'capped-fallback-2' },
      { index: 3, value: 'fallback-3' },
    ]);
  });

  it('still promotes a fallback when .env has no real global primary either', () => {
    // Last-resort path preserved: if even the .env file lacks a real global
    // (only numbered siblings exist), promote the first so non-scoped groups
    // keep a rotation pool rather than collapsing to zero.
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'real-rotation-2',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'real-rotation-3',
    };
    const auth = resolveAnthropicAuth('illysium', env, { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' });
    expect(auth.oauthPrimary).toBe('real-rotation-2');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'real-rotation-3' }]);
  });

  it('placeholder in a scoped slot is also filtered', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_AXIE_DEV: 'placeholder',
    };
    const auth = resolveAnthropicAuth('axie-dev', env);
    // Scoped primary is sentinel → falls back to the global, which is real.
    expect(auth.oauthPrimary).toBe('global-oauth');
  });

  it('per-group token does not leak to other groups', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
    };
    const auth = resolveAnthropicAuth('illysium', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    // illysium must not see madison-reed siblings
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('orphan per-group fallbacks (no per-group primary) fall through to global', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-fallback-only',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('hyphens in folder name normalise to underscores', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
    };
    expect(resolveAnthropicAuth('madison-reed', env).oauthPrimary).toBe('mr-oauth');
    expect(resolveAnthropicAuth('Madison-Reed', env).oauthPrimary).toBe('mr-oauth');
  });

  it('digit-only folder name skips per-group resolution to avoid rotation collision', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      // ambiguous: is this folder=2 primary, or rotation slot _2? Treat as rotation.
      CLAUDE_CODE_OAUTH_TOKEN_2: 'ambiguous',
    };
    const auth = resolveAnthropicAuth('2', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 2, value: 'ambiguous' }]);
  });

  it('OAuth and API key scope independently', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      ANTHROPIC_API_KEY_MADISON_REED: 'mr-key',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.apiKeyPrimary).toBe('mr-key');
  });

  it('skips empty-string env values', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: '',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env);
    // empty per-group falls through to global
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'global-oauth-3' }]);
  });

  it('fallbacks return sorted by index ascending', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'g',
      CLAUDE_CODE_OAUTH_TOKEN_5: 'g5',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'g2',
      CLAUDE_CODE_OAUTH_TOKEN_10: 'g10',
    };
    const auth = resolveAnthropicAuth('any', env);
    expect(auth.oauthFallbacks.map((f) => f.index)).toEqual([2, 5, 10]);
  });

  // Disk (.env read fresh at spawn) supplements/overrides the host's stale
  // startup process.env snapshot. The host loads .env once at startup, so a
  // per-group token ADDED after that is absent from process.env — the
  // 2026-06-27 incident: madison-reed ran on the global pool for ~15h while
  // its scoped 3-account set sat in .env, unseen, and rotation had no healthy
  // fallback to reach.
  it('resolves a scoped set present only on disk, not yet in process.env (2026-06-27 incident)', () => {
    // process.env was snapshotted before the scoped tokens were added — only
    // the global token is present in the live host env.
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth' };
    const envFile = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_3: 'mr-oauth-3',
    };
    const auth = resolveAnthropicAuth('madison-reed', env, envFile);
    expect(auth.oauthPrimary).toBe('mr-oauth');
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'mr-oauth-2' },
      { index: 3, value: 'mr-oauth-3' },
    ]);
  });

  it('includes a scoped numbered sibling that exists only on disk', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'mr-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_2: 'mr-oauth-2',
    };
    // operator appended _3 to .env but hasn't restarted the host
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED_3: 'mr-oauth-3' };
    const auth = resolveAnthropicAuth('madison-reed', env, envFile);
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'mr-oauth-2' },
      { index: 3, value: 'mr-oauth-3' },
    ]);
  });

  it('disk value wins over a stale process.env value (token rotated in .env)', () => {
    // operator replaced a capped token in .env; process.env still holds the old
    // value from host startup. The container should spawn on the NEW token.
    const env = { CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'stale-old-token' };
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_MADISON_REED: 'fresh-new-token' };
    expect(resolveAnthropicAuth('madison-reed', env, envFile).oauthPrimary).toBe('fresh-new-token');
  });

  it('includes a global numbered fallback present only on disk', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth' };
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2' };
    const auth = resolveAnthropicAuth('any-folder', env, envFile);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 2, value: 'global-oauth-2' }]);
  });
});

describe('codex provider host auth', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-home-'));
  }

  function makeSessionDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-session-'));
  }

  function writeAuth(dir: string, value: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ account: value }));
  }

  function copiedAuth(sessionDir: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'codex', 'auth.json'), 'utf-8'));
  }

  it('copies scoped Codex auth for the agent group folder without DB lookup', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');
    writeAuth(path.join(home, '.codex-madison-reed-codex'), 'madison-reed');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    const contribution = fn!({
      sessionDir,
      agentGroupId: 'ag-does-not-match-folder',
      agentGroupFolder: 'madison-reed-codex',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'madison-reed' });
    expect(contribution.mounts?.[0]).toMatchObject({
      hostPath: path.join(sessionDir, 'codex'),
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  });

  it('falls back to global Codex auth when no scoped auth exists', () => {
    const home = makeHome();
    const sessionDir = makeSessionDir();
    writeAuth(path.join(home, '.codex'), 'global');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    fn!({
      sessionDir,
      agentGroupId: 'madison-reed-codex',
      agentGroupFolder: 'madison-reed-codex',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'global' });
  });
});

describe('resolveCodexAuthFallbacks', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-'));
  }

  function writeAuth(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  }

  it('returns [] when declarations is undefined or empty', () => {
    const home = makeHome();
    expect(resolveCodexAuthFallbacks(undefined, path.join(home, '.codex'), home)).toEqual([]);
    expect(resolveCodexAuthFallbacks([], path.join(home, '.codex'), home)).toEqual([]);
  });

  it('expands ~/ relative to provided homedir', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary is some scoped dir; fallback is the global ~/.codex
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toEqual([{ hostPath: path.join(home, '.codex'), containerPath: '/home/node/.codex-fallback-1' }]);
  });

  it('skips entries without an auth.json (no false-positive mounts)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // ~/.codex-missing has no auth.json — must be silently dropped
    const out = resolveCodexAuthFallbacks(['~/.codex-missing', '~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hostPath: path.join(home, '.codex'),
      containerPath: '/home/node/.codex-fallback-1',
    });
  });

  it('dedupes against the primary host path', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary IS ~/.codex, so the same path in fallbacks must be dropped
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex'), home);
    expect(out).toEqual([]);
  });

  it('dedupes within the declaration list (same path declared twice)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const out = resolveCodexAuthFallbacks(['~/.codex', '~/.codex'], path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0].containerPath).toBe('/home/node/.codex-fallback-1');
  });

  it('preserves declared order and numbers container paths starting at 1', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex-a'));
    writeAuth(path.join(home, '.codex-b'));
    writeAuth(path.join(home, '.codex-c'));
    const out = resolveCodexAuthFallbacks(
      ['~/.codex-b', '~/.codex-a', '~/.codex-c'],
      path.join(home, '.codex-mr'),
      home,
    );
    expect(out.map((e) => e.hostPath)).toEqual([
      path.join(home, '.codex-b'),
      path.join(home, '.codex-a'),
      path.join(home, '.codex-c'),
    ]);
    expect(out.map((e) => e.containerPath)).toEqual([
      '/home/node/.codex-fallback-1',
      '/home/node/.codex-fallback-2',
      '/home/node/.codex-fallback-3',
    ]);
  });

  it('ignores non-string and blank entries', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const messy = [null, '', '   ', '~/.codex'] as unknown as string[];
    const out = resolveCodexAuthFallbacks(messy, path.join(home, '.codex-mr'), home);
    expect(out).toHaveLength(1);
    expect(out[0].hostPath).toBe(path.join(home, '.codex'));
  });
});

describe('materializeCodexFallbackRuntime', () => {
  it('mounts only mutable auth and rollout state from the host home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-runtime-'));
    const hostHome = path.join(root, 'host-home');
    const runtimeHome = path.join(root, 'session', 'fallback-1');
    fs.mkdirSync(path.join(hostHome, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(hostHome, 'plugins', 'cache', 'stale-host-plugin'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, 'auth.json'), '{"token":"opaque"}');
    fs.writeFileSync(
      path.join(hostHome, 'config.toml'),
      '[plugins."stale@host"]\nenabled = true\n[features]\ncodex_hooks = true\n',
    );

    try {
      const mounts = materializeCodexFallbackRuntime(
        { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
        runtimeHome,
      );

      expect(mounts).toEqual([
        { hostPath: runtimeHome, containerPath: '/home/node/.codex-fallback-1', readonly: false },
        {
          hostPath: path.join(hostHome, 'auth.json'),
          containerPath: '/home/node/.codex-fallback-1/auth.json',
          readonly: false,
        },
        {
          hostPath: path.join(hostHome, 'sessions'),
          containerPath: '/home/node/.codex-fallback-1/sessions',
          readonly: false,
        },
      ]);
      expect(fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8')).toContain('[features]');
      expect(fs.existsSync(path.join(runtimeHome, 'auth.json'))).toBe(true);
      expect(mounts.some((mount) => mount.hostPath.includes('/plugins'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates first-use rollout persistence and replaces poisoned runtime entries without following them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-poisoned-'));
    const hostHome = path.join(root, 'host-home');
    const runtimeHome = path.join(root, 'session', 'fallback-1');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(path.join(outside, 'tmp', 'marketplaces'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, 'auth.json'), '{"token":"opaque"}');
    fs.writeFileSync(path.join(hostHome, 'config.toml'), 'model = "gpt-5.6-terra"\n');
    fs.writeFileSync(path.join(outside, 'config-victim'), 'keep');
    fs.writeFileSync(path.join(outside, 'auth-victim'), 'keep');
    fs.writeFileSync(path.join(outside, 'tmp', 'marketplaces', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'plugins', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(outside, 'sessions', 'sentinel'), 'keep');
    fs.symlinkSync(path.join(outside, 'tmp'), path.join(runtimeHome, '.tmp'), 'dir');
    fs.symlinkSync(path.join(outside, 'plugins'), path.join(runtimeHome, 'plugins'), 'dir');
    fs.symlinkSync(path.join(outside, 'config-victim'), path.join(runtimeHome, 'config.toml'));
    fs.symlinkSync(path.join(outside, 'auth-victim'), path.join(runtimeHome, 'auth.json'));
    fs.symlinkSync(path.join(outside, 'sessions'), path.join(runtimeHome, 'sessions'), 'dir');

    try {
      const mounts = materializeCodexFallbackRuntime(
        { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
        runtimeHome,
      );

      expect(fs.readFileSync(path.join(outside, 'config-victim'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'auth-victim'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'tmp', 'marketplaces', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'plugins', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(outside, 'sessions', 'sentinel'), 'utf8')).toBe('keep');
      expect(fs.lstatSync(path.join(runtimeHome, 'config.toml')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5.6-terra"\n');
      expect(fs.lstatSync(path.join(runtimeHome, 'auth.json')).isFile()).toBe(true);
      expect(fs.lstatSync(path.join(runtimeHome, 'sessions')).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(runtimeHome, '.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(runtimeHome, 'plugins'))).toBe(false);
      expect(fs.lstatSync(path.join(hostHome, 'sessions')).isDirectory()).toBe(true);
      expect(mounts).toContainEqual({
        hostPath: path.join(hostHome, 'sessions'),
        containerPath: '/home/node/.codex-fallback-1/sessions',
        readonly: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked runtime roots and fallback source entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-root-link-'));
    const hostHome = path.join(root, 'host-home');
    const outside = path.join(root, 'outside');
    const linkedRuntime = path.join(root, 'runtime-link');
    fs.mkdirSync(hostHome);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(hostHome, 'auth.json'), '{}');
    fs.symlinkSync(outside, linkedRuntime, 'dir');

    try {
      expect(() =>
        materializeCodexFallbackRuntime(
          { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
          linkedRuntime,
        ),
      ).toThrow(/Unsafe runtime directory/);

      fs.unlinkSync(linkedRuntime);
      fs.symlinkSync(outside, path.join(hostHome, 'sessions'), 'dir');
      expect(() =>
        materializeCodexFallbackRuntime(
          { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
          path.join(root, 'runtime'),
        ),
      ).toThrow(/Unsafe fallback sessions directory/);

      fs.unlinkSync(path.join(hostHome, 'sessions'));
      fs.symlinkSync(outside, path.join(hostHome, 'config.toml'), 'dir');
      expect(() =>
        materializeCodexFallbackRuntime(
          { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
          path.join(root, 'runtime'),
        ),
      ).toThrow(/Unsafe fallback config file/);

      fs.unlinkSync(path.join(hostHome, 'config.toml'));
      fs.unlinkSync(path.join(hostHome, 'auth.json'));
      fs.symlinkSync(outside, path.join(hostHome, 'auth.json'), 'dir');
      expect(() =>
        materializeCodexFallbackRuntime(
          { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
          path.join(root, 'runtime'),
        ),
      ).toThrow(/Unsafe fallback auth file/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codex provider primary auth refresh mount', () => {
  it('mounts the selected host Codex home separately when provider=codex owns /home/node/.codex', () => {
    const src = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf8');

    const hostPrimaryConstantIdx = src.indexOf("'/home/node/.codex-host-primary'");
    const providerMountIdx = src.indexOf('if (providerHasCodexMount');
    const authJsonIdx = src.indexOf("'auth.json'", providerMountIdx);
    const mountTargetIdx = src.indexOf('containerPath: CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH', authJsonIdx);
    const readOnlyIdx = src.indexOf('readonly: true', mountTargetIdx);
    const envIdx = src.indexOf('CODEX_PRIMARY_HOST_HOME=${CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH}');

    expect(hostPrimaryConstantIdx).toBeGreaterThan(-1);
    expect(providerMountIdx).toBeGreaterThan(-1);
    expect(authJsonIdx).toBeGreaterThan(providerMountIdx);
    expect(mountTargetIdx).toBeGreaterThan(authJsonIdx);
    expect(readOnlyIdx).toBeGreaterThan(mountTargetIdx);
    expect(envIdx).toBeGreaterThan(readOnlyIdx);
  });
});

describe('dependency-audit script mount', () => {
  // scripts/ is excluded from the /workspace/project allowlist, so nothing
  // mounted the audit script and the weekly update advisory died every week
  // with `Module not found "/workspace/project/scripts/container-updates.ts"`.
  // That literal now lives in three in-repo places (the mount, the slash-command
  // prompt, the precheck script) plus verbatim copies embedded in live
  // recurring-task rows in session inbound.dbs. Drift in any of them silently
  // breaks the advisory again, so pin them to one value here.
  const AUDIT_CONTAINER_PATH = '/workspace/project/scripts/container-updates.ts';

  it('mounts the audit script read-only at the path its callers invoke', () => {
    const src = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf8');
    const mountIdx = src.indexOf(`containerPath: '${AUDIT_CONTAINER_PATH}'`);
    const readOnlyIdx = src.indexOf('readonly: true', mountIdx);

    expect(mountIdx).toBeGreaterThan(-1);
    expect(readOnlyIdx).toBeGreaterThan(mountIdx);
  });

  it('keeps the slash-command prompt and precheck script on that same path', () => {
    const prompt = fs.readFileSync(new URL('./channels/discord-slash-commands.ts', import.meta.url), 'utf8');
    expect(prompt).toContain(AUDIT_CONTAINER_PATH);

    const precheck = fs.readFileSync(new URL('../scripts/container-updates-precheck.sh', import.meta.url), 'utf8');
    expect(precheck).toContain('NANOCLAW_PROJECT_ROOT:-/workspace/project');
    expect(precheck).toContain('$PROJECT_ROOT/scripts/container-updates.ts');
  });
});

// ── Workgroup reconciler tests (C1) ──────────────────────────────────────────

/** Create a minimal in-memory DB with the workgroup schema (migration 036). */
function makeWorkgroupDb(): Database.Database {
  const db = new BetterSQLite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);
  return db;
}

function insertGroup(db: Database.Database, id: string, folder: string, workgroupId?: string): void {
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(id, folder, folder, workgroupId ?? null);
}

function insertWorkgroup(db: Database.Database, id: string, onecliSecrets = '[]'): void {
  db.prepare(
    `INSERT INTO workgroups (id, display_name, onecli_secrets, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, id, onecliSecrets, new Date().toISOString());
}

describe('reconcileWorkgroupAtSpawn — C1', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeWorkgroupDb();
  });

  it('test_reconciler_creates_workgroup_and_updates_membership', () => {
    // Seed illie (parent) and illie-codex (sibling)
    insertGroup(db, 'ag-illie', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex');

    // Spawn illie-codex with workgroup_id pointing to the parent folder
    const agentGroup = { id: 'ag-illie-codex', folder: 'illysium-codex' };
    const containerConfig = { workgroup_id: 'illysium' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    const wg = db.prepare('SELECT id FROM workgroups WHERE id = ?').get('illysium') as { id: string };
    expect(wg).toBeDefined();
    expect(wg.id).toBe('illysium');

    // agent_groups.workgroup_id should be updated
    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-illie-codex') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('illysium');
  });

  it('test_reconciler_preserves_existing_workgroup_row', () => {
    // Pre-seed workgroup with operator-owned secret configuration.
    insertGroup(db, 'ag-illie', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex');
    insertWorkgroup(db, 'illysium', '["Shared-Secret"]');

    const agentGroup = { id: 'ag-illie-codex', folder: 'illysium-codex' };
    const containerConfig = { workgroup_id: 'illysium' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    const wg = db.prepare('SELECT onecli_secrets FROM workgroups WHERE id = ?').get('illysium') as {
      onecli_secrets: string;
    };
    expect(wg.onecli_secrets).toBe('["Shared-Secret"]');
  });

  it('test_reconciler_standalone_fallback_to_self', () => {
    // Standalone group — no parent, no sibling
    insertGroup(db, 'ag-solo', 'solo-agent');

    const agentGroup = { id: 'ag-solo', folder: 'solo-agent' };
    const containerConfig = {}; // no workgroup_id declared

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    const wg = db.prepare('SELECT id FROM workgroups WHERE id = ?').get('solo-agent') as { id: string };
    expect(wg).toBeDefined();
    expect(wg.id).toBe('solo-agent');

    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-solo') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('solo-agent');
  });

  it('test_reconciler_atomic_workgroup_id_update', () => {
    // Start with NULL workgroup_id; reconciler must set it
    insertGroup(db, 'ag-foo', 'foo');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-foo', folder: 'foo' }, {});

    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-foo') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('foo');
  });

  it('test_reconciler_returns_resolved_workgroup_id_for_threading', () => {
    // Contract: spawnContainer threads the resolved wgId from reconcile
    // through to buildMounts / buildArchiveProjection so they don't re-derive
    // (race-fix). The reconciler must return what it settled on.
    insertGroup(db, 'ag-illie-codex', 'illysium-codex');
    const result = reconcileWorkgroupAtSpawn(
      db,
      { id: 'ag-illie-codex', folder: 'illysium-codex' },
      { workgroup_id: 'illysium' },
    );
    expect(result.workgroupId).toBe('illysium');
  });

  it('test_reconciler_noop_when_unchanged', () => {
    // Pre-set workgroup_id correctly
    insertGroup(db, 'ag-bar', 'bar', 'bar');
    insertWorkgroup(db, 'bar');

    // Spy on prepare to check that UPDATE runs but updates 0 rows
    const before = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-bar') as {
      workgroup_id: string;
    };
    expect(before.workgroup_id).toBe('bar');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-bar', folder: 'bar' }, {});

    // workgroup_id unchanged after noop
    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-bar') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('bar');
  });
});

// ── reconcileWorkgroupAtSpawn — preserve migration 036 pairings ──────────────
// Codex P1 catch on PR #107 commit f166ae1: when container.json omits
// workgroup_id, the prior code defaulted to agentGroup.folder and overwrote
// the migration's pairing on first spawn. New behavior: preserve existing DB
// value when config is silent.

describe('reconcileWorkgroupAtSpawn — workgroup_id preservation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeWorkgroupDb();
  });

  it('test_preserves_migrated_workgroup_id_when_container_config_silent', () => {
    // Simulate post-migration-036 state for illie + illie-codex pair:
    // both agent_groups rows have workgroup_id='illysium' set by migration,
    // while existing container.json files did not declare workgroup_id.
    insertGroup(db, 'ag-illie', 'illysium', 'illysium');
    insertGroup(db, 'ag-illie-codex', 'illysium-codex', 'illysium');
    insertWorkgroup(db, 'illysium');

    // Spawn illie-codex with no workgroup_id in containerConfig — must preserve
    // the migrated pairing rather than overwriting to 'illysium-codex'.
    reconcileWorkgroupAtSpawn(db, { id: 'ag-illie-codex', folder: 'illysium-codex' }, {});

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-illie-codex') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('illysium'); // preserved, NOT overwritten to 'illysium-codex'

    const wg = db.prepare('SELECT id FROM workgroups WHERE id = ?').get('illysium') as { id: string };
    expect(wg.id).toBe('illysium');
  });

  it('test_explicit_config_workgroup_id_overrides_db_value', () => {
    // If container.json explicitly sets workgroup_id, operator intent wins
    // (e.g., operator moves a sibling to a different workgroup).
    insertGroup(db, 'ag-foo', 'foo', 'old-workgroup');

    reconcileWorkgroupAtSpawn(db, { id: 'ag-foo', folder: 'foo' }, { workgroup_id: 'new-workgroup' });

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-foo') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('new-workgroup'); // operator intent honored
  });

  it('test_defaults_to_own_folder_when_db_value_null', () => {
    // Fresh install: no migration ran, agent_groups.workgroup_id is NULL,
    // container.json silent → default to workgroup-of-1 (own folder).
    insertGroup(db, 'ag-fresh', 'fresh'); // no workgroup_id set

    reconcileWorkgroupAtSpawn(db, { id: 'ag-fresh', folder: 'fresh' }, {});

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-fresh') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('fresh'); // workgroup-of-1
  });
});

// ── Spawn merged-secrets tests (C3) ──────────────────────────────────────────
// These tests verify the merge logic by exercising mergeWorkgroupAndGroupSecrets
// (from onecli-secrets.ts) as it would be called from the spawn path.
// The full buildContainerArgs path uses live onecli shell calls — tested via
// the unit tests in onecli-secrets.test.ts instead.

describe('workgroup secrets merge at spawn (C3 contract verification)', () => {
  it('test_spawn_applies_merged_secrets — workgroup baseline union group additive', () => {
    // Directly verify the merge that buildContainerArgs performs:
    // workgroups.onecli_secrets ∪ containerConfig.onecliSecrets (additive, dedup)
    const workgroupSecrets = ['Anthropic', 'Exa'];
    const groupSecrets = ['Datafold-Illysium'];
    const merged = mergeWorkgroupAndGroupSecrets(workgroupSecrets, groupSecrets);

    expect(merged).toEqual(['Anthropic', 'Exa', 'Datafold-Illysium']);
  });

  it('dedup when group repeats workgroup secret', () => {
    const merged = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'NewSecret']);
    expect(merged).toEqual(['Anthropic', 'Exa', 'NewSecret']);
  });

  it('empty workgroup secrets passes through group secrets only', () => {
    const merged = mergeWorkgroupAndGroupSecrets([], ['Datafold-Illysium']);
    expect(merged).toEqual(['Datafold-Illysium']);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('Claude Bash timeout policy (structural)', () => {
  it('raises only the maximum Bash timeout for spawned containers', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain("args.push('-e', 'BASH_MAX_TIMEOUT_MS=3600000')");
    expect(src).not.toMatch(/args\.push\('-e', 'BASH_DEFAULT_TIMEOUT_MS=/);
  });
});
