import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';
import { SourceIngester, setIngestDb } from './source-ingest.js';
import type { MemoryStore, RememberResult } from '../modules/memory/store.js';
import type { HealthRecorder } from './health.js';
import { setDeadLettersDb } from './dead-letters.js';

vi.mock('./anthropic-client.js', () => ({
  callClassifier: vi.fn(),
  CLASSIFIER_VERSION: 'v1',
  PROMPT_VERSION: 'v1',
  EXTRACTOR_VERSION: 'v1',
}));

/**
 * processInboxFile reads through an O_NOFOLLOW file descriptor with
 * fstat + /proc/self/fd readlink validation, closing the TOCTOU race
 * (Codex finding #2 round 2). Tests use synthetic paths (e.g. /tmp/test.txt)
 * that may not exist on disk; this helper stubs realpath/open/fstat/readlink/
 * read/close so the synthetic path appears to be a regular file inside the
 * inbox containing `fileContent`.
 *
 * Returns the resolved path the test should use for subsequent assertions
 * (since the production code reassigns filePath = fdRealPath).
 */
function stubProcessInboxFileValidation(filePath: string, folder: string, fileContent: string): string {
  const inboxPath = path.join(GROUPS_DIR, folder, 'sources', 'inbox');
  const fileName = path.basename(filePath);
  const stubbedRealPath = path.join(inboxPath, fileName);
  const FAKE_FD = 999;
  const contentBuf = Buffer.from(fileContent, 'utf8');

  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s === inboxPath) return inboxPath;
    return stubbedRealPath;
  }) as unknown as typeof fs.realpathSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((..._args: unknown[]) => FAKE_FD) as unknown as typeof fs.openSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((..._args: unknown[]) =>
    ({
      isFile: () => true,
      size: contentBuf.length,
    }) as fs.Stats) as unknown as typeof fs.fstatSync);
  vi.spyOn(fs, 'readlinkSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s === `/proc/self/fd/${FAKE_FD}`) return stubbedRealPath;
    throw new Error(`unexpected readlinkSync(${s})`);
  }) as unknown as typeof fs.readlinkSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((
    _fd: number,
    buf: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    _position: number | bigint | null,
  ) => {
    const view = buf as unknown as Buffer;
    const remaining = contentBuf.length - offset;
    const toCopy = Math.min(length, remaining);
    contentBuf.copy(view, offset, offset, offset + toCopy);
    return toCopy;
  }) as unknown as typeof fs.readSync);
  vi.spyOn(fs, 'closeSync').mockImplementation((() => undefined) as unknown as typeof fs.closeSync);
  return stubbedRealPath;
}

import { callClassifier } from './anthropic-client.js';

function makeIngestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processed_sources (
      agent_group_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      source_path TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      facts_written INTEGER NOT NULL,
      PRIMARY KEY (agent_group_id, content_sha256, extractor_version, prompt_version)
    );
    CREATE TABLE dead_letters (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      agent_group_id TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempted_at TEXT NOT NULL,
      next_retry_at TEXT,
      poisoned_at TEXT,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letters_retry
      ON dead_letters(next_retry_at) WHERE poisoned_at IS NULL;
  `);
  return db;
}

function makeStore(overrides?: Partial<MemoryStore>): MemoryStore {
  return {
    recall: vi.fn().mockResolvedValue({ facts: [], totalAvailable: 0, latencyMs: 0, fromCache: false }),
    remember: vi.fn().mockResolvedValue({ action: 'added', factId: 'fact-1' } as RememberResult),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeHealth(): HealthRecorder {
  return {
    recordTurnClassified: vi.fn(),
    recordClassifierFailure: vi.fn(),
    recordSourceIngest: vi.fn(),
    recordRecallLatency: vi.fn(),
    recordRecallFailOpen: vi.fn(),
    recordRedaction: vi.fn(),
    recordSynthesiseSucceeded: vi.fn(),
    recordMemoryEnabledCheckFailure: vi.fn(),
    setPrereqVerification: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as HealthRecorder;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SourceIngester', () => {
  it('test_atomic_write_event_mask — FSWatcher uses change/rename events, not IN_CREATE only', () => {
    // Verify that the source code subscribes to 'change' and 'rename' events (which map to
    // IN_CLOSE_WRITE and IN_MOVED_TO in Linux inotify), NOT just 'rename' (which maps to IN_CREATE).
    // The implementation comments explain: 'change' = IN_CLOSE_WRITE, 'rename' = IN_MOVED_TO.
    const src = fs.readFileSync(new URL('./source-ingest.ts', import.meta.url), 'utf8');

    // Must subscribe to 'change' events (covers IN_CLOSE_WRITE)
    expect(src).toContain("eventType !== 'rename' && eventType !== 'change'");
    // Must NOT subscribe to IN_CREATE-only logic (no unconditional rename-only filter)
    expect(src).toContain('IN_CLOSE_WRITE');
    expect(src).toContain('IN_MOVED_TO');
    // Must NOT have IN_CREATE in the event subscription logic
    expect(src).not.toContain('IN_CREATE');
  });

  it('test_reconcile_opens_and_closes — reconcile closes removed, opens new, leaves existing', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    const ingester = new SourceIngester();

    // Mock fs.watch to avoid real filesystem operations
    const mockWatcherA = { on: vi.fn().mockReturnThis(), close: vi.fn() };
    const mockWatcherB = { on: vi.fn().mockReturnThis(), close: vi.fn() };
    const mockWatcherC = { on: vi.fn().mockReturnThis(), close: vi.fn() };

    let watchCallCount = 0;
    const watchers = [mockWatcherA, mockWatcherB, mockWatcherC];
    const fsWatchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      return watchers[watchCallCount++] as unknown as fs.FSWatcher;
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    // Open watchers for A and B
    const result1 = ingester.reconcileWatchers([
      { agentGroupId: 'A', folder: 'group-a', enabled: true },
      { agentGroupId: 'B', folder: 'group-b', enabled: true },
    ]);

    expect(result1.opened).toBe(2);
    expect(result1.closed).toBe(0);
    expect(fsWatchSpy).toHaveBeenCalledTimes(2);

    // Reconcile: A=enabled, B=disabled, C=enabled (new)
    const result2 = ingester.reconcileWatchers([
      { agentGroupId: 'A', folder: 'group-a', enabled: true },
      { agentGroupId: 'B', folder: 'group-b', enabled: false },
      { agentGroupId: 'C', folder: 'group-c', enabled: true },
    ]);

    expect(result2.opened).toBe(1); // C opened
    expect(result2.closed).toBe(1); // B closed
    expect(mockWatcherB.close).toHaveBeenCalled();
    expect(mockWatcherA.close).not.toHaveBeenCalled();

    await ingester.shutdown();

    fsWatchSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_idempotency — already-processed file skips classifier', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    const agentGroupId = 'ag-test-idempotency';
    const folder = 'test-group';
    const fileContent = 'This is the test file content for idempotency checking.';
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const { createHash } = await import('crypto');
    const contentHash = createHash('sha256').update(canonical).digest('hex');

    // Pre-insert processed_sources row
    ingestDb
      .prepare(
        `
      INSERT INTO processed_sources
        (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
      VALUES (?, ?, 'v1', 'v1', '/tmp/test.txt', ?, 2)
    `,
      )
      .run(agentGroupId, contentHash, new Date().toISOString());

    stubProcessInboxFileValidation('/tmp/test.txt', folder, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, folder, '/tmp/test.txt', store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(false);
    expect(callClassifier).not.toHaveBeenCalled();
    // File moved to processed/
    expect(renameSpy).toHaveBeenCalled();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_moves_file_on_success — new file classified, moved to processed/', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'The project uses TypeScript with strict mode enabled',
          category: 'fact',
          importance: 3,
          entities: ['TypeScript'],
          source_role: 'external',
        },
        {
          content: 'Dave prefers pnpm over npm for the host package manager',
          category: 'preference',
          importance: 4,
          entities: ['pnpm'],
          source_role: 'external',
        },
      ],
    });

    const agentGroupId = 'ag-test-success';
    const folder = 'test-group';
    const fileContent =
      'The project uses TypeScript with strict mode. Dave prefers pnpm over npm for the host package manager. This is a detailed source document with substantial information.';

    const resolvedPath = stubProcessInboxFileValidation('/tmp/new-doc.txt', folder, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, folder, '/tmp/new-doc.txt', store, health);

    expect(result.factsWritten).toBe(2);
    expect(result.failed).toBe(false);
    expect(callClassifier).toHaveBeenCalledOnce();
    expect(store.remember).toHaveBeenCalledTimes(2);

    // File moved to processed/<date>/ directory. Note: production canonicalizes
    // the path via the fd readlink before reading, so renameSync is called
    // with the resolved (stubbed) path, not the original /tmp/new-doc.txt.
    expect(renameSpy).toHaveBeenCalledWith(resolvedPath, expect.stringContaining('processed'));

    // processed_sources row inserted
    const { createHash } = await import('crypto');
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const contentHash = createHash('sha256').update(canonical).digest('hex');
    const row = ingestDb.prepare(`SELECT * FROM processed_sources WHERE content_sha256 = ?`).get(contentHash);
    expect(row).toBeTruthy();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_success_clears_dead_letters — pre-existing dead_letters row is deleted in same txn as processed_sources INSERT', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'Fact from previously dead-lettered file',
          category: 'fact',
          importance: 3,
          entities: [],
          source_role: 'external',
        },
      ],
    });

    const agentGroupId = 'ag-test-dl-cleanup';
    const folder = 'test-group';
    const fileContent = 'Source document that was previously dead-lettered and is now re-processed.';
    const filePath = '/tmp/previously-dead.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, folder, fileContent);

    // Pre-insert a dead_letters row for this file (simulating a prior failure)
    ingestDb
      .prepare(
        `INSERT INTO dead_letters
           (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at)
         VALUES ('dl-1', 'source-file', ?, ?, 2, 'prior error', ?)`,
      )
      .run(resolvedPath, agentGroupId, new Date().toISOString());

    const dlBefore = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlBefore).toBeTruthy();

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, folder, filePath, store, health);

    expect(result.factsWritten).toBe(1);
    expect(result.failed).toBe(false);

    // dead_letters row must be gone after successful processing
    const dlAfter = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlAfter).toBeUndefined();

    // processed_sources row must exist
    const { createHash } = await import('crypto');
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const contentHash = createHash('sha256').update(canonical).digest('hex');
    const psRow = ingestDb.prepare(`SELECT * FROM processed_sources WHERE content_sha256 = ?`).get(contentHash);
    expect(psRow).toBeTruthy();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_worth_storing_false_clears_dead_letters — worth_storing=false path also deletes dead_letters', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: false,
      facts: [],
    });

    const agentGroupId = 'ag-test-dl-cleanup-no-facts';
    const folder = 'test-group';
    const fileContent = 'A trivial document with no extractable facts.';
    const filePath = '/tmp/no-facts.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, folder, fileContent);

    // Pre-insert a dead_letters row for this file
    ingestDb
      .prepare(
        `INSERT INTO dead_letters
           (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at)
         VALUES ('dl-2', 'source-file', ?, ?, 1, 'prior error', ?)`,
      )
      .run(resolvedPath, agentGroupId, new Date().toISOString());

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, folder, filePath, store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(false);

    // dead_letters row must be gone after worth_storing=false success
    const dlAfter = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlAfter).toBeUndefined();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_keeps_file_on_failure — classifier error leaves file in inbox, dead_letters created', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockRejectedValue(new Error('Anthropic API error 500: internal error'));

    const agentGroupId = 'ag-test-failure';
    const folder = 'test-group';
    const fileContent = 'Source document that will fail to classify due to API error.';
    const filePath = '/tmp/failing-doc.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, folder, fileContent);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, folder, filePath, store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(true);
    // File NOT moved (stays in inbox)
    expect(renameSpy).not.toHaveBeenCalled();
    // Dead letters row created — keyed on the resolved path (production
    // canonicalizes the path via realpathSync before storing).
    const dlRow = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlRow).toBeTruthy();

    renameSpy.mockRestore();
    ingestDb.close();
  });
});
