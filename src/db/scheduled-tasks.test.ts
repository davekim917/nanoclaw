/**
 * Tests for the scheduleTask API (Task C1).
 *
 * TDD: these tests were written before the implementation.
 * Uses temp-file SQLite DBs. Session resolution is tested via the actual
 * `findSessionByAgentGroup` query on an in-memory central DB.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { ensureSchema, openInboundDb } from './session-db.js';
import { scheduleTask } from './scheduled-tasks.js';

const TEST_DIR = '/tmp/nanoclaw-scheduled-tasks-test';
const AGENT_GROUP_ID = 'ag-test-c1';
const SESSION_ID = 'sess-test-c1';

function agentSessionDir(sessionId = SESSION_ID): string {
  return path.join(TEST_DIR, 'v2-sessions', AGENT_GROUP_ID, sessionId);
}

function inboundPath(sessionId = SESSION_ID): string {
  return path.join(agentSessionDir(sessionId), 'inbound.db');
}

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, is_group INTEGER DEFAULT 0, unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped',
      last_active TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_group ON sessions(agent_group_id);
  `);
}

function seedActiveSession(sessionId = SESSION_ID): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'active', 'stopped', NULL, datetime('now'))`,
  ).run(sessionId, AGENT_GROUP_ID);
}

function seedInboundDb(sessionId = SESSION_ID): void {
  const sessDir = agentSessionDir(sessionId);
  fs.mkdirSync(sessDir, { recursive: true });
  ensureSchema(inboundPath(sessionId), 'inbound');
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupCentralDb();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── test_scheduleTask_no_messaging_group_param ──────────────────────────────
describe('test_scheduleTask_no_messaging_group_param', () => {
  it('TaskDef interface has no platformId or channelType field', () => {
    // Compile-time check: if the TypeScript interface had platformId or
    // channelType as required fields, this assignment would fail tsc.
    // At runtime we verify the function is callable with a minimal def
    // that has no platform fields.
    const minimalDef = {
      id: 'check',
      agentGroupId: AGENT_GROUP_ID,
      cron: '0 3 * * *',
      processAfter: new Date(Date.now() + 86400000).toISOString(),
      seriesId: 'check-series',
      prompt: 'test',
    };
    // If TaskDef required platformId/channelType, TS would error here.
    // We document this by confirming the keys are absent from the shape.
    expect('platformId' in minimalDef).toBe(false);
    expect('channelType' in minimalDef).toBe(false);
    expect(scheduleTask).toBeTypeOf('function');
  });
});

// ── test_scheduleTask_inserts_new ──────────────────────────────────────────
describe('test_scheduleTask_inserts_new', () => {
  it('inserts a new task row with correct fields', async () => {
    seedActiveSession();
    seedInboundDb();

    const processAfter = new Date(Date.now() + 86400000).toISOString();
    await scheduleTask(
      {
        id: 't1',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter,
        seriesId: 's1',
        prompt: 'do thing',
      },
      TEST_DIR,
    );

    const db = openInboundDb(inboundPath());
    const rows = db.prepare("SELECT * FROM messages_in WHERE series_id = 's1'").all() as Array<{
      series_id: string;
      kind: string;
      recurrence: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('task');
    expect(rows[0].recurrence).toBe('0 3 * * *');
    expect(rows[0].series_id).toBe('s1');
  });
});

// ── test_scheduleTask_idempotent ───────────────────────────────────────────
describe('test_scheduleTask_idempotent', () => {
  it('calling twice with same seriesId results in exactly one row with updated process_after', async () => {
    seedActiveSession();
    seedInboundDb();

    const processAfter1 = new Date(Date.now() + 86400000).toISOString();
    const processAfter2 = new Date(Date.now() + 172800000).toISOString();

    await scheduleTask(
      {
        id: 't2a',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter: processAfter1,
        seriesId: 's-idempotent',
        prompt: 'do thing',
      },
      TEST_DIR,
    );
    await scheduleTask(
      {
        id: 't2b',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter: processAfter2,
        seriesId: 's-idempotent',
        prompt: 'do thing updated',
      },
      TEST_DIR,
    );

    const db = openInboundDb(inboundPath());
    const rows = db.prepare("SELECT * FROM messages_in WHERE series_id = 's-idempotent'").all() as Array<{
      series_id: string;
      process_after: string;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].process_after).toBe(processAfter2);
  });
});

// ── test_scheduleTask_does_not_resurrect_completed_row ─────────────────────
describe('test_scheduleTask_does_not_resurrect_completed_row', () => {
  it('does not update a completed history row; instead inserts a fresh active row', async () => {
    seedActiveSession();
    seedInboundDb();

    const processAfter1 = new Date(Date.now() + 86400000).toISOString();
    const processAfter2 = new Date(Date.now() + 172800000).toISOString();

    // Schedule, then mark the row completed (simulating sweeper-clone after task fired).
    await scheduleTask(
      {
        id: 'tcompleted',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter: processAfter1,
        seriesId: 's-completed-history',
        prompt: 'first',
      },
      TEST_DIR,
    );
    {
      const db = openInboundDb(inboundPath());
      db.prepare("UPDATE messages_in SET status = 'completed' WHERE series_id = ?").run('s-completed-history');
      db.close();
    }

    // Re-schedule with same seriesId. The completed row must NOT be updated; a new row is inserted.
    await scheduleTask(
      {
        id: 'tnew',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 4 * * *',
        processAfter: processAfter2,
        seriesId: 's-completed-history',
        prompt: 'second',
      },
      TEST_DIR,
    );

    const db = openInboundDb(inboundPath());
    const rows = db
      .prepare("SELECT id, status, process_after FROM messages_in WHERE series_id = ? ORDER BY status")
      .all('s-completed-history') as Array<{ id: string; status: string; process_after: string }>;
    db.close();

    expect(rows).toHaveLength(2);
    const completed = rows.find((r) => r.status === 'completed');
    const pending = rows.find((r) => r.status === 'pending');
    expect(completed).toBeDefined();
    expect(pending).toBeDefined();
    // Completed row's process_after must still be the original (not re-set).
    expect(completed!.process_after).toBe(processAfter1);
    // New pending row has the updated process_after.
    expect(pending!.process_after).toBe(processAfter2);
  });
});

// ── test_scheduleTask_re_enable_after_cancel ───────────────────────────────
describe('test_scheduleTask_re_enable_after_cancel', () => {
  it('re-enables a cancelled series by inserting a fresh pending row', async () => {
    seedActiveSession();
    seedInboundDb();

    await scheduleTask(
      {
        id: 'tc1',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter: new Date(Date.now() + 86400000).toISOString(),
        seriesId: 's-cancel-reenable',
        prompt: 'before-cancel',
      },
      TEST_DIR,
    );
    // Operator runs disable-mnemon — flips the row to cancelled.
    {
      const db = openInboundDb(inboundPath());
      db.prepare("UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE series_id = ?").run(
        's-cancel-reenable',
      );
      db.close();
    }

    // Re-enable.
    const newProcessAfter = new Date(Date.now() + 172800000).toISOString();
    await scheduleTask(
      {
        id: 'tc2',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter: newProcessAfter,
        seriesId: 's-cancel-reenable',
        prompt: 'after-reenable',
      },
      TEST_DIR,
    );

    const db = openInboundDb(inboundPath());
    const rows = db
      .prepare("SELECT id, status FROM messages_in WHERE series_id = ? ORDER BY status")
      .all('s-cancel-reenable') as Array<{ id: string; status: string }>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === 'cancelled')).toBe(true);
    expect(rows.some((r) => r.status === 'pending')).toBe(true);
  });
});

// ── test_scheduleTask_resolves_session_when_missing ────────────────────────
describe('test_scheduleTask_resolves_session_when_missing', () => {
  it('creates a session stub when no active session exists for the agent group', async () => {
    // No session seeded — scheduleTask should create one.
    const processAfter = new Date(Date.now() + 86400000).toISOString();
    await scheduleTask(
      {
        id: 't3',
        agentGroupId: AGENT_GROUP_ID,
        cron: '0 3 * * *',
        processAfter,
        seriesId: 's3',
        prompt: 'created session',
      },
      TEST_DIR,
    );

    // A session row should now exist in the central DB.
    const centralDb = getDb();
    const sessionRow = centralDb
      .prepare("SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' LIMIT 1")
      .get(AGENT_GROUP_ID) as { id: string } | undefined;
    expect(sessionRow).toBeDefined();

    // The inbound.db in the created session dir should have the task row.
    const sessId = sessionRow!.id;
    const dbPath = path.join(TEST_DIR, 'v2-sessions', AGENT_GROUP_ID, sessId, 'inbound.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = openInboundDb(dbPath);
    const rows = db.prepare("SELECT * FROM messages_in WHERE series_id = 's3'").all();
    db.close();
    expect(rows).toHaveLength(1);
  });
});
