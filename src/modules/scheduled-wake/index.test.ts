import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { applyScheduleWake } from './index.js';

function makeInDb(withRouting = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_routing (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type  TEXT,
      platform_id   TEXT,
      thread_id     TEXT
    );
  `);
  if (withRouting) {
    db.prepare(
      "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'slack', 'C-1', 'T-1')",
    ).run();
  }
  return db;
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function rows(db: Database.Database) {
  return db.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
}

describe('schedule_wake delivery action', () => {
  it('registers the action', () => {
    expect(getDeliveryAction('schedule_wake')).toBeDefined();
  });

  it('writes a process_after row into the same session inbound.db', async () => {
    const db = makeInDb();
    const fireAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await applyScheduleWake(
      { action: 'schedule_wake', process_after: fireAt, prompt: 'Check CI for PR #207 and report status' },
      fakeSession(),
      db,
    );

    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('chat');
    expect(r[0].status).toBe('pending');
    expect(r[0].trigger).toBe(1);
    expect(r[0].process_after).toBe(fireAt);
    expect(r[0].platform_id).toBe('C-1');
    expect(r[0].channel_type).toBe('slack');
    expect(r[0].thread_id).toBe('T-1');
    const content = JSON.parse(r[0].content as string);
    expect(content.senderId).toBe('system');
    expect(content._system.kind).toBe('agent_scheduled_wake');
    expect(content.text).toBe('[system] Check CI for PR #207 and report status');
  });

  it('tolerates a session with no routing row', async () => {
    const db = makeInDb(false);
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    await applyScheduleWake({ process_after: fireAt, prompt: 'ping' }, fakeSession(), db);
    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].platform_id).toBeNull();
  });

  it('rejects invalid payloads without writing', async () => {
    const db = makeInDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const tooFar = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    for (const payload of [
      { process_after: future, prompt: '' },
      { process_after: future, prompt: 'x'.repeat(2001) },
      { process_after: past, prompt: 'ok' },
      { process_after: 'not a date', prompt: 'ok' },
      { process_after: tooFar, prompt: 'ok' },
      { prompt: 'no time at all' },
    ]) {
      await applyScheduleWake(payload, fakeSession(), db);
    }
    expect(rows(db)).toHaveLength(0);
  });
});
