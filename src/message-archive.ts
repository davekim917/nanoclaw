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

function openDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(ARCHIVE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  _db = db;
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
       (id, agent_group_id, messaging_group_id, channel_type, platform_id, thread_id, role, sender_id, sender_name, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @platformId, @threadId, @role, @senderId, @senderName, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name
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

/** FTS5 keyword search, grouped and ordered for caller consumption. */
export interface ArchiveSearchHit {
  thread_id: string | null;
  channel_type: string;
  platform_id: string | null;
  latest_message_at: string;
  match_count: number;
  first_snippet: string;
}

/** Sanitize a raw user query for FTS5 MATCH syntax. */
function sanitizeFtsQuery(q: string): string {
  // Strip characters that break FTS5 MATCH tokenization
  return q
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(' ');
}

export function searchThreadsFTS(
  agentGroupId: string,
  query: string,
  limit = 10,
): ArchiveSearchHit[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `SELECT
           a.thread_id,
           a.channel_type,
           a.platform_id,
           MAX(a.sent_at) AS latest_message_at,
           COUNT(*) AS match_count,
           (SELECT snippet(messages_archive_fts, 0, '[', ']', '…', 12)
            FROM messages_archive_fts
            WHERE messages_archive_fts MATCH @q
              AND rowid = a.rowid) AS first_snippet
         FROM messages_archive a
         JOIN messages_archive_fts f ON f.rowid = a.rowid
         WHERE a.agent_group_id = @ag
           AND messages_archive_fts MATCH @q
         GROUP BY a.thread_id, a.channel_type, a.platform_id
         ORDER BY latest_message_at DESC
         LIMIT @limit`,
      )
      .all({ ag: agentGroupId, q: sanitized, limit }) as ArchiveSearchHit[];
    return rows;
  } catch (err) {
    log.warn('FTS search failed', { err, query, sanitized });
    return [];
  }
}

/** Load all messages for a specific thread (permalink resolver). */
export function getThreadMessages(
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  limit = 200,
): Array<{
  id: string;
  role: string;
  sender_name: string | null;
  text: string;
  sent_at: string;
}> {
  const db = openDb();
  return db
    .prepare(
      `SELECT id, role, sender_name, text, sent_at
       FROM messages_archive
       WHERE agent_group_id = ?
         AND channel_type = ?
         AND platform_id = ?
         AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))
       ORDER BY sent_at ASC
       LIMIT ?`,
    )
    .all(agentGroupId, channelType, platformId, threadId, threadId, limit) as Array<{
    id: string;
    role: string;
    sender_name: string | null;
    text: string;
    sent_at: string;
  }>;
}

export const ARCHIVE_DB_PATH = ARCHIVE_PATH;
