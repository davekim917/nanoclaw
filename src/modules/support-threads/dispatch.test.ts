/**
 * Integration tests for the dispatch_support_issue handler.
 *
 * A new Gmail thread opens exactly one channel announcement + native thread +
 * per-issue session and records the mapping; a follow-up email on the same
 * Gmail thread routes into the existing session WITHOUT opening a second thread.
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

const { postParent, createThread } = vi.hoisted(() => ({
  postParent: vi.fn(),
  createThread: vi.fn(),
}));
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ postParent, createThread }),
}));

const TEST_DIR = '/tmp/nanoclaw-test-support-dispatch';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { getSupportThread } from '../../db/support-threads.js';
import { resolveSession } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { handleDispatchSupportIssue } from './dispatch.js';

function now(): string {
  return new Date().toISOString();
}

function seed(): void {
  createAgentGroup({ id: 'ag-1', name: 'Illie', folder: 'illie', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: '#agents-xzo',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function tasksInSession(sessionId: string): Array<{ thread_id: string | null; content: string }> {
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

function content(gmailThreadId: string, body: string): Record<string, unknown> {
  return {
    action: 'dispatch_support_issue',
    gmailThreadId,
    linearIssue: 'XZO-123',
    linearTeam: 'XZO',
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
  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleDispatchSupportIssue', () => {
  it('opens an announcement + thread + per-issue session and records the mapping', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleDispatchSupportIssue(content('gthread-A', 'depletions are off for March'), poller, {} as never);

    // Announcement + thread opened exactly once.
    expect(postParent).toHaveBeenCalledTimes(1);
    expect(postParent).toHaveBeenCalledWith('slack:C1', expect.stringContaining('XZO XZO-123'));
    expect(createThread).toHaveBeenCalledTimes(1);

    // Mapping recorded with the encoded thread id and a per-issue session.
    const row = getSupportThread('gthread-A');
    expect(row).toBeTruthy();
    expect(row!.slack_thread_id).toBe('slack:C1:thread-ts-1');
    expect(row!.slack_parent_msg_id).toBe('parent-ts-1');
    expect(row!.linear_issue).toBe('XZO-123');
    expect(row!.status).toBe('open');
    expect(row!.session_id).toBeTruthy();
    expect(row!.session_id).not.toBe(poller.id); // a NEW per-issue session, not the poller

    // The per-issue session was seeded in its thread and woken.
    const seeded = tasksInSession(row!.session_id!);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].thread_id).toBe('slack:C1:thread-ts-1');
    expect(seeded[0].content).toContain('New support issue routed');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('routes a follow-up email into the existing session — no second thread', async () => {
    seed();
    const { session: poller } = resolveSession('ag-1', 'mg-1', null, 'shared');

    await handleDispatchSupportIssue(content('gthread-A', 'first email'), poller, {} as never);
    const row1 = getSupportThread('gthread-A');
    const issueSessionId = row1!.session_id!;
    const firstActivity = row1!.last_activity_at;

    // Same Gmail thread, a reply.
    await handleDispatchSupportIssue(content('gthread-A', 'customer replied with more detail'), poller, {} as never);

    // No second announcement/thread.
    expect(postParent).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledTimes(1);

    // Same session, now with a second inbound (the follow-up) routed to the thread.
    const row2 = getSupportThread('gthread-A');
    expect(row2!.session_id).toBe(issueSessionId);
    const msgs = tasksInSession(issueSessionId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].thread_id).toBe('slack:C1:thread-ts-1');
    expect(msgs[1].content).toContain('Follow-up email');
    expect(row2!.last_activity_at >= firstActivity).toBe(true);
  });
});
