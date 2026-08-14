import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-surfaces-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-surfaces-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-surfaces-test/groups',
  WORKGROUP_SHARED_FS: false,
}));

vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./db/messaging-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/messaging-groups.js')>();
  return {
    ...actual,
    getMessagingGroup: (id: string) =>
      id === 'mg-shared'
        ? { id, channel_type: 'slack-test', platform_id: 'slack:C1', thread_policy: 'native' }
        : actual.getMessagingGroup(id),
  };
});

import { buildMounts } from './container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import { PERSONA_PREPEND_FILE, readGroupPersona } from './group-persona.js';
import {
  getProviderContainerConfig,
  registerProviderContainerConfig,
  type ProviderContainerContribution,
} from './providers/provider-container-registry.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

// A provider that declares (at registration) that it owns its agent surfaces.
// Registered once — the registry is module-global and rejects duplicates.
registerProviderContainerConfig('surfaces-test-provider', () => ({}), { providesAgentSurfaces: true });

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string): Session {
  return { id, agent_group_id: agentGroupId } as Session;
}

// Production sets workgroup_id via reconcileWorkgroupAtSpawn before buildMounts
// runs; buildMounts fail-closes (W3) on a NULL workgroup_id. Give the test group
// a workgroup-of-1 (folder as its own workgroup) so the archive projection resolves.
function withWorkgroup(ag: AgentGroup): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, '[]', ?, datetime('now'))`,
  ).run(ag.folder, ag.folder, ag.id);
  db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(ag.folder, ag.id);
}

function assignWorkgroup(ag: AgentGroup, workgroupId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, '[]', ?, datetime('now'))`,
  ).run(workgroupId, workgroupId, ag.id);
  db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, ag.id);
}

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

function providerContribution(provider: string, ag: AgentGroup, sess: Session): ProviderContainerContribution {
  const factory = getProviderContainerConfig(provider);
  return (
    factory?.({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, sess.id),
      agentGroupId: ag.id,
      agentGroupFolder: ag.folder,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: [],
      hostEnv: { HOME: path.join(TEST_ROOT, 'home') },
    }) ?? {}
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('container instruction contracts', () => {
  it('routes Claude and OpenCode through the current seven-skill workflow', () => {
    const retiredRoutes = ['/team-brief', '/team-design', '/team-qa'];
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');
    expect(instructions).toContain('start with `/team-plan`');
    expect(instructions).toContain('/team-build');
    expect(instructions).toContain('/team-review --implementation');
    expect(instructions).toContain('/team-auto');
    expect(instructions).toContain('/team-ship');
    for (const retired of retiredRoutes) expect(instructions).not.toContain(retired);
  });

  it('keeps nested-container Codex delegation on the supported foreground transport', () => {
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');
    expect(instructions).toContain('codex exec --yolo');
    expect(instructions).toContain('`timeout` to `3600000`');
    expect(instructions).not.toContain('`timeout` to `600000`');
    expect(instructions).not.toContain('team-qa/team-review');
  });
});

describe('initGroupFilesystem agent surfaces', () => {
  it('preserves local instructions and stages default Claude support files', () => {
    const ag = group('ag-default', 'default-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('hello\n');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('');
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')) as {
      autoMemoryEnabled?: boolean;
      env: Record<string, string>;
      hooks: Record<string, unknown>;
    };
    expect(settings.env.BASH_MAX_TIMEOUT_MS).toBe('3600000');
    expect(settings.env).not.toHaveProperty('BASH_DEFAULT_TIMEOUT_MS');
    expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(true);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.PreToolUse).toBeUndefined();

    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    buildMounts(ag, session('s-default-instructions', ag.id), containerConfig(), 'claude', {});
    expect(fs.readFileSync(path.join(groupDir, '.claude-fragments', 'persona.md'), 'utf-8')).toBe('hello');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toContain('@./.claude-fragments/persona.md');
  });

  it('reconciles the managed Bash maximum while preserving an operator-owned default', () => {
    const ag = group('ag-bash-timeout', 'bash-timeout-group');
    createAgentGroup(ag);
    initGroupFilesystem(ag, {});

    const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { env: Record<string, string> };
    settings.env.BASH_MAX_TIMEOUT_MS = '600000';
    settings.env.BASH_DEFAULT_TIMEOUT_MS = '45000';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

    initGroupFilesystem(ag, {});

    const reconciled = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { env: Record<string, string> };
    expect(reconciled.env.BASH_MAX_TIMEOUT_MS).toBe('3600000');
    expect(reconciled.env.BASH_DEFAULT_TIMEOUT_MS).toBe('45000');
  });

  it('stages instructions outside memory for a provider with its own surfaces and is idempotent', () => {
    const ag = group('ag-surfy', 'surfy-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });
    initGroupFilesystem(ag, { instructions: 'replacement', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    const canonicalMemory = path.join(DATA_DIR, 'workgroups', ag.folder, 'memory');
    const compatibilityLink = path.join(groupDir, 'memory');
    expect(fs.existsSync(groupDir)).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('hello\n');
    expect(readGroupPersona(groupDir)).toBe('hello');
    expect(fs.existsSync(path.join(canonicalMemory, 'memories', 'imported-agent-memory.md'))).toBe(false);
    expect(fs.lstatSync(compatibilityLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(compatibilityLink)).toBe('/workspace/workgroup/memory');
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
  });

  it('treats an unregistered provider name as default support files without creating memory', () => {
    const ag = group('ag-unknown', 'unknown-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'not-registered' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });
});

describe('initGroupFilesystem legacy seed isolation', () => {
  it('never reads, transforms, or deletes .seed.md', () => {
    const ag = group('ag-seed', 'seed-group');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const seedFile = path.join(groupDir, '.seed.md');
    const seedBytes = Buffer.from('seeded identity\r\n  trailing bytes \n');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(seedFile, seedBytes);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      initGroupFilesystem(ag, {});
      initGroupFilesystem(ag, {});
      expect(readSpy.mock.calls.some(([target]) => path.resolve(String(target)) === seedFile)).toBe(false);
    } finally {
      readSpy.mockRestore();
    }

    expect(fs.readFileSync(seedFile)).toEqual(seedBytes);
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('');
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });

  it('does not overwrite existing nonempty instruction surfaces', () => {
    const ag = group('ag-existing-instructions', 'existing-instructions-group');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'operator persona\n');
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'operator local\n');

    initGroupFilesystem(ag, { instructions: 'replacement' });
    initGroupFilesystem(ag, { instructions: 'another replacement' });

    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('operator persona\n');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('operator local\n');
  });
});

describe('buildMounts agent surfaces', () => {
  it('canonical-working-tree-is-not-container-accessible', () => {
    const workgroupId = 'wg-repositories';
    const ag = group('ag-repositories', 'repositories-agent');
    createAgentGroup(ag);
    assignWorkgroup(ag, workgroupId);
    ensureContainerConfig(ag.id);
    initGroupFilesystem({ ...ag, workgroup_id: workgroupId }, { provider: 'claude' });

    const canonical = path.join(DATA_DIR, 'repositories', workgroupId, 'proj');
    fs.mkdirSync(canonical, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: canonical });
    const state = path.join(DATA_DIR, 'repository-state', workgroupId, 'proj');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, 'origin.json'),
      JSON.stringify({ origin: 'https://github.com/acme/proj.git', repositoryId: 'github.com/acme/proj' }),
    );

    const siblingA = {
      ...session('s-repo-a', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:171234.567',
    } as Session;
    const siblingB = {
      ...session('s-repo-b', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:171234.567',
    } as Session;
    const otherTopic = {
      ...session('s-repo-other', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:999999.000',
    } as Session;

    const a = buildMounts(ag, siblingA, containerConfig(), 'claude', {}, workgroupId);
    const b = buildMounts(ag, siblingB, containerConfig(), 'claude', {}, workgroupId);
    const other = buildMounts(ag, otherTopic, containerConfig(), 'claude', {}, workgroupId);
    const stableA = a.find((mount) => mount.containerPath === '/workspace/worktrees');
    const stableB = b.find((mount) => mount.containerPath === '/workspace/worktrees');
    const stableOther = other.find((mount) => mount.containerPath === '/workspace/worktrees');

    expect(stableA?.hostPath).toBe(stableB?.hostPath);
    expect(stableOther?.hostPath).not.toBe(stableA?.hostPath);
    expect(a).toContainEqual({ hostPath: stableA?.hostPath, containerPath: stableA?.hostPath, readonly: false });
    expect(a).toContainEqual({
      hostPath: path.join(canonical, '.git'),
      containerPath: path.join(canonical, '.git'),
      readonly: false,
    });
    expect(a).toContainEqual({
      hostPath: path.join(canonical, '.git', 'HEAD'),
      containerPath: path.join(canonical, '.git', 'HEAD'),
      readonly: true,
    });
    expect(a).toContainEqual({
      hostPath: path.join(state, 'canonical-index-unavailable'),
      containerPath: path.join(canonical, '.git', 'index'),
      readonly: true,
    });
    const commonMount = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git'));
    const headOverlay = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git', 'HEAD'));
    const indexOverlay = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git', 'index'));
    expect(headOverlay).toBeGreaterThan(commonMount);
    expect(indexOverlay).toBeGreaterThan(commonMount);
    expect(a).toContainEqual({
      hostPath: path.join(state, 'repository.lock'),
      containerPath: path.join(state, 'repository.lock'),
      readonly: false,
    });
    expect(a.some((mount) => mount.hostPath === canonical || mount.containerPath === canonical)).toBe(false);
    expect(fs.lstatSync(path.join(state, 'repository.lock')).isFile()).toBe(true);
  });

  it('uses the OpenCode Go Qwen 3.8 Max default at high effort when no DB override exists', () => {
    const ag = group('ag-opencode-defaults', 'opencode-defaults');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);

    const contribution = providerContribution('opencode', ag, session('s-opencode-defaults', ag.id));

    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'opencode-go/qwen3.8-max',
      OPENCODE_PROVIDER: 'opencode-go',
      OPENCODE_EFFORT: 'high',
    });
  });

  it('keeps explicit OpenCode DB model and effort overrides authoritative', () => {
    const ag = group('ag-opencode-overrides', 'opencode-overrides');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    updateContainerConfigScalars(ag.id, { model: 'opencode-go/kimi-k3', effort: 'high' });

    const contribution = providerContribution('opencode', ag, session('s-opencode-overrides', ag.id));

    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'opencode-go/kimi-k3',
      OPENCODE_PROVIDER: 'opencode-go',
      OPENCODE_EFFORT: 'high',
    });
  });

  it('mounts one shared kernel-lock inode for real Claude, Codex, and OpenCode build plans', () => {
    const workgroupId = 'shared-house';
    const providerGroups = [
      { provider: 'claude', ag: group('ag-lock-claude', 'lock-claude') },
      { provider: 'codex', ag: group('ag-lock-codex', 'lock-codex') },
      { provider: 'opencode', ag: group('ag-lock-opencode', 'lock-opencode') },
    ];

    for (const { provider, ag } of providerGroups) {
      createAgentGroup(ag);
      assignWorkgroup(ag, workgroupId);
      ensureContainerConfig(ag.id);
      initGroupFilesystem({ ...ag, workgroup_id: workgroupId }, { provider });
    }

    const buildProviderMounts = (provider: string, ag: AgentGroup, suffix: string) => {
      const sess = session(`s-lock-${provider}-${suffix}`, ag.id);
      return buildMounts(ag, sess, containerConfig(), provider, providerContribution(provider, ag, sess), workgroupId);
    };
    const assertNestedMounts = (
      mounts: ReturnType<typeof buildMounts>,
      expectParent: boolean,
    ): { dev: number; ino: number } => {
      const parentIdx = mounts.findIndex((mount) => mount.containerPath === '/workspace/workgroup');
      const memoryIdx = mounts.findIndex((mount) => mount.containerPath === '/workspace/workgroup/memory');
      const lockMounts = mounts.filter((mount) => mount.containerPath === '/workspace/workgroup/.memory-write.lock');
      const lockIdx = mounts.indexOf(lockMounts[0]);

      expect(parentIdx >= 0).toBe(expectParent);
      expect(memoryIdx).toBeGreaterThan(parentIdx);
      expect(lockMounts).toEqual([
        {
          hostPath: path.join(DATA_DIR, 'workgroups', workgroupId, '.memory-write.lock'),
          containerPath: '/workspace/workgroup/.memory-write.lock',
          readonly: false,
        },
      ]);
      expect(lockIdx).toBeGreaterThan(memoryIdx);
      const stat = fs.lstatSync(lockMounts[0].hostPath);
      return { dev: stat.dev, ino: stat.ino };
    };

    // The test config forces WORKGROUP_SHARED_FS off. All three real provider
    // build plans still receive the exact nested memory + lock mounts.
    const memoryOnlyIdentities = providerGroups.map(({ provider, ag }) =>
      assertNestedMounts(buildProviderMounts(provider, ag, 'memory-only'), false),
    );
    expect(new Set(memoryOnlyIdentities.map(({ dev, ino }) => `${dev}:${ino}`)).size).toBe(1);

    // A prior full-FS migration marker activates the parent mount even with
    // the flag disabled. The nested file overlay must remain later than both
    // the parent and memory mounts for every provider.
    fs.writeFileSync(path.join(DATA_DIR, 'workgroups', workgroupId, '.migrated'), '{}\n');
    const fullIdentities = providerGroups.map(({ provider, ag }) =>
      assertNestedMounts(buildProviderMounts(provider, ag, 'full'), true),
    );
    expect(new Set(fullIdentities.map(({ dev, ino }) => `${dev}:${ino}`)).size).toBe(1);
    expect(fullIdentities[0]).toEqual(memoryOnlyIdentities[0]);

    const outsider = group('ag-lock-outsider', 'lock-outsider');
    createAgentGroup(outsider);
    assignWorkgroup(outsider, 'other-house');
    ensureContainerConfig(outsider.id);
    initGroupFilesystem({ ...outsider, workgroup_id: 'other-house' }, { provider: 'claude' });
    const outsiderSession = session('s-lock-outsider', outsider.id);
    const outsiderLock = buildMounts(
      outsider,
      outsiderSession,
      containerConfig(),
      'claude',
      providerContribution('claude', outsider, outsiderSession),
      'other-house',
    ).find((mount) => mount.containerPath === '/workspace/workgroup/.memory-write.lock');
    expect(outsiderLock?.hostPath).toBe(path.join(DATA_DIR, 'workgroups', 'other-house', '.memory-write.lock'));
    expect(outsiderLock?.hostPath).not.toBe(path.join(DATA_DIR, 'workgroups', workgroupId, '.memory-write.lock'));
  });

  it('mounts the default surfaces for an unregistered provider (today’s behavior)', () => {
    const ag = group('ag-mounts-default', 'mounts-default');
    createAgentGroup(ag);
    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    const mounts = buildMounts(ag, session('s1', ag.id), containerConfig(), 'claude', {});

    const byContainerPath = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byContainerPath.has('/home/node/.claude')).toBe(true);
    expect(byContainerPath.has('/app/CLAUDE.md')).toBe(true);
    expect(byContainerPath.has('/workspace/agent/CLAUDE.md')).toBe(true);
    // Composer ran: the generated project doc exists on disk.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(true);
  });

  it('suppresses the default surfaces and keeps contributed mounts for a surfaces-providing provider', () => {
    const ag = group('ag-mounts-surfy', 'mounts-surfy');
    createAgentGroup(ag);
    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const contributed = {
      mounts: [
        {
          hostPath: path.join(GROUPS_DIR, ag.folder),
          containerPath: '/workspace/agent/OWN-DOC.md',
          readonly: true,
        },
      ],
    };
    const mounts = buildMounts(ag, session('s2', ag.id), containerConfig(), 'surfaces-test-provider', contributed);

    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/app/CLAUDE.md');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    // Composer did NOT run for this group.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(false);
    // Core mounts and the provider's own contribution are intact.
    expect(containerPaths).toContain('/workspace');
    expect(containerPaths).toContain('/workspace/agent');
    expect(containerPaths).toContain('/app/src');
    expect(containerPaths).toContain('/workspace/agent/OWN-DOC.md');
  });

  it('test_mandatory_graphify_skill_for_all_and_restricted_configs', () => {
    const cases: Array<{ provider: string; skills: ContainerConfig['skills']; suffix: string }> = [
      { provider: 'claude', skills: 'all', suffix: 'all' },
      { provider: 'codex', skills: [], suffix: 'empty' },
      { provider: 'opencode', skills: ['debug', 'graphify', 'debug'], suffix: 'restricted' },
    ];

    for (const testCase of cases) {
      const ag = group(`ag-graphify-${testCase.suffix}`, `graphify-${testCase.suffix}`);
      createAgentGroup(ag);
      withWorkgroup(ag);
      ensureContainerConfig(ag.id);
      initGroupFilesystem(ag, {});

      buildMounts(
        ag,
        session(`s-graphify-${testCase.suffix}`, ag.id),
        { ...containerConfig(), skills: testCase.skills },
        testCase.provider,
        {},
      );

      const skillsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
      const selected = fs.readdirSync(skillsDir);
      expect(selected.filter((name) => name === 'graphify')).toHaveLength(1);
      expect(fs.readlinkSync(path.join(skillsDir, 'graphify'))).toBe('/app/skills/graphify');
      if (testCase.suffix === 'restricted') {
        expect(selected).toEqual(['debug', 'graphify']);
      }
    }
  });

  it('test_graphify_cache_mounts_share_only_with_thread_siblings', () => {
    const previousThreadWorktrees = process.env.NANOCLAW_THREAD_WORKTREES;
    process.env.NANOCLAW_THREAD_WORKTREES = '1';
    try {
      const ag = group('ag-graphify-cache', 'graphify-cache');
      createAgentGroup(ag);
      withWorkgroup(ag);
      ensureContainerConfig(ag.id);
      initGroupFilesystem(ag, {});

      const siblingA = { ...session('s-cache-a', ag.id), messaging_group_id: 'mg-shared', thread_id: 'thread-one' };
      const siblingB = { ...session('s-cache-b', ag.id), messaging_group_id: 'mg-shared', thread_id: 'thread-one' };
      const unrelated = { ...session('s-cache-c', ag.id), messaging_group_id: 'mg-shared', thread_id: 'thread-two' };
      const isolated = session('s-cache-isolated', ag.id);

      const graphifyMount = (sess: Session) =>
        buildMounts(ag, sess, containerConfig(), 'claude', {}).find(
          (mount) => mount.containerPath === '/workspace/.cache/graphify',
        );

      const first = graphifyMount(siblingA);
      const second = graphifyMount(siblingB);
      const differentThread = graphifyMount(unrelated);
      const differentSession = graphifyMount(isolated);

      expect(first).toMatchObject({ readonly: false });
      expect(first?.hostPath).toBe(second?.hostPath);
      expect(first?.hostPath).not.toBe(differentThread?.hostPath);
      expect(first?.hostPath).not.toBe(differentSession?.hostPath);

      const runtimeMounts = buildMounts(ag, isolated, containerConfig(), 'claude', {}).filter(
        (mount) => mount.containerPath === '/run/nanoclaw-graphify',
      );
      expect(runtimeMounts).toHaveLength(1);
      expect(runtimeMounts[0]).toMatchObject({
        hostPath: path.join(DATA_DIR, 'graphify-runtime'),
        readonly: false,
      });
    } finally {
      if (previousThreadWorktrees === undefined) delete process.env.NANOCLAW_THREAD_WORKTREES;
      else process.env.NANOCLAW_THREAD_WORKTREES = previousThreadWorktrees;
    }
  });

  it('test_gitnexus_host_plugin_and_builtin_hook_never_mount', () => {
    const homedir = path.join(TEST_ROOT, 'home');
    const pluginsDir = path.join(homedir, 'plugins');
    const builtinDir = path.join(TEST_ROOT, 'container', 'nanoclaw-plugin');
    fs.mkdirSync(path.join(pluginsDir, 'gitnexus'), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, 'unrelated-plugin'), { recursive: true });
    fs.mkdirSync(builtinDir, { recursive: true });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homedir);

    try {
      const ag = group('ag-plugin-shadow', 'plugin-shadow');
      createAgentGroup(ag);
      withWorkgroup(ag);
      ensureContainerConfig(ag.id);
      initGroupFilesystem(ag, {});

      const mounts = buildMounts(ag, session('s-plugin-shadow', ag.id), containerConfig(), 'claude', {});
      const paths = mounts.map((mount) => mount.containerPath);
      expect(paths).not.toContain('/workspace/plugins/gitnexus');
      expect(paths).not.toContain('/workspace/plugins/nanoclaw-hooks');
      expect(paths).toContain('/workspace/plugins/unrelated-plugin');
    } finally {
      homedirSpy.mockRestore();
    }
  });
});

describe('worker agent def sync (orchestrator roster)', () => {
  it('copies trunk defs for a claude spawn, prunes retired managed defs, preserves operator files', () => {
    const ag = group('ag-worker-defs', 'worker-defs');
    createAgentGroup(ag);
    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    const agentsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents');
    // Seed: an operator-owned def plus a currently-shipping managed def that a
    // later trunk revision could retire (worker-codex stands in — it IS in
    // MANAGED_WORKER_DEFS, so if trunk dropped it, the prune must remove it).
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'custom-op.md'), 'operator-owned\n');

    buildMounts(ag, session('s-wd', ag.id), containerConfig(), 'claude', {});

    // Trunk roster copied byte-for-byte.
    for (const def of ['worker-fast.md', 'worker.md', 'worker-high.md', 'worker-codex.md']) {
      expect(fs.readFileSync(path.join(agentsDir, def), 'utf-8')).toBe(
        fs.readFileSync(path.join(process.cwd(), 'container', 'agents', def), 'utf-8'),
      );
    }
    // Operator file untouched.
    expect(fs.readFileSync(path.join(agentsDir, 'custom-op.md'), 'utf-8')).toBe('operator-owned\n');
    // Regression guard for the 1M-window fix (F4): opus worker must carry [1m],
    // not a bare id that collapses to 200k under proxy auth. Reverting to
    // `model: opus` or bare `claude-opus-5` fails here.
    expect(fs.readFileSync(path.join(agentsDir, 'worker-high.md'), 'utf-8')).toContain('model: claude-opus-5[1m]');
    const codexWorker = fs.readFileSync(path.join(agentsDir, 'worker-codex.md'), 'utf-8');
    expect(codexWorker).toContain('Always run Codex in the foreground');
    expect(codexWorker).toContain('`timeout` to `3600000`');
    expect(codexWorker).toContain('never set `run_in_background` for the Codex call');
    expect(codexWorker).toContain('the orchestrator owns continued monitoring');
    expect(codexWorker).not.toContain('timeout to 600000');
    const orchestratorInstructions = fs.readFileSync(
      path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'orchestrator-workers.instructions.md'),
      'utf-8',
    );
    expect(orchestratorInstructions).toContain('Invoke `worker-codex` with `run_in_background: true`');
    expect(orchestratorInstructions).toContain('keeps its `codex exec` Bash call in the foreground');
    // Delegation-rules fragment composed for claude. The fragment itself is a
    // symlink to a container path (dangling on the host), so assert on the
    // composed doc's include line rather than existsSync (which follows links).
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'), 'utf-8')).toContain(
      'module-orchestrator-workers.md',
    );
  });

  it('never deletes outside the agents dir even if a poisoned file is planted (F1 traversal guard)', () => {
    const ag = group('ag-worker-defs-sec', 'worker-defs-sec');
    createAgentGroup(ag);
    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    // A canary the old manifest-driven prune could have deleted via traversal.
    const canary = path.join(DATA_DIR, 'canary-must-survive.txt');
    fs.writeFileSync(canary, 'do not delete\n');
    const agentsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Container-writable state an agent could plant; prune must ignore it
    // entirely (targets come only from the in-source MANAGED_WORKER_DEFS list).
    fs.writeFileSync(
      path.join(agentsDir, '.nanoclaw-managed.json'),
      JSON.stringify(['../../../../canary-must-survive.txt']),
    );

    buildMounts(ag, session('s-wd-sec', ag.id), containerConfig(), 'claude', {});

    expect(fs.existsSync(canary)).toBe(true);
  });

  it('skips defs and the orchestrator fragment when the spawn-resolved provider is codex', () => {
    const ag = group('ag-worker-defs-cx', 'worker-defs-cx');
    createAgentGroup(ag);
    withWorkgroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    buildMounts(ag, session('s-wd-cx', ag.id), containerConfig(), 'codex', {});

    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents'))).toBe(false);
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'), 'utf-8')).not.toContain(
      'module-orchestrator-workers.md',
    );
  });
});

describe('retired mirror snapshot topology', () => {
  it('does not expose old mirror-backed snapshots as repository canonicals', () => {
    const ag = group('ag-snap', 'snap-group');
    createAgentGroup(ag);
    assignWorkgroup(ag, 'wg-snap');
    ensureContainerConfig(ag.id);
    fs.mkdirSync(path.join(GROUPS_DIR, ag.folder), { recursive: true });

    const wgShared = path.join(DATA_DIR, 'workgroups', 'wg-snap');
    // .migrated marker forces the workgroup mount on even though the test
    // config pins WORKGROUP_SHARED_FS=false.
    fs.mkdirSync(wgShared, { recursive: true });
    fs.writeFileSync(path.join(wgShared, '.migrated'), '');
    fs.mkdirSync(path.join(wgShared, '.repos', 'proj.git'), { recursive: true });
    fs.mkdirSync(path.join(wgShared, 'proj', '.git'), { recursive: true });
    // A mirror with no snapshot yet must NOT produce a mount.
    fs.mkdirSync(path.join(wgShared, '.repos', 'pending.git'), { recursive: true });

    const mounts = buildMounts(ag, session('s-snap', ag.id), containerConfig(), 'claude', {}, 'wg-snap');
    const snap = mounts.find((m) => m.containerPath === '/workspace/workgroup/proj');
    expect(snap).toBeUndefined();
    expect(mounts.find((m) => m.containerPath === '/workspace/workgroup/pending')).toBeUndefined();
  });
});

describe('symlink overlay workgroup allowlist', () => {
  it('mounts same-workgroup targets and refuses outside targets', () => {
    const ag = group('ag-sym', 'sym-main');
    const sib = group('ag-sym-sib', 'sym-sib');
    const outsider = group('ag-out', 'out-group');
    createAgentGroup(ag);
    createAgentGroup(sib);
    createAgentGroup(outsider);
    assignWorkgroup(ag, 'wg-sym');
    assignWorkgroup(sib, 'wg-sym');
    assignWorkgroup(outsider, 'wg-other');
    ensureContainerConfig(ag.id);

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sibTarget = path.join(GROUPS_DIR, sib.folder, 'SHARED-REPO');
    const outsiderTarget = path.join(GROUPS_DIR, outsider.folder, 'SECRET');
    const hostTarget = path.join(TEST_ROOT, 'host-secret');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(sibTarget, { recursive: true });
    fs.mkdirSync(outsiderTarget, { recursive: true });
    fs.mkdirSync(hostTarget, { recursive: true });
    // Sibling share (legit clone-as-codex pattern), cross-workgroup theft,
    // and arbitrary host path — only the first may mount.
    fs.symlinkSync(sibTarget, path.join(groupDir, 'SHARED-REPO'));
    fs.symlinkSync(outsiderTarget, path.join(groupDir, 'STOLEN'));
    fs.symlinkSync(hostTarget, path.join(groupDir, 'HOST'));

    const mounts = buildMounts(ag, session('s-sym', ag.id), containerConfig(), 'claude', {}, 'wg-sym');
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/workspace/agent/SHARED-REPO');
    expect(containerPaths).not.toContain('/workspace/agent/STOLEN');
    expect(containerPaths).not.toContain('/workspace/agent/HOST');
  });
});
