/**
 * `createScheduledTask` — the template/agent-creation path into a task series.
 *
 * The case that matters here is the one the rest of the suite cannot reach:
 * the insert is a due-ness write, so it is bracketed by the session's
 * quiet-mark invalidation, and a refused invalidation must abort the create
 * rather than land a row the host sweep's quiet cache will hide (Codex round 2,
 * H1). What the bracket does on each side is asserted against real SQLite in
 * src/db/migrations/068-sessions-sweep-quiet-until.test.ts.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('scheduling-create-test') }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
  TIMEZONE: 'UTC',
}));

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { createScheduledTask, prepareScheduledTask } from './create.js';

const AG = 'ag-create-test';

function taskSession(): { id: string } {
  const sessions = getSessionsByAgentGroup(AG).filter((s) => s.thread_id?.startsWith('system:tasks'));
  expect(sessions, 'no task session was provisioned').toHaveLength(1);
  return sessions[0]!;
}

/** Task rows in this session's mailbox right now; 0 when it has no inbound.db yet. */
function taskRowCount(sessionId: string): number {
  const path = inboundDbPath(AG, sessionId);
  if (!fs.existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task'").get() as { c: number };
  db.close();
  return row.c;
}

const TASK = prepareScheduledTask({
  name: 'digest',
  prompt: 'post the digest',
  recurrence: '0 9 * * *',
});

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: AG, name: AG, folder: AG, agent_provider: null, created_at: new Date().toISOString() });
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('createScheduledTask', () => {
  it('invalidates in the same turn as the insert, with the row not yet written', async () => {
    const sessionsModule = await import('../../db/sessions.js');
    const original = sessionsModule.withQuietInvalidationSync;
    // Each entry: the session invalidated, and the task-row count at that
    // moment. A per-series id is random, so every create mints a fresh session
    // whose mark starts NULL — asserting the mark after the fact would be
    // vacuous. What is not vacuous is that the insert is the statement the
    // invalidation wraps, inside the mailbox callback.
    const entered: Array<[string, number]> = [];
    vi.spyOn(sessionsModule, 'withQuietInvalidationSync').mockImplementation(<T>(id: string, write: () => T) => {
      entered.push([id, taskRowCount(id)]);
      return original(id, write);
    });

    const { session } = await createScheduledTask(AG, TASK, { status: 'paused' });

    expect(entered).toEqual([[session.id, 0]]);
    expect(taskRowCount(session.id), 'the insert never landed').toBe(1);
  });

  it('writes nothing when the quiet-mark invalidation fails', async () => {
    const sessionsModule = await import('../../db/sessions.js');
    const spy = vi.spyOn(sessionsModule, 'withQuietInvalidationSync').mockImplementation((id: string) => {
      throw new sessionsModule.QuietInvalidationError(id, new Error('central DB is read-only'));
    });

    await expect(createScheduledTask(AG, TASK, { status: 'paused' })).rejects.toThrow(/quiet-mark invalidation failed/);
    spy.mockRestore();

    // The session was resolved (and its inbound.db provisioned) before the
    // bracket, so an empty mailbox is the abort, not a missing session.
    expect(taskRowCount(taskSession().id)).toBe(0);
  });
});
