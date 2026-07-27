/**
 * Tests for the scheduling module's task DB helpers — focused on the
 * series_id invariant that lets cancel/pause/resume/update reach the live
 * next occurrence of a recurring task, even after the row the agent
 * remembers has completed and been replaced by a follow-up.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import {
  insertTaskRow,
  insertRecurrence,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
  getCompletedRecurring,
  restoreTaskRow,
  cancelSeriesWithStrandClear,
  type RecurringMessage,
  type TaskRowSnapshot,
} from './db.js';

const TEST_DIR = '/tmp/nanoclaw-scheduling-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertBasicTask(db: ReturnType<typeof openInboundDb>, id: string, recurrence: string | null) {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date().toISOString(),
    recurrence,
    content: JSON.stringify({ prompt: 'noop' }),
  });
}

function simulateAdmittedTask(db: ReturnType<typeof openInboundDb>, id: string): void {
  db.prepare('UPDATE messages_in SET seq = 4, trigger = 1 WHERE id = ?').run(id);
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger, content)
     SELECT ?, 2, 'system', timestamp, 'pending', process_after, NULL, ?, 0, 0, ?
       FROM messages_in
      WHERE id = ?`,
  ).run(`recall-${id}`, `recall-${id}`, JSON.stringify({ subtype: 'recall_context', revision: 'stale' }), id);
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('insertTaskRow', () => {
  it('stamps series_id and keeps a scheduled occurrence inert until due admission', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', null);
    const row = db.prepare('SELECT series_id, trigger FROM messages_in WHERE id = ?').get('task-1') as {
      series_id: string;
      trigger: number;
    };
    expect(row.series_id).toBe('task-1');
    expect(row.trigger).toBe(0);
    db.close();
  });

  it('persists thread_id for a thread-scoped task', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-thr',
      seriesId: 'task-thr',
      processAfter: new Date().toISOString(),
      recurrence: '*/10 * * * *',
      platformId: 'CTEST00004',
      channelType: 'slack',
      threadId: 'CTEST00004:1779996680.937799',
      content: JSON.stringify({ prompt: 'loop' }),
    });
    const row = db.prepare('SELECT thread_id FROM messages_in WHERE id = ?').get('task-thr') as { thread_id: string };
    expect(row.thread_id).toBe('CTEST00004:1779996680.937799');
    db.close();
  });

  it('carries thread_id forward across a recurrence fire', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-thr',
      seriesId: 'task-thr',
      processAfter: new Date().toISOString(),
      recurrence: '*/10 * * * *',
      platformId: 'CTEST00004',
      channelType: 'slack',
      threadId: 'thr-xyz',
      content: JSON.stringify({ prompt: 'loop' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-thr'").run();
    const [msg] = getCompletedRecurring(db);
    insertRecurrence(db, msg, 'task-thr-2', new Date(Date.now() + 600000).toISOString());
    const next = db.prepare("SELECT thread_id FROM messages_in WHERE id = 'task-thr-2'").get() as {
      thread_id: string;
    };
    expect(next.thread_id).toBe('thr-xyz');
    expect(
      (db.prepare("SELECT trigger FROM messages_in WHERE id = 'task-thr-2'").get() as { trigger: number }).trigger,
    ).toBe(0);
    db.close();
  });
});

describe('cancel/pause/resume return affected-row counts', () => {
  // The host's management handlers use these counts to resolve which inbound
  // holds the series — calling-session (thread-scoped) first, then channel root.
  it('cancelTask returns 1 on match, 0 on miss', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', null);
    expect(cancelTask(db, 'task-1')).toBe(1);
    expect(cancelTask(db, 'task-1')).toBe(0); // already completed
    expect(cancelTask(db, 'nope')).toBe(0);
    db.close();
  });

  it('pauseTask / resumeTask return counts', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', '0 9 * * *');
    expect(pauseTask(db, 'task-1')).toBe(1);
    expect(pauseTask(db, 'task-1')).toBe(0); // already paused
    expect(resumeTask(db, 'task-1')).toBe(1);
    expect(resumeTask(db, 'nope')).toBe(0);
    db.close();
  });
});

describe('cancelTask / pauseTask / resumeTask series matching', () => {
  // Simulates the recurrence chain that used to survive cancellation:
  // the original task completes → handleRecurrence spawns a follow-up
  // row → agent calls cancel_task(originalId) → historically only hit
  // the completed row, leaving the live one running.
  function seedRecurringChain(db: ReturnType<typeof openInboundDb>) {
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    // Mark the original as completed (as syncProcessingAcks would do).
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: JSON.stringify({ prompt: 'noop' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());
  }

  it('cancel by original id reaches the live follow-up via series_id', () => {
    const db = freshDb();
    seedRecurringChain(db);

    cancelTask(db, 'task-orig');

    const live = db.prepare("SELECT id, status, recurrence FROM messages_in WHERE status = 'pending'").all();
    expect(live).toHaveLength(0);

    const followUp = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'task-next'").get() as {
      status: string;
      recurrence: string | null;
    };
    // Cancel marks 'cancelled' (not 'completed') so it never counts as a run.
    expect(followUp.status).toBe('cancelled');
    // Recurrence cleared so the sweep doesn't spawn another clone.
    expect(followUp.recurrence).toBeNull();
    db.close();
  });

  it('cancelled task is not picked up by getCompletedRecurring', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', '0 9 * * *');
    cancelTask(db, 'task-1');

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(0);
    db.close();
  });

  it('failed recurring task is picked up so the cron series advances', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-fail', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = 'task-fail'").run();

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(1);
    expect(recurring[0].id).toBe('task-fail');
    db.close();
  });

  it('expired recurring task is picked up so a missed fire resumes the series', () => {
    // Regression: a recurring fire that was never claimed (host down / sweep
    // delayed) is reaped to 'expired' by expireStalePending. Without 'expired'
    // in this set the row was orphaned and the series died permanently —
    // stranded the daily wiki-synth across all memory-enabled agents 2026-05-10.
    const db = freshDb();
    insertBasicTask(db, 'task-exp', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'expired' WHERE id = 'task-exp'").run();

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(1);
    expect(recurring[0].id).toBe('task-exp');
    db.close();
  });

  it('pause by original id pauses the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    pauseTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('paused');
    db.close();
  });

  it('resume by original id resumes the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = 'task-next'").run();
    resumeTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('pending');
    db.close();
  });

  it('resume atomically invalidates an admitted paused row before its next execution', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-admitted-resume', '0 9 * * *');
    simulateAdmittedTask(db, 'task-admitted-resume');
    pauseTask(db, 'task-admitted-resume');

    expect(resumeTask(db, 'task-admitted-resume')).toBe(1);

    const rows = db.prepare('SELECT id, seq, status, trigger FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      status: string;
      trigger: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'task-admitted-resume',
      status: 'pending',
      trigger: 0,
    });
    expect(rows[0]!.seq).toBeGreaterThan(4);
    db.close();
  });

  it('pause/resume touch ONLY status — recurrence and process_after survive the cycle', () => {
    const db = freshDb();
    seedRecurringChain(db);
    const before = db.prepare("SELECT recurrence, process_after FROM messages_in WHERE id = 'task-next'").get() as {
      recurrence: string | null;
      process_after: string | null;
    };

    pauseTask(db, 'task-next');
    resumeTask(db, 'task-next');

    const after = db.prepare("SELECT recurrence, process_after FROM messages_in WHERE id = 'task-next'").get() as {
      recurrence: string | null;
      process_after: string | null;
    };
    // A cancel-style copy-paste (clearing recurrence) would kill the series here.
    expect(after.recurrence).toBe(before.recurrence);
    expect(after.process_after).toBe(before.process_after);
    db.close();
  });
});

describe('updateTask', () => {
  it('invalidates stale admission when an active occurrence is edited or snoozed', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-admitted-update',
      seriesId: 'task-admitted-update',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'old' }),
    });
    simulateAdmittedTask(db, 'task-admitted-update');

    const touched = updateTask(db, 'task-admitted-update', {
      prompt: 'new',
      processAfter: '2026-02-01T00:00:00Z',
    });

    expect(touched).toBe(1);
    const rows = db.prepare('SELECT id, seq, status, trigger, process_after, content FROM messages_in').all() as Array<{
      id: string;
      seq: number;
      status: string;
      trigger: number;
      process_after: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'task-admitted-update',
      status: 'pending',
      trigger: 0,
      process_after: '2026-02-01T00:00:00Z',
    });
    expect(rows[0]!.seq).toBeGreaterThan(4);
    expect(JSON.parse(rows[0]!.content)).toMatchObject({ prompt: 'new' });
    db.close();
  });

  it('merges supplied fields into content JSON without clobbering others', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep me' }),
    });

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(1);

    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-1') as { content: string };
    const parsed = JSON.parse(row.content);
    expect(parsed.prompt).toBe('new');
    expect(parsed.script).toBe('echo old');
    expect(parsed.extra).toBe('keep me');
  });

  it('updates recurrence and process_after when supplied', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: '0 18 * * *', processAfter: '2026-02-01T00:00:00Z' });

    const row = db.prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string;
      process_after: string;
    };
    expect(row.recurrence).toBe('0 18 * * *');
    expect(row.process_after).toBe('2026-02-01T00:00:00Z');
  });

  it('clears recurrence when null is passed', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: null });

    const row = db.prepare('SELECT recurrence FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
  });

  it('reaches the live follow-up via series_id when called with the original id', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-orig',
      seriesId: 'task-orig',
      processAfter: new Date().toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'old' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: JSON.stringify({ prompt: 'old' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());

    const touched = updateTask(db, 'task-orig', { prompt: 'new' });
    // Only the live follow-up should be touched — completed rows are excluded.
    expect(touched).toBe(1);

    const live = db.prepare("SELECT content FROM messages_in WHERE id = 'task-next'").get() as { content: string };
    expect(JSON.parse(live.content).prompt).toBe('new');

    // Original (completed) row left alone.
    const orig = db.prepare("SELECT content FROM messages_in WHERE id = 'task-orig'").get() as { content: string };
    expect(JSON.parse(orig.content).prompt).toBe('old');
  });

  it('returns 0 when no live task matches', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'p' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(0);
  });
});

describe('restoreTaskRow', () => {
  // Move compensation (§4.2 step 5) and paused-snapshot staged restore (§4.2 4a)
  // re-insert a snapshot of the source row. Unlike insertTask (which sets
  // series_id = new id, severing identity) restoreTaskRow preserves the
  // snapshot's series_id AND status — a paused row must come back paused.
  it('test_restore_preserves_series_id_and_status', () => {
    const db = freshDb();
    const snapshot: TaskRowSnapshot = {
      id: 'restored-1',
      series_id: 'S',
      status: 'paused',
      process_after: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'restore me', script: 'echo hi' }),
      platform_id: 'C1',
      channel_type: 'slack',
      thread_id: null,
      kind: 'task',
    };

    restoreTaskRow(db, snapshot);

    const row = db
      .prepare(
        'SELECT series_id, status, recurrence, process_after, content, platform_id, channel_type, kind FROM messages_in WHERE id = ?',
      )
      .get('restored-1') as {
      series_id: string;
      status: string;
      recurrence: string | null;
      process_after: string | null;
      content: string;
      platform_id: string | null;
      channel_type: string | null;
      kind: string;
    };
    expect(row.series_id).toBe('S');
    expect(row.status).toBe('paused');
    expect(row.recurrence).toBe('0 9 * * *');
    expect(row.process_after).toBe('2026-01-01T00:00:00Z');
    expect(JSON.parse(row.content).script).toBe('echo hi');
    expect(row.platform_id).toBe('C1');
    expect(row.channel_type).toBe('slack');
    expect(row.kind).toBe('task');
    db.close();
  });

  it('restores a pending snapshot as pending', () => {
    const db = freshDb();
    const snapshot: TaskRowSnapshot = {
      id: 'restored-2',
      series_id: 'S2',
      status: 'pending',
      process_after: '2026-02-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: '{}',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    };
    restoreTaskRow(db, snapshot);
    const row = db.prepare('SELECT status FROM messages_in WHERE id = ?').get('restored-2') as { status: string };
    expect(row.status).toBe('pending');
    db.close();
  });
});

describe('cancelSeriesWithStrandClear', () => {
  it('test_cancel_strand_clear_clears_terminal_recurrence', () => {
    // A pure strand: one terminal (completed) row still carrying recurrence,
    // no live row. getCompletedRecurring would mint a successor, silently
    // undoing the operator's cancel. cancelSeriesWithStrandClear clears it.
    const db = freshDb();
    insertBasicTask(db, 'task-strand', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-strand'").run();
    // Precondition: the strand is resurrectable.
    expect(getCompletedRecurring(db).some((r) => r.series_id === 'task-strand')).toBe(true);

    const count = cancelSeriesWithStrandClear(db, 'task-strand');

    const row = db.prepare("SELECT recurrence FROM messages_in WHERE id = 'task-strand'").get() as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
    expect(count).toBeGreaterThanOrEqual(1);
    // No longer resurrectable.
    expect(getCompletedRecurring(db).some((r) => r.series_id === 'task-strand')).toBe(false);
    db.close();
  });

  it('test_cancel_strand_clear_live_and_terminal', () => {
    // One live pending row + one terminal recurrence-set row in the same
    // series. The live row → completed + recurrence NULL (cancelTask); the
    // terminal row → recurrence NULL (strand clear). Count === 2.
    const db = freshDb();
    // Terminal recurrence-set row (crash residue / swallowed-parse strand).
    insertBasicTask(db, 'series-term', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'series-term'").run();
    // Live pending follow-up sharing the same series_id.
    const msg: RecurringMessage = {
      id: 'series-term',
      kind: 'task',
      content: JSON.stringify({ prompt: 'noop' }),
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'series-term',
    };
    insertRecurrence(db, msg, 'series-live', new Date(Date.now() + 86400000).toISOString());

    const count = cancelSeriesWithStrandClear(db, 'series-term');

    const live = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'series-live'").get() as {
      status: string;
      recurrence: string | null;
    };
    const term = db.prepare("SELECT recurrence FROM messages_in WHERE id = 'series-term'").get() as {
      recurrence: string | null;
    };
    expect(live.status).toBe('cancelled');
    expect(live.recurrence).toBeNull();
    expect(term.recurrence).toBeNull();
    expect(count).toBe(2);
    // Series is no longer resurrectable.
    expect(getCompletedRecurring(db).some((r) => r.series_id === 'series-term')).toBe(false);
    db.close();
  });

  it('returns 0 on a fully-absent series (no live rows, no terminal recurrence)', () => {
    const db = freshDb();
    expect(cancelSeriesWithStrandClear(db, 'nonexistent')).toBe(0);
    db.close();
  });
});

describe('insertRecurrence', () => {
  it('copies series_id forward', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      kind: 'task',
      content: '{}',
      recurrence: '0 9 * * *',
      process_after: null,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date().toISOString());

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-next') as {
      series_id: string;
    };
    expect(row.series_id).toBe('task-orig');
    db.close();
  });
});
