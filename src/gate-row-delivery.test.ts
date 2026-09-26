/**
 * Container gate rows reach the gate lane through delivery: recorded in `seq`
 * order, retried in place on a recording failure and never given up, and
 * never answering the occurrence they describe.
 *
 * Runs on a central DB FILE so a recording failure can be injected the way a
 * broken DB produces one (the table is gone) with the real writer in the path.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-gate-row-delivery') }));
const DB_PATH = `${TEST_DIR}/v2.db`;

// A complete stub: log.ts installs process-wide handlers at module scope.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: logSpy,
  isSurvivableIoError: vi.fn(() => false),
}));

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

import { closeDb, createAgentGroup, createMessagingGroup, initDb, runMigrations } from './db/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { completeAnsweredPendingRows } from './modules/mailbox/ops/sweep.js';
import { resolveSession, resolveTaskSession } from './session-manager.js';
import type { Session } from './types.js';

const adapterCalls: string[] = [];

function now(): string {
  return new Date().toISOString();
}

async function seedGroup(): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Watcher', folder: 'watcher', agent_provider: null, created_at: now() });
}

async function taskSession(series = 'series-1'): Promise<Session> {
  await seedGroup();
  return (await resolveTaskSession('ag-1', series)).session;
}

function withFile<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function insertOccurrence(session: Session, id: string, series: string, trigger = 0): void {
  withFile(inboundDbPath('ag-1', session.id), (db) =>
    db
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, series_id, trigger, content)
         VALUES (?, ?, 'task', ?, 'pending', ?, ?, ?, '{}')`,
      )
      .run(
        id,
        2 + (db.prepare('SELECT COUNT(*) FROM messages_in').pluck().get() as number) * 2,
        now(),
        now(),
        series,
        trigger,
      ),
  );
}

/** A gate row exactly as the runner writes it, with the seq and timestamp under test control. */
function insertGateRow(
  session: Session,
  id: string,
  seq: number,
  timestamp: string,
  gate: Record<string, unknown>,
): void {
  withFile(outboundDbPath('ag-1', session.id), (db) =>
    db
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content, in_reply_to)
         VALUES (?, ?, ?, 'task_log', ?, NULL)`,
      )
      .run(id, seq, timestamp, JSON.stringify({ gate })),
  );
}

function insertWorkLog(session: Session, id: string, seq: number, timestamp: string): void {
  withFile(outboundDbPath('ag-1', session.id), (db) =>
    db
      .prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'work_log', '{}')`)
      .run(id, seq, timestamp),
  );
}

const EMPTY = { kind: 'empty', evidence: 'nothing new', bound: '1h' };
const UNREADABLE = { kind: 'unreadable', evidence: 'api 502', bound: '90m' };

function ledger(): Array<{ series_id: string; outbound_id: string; observation: string; outcome: string }> {
  return withFile(
    DB_PATH,
    (db) =>
      db
        .prepare(
          "SELECT series_id, outbound_id, observation, outcome FROM task_run_outcomes WHERE source = 'gate' ORDER BY id",
        )
        .all() as Array<{ series_id: string; outbound_id: string; observation: string; outcome: string }>,
  );
}

function delivered(session: Session): string[] {
  return withFile(inboundDbPath('ag-1', session.id), (db) =>
    (db.prepare("SELECT message_out_id FROM delivered WHERE status = 'delivered'").pluck().all() as string[]).sort(),
  );
}

function attemptRows(): number {
  return withFile(DB_PATH, (db) => db.prepare('SELECT COUNT(*) FROM delivery_attempts').pluck().get() as number);
}

function renameLedger(from: string, to: string): void {
  withFile(DB_PATH, (db) => db.exec(`ALTER TABLE ${from} RENAME TO ${to}`));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  withFile(DB_PATH, (db) => runMigrations(db));
  await initDb(DB_PATH);
  adapterCalls.length = 0;
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      adapterCalls.push(content);
      return 'plat-1';
    },
  });
  for (const spy of Object.values(logSpy)) spy.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('container gate rows in delivery', () => {
  it('records the result under the occurrence, marks the row delivered, and sends nothing', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    insertGateRow(session, 'gate-a', 3, now(), { occurrenceId: 'occ-1', wakeAgent: false, observation: UNREADABLE });

    expect(await deliverSessionMessages(session)).toBe('clean');

    expect(ledger()).toEqual([
      { series_id: 'series-1', outbound_id: 'gate:occ-1', observation: 'unreadable', outcome: 'failed' },
    ]);
    expect(delivered(session)).toEqual(['gate-a']);
    expect(adapterCalls).toEqual([]);
    expect(fs.existsSync(`${TEST_DIR}/groups/watcher/tasks/series-1.md`)).toBe(false);
  });

  it('a null in_reply_to leaves an admitted, unacked occurrence pending for its own ack', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-admitted', 'series-1', 1);
    insertGateRow(session, 'gate-a', 3, now(), { occurrenceId: 'occ-admitted', wakeAgent: false, observation: EMPTY });
    await deliverSessionMessages(session);

    const inbound = new Database(inboundDbPath('ag-1', session.id));
    const outbound = new Database(outboundDbPath('ag-1', session.id));
    try {
      expect(completeAnsweredPendingRows(inbound, outbound)).toEqual([]);
      expect(inbound.prepare("SELECT status FROM messages_in WHERE id = 'occ-admitted'").get()).toEqual({
        status: 'pending',
      });
      // Control: the same row naming the occurrence WOULD complete it.
      outbound.prepare("UPDATE messages_out SET in_reply_to = 'occ-admitted' WHERE id = 'gate-a'").run();
      expect(completeAnsweredPendingRows(inbound, outbound)).toEqual(['occ-admitted']);
    } finally {
      inbound.close();
      outbound.close();
    }
  });

  it('a crash between the gate row and the ack: the second execution is the one on record', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    insertGateRow(session, 'gate-first', 3, now(), { occurrenceId: 'occ-1', wakeAgent: false, observation: EMPTY });
    insertGateRow(session, 'gate-rerun', 5, now(), {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      observation: UNREADABLE,
    });

    await deliverSessionMessages(session);

    expect(ledger()).toEqual([
      { series_id: 'series-1', outbound_id: 'gate:occ-1', observation: 'unreadable', outcome: 'failed' },
    ]);
  });

  it.each([
    ['reversed', '2026-09-26T10:00:05.000Z', '2026-09-26T10:00:00.000Z'],
    ['equal', '2026-09-26T10:00:00.000Z', '2026-09-26T10:00:00.000Z'],
  ])('%s timestamps still record the later seq last', async (_shape, firstTs, secondTs) => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    // Inserted newest-seq first so neither insertion order nor rowid can pass for seq order.
    insertGateRow(session, 'gate-z-later', 7, secondTs, {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      observation: UNREADABLE,
    });
    insertGateRow(session, 'gate-a-earlier', 5, firstTs, {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      observation: EMPTY,
    });

    await deliverSessionMessages(session);

    expect(ledger().map((r) => r.observation)).toEqual(['unreadable']);
  });

  it('holds back a row written after a failing gate row even when its timestamp sorts it first', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    insertWorkLog(session, 'written-before', 3, '2026-09-26T09:59:59.000Z');
    insertGateRow(session, 'gate-a', 5, '2026-09-26T10:00:05.000Z', {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      observation: UNREADABLE,
    });
    // The clock stepped back: written after the gate row, stamped before it.
    insertWorkLog(session, 'written-after', 7, '2026-09-26T10:00:00.000Z');
    renameLedger('task_run_outcomes', 'task_run_outcomes_unreachable');

    expect(await deliverSessionMessages(session)).toBe('error');
    expect(delivered(session)).toEqual(['written-before']);

    renameLedger('task_run_outcomes_unreachable', 'task_run_outcomes');
    expect(await deliverSessionMessages(session)).toBe('clean');
    expect(delivered(session)).toEqual(['gate-a', 'written-after', 'written-before']);
  });

  it('a recording failure is retried in place: five failures, never given up, order kept, then recorded', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    insertGateRow(session, 'gate-a', 3, '2026-09-26T10:00:00.000Z', {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      observation: UNREADABLE,
    });
    insertWorkLog(session, 'behind-gate', 5, '2026-09-26T10:00:01.000Z');
    renameLedger('task_run_outcomes', 'task_run_outcomes_unreachable');

    for (let i = 0; i < 5; i += 1) expect(await deliverSessionMessages(session)).toBe('error');

    expect(delivered(session)).toEqual([]); // neither given up nor overtaken
    expect(attemptRows()).toBe(0); // no attempt cap was ever charged
    expect(logSpy.error.mock.calls.filter((c) => c[0] === 'Message delivery failed permanently, giving up')).toEqual(
      [],
    );

    renameLedger('task_run_outcomes_unreachable', 'task_run_outcomes');
    expect(await deliverSessionMessages(session)).toBe('clean');

    expect(ledger().map((r) => r.outbound_id)).toEqual(['gate:occ-1']);
    expect(delivered(session)).toEqual(['behind-gate', 'gate-a']);
  });

  it('records a script failure with the reason the runner carried', async () => {
    const session = await taskSession();
    insertOccurrence(session, 'occ-1', 'series-1');
    insertGateRow(session, 'gate-a', 3, now(), {
      occurrenceId: 'occ-1',
      wakeAgent: false,
      error: 'timed out after 120000ms and was killed',
    });

    await deliverSessionMessages(session);

    const detail = withFile(DB_PATH, (db) => db.prepare('SELECT detail FROM task_run_outcomes').pluck().get());
    expect(detail).toBe('timed out after 120000ms and was killed');
    expect(ledger()[0]).toMatchObject({ observation: 'error', outcome: 'failed' });
  });

  it('takes the series from the occurrence row, not from anything the container claims', async () => {
    await seedGroup();
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      name: 'Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOccurrence(session, 'occ-chan', 'channel-series');
    insertGateRow(session, 'gate-a', 3, now(), {
      occurrenceId: 'occ-chan',
      seriesId: 'someone-elses-series',
      wakeAgent: false,
      observation: EMPTY,
    });

    await deliverSessionMessages(session);

    expect(ledger().map((r) => r.series_id)).toEqual(['channel-series']);
  });

  it('drops a gate row that names no occurrence, instead of blocking the session forever', async () => {
    const session = await taskSession();
    insertGateRow(session, 'gate-bad', 3, now(), { wakeAgent: false, observation: EMPTY });
    insertWorkLog(session, 'behind-bad', 5, now());

    expect(await deliverSessionMessages(session)).toBe('clean');

    expect(ledger()).toEqual([]);
    expect(delivered(session)).toEqual(['behind-bad', 'gate-bad']);
    expect(logSpy.error.mock.calls.map((c) => c[0])).toContain(
      'Gate row names no occurrence of this session — dropped unrecorded',
    );
  });
});
