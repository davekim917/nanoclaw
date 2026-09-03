/**
 * Per-session core — S2-PR9 acceptance cases (F-9.1..F-9.4,
 * docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * The `deleteOrphanProcessingClaims` and `resetStuckProcessingRows — orphan
 * claim cleanup` describes below are ported verbatim from
 * `src/host-sweep.test.ts` (pre-move). F-9.1..F-9.4 are new: the pre-move
 * suite exercised the reset body directly and never the four REGISTERED
 * entries this PR actually writes (plan §8's family-case rule).
 *
 * Hermeticity (brief-common.md HARD RULE): every fixture is an in-memory
 * SQLite pair built by the production composer — no temp tree, no `data/`, no
 * git, no network. The `child_process` tripwire below records and throws on
 * any real spawn, and every case asserts it stayed empty.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composeNanoclawSession, type NanoclawMailboxSession } from '../mailbox/index.js';
import { deleteOrphanProcessingClaims, getProcessingClaims } from '../mailbox/ops/sweep.js';
import {
  SWEEP_DUTY_INVENTORY,
  _listSweepRegistrationsForTesting,
  type SweepDuty,
  type SweepKillFollowUp,
  type SweepSessionContext,
} from '../../host-sweep.js';
import { BACKOFF_BASE_MS, MAX_TRIES, PENDING_MESSAGE_MAX_AGE_MS } from './index.js';
// Importing the module registers S2/S3/S4/S17 as a duty source — every case
// below reads them back out of the registry rather than calling a body.
import './index.js';
// PR 14 integration: the ordering case below drives session:plan up to S5,
// which moved to the scheduling family (S2-PR11).
import '../sweep-scheduling/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// ─── Hermeticity tripwire (brief-common.md HARD RULE) ────────────────────────
// A tripwire, not a functional mock: it records the call AND throws, so a body
// that reaches an unmocked docker/git/network spawn fails loudly even where the
// caller swallows the throw.
const spawns = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`session-core.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}
vi.mock('child_process', () => childProcessTripwire(spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawns));

afterEach(() => {
  expect(spawns).toEqual([]);
});

// ─── Module mocks ────────────────────────────────────────────────────────────
// Only the seams the four duties (and S5, which F-9.2 must run past) actually
// reach. `DATA_DIR` is redirected so nothing here can resolve a real session
// path even by accident.
const testDataDir = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-session-core-')) };
});
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return testDataDir.dir;
    },
  };
});

const mockIsContainerRunning = vi.fn();
vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
  };
});

// S5 (S2-PR11's duty, still registered in host-sweep.ts) runs in the same
// session:plan phase F-9.2 drives. Its two callees are stubbed at the seam:
// the point of the case is WHERE the due count is consulted, not what it
// admits.
const mockRunHostGatedTaskScripts = vi.fn().mockResolvedValue(undefined);
vi.mock('../scheduling/host-script.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../scheduling/host-script.js')>();
  return {
    ...real,
    runHostGatedTaskScripts: (...args: unknown[]) => mockRunHostGatedTaskScripts(...args),
  };
});

const mockAdmitDueTaskContexts = vi.fn().mockReturnValue(0);
vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
  };
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSessionDbs(): {
  inDb: Database.Database;
  outDb: Database.Database;
  mailbox: NanoclawMailboxSession;
} {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_routing (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type  TEXT,
      platform_id   TEXT,
      thread_id     TEXT
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // The exact session surface the registered mailbox hands an action, built
  // over these in-memory handles by the production composer — so a test drives
  // the same ops the sweep does, without a temp directory.
  return { inDb, outDb, mailbox: composeNanoclawSession(inDb, () => outDb) };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

/** Record every mailbox method a duty reaches, in call order, then delegate. */
function recordingMailbox(mailbox: NanoclawMailboxSession, calls: string[]): NanoclawMailboxSession {
  return new Proxy(mailbox as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as NanoclawMailboxSession;
}

/** A session context carrying just what these duties read. */
function sessionCtx(
  mailbox: NanoclawMailboxSession | null,
  overrides: Partial<SweepSessionContext> = {},
): SweepSessionContext {
  const session = overrides.session ?? fakeSession();
  return {
    now: Date.now(),
    sessions: [session],
    activeContainerSessionIds: new Set<string>(),
    session,
    agentGroupId: session.agent_group_id,
    agentGroupFolder: 'ag-folder',
    mailbox,
    hasOutbound: true,
    alive: false,
    justWoke: false,
    plan: {
      dueCount: 0,
      wakePriority: 'interactive',
      admittedTasks: 0,
      workContinuation: null,
      continuationWakeEligible: false,
      hasOutbound: true,
    },
    observed: null,
    killSnapshot: null,
    run: async () => undefined,
    runIn: async () => undefined,
    reportWoke: () => undefined,
    ...overrides,
  } as SweepSessionContext;
}

/** The duty the REGISTRY holds under this name — never a local body. */
function registeredDuty(name: string): SweepDuty {
  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
  if (!duty) throw new Error(`no registered duty named ${name}`);
  return duty;
}

function registeredKillFollowUp(name: string): SweepKillFollowUp {
  const followUp = _listSweepRegistrationsForTesting().killFollowUps.find((f) => f.name === name);
  if (!followUp) throw new Error(`no registered kill follow-up named ${name}`);
  return followUp;
}

/**
 * Drive the REGISTERED S17 tail duty over a stopped session that has an
 * outbound file — the only shape in which it does anything. Every case that
 * exercises the orphan-claim reset goes through this, never through the body:
 * a case that called the body directly would stay green even if the registered
 * wrapper dropped `ctx.mailbox` or no-oped (series rule, plan §8).
 */
async function runRegisteredOrphanReset(mailbox: NanoclawMailboxSession, calls: string[] = []): Promise<void> {
  const duty = registeredDuty(SWEEP_DUTY_INVENTORY.S17);
  expect(duty.claims).toBeUndefined();
  await duty.run(sessionCtx(recordingMailbox(mailbox, calls), { alive: false, hasOutbound: true }));
}

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsContainerRunning.mockReturnValue(false);
  mockRunHostGatedTaskScripts.mockResolvedValue(undefined);
  mockAdmitDueTaskContexts.mockReturnValue(0);
});

// ── F-9.1 ────────────────────────────────────────────────────────────────────

describe('S2-PR9 — per-session core', () => {
  it('processing_ack sync and stale-pending expiry keep their windows and never expire recurring rows', async () => {
    const s2 = registeredDuty(SWEEP_DUTY_INVENTORY.S2);
    const s3 = registeredDuty(SWEEP_DUTY_INVENTORY.S3);

    // The windows: both are session:plan duties, ack sync strictly first.
    expect([s2.phase, s2.order]).toEqual(['session:plan', 10]);
    expect([s3.phase, s3.order]).toEqual(['session:plan', 20]);
    expect(s2.claims).toBeUndefined();
    expect(s3.claims).toBeUndefined();

    const { inDb, outDb, mailbox } = makeSessionDbs();
    const now = Date.now();
    const old = new Date(now - 25 * HOUR_MS).toISOString();
    const recent = new Date(now - 12 * HOUR_MS).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, recurrence, content)
         VALUES ('m-acked', 1, 'chat', ?, 'pending', NULL, '{}'),
                ('m-stale', 2, 'chat', ?, 'pending', NULL, '{}'),
                ('m-recurring', 3, 'task', ?, 'pending', '0 9 * * *', '{}'),
                ('m-recent', 4, 'chat', ?, 'pending', NULL, '{}')`,
      )
      .run(old, old, old, recent);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-acked', 'completed', ?)").run(old);

    const calls: string[] = [];
    const ctx = sessionCtx(recordingMailbox(mailbox, calls));
    await s2.run(ctx);
    await s3.run(ctx);

    // S2's window: the terminal ack was mirrored onto messages_in.
    expect(calls).toContain('syncProcessingAcks');
    // S3's window: the 24 h default expired the stale one-shot row and nothing
    // else — the recurring row is never expired, and a 12 h-old row is inside
    // the window.
    expect(calls).toContain('expireStalePending');
    expect(PENDING_MESSAGE_MAX_AGE_MS).toBe(24 * HOUR_MS);
    const rows = inDb.prepare('SELECT id, status FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      status: string;
    }>;
    expect(rows).toEqual([
      { id: 'm-acked', status: 'completed' },
      { id: 'm-stale', status: 'expired' },
      { id: 'm-recurring', status: 'pending' },
      { id: 'm-recent', status: 'pending' },
    ]);
  });

  // ── F-9.2 ──────────────────────────────────────────────────────────────────

  it('the orphan-claim reset runs before any due-count or wake decision', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, tries, trigger, content)
         VALUES ('recall-m-due', 1, 'system', ?, 'pending', NULL, 0, 0, ?),
                ('m-due', 2, 'chat', ?, 'pending', NULL, 0, 1, ?)`,
      )
      .run(
        claimedAt,
        JSON.stringify({ subtype: 'recall_context', revision: 'before-crash' }),
        claimedAt,
        JSON.stringify({ text: 'due now' }),
      );
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-due', 'processing', ?)").run(claimedAt);

    // The row IS due before the reset — otherwise the ordering below proves
    // nothing.
    expect(mailbox.countDueMessages()).toBe(1);

    const calls: string[] = [];
    const ctx = sessionCtx(recordingMailbox(mailbox, calls));

    // Drive the REGISTERED session:plan duties, in registry order, up to and
    // including the due-admission duty that consults the count (S5, order 40).
    const planDuties = _listSweepRegistrationsForTesting().duties.filter(
      (d) => d.phase === 'session:plan' && d.order <= 40,
    );
    expect(planDuties.map((d) => d.name)).toEqual([
      SWEEP_DUTY_INVENTORY.S2,
      SWEEP_DUTY_INVENTORY.S3,
      SWEEP_DUTY_INVENTORY.S4,
      SWEEP_DUTY_INVENTORY.S5,
    ]);
    for (const duty of planDuties) await duty.run(ctx);

    // Ordering: the claim was cleared and the paired input deferred BEFORE the
    // due count was consulted.
    const clearedAt = calls.indexOf('deleteOrphanProcessingClaims');
    const countedAt = calls.indexOf('countDueMessages');
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    expect(countedAt).toBeGreaterThanOrEqual(0);
    expect(clearedAt).toBeLessThan(countedAt);

    // Effect: the orphan claim is gone and the paired turn is inert (trigger 0
    // on both halves, backoff stamped), so the count the wake decision reads is
    // the post-reset one.
    expect(getProcessingClaims(outDb)).toEqual([]);
    const pair = inDb.prepare('SELECT id, trigger, tries, process_after FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      tries: number;
      process_after: string | null;
    }>;
    expect(pair[0]).toMatchObject({ id: 'recall-m-due', trigger: 0, tries: 0 });
    expect(pair[1]).toMatchObject({ id: 'm-due', trigger: 0, tries: 1 });
    expect(pair[0]!.process_after).toBe(pair[1]!.process_after);
    expect(ctx.plan.dueCount).toBe(0);
    expect(ctx.plan.wakePriority).toBe('interactive');
  });

  // ── F-9.3 ──────────────────────────────────────────────────────────────────

  it('resetStuckProcessingRows keeps the dup-reply guard and the retry backoff', async () => {
    const s17 = registeredDuty(SWEEP_DUTY_INVENTORY.S17);
    expect([s17.phase, s17.order]).toEqual(['session:tail', 10]);

    // Fake timers so the deferred stamp is an exact value, not "some future
    // time": the body computes `BACKOFF_BASE_MS * 2 ** tries`, floors it to
    // whole seconds, and `deferMessageForFreshContextRetry` stamps
    // `Date.now() + backoffSec * 1000`. Both constants are imported from the
    // module under test so the ladder cannot drift away from this assertion.
    vi.useFakeTimers();
    const t0 = Date.parse('2026-04-20T12:00:00.000Z');
    vi.setSystemTime(t0);
    try {
      const { inDb, outDb, mailbox } = makeSessionDbs();
      const claimedAt = new Date(t0 - 2 * HOUR_MS).toISOString();
      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content)
           VALUES ('m-answered', 1, 'chat', ?, 'pending', 0, '{}'),
                  ('m-spent', 2, 'chat', ?, 'pending', ?, '{}'),
                  ('m-retry', 3, 'chat', ?, 'pending', 2, '{}')`,
        )
        .run(claimedAt, claimedAt, MAX_TRIES, claimedAt);
      const claimAll = (): void => {
        outDb
          .prepare(
            `INSERT OR REPLACE INTO processing_ack VALUES ('m-answered', 'processing', ?),
                                                          ('m-spent', 'processing', ?),
                                                          ('m-retry', 'processing', ?)`,
          )
          .run(claimedAt, claimedAt, claimedAt);
      };
      claimAll();
      outDb
        .prepare(
          `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content)
           VALUES ('reply-1', 1, 'm-answered', ?, 'chat', '{}')`,
        )
        .run(new Date(t0).toISOString());

      const calls: string[] = [];
      await runRegisteredOrphanReset(mailbox, calls);

      const read = (id: string): { status: string; tries: number; process_after: string | null } =>
        inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get(id) as {
          status: string;
          tries: number;
          process_after: string | null;
        };

      // Dup-reply guard: an already-answered input is completed, never retried.
      expect(read('m-answered')).toEqual({ status: 'completed', tries: 0, process_after: null });
      // At MAX_TRIES: failed, not deferred again.
      expect(read('m-spent')).toMatchObject({ status: 'failed', tries: MAX_TRIES });
      expect(read('m-spent').process_after).toBeNull();
      // Retry backoff, attempt 1: tries 2 -> 3, deferred by exactly
      // BACKOFF_BASE_MS * 2 ** 2 (20 s) from now.
      const firstDelayMs = Math.floor((BACKOFF_BASE_MS * 2 ** 2) / 1000) * 1000;
      expect(firstDelayMs).toBe(20_000);
      expect(read('m-retry')).toEqual({
        status: 'pending',
        tries: 3,
        process_after: new Date(t0 + firstDelayMs).toISOString(),
      });
      expect(calls).toContain('markInboundCompletedIfPending');
      expect(calls).toContain('markMessageFailed');

      // A second crash after the backoff elapsed doubles the delay — the ladder
      // grows with `tries`, it is not a fixed pause.
      const t1 = t0 + firstDelayMs + 1_000;
      vi.setSystemTime(t1);
      claimAll();
      await runRegisteredOrphanReset(mailbox);
      const secondDelayMs = Math.floor((BACKOFF_BASE_MS * 2 ** 3) / 1000) * 1000;
      expect(secondDelayMs).toBe(firstDelayMs * 2);
      expect(read('m-retry')).toEqual({
        status: 'pending',
        tries: 4,
        process_after: new Date(t1 + secondDelayMs).toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ── F-9.4 ──────────────────────────────────────────────────────────────────

  it('orphan processing_ack rows are deleted so a respawn is not killed on stale evidence', async () => {
    const followUp = registeredKillFollowUp(SWEEP_DUTY_INVENTORY.S17);
    expect(followUp.order).toBe(20);

    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb
      .prepare(
        `INSERT INTO processing_ack VALUES ('m-1', 'processing', ?),
                                           ('m-done', 'completed', ?)`,
      )
      .run(claimedAt, claimedAt);
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    const calls: string[] = [];
    const ctx = sessionCtx(null, {
      killSnapshot: { reason: 'absolute-ceiling', containerState: null, pendingClaims: 1, workContinuation: null },
    });
    await followUp.run(
      ctx,
      { action: 'kill-ceiling', heartbeatAgeMs: 31 * 60_000, ceilingMs: 30 * 60_000 },
      recordingMailbox(mailbox, calls),
    );

    // The stale 'processing' evidence is gone, so the next tick cannot read it
    // and kill the freshly respawned container. Terminal rows are untouched.
    expect(getProcessingClaims(outDb)).toEqual([]);
    expect(outDb.prepare('SELECT message_id FROM processing_ack').all()).toEqual([{ message_id: 'm-done' }]);
    expect(calls).toContain('deleteOrphanProcessingClaims');
  });
});

// ── Registered-duty coverage the family rule requires ────────────────────────

describe('the registered session-core entries reach their bodies', () => {
  it('S17 is one name on two surfaces, and the tail duty is skipped for a live container', async () => {
    const registrations = _listSweepRegistrationsForTesting();
    expect(registrations.duties.filter((d) => d.name === SWEEP_DUTY_INVENTORY.S17)).toHaveLength(1);
    expect(registrations.killFollowUps.filter((f) => f.name === SWEEP_DUTY_INVENTORY.S17)).toHaveLength(1);

    const { outDb, mailbox } = makeSessionDbs();
    outDb
      .prepare("INSERT INTO processing_ack VALUES ('m-live', 'processing', ?)")
      .run(new Date(Date.now() - 2 * HOUR_MS).toISOString());

    const s17 = registeredDuty(SWEEP_DUTY_INVENTORY.S17);
    const calls: string[] = [];
    // Alive → the tail retry does nothing; a live container clears its own.
    await s17.run(sessionCtx(recordingMailbox(mailbox, calls), { alive: true }));
    expect(calls).toEqual([]);
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    // No outbound → nothing to read a claim from, so still a no-op.
    await s17.run(sessionCtx(recordingMailbox(mailbox, calls), { alive: false, hasOutbound: false }));
    expect(calls).toEqual([]);
    expect(getProcessingClaims(outDb)).toHaveLength(1);
  });

  it('S4 is skipped while the container is running and reaches the reset when it is not', async () => {
    const s4 = registeredDuty(SWEEP_DUTY_INVENTORY.S4);
    expect([s4.phase, s4.order]).toEqual(['session:plan', 30]);

    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-4', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-4', 'processing', ?)").run(claimedAt);

    mockIsContainerRunning.mockReturnValue(true);
    const liveCalls: string[] = [];
    await s4.run(sessionCtx(recordingMailbox(mailbox, liveCalls)));
    // The running check short-circuits before the claim read.
    expect(liveCalls).toEqual([]);
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    mockIsContainerRunning.mockReturnValue(false);
    const deadCalls: string[] = [];
    await s4.run(sessionCtx(recordingMailbox(mailbox, deadCalls)));
    expect(deadCalls).toContain('deleteOrphanProcessingClaims');
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('a failing claim delete keeps its preserved warning and never costs the session its sweep', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-boom', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-boom', 'processing', ?)").run(claimedAt);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const broken = new Proxy(mailbox as unknown as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'deleteOrphanProcessingClaims') {
          return () => {
            throw new Error('outbound.db is readonly');
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as NanoclawMailboxSession;

    const s17 = registeredDuty(SWEEP_DUTY_INVENTORY.S17);
    expect(() => s17.run(sessionCtx(broken, { alive: false, hasOutbound: true }))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Failed to clear orphan processing claims',
      expect.objectContaining({ sessionId: 'sess-test' }),
    );
    // The retry half still ran before the delete failed.
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-boom') as { tries: number };
    expect(row.tries).toBe(1);
    warn.mockRestore();
  });
});

// ── Ported from src/host-sweep.test.ts, unchanged ────────────────────────────

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

// Ported verbatim except for the invocation: each case now drives the
// REGISTERED S17 tail duty through the registry instead of the moved body's
// test-only alias (series rule, plan §8). Every assertion is unchanged; the
// alias's `reason` argument becomes the tail duty's own 'container not
// running', which no assertion here reads.
describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    await runRegisteredOrphanReset(mailbox);

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('makes a paired crashed turn inert with its recall until fresh due admission', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, tries, trigger, content)
         VALUES ('recall-m-paired', 2, 'system', ?, 'pending', ?, 0, 0, ?),
                ('m-paired', 4, 'chat', ?, 'pending', ?, 0, 1, ?)`,
      )
      .run(
        claimedAt,
        claimedAt,
        JSON.stringify({ subtype: 'recall_context', revision: 'before-crash' }),
        claimedAt,
        claimedAt,
        JSON.stringify({ text: 'retry me' }),
      );
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-paired', 'processing', ?)").run(claimedAt);

    await runRegisteredOrphanReset(mailbox);

    const pair = inDb.prepare('SELECT id, trigger, tries, process_after FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      tries: number;
      process_after: string | null;
    }>;
    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({ id: 'recall-m-paired', trigger: 0, tries: 0 });
    expect(pair[1]).toMatchObject({ id: 'm-paired', trigger: 0, tries: 1 });
    expect(pair[0]!.process_after).not.toBeNull();
    expect(pair[0]!.process_after).toBe(pair[1]!.process_after);
    expect(
      (
        inDb
          .prepare(
            `SELECT COUNT(*) AS count
               FROM messages_in
              WHERE status = 'pending' AND trigger = 1
                AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', async () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    await runRegisteredOrphanReset(mailbox);

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });

  it('retries an input that produced only progress/status rows', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-status-only', 3, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-status-only', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('progress-1', 2, 'm-status-only', ?, 'status', '{}')",
      )
      .run(new Date().toISOString());

    await runRegisteredOrphanReset(mailbox);

    const row = inDb
      .prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?')
      .get('m-status-only') as { status: string; tries: number; process_after: string | null };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('does not retry an input after a non-status response was written', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-answered', 4, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-answered', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('reply-1', 4, 'm-answered', ?, 'chat', '{}')",
      )
      .run(new Date().toISOString());

    await runRegisteredOrphanReset(mailbox);

    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-answered') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('completed');
    expect(row.tries).toBe(0);
    expect(row.process_after).toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });
});
