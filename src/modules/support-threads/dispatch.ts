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
 * State design: ALL workflow state lives host-side in the
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
 * or, for an isolated system task, its host-written messages_in routing
 * columns — never from agent-supplied action content. This preserves the
 * post-2026-05-02 cross-tenant invariant (see scheduling/actions.ts).
 */
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { readContainerConfig } from '../../container-config.js';
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import {
  getSupportThread,
  getSupportThreadBySession,
  rebindSupportThreadSession,
  setSupportThreadTicket,
  touchSupportThread,
  upsertSupportThread,
} from '../../db/support-threads.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const MAX_BODY = 3000;
const TASK_SESSION_PREFIX = 'system:tasks:';

interface SupportTaskContext {
  channelType: string;
  platformId: string;
  flagIntent?: {
    stickyModel?: string;
    stickyEffort?: string;
  };
}

function clip(s: unknown, n = MAX_BODY): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? `${str.slice(0, n)}\n…[truncated]` : str;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function supportTicketPolicy(agentGroupId: string): string | null {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) return null;
  const credentialFolder = readContainerConfig(agentGroup.folder).credentialFolder ?? agentGroup.folder;
  const scopedName = `NANOCLAW_SUPPORT_TICKET_POLICY_${credentialFolder.toUpperCase().replace(/-/g, '_')}`;
  return str(process.env[scopedName]) ?? str(process.env.NANOCLAW_SUPPORT_TICKET_POLICY);
}

function ticketCreationStep(policy: string | null): string {
  return policy
    ? `Create the Linear issue using this operator-configured policy: ${policy} `
    : `Create the Linear issue in the appropriate team using the email subject as the title, include the complete email context in the description, choose priority from the reported impact, then immediately call update_support_ticket with the created issue identifier and team. `;
}

/**
 * Isolated scheduled-task sessions have no central messaging_group_id. Their
 * host-authored task row carries the delivery route instead, and its per-fire
 * turn flags are the model policy that should follow work dispatched from that
 * fire. Convert those one-turn flags to sticky flags for the dedicated support
 * session so later engineer replies stay on the same model/effort.
 */
function getSupportTaskContext(session: Session, inDb: Database.Database): SupportTaskContext | null {
  if (!session.thread_id?.startsWith(TASK_SESSION_PREFIX)) return null;
  const seriesId = session.thread_id.slice(TASK_SESSION_PREFIX.length);
  if (!seriesId) return null;

  const row = inDb
    .prepare(
      `SELECT channel_type, platform_id, content
         FROM messages_in
        WHERE kind = 'task'
          AND series_id = ?
          AND channel_type IS NOT NULL
          AND platform_id IS NOT NULL
     ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(seriesId) as { channel_type: string; platform_id: string; content: string } | undefined;
  if (!row) return null;

  let flagIntent: SupportTaskContext['flagIntent'];
  try {
    const parsed = JSON.parse(row.content) as {
      flagIntent?: { turnModel?: unknown; turnEffort?: unknown };
    };
    const stickyModel = str(parsed.flagIntent?.turnModel);
    const stickyEffort = str(parsed.flagIntent?.turnEffort);
    if (stickyModel || stickyEffort) {
      flagIntent = {
        ...(stickyModel ? { stickyModel } : {}),
        ...(stickyEffort ? { stickyEffort } : {}),
      };
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // A malformed task prompt must not block support routing. Task creation
    // normally validates this JSON; fall back to provider defaults if corrupt.
  }

  return { channelType: row.channel_type, platformId: row.platform_id, flagIntent };
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

function emailContext(subject: string, sender: string, date: string, bodyText: unknown): string {
  return [
    'Email context (customer-provided content to assess):',
    `Subject: ${subject}`,
    `From: ${sender}`,
    `Date: ${date}`,
    'Body:',
    clip(bodyText),
  ].join('\n');
}

/** First thread message (bot-posted) — the captured customer email. */
function threadOpener(sender: string, date: string, bodyText: unknown, linearIssue: string | null): string {
  const footer = linearIssue ? `\n\n_Linear: ${linearIssue}_` : '';
  return `📧 *From ${sender}:*\n_Date: ${date}_\n\n${clip(bodyText)}${footer}`;
}

/**
 * Seed inbound that wakes the per-issue session. Two variants:
 *  - no ticket known → the session CREATES the Linear issue, then reports it
 *    back via `update_support_ticket`;
 *  - ticket known (seeded legacy row, or the dispatcher passed one) → the
 *    session posts a Linear comment instead of creating a duplicate.
 */
function seedPrompt(
  linearIssue: string | null,
  subject: string,
  sender: string,
  date: string,
  bodyText: unknown,
  ticketPolicy: string | null,
): string {
  const common = [
    `Then assess the issue and respond in this thread — this thread is the working space for this support issue.`,
    `Loop in engineers with @-mentions when you need them. Keep ALL progress and results in this thread.`,
    `Do NOT send email replies — outbound email is a later phase; the conversation stays in Slack.`,
  ].join(' ');
  if (linearIssue) {
    const protocol =
      `New support email routed to this thread. A Linear ticket already exists for it: ${linearIssue}. ` +
      `First post a Linear comment on ${linearIssue} capturing the email context below (blockquote the new content, attribute the sender). Do NOT create a new ticket. ` +
      common;
    return `${protocol}\n\n${emailContext(subject, sender, date, bodyText)}`;
  }
  const protocol =
    `New support issue routed to this thread (no Linear ticket yet — creating it is YOUR first step). ` +
    ticketCreationStep(ticketPolicy) +
    common;
  return `${protocol}\n\n${emailContext(subject, sender, date, bodyText)}`;
}

/** Follow-up inbound for a new email landing on an open issue. */
function followupText(
  subject: string,
  sender: string,
  date: string,
  bodyText: unknown,
  linearIssue: string | null,
  ticketPolicy: string | null,
): string {
  const ticketStep = linearIssue
    ? `Post a Linear comment on ${linearIssue} capturing this reply (blockquote, attribute the sender). `
    : `No Linear ticket is recorded for this thread yet — ${ticketCreationStep(ticketPolicy)}`;
  return (
    `📧 *Follow-up email*\n\n${emailContext(subject, sender, date, bodyText)}\n\n` +
    ticketStep +
    `If the reply is a pure acknowledgment (thanks / got it / out-of-office), the Linear comment is enough — stay quiet here. ` +
    `If it's substantive, continue working the issue in this thread.`
  );
}

/**
 * One in-flight dispatch per Gmail thread. Two follow-ups arriving together
 * used to race: both read the same stale binding, both opened a thread and a
 * session, and the second upsert overwrote the first — one orphaned session,
 * one duplicate Slack thread, one message delivered where nobody was reading.
 * The host is a single Node process, so a promise chain per thread id is the
 * whole lock.
 */
const dispatchChains = new Map<string, Promise<unknown>>();

function withSupportThreadLock<T>(gmailThreadId: string, run: () => Promise<T>): Promise<T> {
  const prior = dispatchChains.get(gmailThreadId) ?? Promise.resolve();
  const next = prior.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  dispatchChains.set(gmailThreadId, settled);
  void settled.then(() => {
    if (dispatchChains.get(gmailThreadId) === settled) dispatchChains.delete(gmailThreadId);
  });
  return next;
}

export function handleDispatchSupportIssue(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const gmailThreadId = str(content.gmailThreadId);
  if (!gmailThreadId) {
    log.warn('dispatch_support_issue: rejected — missing gmailThreadId', { sessionId: session.id });
    return Promise.resolve();
  }
  return withSupportThreadLock(gmailThreadId, () => dispatchSupportIssue(gmailThreadId, content, session, inDb));
}

async function dispatchSupportIssue(
  gmailThreadId: string,
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskContext = getSupportTaskContext(session, inDb);
  const mg = session.messaging_group_id
    ? getMessagingGroup(session.messaging_group_id)
    : taskContext
      ? getMessagingGroupByPlatform(taskContext.channelType, taskContext.platformId)
      : undefined;
  if (!mg) {
    log.warn('dispatch_support_issue: rejected — no host-authoritative messaging group route', {
      gmailThreadId,
      sessionId: session.id,
    });
    return;
  }
  const supportFlagIntent = taskContext?.flagIntent;

  const now = new Date().toISOString();
  const lastMessageId = str(content.lastMessageId);
  const sender = str(content.sender) ?? 'unknown sender';
  const subject = str(content.subject) ?? '(no subject)';
  const date = str(content.date) ?? '(date unavailable)';

  const existing = getSupportThread(gmailThreadId);
  // Ticket identity: prefer what the host already recorded; fall back to what
  // the dispatcher passed (it may know from a legacy flow).
  const linearIssue = existing?.linear_issue ?? str(content.linearIssue);
  const linearTeam = existing?.linear_team ?? str(content.linearTeam);
  const ticketPolicy = supportTicketPolicy(session.agent_group_id);

  // ── Follow-up: an open issue with a live Slack thread already exists ──
  if (existing && existing.slack_thread_id) {
    const bound = existing.session_id ? getSession(existing.session_id) : undefined;
    // Reclaim only CLOSES a session row, it never deletes it, so `getSession`
    // still answers for an archived session. Without the status filter the
    // follow-up wrote into (and spawned a container for) a status='closed'
    // row — permanently invisible to host-sweep's stuck/heartbeat machinery.
    const issueSession = bound?.status === 'active' ? bound : undefined;
    const followup = {
      id: randomUUID(),
      kind: 'chat' as const,
      timestamp: now,
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      threadId: existing.slack_thread_id,
      content: JSON.stringify({
        text: followupText(subject, sender, date, content.bodyText, linearIssue, ticketPolicy),
        sender: 'system',
        senderId: 'system',
        ...(supportFlagIntent ? { flagIntent: supportFlagIntent } : {}),
      }),
    };

    // The Slack thread, the Linear ticket and the customer's Gmail thread all
    // outlive the session. A reclaimed session is re-provisioned in place —
    // same thread, same ticket, ONLY session_id changes — instead of opening a
    // second announcement for one ongoing conversation.
    const target =
      issueSession ?? resolveSession(existing.agent_group_id, mg.id, existing.slack_thread_id, 'per-thread').session;

    await writeSessionMessage(target.agent_group_id, target.id, followup);
    if (issueSession) {
      touchSupportThread(gmailThreadId, now, lastMessageId);
    } else {
      rebindSupportThreadSession(gmailThreadId, target.id);
      touchSupportThread(gmailThreadId, now, lastMessageId);
      log.info('dispatch_support_issue: rebound thread to a fresh session', {
        gmailThreadId,
        previousSessionId: existing.session_id,
        sessionId: target.id,
      });
    }
    void wakeContainer(target).catch((err) =>
      log.warn('dispatch_support_issue: wake (follow-up) failed', { gmailThreadId, err }),
    );
    log.info('dispatch_support_issue: routed follow-up into existing thread', {
      gmailThreadId,
      sessionId: target.id,
    });
    return;
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
    threadOpener(sender, date, content.bodyText, linearIssue),
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
    content: JSON.stringify({
      text: seedPrompt(linearIssue, subject, sender, date, content.bodyText, ticketPolicy),
      sender: 'system',
      senderId: 'system',
      ...(supportFlagIntent ? { flagIntent: supportFlagIntent } : {}),
    }),
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
