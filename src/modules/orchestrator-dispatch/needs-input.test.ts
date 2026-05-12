import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applySpawnNeedsInput } from './needs-input.js';
import type { Session } from '../../types.js';

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
    child_platform_thread_id: null,
    child_messaging_group_id: null,
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
    surface_mode: 'headless',
    needs_input: 0,
    steer_question: null,
    ...overrides,
  })!;
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
});

describe('applySpawnNeedsInput', () => {
  it('flips needs_input and stores question on a running task', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await applySpawnNeedsInput(
      { task_id: 'task-1', question: 'Repo path A or B?' },
      makeChildSession(),
    );

    const task = getTaskById('task-1');
    expect(task!.needs_input).toBe(1);
    expect(task!.steer_question).toBe('Repo path A or B?');
  });

  it('truncates question to 500 chars', async () => {
    setupDb();
    seedGroups();
    makeTask();

    await applySpawnNeedsInput(
      { task_id: 'task-1', question: 'X'.repeat(1000) },
      makeChildSession(),
    );

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

    await applySpawnNeedsInput(
      { task_id: 'task-1', question: 'too late' },
      makeChildSession(),
    );

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
    await expect(
      applySpawnNeedsInput({ question: 'x' }, makeChildSession()),
    ).resolves.not.toThrow();
  });
});
