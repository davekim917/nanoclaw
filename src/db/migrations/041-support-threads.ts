import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Maps a support email thread (Gmail `threadId`, the key) to its own Slack thread and per-thread session, so each
 * issue and its follow-ups get one conversation. Central because follow-up routing happens host-side in the
 * `dispatch_support_issue` handler. `slack_thread_id` is the chat-sdk ENCODED thread id used for session routing;
 * `last_gmail_message_id` is the RFC-822 Message-ID kept for reply threading.
 */
export const migration041: Migration = {
  version: 41,
  name: 'support-threads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS support_threads (
        gmail_thread_id       TEXT PRIMARY KEY,
        agent_group_id        TEXT NOT NULL,
        messaging_group_id    TEXT NOT NULL,
        linear_team           TEXT,
        linear_issue          TEXT,
        slack_parent_msg_id   TEXT,
        slack_thread_id       TEXT,
        session_id            TEXT,
        status                TEXT NOT NULL DEFAULT 'open',
        last_gmail_message_id TEXT,
        created_at            TEXT NOT NULL,
        last_activity_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_support_threads_session ON support_threads(session_id);
      CREATE INDEX IF NOT EXISTS idx_support_threads_agent ON support_threads(agent_group_id);
    `);
  },
};
