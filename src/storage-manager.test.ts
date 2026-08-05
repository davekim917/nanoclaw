import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
const mockGetAllContainerConfigs = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Default: central DB unavailable (throws) — proves the manager works without
// it and that session reclaim fails closed. Tests that exercise reclaim set
// mocks.centralDb to a row map; UPDATEd session ids land in centralDb.updates.
const centralDbMock = vi.hoisted(() => ({
  current: null as null | {
    rows: Record<string, { status: string; last_activity: string | null }>;
    updates: string[];
  },
}));
vi.mock('./db/connection.js', () => ({
  getDb: () => {
    if (!centralDbMock.current) throw new Error('central db unavailable in storage-manager unit test');
    const db = centralDbMock.current;
    return {
      prepare: (sql: string) => ({
        get: (id: string) => db.rows[id],
        run: (id: string) => {
          if (sql.includes('UPDATE sessions')) db.updates.push(id);
        },
        all: () => [],
      }),
    };
  },
}));

vi.mock('./db/container-configs.js', () => ({
  getAllContainerConfigs: () => mockGetAllContainerConfigs(),
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogScrubber: vi.fn(),
}));

import {
  _resetStorageManagerThrottleForTesting,
  assertStorageAdmission,
  classifyDockerImage,
  getStorageReport,
  pruneIdleSessionArtifacts,
  type DockerImageInventory,
} from './storage-manager.js';
import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL } from './config.js';
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

  function makeSession(opts: {
    id: string;
    root?: string;
    pending?: boolean;
    fresh?: boolean;
    trigger?: number;
    processAfter?: string | null;
    status?: 'pending' | 'processing';
    processingAck?: boolean;
  }): string {
    const dir = path.join(opts.root ?? tmpRoot, 'ag-1', opts.id);
    fs.mkdirSync(path.join(dir, 'worktrees', 'repo', '.next', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'worktrees', 'repo', '.next', 'cache', 'compiled.bin'), 'next-cache');
    fs.mkdirSync(path.join(dir, 'worktrees', 'repo', '.turbo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'worktrees', 'repo', '.turbo', 'index.bin'), 'turbo-cache');

    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(`CREATE TABLE messages_in (
      status TEXT NOT NULL DEFAULT 'completed',
      trigger INTEGER NOT NULL DEFAULT 1,
      process_after TEXT
    )`);
    if (opts.pending || opts.status) {
      db.prepare('INSERT INTO messages_in (status, trigger, process_after) VALUES (?, ?, ?)').run(
        opts.status ?? 'pending',
        opts.trigger ?? 1,
        opts.processAfter ?? null,
      );
    }
    db.close();

    if (opts.processingAck) {
      const outbound = new Database(path.join(dir, 'outbound.db'));
      outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT, status_changed TEXT)');
      outbound
        .prepare("INSERT INTO processing_ack VALUES ('m-processing', 'processing', ?)")
        .run(new Date(now).toISOString());
      outbound.close();
    }

    const ageMs = opts.fresh ? 60 * 60 * 1000 : 30 * 60 * 60 * 1000;
    const mtime = (now - ageMs) / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), mtime, mtime);
    return dir;
  }

  function markSessionIdle(dir: string): void {
    const mtime = (now - 30 * 60 * 60 * 1000) / 1000;
    for (const name of ['inbound.db', 'outbound.db', 'archive.db', 'central.db']) {
      const target = path.join(dir, name);
      if (fs.existsSync(target)) fs.utimesSync(target, mtime, mtime);
    }
  }

  function createCanonicalProjectionSources(dataRoot: string): { archivePath: string; centralPath: string } {
    fs.mkdirSync(dataRoot, { recursive: true });
    const archivePath = path.join(dataRoot, 'archive.db');
    const archive = new Database(archivePath);
    archive.exec('CREATE TABLE messages_archive (id TEXT PRIMARY KEY, text TEXT NOT NULL)');
    archive.prepare("INSERT INTO messages_archive VALUES ('canonical-history', 'retain this history')").run();
    archive.close();

    const centralPath = path.join(dataRoot, 'v2.db');
    const central = new Database(centralPath);
    central.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    central.close();
    return { archivePath, centralPath };
  }

  function createSessionProjections(dir: string): void {
    const archive = new Database(path.join(dir, 'archive.db'));
    archive.exec('CREATE TABLE messages_archive (id TEXT PRIMARY KEY, text TEXT NOT NULL)');
    archive.prepare("INSERT INTO messages_archive VALUES ('projection-history', 'old projected history')").run();
    archive.close();

    const central = new Database(path.join(dir, 'central.db'));
    central.exec('CREATE TABLE backlog_items (id TEXT PRIMARY KEY)');
    central.close();

    const outbound = new Database(path.join(dir, 'outbound.db'));
    outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT, status_changed TEXT)');
    outbound.close();

    fs.mkdirSync(path.join(dir, 'codex', 'plugins', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'codex', 'plugins', 'cache', 'plugin.json'), 'derived-plugin-cache');
    fs.writeFileSync(path.join(dir, 'codex', 'auth.json'), 'must-be-retained');
    markSessionIdle(dir);
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

  it('removes only rebuildable session projections and Codex plugin caches after verifying canonical sources', () => {
    const dataRoot = path.join(tmpRoot, 'data');
    const sessionsRoot = path.join(dataRoot, 'v2-sessions');
    const canonical = createCanonicalProjectionSources(dataRoot);
    const idleDir = makeSession({ id: 'sess-derived', root: sessionsRoot });
    createSessionProjections(idleDir);

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(dataRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(idleDir, 'codex', 'plugins'),
          kind: 'delete-cache-dir',
          status: 'applied',
        }),
        expect.objectContaining({
          path: path.join(idleDir, 'archive.db'),
          kind: 'delete-derived-file',
          status: 'applied',
        }),
        expect.objectContaining({
          path: path.join(idleDir, 'central.db'),
          kind: 'delete-derived-file',
          status: 'applied',
        }),
      ]),
    );
    expect(fs.existsSync(path.join(idleDir, 'codex', 'plugins'))).toBe(false);
    expect(fs.existsSync(path.join(idleDir, 'archive.db'))).toBe(false);
    expect(fs.existsSync(path.join(idleDir, 'central.db'))).toBe(false);

    expect(fs.existsSync(path.join(idleDir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'outbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'codex', 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'worktrees', 'repo'))).toBe(true);

    const archive = new Database(canonical.archivePath, { readonly: true });
    expect(archive.prepare("SELECT text FROM messages_archive WHERE id = 'canonical-history'").get()).toEqual({
      text: 'retain this history',
    });
    archive.close();
    expect(fs.existsSync(canonical.centralPath)).toBe(true);
  });

  it('fails closed and retains projections when their canonical sources are unavailable', () => {
    const dataRoot = path.join(tmpRoot, 'data');
    const sessionsRoot = path.join(dataRoot, 'v2-sessions');
    const idleDir = makeSession({ id: 'sess-no-canonical-source', root: sessionsRoot });
    createSessionProjections(idleDir);

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(dataRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    expect(report.actions.map((action) => action.path)).not.toContain(path.join(idleDir, 'archive.db'));
    expect(report.actions.map((action) => action.path)).not.toContain(path.join(idleDir, 'central.db'));
    expect(report.warnings).toContain(
      'session archive projections retained: canonical data/archive.db is unavailable or unreadable',
    );
    expect(report.warnings).toContain(
      'session central projections retained: canonical data/v2.db is unavailable or unreadable',
    );
    expect(fs.existsSync(path.join(idleDir, 'archive.db'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'central.db'))).toBe(true);
    expect(fs.existsSync(path.join(idleDir, 'codex', 'plugins'))).toBe(false);

    const projection = new Database(path.join(idleDir, 'archive.db'), { readonly: true });
    expect(projection.prepare("SELECT text FROM messages_archive WHERE id = 'projection-history'").get()).toEqual({
      text: 'old projected history',
    });
    projection.close();
  });

  it('rechecks the canonical archive immediately before deleting its projection', () => {
    const dataRoot = path.join(tmpRoot, 'data');
    const sessionsRoot = path.join(dataRoot, 'v2-sessions');
    const canonical = createCanonicalProjectionSources(dataRoot);
    const idleDir = makeSession({ id: 'sess-source-disappears', root: sessionsRoot });
    createSessionProjections(idleDir);
    const pluginCache = path.join(idleDir, 'codex', 'plugins');
    const realRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === pluginCache) realRmSync(canonical.archivePath, { force: true });
      return realRmSync(target, options);
    });

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(dataRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });
    rmSpy.mockRestore();

    expect(report.actions.find((action) => action.path === path.join(idleDir, 'archive.db'))).toMatchObject({
      status: 'skipped',
    });
    expect(fs.existsSync(path.join(idleDir, 'archive.db'))).toBe(true);
  });

  it('treats only due triggered work as busy', () => {
    const chatterDir = makeSession({ id: 'sess-chatter', pending: true, trigger: 0 });
    const futureDir = makeSession({
      id: 'sess-future',
      pending: true,
      trigger: 1,
      processAfter: '2026-07-01T00:00:00.000Z',
    });
    const dueDir = makeSession({
      id: 'sess-due',
      pending: true,
      trigger: 1,
      processAfter: '2026-06-29T00:00:00.000Z',
    });

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: tmpRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    const plannedPaths = report.actions.map((action) => action.path);
    expect(plannedPaths).toContain(path.join(chatterDir, 'worktrees', 'repo', '.turbo'));
    expect(plannedPaths).toContain(path.join(futureDir, 'worktrees', 'repo', '.turbo'));
    expect(plannedPaths).not.toContain(path.join(dueDir, 'worktrees', 'repo', '.turbo'));
    expect(report.skipped.busySessions).toBe(1);
  });

  it('protects sessions with inbound processing or an active processing acknowledgement', () => {
    const inboundDir = makeSession({ id: 'sess-inbound-processing', status: 'processing' });
    const ackDir = makeSession({ id: 'sess-processing-ack', processingAck: true });

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: tmpRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    const plannedPaths = report.actions.map((action) => action.path);
    expect(plannedPaths).not.toContain(path.join(inboundDir, 'worktrees', 'repo', '.turbo'));
    expect(plannedPaths).not.toContain(path.join(ackDir, 'worktrees', 'repo', '.turbo'));
    expect(report.skipped.busySessions).toBe(2);
  });

  it('fails closed when a legacy session database lacks the scheduling columns', () => {
    const legacyDir = makeSession({ id: 'sess-legacy-schema' });
    const inboundPath = path.join(legacyDir, 'inbound.db');
    fs.rmSync(inboundPath);
    const legacyDb = new Database(inboundPath);
    legacyDb.exec("CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed')");
    legacyDb.close();

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: tmpRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 24 * 60 * 60 * 1000 },
    });

    expect(report.actions.map((action) => action.path)).not.toContain(
      path.join(legacyDir, 'worktrees', 'repo', '.turbo'),
    );
    expect(report.skipped.unreadableSessions).toBe(1);
  });
});

describe('storage-manager session archive-then-reclaim', () => {
  let tmpRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    centralDbMock.current = null;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-sess-reclaim-'));
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 900 100 90% /\n';
      }
      if (cmd === 'tar') {
        const argv = cmdArgs as string[];
        fs.writeFileSync(argv[argv.indexOf('-cf') + 1]!, 'fake-zstd-archive');
        return '';
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    centralDbMock.current = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeIdleSession(id: string, idleMs: number): string {
    const dir = path.join(tmpRoot, 'v2-sessions', 'ag-1', id);
    fs.mkdirSync(path.join(dir, 'creds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds', 'secret.json'), 'secret-material');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'human work');
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec("CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed', trigger INTEGER, process_after TEXT)");
    db.close();
    const mtime = (now - idleMs) / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), mtime, mtime);
    return dir;
  }

  function runApply() {
    return getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot: path.join(tmpRoot, 'v2-sessions'),
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
    });
  }

  function iso(msAgo: number): string {
    return new Date(now - msAgo).toISOString();
  }

  it('archives a 30d-idle session, closes its row, and excludes creds from the rescue', () => {
    const dir = makeIdleSession('sess-old', 31 * DAY);
    centralDbMock.current = {
      rows: { 'sess-old': { status: 'active', last_activity: iso(31 * DAY) } },
      updates: [],
    };

    const report = runApply();

    const action = report.actions.find((a) => a.kind === 'archive-session');
    expect(action?.status).toBe('applied');
    expect(centralDbMock.current.updates).toEqual(['sess-old']);
    expect(fs.existsSync(dir)).toBe(false);
    const rescues = fs.readdirSync(path.join(tmpRoot, 'session-rescues'));
    expect(rescues.some((f) => f.startsWith('ag-1__sess-old-') && f.endsWith('.tar.zst'))).toBe(true);
    const tarCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall?.[1]).toContain('--exclude=creds');
  });

  it('holds a session whose central row shows fresh activity, whatever the dir mtime says', () => {
    const dir = makeIdleSession('sess-db-fresh', 31 * DAY);
    centralDbMock.current = {
      rows: { 'sess-db-fresh': { status: 'active', last_activity: iso(1 * DAY) } },
      updates: [],
    };

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(centralDbMock.current.updates).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true);
  });

  it('fails closed when the central DB is unavailable, while cache pruning continues', () => {
    makeIdleSession('sess-no-db', 31 * DAY);
    // centralDbMock.current stays null -> getDb throws

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
  });

  it('reclaims an orphan dir with no central row without touching the DB', () => {
    const dir = makeIdleSession('sess-orphan', 40 * DAY);
    centralDbMock.current = { rows: {}, updates: [] };

    const report = runApply();

    const action = report.actions.find((a) => a.kind === 'archive-session');
    expect(action?.status).toBe('applied');
    expect(centralDbMock.current.updates).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('storage-manager thread worktree archive-then-reclaim', () => {
  let tmpRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-threads-'));
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 900 100 90% /\n';
      }
      if (cmd === 'tar') {
        const argv = cmdArgs as string[];
        const archivePath = argv[argv.indexOf('-cf') + 1];
        fs.writeFileSync(archivePath, 'fake-zstd-archive');
        return '';
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeThreadDir(relative: string, idleMs: number): string {
    const threadDir = path.join(tmpRoot, 'v2-threads', relative);
    fs.mkdirSync(path.join(threadDir, 'worktrees', 'repo', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'worktrees', 'repo', 'notes.md'), 'unpushed human work');
    fs.writeFileSync(path.join(threadDir, 'worktrees', 'repo', 'node_modules', 'blob.bin'), 'reinstallable');
    const mtime = (now - idleMs) / 1000;
    fs.utimesSync(path.join(threadDir, 'worktrees'), mtime, mtime);
    return threadDir;
  }

  function runApply() {
    return getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot: path.join(tmpRoot, 'no-sessions'),
      threadsRoot: path.join(tmpRoot, 'v2-threads'),
      includeDocker: false,
      policy: {
        filesystemPath: tmpRoot,
        idleArtifactMs: 1 * DAY,
        worktreeReclaimMs: 30 * DAY,
      },
    });
  }

  it('archives a 30d-idle thread dir into thread-rescues then removes it, covering the nested layout', () => {
    const flat = makeThreadDir('flat-thread', 31 * DAY);
    const nested = makeThreadDir(path.join('wg-example', 'nested-thread'), 40 * DAY);

    const report = runApply();

    const archiveActions = report.actions.filter((a) => a.kind === 'archive-thread-worktree');
    expect(archiveActions.map((a) => a.status)).toEqual(['applied', 'applied']);
    expect(fs.existsSync(flat)).toBe(false);
    expect(fs.existsSync(nested)).toBe(false);
    const rescues = fs.readdirSync(path.join(tmpRoot, 'thread-rescues'));
    expect(rescues.some((f) => f.startsWith('flat-thread-') && f.endsWith('.tar.zst'))).toBe(true);
    expect(rescues.some((f) => f.startsWith('wg-example__nested-thread-'))).toBe(true);
    // tar was told to skip regenerable trees
    const tarCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall?.[1]).toContain('--exclude=node_modules');
  });

  it('keeps a merely cache-idle thread dir on the pruning path, not the archive path', () => {
    const threadDir = makeThreadDir('young-thread', 2 * DAY);

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-thread-worktree')).toEqual([]);
    expect(fs.existsSync(path.join(threadDir, 'worktrees', 'repo', 'notes.md'))).toBe(true);
    expect(fs.existsSync(path.join(threadDir, 'worktrees', 'repo', 'node_modules'))).toBe(false);
  });

  it('keeps the thread dir untouched when the archive cannot be produced', () => {
    const threadDir = makeThreadDir('doomed-thread', 31 * DAY);
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 900 100 90% /\n';
      }
      if (cmd === 'tar') throw new Error('zstd: not enough space');
      throw new Error(`unexpected command ${cmd}`);
    });

    const report = runApply();

    const action = report.actions.find((a) => a.kind === 'archive-thread-worktree');
    expect(action?.status).toBe('failed');
    expect(fs.existsSync(path.join(threadDir, 'worktrees', 'repo', 'notes.md'))).toBe(true);
  });
});

describe('storage-manager Docker cleanup', () => {
  const now = Date.parse('2026-07-19T00:00:00.000Z');
  let images: Array<Record<string, unknown>>;
  let containers: Array<Record<string, unknown>>;
  let usagePct: number;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    mockGetAllContainerConfigs.mockReturnValue([]);
    usagePct = 91;
    images = [
      {
        Id: 'sha256:canonical',
        RepoTags: [CONTAINER_IMAGE],
        Created: '2026-07-01T00:00:00.000Z',
        Size: 2_000,
        Config: { Labels: { 'nanoclaw.commit': 'canonical' } },
      },
      {
        Id: 'sha256:expired',
        RepoTags: [`${CONTAINER_IMAGE_BASE}:graphify-old`],
        Created: '2026-07-01T00:00:00.000Z',
        Size: 1_000,
        Config: {
          Labels: {
            'nanoclaw.commit': 'candidate',
            'nanoclaw.image.role': 'candidate',
            'nanoclaw.retention.created_at': '2026-07-01T00:00:00.000Z',
            'nanoclaw.retention.hours': '168',
          },
        },
      },
    ];
    containers = [
      {
        Id: 'own-stopped',
        Image: 'sha256:canonical',
        Name: '/nanoclaw-own',
        State: { Running: false },
        Config: { Labels: Object.fromEntries([CONTAINER_INSTALL_LABEL.split('=')]) },
      },
      {
        Id: 'own-running',
        Image: 'sha256:canonical',
        Name: '/nanoclaw-running',
        State: { Running: true },
        Config: { Labels: Object.fromEntries([CONTAINER_INSTALL_LABEL.split('=')]) },
      },
      {
        Id: 'peer-stopped',
        Image: 'sha256:peer',
        Name: '/nanoclaw-peer',
        State: { Running: false },
        Config: { Labels: { 'nanoclaw-install': 'peer-install' } },
      },
    ];
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'df') {
        return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 ${usagePct * 10} ${(100 - usagePct) * 10} ${usagePct}% /\n`;
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
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'container' && args[1] === 'ls') {
        return containers.map((container) => container.Id).join('\n');
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'container' && args[1] === 'inspect') {
        const ids = args.slice(2);
        return JSON.stringify(containers.filter((container) => ids.includes(String(container.Id))));
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'image' && args[1] === 'ls') {
        return images.map((image) => image.Id).join('\n');
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'image' && args[1] === 'inspect') {
        const ids = args.slice(2);
        return JSON.stringify(images.filter((image) => ids.includes(String(image.Id))));
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'builder' && args[1] === 'prune' && args[2] === '--help') {
        return '      --min-free-space bytes   minimum free space\n';
      }
      return '';
    });
  });

  it('plans only exact stopped-install containers and expired unreferenced images without force', () => {
    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.actions.map((a) => a.dockerArgs)).toEqual([
      ['container', 'rm', 'own-stopped'],
      ['builder', 'prune', '-a', '-f', '--filter', 'until=168h'],
      ['builder', 'prune', '-a', '-f', '--min-free-space', expect.stringMatching(/B$/)],
      ['image', 'rm', 'sha256:expired'],
    ]);
    expect(
      report.actions.filter(
        (action) => action.dockerArgs?.includes('-f') && action.kind !== 'docker-prune-builder-cache',
      ),
    ).toEqual([]);
    expect(report.images.protectedCount).toBe(1);
    expect(report.images.eligibleCount).toBe(1);
    expect(report.pressure).toMatchObject({ level: 'critical', cleanupTargetPct: 82, targetReached: false });
  });

  it('caps BuildKit cache even when Docker filesystem usage is below cleanup threshold', () => {
    usagePct = 60;

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.actions.map((a) => a.dockerArgs)).toEqual([
      ['builder', 'prune', '-a', '-f', '--filter', 'until=168h'],
    ]);
  });

  it('revalidates an image immediately before removal and skips a newly referenced image', () => {
    let containerInventoryReads = 0;
    const originalImplementation = mockExecFileSync.getMockImplementation()!;
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'container' && args[1] === 'inspect') {
        containerInventoryReads += 1;
        if (containerInventoryReads >= 2) {
          return JSON.stringify([
            {
              Id: 'new-container',
              Image: 'sha256:expired',
              State: { Running: true },
              Config: { Labels: {} },
            },
          ]);
        }
      }
      return originalImplementation(cmd, args);
    });

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['image', 'rm', 'sha256:expired'],
      expect.anything(),
    );
    expect(report.actions.find((action) => action.id.includes('sha256:expired'))?.status).toBe('skipped');
  });

  it('bypasses the long cadence under critical pressure but honors the emergency retry guard', () => {
    const options = {
      mode: 'apply' as const,
      respectCadence: true,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85, emergencyRetryMs: 60_000 },
    };

    getStorageReport({ ...options, now });
    const guarded = getStorageReport({ ...options, now: now + 30_000 });
    const retried = getStorageReport({ ...options, now: now + 61_000 });

    expect(guarded.warnings).toContain('docker cleanup skipped by emergency retry throttle');
    expect(guarded.warnings).not.toContain('expensive storage scan skipped by cadence throttle');
    expect(retried.actions.some((action) => action.pool === 'docker')).toBe(true);
  });

  it('lets explicit cleanup bypass both throttles', () => {
    const baseOptions = {
      mode: 'apply' as const,
      respectCadence: true,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    };
    getStorageReport({ ...baseOptions, now });

    const forced = getStorageReport({ ...baseOptions, now: now + 1_000, force: true });

    expect(forced.actions.some((action) => action.pool === 'docker')).toBe(true);
    expect(forced.warnings).not.toContain('docker cleanup skipped by emergency retry throttle');
  });

  it('runs the age-bounded BuildKit cleanup on the first normal-cadence scan', () => {
    usagePct = 60;
    const report = getStorageReport({
      mode: 'apply',
      now,
      respectCadence: true,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.actions.map((action) => action.dockerArgs)).toEqual([
      ['builder', 'prune', '-a', '-f', '--filter', 'until=168h'],
    ]);
  });

  it('arms the long cooldown after a successful zero-byte Docker action', () => {
    usagePct = 60;
    const options = {
      mode: 'apply' as const,
      respectCadence: true,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: {
        filesystemPath: process.cwd(),
        cleanupThresholdPct: 85,
        scanCadenceMs: 1,
        dockerPruneCadenceMs: 6 * 60 * 60 * 1000,
      },
    };

    const first = getStorageReport({ ...options, now });
    const second = getStorageReport({ ...options, now: now + 1_000 });

    expect(first.filesystem.actualReclaimedBytes).toBe(0);
    expect(first.actions[0]).toMatchObject({ pool: 'docker', status: 'applied' });
    expect(second.warnings).toContain('docker cleanup skipped by cadence throttle');
  });

  it('protects an image referenced only by a stopped peer container', () => {
    images.push({
      Id: 'sha256:stopped-reference',
      RepoTags: [`${CONTAINER_IMAGE_BASE}:stopped-reference`],
      Created: '2026-07-01T00:00:00.000Z',
      Size: 700,
      Config: {
        Labels: {
          'nanoclaw.commit': 'stopped-reference',
          'nanoclaw.image.role': 'candidate',
          'nanoclaw.retention.created_at': '2026-07-01T00:00:00.000Z',
          'nanoclaw.retention.hours': '168',
        },
      },
    });
    containers.push({
      Id: 'peer-stopped-reference',
      Image: 'sha256:stopped-reference',
      State: { Running: false },
      Config: { Labels: { 'nanoclaw-install': 'peer-install' } },
    });

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.images.dispositions.find((image) => image.id === 'sha256:stopped-reference')).toMatchObject({
      disposition: 'protected',
      protectionReason: 'container-referenced',
    });
    expect(report.actions.map((action) => action.dockerArgs)).not.toContainEqual([
      'image',
      'rm',
      'sha256:stopped-reference',
    ]);
  });

  it('disables managed image deletion when configured image references are unreadable', () => {
    mockGetAllContainerConfigs.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    const report = getStorageReport({
      mode: 'dry-run',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(report.images.dispositions.find((image) => image.id === 'sha256:expired')).toMatchObject({
      disposition: 'protected',
      protectionReason: 'configuration-unreadable',
    });
    expect(report.actions.map((action) => action.dockerArgs)).not.toContainEqual(['image', 'rm', 'sha256:expired']);
  });

  it('skips an exact stopped-container removal if the container starts before execution', () => {
    let targetInspectReads = 0;
    const originalImplementation = mockExecFileSync.getMockImplementation()!;
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === CONTAINER_RUNTIME_BIN &&
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args.length === 3 &&
        args[2] === 'own-stopped'
      ) {
        targetInspectReads += 1;
        return JSON.stringify([{ ...containers[0], State: { Running: true } }]);
      }
      return originalImplementation(cmd, args);
    });

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(targetInspectReads).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['container', 'rm', 'own-stopped'],
      expect.anything(),
    );
    expect(report.actions.find((action) => action.id === 'docker:container:own-stopped')?.status).toBe('skipped');
  });

  it('removes eligible images oldest first and stops once the cleanup target is reached', () => {
    containers = [];
    images.push({
      Id: 'sha256:newer-expired',
      RepoTags: [`${CONTAINER_IMAGE_BASE}:newer-expired`],
      Created: '2026-07-02T00:00:00.000Z',
      Size: 500,
      Config: {
        Labels: {
          'nanoclaw.commit': 'candidate-2',
          'nanoclaw.image.role': 'candidate',
          'nanoclaw.retention.created_at': '2026-07-02T00:00:00.000Z',
          'nanoclaw.retention.hours': '168',
        },
      },
    });
    let dfReads = 0;
    const originalImplementation = mockExecFileSync.getMockImplementation()!;
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'df') {
        dfReads += 1;
        const pct = dfReads >= 4 ? 81 : 91;
        return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 ${pct * 10} ${(100 - pct) * 10} ${pct}% /\n`;
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args.join(' ') === 'builder prune --help') return '';
      return originalImplementation(cmd, args);
    });

    const report = getStorageReport({
      mode: 'apply',
      now,
      force: true,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85 },
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['image', 'rm', 'sha256:expired'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['image', 'rm', 'sha256:newer-expired'],
      expect.anything(),
    );
    expect(report.actions.find((action) => action.id.includes('newer-expired'))?.status).toBe('skipped');
    expect(report.pressure.targetReached).toBe(true);
    expect(report.warnings).toContain(
      'Docker builder does not support --min-free-space; aggressive BuildKit cleanup skipped',
    );
  });

  it('preserves the synchronous admission result and reason contract', () => {
    const refused = assertStorageAdmission({
      now,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85, admissionRefusePct: 90 },
    });
    expect(refused).toMatchObject({ allowed: false, reason: 'still-over-threshold' });

    usagePct = 60;
    const allowed = assertStorageAdmission({
      now: now + 1_000,
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: { filesystemPath: process.cwd(), cleanupThresholdPct: 85, admissionRefusePct: 90 },
    });
    expect(allowed).toMatchObject({ allowed: true, reason: 'below-threshold' });
  });

  it('throttles admission scans to the cadence in the pressure band, but never under critical pressure', () => {
    const options = {
      sessionsRoot: path.join(os.tmpdir(), 'missing-sessions'),
      threadsRoot: path.join(os.tmpdir(), 'missing-threads'),
      policy: {
        filesystemPath: process.cwd(),
        cleanupThresholdPct: 85,
        admissionRefusePct: 95,
        scanCadenceMs: 60 * 60 * 1000,
      },
    };

    // usage 92: in the [threshold, refuse) band. First admission scans and
    // arms the cadence; a second admission moments later (spawn traffic)
    // must NOT run another full scan+apply pass.
    const first = assertStorageAdmission({ ...options, now });
    expect(first.report.warnings).not.toContain('expensive storage scan skipped by cadence throttle');
    const second = assertStorageAdmission({ ...options, now: now + 40_000 });
    expect(second.report.warnings).toContain('expensive storage scan skipped by cadence throttle');
    expect(second).toMatchObject({ allowed: true, reason: 'cleanup-succeeded' });

    // Critical pressure (>= admissionRefusePct) bypasses the throttle.
    const critical = assertStorageAdmission({
      ...options,
      now: now + 80_000,
      policy: { ...options.policy, admissionRefusePct: 90 },
    });
    expect(critical.report.warnings).not.toContain('expensive storage scan skipped by cadence throttle');
    expect(critical).toMatchObject({ allowed: false, reason: 'still-over-threshold' });
  });
});

describe('storage-manager image protection', () => {
  const now = Date.parse('2026-07-19T00:00:00.000Z');
  const baseImage: DockerImageInventory = {
    id: 'sha256:candidate',
    repoTags: [`${CONTAINER_IMAGE_BASE}:candidate`],
    createdAt: '2026-07-10T00:00:00.000Z',
    sizeBytes: 1_000,
    labels: {
      'nanoclaw.commit': 'abc123',
      'nanoclaw.image.role': 'candidate',
      'nanoclaw.retention.created_at': '2026-07-10T00:00:00.000Z',
      'nanoclaw.retention.hours': '168',
    },
  };

  function classify(image: typeof baseImage, overrides: Partial<Parameters<typeof classifyDockerImage>[1]> = {}) {
    return classifyDockerImage(image, {
      now,
      canonicalImage: CONTAINER_IMAGE,
      configuredImages: new Set<string>(),
      containerImageIds: new Set<string>(),
      candidateRetentionHours: 168,
      legacyGraceHours: 168,
      configurationReadable: true,
      ...overrides,
    });
  }

  it.each([
    [
      'canonical image',
      { ...baseImage, repoTags: [CONTAINER_IMAGE] },
      { canonicalImage: CONTAINER_IMAGE },
      'canonical-image',
    ],
    ['configured image', baseImage, { configuredImages: new Set([baseImage.repoTags[0]]) }, 'configured-image'],
    ['container referenced image', baseImage, { containerImageIds: new Set([baseImage.id]) }, 'container-referenced'],
  ])('protects the %s', (_name, image, context, reason) => {
    expect(classify(image as typeof baseImage, context as never)).toMatchObject({
      disposition: 'protected',
      protectionReason: reason,
    });
  });

  it('protects an unexpired lease and exposes its owner and expiry', () => {
    const result = classify({
      ...baseImage,
      labels: {
        ...baseImage.labels,
        'nanoclaw.retention.created_at': '2026-07-18T00:00:00.000Z',
        'nanoclaw.retention.owner': 'graphify-session',
      },
    });

    expect(result).toMatchObject({
      disposition: 'protected',
      protectionReason: 'retention-lease',
      owner: 'graphify-session',
      leaseExpiresAt: '2026-07-25T00:00:00.000Z',
    });
  });

  it('makes an expired, unreferenced managed image eligible', () => {
    expect(classify(baseImage)).toMatchObject({
      disposition: 'eligible',
      protectionReason: 'expired-unreferenced',
    });
  });

  it('fails closed on malformed retention metadata', () => {
    expect(
      classify({
        ...baseImage,
        labels: { ...baseImage.labels, 'nanoclaw.retention.hours': 'not-a-number' },
      }),
    ).toMatchObject({ disposition: 'protected', protectionReason: 'invalid-retention-metadata' });
  });

  it('gives legacy tagged NanoClaw images a seven-day creation grace', () => {
    const legacy = {
      ...baseImage,
      createdAt: '2026-07-18T00:00:00.000Z',
      labels: { 'nanoclaw.commit': 'old-builder' },
    };
    expect(classify(legacy)).toMatchObject({ disposition: 'protected', protectionReason: 'legacy-grace' });
  });

  it('never deletes unmanaged images', () => {
    expect(classify({ ...baseImage, repoTags: ['postgres:17'], labels: {} })).toMatchObject({
      disposition: 'unmanaged',
      protectionReason: 'unmanaged-image',
    });
  });
});
