import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('./db/connection.js', () => ({
  getDb: () => {
    throw new Error('central db unavailable in storage-manager unit test');
  },
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogScrubber: vi.fn(),
}));

import {
  _resetStorageManagerThrottleForTesting,
  getStorageReport,
  pruneIdleSessionArtifacts,
} from './storage-manager.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

describe('storage-manager cache cleanup', () => {
  let tmpRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-manager-'));
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 900 100 90% /\n';
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSession(opts: { id: string; pending?: boolean; fresh?: boolean }): string {
    const dir = path.join(tmpRoot, 'ag-1', opts.id);
    fs.mkdirSync(path.join(dir, 'worktrees', 'repo', '.next', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'worktrees', 'repo', '.next', 'cache', 'compiled.bin'), 'next-cache');
    fs.mkdirSync(path.join(dir, 'worktrees', 'repo', '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'worktrees', 'repo', '.turbo', 'index.bin'), 'turbo-cache');

    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec("CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed')");
    if (opts.pending) {
      db.prepare("INSERT INTO messages_in (status) VALUES ('pending')").run();
    }
    db.close();

    const ageMs = opts.fresh ? 60 * 60 * 1000 : 30 * 60 * 60 * 1000;
    const mtime = (now - ageMs) / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), mtime, mtime);
    return dir;
  }

  it('estimates regenerable cache dirs and skips sessions with pending work', () => {
    const idleDir = makeSession({ id: 'sess-idle' });
    const pendingDir = makeSession({ id: 'sess-pending', pending: true });

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: tmpRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    expect(report.actions.map((a) => a.path).sort()).toEqual([
      path.join(idleDir, 'worktrees', 'repo', '.next', 'cache'),
      path.join(idleDir, 'worktrees', 'repo', '.turbo'),
    ]);
    expect(report.estimatedReclaimableBytes).toBe('next-cache'.length + 'turbo-cache'.length);
    expect(report.skipped.busySessions).toBe(1);
    expect(fs.existsSync(path.join(pendingDir, 'worktrees', 'repo', '.turbo'))).toBe(true);
  });

  it('applies cache cleanup without removing source worktrees', () => {
    const idleDir = makeSession({ id: 'sess-idle' });

    pruneIdleSessionArtifacts(now, tmpRoot, () => false);

    expect(fs.existsSync(path.join(idleDir, 'worktrees', 'repo', '.next', 'cache'))).toBe(false);
    expect(fs.existsSync(path.join(idleDir, 'worktrees', 'repo', '.turbo'))).toBe(false);
    expect(fs.existsSync(path.join(idleDir, 'worktrees', 'repo'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'inbound.db'))).toBe(true);
  });
});

describe('storage-manager Docker cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 910 90 91% /\n';
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'info') {
        return '/var/lib/docker\n';
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'system') {
        return [
          '{"Type":"Images","TotalCount":"12","Active":"3","Size":"55.66GB","Reclaimable":"44.13GB (79%)"}',
          '{"Type":"Containers","TotalCount":"3","Active":"2","Size":"2GB","Reclaimable":"500MB (25%)"}',
          '{"Type":"Build Cache","TotalCount":"42","Active":"0","Size":"28.58GB","Reclaimable":"909.8MB"}',
        ].join('\n');
      }
      return '';
    });
  });

  it('dry-runs Docker actions with install-label containers and commit-label images', () => {
    const report = getStorageReport({
      mode: 'dry-run',
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.actions.map((a) => a.dockerArgs)).toEqual([
      ['container', 'prune', '-f', '--filter', `label=${CONTAINER_INSTALL_LABEL}`],
      ['container', 'prune', '-f', '--filter', 'label=nanoclaw.commit'],
      ['image', 'prune', '-a', '-f', '--filter', 'label=nanoclaw.commit'],
      ['builder', 'prune', '-a', '-f', '--filter', 'until=168h'],
    ]);
    expect(report.pools.docker.estimatedBytes).toBe(44_130_000_000 + 500_000_000 + 909_800_000);
  });

  it('caps BuildKit cache even when Docker filesystem usage is below cleanup threshold', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 600 400 60% /\n';
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'info') {
        return '/var/lib/docker\n';
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'system') {
        return [
          '{"Type":"Images","TotalCount":"12","Active":"3","Size":"55.66GB","Reclaimable":"44.13GB (79%)"}',
          '{"Type":"Containers","TotalCount":"3","Active":"2","Size":"2GB","Reclaimable":"500MB (25%)"}',
          '{"Type":"Build Cache","TotalCount":"42","Active":"0","Size":"28.58GB","Reclaimable":"8.12GB"}',
        ].join('\n');
      }
      return '';
    });

    const report = getStorageReport({
      mode: 'dry-run',
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.actions.map((a) => a.dockerArgs)).toEqual([
      ['builder', 'prune', '-a', '-f', '--filter', 'until=168h'],
    ]);
    expect(report.pools.docker.estimatedBytes).toBe(8_120_000_000);
  });

  it('applies Docker cleanup with execFileSync argument arrays', () => {
    getStorageReport({
      mode: 'apply',
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85, dockerBuildCacheUnusedFor: '72h' },
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['container', 'prune', '-f', '--filter', `label=${CONTAINER_INSTALL_LABEL}`],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['container', 'prune', '-f', '--filter', 'label=nanoclaw.commit'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['image', 'prune', '-a', '-f', '--filter', 'label=nanoclaw.commit'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['builder', 'prune', '-a', '-f', '--filter', 'until=72h'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });
});
