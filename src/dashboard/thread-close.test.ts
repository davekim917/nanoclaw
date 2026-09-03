import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { ensureSchema } from '../modules/mailbox/schema.js';
import { guard } from '../guard/index.js';
import type { AuthedRequestContext } from './router.js';

// The close path calls into the container registry. Both are injected at the
// call sites the tests exercise; the mock only keeps the spawn path (docker,
// mounts, onecli) out of the module graph.
vi.mock('../container-runner.js', () => ({
  isContainerRunning: () => false,
  killContainer: () => {},
  getActiveContainerSessionIds: () => [],
  resolveAssistantName: (group: { name: string }) => Promise.resolve(group.name),
}));

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

import { parseDirectOutboundWrite } from '../mailbox/model.js';
import { clearWorkContinuation } from '../modules/mailbox/index.js';
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

function seed(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createAgentGroup({ id: 'ag1', name: 'ag1', folder: 'ag1', agent_provider: null, created_at: iso(0) });
  createAgentGroup({ id: 'ag2', name: 'ag2', folder: 'ag2', agent_provider: null, created_at: iso(0) });
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
  getDb()
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

beforeEach(seed);

// ── The guard ────────────────────────────────────────────────────────────────

describe('threads.close guard', () => {
  const consult = (over: Record<string, unknown> = {}, userId = 'admin') =>
    guard(threadsClose, {
      actor: { kind: 'human', userId },
      payload: { agentGroupIds: ['ag1'], agentProposed: false, confirmations: 2, ...over },
    });

  it('an agent-proposed close needs one confirmation, an operator-initiated one needs two', async () => {
    expect(requiredConfirmations(true)).toBe(1);
    expect(requiredConfirmations(false)).toBe(2);
    expect(consult({ agentProposed: true, confirmations: 1 }).effect).toBe('allow');
    // The distinction lives in the guard, so a UI cannot collapse the two.
    expect(consult({ agentProposed: false, confirmations: 1 }).effect).toBe('deny');
    expect(consult({ agentProposed: false, confirmations: 2 }).effect).toBe('allow');
  });

  it('names the missing confirmation count so the surface can say so honestly', async () => {
    const denial = consult({ agentProposed: false, confirmations: 0 });
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
        guard(threadsClose, { actor, payload: { agentGroupIds: ['ag1'], agentProposed: true, confirmations: 9 } })
          .effect,
      ).toBe('deny');
    }
  });

  it('refuses a caller with no admin privilege on any agent group backing the thread', async () => {
    expect(consult({}, 'nobody').effect).toBe('deny');
    expect(consult({ agentGroupIds: [] }).effect).toBe('deny');
  });

  it('never holds — closure has no approval path and therefore no settle-by-silence', async () => {
    expect(threadsClose.grantActionName).toBeUndefined();
    for (const confirmations of [0, 1, 2, 3]) {
      expect(consult({ confirmations }).effect).not.toBe('hold');
    }
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
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM thread_closures').get()).toMatchObject({ n: 0 });
  });

  it('records the close and freezes the fan-out on two confirmations', async () => {
    insertSession('s2', 'ag2', 'slack:C1:1.1');
    const res = await requestThreadClose('slack:C1:1.1', { confirmations: 2, reason: 'shipped' }, ctxFor('admin'));
    expect(res.status).toBe(202);
    const row = getDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get('slack:C1:1.1') as {
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
    expect(readThreadClosures(['slack:C1:1.1']).get('slack:C1:1.1')).toMatchObject({ state: 'awaiting_confirmation' });
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
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM thread_closures').get()).toMatchObject({ n: 0 });
  });

  it('refuses a second close while one is in flight', async () => {
    await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin'));
    const again = await requestThreadClose('slack:C1:1.1', { confirmations: 2 }, ctxFor('admin'));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'close_already_in_progress' });
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

  it('the wrap-up asks for the confirmation and names the deadline', async () => {
    const text = composeCloseWrapUp({ who: 'the operator', reason: 'shipped', windowMinutes: 10 });
    expect(text).toContain('asked to close this thread');
    expect(text).toContain('cancel_continuation');
    expect(text).toContain('propose_done');
    expect(text).toContain('10 minutes');
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
    getDb()
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
    return {
      calls,
      deps: {
        now: NOW,
        isContainerRunning: () => true,
        readProposal: () => null,
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
          return getDb().prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(iso(0), id).changes > 0;
        },
        ...over,
      },
    };
  }

  it('clears the continuation BEFORE killing, and archives only after the process is gone', async () => {
    startClose();
    const { calls, deps } = recordingDeps();
    await advanceThreadClosures(deps);
    // The invariant: a kill that precedes the clear resurrects the promise on
    // the next wake (decideCeilingFollowUp's first branch), so the close would
    // silently not close.
    expect(calls.indexOf('clear')).toBeLessThan(calls.indexOf('kill'));
    expect(calls.indexOf('kill')).toBeLessThan(calls.indexOf('archive'));
    // Re-cleared once the exit callback proves the container is gone.
    expect(calls).toEqual(['clear', 'kill', 'clear', 'archive']);
  });

  it('does NOT kill or archive when the continuation cannot be cleared', async () => {
    startClose();
    const { calls, deps } = recordingDeps((recorded) => ({
      clearContinuation: () => {
        recorded.push('clear');
        return false;
      },
    }));
    await advanceThreadClosures(deps);
    expect(calls).toEqual(['clear']);
    expect(getDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s1')).toMatchObject({
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
    const row = getDb().prepare('SELECT * FROM thread_closures WHERE thread_id = ?').get(THREAD) as {
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
    expect(calls).toEqual(['clear', 'kill', 'clear', 'archive']);
    expect(getDb().prepare('SELECT forced FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      forced: 0,
    });
  });

  it('does nothing at all while the agent still has time to answer', async () => {
    startClose({ requestedAt: iso(30_000) });
    const { calls, deps } = recordingDeps();
    await advanceThreadClosures(deps);
    expect(calls).toEqual([]);
    expect(getDb().prepare('SELECT state FROM thread_closures WHERE thread_id = ?').get(THREAD)).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  it('end to end: the REAL clear empties the session DB before the container is killed', async () => {
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
    await advanceThreadClosures({
      now: NOW,
      isContainerRunning: () => true,
      readProposal: () => null,
      killContainer: (_id, _reason, onExit) => {
        const db = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
        continuationAtKill =
          db.prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() ?? null;
        db.close();
        onExit?.();
      },
    });

    // The invariant, observed at the exact moment of the kill.
    expect(continuationAtKill).toBeNull();
    const after = new Database(dbPathFor('ag1', 's1', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    after.close();
    expect(getDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s1')).not.toMatchObject({
      archived_at: null,
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
    syncDoneProposalMirror('s1', readDoneProposal(proposed));
    const mirrored = getDb().prepare('SELECT done_proposal FROM sessions WHERE id = ?').get('s1') as {
      done_proposal: string;
    };
    expect(JSON.parse(mirrored.done_proposal)).toMatchObject({ reason: 'finished' });

    // continue_work / real inbound delete the container-side record; the next
    // sweep must take the flag back off the row.
    syncDoneProposalMirror('s1', readDoneProposal(outboundStub()));
    expect(getDb().prepare('SELECT done_proposal FROM sessions WHERE id = ?').get('s1')).toMatchObject({
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

    getDb()
      .prepare(`UPDATE thread_closures SET requested_at = ? WHERE thread_id = ?`)
      .run(iso(CLOSE_CONFIRM_WINDOW_MS + 1_000), THREAD);
    await advanceThreadClosures({ now: NOW, isContainerRunning: () => false });

    const after = new Database(dbPathFor('ag1', 's-seam', 'outbound.db'), { readonly: true });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_state WHERE key IN ('work_continuation','pending_next')").get(),
    ).toMatchObject({ n: 0 });
    after.close();
    expect(getDb().prepare('SELECT archived_at FROM sessions WHERE id = ?').get('s-seam')).not.toMatchObject({
      archived_at: null,
    });
  });
});
