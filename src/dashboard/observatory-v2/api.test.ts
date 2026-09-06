import * as scheduleAssembly from '../api/scheduled-assembly.js';
import { getScheduledCache } from '../api/scheduled-shared.js';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { SIGNAL_SCHEMA } from '../../db/migrations/072-observatory-signal.js';
import {
  buildSignalData,
  releaseDecision,
  readSignalRelease,
  pendingQuestionFromRows,
  type SourceDeps,
} from './sources.js';
import { decisionDetail, reviewDecision, dispatchDecision, updateProject, signalOverviewHandler, type ApiDeps } from './api.js';
import type { AuthedRequestContext } from '../router.js';
import type { ObservatoryScene, ReleaseStateItem } from '../api/observatory.js';
import type { ThreadSummary } from '../api/threads.js';
import { readReview, readRecord } from './state.js';
import * as signalSources from './sources.js';

const item: ReleaseStateItem = {
  id: 'decision-1',
  kind: 'decision',
  title: 'Should this be editable?',
  why: 'Current policy blocks editing.',
  nextAction: 'Choose the intended policy.',
  owner: 'Reviewer Two or Reviewer One',
  nextMover: 'human',
  url: 'https://github.com/acme/widget/issues/12',
  channel: '#dispatch',
};
function ctx(id = 'd', role: AuthedRequestContext['scopes']['role'] = 'owner', groups = ['a']): AuthedRequestContext {
  return {
    user: {
      id,
      kind: 'dashboard',
      display_name: id === 'd' ? 'Reviewer One' : 'Reviewer Two',
      created_at: new Date().toISOString(),
    },
    scopes: { role, allowed_group_ids: groups, no_filter: role === 'owner' },
    rawNodeReq: {} as http.IncomingMessage,
  };
}
function scene(items: ReleaseStateItem[] = [item]): ObservatoryScene {
  return {
    workgroupId: 'w',
    asOf: '2026-09-05T00:00:00Z',
    rooms: [
      {
        key: 'slack:C',
        name: 'dispatch',
        platform: 'slack',
        memberAgentIds: ['a', 'b'],
        lastActivityAt: null,
        permalink: null,
      },
    ],
    agents: [
      {
        id: 'a',
        name: 'Agent A',
        canonicalName: 'A',
        folder: 'a',
        provider: 'codex',
        avatarUrl: null,
        awake: false,
        active: false,
        location: null,
        lastSeenAt: null,
        lastSessionId: null,
        holding: [],
        nextTask: null,
        liveSession: null,
      },
      {
        id: 'b',
        name: 'Hidden agent',
        canonicalName: 'B',
        folder: 'b',
        provider: 'claude',
        avatarUrl: null,
        awake: false,
        active: false,
        location: null,
        lastSeenAt: null,
        lastSessionId: null,
        holding: [],
        nextTask: null,
        liveSession: null,
      },
    ],
    claims: [],
    releaseState: { asOf: '2026-09-05T00:00:00Z', items },
  };
}
function deps(items: ReleaseStateItem[] = [item]): ApiDeps {
  return { scene: async () => scene(items), threads: async () => [], now: Date.parse('2026-09-05T00:30:00Z') };
}
async function setup() {
  await initTestDb();
  await getDb().exec(`
 CREATE TABLE workgroups(id TEXT PRIMARY KEY,display_name TEXT,attention_sources TEXT);
 CREATE TABLE agent_groups(id TEXT PRIMARY KEY,workgroup_id TEXT,name TEXT);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,agent_group_id TEXT);
 CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT);
 CREATE TABLE observatory_item_threads(workgroup_id TEXT,item_id TEXT,thread_id TEXT,created_at TEXT,created_by TEXT);
 CREATE TABLE pending_approvals(approval_id TEXT PRIMARY KEY,agent_group_id TEXT,session_id TEXT,title TEXT,action TEXT,created_at TEXT,expires_at TEXT,approver_user_id TEXT,channel_type TEXT,platform_id TEXT,platform_message_id TEXT,status TEXT);
 CREATE TABLE messaging_groups(id TEXT PRIMARY KEY,platform_id TEXT,name TEXT);
 CREATE TABLE messaging_group_agents(messaging_group_id TEXT,agent_group_id TEXT);
 CREATE TABLE user_dms(user_id TEXT,channel_type TEXT,messaging_group_id TEXT,resolved_at TEXT);
 INSERT INTO workgroups(id,display_name) VALUES('w','Workspace'),('other','Other');
 INSERT INTO agent_groups VALUES('a','w','A'),('b','w','B'),('c','other','C');
 INSERT INTO messaging_groups(id,platform_id) VALUES('m','slack:C');
 INSERT INTO messaging_group_agents VALUES('m','a');
 `);
  await getDb().exec(SIGNAL_SCHEMA);
}
beforeEach(setup);
afterEach(closeDb);
describe('Signal source and authority boundaries', () => {
  it('includes non-PR decisions and only scoped agents; member cannot mutate', async () => {
    const member = ctx('j', 'member', ['a']);
    const data = await buildSignalData(member, 'w', deps());
    expect(data.decisions).toHaveLength(1);
    expect(data.agents.map((a) => a.id)).toEqual(['a']);
    expect(data.decisions[0]!.context).toBe(item.why);
    expect(data.decisions[0]!.capabilities.answer).toBe(false);
    await expect(
      reviewDecision(
        data.decisions[0]!.id,
        { expected_version: 0, evidence_hash: data.decisions[0]!.evidence_hash, action: 'claim', idempotency_key: 'k' },
        member,
        deps(),
      ),
    ).rejects.toThrow('not_found');
    expect((await buildSignalData(member, 'other', deps())).decisions).toEqual([]);
  });
  it('rejects a non-string review action without creating a review', async () => {
    const source = (await buildSignalData(ctx(), 'w', deps())).decisions[0]!;
    await expect(
      reviewDecision(
        source.id,
        {
          expected_version: 0,
          evidence_hash: source.evidence_hash,
          action: ['claim'],
          idempotency_key: 'invalid-action',
        },
        ctx(),
        deps(),
      ),
    ).rejects.toThrow('invalid_request');
    expect(await readReview(source.id)).toBeUndefined();
  });
  it('keeps exact named approval authority even for global owner, without payload', async () => {
    await getDb().run(
      `INSERT INTO pending_approvals VALUES('p','a',NULL,'Exact approval','install_packages',?,NULL,'j','slack','C','123.456','pending')`,
      new Date().toISOString(),
    );
    expect((await buildSignalData(ctx(), 'w', deps())).decisions.some((d) => d.source_kind === 'approval')).toBe(false);
    const allowed = await buildSignalData(ctx('j', 'admin_of_group', ['a']), 'w', deps());
    expect(allowed.decisions.filter((d) => d.source_kind === 'approval')).toHaveLength(1);
    expect(JSON.stringify(allowed)).not.toContain('payload');
  });
  it('material hash ignores watcher freshness and verification stamps but changes on head', () => {
    const first = { ...item, meta: { repo: 'acme/widget', headSha: 'abc', liveVerifiedAt: 'old' } };
    const second = { ...item, meta: { repo: 'acme/widget', headSha: 'abc', liveVerifiedAt: 'new' } };
    expect(releaseDecision('w', first, 'old').evidence_hash).toBe(releaseDecision('w', second, 'new').evidence_hash);
    expect(releaseDecision('w', Object.assign({}, second, { meta: { headSha: 'def' } }), 'new').evidence_hash).not.toBe(
      releaseDecision('w', first, 'old').evidence_hash,
    );
  });
  it('persisted explicit channel maps board names and threads to one project', async () => {
    await updateProject(
      'project',
      {
        workgroup_id: 'w',
        name: 'Widget',
        description: 'Ship it',
        repositories: [],
        channel_keys: ['slack:C'],
        expected_version: 0,
      },
      ctx(),
    );
    const data = await buildSignalData(ctx(), 'w', deps());
    expect(data.projects.find((p) => p.id === 'project')!.items).toHaveLength(1);
    await expect(
      updateProject(
        'project',
        { workgroup_id: 'w', name: 'Stale', description: '', repositories: [], channel_keys: [], expected_version: 0 },
        ctx(),
      ),
    ).rejects.toThrow('revision_conflict');
    await expect(
      updateProject(
        'project',
        {
          workgroup_id: 'other',
          name: 'Move',
          description: '',
          repositories: [],
          channel_keys: [],
          expected_version: 1,
        },
        ctx(),
      ),
    ).rejects.toThrow('cross_workgroup');
  });
  it('accepts a workgroup canonical DM key for project create and update, but not a foreign one', async () => {
    await getDb().exec(`
      INSERT INTO users VALUES('slack-workspace:Uallowed','Synthetic allowed'),('slack-workspace:Uforeign','Synthetic foreign');
      INSERT INTO messaging_groups VALUES('dm-allowed','slack:dm-allowed','Synthetic direct message'),('dm-foreign','slack:dm-foreign','Synthetic foreign message');
      INSERT INTO messaging_group_agents VALUES('dm-allowed','a'),('dm-foreign','c');
      INSERT INTO user_dms VALUES('slack-workspace:Uallowed','slack-workspace','dm-allowed','2026-09-05T00:00:00Z'),('slack-workspace:Uforeign','slack-workspace','dm-foreign','2026-09-05T00:00:00Z');
    `);
    const canonical = 'dm:slack:Uallowed';
    await expect(
      updateProject(
        'canonical-dm',
        {
          workgroup_id: 'w',
          name: 'Canonical DM',
          description: 'Maps a direct message',
          repositories: [],
          channel_keys: [canonical],
          expected_version: 0,
        },
        ctx(),
      ),
    ).resolves.toEqual({ id: 'canonical-dm', version: 1 });
    await expect(
      updateProject(
        'canonical-dm',
        {
          workgroup_id: 'w',
          name: 'Canonical DM',
          description: 'Updated direct message mapping',
          repositories: [],
          channel_keys: [canonical],
          expected_version: 1,
        },
        ctx(),
      ),
    ).resolves.toEqual({ id: 'canonical-dm', version: 2 });
    const thread = {
      thread_id: 'slack:dm-allowed:101',
      session_ids: ['synthetic-session'],
      participants: [{ agent_group_id: 'a', session_id: 'synthetic-session', name: 'A' }],
      channel_key: canonical,
      channel_name: 'Synthetic direct message',
      title: 'Canonical direct message',
      state: 'active',
      last_activity_at: '2026-09-05T00:00:00Z',
    } as unknown as ThreadSummary;
    const data = await buildSignalData(ctx(), 'w', { ...deps([]), threads: async () => [thread] });
    expect(data.projects.find((p) => p.id === 'canonical-dm')!.thread_ids).toEqual([thread.thread_id]);
    await expect(
      updateProject(
        'foreign-dm',
        {
          workgroup_id: 'w',
          name: 'Foreign DM',
          description: 'Must stay out of this workgroup',
          repositories: [],
          channel_keys: ['dm:slack:Uforeign'],
          expected_version: 0,
        },
        ctx(),
      ),
    ).rejects.toThrow('channel_not_in_workgroup');
  });
  it('retains reviewed source context/history on disappearance and disables mutations', async () => {
    const s = (await buildSignalData(ctx(), 'w', deps())).decisions[0]!;
    await reviewDecision(
      s.id,
      {
        expected_version: 0,
        evidence_hash: s.evidence_hash,
        action: 'answer',
        text: 'Keep it editable',
        idempotency_key: 'a',
      },
      ctx(),
      deps(),
    );
    const missing = await decisionDetail(s.id, ctx(), deps([]));
    expect(missing.decision.question).toBe(item.title);
    expect(missing.decision.history[0]!.note).toBe('Keep it editable');
    expect(missing.decision.state).toBe('changed');
    expect(missing.decision.capabilities.answer).toBe(false);
  });
  it('successive questions in the same session have independent identities', async () => {
    const thread = {
      thread_id: 'slack:C:123',
      session_ids: ['s'],
      participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }],
      reply_target_session_id: 's',
      channel_key: 'slack:C',
      channel_name: 'dispatch',
      title: 'Need input',
      state: 'needs_you',
      needs_you_reason: { cause: 'ask_question', text: 'Generic' },
      last_activity_at: '2026-09-05T00:00:00Z',
    } as unknown as ThreadSummary;
    const d: SourceDeps = {
      ...deps([]),
      threads: async () => [thread],
      question: () => ({ seq: 1, text: 'First?', timestamp: '2026-09-05T00:00:00Z' }),
    };
    const first = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
    const second = (
      await buildSignalData(ctx(), 'w', {
        ...d,
        question: () => ({ seq: 3, text: 'Second?', timestamp: '2026-09-05T00:00:00Z' }),
      })
    ).decisions[0]!;
    expect(first.question).toBe('First?');
    expect(first.id).not.toBe(second.id);
  });
  it('retains scoped thread review history after completion without marking off-page questions unavailable', async () => {
    await updateProject(
      'thread-project',
      {
        workgroup_id: 'w',
        name: 'Thread project',
        description: 'Tracks synthetic direct work',
        repositories: [],
        channel_keys: ['slack:C'],
        expected_version: 0,
      },
      ctx(),
    );
    const active = {
      thread_id: 'slack:C:recorded',
      session_ids: ['synthetic-recorded-session'],
      participants: [{ agent_group_id: 'a', session_id: 'synthetic-recorded-session', name: 'A' }],
      reply_target_session_id: 'synthetic-recorded-session',
      channel_key: 'slack:C',
      channel_name: 'dispatch',
      title: 'Recorded thread question',
      state: 'needs_you',
      needs_you_reason: { cause: 'ask_question', text: 'Record this answer' },
      last_activity_at: '2026-09-05T00:00:00Z',
    } as unknown as ThreadSummary;
    const answerDeps: ApiDeps = {
      ...deps([]),
      threads: async () => [active],
      question: () => ({ seq: 1, text: 'Record this answer', timestamp: '2026-09-05T00:00:00Z' }),
    };
    const source = (await buildSignalData(ctx(), 'w', answerDeps)).decisions[0]!;
    await reviewDecision(
      source.id,
      {
        expected_version: 0,
        evidence_hash: source.evidence_hash,
        action: 'answer',
        text: 'Synthetic recorded answer',
        idempotency_key: 'recorded-answer',
      },
      ctx(),
      answerDeps,
    );
    const claimDeps: ApiDeps = {
      ...answerDeps,
      question: () => ({ seq: 2, text: 'Record this claim', timestamp: '2026-09-05T00:00:00Z' }),
    };
    const claim = (await buildSignalData(ctx(), 'w', claimDeps)).decisions.find(
      (decision) => decision.question === 'Record this claim',
    )!;
    await reviewDecision(
      claim.id,
      { expected_version: 0, evidence_hash: claim.evidence_hash, action: 'claim', idempotency_key: 'recorded-claim' },
      ctx(),
      claimDeps,
    );
    const idle = { ...active, state: 'idle', needs_you_reason: null } as unknown as ThreadSummary;
    const completed = await buildSignalData(ctx(), 'w', { ...claimDeps, threads: async () => [idle] });
    const retained = completed.decisions.find((decision) => decision.id === source.id)!;
    expect(retained).toMatchObject({
      state: 'answered',
      project_id: 'thread-project',
      answer: 'Synthetic recorded answer',
    });
    expect(retained.history).toHaveLength(1);
    expect(retained.capabilities).toEqual({ claim: false, answer: false, dispatch: false });
    expect(completed.projects.find((project) => project.id === 'thread-project')!.decision_ids).toContain(source.id);
    expect(
      completed.sources.some((entry) => entry.source === retained.question && entry.status === 'unavailable'),
    ).toBe(false);
    const retainedClaim = completed.decisions.find((decision) => decision.id === claim.id)!;
    expect(retainedClaim).toMatchObject({ state: 'changed', project_id: 'thread-project', owner: { id: 'd' } });
    expect(retainedClaim.history).toHaveLength(1);
    expect(retainedClaim.capabilities).toEqual({ claim: false, answer: false, dispatch: false });
    expect(completed.projects.find((project) => project.id === 'thread-project')!.decision_ids).toContain(claim.id);
    expect(
      completed.sources.some((entry) => entry.source === retainedClaim.question && entry.status === 'unavailable'),
    ).toBe(true);
    const detail = await decisionDetail(claim.id, ctx(), {
      ...claimDeps,
      threadId: active.thread_id,
      threads: async () => [idle],
      threadDetail: async () => null,
    });
    expect(detail.decision).toMatchObject({ id: claim.id, state: 'changed', owner: { id: 'd' } });
    const laterQuestion = await buildSignalData(ctx(), 'w', {
      ...claimDeps,
      question: () => ({ seq: 3, text: 'A later question', timestamp: '2026-09-05T01:00:00Z' }),
    });
    expect(laterQuestion.decisions.find((decision) => decision.id === source.id)?.state).toBe('answered');
    expect(laterQuestion.decisions.find((decision) => decision.id === claim.id)).toMatchObject({
      state: 'changed',
      owner: { id: 'd' },
      capabilities: { claim: false, answer: false, dispatch: false },
    });
    expect(laterQuestion.decisions.some((decision) => decision.question === 'A later question')).toBe(true);
    const outOfScope = await buildSignalData(ctx('j', 'admin_of_group', ['b']), 'w', {
      ...claimDeps,
      threads: async () => [idle],
    });
    expect(outOfScope.decisions.some((decision) => decision.id === source.id)).toBe(false);
    expect(outOfScope.decisions.some((decision) => decision.id === claim.id)).toBe(false);
    const filler = {
      ...active,
      thread_id: 'slack:C:filler',
      session_ids: ['synthetic-filler-session'],
      participants: [{ agent_group_id: 'a', session_id: 'synthetic-filler-session', name: 'A' }],
      reply_target_session_id: 'synthetic-filler-session',
    } as unknown as ThreadSummary;
    const offPage = await buildSignalData(ctx(), 'w', {
      ...claimDeps,
      threads: async () => [filler, active],
      threadLimit: 1,
    });
    expect(offPage.decisions.filter((decision) => decision.id === source.id)).toHaveLength(1);
    expect(offPage.decisions.find((decision) => decision.id === source.id)!.state).toBe('answered');
    expect(offPage.sources.some((entry) => entry.source === source.question && entry.status === 'unavailable')).toBe(
      false,
    );
    const offPageClaim = offPage.decisions.find((decision) => decision.id === claim.id)!;
    expect(offPageClaim).toMatchObject({ state: 'open', owner: { id: 'd' } });
    expect(offPageClaim.capabilities).toEqual({ claim: false, answer: false, dispatch: false });
    expect(offPage.sources.some((entry) => entry.source === claim.question && entry.status === 'unavailable')).toBe(
      false,
    );
  });
});
describe('Signal durable dispatch', () => {
  it('reserves exact target before sending and recovers crash after successful delivery without duplicate', async () => {
    const sent = new Set<string>();
    let actualMessages = 0;
    const d: ApiDeps = {
      ...deps(),
      threadDetail: async () => ({
        thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
        transcript: [],
      }),
      canSend: async () => ({ ok: true }),
      send: async (_session, body) => {
        if (!sent.has(body.idempotency_key)) {
          sent.add(body.idempotency_key);
          actualMessages++;
        }
        return { status: 202, body: {} };
      },
      afterSend: () => {
        throw new Error('simulated crash');
      },
    };
    const source = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
    const answered = await reviewDecision(
      source.id,
      { expected_version: 0, evidence_hash: source.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
      ctx(),
      d,
    );
    const request = {
      expected_version: answered.version,
      evidence_hash: source.evidence_hash,
      agent_group_id: 'a',
      target_thread_id: 'slack:C:123',
    };
    await expect(dispatchDecision(source.id, request, ctx(), d)).rejects.toThrow('simulated crash');
    expect(readRecord(await readReview(source.id)).dispatch?.state).toBe('pending');
    const result = await dispatchDecision(source.id, request, ctx(), { ...d, afterSend: undefined });
    expect(result.dispatch_state).toBe('sent');
    expect(actualMessages).toBe(1);
    await expect(
      dispatchDecision(source.id, { ...request, target_thread_id: 'slack:C:999' }, ctx(), d),
    ).rejects.toThrow('dispatch_target_conflict');
  });
  it('rejects cross-workgroup destinations before any message is sent', async () => {
    const send = vi.fn();
    const d: ApiDeps = {
      ...deps(),
      threadDetail: async () => ({
        thread: { participants: [{ agent_group_id: 'c', session_id: 's', name: 'C' }] } as unknown as ThreadSummary,
        transcript: [],
      }),
      canSend: async () => ({ ok: true }),
      send,
    };
    const source = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
    await reviewDecision(
      source.id,
      { expected_version: 0, evidence_hash: source.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
      ctx(),
      d,
    );
    await expect(
      dispatchDecision(
        source.id,
        { expected_version: 1, evidence_hash: source.evidence_hash, agent_group_id: 'c', target_thread_id: 'other' },
        ctx(),
        d,
      ),
    ).rejects.toThrow('cross_workgroup');
    expect(send).not.toHaveBeenCalled();
  });
});

it('marks a failed retry pending before IO and sent cannot be downgraded by a slower retry', async () => {
  let resolveSlow!: (value: { status: 429; body: Record<string, unknown> }) => void;
  let calls = 0;
  const d: ApiDeps = {
    ...deps(),
    threadDetail: async () => ({
      thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
      transcript: [],
    }),
    canSend: async () => ({ ok: true }),
    send: async () => {
      calls++;
      if (calls === 1) return { status: 429, body: { error: 'rate_limit' } };
      if (calls === 2)
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      return { status: 202, body: {} };
    },
  };
  const source = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
  await reviewDecision(
    source.id,
    { expected_version: 0, evidence_hash: source.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
    ctx(),
    d,
  );
  const request = {
    expected_version: 1,
    evidence_hash: source.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  expect((await dispatchDecision(source.id, request, ctx(), d)).dispatch_state).toBe('pending');
  const slow = dispatchDecision(source.id, request, ctx(), d);
  while (!resolveSlow) await new Promise((resolve) => setTimeout(resolve, 1));
  const pending = await readReview(source.id);
  expect(readRecord(pending).dispatch?.state).toBe('pending');
  await expect(
    reviewDecision(
      source.id,
      {
        expected_version: pending!.version,
        evidence_hash: source.evidence_hash,
        action: 'answer',
        text: 'Changed answer',
        idempotency_key: 'b',
      },
      ctx(),
      d,
    ),
  ).rejects.toThrow('delivery_pending');
  expect((await dispatchDecision(source.id, request, ctx(), d)).dispatch_state).toBe('sent');
  resolveSlow({ status: 429, body: { error: 'late_rate_limit' } });
  expect((await slow).dispatch_state).toBe('sent');
  expect(readRecord(await readReview(source.id)).dispatch?.state).toBe('sent');
});

it('reads the declared canonical workgroup board when legacy group copies are absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-release-'));
  try {
    const directory = path.join(root, 'data', 'workgroups', 'w', 'releases');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'release-state.json'),
      JSON.stringify({ asOf: '2026-09-05T00:00:00Z', items: [item] }),
    );
    await getDb().run(
      'UPDATE workgroups SET attention_sources=? WHERE id=?',
      JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: 'slack:C' }]),
      'w',
    );
    const release = await readSignalRelease('w', {
      groupsRoot: path.join(root, 'groups'),
      dataRoot: path.join(root, 'data'),
    });
    expect(release?.items[0]!.id).toBe(item.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('skips a malformed release board timestamp before a healthy declaration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-release-'));
  try {
    const invalid = path.join(root, 'data', 'workgroups', 'w', 'invalid');
    const healthy = path.join(root, 'data', 'workgroups', 'w', 'healthy');
    fs.mkdirSync(invalid, { recursive: true });
    fs.mkdirSync(healthy, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'release-state.json'), JSON.stringify({ asOf: 'not-a-date', items: [item] }));
    fs.writeFileSync(
      path.join(healthy, 'release-state.json'),
      JSON.stringify({ asOf: '2026-09-05T00:00:00Z', items: [item] }),
    );
    await getDb().run(
      'UPDATE workgroups SET attention_sources=? WHERE id=?',
      JSON.stringify([
        { kind: 'release-board', root: 'invalid', channel_key: 'slack:C' },
        { kind: 'release-board', root: 'healthy', channel_key: 'slack:C' },
      ]),
      'w',
    );
    expect(
      (
        await readSignalRelease('w', {
          groupsRoot: path.join(root, 'groups'),
          dataRoot: path.join(root, 'data'),
        })
      )?.asOf,
    ).toBe('2026-09-05T00:00:00Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('only pending delivery can reconcile an old answer after source disappearance', async () => {
  let sends = 0;
  const d: ApiDeps = {
    ...deps(),
    threadDetail: async () => ({
      thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
      transcript: [],
    }),
    canSend: async () => ({ ok: true }),
    send: async () => {
      sends++;
      return { status: 202, body: {} };
    },
    afterSend: () => {
      throw new Error('crash');
    },
  };
  const s = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
  await reviewDecision(
    s.id,
    { expected_version: 0, evidence_hash: s.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
    ctx(),
    d,
  );
  const request = {
    expected_version: 1,
    evidence_hash: s.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  await expect(dispatchDecision(s.id, request, ctx(), d)).rejects.toThrow('crash');
  const absent = { ...d, scene: async () => scene([]), afterSend: undefined };
  expect((await dispatchDecision(s.id, request, ctx(), absent)).dispatch_state).toBe('sent');
  expect(sends).toBe(2); // same persisted key is reconciled by the real delivery primitive
});

it('reads actual chat-sdk ask_question content and chooses the newest question sequence', () => {
  const row = (seq: number, question: string) => ({
    seq,
    kind: 'chat-sdk',
    timestamp: '2026-09-05T00:00:00Z',
    content: JSON.stringify({ type: 'ask_question', questionId: `q${seq}`, question }),
  });
  expect(
    pendingQuestionFromRows([
      row(1, 'Old question'),
      row(5, 'Current question'),
      {
        seq: 7,
        kind: 'chat-sdk',
        timestamp: '2026-09-05T00:00:00Z',
        content: JSON.stringify({ type: 'status', text: 'Working' }),
      },
    ]),
  ).toMatchObject({ seq: 5, text: 'Current question' });
});

it('keeps every visible pending question answerable beyond the old fifty-question cutoff', async () => {
  const threads = Array.from(
    { length: 51 },
    (_, i) =>
      ({
        thread_id: `slack:C:${i}`,
        session_ids: [`s${i}`],
        participants: [{ agent_group_id: 'a', session_id: `s${i}`, name: 'A' }],
        reply_target_session_id: `s${i}`,
        channel_key: 'slack:C',
        channel_name: 'dispatch',
        title: 'Need input',
        state: 'needs_you',
        needs_you_reason: { cause: 'ask_question', text: 'Generic' },
        last_activity_at: '2026-09-05T00:00:00Z',
      }) as unknown as ThreadSummary,
  );
  const d: SourceDeps = {
    ...deps([]),
    threads: async () => threads,
    question: (_group, session) => ({ seq: 1, text: `Question for ${session}`, timestamp: '2026-09-05T00:00:00Z' }),
  };
  const data = await buildSignalData(ctx(), 'w', d);
  expect(data.decisions).toHaveLength(51);
  expect(data.decisions.every((d) => d.capabilities.answer)).toBe(true);
});

it('a fast retry rejection cannot release a reservation while an earlier delivery is in flight', async () => {
  let complete!: (value: { status: 202; body: Record<string, unknown> }) => void;
  let calls = 0;
  const d: ApiDeps = {
    ...deps(),
    threadDetail: async () => ({
      thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
      transcript: [],
    }),
    canSend: async () => ({ ok: true }),
    send: async () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          complete = resolve;
        });
      return { status: 429, body: { error: 'rate_limit' } };
    },
  };
  const s = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
  await reviewDecision(
    s.id,
    { expected_version: 0, evidence_hash: s.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
    ctx(),
    d,
  );
  const request = {
    expected_version: 1,
    evidence_hash: s.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  const original = dispatchDecision(s.id, request, ctx(), d);
  while (!complete) await new Promise((resolve) => setTimeout(resolve, 1));
  expect((await dispatchDecision(s.id, request, ctx(), d)).dispatch_state).toBe('pending');
  const current = await readReview(s.id);
  await expect(
    reviewDecision(
      s.id,
      {
        expected_version: current!.version,
        evidence_hash: s.evidence_hash,
        action: 'answer',
        text: 'Replacement',
        idempotency_key: 'b',
      },
      ctx(),
      d,
    ),
  ).rejects.toThrow('delivery_pending');
  complete({ status: 202, body: {} });
  expect((await original).dispatch_state).toBe('sent');
});

it('pending missing-source reconciliation still denies revoked role, recipient scope and wrong owner', async () => {
  const send = vi.fn(async () => ({ status: 202 as const, body: {} }));
  const d: ApiDeps = {
    ...deps(),
    threadDetail: async () => ({
      thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
      transcript: [],
    }),
    canSend: async () => ({ ok: true }),
    send,
    afterSend: () => {
      throw new Error('crash');
    },
  };
  const s = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
  await reviewDecision(
    s.id,
    { expected_version: 0, evidence_hash: s.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
    ctx(),
    d,
  );
  const request = {
    expected_version: 1,
    evidence_hash: s.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  await expect(dispatchDecision(s.id, request, ctx(), d)).rejects.toThrow('crash');
  const missing = { ...d, scene: async () => scene([]), afterSend: undefined };
  await expect(dispatchDecision(s.id, request, ctx('d', 'member', ['a']), missing)).rejects.toThrow('not_found');
  await expect(dispatchDecision(s.id, request, ctx('d', 'admin_of_group', ['b']), missing)).rejects.toThrow(
    'not_found',
  );
  await expect(dispatchDecision(s.id, request, ctx('j', 'owner'), missing)).rejects.toThrow('another_reviewer');
  expect(send).toHaveBeenCalledTimes(1);
});

it('pages every active thread without dropping repeated board decisions or duplicating page identities', async () => {
  const threads = Array.from(
    { length: 5 },
    (_, i) =>
      ({
        thread_id: `slack:C:${i}`,
        session_ids: [`s${i}`],
        participants: [{ agent_group_id: 'a', session_id: `s${i}`, name: 'A' }],
        reply_target_session_id: `s${i}`,
        channel_key: 'slack:C',
        channel_name: 'dispatch',
        title: 'Need input',
        state: 'needs_you',
        needs_you_reason: { cause: 'ask_question', text: 'Generic' },
        last_activity_at: '2001-01-01T00:00:00Z',
      }) as unknown as ThreadSummary,
  );
  const d: SourceDeps = {
    ...deps(),
    threads: async () => threads,
    question: (_g, s) => ({ seq: 1, text: s, timestamp: '2001-01-01T00:00:00Z' }),
    threadLimit: 2,
  };
  const pages = await Promise.all([0, 2, 4].map((threadOffset) => buildSignalData(ctx(), 'w', { ...d, threadOffset })));
  expect(pages.map((p) => p.thread_coverage![0]!.has_more)).toEqual([true, true, false]);
  expect(
    new Set(pages.flatMap((p) => p.decisions.filter((d) => d.source_kind === 'thread-question').map((d) => d.id))).size,
  ).toBe(5);
  expect(pages.every((p) => p.decisions.some((d) => d.source_kind === 'release-item'))).toBe(true);
});

it('original rejection cannot release a reservation while its retry is in flight', async () => {
  let finishOriginal!: (value: { status: 429; body: Record<string, unknown> }) => void;
  let finishRetry!: (value: { status: 202; body: Record<string, unknown> }) => void;
  let calls = 0;
  const d: ApiDeps = {
    ...deps(),
    threadDetail: async () => ({
      thread: { participants: [{ agent_group_id: 'a', session_id: 's', name: 'A' }] } as unknown as ThreadSummary,
      transcript: [],
    }),
    canSend: async () => ({ ok: true }),
    send: async () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          finishOriginal = resolve;
        });
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    },
  };
  const s = (await buildSignalData(ctx(), 'w', d)).decisions[0]!;
  await reviewDecision(
    s.id,
    { expected_version: 0, evidence_hash: s.evidence_hash, action: 'answer', text: 'Yes', idempotency_key: 'a' },
    ctx(),
    d,
  );
  const request = {
    expected_version: 1,
    evidence_hash: s.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  const original = dispatchDecision(s.id, request, ctx(), d);
  while (!finishOriginal) await new Promise((resolve) => setTimeout(resolve, 1));
  const retry = dispatchDecision(s.id, request, ctx(), d);
  while (!finishRetry) await new Promise((resolve) => setTimeout(resolve, 1));
  finishOriginal({ status: 429, body: { error: 'rate_limit' } });
  expect((await original).dispatch_state).toBe('pending');
  const current = await readReview(s.id);
  await expect(
    reviewDecision(
      s.id,
      {
        expected_version: current!.version,
        evidence_hash: s.evidence_hash,
        action: 'answer',
        text: 'Replacement',
        idempotency_key: 'b',
      },
      ctx(),
      d,
    ),
  ).rejects.toThrow('delivery_pending');
  finishRetry({ status: 202, body: {} });
  expect((await retry).dispatch_state).toBe('sent');
});

it('exposes exact uniquely owned claim notes and only same-agent thread links within scope', async () => {
  await getDb().exec(`ALTER TABLE sessions ADD COLUMN thread_id TEXT;
    INSERT INTO sessions VALUES('sa','a','thread-a'),('sb','b','thread-b'),('sc','c','thread-other');`);
  const snapshot = scene([]);
  snapshot.agents[0]!.holding = ['owned', 'hidden-link', 'cross-link', 'ambiguous'];
  snapshot.agents[1]!.holding = ['private', 'ambiguous'];
  const claim = (slug: string, threadId: string, owner = 'A') => ({
    slug,
    owner,
    note: `Source note for ${slug}`,
    threadId,
    state: 'parked' as const,
    staleMs: 1234,
    escalated: false,
    threadUrl: `https://example.com/${threadId}`,
    sessionId: null,
  });
  snapshot.claims = [
    claim('owned', 'thread-a'),
    claim('hidden-link', 'thread-b'),
    claim('cross-link', 'thread-other'),
    claim('ambiguous', 'thread-a'),
    claim('private', 'thread-b', 'B'),
  ];
  const d = { ...deps([]), scene: async () => snapshot };
  const result = await buildSignalData(ctx('j', 'member', ['a']), 'w', d);
  expect(result.agents).toHaveLength(1);
  const details = result.agents[0]!.claim_details!;
  expect(details.map((c) => c.slug)).toEqual(['owned', 'hidden-link', 'cross-link']);
  expect(details[0]).toEqual({
    slug: 'owned',
    owner: 'A',
    note: 'Source note for owned',
    state: 'parked',
    stale_ms: 1234,
    escalated: false,
    thread_id: 'thread-a',
    source_url: 'https://example.com/thread-a',
  });
  expect(details.slice(1).every((c) => c.thread_id === null && c.source_url === null)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('Source note for private');
  expect((await buildSignalData(ctx('j', 'member', ['a']), 'other', d)).agents).toEqual([]);
});

it('serves decisions without assembling schedule history when its cache is cold', async () => {
  const assemble = vi.spyOn(scheduleAssembly, 'assembleSnapshot');
  const cache = getScheduledCache();
  const previous = { data: cache.data, expiresMs: cache.expiresMs };
  cache.data = null;
  cache.expiresMs = 0;
  try {
    const data = await buildSignalData(ctx(), 'w', {
      runtimeScene: async () => scene(),
      release: async () => ({ asOf: '2026-09-05T00:00:00Z', items: [item] }),
      threads: async () => [],
    });
    expect(data.decisions.some((d) => d.source_id === item.id)).toBe(true);
    expect(data.sources.some((s) => s.source === 'scheduled work' && s.status === 'unavailable')).toBe(true);
    expect(assemble).not.toHaveBeenCalled();
  } finally {
    Object.assign(cache, previous);
    assemble.mockRestore();
  }
});


it('passes exact-thread context requests through the scoped source loader without a page offset', async () => {
  const load = signalSources.buildSignalData;
  const observed: SourceDeps[] = [];
  const spy = vi.spyOn(signalSources, 'buildSignalData').mockImplementation(async (context, workspace, options = {}) => {
    observed.push(options);
    return load(context, workspace, { ...options, ...deps([]) });
  });
  try {
    const response = await signalOverviewHandler(
      new Request('http://localhost/dashboard/api/observatory/v2?workgroup=w&thread_id=synthetic-thread&thread_offset=200'),
      {}, ctx('j', 'member', ['a']),
    );
    if (!response) throw new Error('Expected the Signal endpoint to respond');
    expect(response.status).toBe(200);
    expect(observed).toEqual([expect.objectContaining({ threadId: 'synthetic-thread', threadOffset: 0 })]);
    const body = await response.json();
    expect(body).toMatchObject({ agents: [{ id: 'a' }] });
    expect(body).not.toHaveProperty('rawDecisions');
  } finally {
    spy.mockRestore();
  }
});
