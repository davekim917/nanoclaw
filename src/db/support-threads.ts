/**
 * Support-thread mapping: Gmail thread ⇄ Linear issue ⇄ Slack thread ⇄ session.
 *
 * One row per support email thread (keyed on Gmail `threadId`). Written by the
 * `dispatch_support_issue` delivery-action handler when it opens a new per-issue
 * Slack thread + session, and read by the same handler to route follow-up emails
 * back into the existing thread/session. See migration 041.
 */
import { getDb } from './connection.js';

export interface SupportThread {
  gmail_thread_id: string;
  agent_group_id: string;
  messaging_group_id: string;
  linear_team: string | null;
  linear_issue: string | null;
  slack_parent_msg_id: string | null;
  slack_thread_id: string | null;
  session_id: string | null;
  status: string;
  last_gmail_message_id: string | null;
  created_at: string;
  last_activity_at: string;
}

export function getSupportThread(gmailThreadId: string): SupportThread | undefined {
  return getDb()
    .prepare('SELECT * FROM support_threads WHERE gmail_thread_id = ?')
    .get(gmailThreadId) as SupportThread | undefined;
}

export interface InsertSupportThread {
  gmailThreadId: string;
  agentGroupId: string;
  messagingGroupId: string;
  linearTeam: string | null;
  linearIssue: string | null;
  slackParentMsgId: string;
  slackThreadId: string;
  sessionId: string;
  lastGmailMessageId: string | null;
}

/**
 * Record a freshly-opened support thread. `INSERT OR IGNORE` so a duplicate
 * dispatch for the same Gmail thread (retried fire, racing poll) can't create
 * a second row — the caller checks `getSupportThread` first, this is the
 * belt-and-suspenders guard. Returns true if a row was inserted.
 */
export function insertSupportThread(t: InsertSupportThread, now: string): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO support_threads
         (gmail_thread_id, agent_group_id, messaging_group_id, linear_team, linear_issue,
          slack_parent_msg_id, slack_thread_id, session_id, status, last_gmail_message_id,
          created_at, last_activity_at)
       VALUES (@gmailThreadId, @agentGroupId, @messagingGroupId, @linearTeam, @linearIssue,
          @slackParentMsgId, @slackThreadId, @sessionId, 'open', @lastGmailMessageId,
          @now, @now)`,
    )
    .run({ ...t, now });
  return res.changes > 0;
}

/**
 * Touch a thread on new activity (a follow-up email or engineer reply). Bumps
 * `last_activity_at`, refreshes `last_gmail_message_id` when supplied, and
 * reopens a previously-closed thread (a customer reply revives the issue).
 */
export function touchSupportThread(gmailThreadId: string, now: string, lastGmailMessageId?: string | null): void {
  getDb()
    .prepare(
      `UPDATE support_threads
          SET last_activity_at = @now,
              status = 'open',
              last_gmail_message_id = COALESCE(@lastGmailMessageId, last_gmail_message_id)
        WHERE gmail_thread_id = @gmailThreadId`,
    )
    .run({ gmailThreadId, now, lastGmailMessageId: lastGmailMessageId ?? null });
}

export function closeSupportThread(gmailThreadId: string, now: string): void {
  getDb()
    .prepare("UPDATE support_threads SET status = 'closed', last_activity_at = ? WHERE gmail_thread_id = ?")
    .run(now, gmailThreadId);
}
