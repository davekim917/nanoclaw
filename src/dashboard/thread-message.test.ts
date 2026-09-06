import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from '../db/index.js';
import { enforceHermeticity } from '../test-hermeticity.js';
import type { AuthedRequestContext } from './router.js';

// `resolveSession` (session-manager.js) creates the session directory under
// `DATA_DIR/v2-sessions/` as a side effect of resolving a thread's session —
// unmocked, that lands in the checkout's own `data/` tree, which on a live
// install is production session state (issue #305).
const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('thread-message') }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

enforceHermeticity();

/**
 * The console's ONE primitive, at the seam that matters: which session a send
 * lands in, whether Assign opens one, and whether a hand-over tells the
 * incumbent to let go of its claim.
 *
 * `applySessionSteer` is stubbed. It is the gate, the rate limit, the
 * idempotency reservation and the echo — all of it already tested in
 * `steer.test.ts` — and stubbing it is what makes the assertions here about
 * ROUTING rather than about re-testing steer. What is NOT stubbed is
 * `canSteer`: the pre-check that stops an unauthorised caller from minting a
 * session row is this file's own behaviour and has to be real.
 */

const applySessionSteer = vi.fn();
vi.mock('./steer.js', async (orig) => ({
  ...(await orig<typeof import('./steer.js')>()),
  applySessionSteer,
}));

// container-runner drags in the whole spawn path; `threads.ts` needs two
// functions off it and neither matters here. Spread the real module so
// exports this suite doesn't assert on — `sessionStillActive` isn't reached
// today, but staying wired means a future caller that reaches for it doesn't
// throw "no such export" the way #291's guard conversion did to four other
// suites.
vi.mock('../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../container-runner.js')>();
  return {
    ...real,
    getActiveContainerSessionIds: () => [],
    resolveAssistantName: (group: { name: string }) => Promise.resolve(`persona:${group.name}`),
  };
});

const { sendThreadMessage, composeReleaseNote, composeClaimContext, composeOperatorMessage, MAX_OPERATOR_TEXT } =
  await import('./thread-message.js');

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (msAgo = 0): string => new Date(NOW - msAgo).toISOString();

const THREAD = 'slack:CTESTCHAN01:1700000000.11';

function ctx(over: { userId?: string; no_filter?: boolean; allowed?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: over.userId ?? 'u-owner', kind: 'dashboard', display_name: 'Dana', created_at: iso() },
    scopes: {
      role: 'owner',
      allowed_group_ids: over.allowed ?? [],
      no_filter: over.no_filter ?? true,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

let claimsRoot: string;

async function seedAgent(id: string, folder = id): Promise<void> {
  getRawDb()
    .prepare(`INSERT OR IGNORE INTO workgroups (id, display_name, created_at) VALUES ('wg-1', 'wg-1', ?)`)
    .run(iso());
  await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: iso() });
  // `createAgentGroup` does not carry workgroup_id, and claims are per-workgroup
  // files — so a claim is unfindable without this.
  getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = 'wg-1' WHERE id = ?`).run(id);
}

function wire(agentGroupId: string, sessionMode = 'per-thread'): void {
  getRawDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
       VALUES ('mg-1', 'slack-testworkspace', 'testworkspace', 'slack:CTESTCHAN01', '#example-eng', ?)`,
    )
    .run(iso());
  getRawDb()
    .prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES (?, 'mg-1', ?, ?, ?)`,
    )
    .run(`mga-${agentGroupId}`, agentGroupId, sessionMode, iso());
}

function seedSession(id: string, agentGroupId: string, threadId: string | null = THREAD): void {
  getRawDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status,
          last_active, last_outbound_at, created_at)
       VALUES (?, ?, 'mg-1', ?, NULL, 'active', 'stopped', ?, ?, ?)`,
    )
    .run(id, agentGroupId, threadId, iso(60_000), iso(60_000), iso(3_600_000));
}

/** A synthetic claim file, exactly the flat shape `claim.sh` writes. */
function writeClaim(opts: { slug: string; owner: string; ttlHours: number; claimedAgoMs: number }): void {
  const dir = path.join(claimsRoot, 'wg-1', 'claims');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${opts.slug}.json`),
    JSON.stringify({
      owner: opts.owner,
      session_id: 'local-nickname',
      thread_id: THREAD,
      claimed_at: iso(opts.claimedAgoMs),
      ttl_hours: opts.ttlHours,
      note: 'publish-gate seam',
    }),
  );
}

const ACCEPTED = { status: 202, body: { message_id: 'm-1', echo_status: 'pending' } };

function makeUserAdmin(userId: string): void {
  getRawDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', ?, ?)`)
    .run(userId, userId, iso());
  getRawDb()
    .prepare(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, 'owner', NULL, ?)`)
    .run(userId, iso());
}

beforeEach(async () => {
  await closeDb();
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  claimsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncc-claims-'));
  applySessionSteer.mockReset();
  applySessionSteer.mockResolvedValue(ACCEPTED);
  makeUserAdmin('u-owner');
});

const send = (body: Record<string, unknown>, c = ctx()) => sendThreadMessage(THREAD, body, c, { now: NOW, claimsRoot });

// ── Steering an agent already on the thread ──────────────────────────────────

describe('a chosen agent already on the thread is an ordinary send', () => {
  it('routes into that agent’s existing session and creates nothing', async () => {
    await seedAgent('ag-alpha');
    wire('ag-alpha');
    seedSession('s-alpha', 'ag-alpha');

    const res = await send({ agent_group_id: 'ag-alpha', idempotency_key: 'k1', text: 'push it forward' });

    expect(res.status).toBe(202);
    expect(res.body['created_session']).toBe(false);
    expect(res.body['handoff']).toBeNull();
    expect(applySessionSteer).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = applySessionSteer.mock.calls[0]!;
    expect(sessionId).toBe('s-alpha');
    // The operator's words go out QUOTED and attributed, not bare — see
    // `composeOperatorMessage` and its own describe block below.
    expect(payload.text).toContain('push it forward');
    expect(payload.text).toContain('Dana');
    // No new session row — an agent already here is steered, never re-assigned.
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});

// ── Assign ───────────────────────────────────────────────────────────────────

describe('assigning an agent with no session on the thread', () => {
  it('creates the session on the thread’s wired channel and delivers into it', async () => {
    await seedAgent('ag-alpha');
    await seedAgent('ag-bravo');
    wire('ag-alpha');
    wire('ag-bravo');
    seedSession('s-alpha', 'ag-alpha');

    const res = await send({ agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'you own this now' });

    expect(res.status).toBe(202);
    expect(res.body['created_session']).toBe(true);
    const created = getRawDb()
      .prepare(`SELECT id, agent_group_id, messaging_group_id, thread_id FROM sessions WHERE agent_group_id='ag-bravo'`)
      .get() as { id: string; messaging_group_id: string; thread_id: string };
    expect(created.messaging_group_id).toBe('mg-1');
    expect(created.thread_id).toBe(THREAD);
    // The send lands in the session that was just opened, not in anyone else's.
    expect(applySessionSteer.mock.calls[0]![0]).toBe(created.id);
    expect(res.body['session_id']).toBe(created.id);
  });

  it('refuses an agent that is not wired to the thread’s channel, and creates nothing', async () => {
    await seedAgent('ag-alpha');
    await seedAgent('ag-elsewhere');
    wire('ag-alpha');
    seedSession('s-alpha', 'ag-alpha');
    // ag-elsewhere is a real, in-scope agent — it simply does not belong in this
    // room, and a browser must not be able to make it speak there.
    const res = await send({ agent_group_id: 'ag-elsewhere', idempotency_key: 'k1', text: 'hi' });

    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('agent_not_wired_to_thread_channel');
    expect(applySessionSteer).not.toHaveBeenCalled();
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('does not mint a session for a caller who may not steer that agent', async () => {
    await seedAgent('ag-alpha');
    await seedAgent('ag-bravo');
    wire('ag-alpha');
    wire('ag-bravo');
    seedSession('s-alpha', 'ag-alpha');
    getRawDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('u-nobody','dashboard','N',?)`)
      .run(iso());

    const res = await send(
      { agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'hi' },
      ctx({ userId: 'u-nobody' }),
    );

    // Disclose-as-not-found, and — the point of the test — the gate ran BEFORE
    // resolveSession, so no row exists for an agent this caller cannot reach.
    expect(res.status).toBe(404);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(applySessionSteer).not.toHaveBeenCalled();
  });
});

// ── Hand-over ────────────────────────────────────────────────────────────────

describe('hand-over notifies both sides', () => {
  beforeEach(async () => {
    await seedAgent('ag-alpha');
    await seedAgent('ag-bravo');
    wire('ag-alpha');
    wire('ag-bravo');
    seedSession('s-alpha', 'ag-alpha');
  });

  it('sends the operator’s text to the new agent AND a composed note to the holder', async () => {
    writeClaim({ slug: 'acme-pr-733', owner: 'ag-alpha', ttlHours: 4, claimedAgoMs: 60_000 });

    const res = await send({ agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'take this over' });

    expect(res.status).toBe(202);
    expect(applySessionSteer).toHaveBeenCalledTimes(2);

    // 1. The operator's own words, with the claim named so the receiver knows
    //    the door is still locked and who holds the key.
    const [, toNew] = applySessionSteer.mock.calls[0]!;
    expect(toNew.text).toContain('take this over');
    expect(toNew.text).toContain('acme-pr-733');
    expect(toNew.text).toContain('do not `--takeover`');

    // 2. The holder's note — server-composed, never the operator's text.
    const [holderSession, toHolder] = applySessionSteer.mock.calls[1]!;
    expect(holderSession).toBe('s-alpha');
    expect(toHolder.text).not.toContain('take this over');
    expect(toHolder.text).toBe(composeReleaseNote({ who: 'Dana', newAgentName: 'ag-bravo', claimSlug: 'acme-pr-733' }));
    expect(toHolder.idempotency_key).toBe('k1:release-note');

    expect(res.body['handoff']).toEqual({
      claim_slug: 'acme-pr-733',
      claim_owner: 'ag-alpha',
      holder_agent_group_id: 'ag-alpha',
      notified: true,
    });
  });

  it('the holder’s note asks for park-or-release and names the exit-3 reason', () => {
    const note = composeReleaseNote({ who: 'Dana', newAgentName: 'Bravo', claimSlug: 'acme-pr-733' });
    expect(note).toContain('park');
    expect(note).toContain('release');
    expect(note).toContain('exit 3');
    expect(note).toContain('--takeover');
  });

  it('does not fire when the chosen agent IS the holder — nothing to hand over', async () => {
    writeClaim({ slug: 'acme-pr-733', owner: 'ag-alpha', ttlHours: 4, claimedAgoMs: 60_000 });
    const res = await send({ agent_group_id: 'ag-alpha', idempotency_key: 'k1', text: 'keep going' });
    expect(applySessionSteer).toHaveBeenCalledTimes(1);
    expect(applySessionSteer.mock.calls[0]![1].text).toContain('keep going');
    expect(applySessionSteer.mock.calls[0]![1].text).not.toContain('--takeover');
    expect(res.body['handoff']).toBeNull();
  });

  it('does not fire on a claim that is already free to take (past its TTL)', async () => {
    // `claim.sh take` only refuses a LIVE claim (exit 3). Past its TTL it is
    // takeable, so there is nobody to ask to let go.
    writeClaim({ slug: 'acme-pr-733', owner: 'ag-alpha', ttlHours: 1, claimedAgoMs: 3 * 3_600_000 });
    const res = await send({ agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'take it' });
    expect(applySessionSteer).toHaveBeenCalledTimes(1);
    expect(res.body['handoff']).toBeNull();
  });

  it('reports notified:false rather than failing when the holder cannot be reached', async () => {
    writeClaim({ slug: 'acme-pr-733', owner: 'ag-alpha', ttlHours: 4, claimedAgoMs: 60_000 });
    // The operator's message goes; the holder's note is refused (e.g. the
    // caller cannot steer that group). The send still succeeds and says so.
    applySessionSteer.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce({ status: 404, body: {} });

    const res = await send({ agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'take it' });

    expect(res.status).toBe(202);
    expect((res.body['handoff'] as { notified: boolean }).notified).toBe(false);
  });

  it('does not send the operator’s message twice if the first send is refused', async () => {
    writeClaim({ slug: 'acme-pr-733', owner: 'ag-alpha', ttlHours: 4, claimedAgoMs: 60_000 });
    applySessionSteer.mockResolvedValue({ status: 429, body: { error: 'rate_limit_exceeded' } });
    const res = await send({ agent_group_id: 'ag-bravo', idempotency_key: 'k1', text: 'take it' });
    expect(res.status).toBe(429);
    // No release note off the back of a message that never landed.
    expect(applySessionSteer).toHaveBeenCalledTimes(1);
  });
});

// ── Input ────────────────────────────────────────────────────────────────────

describe('input', () => {
  it('rejects an empty message and one longer than the cap', async () => {
    await seedAgent('ag-alpha');
    wire('ag-alpha');
    seedSession('s-alpha', 'ag-alpha');
    expect((await send({ agent_group_id: 'ag-alpha', idempotency_key: 'k1', text: '   ' })).status).toBe(400);
    const long = await send({
      agent_group_id: 'ag-alpha',
      idempotency_key: 'k1',
      text: 'x'.repeat(MAX_OPERATOR_TEXT + 1),
    });
    expect(long.status).toBe(400);
    expect(long.body['error']).toBe('message_too_long');
    expect(applySessionSteer).not.toHaveBeenCalled();
  });
});

// ── Attribution and the no-silence clause ────────────────────────────────────

/**
 * Ported from `nudge.ts` / `observatory-steer.ts` / `assign.ts`. The console
 * used to post the operator's bare text: no name on it, and no obligation to
 * answer. Both halves are load-bearing and both are asserted here.
 */
describe('the operator\u2019s words are wrapped, never replaced', () => {
  const wrapped = composeOperatorMessage({ who: 'Dana', text: 'drop it, ship the other one' });

  it('quotes the operator verbatim rather than paraphrasing them', () => {
    expect(wrapped).toContain('drop it, ship the other one');
    expect(wrapped).toContain('verbatim');
    // Inside a fenced block, so the agent can tell the instruction from the
    // frame around it.
    expect(wrapped).toMatch(/"""\ndrop it, ship the other one\n"""/);
  });

  it('attributes it to a named person, on the way in AND in the reply', () => {
    // assign.ts:113 — everyone in the room should know where this came from
    // without asking, which means the AGENT has to say it, not just receive it.
    expect(wrapped).toContain('Dana sent this from the Observatory');
    expect(wrapped).toContain('"Dana asked, via the Observatory');
  });

  it('closes with the no-silence clause', () => {
    expect(wrapped).toContain('If you cannot act on it, say so here and name what blocks you');
    expect(wrapped).toContain('ends in silence is the failure this button exists to end');
  });

  it('keeps the hand-over context between the quote and the closing obligation', () => {
    const withClaim = composeOperatorMessage({
      who: 'Dana',
      text: 'take this over',
      claimContext: '\n\n---\nCLAIM CONTEXT HERE',
    });
    expect(withClaim.indexOf('take this over')).toBeLessThan(withClaim.indexOf('CLAIM CONTEXT HERE'));
    expect(withClaim.indexOf('CLAIM CONTEXT HERE')).toBeLessThan(withClaim.indexOf('ends in silence'));
  });

  it('leaves the worst case inside the executor\u2019s own 4000-character cap', () => {
    // The reason MAX_OPERATOR_TEXT is derived rather than hand-picked: a text
    // this endpoint ACCEPTS must never fail downstream with a length error the
    // operator cannot account for.
    const long = 'x'.repeat(120);
    const worst = composeOperatorMessage({
      who: long,
      text: 'x'.repeat(MAX_OPERATOR_TEXT),
      claimContext: composeClaimContext({ who: long, claimSlug: long, holder: long }),
    });
    expect(MAX_OPERATOR_TEXT).toBeGreaterThan(1000);
    expect(worst.length).toBeLessThanOrEqual(4000);
  });
});

it.each(['shared', 'agent-shared'])('honors an explicit thread despite %s ingress wiring', async (mode) => {
  await seedAgent('ag-shared');
  wire('ag-shared', mode);
  seedSession('s-shared', 'ag-shared', null);
  if (mode === 'agent-shared') {
    getRawDb().prepare('UPDATE sessions SET messaging_group_id = NULL WHERE id = ?').run('s-shared');
  }
  const res = await send({ agent_group_id: 'ag-shared', idempotency_key: 'explicit-thread', text: 'reply here' });
  expect(res.status).toBe(202);
  const sessionId = applySessionSteer.mock.calls[0]![0];
  expect(sessionId).not.toBe('s-shared');
  expect(getRawDb().prepare('SELECT messaging_group_id, thread_id FROM sessions WHERE id = ?').get(sessionId)).toEqual({
    messaging_group_id: 'mg-1',
    thread_id: THREAD,
  });
  expect(getRawDb().prepare('SELECT thread_id FROM sessions WHERE id = ?').get('s-shared')).toEqual({
    thread_id: null,
  });
});
