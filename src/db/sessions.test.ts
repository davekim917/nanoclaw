/**
 * `getAskQuestionRender`'s two `hasTable` guards (seam 3, PR 4).
 *
 * Under the old synchronous `hasTable` these guards short-circuited cleanly
 * when the module-owned table was absent (module not installed / not yet
 * migrated). An un-awaited async `hasTable` returns a Promise, which is
 * always truthy, inverting the guard: the code would try to query a table
 * that doesn't exist and throw instead of falling through. This pins the
 * early-return behavior so that inversion regresses loudly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getRawDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  TASKS_SYSTEM_THREAD_ID,
  createSession,
  findTaskSessions,
  getAskQuestionRender,
  isTaskThread,
  taskSeriesId,
  taskThreadId,
} from './sessions.js';

describe('getAskQuestionRender — module-absent path', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    // Simulate an install where the pending_channel_approvals /
    // pending_sender_approvals modules were never migrated in, which is
    // exactly the state the two `hasTable` guards exist to handle.
    getRawDb().exec('DROP TABLE pending_channel_approvals');
    getRawDb().exec('DROP TABLE pending_sender_approvals');
  });

  afterEach(async () => {
    await closeDb();
  });

  it('module-absent path returns early when the module table is missing', async () => {
    // No pending_question, no pending_approval, and both module tables gone
    // — every branch must fall through to the final `undefined` without
    // throwing.
    await expect(getAskQuestionRender('some-card-id')).resolves.toBeUndefined();
  });
});

/**
 * Task sessions are per-series. The bare `system:tasks` was the shared session
 * they replaced, and THREE separate claims about it are all true at once. An
 * earlier version of this comment ran them together as "nothing produces it and
 * nothing accepts it", which contradicted the cases directly below:
 *
 *   1. Nothing CREATES it. `taskThreadId` is the only producer and appends `:`
 *      unconditionally, so the bare form is unreachable by construction. This
 *      is a fact about the code and holds on every install.
 *   2. It cannot NAME a series — which is why `taskSeriesId` returns null for
 *      it rather than the empty string the old raw slice produced.
 *   3. It must remain REACHABLE. An upgraded install may still hold an active
 *      one, and `findTaskSessions` is how every consumer enumerates task
 *      sessions (`src/cli/resources/tasks.ts:182` and `:996`,
 *      `src/modules/scheduling/pin-audit.ts:77`). Hiding it would leave a live
 *      task that `ncl tasks cancel` cannot reach.
 *
 * (1) is why the value never appears in new data; (3) is why the predicates
 * still accept it. Pure functions here on purpose — no fixture. The guarantee
 * being pinned is (1)'s construction rule, NOT "the table currently holds no
 * bare rows"; it holds none today (452 task sessions on this install, all
 * per-series), but that is a property of this install, not of the code.
 */
describe('per-series task session threads', () => {
  it('taskThreadId always emits the prefix form, never the bare one', () => {
    expect(taskThreadId('daily-digest-a1b2')).toBe(`${TASKS_SYSTEM_THREAD_ID}:daily-digest-a1b2`);
    // Even a degenerate series id keeps the separator, so the result can never
    // collide with the bare thread id.
    expect(taskThreadId('')).toBe(`${TASKS_SYSTEM_THREAD_ID}:`);
    expect(taskThreadId('')).not.toBe(TASKS_SYSTEM_THREAD_ID);
  });

  it('isTaskThread still accepts a legacy bare thread — it IS a task thread', () => {
    expect(isTaskThread(taskThreadId('watch-1'))).toBe(true);
    // Narrowing this would hide an active legacy session from
    // `findTaskSessions`, and with it from `ncl tasks cancel`
    // (`src/cli/resources/tasks.ts:182`).
    expect(isTaskThread(TASKS_SYSTEM_THREAD_ID)).toBe(true);
    expect(isTaskThread('system:tasksxyz')).toBe(false);
    expect(isTaskThread(null)).toBe(false);
  });

  it('taskSeriesId returns null for a thread that names no series, never an empty string', () => {
    expect(taskSeriesId(taskThreadId('watch-1'))).toBe('watch-1');
    // THE bug: `.slice(prefix.length)` took 13 characters off this 12-character
    // string and produced ''. `appendRunLog` rejected that on its charset guard
    // (`src/modules/scheduling/run-log.ts:24`) before writing anything;
    // `recordTaskRunOutcome` (`src/db/task-run-outcomes.ts:47-61`) had no
    // guard, so the empty id landed in the central ledger instead.
    expect(taskSeriesId(TASKS_SYSTEM_THREAD_ID)).toBeNull();
    expect(taskSeriesId(`${TASKS_SYSTEM_THREAD_ID}:`)).toBeNull();
    expect(taskSeriesId('slack:C123:1.1')).toBeNull();
    expect(taskSeriesId(null)).toBeNull();
  });
});

/**
 * A legacy `system:tasks` session must stay REACHABLE.
 *
 * Nothing creates the bare form any more, but an install upgraded from the
 * shared-session era can still hold an ACTIVE one, and `findTaskSessions` is
 * what `ncl tasks list/get/update/cancel/delete` reaches task sessions through.
 * Narrowing that query to the per-series prefix would hide a live scheduled
 * task from `cancel` — a task still firing that nobody can stop.
 *
 * The legacy row is built here rather than asserted against live data: this
 * install has none (452 task sessions, all per-series), which is exactly why a
 * fixture is the only honest way to cover the shape.
 */
describe('findTaskSessions — legacy shared session reachability', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    getRawDb()
      .prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'ag', 'ag', ?)")
      .run(new Date().toISOString());
  });

  afterEach(async () => {
    await closeDb();
  });

  async function seed(id: string, threadId: string): Promise<void> {
    await createSession({
      id,
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  }

  it('returns a legacy bare session alongside per-series ones', async () => {
    await seed('sess-legacy', TASKS_SYSTEM_THREAD_ID);
    await seed('sess-series', taskThreadId('watch-1'));

    const found = await findTaskSessions('ag-1');

    expect(found.map((f) => f.id).sort()).toEqual(['sess-legacy', 'sess-series']);
  });

  it('the legacy session names no series, so nothing derives an empty one from it', async () => {
    await seed('sess-legacy', TASKS_SYSTEM_THREAD_ID);
    const [legacy] = await findTaskSessions('ag-1');

    expect(legacy!.thread_id).toBe(TASKS_SYSTEM_THREAD_ID);
    expect(taskSeriesId(legacy!.thread_id)).toBeNull();
    expect(taskSeriesId(legacy!.thread_id)).not.toBe('');
  });
});
