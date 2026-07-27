import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 041 — support-threads
 *
 * Maps one support email thread (Gmail `threadId`) to its dedicated Slack
 * working thread + per-thread agent session, so the inbox poller can route
 * each support issue to its own conversation (and follow-up emails back into
 * the same one) instead of collapsing every email into the shared poller
 * session. See docs/specs/per-email-thread-sessions/scope.md.
 *
 * Host-readable (central DB) because follow-up routing — "this Gmail thread
 * already has a Slack thread/session, wake it" — happens host-side in the
 * `dispatch_support_issue` delivery-action handler.
 *
 * Columns:
 *   gmail_thread_id       — Gmail thread id; the stable 1:1 key (PRIMARY KEY).
 *   agent_group_id        — the agent group whose session works the issue (helper).
 *   messaging_group_id    — the channel the announcement + thread live in.
 *   linear_team           — routed Linear team (e.g. "EXAMPLE" / "Example Data"), nullable.
 *   linear_issue          — Linear issue identifier (e.g. "EXAMPLE-123"), nullable.
 *   slack_parent_msg_id   — the channel announcement message id (thread parent).
 *   slack_thread_id       — chat-sdk *encoded* thread id used for session routing.
 *   session_id            — the per-issue per-thread session id.
 *   status                — 'open' | 'closed' (lifecycle; reopened on follow-up).
 *   last_gmail_message_id — RFC-822 Message-ID of the latest message; retained
 *                           for v2 outbound-reply threading (In-Reply-To/References).
 *   created_at / last_activity_at — ISO timestamps.
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
