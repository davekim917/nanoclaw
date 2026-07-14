import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-surfaces-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-surfaces-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-surfaces-test/groups',
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

import { buildMounts } from './container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
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

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('initGroupFilesystem agent surfaces', () => {
  it('writes the default surfaces when no provider is given (today’s behavior)', () => {
    const ag = group('ag-default', 'default-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('hello\n');
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')) as {
      env: Record<string, string>;
    };
    expect(settings.env.BASH_MAX_TIMEOUT_MS).toBe('3600000');
    expect(settings.env).not.toHaveProperty('BASH_DEFAULT_TIMEOUT_MS');
    expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(true);
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

  it('writes the seed into the memory scaffold — never CLAUDE.* — for a provider with its own surfaces', () => {
    const ag = group('ag-surfy', 'surfy-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    expect(fs.existsSync(groupDir)).toBe(true);
    // A fresh group on a surfaces-owning provider must not contain stale
    // Claude surfaces; its seed lands in the scaffold's conventional file,
    // which the container-side scaffold preserves at boot.
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md'), 'utf-8')).toBe(
      'hello\n',
    );
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });

  it('treats an unregistered provider name as default surfaces', () => {
    const ag = group('ag-unknown', 'unknown-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'not-registered' });

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'))).toBe(true);
  });
});

describe('initGroupFilesystem deferred seed (.seed.md)', () => {
  // Creation is provider-agnostic: the DM-agent creators drop a neutral
  // `.seed.md` and defer placement to the first spawn, where the DB-resolved
  // provider is known. group-init places it into the right surface and
  // consumes it. Red-on-delete: if that placement is removed, these fail.
  it('places .seed.md into CLAUDE.local.md for the default provider, then consumes it', () => {
    const ag = group('ag-seed-default', 'seed-default');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    initGroupFilesystem(ag, {}); // no inline instructions — must read .seed.md

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('seeded identity\n');
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });

  it('places .seed.md into the memory scaffold (never CLAUDE.*) for a surfaces-owning provider, then consumes it', () => {
    const ag = group('ag-seed-surfy', 'seed-surfy');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md'), 'utf-8')).toBe(
      'seeded identity\n',
    );
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });
});

describe('buildMounts agent surfaces', () => {
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
    for (const def of ['worker.md', 'worker-opus.md', 'worker-codex.md']) {
      expect(fs.readFileSync(path.join(agentsDir, def), 'utf-8')).toBe(
        fs.readFileSync(path.join(process.cwd(), 'container', 'agents', def), 'utf-8'),
      );
    }
    // Operator file untouched.
    expect(fs.readFileSync(path.join(agentsDir, 'custom-op.md'), 'utf-8')).toBe('operator-owned\n');
    // Regression guard for the 1M-window fix (F4): opus worker must carry [1m],
    // not a bare id that collapses to 200k under proxy auth. Reverting to
    // `model: opus` or bare `claude-opus-4-8` fails here.
    expect(fs.readFileSync(path.join(agentsDir, 'worker-opus.md'), 'utf-8')).toContain('model: claude-opus-4-8[1m]');
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
