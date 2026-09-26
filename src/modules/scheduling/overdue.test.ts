/**
 * Aged-occurrence alarm (`escalateOverdueOccurrences`).
 *
 * In-memory SQLite pair under the production-composed mailbox session, so the
 * overdue read is the real op; the operator DM, the group lookup and the
 * timezone resolver are the only seams stubbed.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
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
  TASK_OVERDUE_ATTEMPT_MIN_GAP_MS,
  _resetOverdueAlertsForTesting,
  escalateOverdueOccurrences,
} from './overdue.js';

const MIN = 60_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function makeSession(withOutbound = true) {
  const inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  const outDb = new Database(':memory:');
  outDb.exec(OUTBOUND_SCHEMA);
  const mailbox = composeNanoclawSession(inDb, () => outDb, undefined, withOutbound);
  return { inDb, outDb, mailbox };
}

let seq = 0;
function seed(
  inDb: Database.Database,
  id: string,
  dueAgoMs: number,
  over: { recurrence?: string | null; trigger?: number; status?: string; content?: Record<string, unknown> } = {},
) {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, content)
       VALUES (?, ?, 'task', ?, ?, ?, ?, 'series-a', ?, ?)`,
    )
    .run(
      id,
      (seq += 2),
      ago(dueAgoMs),
      over.status ?? 'pending',
      ago(dueAgoMs),
      over.recurrence === undefined ? '30 1 * * *' : over.recurrence,
      over.trigger ?? 1,
      JSON.stringify(over.content ?? {}),
    );
}

const session = { id: 'sess-test', agent_group_id: 'ag-test' } as Session;

beforeEach(() => {
  notify.calls = [];
  notify.delivered = true;
  _resetOverdueAlertsForTesting();
});

describe('escalateOverdueOccurrences', () => {
  it('alerts once for a due occurrence nothing has claimed, and not again on later ticks', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);

    await escalateOverdueOccurrences(mailbox, session, true, NOW);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 10 * MIN);

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

    await escalateOverdueOccurrences(mailbox, session, false, NOW);

    expect(notify.calls).toHaveLength(1);
    expect(notify.calls[0]![0]).toContain('No container is running');
  });

  it('stays quiet inside the window, and alerts from the minute it closes', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-recent', 59 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW);
    expect(notify.calls).toEqual([]);

    // Lateness is `now - process_after` and nothing else: no host-uptime term.
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-recent']);
    expect(notify.calls[0]![0]).toContain('(60 min)');
  });

  it('a claim on another row does not hide a stuck occurrence: it alerts as queued behind active work', async () => {
    const busy = makeSession();
    seed(busy.inDb, 'task-queued', 90 * MIN);
    // A different message is mid-turn and has held the session for 80 minutes.
    busy.outDb.prepare("INSERT INTO processing_ack VALUES ('other', 'processing', ?)").run(ago(80 * MIN));

    await escalateOverdueOccurrences(busy.mailbox, session, true, NOW);

    expect(notify.calls).toHaveLength(1);
    const [text, context] = notify.calls[0]!;
    expect(context).toMatchObject({ occurrenceId: 'task-queued' });
    expect(text).toContain('queued behind active work');
    expect(text).toContain('its turn on another message has not ended');
    expect(text).not.toContain('nothing has claimed it');
    expect(text).not.toContain('holds no claim');
  });

  it('a stale claim with no container running is reported as a claim, not as work in progress', async () => {
    const busy = makeSession();
    seed(busy.inDb, 'task-queued', 90 * MIN);
    busy.outDb.prepare("INSERT INTO processing_ack VALUES ('other', 'processing', ?)").run(ago(80 * MIN));

    await escalateOverdueOccurrences(busy.mailbox, session, false, NOW);

    expect(notify.calls).toHaveLength(1);
    expect(notify.calls[0]![0]).toContain('queued behind active work');
    expect(notify.calls[0]![0]).toContain('still holds a processing claim');
  });

  it("the row's own ack excludes it, in any status", async () => {
    const claimed = makeSession();
    seed(claimed.inDb, 'task-running', 90 * MIN);
    // Its own turn is under way: the claim-stuck rule judges that, not this one.
    claimed.outDb.prepare("INSERT INTO processing_ack VALUES ('task-running', 'processing', ?)").run(ago(80 * MIN));
    await escalateOverdueOccurrences(claimed.mailbox, session, true, NOW);

    const acked = makeSession();
    seed(acked.inDb, 'task-done', 90 * MIN);
    // Finished; the ack sync has simply not mirrored it yet.
    acked.outDb.prepare("INSERT INTO processing_ack VALUES ('task-done', 'completed', ?)").run(ago(MIN));
    await escalateOverdueOccurrences(acked.mailbox, session, true, NOW);

    expect(notify.calls).toEqual([]);
  });

  it('stays quiet for rows that are not a stuck schedule', async () => {
    const other = makeSession();
    seed(other.inDb, 'task-oneshot', 90 * MIN, { recurrence: null }); // expireStalePending owns it
    seed(other.inDb, 'task-unadmitted', 90 * MIN, { trigger: 0 }); // never counted due
    seed(other.inDb, 'task-paused', 90 * MIN, { status: 'paused' });
    await escalateOverdueOccurrences(other.mailbox, session, true, NOW);

    expect(notify.calls).toEqual([]);
  });

  it('a failed delivery leaves the occurrence owing, and is not re-attempted inside the gap', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);

    notify.delivered = false;
    await escalateOverdueOccurrences(mailbox, session, true, NOW);
    expect(notify.calls).toHaveLength(1);

    // Inside the gap: every sweep tick comes back here, and none may spend
    // another delivery deadline on recipients just shown to be unreachable —
    // not for this occurrence, and not for another session's either.
    notify.delivered = true;
    const other = makeSession();
    seed(other.inDb, 'task-other', 90 * MIN);
    const otherSession = { id: 'sess-other', agent_group_id: 'ag-test' } as Session;
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN);
    await escalateOverdueOccurrences(other.mailbox, otherSession, true, NOW + MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + TASK_OVERDUE_ATTEMPT_MIN_GAP_MS - 1);
    expect(notify.calls).toHaveLength(1);

    // Past the gap: still owing, so it alerts — and, delivered, never again.
    await escalateOverdueOccurrences(mailbox, session, true, NOW + TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 2 * TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-wedged', 'task-wedged']);
  });

  it('spaces a burst: one attempt per gap, the rest stay owing', async () => {
    const a = makeSession();
    const b = makeSession();
    seed(a.inDb, 'task-a', 90 * MIN);
    seed(b.inDb, 'task-b', 90 * MIN);
    const sessionB = { id: 'sess-b', agent_group_id: 'ag-test' } as Session;

    await escalateOverdueOccurrences(a.mailbox, session, false, NOW);
    await escalateOverdueOccurrences(b.mailbox, sessionB, false, NOW);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-a']);

    await escalateOverdueOccurrences(b.mailbox, sessionB, false, NOW + TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-a', 'task-b']);
  });

  it('re-arms for the next occurrence of the same series', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-first', 90 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW);

    inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-first'").run();
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN);
    seed(inDb, 'task-second', 90 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 30 * MIN);

    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-first', 'task-second']);
  });

  it('restarts every 2 minutes leave no blind window: each process alerts on its first tick, at most once', async () => {
    const { inDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);

    // 2 minutes is shorter than both the attempt gap and the alert window, so
    // any gate keyed on how long THIS process has been watching would never
    // open. Each restart is a fresh process: its dedup set and attempt gap
    // start empty. Two ticks per process, a minute apart.
    const perProcess: number[] = [];
    for (let restart = 0; restart < 5; restart++) {
      _resetOverdueAlertsForTesting();
      const before = notify.calls.length;
      const startedAt = NOW + restart * 2 * MIN;
      await escalateOverdueOccurrences(mailbox, session, false, startedAt);
      expect(notify.calls.length - before, `process ${restart} did not alert on its first tick`).toBe(1);
      await escalateOverdueOccurrences(mailbox, session, false, startedAt + MIN);
      perProcess.push(notify.calls.length - before);
    }

    expect(perProcess).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(notify.calls.map(([, c]) => c.occurrenceId))).toEqual(new Set(['task-wedged']));
  });

  it('after a long outage, at most one DM goes out before the woken rows are claimed', async () => {
    // Six hours down: every scheduled session comes back to a row six hours late.
    const sessions = ['a', 'b', 'c', 'd'].map((name) => {
      const made = makeSession();
      seed(made.inDb, `task-${name}`, 6 * 60 * MIN);
      return { ...made, session: { id: `sess-${name}`, agent_group_id: 'ag-test' } as Session, rowId: `task-${name}` };
    });

    // The new process's first tick over every session.
    for (const s of sessions) await escalateOverdueOccurrences(s.mailbox, s.session, false, NOW);
    expect(notify.calls).toHaveLength(1);

    // Its wakes land and each container claims its row before the gap passes.
    for (const s of sessions) {
      s.outDb.prepare("INSERT INTO processing_ack VALUES (?, 'processing', ?)").run(s.rowId, ago(0));
    }
    for (let tick = 1; tick <= 10; tick++) {
      for (const s of sessions) {
        await escalateOverdueOccurrences(s.mailbox, s.session, true, NOW + tick * TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
      }
    }

    expect(notify.calls).toHaveLength(1);
  });
});

describe('results that have not reached the gate lane', () => {
  const HOST_GATED = { prompt: 'watch', script: 'check.sh', scriptHost: true };

  /** A container gate row for `occurrenceId`, written `writtenAgoMs` ago and not yet recorded. */
  function writeGateRow(outDb: Database.Database, id: string, occurrenceId: string, writtenAgoMs: number) {
    outDb
      .prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'task_log', ?)`)
      .run(
        id,
        (seq += 2) + 1,
        ago(writtenAgoMs),
        JSON.stringify({ gate: { occurrenceId, wakeAgent: false, observation: { kind: 'empty' } } }),
      );
  }

  it('reports a gate row delivery has not recorded for an hour, once, and retries a failed DM after the gap', async () => {
    const { inDb, outDb, mailbox } = makeSession();
    seed(inDb, 'task-ran', 2 * 60 * MIN, { status: 'completed' });
    writeGateRow(outDb, 'gate-stuck', 'task-ran', 59 * MIN);
    await escalateOverdueOccurrences(mailbox, session, true, NOW);
    expect(notify.calls).toEqual([]);

    notify.delivered = false;
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN);
    notify.delivered = true;
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN + TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    await escalateOverdueOccurrences(mailbox, session, true, NOW + MIN + 2 * TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);

    expect(notify.calls).toHaveLength(2);
    const [text, context] = notify.calls[1]!;
    expect(context).toMatchObject({ source: 'task-gate-unrecorded', seriesId: 'series-a', occurrenceId: 'task-ran' });
    expect(text).toContain('*Scheduled check result not recorded:* `series-a`');
    expect(text).toContain('occurrence `task-ran`');
    expect(text).toContain('(65 min ago)');
    expect(text).toContain('every later message from session `sess-test` is held behind it');
  });

  it('stays quiet once delivery has recorded the row, and for task_log rows that are not gate rows', async () => {
    const { inDb, outDb, mailbox } = makeSession();
    seed(inDb, 'task-ran', 2 * 60 * MIN, { status: 'completed' });
    writeGateRow(outDb, 'gate-recorded', 'task-ran', 90 * MIN);
    inDb
      .prepare("INSERT INTO delivered (message_out_id, status, delivered_at) VALUES ('gate-recorded', 'delivered', ?)")
      .run(ago(80 * MIN));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('turn-summary', 9001, ?, 'task_log', ?)`,
      )
      .run(ago(90 * MIN), JSON.stringify({ auto: true, summary: 'done' }));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('not-json', 9003, ?, 'task_log', 'x')`,
      )
      .run(ago(90 * MIN));

    await escalateOverdueOccurrences(mailbox, session, true, NOW);

    expect(notify.calls).toEqual([]);
  });

  it('reports a host-gated occurrence still unadmitted with no recorded result an hour past due', async () => {
    const { inDb, mailbox } = makeSession(false);
    seed(inDb, 'task-withheld', 61 * MIN, { trigger: 0, content: HOST_GATED });
    // Not withheld: a recorded wake waiting for admission (its output may be JSON null),
    // a host-gated row not yet an hour late, and an ordinary unadmitted task.
    seed(inDb, 'task-recorded-wake', 90 * MIN, { trigger: 0, content: { ...HOST_GATED, scriptOutput: null } });
    seed(inDb, 'task-recent', 59 * MIN, { trigger: 0, content: HOST_GATED });
    seed(inDb, 'task-container', 90 * MIN, { trigger: 0, content: { prompt: 'x', script: 'check.sh' } });

    await escalateOverdueOccurrences(mailbox, session, false, NOW);

    expect(notify.calls).toHaveLength(1);
    const [text, context] = notify.calls[0]!;
    expect(context).toMatchObject({
      source: 'task-gate-withheld',
      seriesId: 'series-a',
      occurrenceId: 'task-withheld',
    });
    expect(text).toContain('Occurrence `task-withheld` has been due since');
    expect(text).toContain('(61 min)');
    expect(text).toContain('no recorded result');

    // Past the gap the late row has crossed its hour too; the first is not repeated.
    await escalateOverdueOccurrences(mailbox, session, false, NOW + TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    await escalateOverdueOccurrences(mailbox, session, false, NOW + 2 * TASK_OVERDUE_ATTEMPT_MIN_GAP_MS);
    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-withheld', 'task-recent']);
  });

  it("shares the overdue alarm's attempt gap and dedup, and keys a withheld occurrence apart from an unclaimed one", async () => {
    const { inDb, outDb, mailbox } = makeSession();
    seed(inDb, 'task-unclaimed', 90 * MIN);
    seed(inDb, 'task-withheld', 90 * MIN, { trigger: 0, content: HOST_GATED });
    writeGateRow(outDb, 'gate-stuck', 'task-unclaimed', 90 * MIN);

    const gap = TASK_OVERDUE_ATTEMPT_MIN_GAP_MS;
    for (let tick = 0; tick < 5; tick++) {
      await escalateOverdueOccurrences(mailbox, session, true, NOW + tick * gap);
      await escalateOverdueOccurrences(mailbox, session, true, NOW + tick * gap + MIN);
    }
    expect(notify.calls.map(([, c]) => c.source)).toEqual([
      'task-overdue',
      'task-gate-withheld',
      'task-gate-unrecorded',
    ]);

    // Admitted at last, then left unclaimed: a different stuck state, so it alerts again.
    inDb.prepare("UPDATE messages_in SET trigger = 1 WHERE id = 'task-withheld'").run();
    await escalateOverdueOccurrences(mailbox, session, true, NOW + 5 * gap);
    expect(notify.calls.at(-1)![1]).toMatchObject({ source: 'task-overdue', occurrenceId: 'task-withheld' });
  });

  it('a failing stuck-result read does not silence the unclaimed-occurrence alarm', async () => {
    const { inDb, outDb, mailbox } = makeSession();
    seed(inDb, 'task-wedged', 90 * MIN);
    outDb.exec('DROP TABLE messages_out');

    await escalateOverdueOccurrences(mailbox, session, true, NOW);

    expect(notify.calls.map(([, c]) => c.occurrenceId)).toEqual(['task-wedged']);
  });
});
