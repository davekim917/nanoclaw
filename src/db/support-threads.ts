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
  subject: string | null;
  sender: string | null;
  created_at: string;
  last_activity_at: string;
}

export function getSupportThread(gmailThreadId: string): SupportThread | undefined {
  return getDb().prepare('SELECT * FROM support_threads WHERE gmail_thread_id = ?').get(gmailThreadId) as
    | SupportThread
    | undefined;
}

export interface UpsertSupportThread {
  gmailThreadId: string;
  agentGroupId: string;
  messagingGroupId: string;
  linearTeam: string | null;
  linearIssue: string | null;
  slackParentMsgId: string;
  slackThreadId: string;
  sessionId: string;
  lastGmailMessageId: string | null;
  subject: string | null;
  sender: string | null;
}

/**
 * Record a freshly-opened support thread. UPSERT, not INSERT OR IGNORE: a row
 * may already exist with no live session/thread — either seeded from a legacy
 * ticket map (linear fields set, session/slack null) or left behind when its
 * session was archived (reopen). In both cases the new session/thread MUST be
 * recorded or every later follow-up would open yet another thread. Linear
 * fields use COALESCE so a dispatch without ticket info never clobbers a
 * recorded ticket; `created_at` is preserved on conflict.
 */
export function upsertSupportThread(t: UpsertSupportThread, now: string): void {
  getDb()
    .prepare(
      `INSERT INTO support_threads
         (gmail_thread_id, agent_group_id, messaging_group_id, linear_team, linear_issue,
          slack_parent_msg_id, slack_thread_id, session_id, status, last_gmail_message_id,
          subject, sender, created_at, last_activity_at)
       VALUES (@gmailThreadId, @agentGroupId, @messagingGroupId, @linearTeam, @linearIssue,
          @slackParentMsgId, @slackThreadId, @sessionId, 'open', @lastGmailMessageId,
          @subject, @sender, @now, @now)
       ON CONFLICT(gmail_thread_id) DO UPDATE SET
         agent_group_id = excluded.agent_group_id,
         messaging_group_id = excluded.messaging_group_id,
         linear_team = COALESCE(excluded.linear_team, linear_team),
         linear_issue = COALESCE(excluded.linear_issue, linear_issue),
         slack_parent_msg_id = excluded.slack_parent_msg_id,
         slack_thread_id = excluded.slack_thread_id,
         session_id = excluded.session_id,
         status = 'open',
         last_gmail_message_id = COALESCE(excluded.last_gmail_message_id, last_gmail_message_id),
         subject = COALESCE(excluded.subject, subject),
         sender = COALESCE(excluded.sender, sender),
         last_activity_at = excluded.last_activity_at`,
    )
    .run({ ...t, now });
}

/**
 * Resolve the support thread a per-issue session belongs to. Used by the
 * `update_support_ticket` handler — keying on the CALLING session id means the
 * agent never supplies a cross-row key (same security posture as scheduling).
 */
export function getSupportThreadBySession(sessionId: string): SupportThread | undefined {
  return getDb().prepare('SELECT * FROM support_threads WHERE session_id = ?').get(sessionId) as
    | SupportThread
    | undefined;
}

/** Record the Linear ticket a per-issue session created for its thread. */
export function setSupportThreadTicket(
  gmailThreadId: string,
  linearIssue: string,
  linearTeam: string | null,
  now: string,
): void {
  getDb()
    .prepare(
      `UPDATE support_threads
          SET linear_issue = @linearIssue,
              linear_team = COALESCE(@linearTeam, linear_team),
              last_activity_at = @now
        WHERE gmail_thread_id = @gmailThreadId`,
    )
    .run({ gmailThreadId, linearIssue, linearTeam, now });
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

/**
 * Rebind a thread to a fresh session, and ONLY that.
 *
 * A support thread outlives its session: reclaim archives the session dir and
 * closes the row, but the Slack thread, the Linear ticket and the customer's
 * Gmail thread are all still the same issue. Replacing the whole row (the
 * upsert path) would mint a new Slack thread and a duplicate announcement for
 * what is, to everyone involved, an ongoing conversation.
 */
export function rebindSupportThreadSession(gmailThreadId: string, sessionId: string, now: string): void {
  getDb()
    .prepare(
      `UPDATE support_threads
          SET session_id = @sessionId,
              status = 'open',
              last_activity_at = @now
        WHERE gmail_thread_id = @gmailThreadId`,
    )
    .run({ gmailThreadId, sessionId, now });
}

export function closeSupportThread(gmailThreadId: string, now: string): void {
  getDb()
    .prepare("UPDATE support_threads SET status = 'closed', last_activity_at = ? WHERE gmail_thread_id = ?")
    .run(now, gmailThreadId);
}
