/**
 * Integration tests for the support-threads handlers.
 *
 * dispatch_support_issue: a new Gmail thread opens exactly one channel
 * announcement + native thread + per-issue session and records the mapping;
 * the per-issue session is seeded with the ticket-creation protocol (purest
 * design — the poller does no Linear work). A follow-up email routes into the
 * existing session WITHOUT opening a second thread. A seeded/orphaned row
 * (ticket known, no live session) reopens correctly — the upsert must record
 * the new session (regression for the INSERT OR IGNORE reopen bug).
 *
 * update_support_ticket: resolved by CALLING session id, records the ticket,
 * and best-effort edits the announcement to include it.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-support-dispatch' };
});

const { postParent, createThread, adapterDeliver } = vi.hoisted(() => ({
  postParent: vi.fn(),
  createThread: vi.fn(),
  adapterDeliver: vi.fn(),
}));
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ postParent, createThread, deliver: adapterDeliver }),
}));

const TEST_DIR = '/tmp/nanoclaw-test-support-dispatch';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup, getDb } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { getSupportThread } from '../../db/support-threads.js';
import { openInboundDb, resolveSession, resolveTaskSession } from '../../session-manager.js';
import { insertTaskRow } from '../scheduling/db.js';
import { wakeContainer } from '../../container-runner.js';
import { handleDispatchSupportIssue, handleUpdateSupportTicket } from './dispatch.js';

function now(): string {
  return new Date().toISOString();
}

function seed(): void {
  createAgentGroup({ id: 'ag-1', name: 'Illie', folder: 'illie', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: '#support',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function inboundOf(sessionId: string): Array<{ thread_id: string | null; content: string }> {
  const db = new Database(`${TEST_DIR}/v2-sessions/ag-1/${sessionId}/inbound.db`, { readonly: true });
  try {
    return db.prepare("SELECT thread_id, content FROM messages_in WHERE kind = 'chat'").all() as Array<{
      thread_id: string | null;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

function dispatchContent(
  gmailThreadId: string,
  body: string,
  ticket?: { issue: string; team: string },
): Record<string, unknown> {
  return {
    action: 'dispatch_support_issue',
    gmailThreadId,
    linearIssue: ticket?.issue,
    linearTeam: ticket?.team,
    subject: 'Depletions look wrong',
    sender: 'Jane <jane@acme.com>',
    bodyText: body,
    lastMessageId: '<msg-1@acme.com>',
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  postParent.mockReset().mockResolvedValue({ messageId: 'parent-ts-1' });
  createThread.mockReset().mockResolvedValue({ threadId: 'thread-ts-1' });
  adapterDeliver.mockReset().mockResolvedValue(undefined);
  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleDispatchSupportIssue — new issue (purest: no ticket from poller)', () => {
  it('opens announcement + thread + session, seeds the ticket-creation protocol, records the row', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'depletions are off'), poller, {} as never);

    expect(postParent).toHaveBeenCalledTimes(1);
    // No ticket yet → generic Support tag, subject + sender preserved.
    expect(postParent).toHaveBeenCalledWith('slack:C1', '🎫 Support: Depletions look wrong — Jane <jane@acme.com>');
    expect(createThread).toHaveBeenCalledTimes(1);

    const row = getSupportThread('gthread-A');
    expect(row).toBeTruthy();
    expect(row!.slack_thread_id).toBe('slack:C1:thread-ts-1');
    expect(row!.linear_issue).toBeNull();
    expect(row!.subject).toBe('Depletions look wrong');
    expect(row!.sender).toBe('Jane <jane@acme.com>');
    expect(row!.session_id).not.toBe(poller.id);

    // Seed instructs the per-issue session to CREATE the ticket + report back.
    const seeded = inboundOf(row!.session_id!);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].thread_id).toBe('slack:C1:thread-ts-1');
    expect(seeded[0].content).toContain('no Linear ticket yet');
    expect(seeded[0].content).toContain('update_support_ticket');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('inherits isolated poller routing and turn flags as sticky support-session defaults', async () => {
    seed();
    const seriesId = 'task-support-poller';
    const { session: poller } = resolveTaskSession('ag-1', seriesId);
    const pollerDb = openInboundDb('ag-1', poller.id);
    insertTaskRow(pollerDb, {
      id: 'task-fire-1',
      seriesId,
      processAfter: now(),
      recurrence: '*/15 * * * *',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      content: JSON.stringify({
        prompt: 'poll support inbox',
        flagIntent: { turnModel: 'gpt-5.6-terra', turnEffort: 'xhigh' },
      }),
    });

    await handleDispatchSupportIssue(dispatchContent('gthread-task', 'new issue'), poller, pollerDb);
    const row = getSupportThread('gthread-task');
    expect(row).toBeTruthy();
    await handleDispatchSupportIssue(dispatchContent('gthread-task', 'customer replied'), poller, pollerDb);
    pollerDb.close();
    const [seedMessage, followupMessage] = inboundOf(row!.session_id!);
    expect(JSON.parse(seedMessage.content)).toMatchObject({
      flagIntent: { stickyModel: 'gpt-5.6-terra', stickyEffort: 'xhigh' },
    });
    expect(JSON.parse(followupMessage.content)).toMatchObject({
      flagIntent: { stickyModel: 'gpt-5.6-terra', stickyEffort: 'xhigh' },
    });
  });

  it('with a known ticket (legacy dispatcher), seeds the comment-not-duplicate protocol', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleDispatchSupportIssue(
      dispatchContent('gthread-B', 'first email', { issue: 'XZO-123', team: 'XZO' }),
      poller,
      {} as never,
    );

    expect(postParent).toHaveBeenCalledWith('slack:C1', '🎫 XZO XZO-123: Depletions look wrong — Jane <jane@acme.com>');
    const row = getSupportThread('gthread-B');
    expect(row!.linear_issue).toBe('XZO-123');
    const seeded = inboundOf(row!.session_id!);
    expect(seeded[0].content).toContain('already exists');
    expect(seeded[0].content).toContain('XZO-123');
  });
});

describe('handleDispatchSupportIssue — follow-up + reopen', () => {
  it('routes a follow-up into the existing session — no second thread', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'first email'), poller, {} as never);
    const sessionId = getSupportThread('gthread-A')!.session_id!;

    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'customer replied'), poller, {} as never);

    expect(postParent).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(getSupportThread('gthread-A')!.session_id).toBe(sessionId);

    const msgs = inboundOf(sessionId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].thread_id).toBe('slack:C1:thread-ts-1');
    expect(msgs[1].content).toContain('Follow-up email');
  });

  it('seeded legacy row (ticket known, no session) reopens AND records the new session', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Simulate the host-side seeding of the legacy ticket map.
    getDb()
      .prepare(
        `INSERT INTO support_threads (gmail_thread_id, agent_group_id, messaging_group_id, linear_team, linear_issue, status, created_at, last_activity_at)
         VALUES ('gthread-L', 'ag-1', 'mg-1', 'XZO', 'XZO-86', 'open', ?, ?)`,
      )
      .run(now(), now());

    await handleDispatchSupportIssue(dispatchContent('gthread-L', 'reply on in-flight thread'), poller, {} as never);

    // Opens a thread (no live session existed)…
    expect(postParent).toHaveBeenCalledTimes(1);
    // …announcement carries the known ticket…
    expect(postParent).toHaveBeenCalledWith('slack:C1', '🎫 XZO XZO-86: Depletions look wrong — Jane <jane@acme.com>');
    const row = getSupportThread('gthread-L')!;
    // …and the upsert records the new session/thread (regression: INSERT OR
    // IGNORE silently dropped this, stranding every future follow-up).
    expect(row.session_id).toBeTruthy();
    expect(row.slack_thread_id).toBe('slack:C1:thread-ts-1');
    expect(row.linear_issue).toBe('XZO-86'); // preserved, not clobbered
    // Seed says comment-don't-duplicate.
    expect(inboundOf(row.session_id!)[0].content).toContain('XZO-86');
  });
});

describe('handleUpdateSupportTicket', () => {
  it('records the ticket by calling-session and edits the announcement', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'first email'), poller, {} as never);
    const row = getSupportThread('gthread-A')!;
    const issueSession = getSession(row.session_id!)!;

    await handleUpdateSupportTicket(
      { action: 'update_support_ticket', linearIssue: 'XZO-200', linearTeam: 'XZO' },
      issueSession,
      {} as never,
    );

    const updated = getSupportThread('gthread-A')!;
    expect(updated.linear_issue).toBe('XZO-200');
    expect(updated.linear_team).toBe('XZO');

    // Announcement re-edited with full context: ticket + subject + sender.
    expect(adapterDeliver).toHaveBeenCalledTimes(1);
    const [pid, tid, msg] = adapterDeliver.mock.calls[0];
    expect(pid).toBe('slack:C1');
    expect(tid).toBeNull();
    expect(msg.content).toMatchObject({
      operation: 'edit',
      messageId: 'parent-ts-1',
      text: '🎫 XZO XZO-200: Depletions look wrong — Jane <jane@acme.com>',
    });
  });

  it('ignores a call from a non-support session', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleUpdateSupportTicket({ action: 'update_support_ticket', linearIssue: 'XZO-999' }, poller, {} as never);

    expect(adapterDeliver).not.toHaveBeenCalled();
  });
});
