/**
 * Tests for the scheduling module's task DB helpers — focused on the
 * series_id invariant that lets cancel/pause/resume/update reach the live
 * next occurrence of a recurring task, even after the row the agent
 * remembers has completed and been replaced by a follow-up.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('scheduling-db-test') }));

// The seam's ops run against DATA_DIR-derived mailbox paths, so the mailbox
// case below needs a real session directory under a scratch data root. The
// handle-level cases keep using their own file.
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

import { openInboundDb } from '../mailbox/openers.js';
import { ensureSchema } from '../mailbox/schema.js';
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
import { withMailboxSession } from '../../session-manager.js';
import { parseProcessingAckRecord } from '../../mailbox/model.js';
import type { NanoclawMailboxSession } from '../../modules/mailbox/index.js';

const TEST_DIR = TEST_ROOT;
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

  it('stamps scheduled_for from the same value as process_after', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-slot',
      seriesId: 'task-slot',
      processAfter: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily brief' }),
    });
    expect(db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('task-slot')).toEqual({
      process_after: '2026-01-05T09:00:00.000Z',
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
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

  it('moves scheduled_for with process_after — a reschedule changes the slot', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-resched',
      seriesId: 'task-resched',
      processAfter: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily brief' }),
    });

    updateTask(db, 'task-resched', { processAfter: '2026-01-05T14:00:00.000Z' });

    expect(db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('task-resched')).toEqual(
      { process_after: '2026-01-05T14:00:00.000Z', scheduled_for: '2026-01-05T14:00:00.000Z' },
    );
    db.close();
  });

  it('keepScheduledFor moves ONLY process_after — run-now fires early without shifting the slot', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-runnow',
      seriesId: 'task-runnow',
      processAfter: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily brief' }),
    });

    updateTask(db, 'task-runnow', { processAfter: '2026-01-05T07:12:00.000Z', keepScheduledFor: true });

    expect(db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('task-runnow')).toEqual({
      process_after: '2026-01-05T07:12:00.000Z',
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
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

  it('schedule edits skip a queued run-now row — no second recurring chain', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });
    // `ncl tasks run` queues an extra occurrence: pending, same series,
    // recurrence NULL. A recurrence update must not stamp it — that would
    // rearm it as a duplicate series after it completes.
    insertTaskRow(db, {
      id: 'task-1-run-abc',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:01Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: '0 18 * * *', processAfter: '2026-02-01T00:00:00Z' });

    const canonical = db.prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string;
      process_after: string;
    };
    expect(canonical.recurrence).toBe('0 18 * * *');
    expect(canonical.process_after).toBe('2026-02-01T00:00:00Z');
    const runNow = db
      .prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?')
      .get('task-1-run-abc') as {
      recurrence: string | null;
      process_after: string;
    };
    expect(runNow.recurrence).toBeNull();
    expect(runNow.process_after).toBe('2026-01-01T00:00:01Z');
  });

  it('content edits still reach a queued run-now row', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'old' }),
    });
    insertTaskRow(db, {
      id: 'task-1-run-abc',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:01Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'old' }),
    });

    const touched = updateTask(db, 'task-1', { prompt: 'new' });

    expect(touched).toBe(2);
    for (const id of ['task-1', 'task-1-run-abc']) {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string };
      expect(JSON.parse(row.content).prompt).toBe('new');
    }
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
  /**
   * The restored row's own timestamp must be ISO, like every other row's.
   *
   * It was `datetime('now')` — the naive `YYYY-MM-DD HH:MM:SS` shape, which
   * `new Date()` reads as LOCAL time and which sorts BELOW every ISO value as
   * TEXT. A restored row therefore ordered before every sibling in the same
   * column and compared wrong against them (CLAUDE.md, Timestamps).
   */
  it('test_restore_writes_an_iso_timestamp_alongside_its_siblings', () => {
    const db = freshDb();
    insertBasicTask(db, 'sibling-1', null);
    restoreTaskRow(db, {
      id: 'restored-iso',
      series_id: 'S',
      status: 'pending',
      process_after: '2026-01-01T00:00:00Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'restore me' }),
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    });

    const rows = db.prepare('SELECT id, timestamp FROM messages_in ORDER BY id').all() as Array<{
      id: string;
      timestamp: string;
    }>;
    const restored = rows.find((r) => r.id === 'restored-iso')!;
    expect(restored.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // And it sorts WITH its siblings as TEXT, which the naive shape did not.
    const sibling = rows.find((r) => r.id === 'sibling-1')!;
    expect(restored.timestamp >= sibling.timestamp).toBe(true);
    db.close();
  });

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

  it('carries scheduled_for through a restore, falling back for a pre-column snapshot', () => {
    const db = freshDb();
    const base: TaskRowSnapshot = {
      id: 'restored-slot',
      series_id: 'series-slot',
      status: 'pending',
      process_after: '2026-01-05T11:47:00.000Z',
      scheduled_for: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily brief' }),
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    };
    restoreTaskRow(db, base);
    expect(
      db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('restored-slot'),
    ).toEqual({ process_after: '2026-01-05T11:47:00.000Z', scheduled_for: '2026-01-05T09:00:00.000Z' });

    // ISO-8601 UTC, not datetime('now')'s naive shape — `new Date()` reads that
    // as LOCAL time, skewing display and string comparisons against every other
    // row in the table.
    const stamped = db.prepare('SELECT timestamp FROM messages_in WHERE id = ?').get('restored-slot') as {
      timestamp: string;
    };
    expect(stamped.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // A move_intent audit body written before the column existed carries no
    // scheduled_for; the restore must still produce a usable row.
    const { scheduled_for: _omitted, ...legacy } = base;
    restoreTaskRow(db, { ...legacy, id: 'restored-legacy' });
    expect(
      db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('restored-legacy'),
    ).toEqual({ process_after: '2026-01-05T11:47:00.000Z', scheduled_for: '2026-01-05T11:47:00.000Z' });
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
  it("stamps the successor occurrence with its OWN slot, not the previous run's", () => {
    const db = freshDb();
    const previous: RecurringMessage = {
      id: 'task-day1',
      kind: 'task',
      content: JSON.stringify({ prompt: 'daily brief' }),
      recurrence: '0 9 * * *',
      process_after: '2026-01-04T09:00:00.000Z',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      series_id: 'task-day1',
    };
    insertRecurrence(db, previous, 'task-day2', '2026-01-05T09:00:00.000Z');
    expect(db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('task-day2')).toEqual({
      process_after: '2026-01-05T09:00:00.000Z',
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
    db.close();
  });

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

/**
 * Codex round, generalized. The reviewer found the read-only preview path
 * throwing `no such column: scheduled_for` on a session the lazy migration has
 * not reached yet. The WRITE helpers that name the column have the same
 * exposure and a worse outcome — scheduling, editing or restoring a task fails
 * outright rather than degrading — so each migrates the handle it is given.
 */
describe('slots copied out of a session DB are normalized to ISO UTC', () => {
  it('restoreTaskRow rewrites a naive snapshot slot', () => {
    const db = freshDb();
    restoreTaskRow(db, {
      id: 'task-naive-slot',
      series_id: 'ser-naive-slot',
      status: 'pending',
      process_after: '2026-01-05T11:47:00.000Z',
      scheduled_for: '2026-01-05 09:00:00',
      recurrence: '0 9 * * *',
      content: '{}',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    });

    expect(db.prepare('SELECT scheduled_for FROM messages_in WHERE id = ?').get('task-naive-slot')).toEqual({
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
    db.close();
  });

  it('restoreTaskRow rewrites a naive process_after when it is the only slot available', () => {
    // A pre-column audit snapshot has no scheduled_for at all, so the restore
    // falls back to process_after — which on the same install is naive too.
    const db = freshDb();
    restoreTaskRow(db, {
      id: 'task-naive-fallback',
      series_id: 'ser-naive-fallback',
      status: 'paused',
      process_after: '2026-01-05 09:00:00',
      recurrence: null,
      content: '{}',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    });

    expect(db.prepare('SELECT scheduled_for FROM messages_in WHERE id = ?').get('task-naive-fallback')).toEqual({
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
    db.close();
  });
});

describe('task writers on a session that predates scheduled_for', () => {
  /** The pre-migration on-disk shape, produced from the migrated one. */
  function legacyDb() {
    const db = freshDb();
    db.exec('ALTER TABLE messages_in DROP COLUMN scheduled_for');
    return db;
  }

  const columns = (db: ReturnType<typeof freshDb>) =>
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);

  it('insertTaskRow migrates the column into place', () => {
    const db = legacyDb();
    expect(columns(db)).not.toContain('scheduled_for');

    insertTaskRow(db, {
      id: 'task-legacy-insert',
      seriesId: 'task-legacy-insert',
      processAfter: '2026-01-05T09:00:00.000Z',
      recurrence: null,
      content: '{}',
    });

    expect(columns(db)).toContain('scheduled_for');
    expect(db.prepare('SELECT scheduled_for FROM messages_in WHERE id = ?').get('task-legacy-insert')).toEqual({
      scheduled_for: '2026-01-05T09:00:00.000Z',
    });
    db.close();
  });

  it('updateTask migrates the column into place', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-legacy-update',
      seriesId: 'ser-legacy-update',
      processAfter: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: '{}',
    });
    db.exec('ALTER TABLE messages_in DROP COLUMN scheduled_for');
    expect(columns(db)).not.toContain('scheduled_for');

    expect(updateTask(db, 'ser-legacy-update', { processAfter: '2026-01-06T09:00:00.000Z' })).toBe(1);

    expect(
      db.prepare('SELECT process_after, scheduled_for FROM messages_in WHERE id = ?').get('task-legacy-update'),
    ).toEqual({ process_after: '2026-01-06T09:00:00.000Z', scheduled_for: '2026-01-06T09:00:00.000Z' });
    db.close();
  });

  it('restoreTaskRow migrates the column into place', () => {
    const db = legacyDb();
    const snapshot: TaskRowSnapshot = {
      id: 'task-legacy-restore',
      series_id: 'ser-legacy-restore',
      status: 'paused',
      process_after: '2026-01-05T09:00:00.000Z',
      scheduled_for: '2026-01-05T09:00:00.000Z',
      recurrence: '0 9 * * *',
      content: '{}',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      kind: 'task',
    };

    restoreTaskRow(db, snapshot);

    expect(db.prepare('SELECT status, scheduled_for FROM messages_in WHERE id = ?').get('task-legacy-restore')).toEqual(
      {
        status: 'paused',
        scheduled_for: '2026-01-05T09:00:00.000Z',
      },
    );
    db.close();
  });
});

/**
 * PR 4 (mailbox seam, ingress family): the task SQL above now lives in
 * `src/modules/mailbox/ops/tasks.ts` and this file is its façade. The case
 * below drives the same statements the other way round — through a real
 * mailbox session — and pins the one property the split-out ops must not lose.
 */
describe('task ops on the mailbox session', () => {
  const DATA_ROOT = path.join(TEST_ROOT, 'data');
  const AG = 'ag-sched-ops';
  const SESS = 'sess-sched-ops';

  const fork = (m: unknown) => m as NanoclawMailboxSession;

  const recurring = (id: string): RecurringMessage => ({
    id,
    kind: 'task',
    content: JSON.stringify({ prompt: 'noop' }),
    recurrence: '0 9 * * *',
    process_after: new Date().toISOString(),
    platform_id: 'slack:C1',
    channel_type: 'slack',
    thread_id: 'slack:C1:1.1',
    series_id: id,
  });

  function inboundRows(): Array<{ id: string; status: string; recurrence: string | null; thread_id: string | null }> {
    const db = openInboundDb(path.join(DATA_ROOT, 'v2-sessions', AG, SESS, 'inbound.db'));
    try {
      return db
        .prepare("SELECT id, status, recurrence, thread_id FROM messages_in WHERE kind = 'task' ORDER BY seq")
        .all() as Array<{
        id: string;
        status: string;
        recurrence: string | null;
        thread_id: string | null;
      }>;
    } finally {
      db.close();
    }
  }

  afterEach(() => {
    if (fs.existsSync(DATA_ROOT)) fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  });

  it('task ops run through the mailbox session and preserve recurrence arming atomicity', async () => {
    await withMailboxSession(AG, SESS, (mailbox) => {
      fork(mailbox).insertTaskRow({
        id: 'task-1',
        seriesId: 'task-1',
        processAfter: new Date().toISOString(),
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: 'noop' }),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: 'slack:C1:1.1',
      });
    });
    // Fork insert semantics survive the move: routing is carried, and the row
    // lands inert so only the host's due-admission seam can wake it.
    expect(inboundRows()).toEqual([
      { id: 'task-1', status: 'pending', recurrence: '0 9 * * *', thread_id: 'slack:C1:1.1' },
    ]);

    // The original completes; the sweep arms the next occurrence.
    await withMailboxSession(AG, SESS, (mailbox) => {
      mailbox.applyProcessingAcks([
        parseProcessingAckRecord({
          messageId: 'task-1',
          status: 'completed',
          statusChanged: new Date().toISOString(),
        }),
      ]);
      const completed = fork(mailbox).getCompletedRecurringRows();
      expect(completed.map((r) => r.id)).toEqual(['task-1']);
      fork(mailbox).armNextRecurrence('task-1', completed[0], 'task-2', new Date(Date.now() + 60_000).toISOString());
    });

    // Insert + clear are ONE durable step. The torn states this rules out are
    // both live bugs: a successor next to a still-armed original re-clones the
    // series every tick, and a cleared original with no successor silently
    // kills it. Observing either would require reading between two writes of a
    // single transaction inside a single session — there is no such point.
    const armed = inboundRows();
    expect(armed).toEqual([
      { id: 'task-1', status: 'completed', recurrence: null, thread_id: 'slack:C1:1.1' },
      { id: 'task-2', status: 'pending', recurrence: '0 9 * * *', thread_id: 'slack:C1:1.1' },
    ]);

    // And the rollback direction: a failing arm leaves the original armed, so
    // the next tick retries rather than dropping the series.
    await withMailboxSession(AG, SESS, (mailbox) => {
      const source = { ...recurring('task-2'), recurrence: '0 9 * * *' };
      expect(() => fork(mailbox).armNextRecurrence('task-2', source, 'task-1', null)).toThrow();
    });
    expect(inboundRows().find((r) => r.id === 'task-2')).toMatchObject({ recurrence: '0 9 * * *' });
  });
});
