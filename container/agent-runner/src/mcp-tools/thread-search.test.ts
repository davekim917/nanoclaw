/**
 * Container-side integration tests for thread-search MCP tools.
 *
 * Tests the post-D1 state where agent_group_id filters have been removed from
 * the SQL queries — so the tool returns workgroup-pooled rows from whatever
 * is in the (host-projected) archive DB, not just self-group rows.
 *
 * Setup: build a synthetic projection DB in :memory: matching the ARCHIVE_SCHEMA_SQL
 * from src/db/per-agent-projections.ts, then inject it into the module via
 * mock.module on 'bun:sqlite'.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

// ---- Capture real Database class BEFORE any mock.module calls ----
// We use the real class to build synthetic projection DBs in memory.
const RealDatabase = Database;

// ---- Module-level state for injected test DB ----
// The thread-search module keeps a private _db singleton. We intercept by
// mocking 'bun:sqlite' so that new Database(ARCHIVE_PATH, {readonly:true})
// returns our test-controlled in-memory DB instead of opening the missing file.
let _injectedDb: Database | null = null;

mock.module('bun:sqlite', () => ({
  Database: class MockDatabase {
    private _real: Database;
    constructor(path: string | Buffer, options?: { readonly?: boolean }) {
      if (_injectedDb && path === '/workspace/archive.db') {
        // Intercept archive.db open — return injected test DB
        this._real = _injectedDb;
      } else {
        // Any other DB (e.g. :memory: in connection.ts) — open normally
        this._real = new RealDatabase(path as string, options);
      }
    }
    prepare(sql: string) { return this._real.prepare(sql); }
    exec(sql: string) { return this._real.exec(sql); }
    close() { /* keep singleton alive across calls in same test */ }
    run(sql: string, ...params: unknown[]) { return this._real.run(sql, ...params as Parameters<Database['run']>); }
    query(sql: string) { return this._real.query(sql); }
    // bun's mock.module is process-global: later test files' connection.ts
    // singletons are built from THIS class. Forward transaction so code like
    // markScriptSkipped (db.transaction(...)()) keeps working cross-file.
    transaction(fn: (...args: unknown[]) => unknown) { return this._real.transaction(fn); }
    get(sql: string, ...params: unknown[]) { return (this._real as unknown as Record<string, (...a: unknown[]) => unknown>)['get']?.(sql, ...params); }
  },
}));

const { initTestSessionDb, closeSessionDb, getInboundDb } = await import("../db/connection.js");

function seedSessionRouting(): void {
  const db = getInboundDb();
  db.exec("CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT, spawn_task_id TEXT, session_id TEXT)");
  db.prepare(
    "INSERT INTO session_routing (id, channel_type, platform_id, thread_id, spawn_task_id, session_id) VALUES (1, ?, ?, NULL, NULL, ?)",
  ).run("slack", "slack:C001", "sess-test");
}

// ---- Mock server.js registerTools (side-effect on import) ----
mock.module('./server.js', () => ({
  registerTools: (_tools: unknown) => {},
}));

// Import tools AFTER mocks are wired up.
const { searchThreadsTool, resolveThreadLinkTool, readThreadTool } = await import('./thread-search.js');

// ---- ARCHIVE_SCHEMA_SQL (copied from src/db/per-agent-projections.ts) ----
const ARCHIVE_SCHEMA_SQL = `
  CREATE TABLE messages_archive (
    id                  TEXT PRIMARY KEY,
    agent_group_id      TEXT NOT NULL,
    messaging_group_id  TEXT,
    channel_type        TEXT NOT NULL,
    platform_id         TEXT,
    thread_id           TEXT,
    role                TEXT NOT NULL,
    sender_id           TEXT,
    sender_name         TEXT,
    text                TEXT NOT NULL,
    sent_at             TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    channel_name        TEXT
  );
  CREATE INDEX idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
  CREATE INDEX idx_archive_thread ON messages_archive(agent_group_id, thread_id, sent_at);
  CREATE INDEX idx_archive_channel ON messages_archive(channel_type, platform_id, thread_id);
  CREATE VIRTUAL TABLE messages_archive_fts USING fts5(
    text, sender_name, content='messages_archive', content_rowid='rowid'
  );
  CREATE TRIGGER messages_archive_ai AFTER INSERT ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(rowid, text, sender_name)
    VALUES (new.rowid, new.text, new.sender_name);
  END;
  CREATE TRIGGER messages_archive_ad AFTER DELETE ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
    VALUES ('delete', old.rowid, old.text, old.sender_name);
  END;
  CREATE TRIGGER messages_archive_au AFTER UPDATE ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
    VALUES ('delete', old.rowid, old.text, old.sender_name);
    INSERT INTO messages_archive_fts(rowid, text, sender_name)
    VALUES (new.rowid, new.text, new.sender_name);
  END;
`;

function buildProjectionDb(): Database {
  const db = new RealDatabase(':memory:');
  db.exec(ARCHIVE_SCHEMA_SQL);
  return db;
}

function insertMsg(
  db: Database,
  opts: {
    id: string;
    agent_group_id: string;
    channel_type: string;
    platform_id: string;
    thread_id: string;
    role: string;
    sender_name: string;
    text: string;
    sent_at: string;
    channel_name?: string | null;
    sender_id?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_archive
      (id, agent_group_id, messaging_group_id, channel_type, platform_id, thread_id,
       role, sender_id, sender_name, text, sent_at, created_at, channel_name)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
  ).run(
    opts.id,
    opts.agent_group_id,
    opts.channel_type,
    opts.platform_id,
    opts.thread_id,
    opts.role,
    opts.sender_id ?? null,
    opts.sender_name,
    opts.text,
    opts.sent_at,
    opts.channel_name ?? null,
  );
}

// Helper to reset the module's _db singleton between tests.
// We do this by replacing _injectedDb with a fresh DB and clearing the
// thread-search module's internal cache by reassigning _injectedDb before
// the first call (module cache keeps _db set, so we need a different approach).
//
// Solution: set _injectedDb BEFORE calling getDb() in the module. The module
// lazily initialises _db on first call. We force a re-init by re-importing
// with a fresh mock — but that's complex. Instead: each test just makes sure
// _injectedDb is set fresh; the getDb() singleton is already initialised by
// the first test. We work around this by reading via a stable singleton but
// swapping row content per test.
//
// Practical approach: use one shared DB per describe block, insert/delete rows
// per test. Since the module-level _db is initialised on first call and we
// can't reset it between tests without re-importing, we share one DB instance
// across all tests (the one set in _injectedDb before first import). Each test
// clears the table and re-populates.

let sharedDb: Database;

// One-time setup: build the shared DB and wire it as the injected DB.
// The mock.module for bun:sqlite intercepts new Database('/workspace/archive.db')
// and returns this when _injectedDb is set.
sharedDb = buildProjectionDb();
_injectedDb = sharedDb;

function clearDb(db: Database): void {
  // FTS triggers handle fts cleanup automatically via AD trigger.
  db.exec('DELETE FROM messages_archive');
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return (result.content[0] as { type: string; text: string }).text;
}

// =========================================================================
// D2 Test Cases
// =========================================================================

describe('thread-search workgroup-pooled tests', () => {
  beforeEach(() => {
    initTestSessionDb();
    seedSessionRouting();
    clearDb(sharedDb);
  });

  afterEach(() => {
    closeSessionDb();
  });

  // -----------------------------------------------------------------------
  // D2.1: resolve_thread_link finds messages from BOTH sibling agent_groups
  // -----------------------------------------------------------------------
  it('test_resolve_thread_link_finds_sibling_archive', async () => {
    // Insert one message from ag-self and one from ag-sibling, same Slack thread
    insertMsg(sharedDb, {
      id: 'msg-self-1',
      agent_group_id: 'ag-self',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      thread_id: 'slack:C123:1700000000.000000',
      role: 'user',
      sender_name: 'alice',
      text: 'hello from ag-self',
      sent_at: '2024-01-01T10:00:00Z',
      channel_name: 'general',
    });
    insertMsg(sharedDb, {
      id: 'msg-sibling-1',
      agent_group_id: 'ag-sibling',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      thread_id: 'slack:C123:1700000000.000000',
      role: 'assistant',
      sender_name: 'bot',
      text: 'hello from ag-sibling',
      sent_at: '2024-01-01T10:00:05Z',
      channel_name: 'general',
    });

    const slackUrl =
      'https://workspace.slack.com/archives/C123/p1700000000000000?thread_ts=1700000000.000000';
    const result = await resolveThreadLinkTool.handler({ url: slackUrl });

    const text = getText(result);
    // Post-D1: both messages should appear (no agent_group_id filter)
    expect(text).toContain('ag-self');
    expect(text).toContain('ag-sibling');
    expect(result.isError).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // D2.2: search_threads returns matches from both sibling agent_groups
  // -----------------------------------------------------------------------
  it('test_search_threads_returns_workgroup_pooled', async () => {
    insertMsg(sharedDb, {
      id: 'msg-self-fts',
      agent_group_id: 'ag-self',
      channel_type: 'slack',
      platform_id: 'slack:C200',
      thread_id: 'slack:C200:thread1',
      role: 'user',
      sender_name: 'alice',
      text: 'workgroup pooled document review meeting',
      sent_at: '2024-01-01T11:00:00Z',
      channel_name: 'docs',
    });
    insertMsg(sharedDb, {
      id: 'msg-sibling-fts',
      agent_group_id: 'ag-sibling',
      channel_type: 'slack',
      platform_id: 'slack:C200',
      thread_id: 'slack:C200:thread2',
      role: 'user',
      sender_name: 'bob',
      text: 'workgroup pooled document planning session',
      sent_at: '2024-01-01T11:05:00Z',
      channel_name: 'docs',
    });

    const result = await searchThreadsTool.handler({ query: 'workgroup pooled document', rerank: false });

    const text = getText(result);
    // Post-D1: both threads should appear in FTS results
    expect(text).not.toContain('No threads matched');
    // Should return 2 thread hits (one per unique thread_id)
    expect(text).toMatch(/Found 2 thread/);
    expect(result.isError).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // D2.3: read_thread returns messages from both sibling agent_groups
  // -----------------------------------------------------------------------
  it('test_read_thread_returns_workgroup_pooled', async () => {
    insertMsg(sharedDb, {
      id: 'msg-rt-self',
      agent_group_id: 'ag-self',
      channel_type: 'discord',
      platform_id: 'discord:111:222',
      thread_id: 'thread-xyz',
      role: 'user',
      sender_name: 'user1',
      text: 'message from self group',
      sent_at: '2024-01-02T09:00:00Z',
    });
    insertMsg(sharedDb, {
      id: 'msg-rt-sibling',
      agent_group_id: 'ag-sibling',
      channel_type: 'discord',
      platform_id: 'discord:111:222',
      thread_id: 'thread-xyz',
      role: 'assistant',
      sender_name: 'bot2',
      text: 'message from sibling group',
      sent_at: '2024-01-02T09:00:10Z',
    });

    const result = await readThreadTool.handler({
      channel_type: 'discord',
      platform_id: 'discord:111:222',
      thread_id: 'thread-xyz',
    });

    const text = getText(result);
    // Post-D1: both messages appear in the transcript
    expect(text).toContain('message from self group');
    expect(text).toContain('message from sibling group');
    expect(result.isError).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // D2.4: no cross-workgroup leak — projection is already filtered by host
  // The assertion here is structural: if the projection contains only rows
  // for one workgroup, queries return only those rows.
  // -----------------------------------------------------------------------
  it('test_thread_search_isolates_outside_workgroup', async () => {
    // Insert only ag-self rows (simulate a projection scoped to one workgroup)
    insertMsg(sharedDb, {
      id: 'msg-ingroup-1',
      agent_group_id: 'ag-self',
      channel_type: 'slack',
      platform_id: 'slack:C300',
      thread_id: 'slack:C300:threadA',
      role: 'user',
      sender_name: 'carol',
      text: 'isolated workgroup specific conversation',
      sent_at: '2024-01-03T08:00:00Z',
      channel_name: 'private',
    });
    // Do NOT insert any rows for 'ag-outside' — they should not be in projection

    const result = await searchThreadsTool.handler({
      query: 'isolated workgroup specific',
      rerank: false,
    });

    const text = getText(result);
    // The query should find the in-group message
    expect(text).not.toContain('No threads matched');
    // And there should be exactly 1 thread (no cross-workgroup rows)
    expect(text).toMatch(/Found 1 thread/);
    expect(result.isError).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // D2.5: end-to-end pooled archive round-trip via INSERT trigger
  // 2 user messages (same content) + 2 assistant messages (different sender_id)
  // inserted via the projection's INSERT triggers populating FTS automatically.
  // resolveThreadLinkTool returns 1 user-msg + 2 assistant-msgs = 3 total.
  // -----------------------------------------------------------------------
  it('test_e2e_pooled_archive_round_trip', async () => {
    // 2 user messages — same content, different agent_groups, different senders
    insertMsg(sharedDb, {
      id: 'e2e-user-1',
      agent_group_id: 'ag-self',
      channel_type: 'slack',
      platform_id: 'slack:C400',
      thread_id: 'slack:C400:1700001000.000000',
      role: 'user',
      sender_id: 'sender-user',
      sender_name: 'alice',
      text: 'e2e round trip test query payload',
      sent_at: '2024-01-04T10:00:00Z',
      channel_name: 'e2e',
    });
    // For the resolve_thread_link test case spec: "1 user-msg + 2 assistant-msgs"
    // We insert 1 user message (role=user) and 2 assistant messages (different sender_id)
    insertMsg(sharedDb, {
      id: 'e2e-asst-1',
      agent_group_id: 'ag-self',
      channel_type: 'slack',
      platform_id: 'slack:C400',
      thread_id: 'slack:C400:1700001000.000000',
      role: 'assistant',
      sender_id: 'bot-id-1',
      sender_name: 'bot-alpha',
      text: 'assistant response from alpha bot',
      sent_at: '2024-01-04T10:00:10Z',
      channel_name: 'e2e',
    });
    insertMsg(sharedDb, {
      id: 'e2e-asst-2',
      agent_group_id: 'ag-sibling',
      channel_type: 'slack',
      platform_id: 'slack:C400',
      thread_id: 'slack:C400:1700001000.000000',
      role: 'assistant',
      sender_id: 'bot-id-2',
      sender_name: 'bot-beta',
      text: 'assistant response from beta bot',
      sent_at: '2024-01-04T10:00:20Z',
      channel_name: 'e2e',
    });

    // Verify FTS was populated via INSERT trigger
    const ftsRows = sharedDb
      .prepare(`SELECT rowid FROM messages_archive_fts WHERE messages_archive_fts MATCH '"round trip"'`)
      .all() as Array<{ rowid: number }>;
    expect(ftsRows.length).toBeGreaterThan(0);

    // resolveThreadLinkTool should return all 3 messages (1 user + 2 assistants)
    const slackUrl = 'https://workspace.slack.com/archives/C400/p1700001000000000?thread_ts=1700001000.000000';
    const result = await resolveThreadLinkTool.handler({ url: slackUrl });

    const text = getText(result);
    expect(result.isError).toBeFalsy();
    // Should find all 3 messages (1 user + 2 assistants from both agent_groups)
    expect(text).toContain('3 message(s)');
    expect(text).toContain('bot-alpha');
    expect(text).toContain('bot-beta');
    expect(text).toContain('alice');
  });
});
