/**
 * Integration tests for schedule_task scope routing.
 *
 * Thread-scoped loops (`scope:'thread'`) must land in the CALLING per-thread
 * session's inbound with the session's host-authoritative thread_id; the
 * default (`scope:'channel'`, or thread requested from a channel-root session)
 * must land in the channel-root session's inbound with thread_id=null. Cancel
 * resolves the calling thread session first, then channel root.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-sched-actions' };
});

const TEST_DIR = '/tmp/nanoclaw-test-sched-actions';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { resolveSession, openInboundDb } from '../../session-manager.js';
import { handleScheduleTask, handleCancelTask } from './actions.js';

function now(): string {
  return new Date().toISOString();
}

function seed(): void {
  createAgentGroup({ id: 'ag-1', name: 'Test', folder: 'test', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: 'Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function tasksIn(sessionId: string): Array<{ id: string; thread_id: string | null; status: string }> {
  const db = new Database(`${TEST_DIR}/v2-sessions/ag-1/${sessionId}/inbound.db`, { readonly: true });
  try {
    return db.prepare("SELECT id, thread_id, status FROM messages_in WHERE kind = 'task'").all() as Array<{
      id: string;
      thread_id: string | null;
      status: string;
    }>;
  } finally {
    db.close();
  }
}

function scheduleContent(taskId: string, scope: 'thread' | 'channel'): Record<string, unknown> {
  return { action: 'schedule_task', taskId, prompt: 'loop', processAfter: now(), recurrence: '*/10 * * * *', scope };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleScheduleTask scope routing', () => {
  it('scope=thread from a thread session lands in that session with its thread_id', async () => {
    seed();
    const { session: root } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const { session: thr } = resolveSession('ag-1', 'mg-1', 'thr-1', 'per-thread');

    const inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleScheduleTask(scheduleContent('task-t', 'thread'), thr, inDb);
    } finally {
      inDb.close();
    }

    const inThread = tasksIn(thr.id);
    expect(inThread).toHaveLength(1);
    expect(inThread[0]).toMatchObject({ id: 'task-t', thread_id: 'thr-1' });
    expect(tasksIn(root.id)).toHaveLength(0); // not buried in channel root
  });

  it('scope=channel from a thread session lands in channel root with thread_id=null', async () => {
    seed();
    const { session: root } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const { session: thr } = resolveSession('ag-1', 'mg-1', 'thr-1', 'per-thread');

    const inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleScheduleTask(scheduleContent('task-c', 'channel'), thr, inDb);
    } finally {
      inDb.close();
    }

    const inRoot = tasksIn(root.id);
    expect(inRoot).toHaveLength(1);
    expect(inRoot[0]).toMatchObject({ id: 'task-c', thread_id: null });
    expect(tasksIn(thr.id)).toHaveLength(0);
  });

  it('scope=thread from a channel-root session falls back to channel root', async () => {
    seed();
    const { session: root } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const inDb = openInboundDb('ag-1', root.id);
    try {
      await handleScheduleTask(scheduleContent('task-f', 'thread'), root, inDb);
    } finally {
      inDb.close();
    }

    const inRoot = tasksIn(root.id);
    expect(inRoot).toHaveLength(1);
    expect(inRoot[0]).toMatchObject({ id: 'task-f', thread_id: null });
  });
});

describe('handleCancelTask scope resolution', () => {
  it('cancels a thread-scoped task in the calling thread session', async () => {
    seed();
    resolveSession('ag-1', 'mg-1', null, 'shared');
    const { session: thr } = resolveSession('ag-1', 'mg-1', 'thr-1', 'per-thread');

    let inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleScheduleTask(scheduleContent('task-t', 'thread'), thr, inDb);
    } finally {
      inDb.close();
    }
    expect(tasksIn(thr.id)[0].status).toBe('pending');

    inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleCancelTask({ action: 'cancel_task', taskId: 'task-t' }, thr, inDb);
    } finally {
      inDb.close();
    }
    expect(tasksIn(thr.id)[0].status).toBe('completed');
  });

  it('cancelling a channel task from a thread session falls back to channel root', async () => {
    seed();
    const { session: root } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const { session: thr } = resolveSession('ag-1', 'mg-1', 'thr-1', 'per-thread');

    // Channel-scoped task lives in root.
    let inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleScheduleTask(scheduleContent('task-c', 'channel'), thr, inDb);
    } finally {
      inDb.close();
    }
    expect(tasksIn(root.id)[0].status).toBe('pending');

    // Cancel from the thread session — should resolve to channel root.
    inDb = openInboundDb('ag-1', thr.id);
    try {
      await handleCancelTask({ action: 'cancel_task', taskId: 'task-c' }, thr, inDb);
    } finally {
      inDb.close();
    }
    expect(tasksIn(root.id)[0].status).toBe('completed');
  });
});
