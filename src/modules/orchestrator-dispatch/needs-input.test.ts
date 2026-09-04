import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applySpawnNeedsInput } from './needs-input.js';
import type { Session } from '../../types.js';

const deliverMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapter: vi.fn(() => ({ deliver: deliverMock })),
}));

vi.mock('../../db/messaging-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/messaging-groups.js')>();
  return {
    ...real,
    getMessagingGroup: vi.fn(),
  };
});

function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedGroups(): void {
  createAgentGroup({
    id: 'ag-parent',
    name: 'ag-parent',
    folder: 'ag-parent',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({ id: 'ag-child', name: 'ag-child', folder: 'ag-child', agent_provider: null, created_at: now() });
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES ('mg-child', 'slack', 'W-example-labs', 'slack', 'example-labs-channel', 1, 'strict', ?)`,
    )
    .run(now());
  getDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-parent', 'ag-parent', now());
  getDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-child', 'ag-child', now());
}

function makeTask(overrides: Partial<Parameters<typeof insertTaskAtomic>[0]> = {}): Task {
  return insertTaskAtomic({
    task_id: 'task-1',
    idempotency_key: 'ik-1',
    parent_session_id: 'sess-parent',
    parent_agent_group_id: 'ag-parent',
    parent_messaging_group_id: null,
    child_session_id: 'sess-child',
    status: 'running',
    task_content: 'do something',
    request_hash: 'hash123',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: 'thread-task-1',
    child_messaging_group_id: 'mg-child',
    admitted_at: now(),
    started_at: now(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: null,
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'native_thread',
    needs_input: 0,
    steer_question: null,
    ...overrides,
  })!;
}

const mockChildMg = {
  id: 'mg-child',
  channel_type: 'slack',
  platform_id: 'W-example-labs',
  name: 'example-labs-channel',
  is_group: 1 as const,
  unknown_sender_policy: 'strict' as const,
  created_at: '2026-05-12T00:00:00.000Z',
};

async function stubChildMgPresent(): Promise<void> {
  const { getMessagingGroup } = await import('../../db/messaging-groups.js');
  vi.mocked(getMessagingGroup).mockReturnValue(mockChildMg);
}

function makeChildSession(): Session {
  return {
    id: 'sess-child',
    agent_group_id: 'ag-child',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'running',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
}

function makeWrongSession(): Session {
  return {
    id: 'sess-wrong',
    agent_group_id: 'ag-other',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'running',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
}

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  deliverMock.mockClear();
});

describe('applySpawnNeedsInput', () => {
  it('flips needs_input and stores question on a running task', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'Repo path A or B?' }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(1);
    expect(task!.steer_question).toBe('Repo path A or B?');
  });

  it('truncates question to 500 chars', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'X'.repeat(1000) }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.steer_question!.length).toBe(500);
  });

  it('accepts no question and leaves steer_question null', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await applySpawnNeedsInput({ task_id: 'task-1' }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(1);
    expect(task!.steer_question).toBeNull();
  });

  it('does not flip on a terminal task (completed)', async () => {
    setupDb();
    seedGroups();
    makeTask();
    getDb().prepare(`UPDATE tasks SET status = 'completed' WHERE task_id = 'task-1'`).run();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'too late' }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(0);
    expect(task!.steer_question).toBeNull();
  });

  it('silently skips on auth mismatch (wrong child_session)', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await expect(
      applySpawnNeedsInput({ task_id: 'task-1', question: 'spoof?' }, makeWrongSession()),
    ).resolves.not.toThrow();

    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(0);
  });

  it('silently skips when task_id missing', async () => {
    setupDb();
    seedGroups();
    await expect(applySpawnNeedsInput({ question: 'x' }, makeChildSession())).resolves.not.toThrow();
  });

  it('posts into the task thread via the channel adapter when the flag flips', async () => {
    setupDb();
    seedGroups();
    makeTask();
    await stubChildMgPresent();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'Repo path A or B?' }, makeChildSession());

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [platformId, threadId, msg] = deliverMock.mock.calls[0];
    expect(platformId).toBe('W-example-labs');
    expect(threadId).toBe('thread-task-1');
    expect((msg as { content: { text: string } }).content.text).toContain('Repo path A or B?');
    expect((msg as { content: { text: string } }).content.text).toContain('Needs your input');
  });

  it('does not double-notify when worker re-asks with the same question', async () => {
    setupDb();
    seedGroups();
    makeTask();
    await stubChildMgPresent();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'Same q' }, makeChildSession());
    await applySpawnNeedsInput({ task_id: 'task-1', question: 'Same q' }, makeChildSession());

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('re-notifies when the question text changes', async () => {
    setupDb();
    seedGroups();
    makeTask();
    await stubChildMgPresent();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'First?' }, makeChildSession());
    await applySpawnNeedsInput({ task_id: 'task-1', question: 'Second?' }, makeChildSession());

    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it('skips the adapter post for headless tasks but still flips the row', async () => {
    setupDb();
    seedGroups();
    makeTask({ surface_mode: 'headless', child_platform_thread_id: null, child_messaging_group_id: null });
    await stubChildMgPresent();

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'q' }, makeChildSession());

    expect(deliverMock).not.toHaveBeenCalled();
    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(1);
  });

  it('skips the adapter post when the messaging group is gone', async () => {
    setupDb();
    seedGroups();
    makeTask();
    const { getMessagingGroup } = await import('../../db/messaging-groups.js');
    vi.mocked(getMessagingGroup).mockReturnValue(undefined);

    await applySpawnNeedsInput({ task_id: 'task-1', question: 'q' }, makeChildSession());

    expect(deliverMock).not.toHaveBeenCalled();
    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(1);
  });
});
