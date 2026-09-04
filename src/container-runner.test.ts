import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

// Only the wake-admission block below needs this; nothing else in the file
// asserts on logs. The refusal's log line is the ONLY observable difference —
// an unguarded wakeContainer also resolves false here, by throwing on the
// uninitialized DB and being caught, so asserting the return value alone
// passes whether or not the guard exists.
vi.mock('./log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./log.js')>();
  return { ...actual, log: { ...actual.log, warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } };
});

// getMemoryAdmission() sizes its budget from a `docker info` probe at first
// use. That is a real daemon round-trip from a unit test — the hermeticity
// tripwire flags it — so point the runtime binary at a name that does not
// exist: the probe fails instantly into its documented os.totalmem() fallback,
// and nothing leaves the process. Everything else in container-runtime is real.
vi.mock('./container-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-runtime.js')>();
  return { ...actual, CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN };
});

// The memory-admission controller is stubbed so the queue can be driven
// deterministically. The real controller's budget is a module-level singleton
// derived from Docker-visible RAM at first use — unreachable from a unit test,
// and host-dependent — so exhausting it for real is not an option. Everything
// AROUND the controller stays real: the queued payload, releaseMemoryReservation
// and its drain, and the startReservedWake continuation are the code under test.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');

// Holds the wake at its FIRST await — background storage admission — so a test
// can act on a session while it is genuinely in flight. `null` means the real
// pass-through, which is what every other case in this file gets.
const storageGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));

vi.mock('./storage-maintenance-worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage-maintenance-worker.js')>();
  return {
    ...actual,
    assertStorageAdmissionInBackground: async () => {
      if (storageGate.hold) await storageGate.hold;
      // `allowed` short-circuits before anything reads the report.
      return { allowed: true } as Awaited<
        ReturnType<typeof import('./storage-maintenance-worker.js').assertStorageAdmissionInBackground>
      >;
    },
  };
});

const memoryStub = vi.hoisted(() => ({
  queueNext: new Set<string>(),
  queuedPayloads: [] as unknown[],
  requestedIds: [] as string[],
  releasedIds: [] as string[],
  cancelledIds: [] as string[],
  reset() {
    this.queueNext.clear();
    this.queuedPayloads = [];
    this.requestedIds = [];
    this.releasedIds = [];
    this.cancelledIds = [];
  },
}));

vi.mock('./memory-admission.js', () => {
  class StubMemoryAdmissionController<T> {
    readonly budgetMb: number;
    constructor(budgetMb: number) {
      this.budgetMb = budgetMb;
    }
    get reservedMb(): number {
      return 0;
    }
    get queuedCount(): number {
      return memoryStub.queuedPayloads.length;
    }
    isQueued(id: string): boolean {
      return memoryStub.queueNext.has(id);
    }
    hasReservation(): boolean {
      return false;
    }
    request(id: string, requestMb: number, payload: T): MemoryAdmissionResult {
      memoryStub.requestedIds.push(id);
      if (memoryStub.queueNext.has(id)) {
        memoryStub.queuedPayloads.push(payload);
        return { status: 'queued', budgetMb: this.budgetMb, requestMb, position: memoryStub.queuedPayloads.length };
      }
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }
    release(id: string): T[] {
      memoryStub.releasedIds.push(id);
      const drained = memoryStub.queuedPayloads as T[];
      memoryStub.queuedPayloads = [];
      return drained;
    }
    cancel(id: string): T[] {
      memoryStub.cancelledIds.push(id);
      // The real controller drops the QUEUED entry as well as the reservation.
      // Modelling that is the whole point here: a stub that aliased cancel to
      // release would pass whether or not the code under test cancels.
      memoryStub.queueNext.delete(id);
      memoryStub.queuedPayloads = memoryStub.queuedPayloads.filter(
        (payload) => (payload as { session: { id: string } }).session.id !== id,
      );
      return [];
    }
    shutdown(): void {
      memoryStub.queuedPayloads = [];
    }
  }
  return {
    MemoryAdmissionController:
      StubMemoryAdmissionController as unknown as typeof import('./memory-admission.js').MemoryAdmissionController,
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import {
  DATAFOLD_MCP_SERVER,
  dockerResourceLimitArgs,
  securityArgs,
  resolveMemoryAdmissionBudgetMb,
  serializeMcpServersEnv,
  resolveAnthropicAuth,
  resolveCodexAuthFallbacks,
  materializeCodexFallbackRuntime,
  resolveProviderName,
  channelInstructionsMounts,
  resolveAtlassianMcpServer,
  resolveWorkgroupMemoryLockMount,
  resolveWorkgroupMemoryMount,
  WORKGROUP_MEMORY_LOCK_CONTAINER_PATH,
  replaceClaudeNativeMemoryMount,
  reconcileWorkgroupAtSpawn,
  isContainerSpawnWorkgroupAllowed,
  persistResolvedWorkgroupAtSpawn,
  resolveWorkgroupIdAtSpawn,
  stripEnvEntry,
  wakeContainer,
  killContainer,
  sessionStillActive,
  isContainerRunning,
  isContainerSpawning,
} from './container-runner.js';
import { formatMemoryMb, resolveContainerResources } from './container-resources.js';
import { mergeWorkgroupAndGroupSecrets } from './onecli-secrets.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';
import { log } from './log.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';
import type { Session } from './types.js';

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

describe('operator canary workgroup spawn fence', () => {
  it('admits every workgroup when the fence is absent', () => {
    expect(isContainerSpawnWorkgroupAllowed('workgroup-b', undefined)).toBe(true);
  });

  it('admits only exact trimmed workgroup ids when the fence is present', () => {
    const allowlist = 'workgroup-b, workgroup-a,legacy-canary';
    expect(isContainerSpawnWorkgroupAllowed('workgroup-b', allowlist)).toBe(true);
    expect(isContainerSpawnWorkgroupAllowed('workgroup-a', allowlist)).toBe(true);
    expect(isContainerSpawnWorkgroupAllowed('legacy-canary', allowlist)).toBe(true);
    expect(isContainerSpawnWorkgroupAllowed('madison', allowlist)).toBe(false);
    expect(isContainerSpawnWorkgroupAllowed('other', allowlist)).toBe(false);
  });

  it('fails closed when the operator explicitly supplies an empty fence', () => {
    expect(isContainerSpawnWorkgroupAllowed('workgroup-a', '')).toBe(false);
    expect(isContainerSpawnWorkgroupAllowed('workgroup-a', ' , ')).toBe(false);
  });

  it('uses container.json identity ahead of a stale DB workgroup', () => {
    const db = new BetterSQLite3(':memory:');
    try {
      db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, workgroup_id TEXT)');
      db.prepare('INSERT INTO agent_groups (id, workgroup_id) VALUES (?, ?)').run('ag-a', 'workgroup-a');
      const resolved = resolveWorkgroupIdAtSpawn(
        db,
        { id: 'ag-a', folder: 'agent-a' },
        { workgroup_id: 'workgroup-b' },
      );
      expect(resolved).toBe('workgroup-b');
      expect(isContainerSpawnWorkgroupAllowed(resolved, 'workgroup-a')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('uses the DB workgroup when container.json is silent', () => {
    const db = new BetterSQLite3(':memory:');
    try {
      db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, workgroup_id TEXT)');
      db.prepare('INSERT INTO agent_groups (id, workgroup_id) VALUES (?, ?)').run('ag-a', 'workgroup-a');
      expect(resolveWorkgroupIdAtSpawn(db, { id: 'ag-a', folder: 'agent-a' }, {})).toBe('workgroup-a');
    } finally {
      db.close();
    }
  });

  it('persists the fenced identity even if the DB changes after admission', () => {
    const db = new BetterSQLite3(':memory:');
    try {
      db.exec(`
        CREATE TABLE workgroups (
          id TEXT PRIMARY KEY,
          display_name TEXT,
          onecli_secrets TEXT,
          created_at TEXT
        );
        CREATE TABLE agent_groups (id TEXT PRIMARY KEY, workgroup_id TEXT);
      `);
      db.prepare('INSERT INTO agent_groups (id, workgroup_id) VALUES (?, ?)').run('ag-a', 'workgroup-a');
      const agentGroup = { id: 'ag-a', folder: 'agent-a' };
      const admitted = resolveWorkgroupIdAtSpawn(db, agentGroup, {});
      expect(isContainerSpawnWorkgroupAllowed(admitted, 'workgroup-a')).toBe(true);

      db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run('workgroup-b', 'ag-a');
      expect(persistResolvedWorkgroupAtSpawn(db, agentGroup, admitted)).toEqual({ workgroupId: 'workgroup-a' });
      expect(db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').pluck().get('ag-a')).toBe('workgroup-a');
    } finally {
      db.close();
    }
  });
});

describe('resolveAtlassianMcpServer', () => {
  it('builds the Jira and Confluence stdio config from a valid tenant root', () => {
    expect(resolveAtlassianMcpServer('https://example.atlassian.net/')).toEqual({
      type: 'stdio',
      command: 'mcp-atlassian',
      args: [],
      env: {
        JIRA_URL: 'https://example.atlassian.net',
        JIRA_USERNAME: 'onecli-managed',
        JIRA_API_TOKEN: 'onecli-managed',
        CONFLUENCE_URL: 'https://example.atlassian.net/wiki',
        CONFLUENCE_USERNAME: 'onecli-managed',
        CONFLUENCE_API_TOKEN: 'onecli-managed',
      },
    });
  });

  it.each([
    undefined,
    'not a url',
    'http://example.atlassian.net',
    'https://example.com',
    'https://example.atlassian.net/jira',
  ])('fails closed for missing or invalid tenant roots: %s', (value) => {
    expect(resolveAtlassianMcpServer(value)).toBeNull();
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
    if (configured.cpuShares !== undefined) expected.push('--cpu-shares', String(configured.cpuShares));
    expected.push('--pids-limit', String(configured.pidsLimit));

    expect(dockerResourceLimitArgs()).toEqual(expected);
  });

  it('test_docker_resource_args_apply_group_override_once', () => {
    const args = dockerResourceLimitArgs({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      cpuShares: 2048,
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
      '--cpu-shares',
      '2048',
      '--pids-limit',
      '768',
    ]);
  });

  it('test_docker_resource_args_omit_cpu_shares_when_unset', () => {
    const args = dockerResourceLimitArgs({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });

    expect(args).not.toContain('--cpu-shares');
    expect(args.slice(args.indexOf('--cpus'))).toEqual(['--cpus', '2', '--pids-limit', '768']);
  });
});

describe('securityArgs', () => {
  it('emits safe privilege defaults when no override is given', () => {
    const args = securityArgs(undefined);
    expect(args).toEqual(['--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL']);
  });

  it('honors a capAdd override', () => {
    expect(securityArgs({ capAdd: ['SYS_ADMIN'] }).join(' ')).toContain('--cap-add SYS_ADMIN');
  });

  it('honors a narrowed capDrop override', () => {
    const args = securityArgs({ capDrop: ['NET_RAW', 'SYS_PTRACE'] });
    expect(args.join(' ')).toContain('--cap-drop NET_RAW --cap-drop SYS_PTRACE');
    expect(args.join(' ')).not.toContain('--cap-drop ALL');
  });

  it('drops no-new-privileges when explicitly disabled', () => {
    expect(securityArgs({ noNewPrivileges: false }).join(' ')).not.toContain('no-new-privileges');
  });

  // Resource ceilings are dockerResourceLimitArgs' job. If securityArgs ever
  // starts emitting one too, a spawn gets two contradictory values for the
  // same Docker flag — this is the guard against that regression.
  it('never emits a resource-ceiling flag', () => {
    const joined = securityArgs({ capAdd: ['SYS_ADMIN'] }).join(' ');
    expect(joined).not.toContain('--pids-limit');
    expect(joined).not.toContain('--memory');
    expect(joined).not.toContain('--cpus');
  });
});

describe('pids-limit is never emitted as 0', () => {
  // cgroups v2 rejects `--pids-limit 0` and the spawn dies. Upstream guards
  // this by omitting the flag; this install guards it earlier, by refusing a
  // non-positive pidsLimit at config-resolution time. Either way the flag must
  // never reach docker with a 0.
  it('rejects a declared pidsLimit of 0 rather than emitting the flag', () => {
    expect(() => dockerResourceLimitArgs({ pidsLimit: 0 })).toThrow(/positive integer/);
  });

  it('rejects a negative pidsLimit', () => {
    expect(() => dockerResourceLimitArgs({ pidsLimit: -1 })).toThrow(/positive integer/);
  });

  it('emits a positive pids-limit unchanged', () => {
    expect(dockerResourceLimitArgs({ pidsLimit: 768 }).join(' ')).toContain('--pids-limit 768');
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
    expect(auth.oauthScoped).toBe(false);
  });

  it('returns nothing when neither global nor per-group is set', () => {
    expect(resolveAnthropicAuth('example-retail', {})).toEqual({
      oauthPrimary: undefined,
      oauthFallbacks: [],
      apiKeyPrimary: undefined,
      apiKeyFallbacks: [],
      oauthScoped: false,
    });
  });

  it('per-group OAuth wins for the matching folder, ignoring globals entirely', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'retail-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_2: 'retail-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_3: 'retail-oauth-3',
    };
    const auth = resolveAnthropicAuth('example-retail', env);
    expect(auth.oauthPrimary).toBe('retail-oauth');
    // critical: no leakage from global rotation siblings into the workplace set
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'retail-oauth-2' },
      { index: 3, value: 'retail-oauth-3' },
    ]);
    // Slots are forwarded under unscoped `_N` names, so this flag is the only
    // signal that this group's slot 2 is a different account from global _2.
    expect(auth.oauthScoped).toBe(true);
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
    const auth = resolveAnthropicAuth('example-labs', env);
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
    const auth = resolveAnthropicAuth('example-labs', env, envFile);
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
    const auth = resolveAnthropicAuth('example-labs', env, { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' });
    expect(auth.oauthPrimary).toBe('real-rotation-2');
    expect(auth.oauthFallbacks).toEqual([{ index: 3, value: 'real-rotation-3' }]);
  });

  it('placeholder in a scoped slot is also filtered', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_DEV: 'placeholder',
    };
    const auth = resolveAnthropicAuth('example-dev', env);
    // Scoped primary is sentinel → falls back to the global, which is real.
    expect(auth.oauthPrimary).toBe('global-oauth');
  });

  it('per-group token does not leak to other groups', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'retail-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_2: 'retail-oauth-2',
    };
    const auth = resolveAnthropicAuth('example-labs', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    // example-labs must not see example-retail siblings
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('orphan per-group fallbacks (no per-group primary) fall through to global', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_2: 'retail-fallback-only',
    };
    const auth = resolveAnthropicAuth('example-retail', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([]);
  });

  it('hyphens in folder name normalise to underscores', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'retail-oauth',
    };
    expect(resolveAnthropicAuth('example-retail', env).oauthPrimary).toBe('retail-oauth');
    expect(resolveAnthropicAuth('example-retail', env).oauthPrimary).toBe('retail-oauth');
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
      ANTHROPIC_API_KEY_EXAMPLE_RETAIL: 'retail-key',
    };
    const auth = resolveAnthropicAuth('example-retail', env);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.apiKeyPrimary).toBe('retail-key');
  });

  it('skips empty-string env values', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: '',
      CLAUDE_CODE_OAUTH_TOKEN_3: 'global-oauth-3',
    };
    const auth = resolveAnthropicAuth('example-retail', env);
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
  // 2026-06-27 incident: example-retail ran on the global pool for ~15h while
  // its scoped 3-account set sat in .env, unseen, and rotation had no healthy
  // fallback to reach.
  it('resolves a scoped set present only on disk, not yet in process.env (2026-06-27 incident)', () => {
    // process.env was snapshotted before the scoped tokens were added — only
    // the global token is present in the live host env.
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth' };
    const envFile = {
      CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'retail-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_2: 'retail-oauth-2',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_3: 'retail-oauth-3',
    };
    const auth = resolveAnthropicAuth('example-retail', env, envFile);
    expect(auth.oauthPrimary).toBe('retail-oauth');
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'retail-oauth-2' },
      { index: 3, value: 'retail-oauth-3' },
    ]);
  });

  it('includes a scoped numbered sibling that exists only on disk', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'retail-oauth',
      CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_2: 'retail-oauth-2',
    };
    // operator appended _3 to .env but hasn't restarted the host
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL_3: 'retail-oauth-3' };
    const auth = resolveAnthropicAuth('example-retail', env, envFile);
    expect(auth.oauthFallbacks).toEqual([
      { index: 2, value: 'retail-oauth-2' },
      { index: 3, value: 'retail-oauth-3' },
    ]);
  });

  it('disk value wins over a stale process.env value (token rotated in .env)', () => {
    // operator replaced a capped token in .env; process.env still holds the old
    // value from host startup. The container should spawn on the NEW token.
    const env = { CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'stale-old-token' };
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_EXAMPLE_RETAIL: 'fresh-new-token' };
    expect(resolveAnthropicAuth('example-retail', env, envFile).oauthPrimary).toBe('fresh-new-token');
  });

  it('includes a global numbered fallback present only on disk', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'global-oauth' };
    const envFile = { CLAUDE_CODE_OAUTH_TOKEN_2: 'global-oauth-2' };
    const auth = resolveAnthropicAuth('any-folder', env, envFile);
    expect(auth.oauthPrimary).toBe('global-oauth');
    expect(auth.oauthFallbacks).toEqual([{ index: 2, value: 'global-oauth-2' }]);
  });
});

describe('stripEnvEntry', () => {
  it('removes every matching -e pair when no value filter is given', () => {
    const args = ['-e', 'FOO=a', '-e', 'BAR=b', '-e', 'FOO=c'];
    stripEnvEntry(args, 'FOO');
    expect(args).toEqual(['-e', 'BAR=b']);
  });

  it('with onlyValue, drops the placeholder but keeps a real key', () => {
    // The OAuth-bypass path strips OneCLI's ANTHROPIC_API_KEY=placeholder so
    // the literal sentinel never reaches api.anthropic.com as a bearer, while
    // a real operator-forwarded key must survive.
    const args = ['-e', 'ANTHROPIC_API_KEY=placeholder', '-e', 'ANTHROPIC_API_KEY=sk-real'];
    stripEnvEntry(args, 'ANTHROPIC_API_KEY', 'placeholder');
    expect(args).toEqual(['-e', 'ANTHROPIC_API_KEY=sk-real']);
  });

  it('does not match keys that merely share a prefix', () => {
    const args = ['-e', 'ANTHROPIC_API_KEY_2=x', '-e', 'ANTHROPIC_API_KEY=placeholder'];
    stripEnvEntry(args, 'ANTHROPIC_API_KEY', 'placeholder');
    expect(args).toEqual(['-e', 'ANTHROPIC_API_KEY_2=x']);
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
    writeAuth(path.join(home, '.codex-example-retail-codex'), 'example-retail');

    const fn = getProviderContainerConfig('codex');
    expect(fn).toBeDefined();
    const contribution = fn!({
      sessionDir,
      agentGroupId: 'ag-does-not-match-folder',
      agentGroupFolder: 'example-retail-codex',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: { HOME: home } as NodeJS.ProcessEnv,
    });

    expect(copiedAuth(sessionDir)).toEqual({ account: 'example-retail' });
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
      agentGroupId: 'example-retail-codex',
      agentGroupFolder: 'example-retail-codex',
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
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex-retail'), home);
    expect(out).toEqual([{ hostPath: path.join(home, '.codex'), containerPath: '/home/node/.codex-fallback-1' }]);
  });

  it('skips entries without an auth.json (no false-positive mounts)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // ~/.codex-missing has no auth.json — must be silently dropped
    const out = resolveCodexAuthFallbacks(['~/.codex-missing', '~/.codex'], path.join(home, '.codex-retail'), home);
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
    const out = resolveCodexAuthFallbacks(['~/.codex', '~/.codex'], path.join(home, '.codex-retail'), home);
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
      path.join(home, '.codex-retail'),
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
    const out = resolveCodexAuthFallbacks(messy, path.join(home, '.codex-retail'), home);
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
      const generated = fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8');
      expect(generated).toContain('[features]');
      expect(generated).toContain('[features.multi_agent_v2]');
      // Host config never reaches the runtime home — generated base only.
      expect(generated).not.toContain('stale@host');
      expect(generated).not.toContain('codex_hooks');
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
      // The host home's config (with its model pin) must not leak; the runtime
      // gets the generated container base instead.
      const rewritten = fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8');
      expect(rewritten).not.toContain('gpt-5.6-terra');
      expect(rewritten).toContain('sandbox_mode = "workspace-write"');
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
      fs.mkdirSync(path.join(hostHome, 'sessions'));
      fs.symlinkSync(outside, path.join(hostHome, 'config.toml'), 'dir');
      // Host config.toml is never read anymore (generated base instead), so a
      // symlinked host config is inert rather than an error.
      const mounts = materializeCodexFallbackRuntime(
        { hostPath: hostHome, containerPath: '/home/node/.codex-fallback-1' },
        path.join(root, 'runtime'),
      );
      expect(mounts.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(root, 'runtime', 'config.toml'), 'utf8')).toContain('sandbox_mode');

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
    // Seed helper (parent) and helper-codex (sibling)
    insertGroup(db, 'ag-helper', 'example-labs');
    insertGroup(db, 'ag-helper-codex', 'example-labs-codex');

    // Spawn helper-codex with workgroup_id pointing to the parent folder
    const agentGroup = { id: 'ag-helper-codex', folder: 'example-labs-codex' };
    const containerConfig = { workgroup_id: 'example-labs' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    const wg = db.prepare('SELECT id FROM workgroups WHERE id = ?').get('example-labs') as { id: string };
    expect(wg).toBeDefined();
    expect(wg.id).toBe('example-labs');

    // agent_groups.workgroup_id should be updated
    const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-helper-codex') as {
      workgroup_id: string;
    };
    expect(ag.workgroup_id).toBe('example-labs');
  });

  it('test_reconciler_preserves_existing_workgroup_row', () => {
    // Pre-seed workgroup with operator-owned secret configuration.
    insertGroup(db, 'ag-helper', 'example-labs');
    insertGroup(db, 'ag-helper-codex', 'example-labs-codex');
    insertWorkgroup(db, 'example-labs', '["Shared-Secret"]');

    const agentGroup = { id: 'ag-helper-codex', folder: 'example-labs-codex' };
    const containerConfig = { workgroup_id: 'example-labs' };

    reconcileWorkgroupAtSpawn(db, agentGroup, containerConfig);

    const wg = db.prepare('SELECT onecli_secrets FROM workgroups WHERE id = ?').get('example-labs') as {
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
    insertGroup(db, 'ag-helper-codex', 'example-labs-codex');
    const result = reconcileWorkgroupAtSpawn(
      db,
      { id: 'ag-helper-codex', folder: 'example-labs-codex' },
      { workgroup_id: 'example-labs' },
    );
    expect(result.workgroupId).toBe('example-labs');
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
    // Simulate post-migration-036 state for helper + helper-codex pair:
    // both agent_groups rows have workgroup_id='example-labs' set by migration,
    // while existing container.json files did not declare workgroup_id.
    insertGroup(db, 'ag-helper', 'example-labs', 'example-labs');
    insertGroup(db, 'ag-helper-codex', 'example-labs-codex', 'example-labs');
    insertWorkgroup(db, 'example-labs');

    // Spawn helper-codex with no workgroup_id in containerConfig — must preserve
    // the migrated pairing rather than overwriting to 'example-labs-codex'.
    reconcileWorkgroupAtSpawn(db, { id: 'ag-helper-codex', folder: 'example-labs-codex' }, {});

    const after = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get('ag-helper-codex') as {
      workgroup_id: string;
    };
    expect(after.workgroup_id).toBe('example-labs'); // preserved, NOT overwritten to 'example-labs-codex'

    const wg = db.prepare('SELECT id FROM workgroups WHERE id = ?').get('example-labs') as { id: string };
    expect(wg.id).toBe('example-labs');
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
    const groupSecrets = ['Datafold-Example Labs'];
    const merged = mergeWorkgroupAndGroupSecrets(workgroupSecrets, groupSecrets);

    expect(merged).toEqual(['Anthropic', 'Exa', 'Datafold-Example Labs']);
  });

  it('dedup when group repeats workgroup secret', () => {
    const merged = mergeWorkgroupAndGroupSecrets(['Anthropic', 'Exa'], ['Anthropic', 'NewSecret']);
    expect(merged).toEqual(['Anthropic', 'Exa', 'NewSecret']);
  });

  it('empty workgroup secrets passes through group secrets only', () => {
    const merged = mergeWorkgroupAndGroupSecrets([], ['Datafold-Example Labs']);
    expect(merged).toEqual(['Datafold-Example Labs']);
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

describe('pnpm store-dir pinning (structural)', () => {
  it('pins the store to the group mount unconditionally, ahead of the opencode-only block', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const storeDirLine = "args.push('-e', 'npm_config_store_dir=/workspace/agent/.pnpm-store')";
    const storeDirLinePnpm = "args.push('-e', 'pnpm_config_store_dir=/workspace/agent/.pnpm-store')";
    expect(src).toContain(storeDirLine);
    expect(src).toContain(storeDirLinePnpm);

    // Not nested inside `if (provider === 'opencode') {' — it must apply to
    // every provider, so it has to appear before that gate in source order.
    const opencodeGateIdx = src.indexOf("if (provider === 'opencode')");
    expect(src.indexOf(storeDirLine)).toBeGreaterThan(-1);
    expect(src.indexOf(storeDirLine)).toBeLessThan(opencodeGateIdx);
  });
});

// The one guard that covers every by-id wake caller at once. It sits above any
// DB or Docker work in wakeContainer, so it is reachable without a host.
describe('wakeContainer session-status admission', () => {
  function session(status: 'active' | 'closed' | 'archiving'): Session {
    return {
      id: `sess-${status}`,
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status,
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-08-19T00:00:00.000Z',
    };
  }

  function refusals(): string[] {
    return vi
      .mocked(log.warn)
      .mock.calls.filter((call) => String(call[0]).includes('Container wake refused'))
      .map((call) => (call[1] as { status: string }).status);
  }

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
  });

  it('refuses a closed session — the archived-session zombie', async () => {
    await expect(wakeContainer(session('closed'))).resolves.toBe(false);
    expect(refusals()).toEqual(['closed']);
  });

  it('refuses a session mid-archival', async () => {
    await expect(wakeContainer(session('archiving'))).resolves.toBe(false);
    expect(refusals()).toEqual(['archiving']);
  });

  // Explicit timeout, unlike its siblings. Every other case in this block is
  // refused AT the guard and returns in microseconds; this one is the only
  // case that goes through it, so it runs the real admission path until
  // something downstream refuses it for want of a host DB. That path is
  // ~100ms on an idle machine and occasionally blew past the 5s default on a
  // loaded Actions runner, producing a red CI on unrelated PRs — observed on
  // `main` as well as on feature branches, always as a timeout and never as a
  // failed assertion. The generous budget keeps a genuine hang detectable
  // while removing the contention flake.
  it('lets an active session through the guard to the normal admission path', async () => {
    // Keep this guard test independent of the host's current disk pressure;
    // otherwise a full filesystem sends it into the real cleanup worker.
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    try {
      await expect(wakeContainer(session('active'))).resolves.toBe(false);
      // Refused for a real reason (no host DB in a unit test), not by the guard.
      expect(refusals()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);
});

// The guard above runs on the object the CALLER handed us, and the wake path
// then awaits — storage admission, an unbounded wait in the memory-admission
// queue, the storage-activity lease. A reclaim closes the session row inside any
// of those windows, and spawning on a closed row produces a container
// getActiveSessions() will never return. These cover the re-reads that follow
// each await; the DB row, not the caller's snapshot, is the authority.
describe('wakeContainer re-reads the session after every admission await', () => {
  const AGENT_GROUP_ID = 'ag-wake-admission';
  // Deliberately a folder that does not exist under groups/: readContainerConfig
  // returns the empty config for it (no disk fixture, no spawn side effects),
  // while the strict spawn-fence read fails on it — which is how the trigger
  // session below reaches releaseMemoryReservation without touching Docker.
  const AGENT_GROUP_FOLDER = '__wake-admission-test__';

  function seedSession(id: string, status: string): void {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                               container_status, last_active, created_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, 'stopped', NULL, '2026-08-19T00:00:00.000Z')`,
      )
      .run(id, AGENT_GROUP_ID, status);
  }

  function archive(id: string): void {
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(id);
  }

  /** What the caller still believes: an active session, by id. */
  function callerSnapshot(id: string): Session {
    return {
      id,
      agent_group_id: AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-08-19T00:00:00.000Z',
    };
  }

  function abandons(): Array<{ sessionId: string; stage: string; status: string }> {
    return vi
      .mocked(log.warn)
      .mock.calls.filter((call) => String(call[0]).startsWith('Container wake abandoned'))
      .map((call) => {
        const meta = call[1] as { sessionId: string; stage: string; status: string };
        return { sessionId: meta.sessionId, stage: meta.stage, status: meta.status };
      });
  }

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    memoryStub.reset();
    initTestDb();
    getDb().exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT,
        messaging_group_id TEXT,
        thread_id TEXT,
        agent_provider TEXT,
        status TEXT,
        container_status TEXT,
        last_active TEXT,
        created_at TEXT
      );
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT,
        folder TEXT,
        agent_provider TEXT,
        workgroup_id TEXT
      );
    `);
    getDb()
      .prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id) VALUES (?, ?, ?, NULL, ?)')
      .run(AGENT_GROUP_ID, 'wake admission', AGENT_GROUP_FOLDER, 'wg-wake-admission');
    // Keep these independent of the host's real disk pressure; otherwise a full
    // filesystem sends them into the real cleanup worker.
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    // The mocked runtime binary above does not exist, so this permits a call
    // that resolves to ENOENT — nothing actually escapes the process.
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    memoryStub.reset();
    closeDb();
  });

  it('does not spawn a session that was archived while storage admission was awaited', async () => {
    seedSession('sess-storage', 'active');
    // The reclaim lands while checkStorageAdmission is in flight: the caller's
    // object still says active, the row does not.
    archive('sess-storage');

    await expect(wakeContainer(callerSnapshot('sess-storage'))).resolves.toBe(false);

    expect(abandons()).toEqual([{ sessionId: 'sess-storage', stage: 'storage-admission', status: 'closed' }]);
    // Never reached memory admission, so it never reached the spawn either.
    expect(memoryStub.requestedIds).not.toContain('sess-storage');
    expect(memoryStub.releasedIds).toEqual([]);
  });

  it('does not spawn a session that was archived while it sat in the memory-admission queue', async () => {
    seedSession('sess-queued', 'active');
    seedSession('sess-trigger', 'active');

    memoryStub.queueNext.add('sess-queued');
    await expect(wakeContainer(callerSnapshot('sess-queued'))).resolves.toBe(false);
    // Queued holding no reservation, on the row as it looked when it queued.
    expect(memoryStub.queuedPayloads).toHaveLength(1);
    // The queue carries the session AND the caller's guard, so a wake that
    // waits an arbitrarily long time resumes with its precondition intact.
    expect((memoryStub.queuedPayloads[0] as { session: Session }).session.status).toBe('active');

    // The wait in the queue is unbounded; the reclaim lands inside it.
    archive('sess-queued');
    vi.mocked(log.warn).mockClear();

    // Any release drains the queue and hands the payload to startReservedWake.
    // This one fails its authoritative spawn-config read, which is an existing
    // release path — no Docker, no disk fixture.
    vi.stubEnv('NANOCLAW_CONTAINER_SPAWN_WORKGROUP_ALLOWLIST', '');
    await expect(wakeContainer(callerSnapshot('sess-trigger'))).resolves.toBe(false);
    await Promise.resolve();

    // Caught at the dequeue, before the queued session spends its slot — not
    // later, at the pre-spawn re-read.
    expect(abandons()).toEqual([{ sessionId: 'sess-queued', stage: 'memory-admission-dequeue', status: 'closed' }]);
    // And the reservation it was just admitted into is handed back, not leaked.
    expect(memoryStub.releasedIds).toEqual(['sess-trigger', 'sess-queued']);
  });
});

/**
 * `killContainer` has to mean something for a session that is SPAWNING.
 *
 * `containerOwnsOutbound` is deliberately true for one — a wake issued a moment
 * ago is about to hold the file — so every caller that asks "is anyone there?"
 * before killing gets `true`, calls `killContainer`, and used to get silence:
 * the process was not yet in `activeContainers`, so the call returned without
 * killing anything and without firing `onExit`. The container then came up and
 * kept running. A confirmed thread close left the fresh container alive, a
 * self-mod rebuild left the old image running, a provider self-heal never
 * respawned on the fallback.
 */
describe('killContainer against a session that is still spawning', () => {
  const AGENT_GROUP_ID = 'ag-kill-spawning';
  const AGENT_GROUP_FOLDER = '__kill-spawning-test__';

  function seedSession(id: string): void {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                               container_status, last_active, created_at)
         VALUES (?, ?, NULL, NULL, NULL, 'active', 'stopped', NULL, '2026-08-19T00:00:00.000Z')`,
      )
      .run(id, AGENT_GROUP_ID);
  }

  function callerSnapshot(id: string): Session {
    return {
      id,
      agent_group_id: AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-08-19T00:00:00.000Z',
    };
  }

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    memoryStub.reset();
    initTestDb();
    getDb().exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT,
        agent_provider TEXT, status TEXT, container_status TEXT, last_active TEXT, created_at TEXT,
        archived_at TEXT
      );
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT, folder TEXT, agent_provider TEXT, workgroup_id TEXT
      );
    `);
    getDb()
      .prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id) VALUES (?, ?, ?, NULL, ?)')
      .run(AGENT_GROUP_ID, 'kill spawning', AGENT_GROUP_FOLDER, 'wg-kill-spawning');
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(() => {
    storageGate.hold = null;
    vi.unstubAllEnvs();
    memoryStub.reset();
    closeDb();
  });

  it('fires onExit exactly once and leaves no container running', async () => {
    seedSession('sess-spawning');
    let release!: () => void;
    storageGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wake = wakeContainer(callerSnapshot('sess-spawning'));
    // Parked on the storage-admission await: in flight by the host's own
    // predicate, which is exactly what every caller consults before killing.
    await Promise.resolve();
    expect(isContainerSpawning('sess-spawning')).toBe(true);
    expect(isContainerRunning('sess-spawning')).toBe(false);

    const exits: string[] = [];
    killContainer('sess-spawning', 'test kill during spawn', () => exits.push('exit'));
    // Nothing fires yet — the wake is still running, and firing here would
    // report an exit for a container that may still be about to appear.
    expect(exits).toEqual([]);

    release();
    await expect(wake).resolves.toBe(false);
    await Promise.resolve();

    // The guarantee: the caller's exit-driven work ran, exactly once, and no
    // container survived the request.
    expect(exits).toEqual(['exit']);
    // Aborted AT the cancellation point, not merely swept up by the settle
    // path afterwards: the wake failure carries the cancellation itself.
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => String(call[0]).startsWith('wakeContainer failed'))
        .map((call) => String((call[1] as { err?: unknown }).err)),
    ).toEqual(['Error: Container spawn cancelled by a kill request: test kill during spawn']);
    expect(isContainerRunning('sess-spawning')).toBe(false);
    expect(isContainerSpawning('sess-spawning')).toBe(false);
  });

  it('records the kill as deferred rather than silently dropping it', async () => {
    seedSession('sess-deferred');
    let release!: () => void;
    storageGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wake = wakeContainer(callerSnapshot('sess-deferred'));
    await Promise.resolve();
    killContainer('sess-deferred', 'thread close', () => {});
    release();
    await wake;

    // The operator-visible trace that the request was taken, not ignored.
    expect(
      vi
        .mocked(log.info)
        .mock.calls.filter((call) => String(call[0]).startsWith('Container kill deferred'))
        .map((call) => call[1] as { sessionId: string; reason: string }),
    ).toEqual([{ sessionId: 'sess-deferred', reason: 'thread close' }]);
  });

  /**
   * The wake path's own guard.
   *
   * A caller proving its precondition and THEN calling `wakeContainer` proves it
   * before storage admission, before an unbounded wait in the memory queue, and
   * before all of `spawnContainer`'s preparation. The guard is asked where the
   * process is created instead, and again at the dequeue, so a wake that queues
   * for minutes cannot resume on a precondition nobody has re-asked.
   */
  it('refuses the spawn when the caller guard fails, without leaving a container', async () => {
    seedSession('sess-guarded');

    const asked: number[] = [];
    await expect(
      wakeContainer(callerSnapshot('sess-guarded'), 'interactive', {
        guard: () => {
          asked.push(1);
          return { ok: false, reason: 'thread was closed while this wake queued' };
        },
      }),
    ).resolves.toBe(false);

    // Asked at least once, and no container survived the refusal.
    expect(asked.length).toBeGreaterThan(0);
    expect(isContainerRunning('sess-guarded')).toBe(false);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => String(call[0]).startsWith('wakeContainer failed'))
        .map((call) => String((call[1] as { err?: unknown }).err)),
    ).toEqual(['Error: Container spawn refused by its guard: thread was closed while this wake queued']);
  });

  it('carries the guard through the memory queue and asks it again at the dequeue', async () => {
    seedSession('sess-queued-guard');
    seedSession('sess-releaser');

    const state = { wanted: true };
    memoryStub.queueNext.add('sess-queued-guard');
    await expect(
      wakeContainer(callerSnapshot('sess-queued-guard'), 'interactive', {
        guard: () => (state.wanted ? true : { ok: false, reason: 'no longer wanted' }),
      }),
    ).resolves.toBe(false);
    expect(memoryStub.queuedPayloads).toHaveLength(1);

    // The wait in the queue is unbounded; the caller's reason to wake expires
    // inside it. Nothing re-reads the session row here — it is still active —
    // so only the caller's own guard can see this.
    state.wanted = false;
    vi.mocked(log.warn).mockClear();

    // Any release drains the queue and resumes the queued wake.
    await expect(wakeContainer(callerSnapshot('sess-releaser'))).resolves.toBe(false);
    await Promise.resolve();

    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => String(call[0]).startsWith('Queued container wake refused'))
        .map((call) => call[1] as { sessionId: string; reason: string }),
    ).toEqual([{ sessionId: 'sess-queued-guard', reason: 'no longer wanted' }]);
    // And the reservation it was admitted into is handed back, not leaked.
    expect(memoryStub.releasedIds).toContain('sess-queued-guard');
  });

  /**
   * A queued wake outlives the promise that created it.
   *
   * `wakeContainer` returns false when memory admission queues, `trackWake`
   * settles, and the controller still holds the payload until some later
   * release drains it. So "no container running, and the wake promise is
   * finished" is NOT "this session has no container coming" — and the kill
   * settle used to treat it as such, firing the caller's exit work. Thread-close
   * then clears and archives the session as final, a later release drains the
   * queue, and a container spawns into a thread the operator was told was
   * closed. `sessionStillActive` does not catch it either: `archiveSessionById`
   * sets only `archived_at`, so the row is still `active`.
   */
  it('cancels a queued wake before reporting the exit, so nothing spawns later', async () => {
    seedSession('sess-queued-kill');
    let release!: () => void;
    storageGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The wake will QUEUE rather than spawn once it gets past admission.
    memoryStub.queueNext.add('sess-queued-kill');

    const wake = wakeContainer(callerSnapshot('sess-queued-kill'));
    await Promise.resolve();
    const exits: string[] = [];
    killContainer('sess-queued-kill', 'thread close', () => exits.push('exit'));

    release();
    await expect(wake).resolves.toBe(false);
    await Promise.resolve();

    // The exit was reported, AND the controller no longer holds the wake — so
    // the next reservation release has nothing to drain into this session.
    expect(exits).toEqual(['exit']);
    expect(memoryStub.cancelledIds).toContain('sess-queued-kill');
    expect(memoryStub.queuedPayloads).toEqual([]);
  });

  /**
   * `archived_at` is a second axis, not a shade of `status`.
   *
   * `archiveSessionById` stamps `archived_at` and leaves `status` alone, so a
   * thread-close that archives without closing leaves a row still reading
   * `active`. A guard that asked only about `status` waved a wake straight into
   * a thread the operator had been told was finished — and the archive-only
   * close is the ordinary case, not an edge one.
   */
  it('refuses a session that is archived even though its status is still active', () => {
    seedSession('sess-archived');
    getDb()
      .prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
      .run('2026-09-04T00:00:00.000Z', 'sess-archived');

    // The precondition that makes this case worth having: the row still says
    // `active`, so `status` alone cannot answer.
    expect(
      (getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('sess-archived') as { status: string }).status,
    ).toBe('active');

    expect(sessionStillActive('sess-archived')()).toEqual({ ok: false, reason: 'session is archived' });
  });

  it('admits a live session that has never been archived', () => {
    seedSession('sess-live');
    expect(sessionStillActive('sess-live')()).toBe(true);
  });

  /**
   * A guard that THROWS is a refusal, and must release like one.
   *
   * `sessionStillActive` reads the central DB, and a DB read can throw —
   * transient I/O, corruption, a closed handle. Propagating that from the
   * dequeue took it out through `trackWake`'s generic catch, which resolves
   * `false` and never releases the reservation the dequeue is holding: every
   * RETURNED refusal on that path released, a thrown one leaked a slot off the
   * admission budget permanently.
   */
  it('treats a guard that throws at the dequeue as a refusal, and returns the slot', async () => {
    seedSession('sess-throw-queued');
    seedSession('sess-throw-releaser');

    let explode = false;
    memoryStub.queueNext.add('sess-throw-queued');
    await expect(
      wakeContainer(callerSnapshot('sess-throw-queued'), 'interactive', {
        guard: () => {
          if (explode) throw new Error('database is locked');
          return true;
        },
      }),
    ).resolves.toBe(false);
    expect(memoryStub.queuedPayloads).toHaveLength(1);

    // The central DB starts failing while the wake sits in the queue.
    explode = true;
    vi.mocked(log.warn).mockClear();

    // Any release drains the queue and resumes the queued wake, whose guard
    // now throws instead of answering.
    await expect(wakeContainer(callerSnapshot('sess-throw-releaser'))).resolves.toBe(false);
    await Promise.resolve();

    // Refused with the throw as its reason, and — the part that leaked — the
    // reservation handed back rather than stranded.
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => String(call[0]).startsWith('Queued container wake refused'))
        .map((call) => (call[1] as { reason: string }).reason),
    ).toEqual(['guard threw: database is locked']);
    expect(memoryStub.releasedIds).toContain('sess-throw-queued');
    expect(isContainerRunning('sess-throw-queued')).toBe(false);
  });

  /**
   * An UNGUARDED wake must be refused for an archived session too.
   *
   * Most callers pass no guard — over twenty `wakeContainer` call sites hand in
   * a session and nothing else, `applySpawnComplete` among them. The opt-in
   * guard cannot help those; the universal re-read every wake passes through is
   * the only place that can, and it asked about `status` alone. A thread-close
   * that archives without closing leaves the row reading `active`, so an
   * unguarded wake launched a container for a thread the operator was told was
   * finished.
   */
  it('refuses an unguarded wake for an archived session whose status is still active', async () => {
    seedSession('sess-unguarded-archived');
    getDb()
      .prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
      .run('2026-09-04T00:00:00.000Z', 'sess-unguarded-archived');

    // No guard, exactly as those callers wake.
    await expect(wakeContainer(callerSnapshot('sess-unguarded-archived'))).resolves.toBe(false);

    expect(isContainerRunning('sess-unguarded-archived')).toBe(false);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => String(call[0]).includes('cannot take a wake'))
        .map((call) => (call[1] as { reason: string }).reason),
    ).toContain('session is archived');
  });

  it('still does nothing for a session that is neither running nor spawning', async () => {
    seedSession('sess-idle');
    const exits: string[] = [];

    killContainer('sess-idle', 'nothing to kill', () => exits.push('exit'));

    // Unchanged contract, and callers depend on it: `container-restart` reads
    // "not running" as "this restart did not happen", not as an exit.
    expect(exits).toEqual([]);
  });
});

// ── OAuth lane forwarding ────────────────────────────────────────────────────
// buildContainerArgs cannot be executed here (it makes live onecli shell
// calls), so this guards the forward at the source level instead.
//
// Why it needs a guard at all: the container reads CLAUDE_CODE_OAUTH_LANES
// from its OWN env (laneForSlot in providers/claude.ts), and there is no
// generic env passthrough into containers — the only one is prefix-limited to
// RENDER_PG_/RENDER_REDIS_URL_. Without an explicit `-e` push the variable is
// undefined in every container and `lane` is NULL forever, with nothing
// thrown, nothing logged, and every suite still green. That silence is
// precisely why the guard exists: no other test would ever notice.
describe('CLAUDE_CODE_OAUTH_LANES reaches the container', () => {
  // Comments are stripped before matching. Both the forward and the block
  // comment explaining it name the variable, so a naive source match passes
  // against a build with the forward deleted — a false-passing guard is worse
  // than none, because it reports the thing it fails to check.
  const source = fs
    .readFileSync(path.join(import.meta.dirname, 'container-runner.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('pushes an -e forward for the lane declaration', () => {
    expect(source).toMatch(/args\.push\(\s*'-e',\s*`CLAUDE_CODE_OAUTH_LANES=/);
  });

  it('reads the value from the host process env', () => {
    expect(source).toMatch(/process\.env\.CLAUDE_CODE_OAUTH_LANES/);
  });

  it('forwards only when declared, so an install that never sets it sends nothing', () => {
    // An unconditional push would send `CLAUDE_CODE_OAUTH_LANES=undefined`,
    // which laneForSlot would then have to defend against.
    expect(source).toMatch(/if\s*\(\s*oauthLanes\s*\)\s*args\.push/);
  });
});

// ── OAuth scope declaration ──────────────────────────────────────────────────
// Same source-level guard, same reason it is needed, different silence.
//
// When the CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN it has no stored
// credential to read scopes from, so it synthesises one and defaults its
// scopes to ["user:inference"]. Plan utilization is gated behind
// `user:profile`: with the default the CLI answers `rate_limits_available:
// false` and never attempts the lookup, so every usage_pull sample lands with
// a NULL utilization and nothing anywhere reports an error. Verified against
// the shipped CLI binary and reproduced end to end — same token, same proxy,
// scopes undeclared -> no windows, declared -> five_hour + seven_day.
describe('CLAUDE_CODE_OAUTH_SCOPES reaches the container', () => {
  const source = fs
    .readFileSync(path.join(import.meta.dirname, 'container-runner.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('declares user:profile alongside user:inference on the forwarded token', () => {
    // Both scopes matter: `user:inference` gates ii(), `user:profile` gates
    // the utilization read. Dropping either puts the pull back to silent.
    expect(source).toMatch(/args\.push\(\s*'-e',\s*'CLAUDE_CODE_OAUTH_SCOPES=user:inference user:profile'/);
  });

  it('declares them only where a host OAuth token is forwarded', () => {
    // Under API-key / Bedrock / Vertex auth there is no OAuth token for the
    // scopes to describe, and claiming scopes for one would be a lie.
    const oauthBlock = source.slice(source.indexOf('if (hostOauth) {'));
    expect(oauthBlock.indexOf('CLAUDE_CODE_OAUTH_SCOPES')).toBeGreaterThan(-1);
    expect(oauthBlock.indexOf('CLAUDE_CODE_OAUTH_SCOPES')).toBeLessThan(oauthBlock.indexOf('const ghToken'));
  });
});

// ── Per-channel instructions profile ─────────────────────────────────────────

describe('channelInstructionsMounts', () => {
  let root: string;
  let groupDir: string;
  let siblingDir: string;
  let outsideDir: string;
  let allowed: (target: string) => boolean;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-chan-instr-')));
    groupDir = path.join(root, 'groups', 'beta-codex');
    siblingDir = path.join(root, 'groups', 'alpha');
    outsideDir = path.join(root, 'elsewhere');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    // The overlay allowlist as buildMounts computes it: own group dir plus
    // every workgroup sibling's. Nothing else.
    const roots = [groupDir, siblingDir];
    allowed = (target) => roots.some((r) => target === r || target.startsWith(r + path.sep));
    vi.mocked(log.warn).mockClear();
  });

  it('returns nothing when the group has no channel-instructions directory', () => {
    expect(channelInstructionsMounts(groupDir, allowed, 'ag-1')).toEqual([]);
  });

  it('binds each profile read-only at its own container path', () => {
    const dir = path.join(groupDir, 'channel-instructions');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'lab.md'), 'lab rules');
    fs.writeFileSync(path.join(dir, 'support.md'), 'support rules');

    const mounts = channelInstructionsMounts(groupDir, allowed, 'ag-1');
    expect(mounts).toEqual([
      { hostPath: path.join(dir, 'lab.md'), containerPath: '/workspace/channel-instructions/lab.md', readonly: true },
      {
        hostPath: path.join(dir, 'support.md'),
        containerPath: '/workspace/channel-instructions/support.md',
        readonly: true,
      },
    ]);
  });

  it('ignores non-markdown entries and subdirectories', () => {
    const dir = path.join(groupDir, 'channel-instructions');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'lab.md'), 'lab rules');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a profile');
    fs.mkdirSync(path.join(dir, 'archive.md'));

    const mounts = channelInstructionsMounts(groupDir, allowed, 'ag-1');
    expect(mounts.map((m) => m.containerPath)).toEqual(['/workspace/channel-instructions/lab.md']);
  });

  it('resolves a per-file symlink to a workgroup sibling — the sharing case', () => {
    // the owning group holds the file; the codex and opencode siblings link to it, so a
    // rule edit lands once. The bind must point at the REAL file: a symlink
    // relative to the container mount point resolves somewhere else entirely
    // and would dangle.
    const sibDir = path.join(siblingDir, 'channel-instructions');
    fs.mkdirSync(sibDir);
    fs.writeFileSync(path.join(sibDir, 'lab.md'), 'lab rules');

    const dir = path.join(groupDir, 'channel-instructions');
    fs.mkdirSync(dir);
    fs.symlinkSync('../../alpha/channel-instructions/lab.md', path.join(dir, 'lab.md'));

    const mounts = channelInstructionsMounts(groupDir, allowed, 'ag-1');
    expect(mounts).toEqual([
      {
        hostPath: path.join(sibDir, 'lab.md'),
        containerPath: '/workspace/channel-instructions/lab.md',
        readonly: true,
      },
    ]);
  });

  it('resolves a directory-level symlink to a workgroup sibling', () => {
    const sibDir = path.join(siblingDir, 'channel-instructions');
    fs.mkdirSync(sibDir);
    fs.writeFileSync(path.join(sibDir, 'lab.md'), 'lab rules');
    fs.symlinkSync('../alpha/channel-instructions', path.join(groupDir, 'channel-instructions'));

    const mounts = channelInstructionsMounts(groupDir, allowed, 'ag-1');
    expect(mounts).toEqual([
      {
        hostPath: path.join(sibDir, 'lab.md'),
        containerPath: '/workspace/channel-instructions/lab.md',
        readonly: true,
      },
    ]);
  });

  it('refuses a file symlink escaping the workgroup, and says so', () => {
    // The group dir is mounted RW, so this is a path an agent can actually
    // create. Binding it would put arbitrary host content into that agent's
    // own always-on prompt.
    fs.writeFileSync(path.join(outsideDir, 'secrets.md'), 'other tenant');
    const dir = path.join(groupDir, 'channel-instructions');
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(outsideDir, 'secrets.md'), path.join(dir, 'lab.md'));

    expect(channelInstructionsMounts(groupDir, allowed, 'ag-1')).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Refusing channel-instructions file outside workgroup boundary',
      expect.objectContaining({ agentGroupId: 'ag-1' }),
    );
  });

  it('refuses a directory symlink escaping the workgroup, and binds none of it', () => {
    fs.mkdirSync(path.join(outsideDir, 'channel-instructions'));
    fs.writeFileSync(path.join(outsideDir, 'channel-instructions', 'lab.md'), 'other tenant');
    fs.symlinkSync(path.join(outsideDir, 'channel-instructions'), path.join(groupDir, 'channel-instructions'));

    expect(channelInstructionsMounts(groupDir, allowed, 'ag-1')).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Refusing channel-instructions mount outside workgroup boundary',
      expect.objectContaining({ agentGroupId: 'ag-1' }),
    );
  });

  it('skips a dangling link without failing the spawn', () => {
    const dir = path.join(groupDir, 'channel-instructions');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'lab.md'), 'lab rules');
    fs.symlinkSync('../../alpha/channel-instructions/gone.md', path.join(dir, 'gone.md'));

    const mounts = channelInstructionsMounts(groupDir, allowed, 'ag-1');
    expect(mounts.map((m) => m.containerPath)).toEqual(['/workspace/channel-instructions/lab.md']);
  });
});

// buildContainerArgs makes live onecli shell calls and cannot be executed
// here, so the forward is guarded at the source level — the same shape used
// for CLAUDE_CODE_OAUTH_LANES above, and for the same reason: nothing else in
// the suite would notice the variable going missing. A wiring would just stop
// having channel rules, silently, with the agent still answering.
describe('NANOCLAW_INSTRUCTIONS_PROFILE reaches the container', () => {
  const source = fs
    .readFileSync(path.join(import.meta.dirname, 'container-runner.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('reads the profile off the wiring row next to the tone', () => {
    expect(source).toMatch(/channelInstructionsProfile = wiring\.instructions_profile/);
  });

  it('pushes an -e forward for the profile name', () => {
    expect(source).toMatch(/args\.push\(\s*'-e',\s*`NANOCLAW_INSTRUCTIONS_PROFILE=/);
  });

  it('forwards only when the wiring sets one', () => {
    // An unconditional push would send the literal string "null" and the
    // runner would warn about a missing profile on every spawn of every
    // channel that never wanted one.
    expect(source).toMatch(/if\s*\(\s*instructionsProfile\s*\)\s*\{?\s*args\.push/);
  });

  it('has no container.json fallback — per-wiring or nothing', () => {
    // Tone falls through to containerConfig.tone. Instructions deliberately
    // do not: the group-wide equivalent is standing-instructions.md, and a
    // second group-level slot here would only be a way for the two to
    // disagree.
    expect(source).toMatch(/const instructionsProfile = channelDefaults\?\.channelInstructionsProfile \?\? null;/);
  });
});
