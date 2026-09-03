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
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { postParent, createThread, adapterDeliver } = vi.hoisted(() => ({
  postParent: vi.fn(),
  createThread: vi.fn(),
  adapterDeliver: vi.fn(),
}));
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ postParent, createThread, deliver: adapterDeliver }),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-support-dispatch') }));

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
  createAgentGroup({
    id: 'ag-1',
    name: 'Support Agent',
    folder: 'support-agent',
    agent_provider: null,
    created_at: now(),
  });
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
    date: 'Fri, 17 Jul 2026 16:40:55 -0400',
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
  process.env.NANOCLAW_SUPPORT_TICKET_POLICY_SUPPORT_AGENT =
    'Use team EXAMPLE for product incidents and team HELP for all other requests, then call update_support_ticket.';
});

afterEach(() => {
  delete process.env.NANOCLAW_SUPPORT_TICKET_POLICY_SUPPORT_AGENT;
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
    expect(seeded[0].content).toContain('operator-configured policy');
    expect(seeded[0].content).toContain('team EXAMPLE');
    expect(seeded[0].content).toContain('update_support_ticket');
    expect(seeded[0].content).toContain('Subject: Depletions look wrong');
    expect(seeded[0].content).toContain('From: Jane <jane@acme.com>');
    expect(seeded[0].content).toContain('Date: Fri, 17 Jul 2026 16:40:55 -0400');
    expect(seeded[0].content).toContain('depletions are off');
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
      dispatchContent('gthread-B', 'first email', { issue: 'EXAMPLE-123', team: 'EXAMPLE' }),
      poller,
      {} as never,
    );

    expect(postParent).toHaveBeenCalledWith(
      'slack:C1',
      '🎫 EXAMPLE EXAMPLE-123: Depletions look wrong — Jane <jane@acme.com>',
    );
    const row = getSupportThread('gthread-B');
    expect(row!.linear_issue).toBe('EXAMPLE-123');
    const seeded = inboundOf(row!.session_id!);
    expect(seeded[0].content).toContain('already exists');
    expect(seeded[0].content).toContain('EXAMPLE-123');
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
    expect(msgs[1].content).toContain('Subject: Depletions look wrong');
    expect(msgs[1].content).toContain('Date: Fri, 17 Jul 2026 16:40:55 -0400');
    expect(msgs[1].content).toContain('customer replied');
  });

  it('seeded legacy row (ticket known, no session) reopens AND records the new session', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Simulate the host-side seeding of the legacy ticket map.
    getDb()
      .prepare(
        `INSERT INTO support_threads (gmail_thread_id, agent_group_id, messaging_group_id, linear_team, linear_issue, status, created_at, last_activity_at)
         VALUES ('gthread-L', 'ag-1', 'mg-1', 'EXAMPLE', 'EXAMPLE-86', 'open', ?, ?)`,
      )
      .run(now(), now());

    await handleDispatchSupportIssue(dispatchContent('gthread-L', 'reply on in-flight thread'), poller, {} as never);

    // Opens a thread (no live session existed)…
    expect(postParent).toHaveBeenCalledTimes(1);
    // …announcement carries the known ticket…
    expect(postParent).toHaveBeenCalledWith(
      'slack:C1',
      '🎫 EXAMPLE EXAMPLE-86: Depletions look wrong — Jane <jane@acme.com>',
    );
    const row = getSupportThread('gthread-L')!;
    // …and the upsert records the new session/thread (regression: INSERT OR
    // IGNORE silently dropped this, stranding every future follow-up).
    expect(row.session_id).toBeTruthy();
    expect(row.slack_thread_id).toBe('slack:C1:thread-ts-1');
    expect(row.linear_issue).toBe('EXAMPLE-86'); // preserved, not clobbered
    // Seed says comment-don't-duplicate.
    expect(inboundOf(row.session_id!)[0].content).toContain('EXAMPLE-86');
  });
});

// T6 (SR6) — a support thread outlives the session bound to it.
describe('handleDispatchSupportIssue — archived session binding', () => {
  it('never writes to or wakes a closed session, and replaces ONLY session_id', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'first email'), poller, {} as never);
    const before = getSupportThread('gthread-A')!;
    const archivedId = before.session_id!;
    // Reclaim closes the row and removes the dir; the row itself survives, so
    // a bare getSession still answers for it.
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(archivedId);
    fs.rmSync(`${TEST_DIR}/v2-sessions/ag-1/${archivedId}`, { recursive: true, force: true });
    vi.mocked(wakeContainer).mockClear();

    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'customer replied'), poller, {} as never);

    const after = getSupportThread('gthread-A')!;
    expect(after.session_id).not.toBe(archivedId);
    expect(getSession(after.session_id!)!.status).toBe('active');
    // session_id is the ONLY column the rebinding owns. Everything else on the
    // row is either untouched or moved by touchSupportThread, as before.
    const { session_id: _newSession, last_activity_at: _newActivity, ...afterRest } = after;
    const { session_id: _oldSession, last_activity_at: _oldActivity, ...beforeRest } = before;
    expect(afterRest).toEqual(beforeRest);
    expect(after.status).toBe('open');
    expect(Date.parse(after.last_activity_at)).toBeGreaterThanOrEqual(Date.parse(before.last_activity_at));
    // No second announcement or thread for one ongoing conversation.
    expect(postParent).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledTimes(1);
    // The closed session was never written to or spawned.
    expect(fs.existsSync(`${TEST_DIR}/v2-sessions/ag-1/${archivedId}`)).toBe(false);
    expect(vi.mocked(wakeContainer).mock.calls.map((call) => call[0]!.id)).toEqual([after.session_id]);
    const delivered = inboundOf(after.session_id!);
    expect(delivered.map((m) => m.content).join('\n')).toContain('customer replied');
  });

  it('gives two concurrent follow-ups exactly one new session, and delivers both', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'first email'), poller, {} as never);
    const archivedId = getSupportThread('gthread-A')!.session_id!;
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(archivedId);
    fs.rmSync(`${TEST_DIR}/v2-sessions/ag-1/${archivedId}`, { recursive: true, force: true });
    vi.mocked(wakeContainer).mockClear();

    await Promise.all([
      handleDispatchSupportIssue(dispatchContent('gthread-A', 'reply one'), poller, {} as never),
      handleDispatchSupportIssue(dispatchContent('gthread-A', 'reply two'), poller, {} as never),
    ]);

    const after = getSupportThread('gthread-A')!;
    const activeIds = (
      getDb().prepare("SELECT id FROM sessions WHERE status = 'active'").all() as Array<{ id: string }>
    ).map((r) => r.id);
    // poller + exactly one replacement issue session.
    expect(activeIds.sort()).toEqual([poller.id, after.session_id].sort());
    expect(vi.mocked(wakeContainer).mock.calls.map((call) => call[0]!.id)).toEqual([
      after.session_id,
      after.session_id,
    ]);
    const bodies = inboundOf(after.session_id!).map((m) => m.content);
    expect(bodies.some((b) => b.includes('reply one'))).toBe(true);
    expect(bodies.some((b) => b.includes('reply two'))).toBe(true);
    expect(postParent).toHaveBeenCalledTimes(1);
  });

  it('opens exactly one thread when two emails for a NEW issue arrive together', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The new-issue branch awaits postParent BEFORE recording the row, so
    // without per-thread serialization the second dispatch reads "no such
    // thread" and announces the same issue a second time.
    await Promise.all([
      handleDispatchSupportIssue(dispatchContent('gthread-N', 'first email'), poller, {} as never),
      handleDispatchSupportIssue(dispatchContent('gthread-N', 'same issue again'), poller, {} as never),
    ]);

    expect(postParent).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledTimes(1);
    const row = getSupportThread('gthread-N')!;
    const bodies = inboundOf(row.session_id!).map((m) => m.content);
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes('first email'))).toBe(true);
    expect(bodies.some((b) => b.includes('same issue again'))).toBe(true);
  });

  it('leaves an active binding on its original session', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');
    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'first email'), poller, {} as never);
    const sessionId = getSupportThread('gthread-A')!.session_id!;

    await handleDispatchSupportIssue(dispatchContent('gthread-A', 'customer replied'), poller, {} as never);

    expect(getSupportThread('gthread-A')!.session_id).toBe(sessionId);
    expect(inboundOf(sessionId)).toHaveLength(2);
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
      { action: 'update_support_ticket', linearIssue: 'EXAMPLE-200', linearTeam: 'EXAMPLE' },
      issueSession,
      {} as never,
    );

    const updated = getSupportThread('gthread-A')!;
    expect(updated.linear_issue).toBe('EXAMPLE-200');
    expect(updated.linear_team).toBe('EXAMPLE');

    // Announcement re-edited with full context: ticket + subject + sender.
    expect(adapterDeliver).toHaveBeenCalledTimes(1);
    const [pid, tid, msg] = adapterDeliver.mock.calls[0];
    expect(pid).toBe('slack:C1');
    expect(tid).toBeNull();
    expect(msg.content).toMatchObject({
      operation: 'edit',
      messageId: 'parent-ts-1',
      text: '🎫 EXAMPLE EXAMPLE-200: Depletions look wrong — Jane <jane@acme.com>',
    });
  });

  it('ignores a call from a non-support session', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleUpdateSupportTicket(
      { action: 'update_support_ticket', linearIssue: 'EXAMPLE-999' },
      poller,
      {} as never,
    );

    expect(adapterDeliver).not.toHaveBeenCalled();
  });
});
