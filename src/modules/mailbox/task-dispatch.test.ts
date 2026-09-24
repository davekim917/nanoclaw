import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { migrateMessagesInTable } from './schema.js';
import { dispatchTaskEvent as dispatchEvent, type TaskDispatchInput } from './ops/task-dispatch.js';
import { readTaskSettlement } from './ops/task-settlement.js';
import { taskThreadId } from '../../db/sessions.js';

describe('keyed task admission and settlement', () => {
  let inbound: Database.Database;
  let outbound: Database.Database;
  const dispatchTaskEvent = (db: Database.Database, request: TaskDispatchInput) => dispatchEvent(db, request, outbound);
  const input: TaskDispatchInput = {
    contextKey: 'campaign/42/intake',
    eventKey: 'initial',
    prompt: 'Read the durable current brief.',
    originSessionId: null,
    platformId: null,
    channelType: null,
    threadId: null,
    muteChat: true,
    quietStatus: true,
  };
  beforeEach(() => {
    inbound = new Database(':memory:');
    inbound.exec(INBOUND_SCHEMA);
    migrateMessagesInTable(inbound);
    outbound = new Database(':memory:');
    outbound.exec(OUTBOUND_SCHEMA);
    outbound.exec(
      "ALTER TABLE container_state ADD COLUMN provider_executing INTEGER; INSERT INTO container_state(id, updated_at, provider_executing) VALUES(1, '2026-09-22T00:00:00.000Z', 0)",
    );
  });
  afterEach(() => {
    inbound.close();
    outbound.close();
  });
  function complete(id: string, extra: Record<string, unknown> = {}) {
    inbound.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(id);
    outbound
      .prepare(
        "INSERT INTO messages_out(id,seq,kind,timestamp,in_reply_to,content) VALUES('outcome',1,'task_log',?,?,?)",
      )
      .run(new Date().toISOString(), id, JSON.stringify({ auto: true, taskMessageIds: [id], ...extra }));
  }
  it('replays a committed admission after response loss without changing sequence or due time', () => {
    const first = dispatchTaskEvent(inbound, input);
    const original = inbound.prepare('SELECT * FROM messages_in').get();
    expect(dispatchTaskEvent(inbound, input)).toEqual({ ...first, admission: 'replay' });
    expect(inbound.prepare('SELECT * FROM messages_in').all()).toEqual([original]);
    expect(original).toMatchObject({ trigger: 0, recurrence: null });
    expect(JSON.parse((original as { content: string }).content).flagIntent).toBeUndefined();
  });
  it('rejects changed content or route and retains the original event', () => {
    dispatchTaskEvent(inbound, input);
    for (const change of [
      { prompt: 'Different assignment' },
      { platformId: 'other' },
      { muteChat: false },
      { originSessionId: 'other' },
    ]) {
      expect(() => dispatchTaskEvent(inbound, { ...input, ...change })).toThrow('collision');
    }
    expect(inbound.prepare('SELECT COUNT(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
    expect(() =>
      dispatchTaskEvent(inbound, { ...input, eventKey: 'different-event', threadId: 'different-route' }),
    ).toThrow('context collision');
  });
  it.each(['', 'bad\n', 'x'.repeat(201), '../ space', 'ümlaut'])(
    'rejects invalid identity %j before writing',
    (key) => {
      expect(() => dispatchTaskEvent(inbound, { ...input, contextKey: key })).toThrow();
      expect(inbound.prepare('SELECT COUNT(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
    },
  );
  it.each(['pending', 'processing', 'paused', 'completed', 'cancelled'])('does not recover a %s event', (status) => {
    const first = dispatchTaskEvent(inbound, input);
    inbound.prepare('UPDATE messages_in SET status = ?').run(status);
    expect(() => dispatchTaskEvent(inbound, { ...input, eventKey: 'retry1', retryOf: 'initial' })).toThrow(
      'only failed or expired',
    );
    expect(dispatchTaskEvent(inbound, input).rowId).toBe(first.rowId);
  });
  it('bounds failed/expired recovery to two, with no branching and stable context', () => {
    const initial = dispatchTaskEvent(inbound, input);
    inbound.prepare("UPDATE messages_in SET status='failed'").run();
    const retry = dispatchTaskEvent(inbound, { ...input, eventKey: 'retry1', retryOf: 'initial' });
    expect(retry.seriesId).toBe(initial.seriesId);
    expect(retry.attempt).toBe(1);
    expect(() => dispatchTaskEvent(inbound, { ...input, eventKey: 'branch', retryOf: 'initial' })).toThrow(
      'already has',
    );
    inbound.prepare("UPDATE messages_in SET status='expired' WHERE id=?").run(retry.rowId);
    const final = dispatchTaskEvent(inbound, { ...input, eventKey: 'retry2', retryOf: 'retry1' });
    expect(final.attempt).toBe(2);
    inbound.prepare("UPDATE messages_in SET status='failed' WHERE id=?").run(final.rowId);
    expect(() => dispatchTaskEvent(inbound, { ...input, eventKey: 'retry3', retryOf: 'retry2' })).toThrow('limit');
  });
  it('settles only an exact successful automatic outcome plus quiet execution', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    const read = () => readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId));
    complete(rowId);
    expect(read().state).toBe('settled');
    outbound.prepare('UPDATE container_state SET provider_executing=1').run();
    expect(read().state).toBe('busy');
    outbound.prepare('UPDATE container_state SET provider_executing=0').run();
    outbound.prepare("INSERT INTO session_state VALUES('work_continuation','invalid',?)").run(new Date().toISOString());
    expect(read().state).toBe('busy');
  });
  it('recovers completed provider-error delivery only after the retained worker settles', () => {
    const { rowId } = dispatchTaskEvent(inbound, input);
    complete(rowId, { isError: true });
    const retry = { ...input, eventKey: 'recovery', retryOf: 'initial' };
    outbound.prepare('UPDATE container_state SET provider_executing=1').run();
    expect(() => dispatchTaskEvent(inbound, retry)).toThrow();
    outbound.prepare('UPDATE container_state SET provider_executing=0').run();
    expect(dispatchTaskEvent(inbound, retry)).toMatchObject({ admission: 'inserted', attempt: 1 });
  });
  it.each([{ auto: false, isError: true }, { taskMessageIds: ['unrelated'], isError: true }, { isError: false }])(
    'does not authorize recovery from unrelated/manual/success log %j',
    (extra) => {
      const { rowId } = dispatchTaskEvent(inbound, input);
      complete(rowId, extra);
      expect(() => dispatchTaskEvent(inbound, { ...input, eventKey: 'recovery', retryOf: 'initial' })).toThrow();
    },
  );
  it.each([{ auto: false }, { taskMessageIds: [] }, { taskMessageIds: ['other'] }, { isError: true }])(
    'never accepts manual, mismatched, or failed outcome %j',
    (extra) => {
      const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
      complete(rowId, extra);
      expect(readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId)).state).toBe('unknown');
    },
  );
  it('future waits, paused inputs and undelivered actions block phase advancement', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    complete(rowId);
    const read = () => readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId));
    inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,content,status,process_after) VALUES('future',4,'chat',?,'{}','pending','2099-01-01T00:00:00.000Z')",
      )
      .run(new Date().toISOString());
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE messages_in SET status='paused' WHERE id='future'").run();
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE messages_in SET status='cancelled' WHERE id='future'").run();
    outbound
      .prepare(
        "INSERT INTO messages_out(id,seq,kind,timestamp,content) VALUES('wait',3,'system',?,'{\"action\":\"schedule_wake\"}')",
      )
      .run(new Date().toISOString());
    expect(read().reason).toBe('outbound-action-outstanding');
    inbound
      .prepare("INSERT INTO delivered(message_out_id,status,delivered_at) VALUES('wait','delivered',?)")
      .run(new Date().toISOString());
    expect(read().state).toBe('settled');
    inbound.prepare("UPDATE delivered SET status='pending' WHERE message_out_id='wait'").run();
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE delivered SET status='failed' WHERE message_out_id='wait'").run();
    expect(read().state).toBe('settled'); // resolved denial is terminal, not a future obligation
    outbound
      .prepare("UPDATE messages_out SET content=? WHERE id='outcome'")
      .run(JSON.stringify({ auto: true, taskMessageIds: [rowId], isError: true }));
    expect(read().state).toBe('unknown'); // terminal action never turns a failed provider outcome into success
  });
  it('fails closed on missing execution metadata, outcomes or outbound store', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    complete(rowId);
    expect(readTaskSettlement(inbound, null, rowId, taskThreadId(seriesId)).state).toBe('unknown');
    outbound.prepare('DELETE FROM container_state').run();
    expect(readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId)).state).toBe('unknown');
  });
  it('legacy observer cutover excludes only its own future inert recurrence, never owned follow-ups', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    complete(rowId);
    inbound.prepare("UPDATE messages_in SET recurrence='15,45 * * * *' WHERE id=?").run(rowId);
    inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,content,status,process_after,recurrence,series_id,trigger) VALUES('poll',4,'task',?,'{}','pending','2099-01-01T00:00:00.000Z','15,45 * * * *',?,0)",
      )
      .run(new Date().toISOString(), seriesId);
    const read = () => readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId), true);
    expect(readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId)).state).toBe('busy');
    expect(read().state).toBe('settled');
    inbound.prepare("UPDATE messages_in SET trigger=1 WHERE id='poll'").run();
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE messages_in SET trigger=0,status='paused' WHERE id='poll'").run();
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE messages_in SET status='pending',recurrence=NULL,series_id=NULL WHERE id='poll'").run();
    expect(read().state).toBe('busy');
    inbound.prepare("UPDATE messages_in SET kind='chat' WHERE id='poll'").run();
    expect(read().state).toBe('busy');
  });
  it('future-inputs mode counts not-yet-due waits instead of blocking; everything else still blocks', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    complete(rowId);
    const insert = inbound.prepare(
      "INSERT INTO messages_in(id,seq,kind,timestamp,content,status,process_after) VALUES(?,?,?,?,'{}','pending',?)",
    );
    // A keyed deadline wake the observation turn armed for a different work item, plus its recall row.
    insert.run('wake', 4, 'chat', new Date().toISOString(), '2099-01-01T00:00:00.000Z');
    insert.run('recall-wake', 6, 'system', new Date().toISOString(), '2099-01-01T00:00:00.000Z');
    const strict = () => readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId));
    const read = () => readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId), false, true);
    expect(strict()).toMatchObject({ state: 'busy', reason: 'execution-or-input-outstanding' });
    expect(strict()).not.toHaveProperty('futureInputs');
    expect(read()).toMatchObject({ state: 'settled', executionSettled: true, futureInputs: 2 });
    // Due, undated, paused and processing inputs are current work, not future follow-ups.
    for (const [status, processAfter] of [
      ['pending', '2000-01-01T00:00:00.000Z'],
      ['pending', null],
      ['paused', '2099-01-01T00:00:00.000Z'],
      ['processing', '2099-01-01T00:00:00.000Z'],
    ] as const) {
      inbound.prepare("UPDATE messages_in SET status=?, process_after=? WHERE id='wake'").run(status, processAfter);
      expect(read().state, `${status} ${processAfter}`).toBe('busy');
    }
    inbound
      .prepare("UPDATE messages_in SET status='pending', process_after='2099-01-01T00:00:00.000Z' WHERE id='wake'")
      .run();
    outbound.prepare('UPDATE container_state SET provider_executing=1').run();
    expect(read().state).toBe('busy');
    outbound.prepare('UPDATE container_state SET provider_executing=0').run();
    outbound.prepare("INSERT INTO session_state VALUES('work_continuation','invalid',?)").run(new Date().toISOString());
    expect(read().state).toBe('busy');
    outbound.prepare("DELETE FROM session_state WHERE key='work_continuation'").run();
    outbound
      .prepare("UPDATE messages_out SET content=? WHERE id='outcome'")
      .run(JSON.stringify({ auto: true, taskMessageIds: [rowId], isError: true }));
    expect(read().state).toBe('unknown'); // setting future inputs aside never turns a failed outcome into success
  });
  it('legacy observer plus future-inputs settles the cutover shape: own inert poll and a later deadline wake', () => {
    const { rowId, seriesId } = dispatchTaskEvent(inbound, input);
    complete(rowId);
    inbound.prepare("UPDATE messages_in SET recurrence='15,45 * * * *' WHERE id=?").run(rowId);
    inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,content,status,process_after,recurrence,series_id,trigger) VALUES('poll',4,'task',?,'{}','pending','2099-01-01T00:00:00.000Z','15,45 * * * *',?,0)",
      )
      .run(new Date().toISOString(), seriesId);
    inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,content,status,process_after) VALUES('wake',6,'chat',?,'{}','pending','2099-01-01T00:00:00.000Z')",
      )
      .run(new Date().toISOString());
    const at = (observer: boolean, future: boolean) =>
      readTaskSettlement(inbound, outbound, rowId, taskThreadId(seriesId), observer, future);
    expect(at(true, false)).toMatchObject({ state: 'busy', executionSettled: false });
    expect(at(true, true)).toMatchObject({ state: 'settled', executionSettled: true, futureInputs: 2 });
  });
});
