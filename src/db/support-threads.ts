/**
 * Support-thread mapping: Gmail thread ⇄ Linear issue ⇄ Slack thread ⇄ session, one row per Gmail `threadId`
 * (migration 041). Every export is a single statement, so none needs `centralTransaction`.
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

export function getSupportThread(gmailThreadId: string): Promise<SupportThread | undefined> {
  return getDb().get<SupportThread>('SELECT * FROM support_threads WHERE gmail_thread_id = ?', gmailThreadId);
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
 * UPSERT, not INSERT OR IGNORE: a row may exist with no live session (seeded from a legacy ticket map, or left by an
 * archived session), and the new session/thread MUST be recorded or every follow-up opens another thread. Linear
 * fields COALESCE so a dispatch without ticket info never clobbers a recorded ticket; `created_at` is preserved.
 */
export async function upsertSupportThread(t: UpsertSupportThread, now: string): Promise<void> {
  await getDb().run(
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
    { ...t, now },
  );
}

/** Keyed on the CALLING session id, so the agent never supplies a cross-row key. */
export function getSupportThreadBySession(
  sessionId: string,
  sessionThreadId: string | null,
): Promise<SupportThread | undefined> {
  // Any agent in the ticket's Slack thread may record the ticket; both keys are host-authored, so the agent still
  // supplies no cross-row key.
  return getDb().get<SupportThread>(
    `SELECT * FROM support_threads
      WHERE session_id = ? OR (? IS NOT NULL AND slack_thread_id = ?)
      ORDER BY (session_id = ?) DESC LIMIT 1`,
    sessionId,
    sessionThreadId,
    sessionThreadId,
    sessionId,
  );
}

export async function setSupportThreadTicket(
  gmailThreadId: string,
  linearIssue: string,
  linearTeam: string | null,
  now: string,
): Promise<void> {
  await getDb().run(
    `UPDATE support_threads
          SET linear_issue = @linearIssue,
              linear_team = COALESCE(@linearTeam, linear_team),
              last_activity_at = @now
        WHERE gmail_thread_id = @gmailThreadId`,
    { gmailThreadId, linearIssue, linearTeam, now },
  );
}

/** Also reopens a closed thread: a customer reply revives the issue. */
export async function touchSupportThread(
  gmailThreadId: string,
  now: string,
  lastGmailMessageId?: string | null,
): Promise<void> {
  await getDb().run(
    `UPDATE support_threads
          SET last_activity_at = @now,
              status = 'open',
              last_gmail_message_id = COALESCE(@lastGmailMessageId, last_gmail_message_id)
        WHERE gmail_thread_id = @gmailThreadId`,
    { gmailThreadId, now, lastGmailMessageId: lastGmailMessageId ?? null },
  );
}

/**
 * Rebinds ONE column. Status and activity belong to `touchSupportThread`. The upsert path would mint a new Slack
 * thread and a duplicate announcement for what is still the same issue.
 */
export async function rebindSupportThreadSession(
  gmailThreadId: string,
  sessionId: string,
  agentGroupId: string,
): Promise<void> {
  // messaging_group_id stays: it names the bot that posted the parent announcement, and only that bot can edit it.
  await getDb().run(
    'UPDATE support_threads SET session_id = @sessionId, agent_group_id = @agentGroupId WHERE gmail_thread_id = @gmailThreadId',
    { gmailThreadId, sessionId, agentGroupId },
  );
}
