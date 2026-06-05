/**
 * `dispatch_support_issue` delivery-action handler.
 *
 * The inbox-poller agent (illie's channel-root session) calls the
 * `dispatch_support_issue` MCP tool once per triaged support email, AFTER it
 * has decided the email is real support and created/located the Linear ticket.
 * The container writes a `kind='system'` outbound; this host handler applies it.
 *
 * One idempotent path keyed on the Gmail `threadId`:
 *   - NEW thread → post a channel announcement, open a native Slack thread under
 *     it, create a per-thread session in the SAME agent group (illie), seed it
 *     with the issue context, record the mapping, and wake it.
 *   - EXISTING thread (a follow-up email) → route the new email into the
 *     already-open session/thread and wake it. No second thread is created.
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
  insertSupportThread,
  touchSupportThread,
} from '../../db/support-threads.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const MAX_BODY = 3000;

function clip(s: unknown, n = MAX_BODY): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? `${str.slice(0, n)}\n…[truncated]` : str;
}

/** The channel-level announcement that replaces the bundled digest line. */
function announcementText(c: Record<string, unknown>): string {
  const team = typeof c.linearTeam === 'string' ? c.linearTeam : null;
  const issue = typeof c.linearIssue === 'string' ? c.linearIssue : null;
  const tag = [team, issue].filter(Boolean).join(' ') || 'Support';
  const subject = (typeof c.subject === 'string' && c.subject) || '(no subject)';
  const sender = (typeof c.sender === 'string' && c.sender) || 'unknown sender';
  return `🎫 ${tag}: ${subject} — ${sender}`;
}

/** First thread message (bot-posted) — the captured customer email. */
function threadOpener(c: Record<string, unknown>): string {
  const sender = (typeof c.sender === 'string' && c.sender) || 'unknown sender';
  const issue = typeof c.linearIssue === 'string' ? c.linearIssue : null;
  const footer = issue ? `\n\n_Linear: ${issue}_` : '';
  return `📧 *From ${sender}:*\n\n${clip(c.bodyText)}${footer}`;
}

/** Seed inbound that wakes illie to work the new issue in-thread. */
function seedPrompt(c: Record<string, unknown>): string {
  const issue = typeof c.linearIssue === 'string' ? c.linearIssue : '(none)';
  return [
    `New support issue routed to this thread (Linear ${issue}). The customer's email is posted above.`,
    `Assess it and respond in this thread. Loop in engineers with @mentions when you need them.`,
    `Do not send email replies yet — outbound email is a later phase; keep the conversation here in Slack.`,
  ].join(' ');
}

/** Follow-up inbound that wakes illie when a new email lands on an open issue. */
function followupText(c: Record<string, unknown>): string {
  const sender = (typeof c.sender === 'string' && c.sender) || 'unknown sender';
  return `📧 *Follow-up email from ${sender}:*\n\n${clip(c.bodyText)}`;
}

export async function handleDispatchSupportIssue(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const gmailThreadId = content.gmailThreadId as string;
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
  const lastMessageId = typeof content.lastMessageId === 'string' ? content.lastMessageId : null;

  // ── Follow-up: an open issue with a live session already exists ──
  const existing = getSupportThread(gmailThreadId);
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
        content: JSON.stringify({ text: followupText(content), sender: 'system', senderId: 'system' }),
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

  // ── New issue: announcement → thread → session → seed → wake ──
  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.createThread !== 'function' || typeof adapter.postParent !== 'function') {
    log.error('dispatch_support_issue: channel adapter lacks thread support', { channelType: mg.channel_type });
    return;
  }

  const subject = (typeof content.subject === 'string' && content.subject) || 'Support';
  const { messageId: parentMsgId } = await adapter.postParent(mg.platform_id, announcementText(content));
  const { threadId: bareThreadId } = await adapter.createThread(
    mg.platform_id,
    parentMsgId,
    subject.slice(0, 80),
    threadOpener(content),
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
    content: JSON.stringify({ text: seedPrompt(content), sender: 'system', senderId: 'system' }),
  });

  insertSupportThread(
    {
      gmailThreadId,
      agentGroupId: session.agent_group_id,
      messagingGroupId: mg.id,
      linearTeam: typeof content.linearTeam === 'string' ? content.linearTeam : null,
      linearIssue: typeof content.linearIssue === 'string' ? content.linearIssue : null,
      slackParentMsgId: parentMsgId,
      slackThreadId: encodedThreadId,
      sessionId: issueSession.id,
      lastGmailMessageId: lastMessageId,
    },
    now,
  );

  void wakeContainer(issueSession).catch((err) =>
    log.warn('dispatch_support_issue: wake (new) failed', { gmailThreadId, err }),
  );
  log.info('dispatch_support_issue: opened support thread', {
    gmailThreadId,
    sessionId: issueSession.id,
    linearIssue: content.linearIssue ?? null,
    parentMsgId,
  });
}
