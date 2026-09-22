/**
 * `ncl tasks create|update --fresh-context` writes `freshContext` onto the
 * series' task content, and `get` reports it. The agent-runner side (a flagged
 * fire starts with no resumed continuation) is covered in
 * container/agent-runner/src/fresh-context-task.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups`, TIMEZONE: 'UTC' };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-fresh-context') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { taskFreshContext } from './fresh-context.js';
import '../../cli/resources/tasks.js';

const host: CallerContext = { caller: 'host' };

function taskContent(sessionId: string): Record<string, unknown> {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    const row = db
      .prepare("SELECT content FROM messages_in WHERE kind = 'task' AND status IN ('pending','paused')")
      .get() as { content: string };
    return JSON.parse(row.content) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

async function run(command: string, args: Record<string, unknown>) {
  const resp = await dispatch({ id: `${command}-${Date.now()}`, command, args }, host);
  if (!resp.ok) throw new Error(JSON.stringify(resp));
  return resp.data as Record<string, unknown>;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'ag-1',
    folder: 'ag-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('--fresh-context', () => {
  it('is absent by default, and round-trips through update without touching the other controls', async () => {
    const created = await run('tasks-create', {
      group: 'ag-1',
      prompt: 'watch',
      process_after: '2999-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      script: 'echo {}',
      quiet_status: true,
    });
    const sessionId = created.session_id as string;
    const before = taskContent(sessionId);
    expect(before).not.toHaveProperty('freshContext');

    await run('tasks-update', { id: created.series_id, group: 'ag-1', fresh_context: true });
    const on = taskContent(sessionId);
    expect(on.freshContext).toBe(true);
    expect({ ...on, freshContext: undefined }).toEqual({ ...before, freshContext: undefined });
    const shown = await run('tasks-get', { id: created.series_id, group: 'ag-1' });
    expect(JSON.stringify(shown)).toContain('"fresh_context":1');

    await run('tasks-update', { id: created.series_id, group: 'ag-1', fresh_context: false });
    expect(taskContent(sessionId).freshContext).toBe(false);
    expect(taskFreshContext(JSON.stringify(taskContent(sessionId)))).toBe(false);
  });

  it('can be set at create', async () => {
    const created = await run('tasks-create', {
      group: 'ag-1',
      prompt: 'watch',
      process_after: '2999-01-01T00:00:00Z',
      fresh_context: true,
    });
    expect(taskContent(created.session_id as string).freshContext).toBe(true);
  });
});
