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
// it and that session reclaim fails closed. Tests that exercise reclaim install
// a real in-memory sessions table, so status CAS (active -> archiving ->
// closed) is exercised against actual SQL rather than a hand-rolled fake.
const centralDbMock = vi.hoisted(() => ({ current: null as null | { db: Database.Database } }));
vi.mock('./db/connection.js', () => ({
  getDb: () => {
    if (!centralDbMock.current) throw new Error('central db unavailable in storage-manager unit test');
    return centralDbMock.current.db;
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
  finishInterruptedSessionArchivals,
  getStorageReport,
  pruneIdleSessionArtifacts,
  readReclaimJournal,
  type DockerImageInventory,
} from './storage-manager.js';
import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

// ── Shared session-reclaim fixtures ──────────────────────────────────────────

interface CentralSessionSeed {
  id: string;
  status: string;
  last_active: string | null;
  agent_group_id?: string;
}

function installCentralDb(
  seeds: CentralSessionSeed[],
  options: { activeTripleIndex?: boolean } = {},
): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_group_id TEXT NOT NULL DEFAULT 'ag-1',
    messaging_group_id TEXT,
    thread_id TEXT,
    status TEXT DEFAULT 'active',
    last_active TEXT,
    created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
  )`);
  if (options.activeTripleIndex) {
    // Migration 049, verbatim: the constraint releaseArchivingRow can hit.
    db.exec(`CREATE UNIQUE INDEX idx_sessions_active_triple
      ON sessions(agent_group_id, COALESCE(messaging_group_id, ''), COALESCE(thread_id, ''))
      WHERE status = 'active'`);
  }
  const insert = db.prepare(
    'INSERT INTO sessions (id, agent_group_id, status, last_active) VALUES (@id, @agent_group_id, @status, @last_active)',
  );
  for (const seed of seeds) {
    insert.run({ agent_group_id: 'ag-1', ...seed });
  }
  centralDbMock.current = { db };
  return db;
}

function closeCentralDb(): void {
  try {
    centralDbMock.current?.db.close();
  } catch {
    // Already closed by the test.
  }
  centralDbMock.current = null;
}

function sessionStatus(db: Database.Database, id: string): string | undefined {
  return (db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string } | undefined)?.status;
}

/** `tar -cf` writes a stub archive; `tar -tf` lists it. Anything else throws. */
function tarAwareExecFileSync(cmd: string, cmdArgs?: unknown): string {
  if (cmd === 'df') {
    return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 900 100 90% /\n';
  }
  if (cmd === 'tar') {
    const argv = cmdArgs as string[];
    const create = argv.indexOf('-cf');
    if (create >= 0) {
      fs.writeFileSync(argv[create + 1]!, 'fake-zstd-archive');
      return '';
    }
    const list = argv.indexOf('-tf');
    if (list >= 0) {
      const target = argv[list + 1]!;
      if (!fs.existsSync(target)) throw new Error(`tar -tf: no such archive ${target}`);
      return 'session/\n';
    }
  }
  throw new Error(`unexpected command ${cmd}`);
}

interface SessionDirOptions {
  /** Rows written into messages_in (defaults to none). */
  pending?: Array<{ status: string; trigger: number; process_after?: string | null }>;
  processingAck?: boolean;
  /** Raw session_state.work_continuation value. */
  workContinuation?: string;
}

function makeSessionDir(
  sessionsRoot: string,
  group: string,
  id: string,
  activityMs: number,
  options: SessionDirOptions = {},
): string {
  const dir = path.join(sessionsRoot, group, id);
  fs.mkdirSync(path.join(dir, 'creds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds', 'secret.json'), 'secret-material');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'human work');

  const inbound = new Database(path.join(dir, 'inbound.db'));
  inbound.exec(
    "CREATE TABLE messages_in (status TEXT NOT NULL DEFAULT 'completed', trigger INTEGER, process_after TEXT)",
  );
  for (const row of options.pending ?? []) {
    inbound
      .prepare('INSERT INTO messages_in (status, trigger, process_after) VALUES (?, ?, ?)')
      .run(row.status, row.trigger, row.process_after ?? null);
  }
  inbound.close();

  if (options.processingAck || options.workContinuation !== undefined) {
    const outbound = new Database(path.join(dir, 'outbound.db'));
    outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT)');
    outbound.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT)');
    if (options.processingAck) {
      outbound.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing')").run();
    }
    if (options.workContinuation !== undefined) {
      outbound.prepare("INSERT INTO session_state VALUES ('work_continuation', ?)").run(options.workContinuation);
    }
    outbound.close();
  }

  const seconds = activityMs / 1000;
  for (const name of ['inbound.db', 'outbound.db']) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) fs.utimesSync(target, seconds, seconds);
  }
  return dir;
}

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

  // Contract change (SR5, session-storage-health): this used to read
  // "treats only due triggered work as busy". A future-dated recurrence and an
  // unconsumed accumulated row are both real work a reclaim must not race.
  it('treats any unconsumed inbound row as busy, due or not', () => {
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
    expect(plannedPaths).not.toContain(path.join(chatterDir, 'worktrees', 'repo', '.turbo'));
    expect(plannedPaths).not.toContain(path.join(futureDir, 'worktrees', 'repo', '.turbo'));
    expect(plannedPaths).not.toContain(path.join(dueDir, 'worktrees', 'repo', '.turbo'));
    expect(report.skipped.busySessions).toBe(3);
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

  // A legacy DB missing only the scheduling columns is now fully evaluable —
  // the blocker predicate reads `status` alone — so fail-closed is reserved
  // for a session whose inbound DB genuinely cannot be read.
  it('fails closed when a session inbound database cannot be read', () => {
    const legacyDir = makeSession({ id: 'sess-unreadable' });
    const inboundPath = path.join(legacyDir, 'inbound.db');
    fs.rmSync(inboundPath);
    fs.writeFileSync(inboundPath, 'this is not a sqlite database');

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
    closeCentralDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-sess-reclaim-'));
    mockExecFileSync.mockImplementation(tarAwareExecFileSync);
  });

  afterEach(() => {
    closeCentralDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeIdleSession(id: string, idleMs: number): string {
    return makeSessionDir(path.join(tmpRoot, 'v2-sessions'), 'ag-1', id, now - idleMs);
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
    const db = installCentralDb([{ id: 'sess-old', status: 'active', last_active: iso(31 * DAY) }]);

    const report = runApply();

    const action = report.actions.find((a) => a.kind === 'archive-session');
    expect(action?.status).toBe('applied');
    expect(sessionStatus(db, 'sess-old')).toBe('closed');
    expect(fs.existsSync(dir)).toBe(false);
    const rescues = fs.readdirSync(path.join(tmpRoot, 'session-rescues'));
    expect(rescues.some((f) => f.startsWith('ag-1__sess-old-') && f.endsWith('.tar.zst'))).toBe(true);
    const tarCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall?.[1]).toContain('--exclude=creds');
  });

  it('holds a session whose central row shows fresh activity, whatever the dir mtime says', () => {
    const dir = makeIdleSession('sess-db-fresh', 31 * DAY);
    const db = installCentralDb([{ id: 'sess-db-fresh', status: 'active', last_active: iso(1 * DAY) }]);

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(sessionStatus(db, 'sess-db-fresh')).toBe('active');
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
    installCentralDb([]);

    const report = runApply();

    const action = report.actions.find((a) => a.kind === 'archive-session');
    expect(action?.status).toBe('applied');
    expect(fs.existsSync(dir)).toBe(false);
  });
});

// T5 (SR5) — the two blocker gaps the reaper plan closes, plus the literal
// "ANY pending row" reading recorded in run.md.
describe('storage-manager session open-work blockers', () => {
  let tmpRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    closeCentralDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-open-work-'));
    mockExecFileSync.mockImplementation(tarAwareExecFileSync);
  });

  afterEach(() => {
    closeCentralDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

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

  function seed(id: string, options: SessionDirOptions): string {
    const dir = makeSessionDir(path.join(tmpRoot, 'v2-sessions'), 'ag-1', id, now - 40 * DAY, options);
    installCentralDb([{ id, status: 'active', last_active: new Date(now - 40 * DAY).toISOString() }]);
    return dir;
  }

  it('blocks a session whose only pending trigger row is scheduled in the future', () => {
    const dir = seed('sess-future', {
      pending: [{ status: 'pending', trigger: 1, process_after: new Date(now + 7 * DAY).toISOString() }],
    });

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
    expect(report.skipped.busySessions).toBe(1);
  });

  it('blocks a session holding a live work_continuation promise', () => {
    const dir = seed('sess-continuation', {
      workContinuation: JSON.stringify({ id: 'wc-1', task: 'finish the migration', phase: 'queued', chain: 1 }),
    });

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
    expect(report.skipped.busySessions).toBe(1);
  });

  it('blocks a session with an unconsumed non-triggering inbound row', () => {
    const dir = seed('sess-accumulated', { pending: [{ status: 'pending', trigger: 0 }] });

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('archives an idle session with no pending rows and no continuation', () => {
    const dir = seed('sess-clean', { workContinuation: '' });

    const report = runApply();

    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('applied');
    expect(fs.existsSync(dir)).toBe(false);
  });

  // A lazy inbound.db schema migration rewrites the whole fleet's inbound
  // files at once (2026-08-15, again 2026-08-25). While the 24h freshness gate
  // read inbound.db, that single event made every session look fresh and
  // stalled the reaper for a day. Both idle gates now read the age signal.
  it('archives a session whose inbound.db was just rewritten but whose age signals are stale', () => {
    const dir = seed('sess-migrated-inbound', { workContinuation: '' });
    const justNow = now / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), justNow, justNow);
    expect(fs.statSync(path.join(dir, 'outbound.db')).mtimeMs).toBeLessThan(now - 30 * DAY);

    const report = runApply();

    expect(report.skipped.freshSessions).toBe(0);
    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('applied');
    expect(fs.existsSync(dir)).toBe(false);
  });

  // The other half of the same rule: inbound is dropped from the idle gates
  // because a migration rewrites it, NOT because inbound activity stopped
  // counting. A real unconsumed row still blocks, even at the same mtime.
  it('still blocks a freshly rewritten inbound.db that carries a pending row', () => {
    const dir = seed('sess-migrated-pending', { pending: [{ status: 'pending', trigger: 1 }] });
    const justNow = now / 1000;
    fs.utimesSync(path.join(dir, 'inbound.db'), justNow, justNow);

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(report.skipped.busySessions).toBe(1);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// T2b (SR2b) — the archival lifecycle is crash-safe and re-validates inside apply.
describe('storage-manager session archival lifecycle', () => {
  let tmpRoot: string;
  let sessionsRoot: string;
  let rescuesDir: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    closeCentralDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-lifecycle-'));
    sessionsRoot = path.join(tmpRoot, 'v2-sessions');
    rescuesDir = path.join(tmpRoot, 'session-rescues');
    mockExecFileSync.mockImplementation(tarAwareExecFileSync);
  });

  afterEach(() => {
    closeCentralDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seedOne(id = 'sess-old'): string {
    const dir = makeSessionDir(sessionsRoot, 'ag-1', id, now - 40 * DAY);
    installCentralDb([{ id, status: 'active', last_active: new Date(now - 40 * DAY).toISOString() }]);
    return dir;
  }

  function runApply(isContainerRunning?: (sessionId: string) => boolean) {
    return getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      ...(isContainerRunning ? { isContainerRunning } : {}),
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
    });
  }

  it('leaves the session active and the dir intact when the archive cannot be produced', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'tar' && (cmdArgs as string[]).includes('-cf')) throw new Error('zstd: no space left on device');
      return tarAwareExecFileSync(cmd, cmdArgs);
    });

    const report = runApply();

    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('failed');
    expect(sessionStatus(db, 'sess-old')).toBe('active');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true);
    const leftovers = fs.existsSync(rescuesDir) ? fs.readdirSync(rescuesDir) : [];
    expect(leftovers.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('skips a session whose container starts between collection and apply', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    let calls = 0;
    const report = runApply(() => {
      calls += 1;
      return calls > 1; // idle during collection, running by the time apply revalidates
    });

    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('skipped');
    expect(sessionStatus(db, 'sess-old')).toBe('active');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true);
  });

  it('journals every archival with its prior status and rescue path', () => {
    seedOne();

    expect(runApply().actions.find((a) => a.kind === 'archive-session')?.status).toBe('applied');

    const journal = readReclaimJournal(rescuesDir);
    const entry = journal.get('sess-old');
    expect(entry).toMatchObject({ session_id: 'sess-old', agent_group_id: 'ag-1', prior_status: 'active' });
    expect(fs.existsSync(entry!.rescue_path)).toBe(true);
    expect(entry!.rescue_path.endsWith('.tar.zst')).toBe(true);
  });

  it('finishes an archival interrupted after publish, exactly once', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    // Reproduce the crash window: archive published and journalled, row still
    // 'archiving', dir not yet removed.
    fs.mkdirSync(rescuesDir, { recursive: true });
    const rescuePath = path.join(rescuesDir, 'ag-1__sess-old-2026-06-30T00-00-00-000Z.tar.zst');
    fs.writeFileSync(rescuePath, 'fake-zstd-archive');
    fs.writeFileSync(
      path.join(rescuesDir, 'reclaim-journal.jsonl'),
      `${JSON.stringify({
        ts: '2026-06-30T00:00:00.000Z',
        session_id: 'sess-old',
        agent_group_id: 'ag-1',
        prior_status: 'active',
        rescue_path: rescuePath,
      })}\n`,
    );
    db.prepare("UPDATE sessions SET status = 'archiving' WHERE id = 'sess-old'").run();

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 0, finished: 1 });
    expect(sessionStatus(db, 'sess-old')).toBe('closed');
    expect(fs.existsSync(dir)).toBe(false);

    // Idempotent: a second startup finds nothing left to do.
    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 0, finished: 0 });
  });

  it('returns an archiving row with an intact dir to active and clears the temp archive', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    fs.mkdirSync(rescuesDir, { recursive: true });
    const tempPath = path.join(rescuesDir, 'ag-1__sess-old-2026-06-30T00-00-00-000Z.tar.zst.tmp');
    fs.writeFileSync(tempPath, 'half-written');
    db.prepare("UPDATE sessions SET status = 'archiving' WHERE id = 'sess-old'").run();

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 1, finished: 0 });
    expect(sessionStatus(db, 'sess-old')).toBe('active');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('never removes a closed session dir the journal does not vouch for', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = 'sess-old'").run();

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 0, finished: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('skips a session the collection pass saw as already archiving', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    db.prepare("UPDATE sessions SET status = 'archiving' WHERE id = 'sess-old'").run();

    const report = runApply();

    expect(report.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps the dir when the closing CAS finds the row is no longer ours', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'tar' && (cmdArgs as string[]).includes('-cf')) {
        // Something reclaimed the row while the tar ran.
        db.prepare("UPDATE sessions SET status = 'active' WHERE id = 'sess-old'").run();
      }
      return tarAwareExecFileSync(cmd, cmdArgs);
    });

    const report = runApply();

    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('skipped');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true);
    expect(sessionStatus(db, 'sess-old')).toBe('active');
  });

  it('does not treat an unlistable archive as published', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    fs.mkdirSync(rescuesDir, { recursive: true });
    const rescuePath = path.join(rescuesDir, 'ag-1__sess-old-2026-06-30T00-00-00-000Z.tar.zst');
    fs.writeFileSync(rescuePath, 'truncated');
    fs.writeFileSync(
      path.join(rescuesDir, 'reclaim-journal.jsonl'),
      `${JSON.stringify({
        ts: '2026-06-30T00:00:00.000Z',
        session_id: 'sess-old',
        agent_group_id: 'ag-1',
        prior_status: 'active',
        rescue_path: rescuePath,
      })}\n`,
    );
    db.prepare("UPDATE sessions SET status = 'archiving' WHERE id = 'sess-old'").run();
    // tar -tf fails on this archive, so it cannot license removing the dir.
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'tar' && (cmdArgs as string[]).includes('-tf')) throw new Error('unexpected end of file');
      return tarAwareExecFileSync(cmd, cmdArgs);
    });

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 1, finished: 0 });
    expect(sessionStatus(db, 'sess-old')).toBe('active');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('re-archives an orphan closed dir through the ordinary walk instead of a journal-driven delete', () => {
    // A crash between the closing CAS and the rm leaves this shape. There is
    // no journal-gated deletion pass any more; the normal reclaim path is the
    // recovery, which means a stale journal line can never authorize a delete.
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    fs.mkdirSync(rescuesDir, { recursive: true });
    const rescuePath = path.join(rescuesDir, 'ag-1__sess-old-2026-06-30T00-00-00-000Z.tar.zst');
    fs.writeFileSync(rescuePath, 'fake-zstd-archive');
    fs.writeFileSync(
      path.join(rescuesDir, 'reclaim-journal.jsonl'),
      `${JSON.stringify({
        ts: '2026-06-30T00:00:00.000Z',
        session_id: 'sess-old',
        agent_group_id: 'ag-1',
        prior_status: 'active',
        rescue_path: rescuePath,
      })}\n`,
    );
    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = 'sess-old'").run();

    // Startup does nothing to it…
    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ finished: 0, lost: 0, failed: 0 });
    expect(fs.existsSync(dir)).toBe(true);

    // …and the next maintenance tick reclaims it as an ordinary closed dir.
    const report = runApply();
    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('applied');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('closes an archiving row whose triple a newer session already claimed', () => {
    const dir = seedOne();
    const db = installCentralDb(
      [
        { id: 'sess-old', status: 'archiving', last_active: new Date(now - 40 * DAY).toISOString() },
        { id: 'sess-new', status: 'active', last_active: new Date(now).toISOString() },
      ],
      { activeTripleIndex: true },
    );

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ released: 1, failed: 0 });
    expect(sessionStatus(db, 'sess-old')).toBe('closed');
    expect(sessionStatus(db, 'sess-new')).toBe('active');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('leaves an archiving row alone when the write fails for any other reason', () => {
    const dir = seedOne();
    // A read-only central DB fails the UPDATE with SQLITE_READONLY — not a
    // constraint, so it must NOT be laundered into a silent close.
    const dbPath = path.join(tmpRoot, 'central.sqlite');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, status TEXT, last_active TEXT)');
    seed.prepare("INSERT INTO sessions VALUES ('sess-old', 'ag-1', 'archiving', NULL)").run();
    seed.close();
    closeCentralDb();
    centralDbMock.current = { db: new Database(dbPath, { readonly: true }) };

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ failed: 1, released: 0, lost: 0 });
    expect(sessionStatus(centralDbMock.current!.db, 'sess-old')).toBe('archiving');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('reports a lost session rather than counting it as finished', () => {
    seedOne();
    const db = centralDbMock.current!.db;
    db.prepare("UPDATE sessions SET status = 'archiving' WHERE id = 'sess-old'").run();
    fs.rmSync(path.join(sessionsRoot, 'ag-1', 'sess-old'), { recursive: true, force: true });

    expect(finishInterruptedSessionArchivals(sessionsRoot)).toMatchObject({ lost: 1, finished: 0, released: 0 });
    expect(sessionStatus(db, 'sess-old')).toBe('closed');
    expect(vi.mocked(log.error).mock.calls.some((c) => String(c[0]).includes('lost with no readable rescue'))).toBe(
      true,
    );
  });

  // T2c (plan Rollback) — the documented restore is mechanical, and it refuses
  // to guess when a newer session has taken the triple.
  it('restores an archived session from its journal line and resumes', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    expect(runApply().actions.find((a) => a.kind === 'archive-session')?.status).toBe('applied');
    expect(fs.existsSync(dir)).toBe(false);

    const entry = readReclaimJournal(rescuesDir).get('sess-old')!;
    expect(entry.prior_status).toBe('active');
    expect(fs.existsSync(entry.rescue_path)).toBe(true);

    // The documented procedure: re-create the dir from the rescue archive, put
    // the row back to the journalled prior status.
    makeSessionDir(sessionsRoot, 'ag-1', 'sess-old', now - 1 * DAY);
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(entry.prior_status, 'sess-old');

    expect(sessionStatus(db, 'sess-old')).toBe('active');
    // Fresh enough to be off the reclaim path again, and readable.
    const resumed = runApply();
    expect(resumed.actions.filter((a) => a.kind === 'archive-session')).toEqual([]);
    expect(fs.existsSync(path.join(sessionsRoot, 'ag-1', 'sess-old', 'inbound.db'))).toBe(true);
  });

  it('refuses to guess when a newer session already owns the restored triple', () => {
    const db = installCentralDb(
      [
        { id: 'sess-old', status: 'closed', last_active: new Date(now - 40 * DAY).toISOString() },
        { id: 'sess-new', status: 'active', last_active: new Date(now).toISOString() },
      ],
      { activeTripleIndex: true },
    );
    makeSessionDir(sessionsRoot, 'ag-1', 'sess-old', now - 1 * DAY);

    // Restoring the old row to 'active' collides — both artifacts survive and
    // the conflict surfaces instead of one silently winning.
    expect(() => db.prepare("UPDATE sessions SET status = 'active' WHERE id = 'sess-old'").run()).toThrow(
      /UNIQUE constraint/,
    );
    expect(sessionStatus(db, 'sess-old')).toBe('closed');
    expect(sessionStatus(db, 'sess-new')).toBe('active');
    expect(fs.existsSync(path.join(sessionsRoot, 'ag-1', 'sess-old', 'inbound.db'))).toBe(true);
  });

  it('skips a session touched by a write between collection and apply', () => {
    const dir = seedOne();
    const db = centralDbMock.current!.db;
    let calls = 0;
    const report = runApply(() => {
      calls += 1;
      if (calls > 1) {
        const fresh = now / 1000;
        fs.utimesSync(path.join(dir, 'inbound.db'), fresh, fresh);
      }
      return false;
    });

    expect(report.actions.find((a) => a.kind === 'archive-session')?.status).toBe('skipped');
    expect(sessionStatus(db, 'sess-old')).toBe('active');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).toBe(true);
  });
});

// T2 (SR2) + T3 (SR3) + T4 (SR4/SR4b) — the reclaim budget, the session-specific
// age knob, and the count-cap union selection.
describe('storage-manager session reclaim budget and selection', () => {
  let tmpRoot: string;
  let sessionsRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    closeCentralDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-budget-'));
    sessionsRoot = path.join(tmpRoot, 'v2-sessions');
    mockExecFileSync.mockImplementation(tarAwareExecFileSync);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeCentralDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** `count` sessions, sess-000 oldest. Returns their ids, oldest first. */
  function seedAgedSessions(count: number, oldestDays: number, options: SessionDirOptions = {}): string[] {
    const ids: string[] = [];
    const seeds: CentralSessionSeed[] = [];
    for (let i = 0; i < count; i++) {
      const id = `sess-${String(i).padStart(3, '0')}`;
      const ageMs = (oldestDays - i) * DAY;
      makeSessionDir(sessionsRoot, 'ag-1', id, now - ageMs, options);
      seeds.push({ id, status: 'active', last_active: new Date(now - ageMs).toISOString() });
      ids.push(id);
    }
    installCentralDb(seeds);
    return ids;
  }

  function runApply(policy: Record<string, number> = {}) {
    return getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY, ...policy },
    });
  }

  function archivedIds(report: ReturnType<typeof getStorageReport>): string[] {
    return report.actions
      .filter((a) => a.kind === 'archive-session' && a.status === 'applied')
      .map((a) => path.basename(a.path!))
      .sort();
  }

  it('archives at most the per-tick budget, oldest-idle first, and drains the rest next pass', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', '50');
    const ids = seedAgedSessions(120, 150);

    const first = runApply();
    expect(archivedIds(first)).toEqual(ids.slice(0, 50).sort());

    _resetStorageManagerThrottleForTesting();
    const second = runApply();
    expect(archivedIds(second)).toEqual(ids.slice(50, 100).sort());
  }, 60_000);

  it('shares one budget across overlapping maintenance and force entry points', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', '50');
    seedAgedSessions(120, 150);

    let reentered = false;
    const archivedInner: string[] = [];
    mockExecFileSync.mockImplementation((cmd: string, cmdArgs?: unknown) => {
      if (cmd === 'df' && !reentered) {
        reentered = true;
        // A second pass starting while this one is open must not get a second
        // budget — the force entry point shares the same module-level pool.
        const inner = getStorageReport({
          mode: 'apply',
          now,
          sessionsRoot,
          threadsRoot: path.join(tmpRoot, 'no-threads'),
          includeDocker: false,
          force: true,
          policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
        });
        archivedInner.push(...archivedIds(inner));
      }
      return tarAwareExecFileSync(cmd, cmdArgs);
    });

    const outer = runApply();

    expect(archivedInner.length + archivedIds(outer).length).toBe(50);
  }, 60_000);

  it('does not hand a second budget to a sequential force pass inside the same epoch', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', '50');
    seedAgedSessions(120, 150);

    const first = runApply();
    // No throttle reset: a second pass minutes later is the SAME lease.
    const second = getStorageReport({
      mode: 'apply',
      now: now + 60_000,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      force: true,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
    });

    expect(archivedIds(first).length + archivedIds(second).length).toBe(50);
  }, 60_000);

  it('draws the exported prune entry point from the same epoch budget', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', '50');
    seedAgedSessions(120, 150);

    const first = runApply();
    const before = fs.readdirSync(path.join(sessionsRoot, 'ag-1')).length;
    pruneIdleSessionArtifacts(now + 60_000, sessionsRoot, () => false);
    const after = fs.readdirSync(path.join(sessionsRoot, 'ag-1')).length;

    expect(archivedIds(first).length).toBe(50);
    expect(before - after).toBe(0);
  }, 60_000);

  it('opens a fresh budget once the epoch has elapsed', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', '50');
    const ids = seedAgedSessions(120, 150);

    expect(archivedIds(runApply()).length).toBe(50);
    const later = getStorageReport({
      mode: 'apply',
      now: now + 46 * 60 * 1000,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
    });
    expect(archivedIds(later)).toEqual(ids.slice(50, 100).sort());
  }, 60_000);

  it('uses the session-specific reclaim knob without moving thread worktrees', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_DAYS', '14');
    seedAgedSessions(1, 20);
    const threadDir = path.join(tmpRoot, 'v2-threads', 'thread-a');
    fs.mkdirSync(path.join(threadDir, 'worktrees', 'repo'), { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'worktrees', 'repo', 'notes.md'), 'human work');
    const threadMtime = (now - 20 * DAY) / 1000;
    fs.utimesSync(path.join(threadDir, 'worktrees'), threadMtime, threadMtime);

    const report = getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'v2-threads'),
      includeDocker: false,
      policy: { filesystemPath: tmpRoot, idleArtifactMs: 1 * DAY, worktreeReclaimMs: 30 * DAY },
    });

    expect(archivedIds(report)).toEqual(['sess-000']);
    expect(report.actions.filter((a) => a.kind === 'archive-thread-worktree')).toEqual([]);
    expect(fs.existsSync(path.join(threadDir, 'worktrees', 'repo', 'notes.md'))).toBe(true);
  });

  it('falls back to the shared worktree knob when the session knob is unset', () => {
    seedAgedSessions(1, 20);

    expect(archivedIds(runApply())).toEqual([]);
  });

  it('archives only the count-cap overflow, oldest-idle first, when nothing is age-eligible', () => {
    vi.stubEnv('NANOCLAW_SESSION_ACTIVE_CAP', '5');
    const ids = seedAgedSessions(8, 10);

    expect(archivedIds(runApply())).toEqual(ids.slice(0, 3).sort());
  });

  it('lets the next-oldest take an overflow slot a blocked session cannot use', () => {
    vi.stubEnv('NANOCLAW_SESSION_ACTIVE_CAP', '7');
    const ids = seedAgedSessions(8, 10);
    // Re-seed the oldest with open work so it is skipped before selection.
    fs.rmSync(path.join(sessionsRoot, 'ag-1', ids[0]!), { recursive: true, force: true });
    makeSessionDir(sessionsRoot, 'ag-1', ids[0]!, now - 10 * DAY, {
      pending: [{ status: 'pending', trigger: 1 }],
    });

    expect(archivedIds(runApply())).toEqual([ids[1]!]);
  });

  it('disables the count cap at zero', () => {
    vi.stubEnv('NANOCLAW_SESSION_ACTIVE_CAP', '0');
    seedAgedSessions(8, 10);

    expect(archivedIds(runApply())).toEqual([]);
  });

  it('dedupes age-eligible and overflow candidates into one oldest-first selection', () => {
    vi.stubEnv('NANOCLAW_SESSION_ACTIVE_CAP', '6');
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_DAYS', '30');
    // sess-000/001 are 40d and 39d idle (age-eligible); the rest are young.
    const ids: string[] = [];
    const seeds: CentralSessionSeed[] = [];
    const ages = [40, 39, 10, 9, 8, 7, 6, 5];
    ages.forEach((days, i) => {
      const id = `sess-${String(i).padStart(3, '0')}`;
      makeSessionDir(sessionsRoot, 'ag-1', id, now - days * DAY);
      seeds.push({ id, status: 'active', last_active: new Date(now - days * DAY).toISOString() });
      ids.push(id);
    });
    installCentralDb(seeds);

    // 8 active - cap 6 = 2 overflow slots, plus the 2 age-eligible rows.
    expect(archivedIds(runApply())).toEqual(ids.slice(0, 4).sort());
  });

  it('falls back to knob defaults with one warning and logs the resolved config once', () => {
    vi.stubEnv('NANOCLAW_SESSION_RECLAIM_PER_TICK', 'not-a-number');
    vi.stubEnv('NANOCLAW_SESSION_ACTIVE_CAP', '-4');
    seedAgedSessions(2, 150);

    const report = runApply();

    expect(archivedIds(report).length).toBe(2);
    const warned = vi
      .mocked(log.warn)
      .mock.calls.filter((call) => String(call[0]).includes('invalid session reclaim knob'));
    expect(warned.map((call) => (call[1] as { knob: string }).knob).sort()).toEqual([
      'NANOCLAW_SESSION_ACTIVE_CAP',
      'NANOCLAW_SESSION_RECLAIM_PER_TICK',
    ]);
    const configLines = vi
      .mocked(log.info)
      .mock.calls.filter((call) => String(call[0]).includes('session reclaim config'));
    expect(configLines).toHaveLength(1);
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
        RepoTags: [`${CONTAINER_IMAGE_BASE}:candidate-old`],
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
        'nanoclaw.retention.owner': 'candidate-session',
      },
    });

    expect(result).toMatchObject({
      disposition: 'protected',
      protectionReason: 'retention-lease',
      owner: 'candidate-session',
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

// The three mechanisms that decide whether the reclaimer keeps up with session
// creation: what counts as "old", how many archivals a pass may do, and what
// eventually removes the archives it writes.
describe('storage-manager reclaim throughput', () => {
  let tmpRoot: string;
  let sessionsRoot: string;
  const now = Date.parse('2026-06-30T00:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStorageManagerThrottleForTesting();
    closeCentralDb();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-throughput-'));
    sessionsRoot = path.join(tmpRoot, 'v2-sessions');
    mockExecFileSync.mockImplementation(tarAwareExecFileSync);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeCentralDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** A session dir with an independently settable mtime per file. */
  function seedSession(id: string, mtimes: { inbound: number; outbound: number }): string {
    const dir = makeSessionDir(sessionsRoot, 'ag-1', id, mtimes.inbound, { processingAck: false });
    const outbound = new Database(path.join(dir, 'outbound.db'));
    outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT)');
    outbound.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT)');
    outbound.close();
    fs.utimesSync(path.join(dir, 'outbound.db'), mtimes.outbound / 1000, mtimes.outbound / 1000);
    fs.utimesSync(path.join(dir, 'inbound.db'), mtimes.inbound / 1000, mtimes.inbound / 1000);
    return dir;
  }

  function runApply(policy: Record<string, number> = {}) {
    return getStorageReport({
      mode: 'apply',
      now,
      sessionsRoot,
      threadsRoot: path.join(tmpRoot, 'no-threads'),
      includeDocker: false,
      policy: {
        filesystemPath: tmpRoot,
        idleArtifactMs: 1 * DAY,
        worktreeReclaimMs: 30 * DAY,
        sessionReclaimMs: 14 * DAY,
        ...policy,
      },
    });
  }

  function archivedIds(report: ReturnType<typeof getStorageReport>): string[] {
    return report.actions
      .filter((a) => a.kind === 'archive-session' && a.status === 'applied')
      .map((a) => path.basename(a.path!))
      .sort();
  }

  // Regression for the 2026-08-15 fleet-wide inbound.db rewrite: a lazy on-open
  // schema migration touched 5,027 inbound.db files in two minutes and the age
  // gate read every one of those sessions as two days old.
  it('a schema-migration touch on inbound.db does not reset the age clock', () => {
    seedSession('sess-migrated', { inbound: now - 2 * DAY, outbound: now - 40 * DAY });
    installCentralDb([{ id: 'sess-migrated', status: 'active', last_active: new Date(now - 40 * DAY).toISOString() }]);

    expect(archivedIds(runApply())).toEqual(['sess-migrated']);
  });

  // The other half of the same rule: outbound.db and the central row still get
  // to veto, so a session a container really touched is never reclaimed.
  it('real container activity still holds a session out of the age gate', () => {
    seedSession('sess-live', { inbound: now - 40 * DAY, outbound: now - 2 * DAY });
    installCentralDb([{ id: 'sess-live', status: 'active', last_active: new Date(now - 40 * DAY).toISOString() }]);

    expect(archivedIds(runApply())).toEqual([]);
    expect(fs.existsSync(path.join(sessionsRoot, 'ag-1', 'sess-live'))).toBe(true);
  });

  it('a central row newer than every file still holds the session out', () => {
    seedSession('sess-db-fresh', { inbound: now - 40 * DAY, outbound: now - 40 * DAY });
    installCentralDb([{ id: 'sess-db-fresh', status: 'active', last_active: new Date(now - 2 * DAY).toISOString() }]);

    expect(archivedIds(runApply())).toEqual([]);
  });

  it('stops archiving once the pass spends its wall-clock budget', () => {
    for (let i = 0; i < 3; i++) seedSession(`sess-${i}`, { inbound: now - 40 * DAY, outbound: now - 40 * DAY });
    installCentralDb(
      [0, 1, 2].map((i) => ({
        id: `sess-${i}`,
        status: 'active',
        last_active: new Date(now - 40 * DAY).toISOString(),
      })),
    );

    // 0ms of archiving time: every archive action is planned and then skipped,
    // and the dirs survive for the next pass.
    const report = runApply({ sessionReclaimMaxMs: 0 });
    const archiveActions = report.actions.filter((a) => a.kind === 'archive-session');
    expect(archiveActions).toHaveLength(3);
    expect(archiveActions.every((a) => a.status === 'skipped')).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(fs.existsSync(path.join(sessionsRoot, 'ag-1', `sess-${i}`))).toBe(true);
    }

    _resetStorageManagerThrottleForTesting();
    expect(archivedIds(runApply())).toEqual(['sess-0', 'sess-1', 'sess-2']);
  }, 30_000);

  it('prunes rescue archives past the retention window and keeps the journal', () => {
    fs.mkdirSync(sessionsRoot, { recursive: true });
    installCentralDb([]);
    const files: Array<[string, string, number]> = [
      ['session-rescues', 'old.tar.zst', now - 40 * DAY],
      ['session-rescues', 'recent.tar.zst', now - 10 * DAY],
      ['session-rescues', 'reclaim-journal.jsonl', now - 40 * DAY],
      ['thread-rescues', 'old-thread.tar.zst', now - 40 * DAY],
      ['thread-rescues', 'recent-thread.tar.zst', now - 10 * DAY],
    ];
    for (const [dir, name, mtime] of files) {
      fs.mkdirSync(path.join(tmpRoot, dir), { recursive: true });
      const full = path.join(tmpRoot, dir, name);
      fs.writeFileSync(full, 'payload');
      fs.utimesSync(full, mtime / 1000, mtime / 1000);
    }

    runApply({ rescueRetentionMs: 30 * DAY });

    const survives = (dir: string, name: string) => fs.existsSync(path.join(tmpRoot, dir, name));
    expect(survives('session-rescues', 'old.tar.zst')).toBe(false);
    expect(survives('thread-rescues', 'old-thread.tar.zst')).toBe(false);
    expect(survives('session-rescues', 'recent.tar.zst')).toBe(true);
    expect(survives('thread-rescues', 'recent-thread.tar.zst')).toBe(true);
    // The journal outlives the archives — it is the record of what was taken.
    expect(survives('session-rescues', 'reclaim-journal.jsonl')).toBe(true);
  });

  it('leaves rescue archives alone when retention is disabled', () => {
    fs.mkdirSync(sessionsRoot, { recursive: true });
    installCentralDb([]);
    fs.mkdirSync(path.join(tmpRoot, 'session-rescues'), { recursive: true });
    const full = path.join(tmpRoot, 'session-rescues', 'ancient.tar.zst');
    fs.writeFileSync(full, 'payload');
    fs.utimesSync(full, (now - 400 * DAY) / 1000, (now - 400 * DAY) / 1000);

    runApply({ rescueRetentionMs: 0 });
    expect(fs.existsSync(full)).toBe(true);
  });
});
