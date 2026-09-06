import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getRawDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applySpawnProgress } from './progress.js';
import type { Session } from '../../types.js';

function now(): string {
  return new Date().toISOString();
}

async function setupDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

async function seedGroups(): Promise<void> {
  await createAgentGroup({
    id: 'ag-parent',
    name: 'ag-parent',
    folder: 'ag-parent',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: 'ag-child',
    name: 'ag-child',
    folder: 'ag-child',
    agent_provider: null,
    created_at: now(),
  });
  getRawDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-parent', 'ag-parent', now());
  getRawDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-child', 'ag-child', now());
}

async function makeRunningTask(lastProgressAt?: string): Promise<Task> {
  return (await insertTaskAtomic({
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
    last_progress_at: lastProgressAt ?? new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
  }))!;
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

afterEach(async () => {
  await closeDb();
  vi.clearAllMocks();
});

describe('applySpawnProgress', () => {
  it('test_progress_resets_timer: updates last_progress_at and last_progress_message', async () => {
    await setupDb();
    await seedGroups();
    await makeRunningTask();

    const before = Date.now();
    await applySpawnProgress({ task_id: 'task-1', message: 'Working' }, makeChildSession());
    const after = Date.now();

    const task = await getTaskById('task-1');
    expect(task!.last_progress_message).toBe('Working');
    // last_progress_at should be within this test run
    const progressMs = new Date(task!.last_progress_at!).getTime();
    expect(progressMs).toBeGreaterThanOrEqual(before);
    expect(progressMs).toBeLessThanOrEqual(after + 100);
  });

  it('test_progress_truncates_500: truncates message to 500 chars', async () => {
    await setupDb();
    await seedGroups();
    await makeRunningTask();

    await applySpawnProgress({ task_id: 'task-1', message: 'X'.repeat(1000) }, makeChildSession());

    const task = await getTaskById('task-1');
    expect(task!.last_progress_message!.length).toBe(500);
  });

  it('test_progress_wrong_session_silent: does not throw on auth mismatch', async () => {
    await setupDb();
    await seedGroups();
    await makeRunningTask();

    await expect(
      applySpawnProgress({ task_id: 'task-1', message: 'Working' }, makeWrongSession()),
    ).resolves.not.toThrow();

    // Task should be unchanged (no update happened)
    const task = await getTaskById('task-1');
    expect(task!.last_progress_message).toBeNull(); // not updated
  });

  it('ASSERT: no status guard — progress can be reported on any status', async () => {
    await setupDb();
    await seedGroups();
    // Insert task with status=pending (unusual but should still work)
    await insertTaskAtomic({
      task_id: 'task-pend',
      idempotency_key: 'ik-p',
      parent_session_id: 'sess-parent',
      parent_agent_group_id: 'ag-parent',
      parent_messaging_group_id: null,
      child_session_id: 'sess-child',
      status: 'running', // need to be 'running' for auth to match
      task_content: 'x',
      request_hash: 'h',
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: now(),
      started_at: null,
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
    });
    // Force status to 'cancelled' to verify no status guard
    getRawDb().prepare(`UPDATE tasks SET status = 'cancelled' WHERE task_id = 'task-pend'`).run();

    // Should not throw — no status guard
    await expect(
      applySpawnProgress({ task_id: 'task-pend', message: 'Still reporting' }, makeChildSession()),
    ).resolves.not.toThrow();
  });
});
