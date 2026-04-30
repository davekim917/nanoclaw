import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FactInput } from './store.js';

// Mock child_process before importing the module under test.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { MnemonStore, setMnemonStoreIngestDb } from './mnemon-impl.js';
import { runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js';

const mockSpawn = vi.mocked(spawn);

function makeFact(content: string = 'user prefers dark mode'): FactInput {
  return {
    content,
    category: 'preference',
    importance: 3,
    provenance: { sourceType: 'chat', sourceId: 'msg-1' },
  };
}

function makeChildMock(
  opts: {
    stdout?: string;
    exitCode?: number;
    neverExit?: boolean;
    throwError?: boolean;
  } = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // When kill is called on a neverExit child, simulate the process dying so
  // spawnMnemon's close listener can resolve the promise.
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || !signal) {
      setImmediate(() => child.emit('close', 1));
    }
  });

  if (opts.throwError) {
    setImmediate(() => child.emit('error', new Error('ENOENT')));
  } else if (!opts.neverExit) {
    setImmediate(() => {
      if (opts.stdout) {
        child.stdout.emit('data', Buffer.from(opts.stdout));
      }
      child.emit('close', opts.exitCode ?? 0);
    });
  }

  return child;
}

function makeInMemoryIngestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMnemonIngestMigrations(db);
  return db;
}

describe('MnemonStore', () => {
  let store: MnemonStore;

  beforeEach(() => {
    store = new MnemonStore();
    // Reset module-level DB so tests don't leak state or open real files.
    setMnemonStoreIngestDb(null);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setMnemonStoreIngestDb(null);
    vi.restoreAllMocks();
  });

  it('test_recall_timeout_kills_child', async () => {
    const child = makeChildMock({ neverExit: true });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const result = await store.recall('ag-X', 'query', { timeoutMs: 100 });

    expect(result.facts).toEqual([]);
    expect(result.totalAvailable).toBe(0);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.fromCache).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // SIGKILL fires after 500ms grace — give it time
    await new Promise((r) => setTimeout(r, 600));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  }, 2000);

  it('test_recall_returns_empty_on_spawn_error', async () => {
    const child = makeChildMock({ throwError: true });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const result = await store.recall('ag-X', 'query');

    expect(result).toEqual({
      facts: [],
      totalAvailable: 0,
      latencyMs: expect.any(Number),
      fromCache: false,
    });
  });

  it('test_remember_skips_on_idempotency_hit', async () => {
    const db = makeInMemoryIngestDb();
    setMnemonStoreIngestDb(db);

    const firstChild = makeChildMock({ stdout: JSON.stringify({ action: 'added', id: 'fact-123' }) });
    mockSpawn.mockReturnValueOnce(firstChild as unknown as ReturnType<typeof spawn>);

    // First call — should hit the CLI
    const first = await store.remember('ag-X', makeFact(), { idempotencyKey: 'K1' });
    expect(first.action).toBe('added');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second call with same key — should be served from DB, spawn NOT called.
    // Critical: must REPLAY the original successful action+factId (not return
    // {skipped, ''}). Callers treat {skipped, ''} as an operational write
    // failure and would lose remaining facts in a multi-fact retry.
    const second = await store.remember('ag-X', makeFact(), { idempotencyKey: 'K1' });
    expect(second.action).toBe('added');
    expect(second.factId).toBe('fact-123');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('test_remember_redacts_secret_before_call', async () => {
    // Content containing a Bearer token — redactor should block before spawn
    const result = await store.remember('ag-X', makeFact('Bearer abc123def456xyz789abcdef'));

    expect(result.action).toBe('skipped');
    expect(result.factId).toBe('');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('test_idempotency_persists_across_instances', async () => {
    const db = makeInMemoryIngestDb();
    setMnemonStoreIngestDb(db);

    // First instance
    const store1 = new MnemonStore();
    const child = makeChildMock({ stdout: JSON.stringify({ action: 'added', id: 'fact-456' }) });
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const first = await store1.remember('ag-Y', makeFact(), { idempotencyKey: 'persist-key-1' });
    expect(first.action).toBe('added');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second instance pointing at the SAME DB — must see the persisted key
    // and replay the original successful result (not {skipped,''}).
    const store2 = new MnemonStore();
    const second = await store2.remember('ag-Y', makeFact(), { idempotencyKey: 'persist-key-1' });
    expect(second.action).toBe('added');
    expect(second.factId).toBe('fact-456');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('test_idempotency_replay_does_not_poison_partial_multi_fact_retry', async () => {
    // Regression test for Codex F1: a multi-fact ingest where fact 0 succeeds
    // and fact 1 fails dead-letters the source. On retry, fact 0's idempotency
    // key MUST replay the original {action:'added', factId:'fact-A'} so the
    // caller continues to fact 1 instead of treating fact 0 as a write failure
    // and bailing the entire retry.
    const db = makeInMemoryIngestDb();
    setMnemonStoreIngestDb(db);

    // Pass 1: fact A succeeds, key persisted.
    const childA = makeChildMock({ stdout: JSON.stringify({ action: 'added', id: 'fact-A' }) });
    mockSpawn.mockReturnValueOnce(childA as unknown as ReturnType<typeof spawn>);
    const passOneA = await store.remember('ag-multi', makeFact('fact A content'), { idempotencyKey: 'multi-A' });
    expect(passOneA.action).toBe('added');
    expect(passOneA.factId).toBe('fact-A');

    vi.clearAllMocks();

    // Pass 2 (retry): fact A is replayed via idempotency.
    // Critical assertion: action is NOT 'skipped' with empty factId.
    // If it were, source-ingest.ts:335 would interpret it as an operational
    // failure and break the per-fact loop, dead-lettering the source again
    // and never retrying fact B.
    const passTwoA = await store.remember('ag-multi', makeFact('fact A content'), { idempotencyKey: 'multi-A' });
    expect(passTwoA.action).toBe('added');
    expect(passTwoA.factId).toBe('fact-A');
    // The shape callers gate on:
    const isOperationalFailure = passTwoA.action === 'skipped' && !passTwoA.factId;
    expect(isOperationalFailure).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('test_idempotency_does_not_persist_operational_failures', async () => {
    // Regression: if remember() fails operationally (CLI exits non-zero,
    // empty stdout, parse error) it returns {skipped, ''}. That MUST NOT
    // be persisted as an idempotency hit — the retry needs to run against
    // an unprimed cache so it can actually re-attempt the write.
    const db = makeInMemoryIngestDb();
    setMnemonStoreIngestDb(db);

    // First call: CLI fails with non-zero exit + empty stdout.
    const failChild = makeChildMock({ stdout: '', exitCode: 1 });
    mockSpawn.mockReturnValueOnce(failChild as unknown as ReturnType<typeof spawn>);
    const first = await store.remember('ag-fail', makeFact(), { idempotencyKey: 'fail-key' });
    expect(first.action).toBe('skipped');
    expect(first.factId).toBe('');

    vi.clearAllMocks();

    // Retry: cache must be a miss → spawn IS called again.
    const retryChild = makeChildMock({ stdout: JSON.stringify({ action: 'added', id: 'fact-recovered' }) });
    mockSpawn.mockReturnValueOnce(retryChild as unknown as ReturnType<typeof spawn>);
    const second = await store.remember('ag-fail', makeFact(), { idempotencyKey: 'fail-key' });
    expect(second.action).toBe('added');
    expect(second.factId).toBe('fact-recovered');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('test_idempotency_no_db_available_falls_open', async () => {
    // Inject a broken DB object whose prepare() always throws — simulates DB unavailable.
    const brokenDb = {
      prepare: () => {
        throw new Error('DB unavailable');
      },
    } as unknown as Database.Database;
    setMnemonStoreIngestDb(brokenDb);

    const child = makeChildMock({ stdout: JSON.stringify({ action: 'added', id: 'fact-789' }) });
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    // Should not throw — DB errors are caught and treated as cache miss.
    const result = await store.remember('ag-Z', makeFact(), { idempotencyKey: 'no-db-key' });
    // Proceeds to spawn (cache miss fallback) and returns the CLI result.
    expect(result.action).toBe('added');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
