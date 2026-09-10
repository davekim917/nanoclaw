import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withCentralSync } from '../db/central-lease.js';
import { createAgentGroup, getRawDb, initTestDb, runMigrations } from '../db/index.js';
import { ensureSchema } from '../modules/mailbox/schema.js';
import { guard } from '../guard/index.js';
import type { AuthedRequestContext } from './router.js';

// The close path calls into the container registry. Both are injected at the
// call sites the tests exercise; the mock only keeps the spawn path (docker,
// mounts, onecli) out of the module graph.
// Container ownership, mockable per READ so a case can model a wake landing
// between the finalizer's branch and the force-clear's own guard — the two
// places that ask. `queue` answers successive reads in order and then falls
// back to `value`. Every other case injects `deps.isContainerRunning` instead.
const containerOwns = vi.hoisted(() => ({ value: false, queue: [] as boolean[] }));

// One-shot hook that fires inside the proposal read — the await that used to
// straddle the membership snapshot. Lets a case add a sibling session mid-flight
// without any timing dependence.
const duringProposalRead = vi.hoisted(() => ({
  run: null as (() => void) | null,
  /** Reads to let pass untouched before firing — 0 means the very first one. */
  skip: 0,
}));

vi.mock('../modules/mailbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/mailbox/index.js')>();
  return {
    ...actual,
    // The SYNC funnel is what the decision path reads through now: the async
    // candidate pass was dead work whose only effect was an await window, and
    // removing it left this file's hooks firing on a pass that decided nothing.
    // Hooking here fires the mutation BETWEEN two per-session reads, which is
    // the window that genuinely remains — an independent container process
    // writing its own outbound.db while the host walks the set.
    withExistingNanoclawOutboundSync: (agentGroupId: string, sessionId: string, action: never) => {
      if (duringProposalRead.skip > 0) {
        duringProposalRead.skip -= 1;
      } else {
        const hook = duringProposalRead.run;
        duringProposalRead.run = null;
        hook?.();
      }
      return actual.withExistingNanoclawOutboundSync(agentGroupId, sessionId, action);
    },
  };
});

// The same shape one step later in the close: the wrap-up fan-out awaits per
// session, so a session named by the frozen set can close or move off the
// thread while an earlier sibling's mailbox is open. Fires inside the funnel
// for `whenOpening`, before that session's own write. Same seam as
// `raceCloses` in src/db/scheduled-tasks.test.ts; inert unless armed.
const raceDuringWrapUp = vi.hoisted(() => ({
  whenOpening: null as string | null,
  run: null as (() => void) | null,
}));

vi.mock('../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      if (raceDuringWrapUp.whenOpening === sessionId) {
        raceDuringWrapUp.whenOpening = null;
        const hook = raceDuringWrapUp.run;
        raceDuringWrapUp.run = null;
        hook?.();
      }
      return actual.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

// Spread the real module so exports this suite doesn't assert on —
// `sessionStillActive` isn't reached today, but staying wired means a future
// caller that reaches for it doesn't throw "no such export" the way #291's
// guard conversion did to four other suites.
vi.mock('../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: () => false,
    containerOwnsOutbound: () => (containerOwns.queue.length > 0 ? containerOwns.queue.shift()! : containerOwns.value),
    killContainer: () => {},
    getActiveContainerSessionIds: () => [],
    resolveAssistantName: (group: { name: string }) => Promise.resolve(group.name),
  };
});

// Point DATA_DIR at a scratch tree so the wrap-up write and the REAL
// force-clear run against real SQLite files through the mailbox seam, not
// stubs. The close path opens its own short mailbox sessions now (mailbox seam
// PR 4), and the mailbox derives every path from DATA_DIR — so redirecting the
// data root is what redirects the opens.
// Hoisted, and pid-derived rather than mkdtemp'd: vi.mock's factory is lifted
// above every module-level initializer, so the value it closes over has to
// come from vi.hoisted, and that factory runs before the `fs`/`os` imports are
// initialized. One root per process is all this needs — the same reasoning as
// session-manager.test.ts's TEST_DATA_DIR, and it keeps two concurrent runs
// from any two worktrees out of each other's session directories.
const { SESSIONS_ROOT } = vi.hoisted(() => ({
  SESSIONS_ROOT: `/tmp/nc-thread-close-${process.pid}`,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: SESSIONS_ROOT,
}));

fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const dbPathFor = (agentGroupId: string, sessionId: string, file: string) =>
  path.join(SESSIONS_ROOT, 'v2-sessions', agentGroupId, sessionId, file);

/** Create the on-disk session DBs the close path expects, with the REAL schemas. */
function materializeSession(agentGroupId: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(dbPathFor(agentGroupId, sessionId, 'inbound.db')), { recursive: true });
  ensureSchema(dbPathFor(agentGroupId, sessionId, 'inbound.db'), 'inbound');
  ensureSchema(dbPathFor(agentGroupId, sessionId, 'outbound.db'), 'outbound');
}

import { log } from '../log.js';
import { parseDirectOutboundWrite } from '../mailbox/model.js';
import { clearWorkContinuation, insertTaskRow } from '../modules/mailbox/index.js';
import { withExistingMailboxSession } from '../session-manager.js';
import {
  CLOSE_CONFIRM_WINDOW_MS,
  advanceThreadClosures,
  composeCloseWrapUp,
  decideCloseFinalization,
  readDoneProposal,
  readThreadClosures,
  requestThreadClose,
  syncDoneProposalMirror,
  type ThreadCloseDeps,
} from './thread-close.js';
import { requiredConfirmations, threadsClose } from './thread-close-guard.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function ctxFor(userId: string, opts: { no_filter?: boolean; allowed?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: userId, created_at: iso(0) },
    scopes: {
      role: opts.no_filter === false ? 'admin_of_group' : 'owner',
      allowed_group_ids: opts.allowed ?? [],
      no_filter: opts.no_filter ?? true,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

async function seed(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  await createAgentGroup({ id: 'ag1', name: 'ag1', folder: 'ag1', agent_provider: null, created_at: iso(0) });
  await createAgentGroup({ id: 'ag2', name: 'ag2', folder: 'ag2', agent_provider: null, created_at: iso(0) });
  db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('admin', 'dashboard', 'admin', ?)`).run(
    iso(0),
  );
  db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('nobody', 'dashboard', 'nobody', ?)`).run(
    iso(0),
  );
  db.prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES ('admin', 'owner', NULL, NULL, ?)`,
  ).run(iso(0));
}

function insertSession(id: string, agentGroupId: string, threadId: string | null): void {
  getRawDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status,
                             last_active, last_outbound_at, created_at)
       VALUES (?, ?, NULL, ?, 'active', 'stopped', ?, ?, ?)`,
    )
    .run(id, agentGroupId, threadId, iso(60_000), iso(60_000), iso(3_600_000));
}

/** A bare outbound.db with just the table the continuation record lives in. */
function outboundStub(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  return db;
}

beforeEach(async () => {
  containerOwns.value = false;
  containerOwns.queue = [];
  duringProposalRead.run = null;
  duringProposalRead.skip = 0;
  raceDuringWrapUp.whenOpening = null;
  raceDuringWrapUp.run = null;
  await seed();
});

// ── The guard ────────────────────────────────────────────────────────────────

describe('threads.close guard', () => {
  // The guard's role reads are lease-only (seam 3 §4.5 I-1): the production
  // caller consults it inside `withCentralSync`, so the test does the same.
  const consult = (over: Record<string, unknown> = {}, userId = 'admin') =>
    withCentralSync(
      () =>
        guard(threadsClose, {
          actor: { kind: 'human', userId },
          payload: { agentGroupIds: ['ag1'], agentProposed: false, confirmations: 2, ...over },
        }),
      'test consult',
    );

  it('an agent-proposed close needs one confirmation, an operator-initiated one needs two', async () => {
    expect(requiredConfirmations(true)).toBe(1);
    expect(requiredConfirmations(false)).toBe(2);
    expect((await consult({ agentProposed: true, confirmations: 1 })).effect).toBe('allow');
    // The distinction lives in the guard, so a UI cannot collapse the two.
    expect((await consult({ agentProposed: false, confirmations: 1 })).effect).toBe('deny');
    expect((await consult({ agentProposed: false, confirmations: 2 })).effect).toBe('allow');
  });

  it('names the missing confirmation count so the surface can say so honestly', async () => {
    const denial = await consult({ agentProposed: false, confirmations: 0 });
    expect(denial.effect).toBe('deny');
    expect(denial.reason).toContain('2 explicit operator confirmation');
    expect(denial.reason).toContain('no agent has proposed');
  });

  it('refuses a non-human actor — an agent may propose, never close', async () => {
    for (const actor of [
      { kind: 'agent' as const, agentGroupId: 'ag1' },
      { kind: 'host' as const },
      { kind: 'system' as const },
    ]) {
      expect(
        (
          await withCentralSync(
            () =>
              guard(threadsClose, {
                actor,
                payload: { agentGroupIds: ['ag1'], agentProposed: true, confirmations: 9 },
              }),
            'test consult',
          )
        ).effect,
      ).toBe('deny');
    }
  });

  it('refuses a caller with no admin privilege on any agent group backing the thread', async () => {
    expect((await consult({}, 'nobody')).effect).toBe('deny');
    expect((await consult({ agentGroupIds: [] })).effect).toBe('deny');
  });

  it('never holds — closure has no approval path and therefore no settle-by-silence', async () => {
    expect(threadsClose.grantActionName).toBeUndefined();
    for (const confirmations of [0, 1, 2, 3]) {
      expect((await consult({ confirmations })).effect).not.toBe('hold');
    }
  });

  // ── Live task series (#601) ────────────────────────────────────────────────

  it('denies a close when a session behind the thread backs a live task series, naming it and the fix', async () => {
    const denial = await consult({ liveTaskSeriesIds: ['weekly-smoke-sweep'], confirmations: 2 });
    expect(denial.effect).toBe('deny');
    expect(denial.reason).toContain('weekly-smoke-sweep');
    expect(denial.reason).toContain('ncl tasks cancel --id <series>');
    expect(denial.reason).toContain('ncl tasks pause --id <series>');
  });

  it('names every series when more than one live series is behind the thread', async () => {
    const denial = await consult({ liveTaskSeriesIds: ['series-a', 'series-b'], confirmations: 2 });
    expect(denial.effect).toBe('deny');
    expect(denial.reason).toContain('series-a');
    expect(denial.reason).toContain('series-b');
  });

  it('the live-series deny is not satisfied by more confirmations — it is a hard block', async () => {
    // Two is already the max requiredConfirmations ever asks for; a live
    // series must still deny, because no confirmation count fixes it.
    expect((await consult({ liveTaskSeriesIds: ['s'], confirmations: 2, agentProposed: true })).effect).toBe('deny');
  });

  it('threads with no live task series are unaffected — empty or absent both allow normally', async () => {
    expect((await consult({ liveTaskSeriesIds: [] })).effect).toBe('allow');
    expect((await consult({})).effect).toBe('allow');
  });
});

// ── Phase 1: the request ─────────────────────────────────────────────────────

describe('requestThreadClose', () => {
  beforeEach(() => insertSession('s1', 'ag1', 'slack:C1:1.1'));

  it('refuses a one-click close of a thread no agent has proposed, and says how many are needed', async () => {
    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 1 }, ctxFor('admin'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'confirmation_required',
      required_confirmations: 2,
      agent_proposed: false,
    });
    // Nothing was started.
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_closures').get()).toMatchObject({ n: 0 });
  });

  it('records the close and freezes the fan-out on two confirmations', async () => {
    insertSession('s2', 'ag2', 'slack:C1:1.1');
    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 2, reason: 'shipped' }, ctxFor('admin'));
    expect(res.status).toBe(202);
    const row = getRawDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get('slack:C1:1.1') as {
      state: string;
      requested_by: string;
      session_ids: string;
      agent_proposed: number;
      reason: string;
    };
    expect(row.state).toBe('awaiting_confirmation');
    expect(row.requested_by).toBe('admin');
    expect(row.reason).toBe('shipped');
    expect(row.agent_proposed).toBe(0);
    expect(new Set(JSON.parse(row.session_ids) as string[])).toEqual(new Set(['s1', 's2']));
    expect((await readThreadClosures(['slack:C1:1.1'])).get('slack:C1:1.1')).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  /**
   * The outbound-only cohort: inbound.db gone, outbound.db present and holding
   * a live `propose_done`.
   *
   * The proposal read is outbound-owned, so gating it on inbound.db's
   * existence made a standing proposal read as absent. That is not merely
   * stricter — the operator is billed a second confirmation, and the record
   * says the agent never proposed.
   */
  it('reads a done proposal from outbound.db when inbound.db is gone', async () => {
    fs.rmSync(path.dirname(dbPathFor('ag1', 's1', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's1');
    const out = new Database(dbPathFor('ag1', 's1', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('done_proposal', JSON.stringify({ reason: 'wrapped up', proposed_at: iso(0) }), iso(0));
    out.close();
    // The host-owned half is gone; the container's half is not.
    fs.rmSync(dbPathFor('ag1', 's1', 'inbound.db'));

    // ONE confirmation is enough when the agent has proposed. Through the
    // inbound-keyed funnel this was a 409 asking for two.
    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 1 }, ctxFor('admin'));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ agent_proposed: true });
    expect(
      getRawDb().prepare('SELECT agent_proposed FROM thread_closures WHERE thread_id = ?').get('slack:C1:1.1'),
    ).toMatchObject({ agent_proposed: 1 });
  });

  /**
   * A proposal retracted before the decision's read must not buy the close.
   *
   * The sampling is now one synchronous sweep with nothing awaited between it
   * and the decision, so any retraction that lands before a session's own read
   * is seen. That is the guarantee a host process can actually make.
   *
   * What it deliberately does NOT claim: a container clearing `done_proposal`
   * AFTER the host has read that session's file but before it reads a sibling's
   * is not caught, and cannot be. The container is an independent OS process
   * writing its own `outbound.db`; no host-side read is atomic with respect to
   * it. That residual window is the runner's admission gate to close, not this
   * function's — see the round-14 disposition.
   */
  it('does not count a proposal retracted before the decision reads it', async () => {
    const THREAD_RETRACT = 'slack:C1:retract';
    // Two agent groups, because one thread may hold only one active session per
    // group. Two sessions is the whole point: the fan-out has to have a sibling
    // still outstanding when the first one retracts.
    for (const [group, id] of [
      ['ag1', 's-retractor'],
      ['ag2', 's-sibling'],
    ] as const) {
      insertSession(id, group, THREAD_RETRACT);
      fs.rmSync(path.dirname(dbPathFor(group, id, 'inbound.db')), { recursive: true, force: true });
      materializeSession(group, id);
      // ONLY the retractor proposes. The sibling exists to keep a read
      // outstanding while the retractor's has already resolved — if it also
      // proposed, its standing proposal would legitimately buy the cheap bar
      // and the case would prove nothing.
      if (id !== 's-retractor') continue;
      const out = new Database(dbPathFor(group, id, 'outbound.db'));
      out
        .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('done_proposal', JSON.stringify({ reason: 'done', proposed_at: iso(0) }), iso(0));
      out.close();
    }

    // Fires as the retractor's own read is taken, so the cleared proposal is
    // what the decision sees. A cached value from an earlier pass would buy the
    // cheap bar here over an agent that is back at work.
    duringProposalRead.run = () => {
      const db = new Database(dbPathFor('ag1', 's-retractor', 'outbound.db'));
      db.prepare("DELETE FROM session_state WHERE key = 'done_proposal'").run();
      db.close();
    };

    // ONE confirmation, which only a standing proposal can buy.
    const res = await requestThreadClose(THREAD_RETRACT, { confirmations: 1 }, ctxFor('admin'));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'confirmation_required',
      required_confirmations: 2,
      agent_proposed: false,
    });
    expect(getRawDb().prepare('SELECT 1 FROM thread_closures WHERE thread_id = ?').get(THREAD_RETRACT)).toBeUndefined();
  });

  /**
   * The privilege check has to be made against the sessions actually closed.
   *
   * The decision used to be made twice — once on the pre-await visible set,
   * again only when the proposer had dropped — so a fresh set the caller does
   * not administer could still ride the first decision's `allow`. Two
   * confirmations then reserved a close over an agent group the caller holds
   * no privilege over, which is the escalation the guard exists to stop.
   *
   * There is one decision now, after the last await, on the fresh set.
   */
  it('refuses when the only group the caller administers leaves during the proposal reads', async () => {
    const THREAD_ESC = 'slack:C1:escalate';
    // A caller who administers ag1 and nothing else.
    getRawDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('scoped', 'dashboard', 'scoped', ?)`)
      .run(iso(0));
    getRawDb()
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
         VALUES ('scoped', 'admin', 'ag1', NULL, ?)`,
      )
      .run(iso(0));
    insertSession('s-admin', 'ag1', THREAD_ESC);
    fs.rmSync(path.dirname(dbPathFor('ag1', 's-admin', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's-admin');

    // The ag1 session leaves and an ag2 session joins, both inside the reads.
    duringProposalRead.run = () => {
      getRawDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = 's-admin'").run();
      insertSession('s-other-group', 'ag2', THREAD_ESC);
    };

    // Two confirmations — enough for any thread this caller may close.
    const res = await requestThreadClose(THREAD_ESC, { confirmations: 2 }, ctxFor('scoped'));

    // Refused, and as a not-found: the surface must not disclose the thread.
    expect(res.status).toBe(404);
    // Nothing reserved. Without one decision on the fresh set this was a 202.
    expect(getRawDb().prepare('SELECT 1 FROM thread_closures WHERE thread_id = ?').get(THREAD_ESC)).toBeUndefined();
  });

  /**
   * What the operator is told and what the record says must be the same value.
   *
   * The row persisted the recomputed proposal status while the response and the
   * request log reported the pre-await one. An operator confirming a close was
   * told an agent had proposed it, over a record that says none did.
   */
  it('reports the same proposal status it persists when the proposer leaves', async () => {
    const THREAD_R = 'slack:C1:report';
    insertSession('s-prop', 'ag1', THREAD_R);
    insertSession('s-stay2', 'ag2', THREAD_R);
    for (const [ag, id] of [
      ['ag1', 's-prop'],
      ['ag2', 's-stay2'],
    ] as const) {
      fs.rmSync(path.dirname(dbPathFor(ag, id, 'inbound.db')), { recursive: true, force: true });
      materializeSession(ag, id);
    }
    const out = new Database(dbPathFor('ag1', 's-prop', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('done_proposal', JSON.stringify({ reason: 'done', proposed_at: iso(0) }), iso(0));
    out.close();

    duringProposalRead.run = () => {
      getRawDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = 's-prop'").run();
    };

    // TWO confirmations, so the close still succeeds — this pins what is
    // REPORTED, not whether it is allowed.
    const res = await requestThreadClose(THREAD_R, { confirmations: 2 }, ctxFor('admin'));

    expect(res.status).toBe(202);
    // The proposal left with the session that made it. Reported false…
    expect(res.body.agent_proposed).toBe(false);
    // …and the record agrees. These used to disagree.
    expect(
      getRawDb().prepare('SELECT agent_proposed FROM thread_closures WHERE thread_id = ?').get(THREAD_R),
    ).toMatchObject({ agent_proposed: 0 });
  });

  /**
   * The proposal that bought the cheaper bar must still be on the thread.
   *
   * `agentProposed` is computed from the pre-await visible set and decides
   * `requiredConfirmations` — one click when an agent has proposed, two when
   * none has. If the ONLY proposing session goes inactive during the proposal
   * reads, the fresh membership read drops it while a bare boolean still says
   * a proposal stands, and the operator gets a one-click force-close of
   * sessions that never proposed anything. Round 6 recorded this direction as
   * "only stricter"; it is not.
   */
  it('refuses the one-click close when the only proposing session leaves during the read', async () => {
    const THREAD_P = 'slack:C1:proposer';
    insertSession('s-proposer', 'ag1', THREAD_P);
    insertSession('s-other', 'ag2', THREAD_P);
    for (const [ag, id] of [
      ['ag1', 's-proposer'],
      ['ag2', 's-other'],
    ] as const) {
      fs.rmSync(path.dirname(dbPathFor(ag, id, 'inbound.db')), { recursive: true, force: true });
      materializeSession(ag, id);
    }
    // Only s-proposer has a standing proposal.
    const out = new Database(dbPathFor('ag1', 's-proposer', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('done_proposal', JSON.stringify({ reason: 'wrapped up', proposed_at: iso(0) }), iso(0));
    out.close();

    // It goes inactive inside the proposal reads, after the visible set was
    // taken and before membership is re-read.
    duringProposalRead.run = () => {
      getRawDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = 's-proposer'").run();
    };

    const res = await requestThreadClose(THREAD_P, { confirmations: 1 }, ctxFor('admin'));

    // One confirmation no longer buys the close: the proposal left with the
    // session that made it. Without the recompute this was a 202.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'confirmation_required',
      required_confirmations: 2,
      agent_proposed: false,
    });
    // And nothing was reserved.
    expect(getRawDb().prepare('SELECT 1 FROM thread_closures WHERE thread_id = ?').get(THREAD_P)).toBeUndefined();
  });

  /**
   * Thread membership must be re-read immediately before it is frozen.
   *
   * The visible-session list was computed before the proposal reads, which
   * await. A sibling session joining the thread during that yield was frozen
   * out of the reservation, so it never received a wrap-up and was never
   * finalized — the operator closes the thread and one agent keeps working.
   */
  it('includes a sibling that joins the thread during the proposal read', async () => {
    // The join lands inside the await that used to straddle the snapshot.
    duringProposalRead.run = () => insertSession('s-late', 'ag2', 'slack:C1:1.1');

    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 2, reason: 'wrap' }, ctxFor('admin'));

    expect(res.status).toBe(202);
    expect(new Set(res.body.session_ids as string[])).toEqual(new Set(['s1', 's-late']));
    const row = getRawDb()
      .prepare('SELECT session_ids FROM thread_closures WHERE thread_id = ?')
      .get('slack:C1:1.1') as {
      session_ids: string;
    };
    expect(new Set(JSON.parse(row.session_ids) as string[])).toEqual(new Set(['s1', 's-late']));
  });

  it('collapses an unknown thread and an unprivileged caller into the same 404', async () => {
    expect((await requestThreadClose('slack:C1:nope', { confirmations: 2 }, ctxFor('admin'))).status).toBe(404);
    expect((await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('nobody'))).status).toBe(404);
    // Out of scope reads as absent too.
    expect(
      (await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin', { no_filter: false }))).status,
    ).toBe(404);
  });

  it('refuses a thread that reaches agents the caller cannot see, rather than half-closing it', async () => {
    insertSession('s2', 'ag2', 'slack:C1:1.1');
    const res = await requestThreadClose(
      'slack:C1:1.1',
      { confirmations: 2 },
      ctxFor('admin', { no_filter: false, allowed: ['ag1'] }),
    );
    // Closing only the visible half would either lie about the thread being
    // closed or stop a container in a group this caller has no privilege over.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'thread_extends_beyond_your_scope' });
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_closures').get()).toMatchObject({ n: 0 });
  });

  it('refuses a second close while one is in flight', async () => {
    await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin'));
    const again = await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin'));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'close_already_in_progress' });
  });

  /**
   * Two overlapping requests must produce ONE closure and ONE wrap-up.
   *
   * The `thread_closures` check and the reservation are no longer in the same
   * synchronous step: `readSessionProposal` awaits since it moved behind the
   * mailbox seam. Both calls below therefore run to that await before either
   * writes — no timers or fakes needed, just not awaiting the first before
   * starting the second, which is exactly a double-click.
   *
   * With an unconditional upsert both answered 202, both fanned out a wrap-up,
   * and the second silently took over the first's actor, reason and
   * confirmation window.
   *
   * Its own thread and session: this case materializes a mailbox and writes to
   * it, and the scratch root is shared across the file's cases.
   */
  it('reserves the closure atomically, so two overlapping requests do not both win', async () => {
    const THREAD_RACE = 'slack:C1:race';
    insertSession('s-race', 'ag1', THREAD_RACE);
    fs.rmSync(path.dirname(dbPathFor('ag1', 's-race', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's-race');

    // Not awaited between the two — both reach the proposal read and yield
    // before either reserves.
    const first = requestThreadClose(THREAD_RACE, { confirmations: 2, reason: 'first' }, ctxFor('admin'));
    const second = requestThreadClose(THREAD_RACE, { confirmations: 2, reason: 'second' }, ctxFor('admin'));
    const [a, b] = await Promise.all([first, second]);

    // Exactly one winner, and the loser gets the in-flight refusal. Before the
    // atomic reservation this was [202, 202].
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const winner = a.status === 202 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(loser.body).toMatchObject({ error: 'close_already_in_progress' });

    // One closure, holding the winner's request — the loser did not overwrite
    // it, and the loser reports the winner's timestamp back.
    expect(
      getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_closures WHERE thread_id = ?').get(THREAD_RACE),
    ).toMatchObject({
      n: 1,
    });
    const row = getRawDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(THREAD_RACE) as {
      requested_at: string;
      reason: string;
      state: string;
    };
    expect(row.state).toBe('awaiting_confirmation');
    expect(row.requested_at).toBe(winner.body.requested_at);
    expect(loser.body.requested_at).toBe(row.requested_at);
    expect(['first', 'second']).toContain(row.reason);

    // And one request means one wrap-up: the loser never reached the fan-out.
    const inbound = new Database(dbPathFor('ag1', 's-race', 'inbound.db'), { readonly: true });
    const wrapUps = inbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind = 'system'").get() as {
      n: number;
    };
    inbound.close();
    expect(wrapUps.n).toBe(1);
  });

  it('lands the wrap-up as a real deferred system row the running container will see', async () => {
    materializeSession('ag1', 's1');
    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin'));
    expect(res.body).toMatchObject({ wrap_up_delivered: 1 });

    const inbound = new Database(dbPathFor('ag1', 's1', 'inbound.db'), { readonly: true });
    const rows = inbound.prepare('SELECT id, kind, content, on_wake, trigger FROM messages_in ORDER BY seq').all() as {
      id: string;
      kind: string;
      content: string;
      on_wake: number;
      trigger: number;
    }[];
    inbound.close();
    // The established shape: an inert recall marker plus the deferred trigger.
    expect(rows.map((r) => r.kind)).toEqual(['system', 'chat']);
    const trigger = rows[1]!;
    expect(trigger.id).toContain('thread-close-s1-');
    // onWake 0 — the container running RIGHT NOW is who this is for.
    expect(trigger.on_wake).toBe(0);
    const content = JSON.parse(trigger.content) as { sender: string; text: string; _system: { kind: string } };
    expect(content.sender).toBe('system');
    expect(content._system.kind).toBe('thread_close_wrap_up');
    expect(content.text).toContain('propose_done');
  });

  /**
   * Membership is re-asked per session, inside the funnel.
   *
   * The frozen set is sampled once and the fan-out awaits per session, so by
   * the time a later sibling's mailbox opens, the snapshot can name a session
   * that has since closed or moved off the thread. Writing to it anyway asks
   * an agent to wrap up work for a thread it is no longer on — the
   * "who told you that?" shape — and inflates the delivered count the operator
   * is shown into a claim about a session that was never asked.
   *
   * Its own thread and sessions: this case materializes mailboxes and writes
   * to them, and the scratch root is shared across the file's cases.
   */
  it('skips a session that leaves the thread while an earlier sibling is being written', async () => {
    const THREAD_LEAVE = 'slack:C1:leave';
    insertSession('s-stay', 'ag1', THREAD_LEAVE);
    insertSession('s-leave', 'ag2', THREAD_LEAVE);
    for (const [ag, id] of [
      ['ag1', 's-stay'],
      ['ag2', 's-leave'],
    ] as const) {
      fs.rmSync(path.dirname(dbPathFor(ag, id, 'inbound.db')), { recursive: true, force: true });
      materializeSession(ag, id);
    }

    // s-leave closes while s-stay's mailbox is open — after the set was
    // frozen, before s-leave's own write.
    raceDuringWrapUp.whenOpening = 's-stay';
    raceDuringWrapUp.run = () => {
      getRawDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = 's-leave'").run();
    };

    const res = await requestThreadClose(THREAD_LEAVE, { confirmations: 2 }, ctxFor('admin'));

    expect(res.status).toBe(202);
    // Both were frozen into the closure — that set is deliberately not
    // re-narrowed — but only the one still on the thread was asked.
    expect(new Set(res.body.session_ids as string[])).toEqual(new Set(['s-stay', 's-leave']));
    // Without the in-funnel re-check this was 2.
    expect(res.body.wrap_up_delivered).toBe(1);

    const countRows = (ag: string, id: string): number => {
      const db = new Database(dbPathFor(ag, id, 'inbound.db'), { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number };
      db.close();
      return row.n;
    };
    // The recall marker plus the deferred trigger for the session still there…
    expect(countRows('ag1', 's-stay')).toBe(2);
    // …and nothing at all for the one that left.
    expect(countRows('ag2', 's-leave')).toBe(0);
  });

  /**
   * Due-ness travels with the row.
   *
   * The wrap-up is a deferred trigger row, and the sweep's quiet cache and the
   * delivery sweep's activity horizon both key on `last_active`. Written into
   * a quiet session without a bump, it sits unseen until the cache expires —
   * the wake the row triggers would bump it, but not until the wake happens,
   * and that insert-to-wake window is the gap. Asserted here as a stamp that
   * moves forward synchronously with the insert, not as a wake that arrives.
   */
  it('bumps the session activity stamp with the wrap-up insert', async () => {
    const THREAD_DUE = 'slack:C1:due';
    insertSession('s-due', 'ag1', THREAD_DUE);
    fs.rmSync(path.dirname(dbPathFor('ag1', 's-due', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's-due');

    const stampOf = (): string =>
      (getRawDb().prepare('SELECT last_active FROM sessions WHERE id = ?').get('s-due') as { last_active: string })
        .last_active;
    const before = stampOf();

    const res = await requestThreadClose(THREAD_DUE, { confirmations: 2 }, ctxFor('admin'));
    expect(res.status).toBe(202);
    expect(res.body.wrap_up_delivered).toBe(1);

    // Strictly forward, and the row it accounts for really landed.
    expect(stampOf() > before).toBe(true);
    const db = new Database(dbPathFor('ag1', 's-due', 'inbound.db'), { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
    db.close();
    expect(n).toBe(2);
  });

  it('the wrap-up asks for the confirmation and names the deadline', async () => {
    const text = composeCloseWrapUp({ who: 'the operator', reason: 'shipped', windowMinutes: 10 });
    expect(text).toContain('asked to close this thread');
    expect(text).toContain('cancel_continuation');
    expect(text).toContain('propose_done');
    expect(text).toContain('10 minutes');
  });
});

// ── Live task series end to end (#601) ───────────────────────────────────────
//
// A per-series task thread (`system:tasks:<seriesId>`) is 1:1 with its
// session (`src/session-manager.ts:409`, `src/delivery.ts:1382`) — exactly
// the shape that stranded a series in production (#601's report): the close
// archived the session, the series stayed `pending`, and every fire refused
// with "session is archived" forever after. These exercise the real
// wiring — `decideClosure`'s synchronous `listLiveTaskRows()` read over a
// materialized inbound.db, through to the HTTP-level outcome — not just the
// guard's own `decide`.
describe('requestThreadClose — live task series (#601)', () => {
  const THREAD_TASK = 'system:tasks:weekly-smoke-sweep';

  function materializeTaskSession(sessionId: string): void {
    insertSession(sessionId, 'ag1', THREAD_TASK);
    fs.rmSync(path.dirname(dbPathFor('ag1', sessionId, 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', sessionId);
  }

  /** One task row, in the state a real `ncl tasks`-created series leaves it. */
  function seedTaskRow(sessionId: string, status: 'pending' | 'paused'): void {
    const db = new Database(dbPathFor('ag1', sessionId, 'inbound.db'));
    insertTaskRow(db, {
      id: 'weekly-smoke-sweep',
      seriesId: 'weekly-smoke-sweep',
      processAfter: iso(-3_600_000),
      recurrence: '0 9 * * 1',
      content: JSON.stringify({ prompt: 'run the weekly smoke sweep' }),
      status,
    });
    db.close();
  }

  it('denies closing the thread while its series is pending, and reserves nothing', async () => {
    materializeTaskSession('s-task-live');
    seedTaskRow('s-task-live', 'pending');

    const res = await requestThreadClose(THREAD_TASK, { confirmations: 2 }, ctxFor('admin'));

    // Same collapse-to-404 every non-confirmation guard deny takes on this
    // surface (see 'refuses a caller with no admin privilege…' above) — the
    // acceptance bullet's "the denial names the series" is the guard's own
    // DENY reason, asserted directly against `decide` above; this asserts the
    // close itself never proceeds.
    expect(res.status).toBe(404);
    expect(getRawDb().prepare('SELECT 1 FROM thread_closures WHERE thread_id = ?').get(THREAD_TASK)).toBeUndefined();
  });

  it('denies while the series is only paused — paused is still live', async () => {
    materializeTaskSession('s-task-paused');
    seedTaskRow('s-task-paused', 'paused');

    const res = await requestThreadClose(THREAD_TASK, { confirmations: 2 }, ctxFor('admin'));
    expect(res.status).toBe(404);
  });

  it('succeeds once the series is cancelled first', async () => {
    materializeTaskSession('s-task-cancelled');
    seedTaskRow('s-task-cancelled', 'pending');
    const db = new Database(dbPathFor('ag1', 's-task-cancelled', 'inbound.db'));
    db.prepare("UPDATE messages_in SET status = 'cancelled' WHERE series_id = ?").run('weekly-smoke-sweep');
    db.close();

    const res = await requestThreadClose(THREAD_TASK, { confirmations: 2 }, ctxFor('admin'));
    expect(res.status).toBe(202);
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD_TASK)).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  it('an ordinary thread with no task series at all is unaffected', async () => {
    const THREAD_CHAT = 'slack:C1:no-task-series';
    insertSession('s-chat-only', 'ag1', THREAD_CHAT);
    fs.rmSync(path.dirname(dbPathFor('ag1', 's-chat-only', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's-chat-only');

    const res = await requestThreadClose(THREAD_CHAT, { confirmations: 2 }, ctxFor('admin'));
    expect(res.status).toBe(202);
  });
});

// ── The confirmation rule ────────────────────────────────────────────────────

describe('decideCloseFinalization', () => {
  const requestedAtMs = NOW - 60_000;

  it('waits while the agent has not answered and the window is open', async () => {
    expect(decideCloseFinalization({ requestedAtMs, now: NOW, proposalAtMs: [null] })).toEqual({ finalize: false });
  });

  it('a proposal that predates the request is not an answer to it', async () => {
    // This is the proposal that made the close a ONE-confirmation close.
    // Counting it again as the agent's wrap-up confirmation would mean the
    // agent never answered anything.
    expect(decideCloseFinalization({ requestedAtMs, now: NOW, proposalAtMs: [requestedAtMs - 1] })).toEqual({
      finalize: false,
    });
  });

  it('finalizes unforced once every session has answered', async () => {
    expect(decideCloseFinalization({ requestedAtMs, now: NOW, proposalAtMs: [NOW - 10, NOW - 5] })).toEqual({
      finalize: true,
      forced: false,
    });
    // One silent participant is enough to keep waiting.
    expect(decideCloseFinalization({ requestedAtMs, now: NOW, proposalAtMs: [NOW - 10, null] })).toEqual({
      finalize: false,
    });
  });

  it('finalizes forced once the bounded window elapses, and only then', async () => {
    const justInside = requestedAtMs + CLOSE_CONFIRM_WINDOW_MS - 1;
    expect(decideCloseFinalization({ requestedAtMs, now: justInside, proposalAtMs: [null] })).toEqual({
      finalize: false,
    });
    expect(decideCloseFinalization({ requestedAtMs, now: justInside + 1, proposalAtMs: [null] })).toEqual({
      finalize: true,
      forced: true,
    });
  });
});

// ── Phase 2: the ordering invariant ──────────────────────────────────────────

describe('the close sequence order', () => {
  const THREAD = 'slack:C1:1.1';

  function startClose(over: { requestedAt?: string } = {}): void {
    insertSession('s1', 'ag1', THREAD);
    getRawDb()
      .prepare(
        `INSERT INTO thread_closures (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state)
         VALUES (?, 'admin', ?, NULL, 0, '["s1"]', 'awaiting_confirmation')`,
      )
      .run(THREAD, over.requestedAt ?? iso(CLOSE_CONFIRM_WINDOW_MS + 1_000));
  }

  function recordingDeps(build: Partial<ThreadCloseDeps> | ((calls: string[]) => Partial<ThreadCloseDeps>) = {}): {
    calls: string[];
    deps: ThreadCloseDeps;
  } {
    const calls: string[] = [];
    const over = typeof build === 'function' ? build(calls) : build;
    // Ownership is now re-sampled AFTER the kill, so the stub has to model what
    // the real registry does: `killContainer`'s onExit fires once the process
    // is gone, and `isContainerRunning` is false from then on. A constant
    // `true` would claim the container survived its own kill.
    const live = { owned: true };
    return {
      calls,
      deps: {
        now: NOW,
        isContainerRunning: () => live.owned,
        readProposal: () => null,
        clearContinuation: () => {
          calls.push('clear');
          return true;
        },
        killContainer: (_id, _reason, onExit) => {
          calls.push('kill');
          live.owned = false;
          onExit?.();
        },
        archiveSession: (id) => {
          calls.push('archive');
          return getRawDb().prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(iso(0), id).changes > 0;
        },
        ...over,
      },
    };
  }

  it('kills first, then clears once the process is gone, then archives', async () => {
    startClose();
    const { calls, deps } = recordingDeps();
    await advanceThreadClosures(deps);
    // The ordering INVERTED deliberately. It used to clear before the kill, to
    // stop the dying container's promise surviving. But `outbound.db` has one
    // writer, and clearing while the container still owns it is a host write
    // under a live writer. Clearing AFTER `onExit` serves the same concern
    // better: a continuation persisted during the SIGTERM grace is cleared
    // rather than raced.
    expect(calls).toEqual(['kill', 'clear', 'archive']);
    expect(calls.indexOf('kill')).toBeLessThan(calls.indexOf('clear'));
    expect(calls.indexOf('clear')).toBeLessThan(calls.indexOf('archive'));
  });

  it('does NOT archive when the continuation cannot be cleared, and retries next tick', async () => {
    startClose();
    const { calls, deps } = recordingDeps((recorded) => ({
      clearContinuation: () => {
        recorded.push('clear');
        return false;
      },
    }));
    await advanceThreadClosures(deps);
    // The kill now precedes the clear, so it has already happened; what a
    // failed clear withholds is the ARCHIVE. The closure stays `finalizing`
    // and the next tick retries — against a container that is now stopped.
    expect(calls).toEqual(['kill', 'clear']);
    expect(getRawDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s1')).toMatchObject({
      archived_at: null,
    });
  });

  it('skips the kill for a session with no container but still clears and archives', async () => {
    startClose();
    const { calls, deps } = recordingDeps({ isContainerRunning: () => false });
    await advanceThreadClosures(deps);
    expect(calls).toEqual(['clear', 'archive']);
  });

  it('archives as the TERMINAL marker and marks the closure closed and forced', async () => {
    startClose();
    const { deps } = recordingDeps();
    await advanceThreadClosures(deps);
    const row = getRawDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(THREAD) as {
      state: string;
      forced: number;
      closed_at: string;
    };
    expect(row.state).toBe('closed');
    // The agent never answered — that must be findable afterwards.
    expect(row.forced).toBe(1);
    expect(row.closed_at).toBe(new Date(NOW).toISOString());
  });

  it('finalizes unforced when the agent confirms, without waiting out the window', async () => {
    startClose({ requestedAt: iso(30_000) });
    const { calls, deps } = recordingDeps({ readProposal: () => ({ reason: 'done', proposed_at: iso(10_000) }) });
    await advanceThreadClosures(deps);
    expect(calls).toEqual(['kill', 'clear', 'archive']);
    expect(getRawDb().prepare('SELECT forced FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      forced: 0,
    });
  });

  /**
   * A confirmation retracted before the decision's read must not buy the kill.
   *
   * The finalizer reads every live session synchronously, with nothing awaited
   * before `decideCloseFinalization`, so a retraction landing before a
   * session's own read is seen and the kill is declined. Declining costs
   * nothing durable: the row stays `awaiting_confirmation`, the next tick asks
   * again, and the forced path is time-based and untouched.
   *
   * The cross-process window above applies here too and is out of scope for any
   * host-side change.
   */
  it('does not finalize on a confirmation retracted before the decision reads it', async () => {
    const THREAD_F = 'slack:C1:finalize-retract';
    for (const [group, id] of [
      ['ag1', 'f-retractor'],
      ['ag2', 'f-sibling'],
    ] as const) {
      insertSession(id, group, THREAD_F);
      fs.rmSync(path.dirname(dbPathFor(group, id, 'inbound.db')), { recursive: true, force: true });
      materializeSession(group, id);
      const out = new Database(dbPathFor(group, id, 'outbound.db'));
      out
        .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('done_proposal', JSON.stringify({ reason: 'done', proposed_at: iso(10_000) }), iso(10_000));
      out.close();
    }
    // Inside the confirmation window, so only standing proposals finalize this.
    getRawDb()
      .prepare(
        `INSERT INTO thread_closures (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state)
         VALUES (?, 'admin', ?, NULL, 1, ?, 'awaiting_confirmation')`,
      )
      .run(THREAD_F, iso(30_000), JSON.stringify(['f-retractor', 'f-sibling']));

    // Fires as the retractor's own read is taken.
    duringProposalRead.run = () => {
      const db = new Database(dbPathFor('ag1', 'f-retractor', 'outbound.db'));
      db.prepare("DELETE FROM session_state WHERE key = 'done_proposal'").run();
      db.close();
    };

    const calls: string[] = [];
    // `readProposal` deliberately NOT injected: this case has to exercise the
    // real fan-out and the real synchronous decision over real files.
    await advanceThreadClosures({
      now: NOW,
      isContainerRunning: () => false,
      clearContinuation: () => {
        calls.push('clear');
        return true;
      },
      killContainer: (_id, _reason, onExit) => {
        calls.push('kill');
        onExit?.();
      },
      archiveSession: (id) => {
        calls.push('archive');
        return getRawDb().prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(iso(0), id).changes > 0;
      },
    });

    expect(calls).toEqual([]);
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD_F)).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  /**
   * The real `killContainer` fires `onExit` long after it returns.
   *
   * The exit work used to be captured into a variable assigned inside that
   * callback and awaited immediately — while it was still `undefined` for every
   * real kill. So the await was awaiting nothing, and when the later exit's
   * settle failed, it rejected a promise with no local catch: the error escaped
   * this function's caller and surfaced at the process `unhandledRejection`
   * handler, outside `advanceThreadClosures`' per-row containment.
   *
   * Resolving from the callback keeps both shapes right. A synchronous exit —
   * an already-stopped container, or an injected kill — still orders kill,
   * clear and archive before the tick returns, which the other cases here pin.
   * This one pins the asynchronous shape.
   */
  it('returns without blocking on a kill whose exit lands on a later tick', async () => {
    startClose();
    let fireExit: (() => void) | undefined;
    // Models the real registry: the process is gone only once `onExit` fires,
    // so ownership flips there and not at the call to kill.
    const live = { owned: true };
    const { calls, deps } = recordingDeps((recorded) => ({
      isContainerRunning: () => live.owned,
      killContainer: (_id, _reason, onExit) => {
        recorded.push('kill');
        fireExit = () => {
          live.owned = false;
          onExit?.();
        };
      },
    }));

    await advanceThreadClosures(deps);

    // The tick is over and the exit has not happened, so nothing after the kill
    // has run. A promise that only the callback can settle would hang here.
    expect(calls).toEqual(['kill']);
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'finalizing',
    });

    // The container exits later, and the settle still runs on that exit.
    fireExit!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['kill', 'clear', 'archive']);
  });

  /**
   * And the later exit's FAILURE is this function's to catch.
   *
   * That is the half the old shape lost. `await exitWork` read a variable the
   * callback had not assigned yet, so a settle that threw on a real exit
   * rejected a promise nobody was holding: it bypassed `advanceThreadClosures`'
   * per-row containment and reached the process `unhandledRejection` handler,
   * where the closure could not associate it with a thread or retry it.
   */
  it('contains a failure from an exit that lands on a later tick', async () => {
    startClose();
    let fireExit: (() => void) | undefined;
    const live = { owned: true };
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { deps } = recordingDeps((recorded) => ({
      isContainerRunning: () => live.owned,
      killContainer: (_id, _reason, onExit) => {
        recorded.push('kill');
        fireExit = () => {
          live.owned = false;
          onExit?.();
        };
      },
      archiveSession: () => {
        throw new Error('archive failed');
      },
    }));

    await advanceThreadClosures(deps);
    fireExit!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      'thread-close: the post-exit settle failed; the closure stays finalizing for the next tick',
    );
    // Reported through the close path, and left for the next tick to retry.
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'finalizing',
    });
    warn.mockRestore();
  });

  it('does nothing at all while the agent still has time to answer', async () => {
    startClose({ requestedAt: iso(30_000) });
    const { calls, deps } = recordingDeps();
    await advanceThreadClosures(deps);
    expect(calls).toEqual([]);
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  it('end to end: the REAL clear empties the session DB once the container is gone', async () => {
    startClose();
    materializeSession('ag1', 's1');
    const out = new Database(dbPathFor('ag1', 's1', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'work_continuation',
        JSON.stringify({ id: 'c1', task: 'resume the migration', phase: 'queued', chain: 1, resume_attempts: 0 }),
        iso(0),
      );
    out.close();

    let continuationAtKill: unknown = 'not-observed';
    // `clearContinuation` is deliberately NOT injected here: this exercises the
    // production force-clear against a real outbound.db.
    //
    // The observation point INVERTED with the ordering: the clear now runs
    // inside `onExit`, so at the moment of the kill the promise is still
    // there. That is the point — the host does not write outbound.db until the
    // container that owns it is provably gone.
    const live = { owned: true };
    await advanceThreadClosures({
      now: NOW,
      isContainerRunning: () => live.owned,
      readProposal: () => null,
      killContainer: (_id, _reason, onExit) => {
        live.owned = false; // the process is gone once onExit fires
        const db = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
        continuationAtKill =
          db.prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() ?? null;
        db.close();
        onExit?.();
      },
    });

    // Still held when the kill is issued; cleared by the time it returns.
    expect(continuationAtKill).not.toBeNull();
    const after = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    after.close();
    expect(getRawDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s1')).not.toMatchObject({
      archived_at: null,
    });
  });

  /**
   * The never-woken shape: inbound.db exists, outbound.db never did, because
   * outbound.db is the CONTAINER's file and no container ever ran here.
   * `exists()` answers on inbound.db alone, so the force-clear's session opens
   * normally and then reaches a writable outbound op with no file under it.
   *
   * There is provably no continuation to clear on such a session, so the close
   * must proceed. Before the `hasOutbound` guard the opener threw,
   * `ensureContinuationCleared` read that as not-cleared, and the closure sat
   * in `finalizing` on every later tick — a thread an operator confirmed twice
   * that never closes.
   */
  it('closes a never-woken session that has no outbound.db, without authoring one', async () => {
    startClose();
    // Inbound only — deliberately NOT materializeSession, which makes both.
    // The scratch root is shared across this file's cases, so clear the
    // directory first: an earlier case materialized the same session id.
    fs.rmSync(path.dirname(dbPathFor('ag1', 's1', 'inbound.db')), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dbPathFor('ag1', 's1', 'inbound.db')), { recursive: true });
    ensureSchema(dbPathFor('ag1', 's1', 'inbound.db'), 'inbound');
    expect(fs.existsSync(dbPathFor('ag1', 's1', 'outbound.db'))).toBe(false);

    // The production force-clear, not an injected one.
    await advanceThreadClosures({
      now: NOW,
      isContainerRunning: () => false,
      readProposal: () => null,
    });

    // It closed, and the host did not author the container's file to do it.
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'closed',
    });
    expect(getRawDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s1')).not.toMatchObject({
      archived_at: null,
    });
    expect(fs.existsSync(dbPathFor('ag1', 's1', 'outbound.db'))).toBe(false);
  });

  /**
   * The inverse cohort: inbound.db gone, outbound.db still holding work.
   *
   * `exists()` is inbound-keyed, so routing the force-clear through a mailbox
   * session answered `undefined` here and `cleared ?? true` read that as
   * success — the finalizer would archive a session with a live
   * `work_continuation` still in outbound. The force-clear is outbound-keyed
   * now, so the record is actually dropped before the close completes.
   */
  it('clears a continuation in outbound.db even when inbound.db is gone', async () => {
    startClose();
    fs.rmSync(path.dirname(dbPathFor('ag1', 's1', 'inbound.db')), { recursive: true, force: true });
    materializeSession('ag1', 's1');
    const out = new Database(dbPathFor('ag1', 's1', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'work_continuation',
        JSON.stringify({ id: 'c-orphan', task: 'still promised', phase: 'queued', chain: 1, resume_attempts: 0 }),
        iso(0),
      );
    out.close();
    // The host-owned half of the mailbox is gone; the container's half is not.
    fs.rmSync(dbPathFor('ag1', 's1', 'inbound.db'));

    await advanceThreadClosures({ now: NOW, isContainerRunning: () => false, readProposal: () => null });

    // The promise is actually gone, not merely reported gone.
    const after = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    after.close();
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'closed',
    });
  });

  /**
   * A wake landing between the finalizer's ownership branch and the
   * force-clear's own guard must not end with an archived session.
   *
   * The ordering fix removed the stale sample by construction — ownership is
   * read immediately before the branch, with no await between. What remains is
   * the composition: the no-container branch still awaits the clear, and a
   * container can come up inside it. The clear's own `containerOwnsOutbound`
   * re-check is what covers that, refusing to write outbound.db under a live
   * writer and reporting not-cleared, so the caller does not archive and the
   * closure retries on the next tick.
   *
   * Deliberately uses the REAL clear and the REAL ownership predicate: the
   * queue answers the finalizer's read `false` and the clear's read `true`,
   * which is the wake landing in between.
   */
  it('does not archive when a container takes the session between the branch and the clear', async () => {
    startClose();
    materializeSession('ag1', 's1');
    const out = new Database(dbPathFor('ag1', 's1', 'outbound.db'));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'work_continuation',
        JSON.stringify({ id: 'c-wake', task: 'still mine', phase: 'queued', chain: 1, resume_attempts: 0 }),
        iso(0),
      );
    out.close();

    // Read 1 = the finalizer's branch (no container). Read 2 = the clear's
    // guard (a container took it during the open).
    containerOwns.queue = [false, true];
    let archived: string | null = null;

    await advanceThreadClosures({
      now: NOW,
      readProposal: () => null,
      archiveSession: (id) => {
        archived = id;
        return true;
      },
    });

    // Not archived, and the promise is untouched — the host did not write
    // outbound.db while a container owned it.
    expect(archived).toBeNull();
    const after = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 1 });
    after.close();
    // Still finalizing, so the next tick retries against a stopped container.
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'finalizing',
    });
  });

  /**
   * A wake issued DURING the clear must be killed, not archived around.
   *
   * The no-container branch awaits the clear, so a container can take the
   * session inside it. Archiving then leaves that container running in a thread
   * the operator sees as closed — archiving is display-only and stops nothing.
   *
   * The force-clear's own guard does not cover this case: a session with no
   * continuation to clear never reaches it (the funnel resolves `undefined`
   * before the action), and "nothing to clear" is a legitimate success. So the
   * ownership question is re-asked after the clear.
   *
   * Injects `isContainerRunning` as the single ownership knob and flips it
   * inside the injected clear — the wake landing in the await.
   */
  it('kills a container that took the session during the clear instead of archiving around it', async () => {
    startClose();
    const live = { owned: false };
    const calls: string[] = [];
    let archived: string | null = null;

    await advanceThreadClosures({
      now: NOW,
      readProposal: () => null,
      isContainerRunning: () => live.owned,
      clearContinuation: async () => {
        calls.push('clear');
        // ONE wake, inside the FIRST clear. The post-exit clear must not flip
        // it again — that would be a second wake, a different scenario.
        if (calls.filter((c) => c === 'clear').length === 1) live.owned = true;
        return true;
      },
      killContainer: (_id, _reason, onExit) => {
        calls.push('kill');
        live.owned = false; // the process is gone once onExit fires
        onExit?.();
      },
      archiveSession: (id) => {
        calls.push('archive');
        archived = id;
        return true;
      },
    });

    // It took the kill path: cleared, found the session taken, killed, cleared
    // again after exit, then archived. Never archive-without-kill.
    expect(calls).toEqual(['clear', 'kill', 'clear', 'archive']);
    expect(archived).toBe('s1');
    expect(calls.indexOf('kill')).toBeLessThan(calls.indexOf('archive'));
  });

  /**
   * A respawn that lands inside the POST-EXIT clear must not be archived
   * around either — the third branch of the same defect.
   *
   * `onExit` proves the old process is gone, not that nobody else took the
   * session: a concurrent group or provider restart can register its own
   * `onExit` respawn for this process and `wakeContainer` while we sit in the
   * clear. Archiving then strands that replacement in a thread later closure
   * ticks skip entirely, because an archived session is skipped.
   *
   * Both branches run through `clearThenSettle`, so this is the same guard the
   * other two cases exercise, reached from the exit callback.
   */
  it('does not archive when a replacement wakes inside the post-exit clear', async () => {
    startClose();
    const live = { owned: true };
    const calls: string[] = [];
    let archived: string | null = null;

    await advanceThreadClosures({
      now: NOW,
      readProposal: () => null,
      isContainerRunning: () => live.owned,
      killContainer: (_id, _reason, onExit) => {
        calls.push('kill');
        live.owned = false; // this process is gone
        onExit?.();
      },
      clearContinuation: async () => {
        calls.push('clear');
        live.owned = true; // a restart's respawn lands inside the clear
        return true;
      },
      archiveSession: (id) => {
        calls.push('archive');
        archived = id;
        return true;
      },
    });

    // Killed and cleared, but NOT archived: something owns the session again.
    expect(calls).toEqual(['kill', 'clear']);
    expect(archived).toBeNull();
    // Left finalizing, so the next tick takes the kill path against the
    // replacement rather than skipping an archived session forever.
    expect(getRawDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'finalizing',
    });
  });

  it('is idempotent — a second tick over an already-closed thread does nothing', async () => {
    startClose();
    await advanceThreadClosures(recordingDeps().deps);
    const second = recordingDeps();
    await advanceThreadClosures(second.deps);
    expect(second.calls).toEqual([]);
  });
});

// ── The force-clear ──────────────────────────────────────────────────────────

describe('force-clearing a work_continuation', () => {
  it('drops both the current and the legacy continuation keys', async () => {
    const db = outboundStub();
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'work_continuation',
      JSON.stringify({ id: 'c1', task: 'keep going', phase: 'queued', chain: 1, resume_attempts: 0 }),
      iso(0),
    );
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pending_next',
      JSON.stringify({ task: 'legacy', chain: 0 }),
      iso(0),
    );

    clearWorkContinuation(db);

    // Leaving either behind leaves a promise the next wake still finds:
    // readWorkContinuation falls back to `pending_next`.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    // Idempotent, and it leaves unrelated session_state alone.
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'sticky_model',
      'opus',
      iso(0),
    );
    clearWorkContinuation(db);
    expect(db.prepare("SELECT value FROM session_state WHERE key = 'sticky_model'").get()).toMatchObject({
      value: 'opus',
    });
    db.close();
  });

  it('clears a record it cannot parse — presence, not validity, is the question', async () => {
    const db = outboundStub();
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'work_continuation',
      'not json',
      iso(0),
    );
    clearWorkContinuation(db);
    expect(db.prepare("SELECT 1 FROM session_state WHERE key = 'work_continuation'").get()).toBeUndefined();
    db.close();
  });
});

// ── The proposal read side ───────────────────────────────────────────────────

describe('readDoneProposal / syncDoneProposalMirror', () => {
  function withProposal(value: string): Database.Database {
    const db = outboundStub();
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'done_proposal',
      value,
      iso(0),
    );
    return db;
  }

  it('reads a valid proposal and rejects everything else as absent', async () => {
    expect(readDoneProposal(outboundStub())).toBeNull();
    expect(readDoneProposal(withProposal('not json'))).toBeNull();
    expect(readDoneProposal(withProposal(JSON.stringify({ reason: '  ', proposed_at: iso(0) })))).toBeNull();
    expect(readDoneProposal(withProposal(JSON.stringify({ reason: 'ok', proposed_at: 'whenever' })))).toBeNull();
    expect(readDoneProposal(withProposal(JSON.stringify({ reason: 'ok', proposed_at: iso(0) })))).toEqual({
      reason: 'ok',
      proposed_at: iso(0),
    });
  });

  it('mirrors onto the session row, and clears it when the agent retracts', async () => {
    insertSession('s1', 'ag1', 'slack:C1:1.1');
    const proposed = withProposal(JSON.stringify({ reason: 'finished', proposed_at: iso(0) }));
    await syncDoneProposalMirror('s1', readDoneProposal(proposed));
    const mirrored = getRawDb().prepare('SELECT done_proposal FROM sessions WHERE id = ?').get('s1') as {
      done_proposal: string;
    };
    expect(JSON.parse(mirrored.done_proposal)).toMatchObject({ reason: 'finished' });

    // continue_work / real inbound delete the container-side record; the next
    // sweep must take the flag back off the row.
    await syncDoneProposalMirror('s1', readDoneProposal(outboundStub()));
    expect(getRawDb().prepare('SELECT done_proposal FROM sessions WHERE id = ?').get('s1')).toMatchObject({
      done_proposal: null,
    });
    proposed.close();
  });
});

// ── The seam ─────────────────────────────────────────────────────────────────

/**
 * PR 4 (mailbox seam, ingress family): both halves of the close run through
 * `withExistingMailboxSession` — the inbound wrap-up (a deferred trigger row
 * plus its inert recall companion) and the outbound side (the proposal read,
 * the force-clear, and a direct outbound row written through the same session).
 */
describe('thread close on the mailbox seam', () => {
  const THREAD = 'slack:C1:9.9';

  it('thread close writes its deferred context and outbound direct rows through the seam', async () => {
    insertSession('s-seam', 'ag1', THREAD);
    materializeSession('ag1', 's-seam');

    // A direct outbound row and a done proposal, both authored through the
    // session rather than a raw handle — the outbound half of the seam.
    await withExistingMailboxSession('ag1', 's-seam', async (mailbox) => {
      await mailbox.writeDirect(
        parseDirectOutboundWrite({
          id: 'direct-1',
          kind: 'chat',
          platformId: 'slack:C1',
          channelType: 'slack',
          threadId: THREAD,
          content: JSON.stringify({ text: 'from the host' }),
        }),
      );
    });

    // (a) The wrap-up request. `requestThreadClose` writes it through the seam.
    const res = await requestThreadClose(THREAD, { confirmations: 2, reason: 'wrapping up' }, ctxFor('admin'));
    expect(res.status).toBe(202);

    const inbound = new Database(dbPathFor('ag1', 's-seam', 'inbound.db'), { readonly: true });
    const rows = inbound.prepare('SELECT id, kind, trigger, on_wake FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      trigger: number;
      on_wake: number;
    }>;
    inbound.close();
    // The deferred trigger row and its inert recall companion — the pair the
    // next sweep tick admits with fresh context.
    expect(rows.map((r) => r.kind)).toEqual(['system', 'chat']);
    expect(rows.find((r) => r.kind === 'chat')).toMatchObject({ on_wake: 0 });
    expect(rows.find((r) => r.kind === 'system')?.trigger).toBe(0);

    const outbound = new Database(dbPathFor('ag1', 's-seam', 'outbound.db'), { readonly: true });
    expect(outbound.prepare('SELECT id, seq FROM messages_out').all()).toEqual([{ id: 'direct-1', seq: 2 }]);
    outbound.close();

    // (b) The outbound half of finalization: a continuation the container still
    // holds is force-cleared through the same seam before the kill.
    const planted = new Database(dbPathFor('ag1', 's-seam', 'outbound.db'));
    planted
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'work_continuation',
        JSON.stringify({ id: 'c-seam', task: 'still going', phase: 'queued', chain: 1, resume_attempts: 0 }),
        iso(0),
      );
    planted.close();

    getRawDb()
      .prepare(`UPDATE thread_closures SET requested_at = ? WHERE thread_id = ?`)
      .run(iso(CLOSE_CONFIRM_WINDOW_MS + 1_000), THREAD);
    await advanceThreadClosures({ now: NOW, isContainerRunning: () => false });

    const after = new Database(dbPathFor('ag1', 's-seam', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    after.close();
    expect(getRawDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s-seam')).not.toMatchObject({
      archived_at: null,
    });
  });
});
