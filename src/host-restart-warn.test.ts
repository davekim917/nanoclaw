import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { warnSessionIfWorkInFlight } from './host-restart-warn.js';
import type { Session } from './types.js';

function makeDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
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
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL,
      provider_status          TEXT,
      provider_last_event_at   TEXT,
      provider_last_probe_at   TEXT,
      provider_probe_failures  INTEGER,
      provider_recovery_attempts INTEGER,
      provider_failure_reason  TEXT,
      memory_current_bytes     INTEGER,
      memory_peak_bytes        INTEGER,
      memory_max_bytes         INTEGER,
      memory_oom_events        INTEGER,
      memory_oom_kill_events   INTEGER,
      memory_telemetry_at      TEXT
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function noteRows(inDb: Database.Database) {
  return inDb.prepare("SELECT * FROM messages_in WHERE content LIKE '%agent_host_restart%'").all() as Array<
    Record<string, unknown>
  >;
}

describe('warnSessionIfWorkInFlight', () => {
  it('does not treat internal narration as proof that work remains', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'status', '{}')")
      .run(new Date().toISOString());

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('fires when a tool is in flight even if the last outbound was a chat message', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());
    outDb
      .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
      .run(new Date().toISOString(), new Date().toISOString());

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'host startup after an unclean stop')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('fires when an explicit continuation is stored', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());
    outDb.prepare('INSERT INTO session_state VALUES (?, ?, ?)').run(
      'work_continuation',
      JSON.stringify({
        id: 'cont-1',
        task: 'write the dbt tests',
        phase: 'queued',
        chain: 2,
        resume_attempts: 0,
      }),
      new Date().toISOString(),
    );

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'graceful host shutdown')).toBe(true);
    expect(noteRows(inDb)).toHaveLength(1);
    const pair = inDb.prepare('SELECT id, trigger, on_wake, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      on_wake: number;
      content: string;
    }>;
    expect(pair).toHaveLength(2);
    expect(pair[0].id).toBe(`recall-${pair[1].id}`);
    expect(pair.map((row) => row.trigger)).toEqual([0, 0]);
    expect(pair.map((row) => row.on_wake)).toEqual([1, 1]);
    expect(JSON.parse(pair[0].content)).toEqual({ subtype: 'recall_context', deferred: true });
  });

  it('stays quiet for an idle session whose last act was a user-facing message', () => {
    const { inDb, outDb } = makeDbs();
    outDb
      .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('o1', 1, ?, 'chat', '{}')")
      .run(new Date().toISOString());

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'graceful host shutdown')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('is idempotent within the restart window', () => {
    const { inDb, outDb } = makeDbs();
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run('m-1', 'processing', new Date().toISOString());

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'first')).toBe(true);
    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'second')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(1);
  });

  it('ignores stale tool state and stale processing claims', () => {
    const { inDb, outDb } = makeDbs();
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    outDb
      .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
      .run(stale, stale);
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run('m-1', 'processing', stale);

    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'startup')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });

  it('allows a distinct restart episode after the ten-minute replay window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
      const { inDb, outDb } = makeDbs();
      outDb
        .prepare("INSERT INTO container_state (id, current_tool, tool_started_at, updated_at) VALUES (1, 'Bash', ?, ?)")
        .run(new Date().toISOString(), new Date().toISOString());
      expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'first restart')).toBe(true);

      vi.setSystemTime(new Date('2026-07-28T12:11:00.000Z'));
      expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'second restart')).toBe(true);
      expect(noteRows(inDb)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a legacy outbound DB without processing_ack', () => {
    const { inDb, outDb } = makeDbs();
    outDb.exec('DROP TABLE processing_ack');
    expect(warnSessionIfWorkInFlight(inDb, outDb, fakeSession(), 'startup')).toBe(false);
    expect(noteRows(inDb)).toHaveLength(0);
  });
});
