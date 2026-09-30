/**
 * `dispatch_support_issue` (from the inbox poller, idempotent on the Gmail
 * `threadId`): a new thread gets an announcement, a Slack thread and a
 * per-issue session in the poller's agent group, which creates the ticket and
 * reports it via `update_support_ticket`; a follow-up email routes into the
 * open session. All workflow state is host-side in `support_threads`.
 *
 * Not the orchestrator tasks layer: support issues idle for days, which that
 * layer's watchdog would reap.
 *
 * SECURITY: routing comes from the CALLING session's own messaging group or
 * host-written task routing, never from agent-supplied content.
 */
import { randomUUID } from 'node:crypto';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { readContainerConfig } from '../../container-config.js';
import { requestWake } from '../../request-wake.js';
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
import { resolveSession, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const MAX_BODY = 3000;
const TASK_SESSION_PREFIX = 'system:tasks:';

interface SupportTaskContext {
  channelType: string;
  platformId: string;
  flagIntent?: {
    turnModel?: string;
    turnEffort?: string;
  };
}

function clip(s: unknown, n = MAX_BODY): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? `${str.slice(0, n)}\n…[truncated]` : str;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function supportTicketPolicy(agentGroupId: string): Promise<string | null> {
  const agentGroup = await getAgentGroup(agentGroupId);
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
 * Isolated task sessions have no messaging_group_id; the host-authored task row
 * carries the route. Its per-fire flags ride ONE turn, and only a light one:
 * a human's reply or an engineering turn must not inherit the poller's cheap pin.
 */
async function getSupportTaskContext(session: Session): Promise<SupportTaskContext | null> {
  if (!session.thread_id?.startsWith(TASK_SESSION_PREFIX)) return null;
  const seriesId = session.thread_id.slice(TASK_SESSION_PREFIX.length);
  if (!seriesId) return null;

  // Existing-only: no mailbox means no task row, i.e. "no task context".
  const row = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getLatestRoutedTaskRow(seriesId),
  );
  if (!row) return null;

  let flagIntent: SupportTaskContext['flagIntent'];
  try {
    const parsed = JSON.parse(row.content) as {
      flagIntent?: { turnModel?: unknown; turnEffort?: unknown };
    };
    const turnModel = str(parsed.flagIntent?.turnModel);
    const turnEffort = str(parsed.flagIntent?.turnEffort);
    if (turnModel || turnEffort) {
      flagIntent = {
        ...(turnModel ? { turnModel } : {}),
        ...(turnEffort ? { turnEffort } : {}),
      };
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // A malformed task prompt must not block support routing.
  }

  return { channelType: row.channel_type, platformId: row.platform_id, flagIntent };
}

function announcementText(
  subject: string,
  sender: string,
  linearIssue: string | null,
  linearTeam: string | null,
): string {
  const tag = [linearTeam, linearIssue].filter(Boolean).join(' ') || 'Support';
  return `🎫 ${tag}: ${subject} — ${sender}`;
}

/**
 * Container-supplied, so validated strictly (fixed categories kept in step
 * with support-triage.ts, snake_case keys, in-range numbers); anything else
 * drops the whole hint and the email dispatches without it.
 */
interface SupportTriageView {
  product: string | null;
  areaType: 'feature' | 'process' | 'general';
  area: string | null;
  areaConfidence: number;
  category: string;
  categoryConfidence: number;
  urgency: number;
  escapedDefect: number;
}

const TRIAGE_KEY = /^[a-z0-9_]{1,40}$/;

export const TRIAGE_CATEGORIES = new Set([
  'bug',
  'question',
  'access_request',
  'data_request',
  'feature_request',
  'follow_up',
  'acknowledgement',
  'automated_notice',
]);

/** Out of range is malformed, never clamped. */
function inRange(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}

function triageKey(v: unknown): string | null {
  return typeof v === 'string' && TRIAGE_KEY.test(v) ? v : null;
}

function supportTriage(raw: unknown): SupportTriageView | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const areaType = t.areaType;
  if (areaType !== 'feature' && areaType !== 'process' && areaType !== 'general') return null;
  const category = typeof t.category === 'string' && TRIAGE_CATEGORIES.has(t.category) ? t.category : null;
  const categoryConfidence = inRange(t.categoryConfidence, 1);
  const urgency = inRange(t.urgency, 2);
  const escapedDefect = inRange(t.escapedDefect, 1);
  if (!category || categoryConfidence === null || urgency === null || escapedDefect === null) return null;

  const product = t.product === null ? null : triageKey(t.product);
  if (t.product !== null && product === null) return null;

  // No area is exactly (null, 0). Nothing is repaired.
  let area: string | null = null;
  let areaConfidence = 0;
  if (t.area === null) {
    if (t.areaConfidence !== 0) return null;
  } else {
    area = triageKey(t.area);
    const confidence = inRange(t.areaConfidence, 1);
    if (!area || areaType === 'general' || confidence === null) return null;
    areaConfidence = confidence;
  }
  return { product, areaType, area, areaConfidence, category, categoryConfidence, urgency, escapedDefect };
}

const LIGHT_TURN_CATEGORIES = new Set([
  'question',
  'access_request',
  'follow_up',
  'acknowledgement',
  'automated_notice',
]);
const LIGHT_TURN_MIN_CONFIDENCE = 0.7;
const LIGHT_TURN_MAX_DEFECT = 0.5;

function isLightTurn(t: SupportTriageView | null): boolean {
  return (
    t !== null &&
    LIGHT_TURN_CATEGORIES.has(t.category) &&
    t.categoryConfidence >= LIGHT_TURN_MIN_CONFIDENCE &&
    t.escapedDefect < LIGHT_TURN_MAX_DEFECT
  );
}

function escalationStep(t: SupportTriageView): string {
  return (
    `This turn runs on a lighter model because the classifier read this email as ${t.category.replace(/_/g, ' ')}. ` +
    `If it needs engineering work (reading or changing code, querying or correcting data, debugging), do not start it here: ` +
    `finish the ticket step, then call \`wait\` with \`minutes: 0.05\` and a prompt that states the engineering task and the ticket, and end your turn. ` +
    `That wake runs in this thread on the thread's normal model.`
  );
}

function withTurnFlags(
  text: string,
  triage: SupportTriageView | null,
  flagIntent: SupportTaskContext['flagIntent'],
): Record<string, unknown> {
  const light = flagIntent && isLightTurn(triage) ? triage : null;
  return {
    text: light ? `${text}\n\n${escalationStep(light)}` : text,
    sender: 'system',
    senderId: 'system',
    ...(light ? { flagIntent } : {}),
  };
}

function triageArea(t: SupportTriageView): string {
  return t.area ? `${t.area} (${t.areaType})` : t.areaType;
}

function triageContextLine(t: SupportTriageView): string {
  return (
    `Automatic triage (fast classifier — a hint, not a verdict; the email below is authoritative): ` +
    `product ${t.product ?? 'unknown'} · area ${triageArea(t)} [${t.areaConfidence.toFixed(2)}] · ` +
    `category ${t.category} [${t.categoryConfidence.toFixed(2)}] · urgency ${t.urgency.toFixed(1)}/2 · ` +
    `user-facing defect likelihood ${t.escapedDefect.toFixed(2)}`
  );
}

function triageTag(t: SupportTriageView): string {
  return `_Triage: ${triageArea(t)} · ${t.category.replace(/_/g, ' ')}_`;
}

function emailContext(
  subject: string,
  sender: string,
  date: string,
  bodyText: unknown,
  triage: SupportTriageView | null = null,
): string {
  return [
    'Email context (customer-provided content to assess):',
    `Subject: ${subject}`,
    `From: ${sender}`,
    `Date: ${date}`,
    ...(triage ? [triageContextLine(triage)] : []),
    'Body:',
    clip(bodyText),
  ].join('\n');
}

function threadOpener(
  sender: string,
  date: string,
  bodyText: unknown,
  linearIssue: string | null,
  triage: SupportTriageView | null = null,
): string {
  const footer = linearIssue ? `\n\n_Linear: ${linearIssue}_` : '';
  const tag = triage ? `\n${triageTag(triage)}` : '';
  return `📧 *From ${sender}:*\n_Date: ${date}_${tag}\n\n${clip(bodyText)}${footer}`;
}

/**
 * No ticket known: the session CREATES it and reports back. Ticket known: it
 * comments instead of creating a duplicate.
 */
function seedPrompt(
  linearIssue: string | null,
  subject: string,
  sender: string,
  date: string,
  bodyText: unknown,
  ticketPolicy: string | null,
  triage: SupportTriageView | null = null,
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
    return `${protocol}\n\n${emailContext(subject, sender, date, bodyText, triage)}`;
  }
  const protocol =
    `New support issue routed to this thread (no Linear ticket yet — creating it is YOUR first step). ` +
    ticketCreationStep(ticketPolicy) +
    common;
  return `${protocol}\n\n${emailContext(subject, sender, date, bodyText, triage)}`;
}

function followupText(
  subject: string,
  sender: string,
  date: string,
  bodyText: unknown,
  linearIssue: string | null,
  ticketPolicy: string | null,
  triage: SupportTriageView | null = null,
): string {
  const ticketStep = linearIssue
    ? `Post a Linear comment on ${linearIssue} capturing this reply (blockquote, attribute the sender). `
    : `No Linear ticket is recorded for this thread yet — ${ticketCreationStep(ticketPolicy)}`;
  return (
    `📧 *Follow-up email*\n\n${emailContext(subject, sender, date, bodyText, triage)}\n\n` +
    ticketStep +
    `If the reply is a pure acknowledgment (thanks / got it / out-of-office), the Linear comment is enough — stay quiet here. ` +
    `If it's substantive, continue working the issue in this thread.`
  );
}

/**
 * One in-flight dispatch per Gmail thread: concurrent follow-ups otherwise
 * both open a thread and session and one is orphaned. The host is a single
 * Node process, so a promise chain per thread id is the whole lock.
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

export function handleDispatchSupportIssue(content: Record<string, unknown>, session: Session): Promise<void> {
  const gmailThreadId = str(content.gmailThreadId);
  if (!gmailThreadId) {
    log.warn('dispatch_support_issue: rejected — missing gmailThreadId', { sessionId: session.id });
    return Promise.resolve();
  }
  return withSupportThreadLock(gmailThreadId, () => dispatchSupportIssue(gmailThreadId, content, session));
}

async function dispatchSupportIssue(
  gmailThreadId: string,
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskContext = await getSupportTaskContext(session);
  const mg = session.messaging_group_id
    ? await getMessagingGroup(session.messaging_group_id)
    : taskContext
      ? await getMessagingGroupByPlatform(taskContext.channelType, taskContext.platformId)
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
  const triage = supportTriage(content.triage);

  const existing = await getSupportThread(gmailThreadId);
  // Prefer the host's recorded ticket; fall back to what the dispatcher passed.
  const linearIssue = existing?.linear_issue ?? str(content.linearIssue);
  const linearTeam = existing?.linear_team ?? str(content.linearTeam);
  const ticketPolicy = await supportTicketPolicy(session.agent_group_id);

  if (existing && existing.slack_thread_id) {
    const bound = existing.session_id ? await getSession(existing.session_id) : undefined;
    // getSession still answers for a CLOSED session; without the status filter
    // the follow-up would spawn into a row the sweep never watches. Follow-ups go
    // to the poller's own group (the ticket may have changed hands), unless the
    // poller's bot can't reach the thread's channel.
    const ownerGroupId = existing.slack_thread_id.startsWith(`${mg.platform_id}:`)
      ? session.agent_group_id
      : existing.agent_group_id;
    const issueSession = bound?.status === 'active' && bound.agent_group_id === ownerGroupId ? bound : undefined;
    const followup = {
      id: randomUUID(),
      kind: 'chat' as const,
      timestamp: now,
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      threadId: existing.slack_thread_id,
      content: JSON.stringify(
        withTurnFlags(
          followupText(subject, sender, date, content.bodyText, linearIssue, ticketPolicy, triage),
          triage,
          supportFlagIntent,
        ),
      ),
    };

    // Thread, ticket and Gmail thread outlive the session: re-provision in place
    // (only session_id changes), never a second announcement.
    const target =
      issueSession ?? (await resolveSession(ownerGroupId, mg.id, existing.slack_thread_id, 'per-thread')).session;

    await writeSessionMessage(target.agent_group_id, target.id, followup);
    if (issueSession) {
      await touchSupportThread(gmailThreadId, now, lastMessageId);
    } else {
      await rebindSupportThreadSession(gmailThreadId, target.id, target.agent_group_id);
      await touchSupportThread(gmailThreadId, now, lastMessageId);
      log.info('dispatch_support_issue: rebound thread to a fresh session', {
        gmailThreadId,
        previousSessionId: existing.session_id,
        previousAgentGroupId: existing.agent_group_id,
        sessionId: target.id,
      });
    }
    void requestWake(target, 'inbound-message').catch((err) =>
      log.warn('dispatch_support_issue: wake (follow-up) failed', { gmailThreadId, err }),
    );
    log.info('dispatch_support_issue: routed follow-up into existing thread', {
      gmailThreadId,
      sessionId: target.id,
    });
    return;
  }

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
    threadOpener(sender, date, content.bodyText, linearIssue, triage),
  );
  // chat-sdk needs the encoded thread id for routing.
  const encodedThreadId = bareThreadId.includes(':') ? bareThreadId : `${mg.platform_id}:${bareThreadId}`;

  const { session: issueSession } = await resolveSession(session.agent_group_id, mg.id, encodedThreadId, 'per-thread');

  await writeSessionMessage(issueSession.agent_group_id, issueSession.id, {
    id: randomUUID(),
    kind: 'chat',
    timestamp: now,
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: encodedThreadId,
    content: JSON.stringify(
      withTurnFlags(
        seedPrompt(linearIssue, subject, sender, date, content.bodyText, ticketPolicy, triage),
        triage,
        supportFlagIntent,
      ),
    ),
  });

  await upsertSupportThread(
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

  void requestWake(issueSession, 'inbound-message').catch((err) =>
    log.warn('dispatch_support_issue: wake (new) failed', { gmailThreadId, err }),
  );
  log.info('dispatch_support_issue: opened support thread', {
    gmailThreadId,
    sessionId: issueSession.id,
    linearIssue,
    parentMsgId,
  });
}

/** The row is resolved from the CALLING session id; the agent supplies only ticket fields. */
export async function handleUpdateSupportTicket(content: Record<string, unknown>, session: Session): Promise<void> {
  const linearIssue = str(content.linearIssue);
  if (!linearIssue) {
    log.warn('update_support_ticket: rejected — missing linearIssue', { sessionId: session.id });
    return;
  }
  const row = await getSupportThreadBySession(session.id, session.thread_id);
  if (!row) {
    log.warn('update_support_ticket: calling session is not a support-thread session', { sessionId: session.id });
    return;
  }
  const linearTeam = str(content.linearTeam);
  const now = new Date().toISOString();
  await setSupportThreadTicket(row.gmail_thread_id, linearIssue, linearTeam, now);
  log.info('update_support_ticket: ticket recorded', {
    gmailThreadId: row.gmail_thread_id,
    linearIssue,
    sessionId: session.id,
  });

  // Best-effort re-edit of the announcement to show the ticket id.
  if (row.slack_parent_msg_id && row.messaging_group_id) {
    const mg = await getMessagingGroup(row.messaging_group_id);
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
