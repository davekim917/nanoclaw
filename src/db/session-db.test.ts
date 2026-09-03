/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  activateRepoIngressFence,
  ensureSchema,
  expireStalePending,
  getDueWakePriority,
  getInboundSourceSessionId,
  insertMessage,
  insertDeferredMessageWithContextIfNew,
  migrateMessagesInTable,
  openInboundDb,
  openOutboundDb,
  openOutboundDbWritable,
  releaseRepoIngressFence,
  SessionDbMissingError,
  recoverHotJournal,
  sessionInboundHasMessage,
  syncProcessingAcks,
  upsertSessionRouting,
} from './session-db.js';
import { INBOUND_SCHEMA } from './schema.js';
import { DATA_DIR } from '../config.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('repository ingress fence statement-time admission', () => {
  const message = (id: string) => ({
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'C-1',
    channelType: 'slack',
    threadId: 'T-1',
    content: JSON.stringify({ text: id }),
    processAfter: null,
    recurrence: null,
    trigger: 1 as const,
  });

  it('never strands an insert when release wins immediately before the insert statement', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    migrateMessagesInTable(db);
    const fence = activateRepoIngressFence(db, 'repository-publish:req-race');
    expect(releaseRepoIngressFence(db, fence.epoch, fence.generation).released).toBe(true);

    insertMessage(db, message('after-release'));
    expect(
      db
        .prepare('SELECT trigger, repo_fence_epoch, repo_fence_original_trigger FROM messages_in WHERE id = ?')
        .get('after-release'),
    ).toEqual({ trigger: 1, repo_fence_epoch: null, repo_fence_original_trigger: null });
    db.close();
  });

  it('atomically tags an insert whose statement runs while the fence is active and restores it on release', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    migrateMessagesInTable(db);
    const fence = activateRepoIngressFence(db, 'repository-transfer:req-active');

    insertMessage(db, message('during-fence'));
    expect(
      db
        .prepare('SELECT trigger, repo_fence_epoch, repo_fence_original_trigger FROM messages_in WHERE id = ?')
        .get('during-fence'),
    ).toEqual({
      trigger: 0,
      repo_fence_epoch: 'repository-transfer:req-active',
      repo_fence_original_trigger: 1,
    });

    expect(releaseRepoIngressFence(db, fence.epoch, fence.generation)).toMatchObject({
      released: true,
      admittedRows: 1,
      wakeRequired: true,
    });
    expect(
      db
        .prepare('SELECT trigger, repo_fence_epoch, repo_fence_original_trigger FROM messages_in WHERE id = ?')
        .get('during-fence'),
    ).toEqual({ trigger: 1, repo_fence_epoch: null, repo_fence_original_trigger: null });
    db.close();
  });
});

describe('insertDeferredMessageWithContextIfNew', () => {
  it('atomically stores an inert recall marker and trigger and ignores a replay', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    const message = {
      id: 'schedule-wake-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'C-1',
      channelType: 'slack',
      threadId: 'T-1',
      content: JSON.stringify({ text: '[system] check CI' }),
      processAfter: new Date(Date.now() + 60_000).toISOString(),
      recurrence: null,
      onWake: 1 as const,
    };

    expect(insertDeferredMessageWithContextIfNew(db, message)).toBe(true);
    expect(insertDeferredMessageWithContextIfNew(db, message)).toBe(false);
    const rows = db
      .prepare('SELECT id, kind, trigger, on_wake, process_after, content FROM messages_in ORDER BY seq')
      .all() as Array<{
      id: string;
      kind: string;
      trigger: number;
      on_wake: number;
      process_after: string;
      content: string;
    }>;
    expect(rows.map((row) => row.id)).toEqual(['recall-schedule-wake-1', 'schedule-wake-1']);
    expect(rows.map((row) => row.trigger)).toEqual([0, 0]);
    expect(rows.map((row) => row.on_wake)).toEqual([1, 1]);
    expect(rows[0].process_after).toBe(message.processAfter);
    expect(JSON.parse(rows[0].content)).toEqual({ subtype: 'recall_context', deferred: true });
    db.close();
  });
});

describe('getDueWakePriority', () => {
  function makeInboundDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    return db;
  }

  function insertDueRow(
    db: Database.Database,
    id: string,
    kind: string,
    options: { trigger?: 0 | 1; processAfter?: string | null; timestamp?: string } = {},
  ): void {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m + 2;
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, content, process_after, series_id, trigger)
       VALUES (?, ?, ?, ?, 'pending', '{}', ?, ?, ?)`,
    ).run(
      id,
      seq,
      kind,
      options.timestamp ?? new Date().toISOString(),
      options.processAfter ?? null,
      id,
      options.trigger ?? 1,
    );
  }

  it('classifies scheduled-only due work as scheduled', () => {
    const db = makeInboundDb();
    try {
      insertDueRow(db, 'task-1', 'task');
      expect(getDueWakePriority(db)).toBe('scheduled');
    } finally {
      db.close();
    }
  });

  it('classifies any due non-task message as interactive', () => {
    const db = makeInboundDb();
    try {
      insertDueRow(db, 'task-1', 'task');
      insertDueRow(db, 'chat-1', 'chat-sdk');
      expect(getDueWakePriority(db)).toBe('interactive');
    } finally {
      db.close();
    }
  });

  it('ignores future and non-triggering chat context', () => {
    const db = makeInboundDb();
    try {
      insertDueRow(db, 'task-1', 'task');
      insertDueRow(db, 'future-chat', 'chat', {
        processAfter: new Date(Date.now() + 60_000).toISOString(),
      });
      insertDueRow(db, 'context-chat', 'chat-sdk', { trigger: 0 });
      expect(getDueWakePriority(db)).toBe('scheduled');
    } finally {
      db.close();
    }
  });

  it('defaults to interactive when no work is due', () => {
    const db = makeInboundDb();
    try {
      expect(getDueWakePriority(db)).toBe('interactive');
    } finally {
      db.close();
    }
  });

  it('demotes aged chat backlog to scheduled (restart-stampede case)', () => {
    const db = makeInboundDb();
    try {
      // A channel-recovery / stale-reset row: chat kind, but hours old.
      insertDueRow(db, 'old-chat', 'chat-sdk', {
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
      expect(getDueWakePriority(db)).toBe('scheduled');
    } finally {
      db.close();
    }
  });

  it('keeps interactive when a fresh message sits alongside aged backlog', () => {
    const db = makeInboundDb();
    try {
      insertDueRow(db, 'old-chat', 'chat-sdk', {
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
      insertDueRow(db, 'fresh-chat', 'chat-sdk');
      expect(getDueWakePriority(db)).toBe('interactive');
    } finally {
      db.close();
    }
  });

  it('keeps aged backlog scheduled even when backoff stamps a fresh fire time', () => {
    const db = makeInboundDb();
    try {
      // Stale-reset retry: inserted hours ago, but each backoff cycle sets a
      // recent process_after. Freshness must come from insertion, or backlog
      // rows would be permanently "fresh".
      insertDueRow(db, 'retried-chat', 'chat-sdk', {
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        processAfter: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      expect(getDueWakePriority(db)).toBe('scheduled');
    } finally {
      db.close();
    }
  });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });

  // ── A2: (series_id, seq DESC) read-path index (design §4.8) ───────────────
  function indexNames(db: Database.Database, table: string): Set<string> {
    // PRAGMA does not accept bound parameters; `table` is a test-literal.
    return new Set((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  }

  it('test_migrate_adds_series_seq_index', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a DB with the OLD index (idx_messages_in_series) but NOT the new
    // compound one — i.e. series_id already exists, so the migrate function's
    // series_id branch is skipped. The compound index must still be added.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        series_id      TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
    `);

    // Precondition: old index present, new index absent.
    const before = indexNames(db, 'messages_in');
    expect(before.has('idx_messages_in_series')).toBe(true);
    expect(before.has('idx_messages_in_series_seq')).toBe(false);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const after = indexNames(db, 'messages_in');
    expect(after.has('idx_messages_in_series_seq')).toBe(true);
    // Existing index is left intact.
    expect(after.has('idx_messages_in_series')).toBe(true);
    db.close();
  });

  it('test_fresh_schema_has_series_seq_index', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);

    const idx = indexNames(db, 'messages_in');
    expect(idx.has('idx_messages_in_series_seq')).toBe(true);
    expect(idx.has('idx_messages_in_series')).toBe(true);
    db.close();
  });
});

describe('upsertSessionRouting — spawn_task_id + session_id columns', () => {
  function makeInboundDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    return db;
  }

  it('test_upsert_writes_session_id_and_spawn_task_id', () => {
    const db = makeInboundDb();
    try {
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: 't1',
        session_id: 'sess-1',
        spawn_task_id: 'spawn-x',
      });
      const row = db
        .prepare(
          'SELECT channel_type, platform_id, thread_id, session_id, spawn_task_id FROM session_routing WHERE id = 1',
        )
        .get() as {
        channel_type: string;
        platform_id: string;
        thread_id: string;
        session_id: string;
        spawn_task_id: string;
      };
      expect(row.channel_type).toBe('slack');
      expect(row.platform_id).toBe('C1');
      expect(row.thread_id).toBe('t1');
      expect(row.session_id).toBe('sess-1');
      expect(row.spawn_task_id).toBe('spawn-x');
    } finally {
      db.close();
    }
  });

  it('test_upsert_coalesce_preserves_existing_spawn_task_id', () => {
    const db = makeInboundDb();
    try {
      // First write: set spawn_task_id
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
        spawn_task_id: 'spawn-x',
      });
      // Second write: routine wake — no spawn_task_id provided
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
      });
      const row = db.prepare('SELECT spawn_task_id, session_id FROM session_routing WHERE id = 1').get() as {
        spawn_task_id: string | null;
        session_id: string | null;
      };
      expect(row.spawn_task_id).toBe('spawn-x');
      expect(row.session_id).toBe('sess-1');
    } finally {
      db.close();
    }
  });

  it('test_upsert_coalesce_preserves_existing_session_id_on_routine_wake', () => {
    const db = makeInboundDb();
    try {
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
      });
      // Explicit null session_id — should not clobber via COALESCE
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: null,
      });
      const row = db.prepare('SELECT session_id FROM session_routing WHERE id = 1').get() as {
        session_id: string | null;
      };
      expect(row.session_id).toBe('sess-1');
    } finally {
      db.close();
    }
  });

  it('test_upsert_renames_legacy_dispatch_task_id_column', () => {
    // Phase-1 inbound.db has dispatch_task_id; upsert must rename it to spawn_task_id.
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type     TEXT,
        platform_id      TEXT,
        thread_id        TEXT,
        dispatch_task_id TEXT,
        session_id       TEXT
      );
      INSERT INTO session_routing (id, channel_type, platform_id, thread_id, dispatch_task_id, session_id)
        VALUES (1, 'slack', 'C1', 't1', 'dispatch-legacy', 'sess-legacy');
    `);
    try {
      // Routine upsert should trigger the rename and preserve the old value
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: 't1',
        session_id: 'sess-legacy',
      });
      const cols = (db.prepare(`PRAGMA table_info(session_routing)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain('spawn_task_id');
      expect(cols).not.toContain('dispatch_task_id');
      const row = db.prepare('SELECT spawn_task_id FROM session_routing WHERE id = 1').get() as {
        spawn_task_id: string | null;
      };
      // Renamed column carries the original value forward
      expect(row.spawn_task_id).toBe('dispatch-legacy');
    } finally {
      db.close();
    }
  });

  it('test_upsert_works_on_legacy_db_without_new_columns', () => {
    // Simulate an old inbound.db that predates migration 026
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id  TEXT,
        thread_id    TEXT
      );
    `);
    try {
      // Should not throw — migrateSessionRoutingTable adds missing columns
      expect(() =>
        upsertSessionRouting(db, {
          channel_type: 'slack',
          platform_id: 'C1',
          thread_id: null,
          session_id: 'sess-1',
          spawn_task_id: 'spawn-x',
        }),
      ).not.toThrow();
      const row = db.prepare('SELECT session_id, spawn_task_id FROM session_routing WHERE id = 1').get() as {
        session_id: string | null;
        spawn_task_id: string | null;
      };
      expect(row.session_id).toBe('sess-1');
      expect(row.spawn_task_id).toBe('spawn-x');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// sessionInboundHasMessage
// ---------------------------------------------------------------------------

describe('sessionInboundHasMessage', () => {
  const TEST_GROUP = 'test-group-has-msg';
  const TEST_SESSION = 'test-session-has-msg';

  function sessionDbPath(): string {
    return path.join(DATA_DIR, 'v2-sessions', TEST_GROUP, TEST_SESSION, 'inbound.db');
  }

  afterEach(() => {
    const dir = path.join(DATA_DIR, 'v2-sessions', TEST_GROUP);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('test_sessionInboundHasMessage_present', () => {
    const dbPath = sessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('msg-1', 2);
    db.close();

    expect(sessionInboundHasMessage(TEST_GROUP, TEST_SESSION, 'msg-1')).toBe(true);
  });

  it('test_sessionInboundHasMessage_absent', () => {
    const dbPath = sessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.close();

    expect(sessionInboundHasMessage(TEST_GROUP, TEST_SESSION, 'msg-2')).toBe(false);
  });

  it('test_sessionInboundHasMessage_no_db', () => {
    expect(sessionInboundHasMessage(TEST_GROUP, 'nonexistent-session', 'msg-1')).toBe(false);
  });

  it('answers over a REAL hot journal instead of throwing', () => {
    // This open was writable until it was narrowed to read-only so it could not
    // take a rollback write on a session the reclaim may be archiving. A hot
    // journal makes that narrowing fatal: the rollback IS a write, so the plain
    // SELECT fails with "attempt to write a readonly database" and the dashboard
    // steer path (its only caller) stops being able to ask the question at all.
    //
    // A hand-written journal file will NOT reproduce this — SQLite validates the
    // header and ignores an invalid one — and neither will a small aborted
    // transaction, because nothing spilled to the main DB and there is nothing
    // to roll back. It takes a child killed mid-transaction with a page cache
    // small enough to force dirty pages out into the main file first.
    const dbPath = sessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = DELETE');
    seed.exec(INBOUND_SCHEMA);
    const insert = seed.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', ?)",
    );
    seed.transaction(() => {
      for (let i = 0; i < 4000; i++) insert.run(`seed-${i}`, i * 2 + 2, 'x'.repeat(400));
    })();
    seed.close();

    const child = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = DELETE');
      db.pragma('cache_size = 8');
      db.prepare('BEGIN EXCLUSIVE').run();
      const ins = db.prepare("INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', ?)");
      for (let i = 0; i < 4000; i++) ins.run('kill-' + i, 100000 + i * 2, 'y'.repeat(400));
      process.kill(process.pid, 'SIGKILL');
    `;
    spawnSync(process.execPath, ['-e', child], { cwd: process.cwd() });

    // Confirm the precondition is REAL before asserting on it, rather than
    // asserting over a condition we never established.
    let reproduced = false;
    try {
      const ro = new Database(dbPath, { readonly: true });
      ro.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get('seed-1');
      ro.close();
    } catch (err) {
      reproduced = /readonly database/.test((err as Error).message);
    }
    if (!reproduced) return;

    expect(sessionInboundHasMessage(TEST_GROUP, TEST_SESSION, 'seed-1')).toBe(true);
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expireStalePending
// ---------------------------------------------------------------------------

describe('expireStalePending', () => {
  function makeInboundDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    return db;
  }

  function insertRow(
    db: Database.Database,
    args: {
      id: string;
      timestamp: string;
      status?: string;
      processAfter?: string | null;
      kind?: string;
    },
  ): void {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m + 2;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, process_after, series_id, trigger)
       VALUES (@id, @seq, @kind, @timestamp, @status, '{}', @processAfter, @id, 1)`,
    ).run({
      id: args.id,
      seq,
      kind: args.kind ?? 'chat',
      timestamp: args.timestamp,
      status: args.status ?? 'pending',
      processAfter: args.processAfter ?? null,
    });
  }

  it('expires pending rows older than the cutoff', () => {
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const recentTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      insertRow(db, { id: 'old-1', timestamp: oldTs });
      insertRow(db, { id: 'recent-1', timestamp: recentTs });

      const changed = expireStalePending(db, 24 * 60 * 60 * 1000);

      expect(changed).toBe(1);
      const rows = db.prepare('SELECT id, status FROM messages_in ORDER BY id').all() as Array<{
        id: string;
        status: string;
      }>;
      expect(rows.find((r) => r.id === 'old-1')?.status).toBe('expired');
      expect(rows.find((r) => r.id === 'recent-1')?.status).toBe('pending');
    } finally {
      db.close();
    }
  });

  it('normalizes SQLite-style timestamps before comparing the stale cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
    const db = makeInboundDb();
    try {
      insertRow(db, { id: 'recent-insert', timestamp: '2026-07-28 11:30:00' });
      insertRow(db, { id: 'stale-insert', timestamp: '2026-07-28 10:30:00' });
      insertRow(db, {
        id: 'recent-fire',
        timestamp: '2026-07-20 12:00:00',
        processAfter: '2026-07-28 11:30:00',
      });
      insertRow(db, {
        id: 'stale-fire',
        timestamp: '2026-07-20 12:00:00',
        processAfter: '2026-07-28 10:30:00',
      });

      expect(expireStalePending(db, 60 * 60 * 1000)).toBe(2);
      expect(db.prepare('SELECT id, status FROM messages_in ORDER BY id').all()).toEqual([
        { id: 'recent-fire', status: 'pending' },
        { id: 'recent-insert', status: 'pending' },
        { id: 'stale-fire', status: 'expired' },
        { id: 'stale-insert', status: 'expired' },
      ]);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it('protects future-scheduled recurring tasks (process_after >= now)', () => {
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const futureFire = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      insertRow(db, { id: 'cron-1', timestamp: oldTs, processAfter: futureFire, kind: 'task' });

      const changed = expireStalePending(db, 24 * 60 * 60 * 1000);

      expect(changed).toBe(0);
      const row = db.prepare("SELECT status FROM messages_in WHERE id = 'cron-1'").get() as {
        status: string;
      };
      expect(row.status).toBe('pending');
    } finally {
      db.close();
    }
  });

  it('never expires a DUE recurring task (recurring rows are protected regardless of process_after)', () => {
    // Regression: a daily recurring row is inserted ~24h before its next fire,
    // so it crosses the staleness cutoff the instant it comes due. Reaping it
    // lost the fire AND stranded the series (wiki-synth across all memory-enabled
    // agents, 2026-05-10). Recurring rows must never be expired here.
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // >24h old
      const overdue = new Date(Date.now() - 60 * 1000).toISOString(); // already due (in the past)
      const staleOneShotFire = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m + 2;
      db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, process_after, recurrence, series_id, trigger)
         VALUES ('cron-due', @seq, 'task', @ts, 'pending', '{}', @pa, '0 9 * * *', 'cron-due', 1)`,
      ).run({ seq, ts: oldTs, pa: overdue });
      // A non-recurring row whose own fire time is stale, to confirm the
      // protection is scoped to recurring rows (the one-shot still expires).
      db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, process_after, series_id, trigger)
         VALUES ('oneshot-due', @seq, 'task', @ts, 'pending', '{}', @pa, 'oneshot-due', 1)`,
      ).run({ seq: seq + 2, ts: oldTs, pa: staleOneShotFire });

      const changed = expireStalePending(db, 24 * 60 * 60 * 1000);

      expect(changed).toBe(1); // only the one-shot
      const rows = db.prepare('SELECT id, status FROM messages_in').all() as Array<{ id: string; status: string }>;
      expect(rows.find((r) => r.id === 'cron-due')?.status).toBe('pending'); // recurring survives
      expect(rows.find((r) => r.id === 'oneshot-due')?.status).toBe('expired'); // one-shot reaped
    } finally {
      db.close();
    }
  });

  it('expires rows whose process_after is also in the past', () => {
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const stalePastFire = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertRow(db, {
        id: 'cron-overdue',
        timestamp: oldTs,
        processAfter: stalePastFire,
        kind: 'task',
      });

      const changed = expireStalePending(db, 24 * 60 * 60 * 1000);

      expect(changed).toBe(1);
      const row = db.prepare("SELECT status FROM messages_in WHERE id = 'cron-overdue'").get() as {
        status: string;
      };
      expect(row.status).toBe('expired');
    } finally {
      db.close();
    }
  });

  it('keeps a seven-day one-shot wake through its first due day', () => {
    const db = makeInboundDb();
    try {
      const inserted = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const justDue = new Date(Date.now() - 60 * 1000).toISOString();
      insertRow(db, {
        id: 'scheduled-wake-7d',
        timestamp: inserted,
        processAfter: justDue,
      });

      expect(expireStalePending(db, 24 * 60 * 60 * 1000)).toBe(0);
      expect(db.prepare("SELECT status FROM messages_in WHERE id = 'scheduled-wake-7d'").get()).toEqual({
        status: 'pending',
      });
    } finally {
      db.close();
    }
  });

  it('leaves non-pending rows untouched', () => {
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertRow(db, { id: 'p1', timestamp: oldTs, status: 'processing' });
      insertRow(db, { id: 'c1', timestamp: oldTs, status: 'completed' });
      insertRow(db, { id: 'f1', timestamp: oldTs, status: 'failed' });

      const changed = expireStalePending(db, 24 * 60 * 60 * 1000);

      expect(changed).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is idempotent — second call expires nothing', () => {
    const db = makeInboundDb();
    try {
      const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertRow(db, { id: 'old-1', timestamp: oldTs });

      expect(expireStalePending(db, 24 * 60 * 60 * 1000)).toBe(1);
      expect(expireStalePending(db, 24 * 60 * 60 * 1000)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('syncProcessingAcks — script-skip counter', () => {
  function freshPair() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    const outPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outPath, 'outbound');
    return { inDb: new Database(DB_PATH), outDb: new Database(outPath) };
  }

  function seedTask(inDb: InstanceType<typeof Database>, id: string, content: Record<string, unknown>) {
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content, series_id)
         VALUES (?, 2, datetime('now'), 'processing', 0, 'task', ?, ?)`,
      )
      .run(id, JSON.stringify(content), id);
  }

  function ack(outDb: InstanceType<typeof Database>, id: string, status: string) {
    outDb
      .prepare(
        "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
      )
      .run(id, status);
  }

  const status = (inDb: InstanceType<typeof Database>, id: string) =>
    (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

  it('script-skip:error ack lands the row as a FAILED run (streak-derivable history)', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('a settled row is terminal — a lingering ack cannot flip failed back to completed', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');
    syncProcessingAcks(inDb, outDb);

    ack(outDb, 't1', 'completed');
    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('plain completed ack completes the row as before', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'completed');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('completed');
  });
});

describe('hot journal recovery (readonly outbound opens)', () => {
  it('recovers a REAL hot rollback journal so the read-only host handle can read', () => {
    // A container SIGKILLed mid-transaction (exit 137 / OOM) leaves a `<db>-journal`.
    // SQLite must roll it back before ANY read, and rollback is a WRITE — so a
    // read-only handle throws "attempt to write a readonly database" on a plain
    // SELECT, permanently wedging the sweep for that session.
    //
    // A hand-written junk file will NOT reproduce this: SQLite validates the journal
    // header and silently ignores an invalid one. We therefore create a GENUINE hot
    // journal by killing a child process mid-transaction.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotjournal-'));
    const dbPath = path.join(dir, 'outbound.db');
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = DELETE');
    seed.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT)');
    seed.prepare('INSERT INTO processing_ack VALUES (?, ?)').run('m1', 'completed');
    seed.close();

    const child = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = DELETE');
      db.prepare('BEGIN EXCLUSIVE').run();
      db.prepare('INSERT INTO processing_ack VALUES (?, ?)').run('m2', 'completed');
      process.kill(process.pid, 'SIGKILL');
    `;
    spawnSync(process.execPath, ['-e', child], { cwd: process.cwd() });

    if (!fs.existsSync(`${dbPath}-journal`)) {
      // Couldn't reproduce the crash residue on this platform — skip rather than
      // assert something we didn't actually set up.
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    // Confirm the precondition is REAL before asserting on it: a genuinely hot
    // journal makes a bare read-only read fail. If the child's crash didn't leave
    // one (timing/platform dependent), skip rather than assert on a condition we
    // never actually established.
    let reproduced = false;
    try {
      const ro = new Database(dbPath, { readonly: true });
      ro.prepare('SELECT message_id FROM processing_ack').all();
      ro.close();
    } catch (err) {
      reproduced = /readonly database/.test((err as Error).message);
    }
    if (!reproduced) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    // The fix: openOutboundDb recovers first, so the read-only read succeeds.
    const db = openOutboundDb(dbPath);
    expect(db.prepare('SELECT message_id FROM processing_ack').all().length).toBeGreaterThan(0);
    db.close();
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when there is no journal (normal path stays cheap)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nojournal-'));
    const dbPath = path.join(dir, 'outbound.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT)');
    seed.close();
    expect(recoverHotJournal(dbPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('host opens never create a session database', () => {
  // 2026-09-01: a storage reclaim removed a session directory while a
  // repository publish was mid-quiescence. The inbound open recreated the
  // directory (its storage-activity marker does a recursive mkdir) and
  // better-sqlite3 then created a 0-byte inbound.db. The schema migration
  // threw, the handle closed, and what stayed on disk was a session directory
  // holding nothing but that stub — which the next host start opened, threw
  // on, and exited over, seven times. `ensureSchema` is the only host-side
  // creator; no open may bring a file, or its parent directory, into existence.

  const roots: string[] = [];
  const chmodBack: Array<[string, number]> = [];

  /** The post-reclaim shape exactly: the session directory itself is gone too. */
  function reclaimedSessionDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-db-missing-'));
    roots.push(root);
    return path.join(root, 'v2-sessions', 'ag-1', 'sess-1');
  }

  /** A real, schema-current DB the process then cannot open. */
  function unreadableDb(name: 'inbound.db' | 'outbound.db'): string {
    const sessionDir = reclaimedSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const dbPath = path.join(sessionDir, name);
    ensureSchema(dbPath, name === 'inbound.db' ? 'inbound' : 'outbound');
    fs.chmodSync(dbPath, 0o000);
    chmodBack.push([dbPath, 0o600]);
    return dbPath;
  }

  /** A real, schema-current DB inside a session directory that cannot be traversed. */
  function dbInUnsearchableDir(name: 'inbound.db' | 'outbound.db'): string {
    const sessionDir = reclaimedSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const dbPath = path.join(sessionDir, name);
    ensureSchema(dbPath, name === 'inbound.db' ? 'inbound' : 'outbound');
    fs.chmodSync(sessionDir, 0o000);
    chmodBack.push([sessionDir, 0o700]);
    return dbPath;
  }

  afterEach(() => {
    // Restore first, or the recursive remove below cannot traverse or unlink.
    for (const [target, mode] of chmodBack.splice(0)) fs.chmodSync(target, mode);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('openInboundDb throws SessionDbMissingError and resurrects neither the file nor its directory', () => {
    const sessionDir = reclaimedSessionDir();
    const dbPath = path.join(sessionDir, 'inbound.db');

    expect(() => openInboundDb(dbPath)).toThrow(SessionDbMissingError);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('openInboundDb releases its activity marker when a corrupt file fails mid-open', () => {
    // Third failure shape for the open funnel, alongside "file missing" and
    // "unreadable directory" above: the connection succeeds and a PRAGMA then
    // throws SQLITE_CORRUPT. Whatever the stage, the .nanoclaw-storage-active
    // marker must not survive — a leaked one makes every later reclamation
    // pass read the session as in use until the next host restart, and
    // repeated failed opens stack them. The empty listing is the proof, same
    // as the sibling cases.
    //
    // NOTE this does NOT reach `assertQueryable`, and no file-corruption
    // payload does: every shape that fails the readability probe fails
    // `journal_mode = DELETE` first (measured — corrupt page 1, truncation,
    // bad page count and whole-file garbage all throw at the pragma; corrupting
    // only bytes 110-900 throws at neither). The probe's own close path is
    // still ordered after the releasing wrapper is installed, so it cannot leak
    // either, but that ordering is unreachable by this route and is asserted by
    // construction rather than by this test.
    const sessionDir = reclaimedSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const dbPath = path.join(sessionDir, 'inbound.db');
    ensureSchema(dbPath, 'inbound');
    const corrupt = fs.readFileSync(dbPath);
    corrupt.fill(0xa5, 100, Math.min(1024, corrupt.length));
    fs.writeFileSync(dbPath, corrupt);

    expect(() => openInboundDb(dbPath)).toThrow();
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readdirSync(sessionDir)).toEqual(['inbound.db']);
  });

  it('openInboundDb leaves no stub and no marker when only the file is missing', () => {
    // The directory survives here (an operator `rm inbound.db`, or a partly
    // completed reclaim), so the marker's mkdir is not what would create the
    // file — better-sqlite3's own file creation is, and `fileMustExist`
    // refuses it. The empty listing also proves the storage-activity marker
    // was released, which is what keeps the session reclaimable.
    const sessionDir = reclaimedSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const dbPath = path.join(sessionDir, 'inbound.db');

    expect(() => openInboundDb(dbPath)).toThrow(SessionDbMissingError);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.readdirSync(sessionDir)).toEqual([]);
  });

  it('openOutboundDbWritable throws SessionDbMissingError and creates nothing', () => {
    // The host never provisions outbound.db — the container does.
    const sessionDir = reclaimedSessionDir();
    const dbPath = path.join(sessionDir, 'outbound.db');

    expect(() => openOutboundDbWritable(dbPath)).toThrow(SessionDbMissingError);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('openOutboundDb (readonly) reports a vanished session the same way', () => {
    const sessionDir = reclaimedSessionDir();
    const dbPath = path.join(sessionDir, 'outbound.db');

    expect(() => openOutboundDb(dbPath)).toThrow(SessionDbMissingError);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  // SQLite raises SQLITE_CANTOPEN with the identical "unable to open database
  // file" message for a file that is PRESENT but unopenable — EACCES here, and
  // descriptor exhaustion or a read-only filesystem in production. Reporting
  // those as a missing session would let container-restart's skip-the-vanished
  // branch leave a session whose ingress is present but unreadable UNFENCED,
  // which is the one case that has to fail closed. Root bypasses file modes, so
  // the precondition cannot be established there.
  const notRoot = process.getuid?.() !== 0;

  it.skipIf(!notRoot)('a present but unreadable inbound.db is NOT reported as missing', () => {
    const dbPath = unreadableDb('inbound.db');
    const sizeBefore = fs.statSync(dbPath).size;

    let thrown: unknown;
    try {
      openInboundDb(dbPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SessionDbMissingError);
    expect((thrown as { code?: string }).code).toBe('SQLITE_CANTOPEN');

    // The failing open touched nothing, and released its activity marker.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(['inbound.db']);
  });

  it.skipIf(!notRoot)('a present but unreadable outbound.db is NOT reported as missing', () => {
    const dbPath = unreadableDb('outbound.db');
    const sizeBefore = fs.statSync(dbPath).size;

    let thrown: unknown;
    try {
      openOutboundDbWritable(dbPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SessionDbMissingError);
    expect((thrown as { code?: string }).code).toBe('SQLITE_CANTOPEN');

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
  });

  it.skipIf(!notRoot)('an unreadable session DIRECTORY is not mistaken for a vanished session', () => {
    // One level below the CANTOPEN trap and the same mistake: `fs.existsSync`
    // returns false for ANY stat failure, EACCES on a parent directory that
    // lost search permission included. The session is present — its DB is right
    // there — so this must surface the real error and fail closed, not report a
    // missing session that container-restart would then skip fencing.
    const inboundPath = dbInUnsearchableDir('inbound.db');

    let thrown: unknown;
    try {
      openInboundDb(inboundPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SessionDbMissingError);
    expect((thrown as { code?: string }).code).toBe('EACCES');

    const outboundPath = dbInUnsearchableDir('outbound.db');
    let outboundThrown: unknown;
    try {
      openOutboundDbWritable(outboundPath);
    } catch (err) {
      outboundThrown = err;
    }
    expect(outboundThrown).toBeInstanceOf(Error);
    expect(outboundThrown).not.toBeInstanceOf(SessionDbMissingError);
    expect((outboundThrown as { code?: string }).code).toBe('SQLITE_CANTOPEN');
  });

  it('a provisioned session still opens through both funnels', () => {
    // The regression guard: refusing to create must not refuse a real session.
    // `ensureSchema` is the legitimate provisioning call, and it is what
    // `initSessionFolder` runs before any open.
    const sessionDir = reclaimedSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const inboundPath = path.join(sessionDir, 'inbound.db');
    const outboundPath = path.join(sessionDir, 'outbound.db');
    ensureSchema(inboundPath, 'inbound');
    ensureSchema(outboundPath, 'outbound');

    const inbound = openInboundDb(inboundPath);
    expect(inbound.prepare('SELECT COUNT(*) AS c FROM messages_in').get()).toEqual({ c: 0 });
    inbound.close();

    const outbound = openOutboundDbWritable(outboundPath);
    expect(outbound.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
    outbound.close();
  });
});
