import http from 'node:http';
import crypto from 'node:crypto';
import { allowNetwork } from '../src/test-hermeticity.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { initTestDb, getDb, closeDb } from '../src/db/connection.js';
import { SIGNAL_SCHEMA } from '../src/db/migrations/072-observatory-signal.js';
import { register, requireAuth, registerCookieVerifier, dispatch, type AuthHandler } from '../src/dashboard/router.js';
import { buildSetCookie, parseAndVerifyCookie } from '../src/dashboard/auth/cookie.js';
import { buildSignalData } from '../src/dashboard/observatory-v2/sources.js';
import {
  decisionDetail,
  reviewDecision,
  dispatchDecision,
  updateProject,
  type ApiDeps,
} from '../src/dashboard/observatory-v2/api.js';
import { SignalError } from '../src/dashboard/observatory-v2/state.js';
import type { SignalOverview, SignalDecisionDetail } from '../src/dashboard/observatory-v2/types.js';
import type { ReleaseStateItem } from '../src/dashboard/api/observatory.js';
import type { ThreadSummary } from '../src/dashboard/api/threads.js';

let server: http.Server;
let origin: string;
const key = crypto.randomBytes(32);
let item: ReleaseStateItem = {
  id: 'policy',
  kind: 'decision',
  title: 'Allow editing?',
  why: 'Policy requires a human choice.',
  nextAction: 'Choose a policy.',
  nextMover: 'human',
  url: 'https://github.com/acme/widget/issues/1',
};
const delivered = new Map<string, { session: string; text: string }>();
let simulateCrash = true;
const deps: ApiDeps = {
  scene: async (workgroupId) => ({
    workgroupId,
    asOf: new Date().toISOString(),
    rooms: [],
    agents: [],
    claims: [],
    releaseState: { asOf: new Date().toISOString(), items: [item] },
  }),
  threads: async () => [],
  threadDetail: async (id) =>
    id === 'slack:C:123'
      ? {
          thread: {
            participants: [{ agent_group_id: 'a', session_id: 'isolated-session', name: 'Agent A' }],
          } as unknown as ThreadSummary,
          transcript: [],
        }
      : null,
  send: async (session, body) => {
    if (!delivered.has(body.idempotency_key)) delivered.set(body.idempotency_key, { session, text: body.text });
    return { status: 202, body: {} };
  },
  afterSend: () => {
    if (simulateCrash) throw new Error('simulated post-delivery crash');
  },
};
function endpoint(handler: AuthHandler): AuthHandler {
  return async (req, params, ctx) => {
    try {
      return await handler(req, params, ctx);
      // HTTP boundary deliberately serializes failures for the client assertion.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'failure' },
        { status: error instanceof SignalError ? error.status : 500 },
      );
    }
  };
}
function cookie(user: string) {
  return buildSetCookie({ user_id: user, expires_at: new Date(Date.now() + 60000).toISOString() }, key, {
    secure: false,
  }).split(';')[0]!;
}
async function request(
  path: string,
  user: string | null = 'd',
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const res = await fetch(origin + path, {
    method,
    headers: { ...(user ? { cookie: cookie(user) } : {}), 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as SignalOverview & SignalDecisionDetail };
}
beforeAll(async () => {
  await initTestDb();
  await getDb().exec(`
 CREATE TABLE users(id TEXT PRIMARY KEY,kind TEXT,display_name TEXT,created_at TEXT);
 CREATE TABLE user_roles(user_id TEXT,role TEXT,agent_group_id TEXT);
 CREATE TABLE agent_group_members(user_id TEXT,agent_group_id TEXT);
 CREATE TABLE workgroups(id TEXT PRIMARY KEY,display_name TEXT,attention_sources TEXT);
 CREATE TABLE agent_groups(id TEXT PRIMARY KEY,workgroup_id TEXT,name TEXT);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,agent_group_id TEXT);
 CREATE TABLE pending_approvals(approval_id TEXT PRIMARY KEY,agent_group_id TEXT,session_id TEXT,title TEXT,action TEXT,created_at TEXT,expires_at TEXT,approver_user_id TEXT,channel_type TEXT,platform_id TEXT,platform_message_id TEXT,status TEXT);
 CREATE TABLE messaging_groups(id TEXT PRIMARY KEY,platform_id TEXT);
 CREATE TABLE messaging_group_agents(messaging_group_id TEXT,agent_group_id TEXT);
 INSERT INTO users VALUES('d','human','Reviewer One','2026-09-05T00:00:00Z'),('j','human','Reviewer Two','2026-09-05T00:00:00Z'),('member','human','Member','2026-09-05T00:00:00Z');
 INSERT INTO user_roles VALUES('d','owner',NULL),('j','admin',NULL);
 INSERT INTO agent_group_members VALUES('member','a');
 INSERT INTO workgroups VALUES('w','Workspace',NULL),('other','Other',NULL);
 INSERT INTO agent_groups VALUES('a','w','Agent A'),('hidden','other','Hidden agent');
 INSERT INTO sessions VALUES('isolated-session','a');
 INSERT INTO messaging_groups VALUES('m','slack:C');
 INSERT INTO messaging_group_agents VALUES('m','a');
 `);
  await getDb().exec(SIGNAL_SCHEMA);
  registerCookieVerifier((value) => parseAndVerifyCookie(value, key));
  register(
    'GET',
    '/dashboard/api/observatory/v2',
    requireAuth(
      endpoint(async (req, _p, ctx) => {
        const { rawDecisions, ...body } = await buildSignalData(
          ctx,
          new URL(req.url).searchParams.get('workgroup') || 'w',
          deps,
        );
        return Response.json(body);
      }),
    ),
  );
  register(
    'GET',
    '/dashboard/api/observatory/v2/decisions/:id',
    requireAuth(endpoint(async (_req, p, ctx) => Response.json(await decisionDetail(p.id!, ctx, deps)))),
  );
  register(
    'POST',
    '/dashboard/api/observatory/v2/decisions/:id/review',
    requireAuth(
      endpoint(async (req, p, ctx) =>
        Response.json({ decision: await reviewDecision(p.id!, await req.json(), ctx, deps) }),
      ),
    ),
  );
  register(
    'POST',
    '/dashboard/api/observatory/v2/decisions/:id/dispatch',
    requireAuth(
      endpoint(async (req, p, ctx) =>
        Response.json({ decision: await dispatchDecision(p.id!, await req.json(), ctx, deps) }),
      ),
    ),
  );
  register(
    'PUT',
    '/dashboard/api/observatory/v2/projects/:id',
    requireAuth(endpoint(async (req, p, ctx) => Response.json(await updateProject(p.id!, await req.json(), ctx)))),
  );
  server = http.createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let body = '';
    for await (const chunk of req) body += chunk;
    const response = await dispatch(
      new Request(origin + req.url, { method: req.method, headers, ...(body ? { body } : {}) }),
      req,
      res,
    );
    if (response) {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});
it('authenticated HTTP ownership, delivery, project persistence and evidence conflicts are isolated end to end', async () => {
  allowNetwork(); // Ephemeral loopback server only; downstream transport remains fake.
  const base = '/dashboard/api/observatory/v2';
  expect((await request(base, null)).status).toBe(401);
  const first = await request(base);
  expect(first.status).toBe(200);
  const source = first.body.decisions[0];
  const path = base + '/decisions/' + source.id;
  const claim = {
    expected_version: 0,
    evidence_hash: source.evidence_hash,
    action: 'claim',
    idempotency_key: 'claim-d',
  };
  expect((await request(path + '/review', 'd', 'POST', claim, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await request(path + '/review', 'member', 'POST', claim)).status).toBe(404);
  expect((await request(base + '?workgroup=other', 'member')).body.decisions).toEqual([]);
  const race = await Promise.all([
    request(path + '/review', 'd', 'POST', claim),
    request(path + '/review', 'j', 'POST', { ...claim, idempotency_key: 'claim-j' }),
  ]);
  expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = race[0]!.status === 200 ? 'd' : 'j';
  const loser = winner === 'd' ? 'j' : 'd';
  const shared = await request(path, loser);
  expect(shared.body.decision.owner?.id).toBe(winner);
  expect(shared.body.decision.version).toBe(1);
  const answer = await request(path + '/review', winner, 'POST', {
    expected_version: 1,
    evidence_hash: source.evidence_hash,
    action: 'answer',
    text: 'Allow editing with an audit log.',
    idempotency_key: 'answer',
  });
  expect(answer.status).toBe(200);
  expect(delivered.size).toBe(0);
  const dispatchBody = {
    expected_version: answer.body.decision.version,
    evidence_hash: source.evidence_hash,
    agent_group_id: 'a',
    target_thread_id: 'slack:C:123',
  };
  expect((await request(path + '/dispatch', winner, 'POST', dispatchBody)).status).toBe(500);
  expect((await request(path, winner)).body.decision.dispatch_state).toBe('pending');
  simulateCrash = false;
  expect((await request(path + '/dispatch', winner, 'POST', dispatchBody)).body.decision.dispatch_state).toBe('sent');
  expect((await request(path + '/dispatch', winner, 'POST', dispatchBody)).body.decision.dispatch_state).toBe('sent');
  expect([...delivered.values()]).toEqual([
    {
      session: 'isolated-session',
      text: `${winner === 'd' ? 'Reviewer One' : 'Reviewer Two'} sent a decision from the Observatory.\n\nQuestion: Allow editing?\n\nTheir answer, verbatim:\nAllow editing with an audit log.\n\nReply in this thread with what you did or what prevents action.`,
    },
  ]);
  const project = {
    workgroup_id: 'w',
    name: 'Widget',
    description: 'Source-backed goal',
    repositories: ['acme/widget'],
    channel_keys: [],
    expected_version: 0,
  };
  expect((await request(base + '/projects/widget', 'member', 'PUT', project)).status).toBe(404);
  expect((await request(base + '/projects/widget', 'd', 'PUT', project)).status).toBe(200);
  expect((await request(base, 'j')).body.projects.find((p: { id: string }) => p.id === 'widget')?.items).toHaveLength(
    1,
  );
  expect((await request(base + '/projects/widget', 'd', 'PUT', project)).status).toBe(409);
  item = { ...item, why: 'Evidence materially changed.' };
  const fresh = (await request(path, winner)).body.decision;
  expect(fresh.state).toBe('changed');
  expect(fresh.history.some((e) => e.note === 'Allow editing with an audit log.')).toBe(true);
  expect(
    (
      await request(path + '/review', winner, 'POST', {
        expected_version: fresh.version,
        evidence_hash: source.evidence_hash,
        action: 'answer',
        text: 'Old answer',
        idempotency_key: 'stale',
      })
    ).status,
  ).toBe(409);
}, 20000);
