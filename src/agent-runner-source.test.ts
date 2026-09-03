import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('agent-runner-source-test') }));
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

// Same pattern as src/provider-surfaces.test.ts: override the data/groups
// roots buildMounts writes under, leave REPO_ROOT (used by
// agent-runner-source.ts's default sourceDir) untouched.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
  GROUPS_DIR: `${TEST_ROOT}/groups`,
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

import { buildMounts } from './container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import {
  activateAgentRunnerSource,
  agentRunnerSourcePath,
  pruneAgentRunnerSnapshots,
  resetAgentRunnerSourceForTesting,
} from './agent-runner-source.js';
import { log } from './log.js';
import type { AgentGroup, Session } from './types.js';
import type { ContainerConfig } from './container-config.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string): Session {
  return { id, agent_group_id: agentGroupId } as Session;
}

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

// buildMounts fail-closes (W3) on a NULL workgroup_id — give the test group
// a workgroup-of-1 so the archive/central projections resolve.
function withWorkgroup(ag: AgentGroup): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(ag.folder, ag.folder, ag.id);
  db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(ag.folder, ag.id);
}

async function spawnAppSrcMount(id: string): Promise<{ hostPath: string; containerPath: string; readonly?: boolean }> {
  const ag = group(`ag-runner-src-${id}`, `runner-src-group-${id}`);
  createAgentGroup(ag);
  withWorkgroup(ag);
  ensureContainerConfig(ag.id);
  initGroupFilesystem(ag, {});
  const mounts = await buildMounts(ag, session(`s-runner-src-${id}`, ag.id), containerConfig(), 'claude', {});
  const mount = mounts.find((m) => m.containerPath === '/app/src');
  if (!mount) throw new Error('expected a /app/src mount');
  return mount;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full).map((p) => path.join(entry.name, p)));
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

function makeFakeSourceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-src-'));
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'b.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'c.ts'), 'export const c = 3;\n');
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentRunnerSourceForTesting();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  resetAgentRunnerSourceForTesting();
});

describe('activateAgentRunnerSource', async () => {
  it('spawn mounts the boot snapshot of the runner source, not the checkout', async () => {
    const sourceDir = makeFakeSourceDir();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-data-'));

    const snapshotPath = activateAgentRunnerSource({ sourceDir, dataDir });

    expect(snapshotPath.startsWith(path.join(dataDir, 'agent-runner-src') + path.sep)).toBe(true);
    expect(listFilesRecursive(snapshotPath)).toEqual(listFilesRecursive(sourceDir));
    for (const rel of listFilesRecursive(sourceDir)) {
      expect(fs.readFileSync(path.join(snapshotPath, rel))).toEqual(fs.readFileSync(path.join(sourceDir, rel)));
    }

    const mount = await spawnAppSrcMount('snapshot');
    expect(mount.hostPath).toBe(snapshotPath);
    expect(mount.readonly).toBe(true);

    // Live mode: the checkout itself is mounted, unsnapshotted.
    const livePath = activateAgentRunnerSource({ sourceDir, dataDir, live: true });
    expect(livePath).toBe(sourceDir);
    expect(agentRunnerSourcePath()).toBe(sourceDir);
    const liveMount = await spawnAppSrcMount('live');
    expect(liveMount.hostPath).toBe(sourceDir);

    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a second boot replaces the snapshot and pruning removes only unreferenced previous snapshots', async () => {
    const sourceDir = makeFakeSourceDir();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-data-'));
    const root = path.join(dataDir, 'agent-runner-src');

    const first = activateAgentRunnerSource({ sourceDir, dataDir });
    expect(fs.readdirSync(root)).toEqual([path.basename(first)]);

    // Plant a stale in-progress snapshot from a hypothetically crashed boot.
    const staleTmp = path.join(root, 'stale-boot.tmp');
    fs.mkdirSync(staleTmp, { recursive: true });
    fs.writeFileSync(path.join(staleTmp, 'x.ts'), 'stale\n');

    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export const a = 2; // changed\n');

    const second = activateAgentRunnerSource({ sourceDir, dataDir });

    // Activation never prunes — both snapshots (and the stale tmp dir) are
    // still on disk right after the second boot.
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    expect(new Set(fs.readdirSync(root))).toEqual(
      new Set([path.basename(first), path.basename(second), 'stale-boot.tmp']),
    );

    // A caller that still references `first` (e.g. a container from the
    // previous host process still running) keeps it; the unreferenced stale
    // tmp dir is swept; `second` (the active snapshot) is always kept.
    pruneAgentRunnerSnapshots({ dataDir, referencedPaths: () => new Set([first]) });
    expect(new Set(fs.readdirSync(root))).toEqual(new Set([path.basename(first), path.basename(second)]));

    // Once nothing external references `first` any more, it is swept too.
    pruneAgentRunnerSnapshots({ dataDir, referencedPaths: () => new Set() });
    expect(fs.readdirSync(root)).toEqual([path.basename(second)]);
    expect(fs.readFileSync(path.join(second, 'index.ts'), 'utf-8')).toBe('export const a = 2; // changed\n');

    // A referencedPaths failure (docker unreachable, etc.) must prune
    // nothing at all — plant a fresh stale entry and confirm it survives.
    const anotherStale = path.join(root, 'another-stale');
    fs.mkdirSync(anotherStale, { recursive: true });
    pruneAgentRunnerSnapshots({ dataDir, referencedPaths: () => null });
    expect(fs.existsSync(anotherStale)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);

    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('falls back to the checkout path and keeps booting when the snapshot cannot be written', async () => {
    const sourceDir = makeFakeSourceDir();
    // A regular file used as a path prefix — mkdirSync(recursive) under it
    // must fail with ENOTDIR, never throw out of activateAgentRunnerSource.
    const blockerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-blocker-')), 'not-a-dir');
    fs.writeFileSync(blockerFile, 'x');
    const unwritableDataDir = path.join(blockerFile, 'data');

    let thrown: unknown;
    let result = '';
    try {
      result = activateAgentRunnerSource({ sourceDir, dataDir: unwritableDataDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(sourceDir);
    expect(agentRunnerSourcePath()).toBe(sourceDir);
    expect(log.error).toHaveBeenCalled();

    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(blockerFile), { recursive: true, force: true });
  });
});
