/**
 * Aged-occurrence alarm (`escalateOverdueOccurrences`).
 *
 * In-memory SQLite pair under the production-composed mailbox session, so the
 * overdue read is the real op; the operator DM, the group lookup and the
 * timezone resolver are the only seams stubbed.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composeNanoclawSession } from '../mailbox/index.js';
import type { Session } from '../../types.js';

const notify = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, delivered: true }));
vi.mock('../../operator-alert.js', () => ({
  notifyOperators: async (text: string, context: Record<string, unknown>) => {
    notify.calls.push([text, context]);
    return notify.delivered;
  },
}));
vi.mock('../../db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/agent-groups.js')>()),
  getAgentGroup: async (id: string) => ({ id, name: 'group-under-test', folder: 'g-test' }),
}));
vi.mock('../../container-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-config.js')>()),
  resolveGroupTimezone: async () => 'UTC',
}));

import {
  TASK_OVERDUE_ALERT_MIN_GAP_MS,
  TASK_OVERDUE_ALERT_MS,
  _resetOverdueAlertsForTesting,
  escalateOverdueOccurrences,
  overdueCutoffMs,
} from './overdue.js';

const MIN = 60_000;
const NOW = Date.now();
const UP_LONG = 10 * TASK_OVERDUE_ALERT_MS;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function makeSession(withOutbound = true) {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT,
      tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT,
      channel_type TEXT, thread_id TEXT, content TEXT NOT NULL, source_session_id TEXT,
      on_wake INTEGER NOT NULL DEFAULT 0
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL);
  `);
  const mailbox = composeNanoclawSession(inDb, () => outDb, undefined, withOutbound);
  return { inDb, outDb, mailbox };
}

let seq = 0;
function seed(
  inDb: Database.Database,
  id: string,
  dueAgoMs: number,
  over: { recurrence?: string | null; trigger?: number; status?: string } = {},
) {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, content)
       VALUES (?, ?, 'task', ?, ?, ?, ?, 'series-a', ?, '{}')`,
    )
    .run(
      id,
      (seq += 2),
      ago(dueAgoMs),
      over.status ?? 'pending',
      ago(dueAgoMs),
      over.recurrence === undefined ? '30 1 * * *' : over.recurrence,
      over.trigger ?? 1,
    );
}

const session = { id: 'sess-test', agent_group_id: 'ag-test' } as Session;

beforeEach(() => {
  notify.calls = [];
  notify.delivered = true;
  _resetOverdueAlertsForTesting();
});

describe('overdueCutoffMs', () => {
  it('counts only time this host was up to watch', () => {
    expect(overdueCutoffMs(NOW, TASK_OVERDUE_ALERT_MS - 1)).toBeNull();
    expect(overdueCutoffMs(NOW, TASK_OVERDUE_ALERT_MS)).toBe(NOW - TASK_OVERDUE_ALERT_MS);
  });
});

describe('escalateOverdueOccurrences', () => {
  it('alerts once for a due occurrence nothing has claimed, and not again on later ticks', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);

    await escalateOverdueOccurrences(mailbox, session, true, NOW, UP_LONG);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN, UP_LONG);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 10 * MIN, UP_LONG);

    expect(notify.calls).toHaveLength(1);
    const [text, context] = notify.calls[0]!;
    expect(text).toContain('`series-a`');
    expect(text).toContain('`task-wedged`');
    expect(text).toContain('(90 min)');
    expect(text).toContain('A container IS running');
    expect(context).toMatchObject({ source: 'task-overdue', seriesId: 'series-a', occurrenceId: 'task-wedged' });
    // Observer only: the row is exactly as it was.
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'task-wedged'").get()).toEqual({
      status: 'pending',
    });
  });

  it('says so when no container is running', async () => {
    const { inDb, mailbox } = makeSession(false);
    seed(inDb, 'task-unwoken', 90 * MIN);

    await escalateOverdueOccurrences(mailbox, session, false, NOW, UP_LONG);

    expect(notify.calls).toHaveLength(1);
    expect(notify.calls[0]![0]).toContain('No container is running');
  });

  it('stays quiet inside the window, and for a host that has not been up for it', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-recent', 59 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW, UP_LONG);

    seed(inDb, 'task-old', 6 * 60 * MIN);
    await escalateOverdueOccurrences(mailbox, session, false, NOW, 5 * MIN);

    expect(notify.calls).toEqual([]);
  });

  it('stays quiet while the session is being worked, and for rows that are not a stuck schedule', async () => {
    const busy = makeSession();
    seed(busy.inDb, 'task-queued', 90 * MIN);
    // A different row is mid-turn: the container is busy, this one is queued.
    busy.outDb.prepare("INSERT INTO processing_ack VALUES ('other', 'processing', ?)").run(ago(80 * MIN));
    await escalateOverdueOccurrences(busy.mailbox, session, true, NOW, UP_LONG);

    const acked = makeSession();
    seed(acked.inDb, 'task-done', 90 * MIN);
    // Finished; the ack sync has simply not mirrored it yet.
    acked.outDb.prepare("INSERT INTO processing_ack VALUES ('task-done', 'completed', ?)").run(ago(MIN));
    await escalateOverdueOccurrences(acked.mailbox, session, true, NOW, UP_LONG);

    const other = makeSession();
    seed(other.inDb, 'task-oneshot', 90 * MIN, { recurrence: null }); // expireStalePending owns it
    seed(other.inDb, 'task-unadmitted', 90 * MIN, { trigger: 0 }); // never counted due
    seed(other.inDb, 'task-paused', 90 * MIN, { status: 'paused' });
    await escalateOverdueOccurrences(other.mailbox, session, true, NOW, UP_LONG);

    expect(notify.calls).toEqual([]);
  });

  it('leaves the alert armed when nobody was reached', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);

    notify.delivered = false;
    await escalateOverdueOccurrences(mailbox, session, true, NOW, UP_LONG);
    notify.delivered = true;
    await escalateOverdueOccurrences(mailbox, session, true, NOW + TASK_OVERDUE_ALERT_MIN_GAP_MS, UP_LONG);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 2 * TASK_OVERDUE_ALERT_MIN_GAP_MS, UP_LONG);

    expect(notify.calls).toHaveLength(2);
  });

  it('spaces a burst: one alert per gap, the rest stay armed', async () => {
    const a = makeSession();
    const b = makeSession();
    seed(a.inDb, 'task-a', 90 * MIN);
    seed(b.inDb, 'task-b', 90 * MIN);
    const sessionB = { id: 'sess-b', agent_group_id: 'ag-test' } as Session;

    await escalateOverdueOccurrences(a.mailbox, session, false, NOW, UP_LONG);
    await escalateOverdueOccurrences(b.mailbox, sessionB, false, NOW, UP_LONG);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-a']);

    await escalateOverdueOccurrences(b.mailbox, sessionB, false, NOW + TASK_OVERDUE_ALERT_MIN_GAP_MS, UP_LONG);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-a', 'task-b']);
  });

  it('re-arms for the next occurrence of the same series', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-first', 90 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW, UP_LONG);

    inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-first'").run();
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN, UP_LONG);
    seed(inDb, 'task-second', 90 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 30 * MIN, UP_LONG);

    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-first', 'task-second']);
  });
});
