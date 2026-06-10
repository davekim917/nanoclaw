/**
 * Support-threads delivery-action handlers.
 *
 * `dispatch_support_issue` — called by the inbox-poller agent once per real
 * support email (after noise pre-flight; NO Linear work in the poller). The
 * container writes a `kind='system'` outbound; this host handler applies it.
 *
 * One idempotent path keyed on the Gmail `threadId`:
 *   - NEW thread → post a channel announcement, open a native Slack thread under
 *     it, create a per-thread session in the SAME agent group as the poller,
 *     seed it with the issue context + ticketing protocol, record the mapping,
 *     and wake it. The PER-ISSUE session creates the Linear ticket (or comments
 *     if a ticket is already known) and reports it back via
 *     `update_support_ticket` — the poller carries no per-agent state at all.
 *   - EXISTING thread (a follow-up email) → route the new email into the
 *     already-open session/thread and wake it. No second thread is created.
 *
 * `update_support_ticket` — called by a per-issue session after it creates the
 * Linear ticket. Resolved by the CALLING session id (never an agent-supplied
 * key), records the ticket on the row, and best-effort edits the channel
 * announcement to show the ticket id.
 *
 * State design (Dave, 2026-06-09): ALL workflow state lives host-side in the
 * central `support_threads` table. No bedroom or workgroup files — any agent
 * assigned to the workflow inherits protocol (repo) + state (host) wholesale.
 *
 * Deliberately does NOT use the orchestrator-dispatch tasks/watchdog layer:
 * support issues idle for days awaiting an engineer reply, and the watchdog is
 * built to *reap* idle workers — the opposite of what a support thread needs.
 * It reuses only the low-level primitives (postParent → createThread →
 * resolveSession('per-thread') → seed → wake), mirroring dispatch.ts:311-405.
 *
 * SECURITY: routing is derived from the CALLING session's own messaging group
 * (`session.messaging_group_id`) and agent group — never from agent-supplied
 * platform/channel fields — preserving the post-2026-05-02 cross-tenant
 * invariant (see scheduling/actions.ts).
 */
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import {
  getSupportThread,
  getSupportThreadBySession,
  setSupportThreadTicket,
  touchSupportThread,
  upsertSupportThread,
} from '../../db/support-threads.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const MAX_BODY = 3000;

function clip(s: unknown, n = MAX_BODY): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? `${str.slice(0, n)}\n…[truncated]` : str;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The channel-level announcement (the working thread's parent message). */
function announcementText(
  subject: string,
  sender: string,
  linearIssue: string | null,
  linearTeam: string | null,
): string {
  const tag = [linearTeam, linearIssue].filter(Boolean).join(' ') || 'Support';
  return `🎫 ${tag}: ${subject} — ${sender}`;
}

/** First thread message (bot-posted) — the captured customer email. */
function threadOpener(sender: string, bodyText: unknown, linearIssue: string | null): string {
  const footer = linearIssue ? `\n\n_Linear: ${linearIssue}_` : '';
  return `📧 *From ${sender}:*\n\n${clip(bodyText)}${footer}`;
}

/**
 * Seed inbound that wakes the per-issue session. Two variants:
 *  - no ticket known → the session CREATES the Linear issue, then reports it
 *    back via `update_support_ticket`;
 *  - ticket known (seeded legacy row, or the dispatcher passed one) → the
 *    session posts a Linear comment instead of creating a duplicate.
 */
function seedPrompt(linearIssue: string | null): string {
  const common = [
    `Then assess the issue and respond in this thread — this thread is the working space for this support issue.`,
    `Loop in engineers with @-mentions when you need them. Keep ALL progress and results in this thread.`,
    `Do NOT send email replies — outbound email is a later phase; the conversation stays in Slack.`,
  ].join(' ');
  if (linearIssue) {
    return (
      `New support email routed to this thread. A Linear ticket already exists for it: ${linearIssue}. ` +
      `First post a Linear comment on ${linearIssue} capturing the email above (blockquote the new content, attribute the sender). Do NOT create a new ticket. ` +
      common
    );
  }
  return (
    `New support issue routed to this thread (no Linear ticket yet — creating it is YOUR first step). ` +
    `1) Create the Linear issue with your Linear tools: team "Apollo" if the email clearly references Apollo, otherwise "XZO" (XZO is the failover default); ` +
    `title = the email subject; description = sender/date/subject header + the full email body + a "Source: support@illysium.ai" footer; ` +
    `priority 2 (High) if it mentions urgent/down/outage/broken/can't login, else 3 (Medium). ` +
    `2) Immediately call update_support_ticket({ linearIssue: "<IDENT>", linearTeam: "<team>" }) so the host records the ticket for this thread. ` +
    common
  );
}

/** Follow-up inbound for a new email landing on an open issue. */
function followupText(sender: string, bodyText: unknown, linearIssue: string | null): string {
  const ticketStep = linearIssue
    ? `Post a Linear comment on ${linearIssue} capturing this reply (blockquote, attribute the sender). `
    : `No Linear ticket is recorded for this thread yet — create one first (team: Apollo if clearly Apollo, else XZO; then call update_support_ticket). `;
  return (
    `📧 *Follow-up email from ${sender}:*\n\n${clip(bodyText)}\n\n` +
    ticketStep +
    `If the reply is a pure acknowledgment (thanks / got it / out-of-office), the Linear comment is enough — stay quiet here. ` +
    `If it's substantive, continue working the issue in this thread.`
  );
}

export async function handleDispatchSupportIssue(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const gmailThreadId = str(content.gmailThreadId);
  if (!gmailThreadId) {
    log.warn('dispatch_support_issue: rejected — missing gmailThreadId', { sessionId: session.id });
    return;
  }
  if (!session.messaging_group_id) {
    log.warn('dispatch_support_issue: rejected — calling session has no messaging_group_id', {
      gmailThreadId,
      sessionId: session.id,
    });
    return;
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    log.error('dispatch_support_issue: messaging group not found', { messagingGroupId: session.messaging_group_id });
    return;
  }

  const now = new Date().toISOString();
  const lastMessageId = str(content.lastMessageId);
  const sender = str(content.sender) ?? 'unknown sender';
  const subject = str(content.subject) ?? '(no subject)';

  const existing = getSupportThread(gmailThreadId);
  // Ticket identity: prefer what the host already recorded; fall back to what
  // the dispatcher passed (it may know from a legacy flow).
  const linearIssue = existing?.linear_issue ?? str(content.linearIssue);
  const linearTeam = existing?.linear_team ?? str(content.linearTeam);

  // ── Follow-up: an open issue with a live session already exists ──
  if (existing && existing.session_id && existing.slack_thread_id) {
    const issueSession = getSession(existing.session_id);
    if (issueSession) {
      await writeSessionMessage(issueSession.agent_group_id, issueSession.id, {
        id: randomUUID(),
        kind: 'chat',
        timestamp: now,
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        threadId: existing.slack_thread_id,
        content: JSON.stringify({
          text: followupText(sender, content.bodyText, linearIssue),
          sender: 'system',
          senderId: 'system',
        }),
      });
      touchSupportThread(gmailThreadId, now, lastMessageId);
      void wakeContainer(issueSession).catch((err) =>
        log.warn('dispatch_support_issue: wake (follow-up) failed', { gmailThreadId, err }),
      );
      log.info('dispatch_support_issue: routed follow-up into existing thread', {
        gmailThreadId,
        sessionId: issueSession.id,
      });
      return;
    }
    // The session was archived/pruned — fall through and open a fresh thread+session.
    log.info('dispatch_support_issue: existing mapping had no live session, reopening', { gmailThreadId });
  }

  // ── New issue (or seeded/orphaned row): announcement → thread → session → seed → wake ──
  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.createThread !== 'function' || typeof adapter.postParent !== 'function') {
    log.error('dispatch_support_issue: channel adapter lacks thread support', { channelType: mg.channel_type });
    return;
  }

  const { messageId: parentMsgId } = await adapter.postParent(
    mg.platform_id,
    announcementText(subject, sender, linearIssue, linearTeam),
  );
  const { threadId: bareThreadId } = await adapter.createThread(
    mg.platform_id,
    parentMsgId,
    subject.slice(0, 80),
    threadOpener(sender, content.bodyText, linearIssue),
  );
  // chat-sdk needs the encoded thread id (`<platform_id>:<thread>`) for routing,
  // mirroring orchestrator-dispatch (dispatch.ts:363-364).
  const encodedThreadId = bareThreadId.includes(':') ? bareThreadId : `${mg.platform_id}:${bareThreadId}`;

  const { session: issueSession } = resolveSession(session.agent_group_id, mg.id, encodedThreadId, 'per-thread');

  await writeSessionMessage(issueSession.agent_group_id, issueSession.id, {
    id: randomUUID(),
    kind: 'chat',
    timestamp: now,
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: encodedThreadId,
    content: JSON.stringify({ text: seedPrompt(linearIssue), sender: 'system', senderId: 'system' }),
  });

  upsertSupportThread(
    {
      gmailThreadId,
      agentGroupId: session.agent_group_id,
      messagingGroupId: mg.id,
      linearTeam,
      linearIssue,
      slackParentMsgId: parentMsgId,
      slackThreadId: encodedThreadId,
      sessionId: issueSession.id,
      lastGmailMessageId: lastMessageId,
      subject,
      sender,
    },
    now,
  );

  void wakeContainer(issueSession).catch((err) =>
    log.warn('dispatch_support_issue: wake (new) failed', { gmailThreadId, err }),
  );
  log.info('dispatch_support_issue: opened support thread', {
    gmailThreadId,
    sessionId: issueSession.id,
    linearIssue,
    parentMsgId,
  });
}

/**
 * `update_support_ticket` — a per-issue session reports the Linear ticket it
 * created. The row is resolved from the CALLING session id; the agent supplies
 * only the ticket fields. Best-effort: re-edit the channel announcement so the
 * parent message shows the ticket id.
 */
export async function handleUpdateSupportTicket(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const linearIssue = str(content.linearIssue);
  if (!linearIssue) {
    log.warn('update_support_ticket: rejected — missing linearIssue', { sessionId: session.id });
    return;
  }
  const row = getSupportThreadBySession(session.id);
  if (!row) {
    log.warn('update_support_ticket: calling session is not a support-thread session', { sessionId: session.id });
    return;
  }
  const linearTeam = str(content.linearTeam);
  const now = new Date().toISOString();
  setSupportThreadTicket(row.gmail_thread_id, linearIssue, linearTeam, now);
  log.info('update_support_ticket: ticket recorded', {
    gmailThreadId: row.gmail_thread_id,
    linearIssue,
    sessionId: session.id,
  });

  // Best-effort announcement edit — recompose the full announcement (subject +
  // sender are stored on the row) so the parent message now shows the ticket id.
  if (row.slack_parent_msg_id && row.messaging_group_id) {
    const mg = getMessagingGroup(row.messaging_group_id);
    const adapter = mg ? getChannelAdapter(mg.channel_type) : undefined;
    if (mg && adapter) {
      const text = announcementText(
        row.subject ?? '(no subject)',
        row.sender ?? 'unknown sender',
        linearIssue,
        linearTeam ?? row.linear_team,
      );
      try {
        await adapter.deliver(mg.platform_id, null, {
          kind: 'chat',
          content: { operation: 'edit', messageId: row.slack_parent_msg_id, text },
        });
      } catch (err) {
        log.warn('update_support_ticket: announcement edit failed (non-fatal)', {
          gmailThreadId: row.gmail_thread_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
