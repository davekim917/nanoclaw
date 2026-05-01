/**
 * Central archive of every chat message v2 sees — inbound (from users)
 * and outbound (from agents). Stored in `data/archive.db` (separate from
 * v2.db so we can mount it read-only into agent containers) with an FTS5
 * virtual table over the text body.
 *
 * Host side (this module) writes on every chat inbound/outbound. Agent
 * containers read via the mount at `/workspace/archive.db` to power the
 * `search_threads` MCP tool (Phase 2.9) and `resolve_thread_link` (2.10).
 *
 * Design decisions:
 *  - Separate DB file (not a table in v2.db). Lets us mount RO into the
 *    container without exposing central state like pending_approvals,
 *    agent_groups, etc.
 *  - Self-bootstrapping schema on first open. Not part of v2.db's
 *    migration chain because the file lives outside v2.db.
 *  - FTS5 auto-sync via triggers. Inserts flow automatically into the
 *    virtual table.
 *  - `agent_group_id` in every row is our scoping key (v1 used
 *    `group_folder`; v2 uses the AG id).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db');

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

function openDb(): Database.Database {
  // Re-key the cache on the archive path. Under test, beforeEach wipes
  // DATA_DIR and the previously-cached connection points at an unlinked fd;
  // comparing paths catches the swap without requiring a test-only close API.
  if (_db && _dbPath === ARCHIVE_PATH && fs.existsSync(ARCHIVE_PATH)) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      // swallow — stale handle
    }
    _db = null;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(ARCHIVE_PATH);
  // TRUNCATE (not WAL). We have one writer (host) and many cross-process
  // readers (containers reading via a read-only mount of archive.db only).
  // In WAL mode readers need access to the -wal and -shm sidecar files; we
  // don't mount those into the container, so WAL writes would be invisible
  // to the MCP tools. TRUNCATE flushes every write straight to the main
  // file, which containers see immediately. Write volume is per-chat-
  // message so the perf delta vs WAL is a non-issue.
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  _db = db;
  _dbPath = ARCHIVE_PATH;
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      channel_name        TEXT,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Additive migration for pre-existing archives that were created
    -- without the channel_name column. No-op if the column already
    -- exists (we swallow the SQLITE_ERROR below).
  `);
  try {
    db.exec('ALTER TABLE messages_archive ADD COLUMN channel_name TEXT');
  } catch {
    // column already exists
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_thread ON messages_archive(agent_group_id, thread_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_channel ON messages_archive(channel_type, platform_id, thread_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_archive_fts USING fts5(
      text,
      sender_name,
      content='messages_archive',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_archive_ai AFTER INSERT ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_ad AFTER DELETE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_au AFTER UPDATE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
  `);
}

export interface ArchiveMessage {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: 'user' | 'assistant' | 'system';
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
}

const upsertStmt = () =>
  openDb().prepare(
    `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id, thread_id, role, sender_id, sender_name, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @channelName, @platformId, @threadId, @role, @senderId, @senderName, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name,
       channel_name = COALESCE(excluded.channel_name, channel_name)
     WHERE excluded.text IS NOT NULL`,
  );

export function upsertArchiveMessage(msg: ArchiveMessage): void {
  if (!msg.text || msg.text.length === 0) return;
  try {
    upsertStmt().run(msg);
  } catch (err) {
    log.warn('Failed to upsert archive message', { id: msg.id, err });
  }
}

