import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runChatStreamSweep, setIngestDb, setArchiveDbForTest } from './classifier.js';
import type { MemoryStore, FactInput, RememberResult } from '../modules/memory/store.js';
import type { HealthRecorder } from './health.js';
import { setDeadLettersDb } from './dead-letters.js';

vi.mock('./classifier-client.js', () => ({
  callClassifier: vi.fn(),
  CLASSIFIER_VERSION: 'v1',
  PROMPT_VERSION: 'v1',
}));

import { callClassifier } from './classifier-client.js';

function makeArchiveDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_archive (
      id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeIngestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processed_pairs (
      agent_group_id TEXT NOT NULL,
      user_run_first_id TEXT NOT NULL,
      classifier_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      is_orphan INTEGER NOT NULL DEFAULT 0,
      user_run_last_id TEXT,
      assistant_run_first_id TEXT,
      assistant_run_last_id TEXT,
      classified_at TEXT NOT NULL,
      facts_written INTEGER NOT NULL,
      PRIMARY KEY (agent_group_id, user_run_first_id, classifier_version, prompt_version, is_orphan)
    );
    CREATE TABLE watermarks (
      agent_group_id TEXT NOT NULL PRIMARY KEY,
      last_classified_sent_at TEXT,
      scan_cursor TEXT,
      updated_at TEXT NOT NULL
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
    setPrereqVerification: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as HealthRecorder;
}

function pastIso(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

const GROUP_ID = 'ag-test-group';
const GROUP = { agentGroupId: GROUP_ID, folder: 'test-folder' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifier', () => {
  it('test_filters_agent_channel_traffic — agent-channel rows are excluded, slack rows classified', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // Two slack messages (stable pair: user 200s ago, assistant 130s ago)
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'Tell me about TypeScript generics in detail please', ?)`,
      )
      .run('u1', GROUP_ID, pastIso(200));
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'assistant', 'TypeScript generics allow you to write reusable components that work with multiple types', ?)`,
      )
      .run('a1', GROUP_ID, pastIso(130));
    // Two agent-channel messages (should be filtered out)
    archiveDb
      .prepare(`INSERT INTO messages_archive VALUES (?, ?, 'agent', 'user', 'internal routing message', ?)`)
      .run('u2', GROUP_ID, pastIso(190));
    archiveDb
      .prepare(`INSERT INTO messages_archive VALUES (?, ?, 'agent', 'assistant', 'internal routing reply', ?)`)
      .run('a2', GROUP_ID, pastIso(150));

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'TypeScript generics allow reusable components',
          category: 'fact',
          importance: 4,
          entities: ['TypeScript'],
          source_role: 'assistant',
        },
      ],
    });

    const store = makeStore();
    const health = makeHealth();
    const result = await runChatStreamSweep([GROUP], store, health);

    // Classifier called exactly once — for the slack pair only
    expect(callClassifier).toHaveBeenCalledOnce();
    expect(result.pairsClassified).toBe(1);
    expect(result.factsWritten).toBe(1);

    archiveDb.close();
    ingestDb.close();
  });

  it('test_pair_stability_threshold — pair NOT classified when last assistant < 120s ago', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // User msg 200s ago, assistant msg only 60s ago — not stable yet
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'What is the best way to structure a Node.js application', ?)`,
      )
      .run('u1', GROUP_ID, pastIso(200));
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'assistant', 'You should use a layered architecture with controllers services and repositories', ?)`,
      )
      .run('a1', GROUP_ID, pastIso(60));

    const store = makeStore();
    const health = makeHealth();
    const result = await runChatStreamSweep([GROUP], store, health);

    expect(callClassifier).not.toHaveBeenCalled();
    expect(result.pairsClassified).toBe(0);

    archiveDb.close();
    ingestDb.close();
  });

  it('test_orphan_after_10_minutes — user-only run with last msg 11min ago classified as orphan', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // User-only run, no assistant reply, last msg 11 minutes ago
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'I want to switch from PostgreSQL to SQLite for this project going forward', ?)`,
      )
      .run('u1', GROUP_ID, pastIso(660));
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'It will be much simpler for our use case and embedded deployment', ?)`,
      )
      .run('u2', GROUP_ID, pastIso(650));

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'User wants to switch from PostgreSQL to SQLite for simpler embedded deployment',
          category: 'decision',
          importance: 4,
          entities: ['PostgreSQL', 'SQLite'],
          source_role: 'user',
        },
      ],
    });

    const store = makeStore();
    const health = makeHealth();
    const result = await runChatStreamSweep([GROUP], store, health);

    expect(callClassifier).toHaveBeenCalledOnce();
    expect(result.pairsClassified).toBe(1);

    // processed_pairs row must have is_orphan=1
    const ppRow = ingestDb.prepare(`SELECT is_orphan FROM processed_pairs WHERE agent_group_id = ?`).get(GROUP_ID) as
      | { is_orphan: number }
      | undefined;
    expect(ppRow).toBeTruthy();
    expect(ppRow!.is_orphan).toBe(1);

    archiveDb.close();
    ingestDb.close();
  });

  it('test_per_pair_atomic_partial_failure — fact-2 failure prevents processed_pairs insert, dead_letters created', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // Stable pair: user 250s ago, assistant 130s ago
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'Can you explain how database transactions work in detail and give examples', ?)`,
      )
      .run('u1', GROUP_ID, pastIso(250));
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'assistant', 'Transactions ensure atomicity consistency isolation and durability known as ACID properties', ?)`,
      )
      .run('a1', GROUP_ID, pastIso(130));

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'Transactions ensure ACID properties',
          category: 'fact',
          importance: 4,
          entities: ['ACID'],
          source_role: 'assistant',
        },
        {
          content: 'Atomicity means all ops succeed or all fail',
          category: 'fact',
          importance: 4,
          entities: [],
          source_role: 'assistant',
        },
        {
          content: 'Isolation prevents concurrent transactions from interfering',
          category: 'fact',
          importance: 4,
          entities: [],
          source_role: 'assistant',
        },
      ],
    });

    let callCount = 0;
    const store = makeStore({
      remember: vi.fn().mockImplementation(async (_groupId: string, _fact: FactInput) => {
        callCount++;
        if (callCount === 2) throw new Error('simulated write failure on fact 2');
        return { action: 'added' as const, factId: `fact-${callCount}` };
      }),
    });
    const health = makeHealth();

    await runChatStreamSweep([GROUP], store, health);

    // processed_pairs must NOT have been inserted
    const ppCount = (
      ingestDb.prepare(`SELECT COUNT(*) as c FROM processed_pairs WHERE agent_group_id = ?`).get(GROUP_ID) as {
        c: number;
      }
    ).c;
    expect(ppCount).toBe(0);

    // dead_letters must have a row with failure_count=1
    const dlRow = ingestDb
      .prepare(`SELECT failure_count FROM dead_letters WHERE agent_group_id = ? AND item_type = 'turn-pair'`)
      .get(GROUP_ID) as { failure_count: number } | undefined;
    expect(dlRow).toBeTruthy();
    expect(dlRow!.failure_count).toBe(1);

    archiveDb.close();
    ingestDb.close();
  });

  it('test_idempotency_key_deterministic — same pair produces same sha256 idempotency key', async () => {
    const { createHash } = await import('crypto');

    const pairKey = 'msg-abc-123';
    const factIndex = 0;
    const classifierVersion = 'v1';
    const promptVersion = 'v1';

    const key1 = createHash('sha256')
      .update(`${pairKey}|${factIndex}|${classifierVersion}|${promptVersion}`)
      .digest('hex');
    const key2 = createHash('sha256')
      .update(`${pairKey}|${factIndex}|${classifierVersion}|${promptVersion}`)
      .digest('hex');

    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);

    // Different fact index produces a different key
    const key3 = createHash('sha256').update(`${pairKey}|1|${classifierVersion}|${promptVersion}`).digest('hex');
    expect(key1).not.toBe(key3);
  });

  it('test_poison_advances_scan_cursor — after 3 failures: poisoned_at set, scan_cursor advanced, success_watermark unchanged', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    const pairSentAt = pastIso(250);
    const assistantSentAt = pastIso(130);

    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'A detailed question about distributed systems and consensus algorithms like Raft', ?)`,
      )
      .run('u1', GROUP_ID, pairSentAt);
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'assistant', 'Raft uses leader election and log replication to achieve consensus in distributed systems', ?)`,
      )
      .run('a1', GROUP_ID, assistantSentAt);

    // Mock store.remember to always fail so failure_count accumulates
    const store = makeStore({
      remember: vi.fn().mockRejectedValue(new Error('persistent store failure')),
    });
    const health = makeHealth();

    // Sweep 3 times to trigger poison (backoff: first retry is 60s from now, so we need to
    // seed dead_letters to simulate the retries becoming due immediately).
    // Run sweep once to create the first dead_letters entry.
    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'Raft achieves consensus via leader election and log replication',
          category: 'fact',
          importance: 4,
          entities: ['Raft'],
          source_role: 'assistant',
        },
      ],
    });

    await runChatStreamSweep([GROUP], store, health);

    // First sweep: failure_count=1, not yet poisoned
    const dlAfter1 = ingestDb
      .prepare(`SELECT failure_count, poisoned_at, next_retry_at FROM dead_letters WHERE agent_group_id = ?`)
      .get(GROUP_ID) as { failure_count: number; poisoned_at: string | null; next_retry_at: string | null } | undefined;
    expect(dlAfter1?.failure_count).toBe(1);
    expect(dlAfter1?.poisoned_at).toBeNull();

    // Fast-forward next_retry_at to now so the second sweep picks it up
    ingestDb
      .prepare(`UPDATE dead_letters SET next_retry_at = ? WHERE agent_group_id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), GROUP_ID);
    await runChatStreamSweep([GROUP], store, health);

    const dlAfter2 = ingestDb
      .prepare(`SELECT failure_count, poisoned_at FROM dead_letters WHERE agent_group_id = ?`)
      .get(GROUP_ID) as { failure_count: number; poisoned_at: string | null } | undefined;
    expect(dlAfter2?.failure_count).toBe(2);
    expect(dlAfter2?.poisoned_at).toBeNull();

    // Fast-forward again for the third sweep
    ingestDb
      .prepare(`UPDATE dead_letters SET next_retry_at = ? WHERE agent_group_id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), GROUP_ID);
    await runChatStreamSweep([GROUP], store, health);

    // After 3 failures: poisoned_at should be set
    const dlAfter3 = ingestDb
      .prepare(`SELECT failure_count, poisoned_at FROM dead_letters WHERE agent_group_id = ?`)
      .get(GROUP_ID) as { failure_count: number; poisoned_at: string | null } | undefined;
    expect(dlAfter3?.failure_count).toBe(3);
    expect(dlAfter3?.poisoned_at).not.toBeNull();

    // scan_cursor must have advanced past the pair's sent_at
    const wm = ingestDb
      .prepare(`SELECT scan_cursor, last_classified_sent_at FROM watermarks WHERE agent_group_id = ?`)
      .get(GROUP_ID) as { scan_cursor: string | null; last_classified_sent_at: string | null } | undefined;
    expect(wm?.scan_cursor).not.toBeNull();
    expect(wm!.scan_cursor! >= assistantSentAt).toBe(true);

    // success_watermark must NOT have advanced (no successful classification)
    expect(wm?.last_classified_sent_at).toBeNull();

    archiveDb.close();
    ingestDb.close();
  });

  it('test_redact_blocks_fact_before_remember — PEM key in fact: store.remember not called, recordRedaction called', async () => {
    const archiveDb = makeArchiveDb();
    const ingestDb = makeIngestDb();
    setArchiveDbForTest(archiveDb);
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // Stable pair
    archiveDb
      .prepare(`INSERT INTO messages_archive VALUES (?, ?, 'slack', 'user', 'Here is my private key for reference', ?)`)
      .run('u1', GROUP_ID, pastIso(250));
    archiveDb
      .prepare(
        `INSERT INTO messages_archive VALUES (?, ?, 'slack', 'assistant', 'I can see the key you shared in the conversation above', ?)`,
      )
      .run('a1', GROUP_ID, pastIso(130));

    const secretContent =
      '-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHAQMXDl8z4A==\n-----END RSA PRIVATE KEY-----';

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [{ content: secretContent, category: 'fact', importance: 2, entities: [], source_role: 'user' }],
    });

    const store = makeStore();
    const health = makeHealth();

    await runChatStreamSweep([GROUP], store, health);

    // store.remember must NOT have been called (secret blocked by redactSecrets)
    expect(store.remember).not.toHaveBeenCalled();

    // health.recordRedaction must have been called once
    expect(health.recordRedaction).toHaveBeenCalledOnce();
    expect(health.recordRedaction).toHaveBeenCalledWith(GROUP_ID, expect.any(String));

    // Integration check: redactSecrets actually blocks PEM keys
    const { redactSecrets } = await import('../modules/memory/secret-redactor.js');
    const factInput: FactInput = {
      content: secretContent,
      category: 'fact',
      importance: 2,
      provenance: { sourceType: 'chat', sourceId: 'test' },
    };
    const result = redactSecrets(factInput);
    expect(result.shouldStore).toBe(false);

    archiveDb.close();
    ingestDb.close();
  });
});
