/**
 * `ncl tasks create|update --continuous` writes `continuous` onto the series'
 * task content, `get` reports the effective mode, and a fresh fire leaves the
 * task session row alone. The agent-runner side (which fires resume) is
 * covered in container/agent-runner/src/fresh-context-task.test.ts.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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

import { closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { getDb, initDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { admitDueTaskContexts, resolveTaskSession, withExistingMailboxSession } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { taskFiresFresh } from './fresh-context.js';
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
  // Migrated through a throwaway handle so this file never names the raw
  // central handle (src/db/raw-db-ratchet.test.ts), as in
  // src/stop-intent-recovery.test.ts:299-305.
  const dbPath = path.join(TEST_DIR, `central-${crypto.randomUUID()}.db`);
  const migrated = new Database(dbPath);
  runMigrations(migrated);
  migrated.close();
  await initDb(dbPath, { role: 'test' });
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

// The runner's copy of this rule (container/agent-runner/src/fresh-context-task.ts)
// runs the same table, so the two cannot drift.
const sharedCases = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/fresh-context-cases.json'), 'utf8'),
) as { cases: Array<{ name: string; thread_id: string | null; content: string; host: boolean | null }> };

describe('shared fresh-fire cases (container/agent-runner/src/fresh-context-cases.json)', () => {
  for (const c of sharedCases.cases.filter((x) => x.host !== null)) {
    it(c.name, () => {
      expect(taskFiresFresh(c.content)).toBe(c.host);
    });
  }
});

describe('--continuous', () => {
  it('defaults to fresh, and round-trips through update without touching the other controls', async () => {
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
    expect(before).not.toHaveProperty('continuous');
    expect(JSON.stringify(await run('tasks-get', { id: created.series_id, group: 'ag-1' }))).toContain(
      '"context":"fresh"',
    );

    await run('tasks-update', { id: created.series_id, group: 'ag-1', continuous: true });
    const on = taskContent(sessionId);
    expect(on.continuous).toBe(true);
    expect({ ...on, continuous: undefined }).toEqual({ ...before, continuous: undefined });
    expect(JSON.stringify(await run('tasks-get', { id: created.series_id, group: 'ag-1' }))).toContain(
      '"context":"continuous"',
    );

    await run('tasks-update', { id: created.series_id, group: 'ag-1', continuous: false });
    expect(taskContent(sessionId).continuous).toBe(false);
    expect(taskFiresFresh(JSON.stringify(taskContent(sessionId)))).toBe(true);
  });

  it('can be set at create', async () => {
    const created = await run('tasks-create', {
      group: 'ag-1',
      prompt: 'watch',
      process_after: '2999-01-01T00:00:00Z',
      continuous: true,
    });
    expect(taskContent(created.session_id as string).continuous).toBe(true);
  });

  it('a thread-bound series starts fresh with no flag', async () => {
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    const created = await run('tasks-create', {
      group: 'ag-1',
      prompt: 'post in the thread',
      process_after: '2999-01-01T00:00:00Z',
      messaging_group: 'mg-1',
      thread_id: 'slack:C1:1712345678.000100',
    });
    expect(JSON.stringify(await run('tasks-get', { id: created.series_id, group: 'ag-1' }))).toContain(
      '"context":"fresh"',
    );
  });

  it('a fresh fire keeps the same task session row, id and thread_id', async () => {
    const created = await run('tasks-create', {
      group: 'ag-1',
      prompt: 'watch',
      process_after: '2020-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
    });
    const sessionId = created.session_id as string;
    const seriesId = created.series_id as string;
    const before = await getSession(sessionId);
    expect(before?.thread_id).toBe(`system:tasks:${seriesId}`);

    const admitted = await withExistingMailboxSession('ag-1', sessionId, (mailbox) =>
      admitDueTaskContexts(mailbox, 'ag-1', sessionId),
    );
    expect(admitted).toBe(1);

    const again = await resolveTaskSession('ag-1', seriesId);
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(sessionId);
    expect(await getSession(sessionId)).toEqual(before);
    const rows = await getDb().all<{ id: string }>(
      'SELECT id FROM sessions WHERE thread_id = ?',
      `system:tasks:${seriesId}`,
    );
    expect(rows.map((r) => r.id)).toEqual([sessionId]);
  });
});
