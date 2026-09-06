import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { SIGNAL_SCHEMA } from '../../db/migrations/072-observatory-signal.js';
import type { AuthedRequestContext } from '../router.js';
import type { ThreadSummary } from '../api/threads.js';
import { buildSignalData, releaseDecision, type SourceDecision } from './sources.js';
import { resolveDestination, prepareDestination } from './destination.js';
import { readRecord } from './state.js';

const ctx = {
  user: { id: 'operator' },
  scopes: { role: 'admin_of_group', allowed_group_ids: ['a'], no_filter: false },
} as AuthedRequestContext;
const canSend = vi.fn(async () => ({ ok: true as const }));

beforeEach(async () => {
  await initTestDb();
  canSend.mockClear();
  await getDb().exec(`
    CREATE TABLE workgroups(id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE agent_groups(id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
    CREATE TABLE sessions(id TEXT, agent_group_id TEXT, thread_id TEXT, messaging_group_id TEXT);
    CREATE TABLE tasks(task_id TEXT, child_session_id TEXT, surface_mode TEXT);
    CREATE TABLE messaging_groups(id TEXT, platform_id TEXT, name TEXT, channel_type TEXT);
    CREATE TABLE messaging_group_agents(agent_group_id TEXT, messaging_group_id TEXT, priority INTEGER);
    CREATE TABLE pending_approvals(approval_id TEXT, agent_group_id TEXT, session_id TEXT, title TEXT,
      action TEXT, created_at TEXT, expires_at TEXT, approver_user_id TEXT, channel_type TEXT,
      platform_id TEXT, platform_message_id TEXT, status TEXT);
    INSERT INTO workgroups VALUES('w','Workspace'),('other','Other');
    INSERT INTO agent_groups VALUES('a','A','a','w'),('hidden','Hidden','hidden','w'),('foreign','Foreign','foreign','other');
    INSERT INTO sessions VALUES('child','a','spawn-0123456789abcdef',NULL);
    INSERT INTO tasks VALUES('spawn-0123456789abcdef','child','headless');
    INSERT INTO messaging_groups VALUES('m','slack:C','Room','slack'),('m2','slack:C','Room sibling','slack-sibling');
    INSERT INTO messaging_group_agents VALUES('a','m',0),('a','m2',0);
  `);
  await getDb().exec(SIGNAL_SCHEMA);
});
afterEach(closeDb);

function question(threadId = 'spawn-0123456789abcdef', sessionId = 'child'): SourceDecision {
  return {
    ...releaseDecision(
      'w',
      { id: 'q', kind: 'task', title: 'Which option?', nextMover: 'human' },
      '2026-09-06T00:00:00Z',
    ),
    source_kind: 'thread-question',
    source_id: JSON.stringify([sessionId, 'task_needs_input', 1]),
    agent_group_id: 'a',
    thread_id: threadId,
  };
}

it('keeps a headless spawned task bound to its authoritative child session', async () => {
  const source = question();
  const destination = await resolveDestination(source, ctx, canSend);
  expect(destination.error).toBeNull();
  expect(destination.candidates).toHaveLength(1);
  expect(destination.candidates[0]?.session_id).toBe('child');
  expect(destination.default_reason).toBe('origin');
  expect(destination.session_thread_id).toBe(source.thread_id);
  const record = readRecord(undefined);
  record.dispatch = {
    key: 'delivery',
    user_id: 'operator',
    agent_group_id: 'a',
    session_id: destination.candidates[0]!.session_id!,
    thread_id: source.thread_id!,
    text: 'Use option two',
    state: 'pending',
    error: null,
  };
  const session = vi.fn();
  expect((await prepareDestination(source, record, { session }))?.session_id).toBe('child');
  expect(session).not.toHaveBeenCalled();
});

it('does not infer a headless origin from its prefix or a mismatched task relation', async () => {
  await getDb().run("UPDATE tasks SET task_id='different'");
  expect((await resolveDestination(question(), ctx, canSend)).candidates).toEqual([]);
  await getDb().run('DELETE FROM tasks');
  expect((await resolveDestination(question(), ctx, canSend)).candidates).toEqual([]);
});

it('does not expose a headless child outside group scope or steer authority', async () => {
  const restricted = { ...ctx, scopes: { ...ctx.scopes, allowed_group_ids: ['hidden'] } };
  expect((await resolveDestination(question(), restricted, canSend)).candidates).toEqual([]);
  expect(canSend).not.toHaveBeenCalled();
  expect(
    (await resolveDestination(question(), ctx, async () => ({ ok: false, reason: 'forbidden' }))).candidates,
  ).toEqual([]);
  expect((await resolveDestination({ ...question(), workgroup_id: 'other' }, ctx, canSend)).candidates).toEqual([]);
});

async function collapsedQuestion(target = 'older-asking') {
  const thread = {
    thread_id: 'slack:C:1',
    session_ids: ['newer', target],
    participants: [{ agent_group_id: 'a', session_id: 'newer', name: 'A' }],
    reply_target_session_id: target,
    state: 'needs_you',
    needs_you_reason: { cause: 'ask_question', text: 'Waiting for an answer' },
    title: 'Thread',
    channel_key: 'slack:C',
    channel_name: 'Room',
    last_activity_at: '2026-09-06T00:00:00Z',
  } as ThreadSummary;
  const readQuestion = vi.fn((_group: string, session: string) => ({
    seq: 17,
    text: `Question from ${session}`,
    timestamp: '2026-09-06T00:00:00Z',
  }));
  const data = await buildSignalData(ctx, 'w', {
    scene: async () => ({
      workgroupId: 'w',
      asOf: '2026-09-06T00:00:00Z',
      rooms: [],
      agents: [],
      claims: [],
      releaseState: null,
    }),
    threads: async () => [thread],
    question: readQuestion,
  });
  return { data, readQuestion };
}

it('reads and delivers to the exact asking session when display participants collapse same-agent sessions', async () => {
  await getDb().exec("INSERT INTO sessions VALUES('newer','a','slack:C:1','m'),('older-asking','a','slack:C:1','m2')");
  const { data, readQuestion } = await collapsedQuestion();
  expect(readQuestion).toHaveBeenCalledWith('a', 'older-asking');
  const source = data.rawDecisions[0]!;
  expect(JSON.parse(source.source_id)[0]).toBe('older-asking');
  expect(source.question).toBe('Question from older-asking');
  const destination = await resolveDestination(source, ctx, canSend);
  expect(destination.candidates[0]?.session_id).toBe('older-asking');
  expect(destination.candidates[0]?.messaging_group_id).toBe('m2');
  expect(destination.candidates[0]?.channel_type).toBe('slack-sibling');
});

it.each([
  ['hidden', 'w', 'slack:C:1'],
  ['foreign', 'other', 'slack:C:1'],
  ['a', 'w', 'slack:C:elsewhere'],
])('rejects an exact target outside the visible thread (%s, %s, %s)', async (agent, _workgroup, thread) => {
  await getDb().run("INSERT INTO sessions VALUES('older-asking',?,?,NULL)", agent, thread);
  const { data, readQuestion } = await collapsedQuestion();
  expect(data.rawDecisions).toEqual([]);
  expect(readQuestion).not.toHaveBeenCalled();
});

it('dispatch API reserves and sends a headless answer to the child without opening a platform thread', async () => {
  const { reviewDecision, dispatchDecision } = await import('./api.js');
  const send = vi.fn(async () => ({ status: 202 as const, body: {} }));
  const session = vi.fn();
  const adapter = vi.fn();
  const deps = {
    scene: async () => ({
      workgroupId: 'w',
      asOf: '2026-09-06T00:00:00Z',
      rooms: [],
      agents: [],
      claims: [],
      releaseState: null,
    }),
    threads: async () => [
      {
        thread_id: 'spawn-0123456789abcdef',
        session_ids: ['child'],
        participants: [{ agent_group_id: 'a', session_id: 'child', name: 'A' }],
        reply_target_session_id: 'child',
        state: 'needs_you',
        needs_you_reason: { cause: 'task_needs_input', text: 'Which option?' },
        title: 'Headless task',
        channel_key: 'unknown',
        channel_name: 'Unrouted',
        last_activity_at: '2026-09-06T00:00:00Z',
      } as ThreadSummary,
    ],
    canSend,
    send,
    session,
    adapter,
  };
  const source = (await buildSignalData(ctx, 'w', deps)).rawDecisions[0]!;
  const answer = await reviewDecision(
    source.id,
    {
      expected_version: 0,
      evidence_hash: source.evidence_hash,
      action: 'answer',
      text: 'Use option two',
      idempotency_key: 'answer',
    },
    ctx,
    deps,
  );
  const sent = await dispatchDecision(
    source.id,
    {
      expected_version: answer.version,
      evidence_hash: source.evidence_hash,
      agent_group_id: 'a',
    },
    ctx,
    deps,
  );
  expect(sent.dispatch_state).toBe('sent');
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'child',
    expect.objectContaining({ text: expect.stringContaining('Use option two') }),
    ctx,
  );
  expect(session).not.toHaveBeenCalled();
  expect(adapter).not.toHaveBeenCalled();
});
