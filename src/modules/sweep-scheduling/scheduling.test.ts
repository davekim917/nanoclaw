/**
 * Scheduling + thread-close — S2-PR11 acceptance cases (F-11.1..F-11.4,
 * docs/specs/upstream-host-sweep-seam/plan.md §8), plus the family's slice of
 * `src/host-sweep.test.ts` moved here with its assertions unchanged.
 *
 * Every case that exercises a duty drives the REGISTERED duty — obtained from
 * the registry by name, invoked with a mocked context — rather than the moved
 * body directly (the family-case rule, plan §8): a body called directly proves
 * nothing about the wrapper this PR actually wrote.
 *
 * Hermeticity (brief-common.md HARD RULE): the inbound fixture, the groups
 * root and DATA_DIR all live under one per-run `mkdtemp` root; the central DB
 * is `initTestDb()`'s in-memory database; the `child_process` tripwire below
 * records and throws on any real spawn and every case asserts it stayed empty.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type Database from 'better-sqlite3';

import type { NanoclawMailboxSession } from '../mailbox/index.js';
import type { Session } from '../../types.js';
import type { SweepDuty, SweepSessionContext } from '../../host-sweep.js';

// ─── Hermeticity tripwire (brief-common.md HARD RULE) ────────────────────────
const spawns = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`scheduling.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

// ─── Module mocks ────────────────────────────────────────────────────────────

/**
 * One per-run temp root for everything on disk: DATA_DIR (the mailbox derives
 * every session path from it), GROUPS_DIR (the auto-pause run log) and the
 * inbound.db fixture. `Asia/Tokyo` is pinned so the cron grid is exact even on
 * a UTC runner — the same reason `recurrence.test.ts` pins it.
 */
const roots = await vi.hoisted(async () => {
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-scheduling-'));
  return { dir, groups: nodePath.join(dir, 'groups') };
});

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, DATA_DIR: roots.dir, GROUPS_DIR: roots.groups, TIMEZONE: 'Asia/Tokyo' };
});

vi.mock('../../db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/agent-groups.js')>();
  return { ...real, getAgentGroup: (id: string) => ({ id, name: id, folder: 'g-test' }) };
});

const calls = vi.hoisted(() => ({
  order: [] as string[],
  kills: [] as Array<{ sessionId: string; reason: string }>,
  archives: [] as string[],
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  hostScripts: [] as unknown[][],
  admissions: [] as unknown[][],
  recurrences: [] as unknown[][],
  running: false,
  admittedTasks: 0,
  admitImpl: null as null | ((session: unknown) => number),
  hostScriptFails: false,
  /** F-11.4 only: hold `killContainer`'s `onExit` instead of firing it inline. */
  deferKillExit: false,
  killExit: undefined as undefined | (() => void),
}));

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: () => calls.running,
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (mailbox PR 4 round 8 — thread-close's finalizer is its second caller).
    // Composed from the MOCKED checks: spreading `...real` alone leaves the
    // real predicate reading live module state, so every guard in this suite's
    // duty graph would silently bypass this mock. Same composition
    // src/host-sweep.test.ts uses.
    containerOwnsOutbound: (sessionId: string) => Boolean(calls.running) || real.isContainerSpawning(sessionId),
    hasContainerEverRun: () => false,
    getActiveContainerSessionIds: () => [],
    getContainerSpawnedAt: () => 0,
    wakeContainer: async () => true,
    killContainer: (sessionId: string, reason: string, onExit?: () => void) => {
      calls.order.push('kill');
      calls.kills.push({ sessionId, reason });
      // DEFERRED: hold the callback so a case can assert the gap between the
      // kill REQUEST and the container actually going. Firing it inline (the
      // default, which every other case here wants) collapses that gap, and a
      // regression that cleared saved work right after `killContainer` returned
      // would produce the same event order as the correct code.
      if (calls.deferKillExit) {
        calls.killExit = onExit;
        return;
      }
      // The process is provably gone once `onExit` fires — the container no
      // longer owns outbound.db from this point on. Without this the guarded
      // finalizer (mailbox seam round 8) reads the SAME `calls.running` it saw
      // before the kill and never re-clears/archives after it.
      calls.running = false;
      onExit?.();
    },
  };
});

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getActiveSessions: () => [],
    updateSession: (id: string, patch: Record<string, unknown>) => {
      calls.updates.push({ id, patch });
      return real.updateSession(id, patch as never);
    },
    archiveSessionById: (id: string) => {
      calls.order.push('archive');
      calls.archives.push(id);
      return real.archiveSessionById(id);
    },
  };
});

/**
 * `withExistingMailboxSession` is how `thread-close.ts` reads the done-proposal
 * (round 3, 6f131298, moved the continuation force-clear off this inbound-keyed
 * funnel onto the outbound-keyed `withExistingNanoclawOutbound` below — see that
 * mock for what records `clear` in the order F-11.4 asserts).
 */
vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => {
      calls.admissions.push(args);
      return calls.admitImpl ? calls.admitImpl(args[0]) : calls.admittedTasks;
    },
    withExistingMailboxSession: async <T>(
      _agentGroupId: string,
      _sessionId: string,
      action: (mailbox: unknown) => T | Promise<T>,
    ): Promise<T | undefined> =>
      action({
        readDoneProposal: () => null,
        hasOutbound: () => true,
        clearWorkContinuation: () => null,
        readContinuationPresence: () => null,
      }),
  };
});

/**
 * Round 3 (6f131298) moved `forceClearWorkContinuation` off the inbound-keyed
 * `withExistingMailboxSession` onto the outbound-keyed
 * `withExistingNanoclawOutbound`, and round 4 (c00708ba) made that funnel yield
 * a typed `NanoclawOutboundSession` — so the force-clear is now
 * `outbound.clearWorkContinuation()`, a METHOD on the yielded session rather
 * than a module-level export. The fake session below is what records `clear`
 * in the order F-11.4 asserts; nothing else reads it.
 */
vi.mock('../mailbox/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mailbox/index.js')>();
  return {
    ...real,
    withExistingNanoclawOutbound: async <T>(
      _agentGroupId: string,
      _sessionId: string,
      action: (outbound: unknown) => T | Promise<T>,
    ): Promise<T> =>
      action({
        clearWorkContinuation: () => {
          calls.order.push('clear');
          return null;
        },
        readContinuationPresence: () => null,
      }),
  };
});

/**
 * `runHostGatedTaskScripts` runs opted-in shell scripts — mocked outright, and
 * the tripwire above is what proves no real one ever ran.
 */
vi.mock('../scheduling/host-script.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scheduling/host-script.js')>()),
  runHostGatedTaskScripts: async (...args: unknown[]) => {
    calls.hostScripts.push(args);
    if (calls.hostScriptFails) throw new Error('host-gated script blew up');
  },
}));

/** Records the call and still runs the REAL fan-out — F-11.1/F-11.3 need it. */
vi.mock('../scheduling/recurrence.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../scheduling/recurrence.js')>();
  return {
    ...real,
    handleRecurrence: async (mailbox: NanoclawMailboxSession, session: Session) => {
      calls.recurrences.push([mailbox, session]);
      return real.handleRecurrence(mailbox, session);
    },
  };
});

vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return { ...real, getActiveTasks: () => [], getOrphanedTasks: () => [] };
});

import { CLOSE_CONFIRM_WINDOW_MS } from '../../dashboard/thread-close.js';
import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import { openInboundDb } from '../mailbox/openers.js';
import { ensureSchema } from '../mailbox/schema.js';
import { SWEEP_DUTY_INVENTORY, _listSweepRegistrationsForTesting } from '../../host-sweep.js';
import { composeNanoclawSession } from '../mailbox/index.js';
import { insertTaskRow } from '../scheduling/db.js';
import { scriptBackoffMinutes } from '../scheduling/recurrence.js';
import { log } from '../../log.js';
import { _prepareDueWakeForTesting, shouldCloseTaskSession } from './index.js';
// Importing the module registers T8/S5/S18/S19 as a duty source, which is what
// every case below drives through.
import './index.js';
// PR 14 integration: the session:tail chain case also pins S17, which moved
// to the per-session-core family (S2-PR9).
import '../sweep-session-core/index.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const TASK_THREAD = 'system:tasks:task-s-0';

let fixtureSeq = 0;
let openInbound: Database.Database | null = null;

/** A real inbound.db with the production schema, under the per-run temp root. */
function freshInbound(): Database.Database {
  const dir = path.join(roots.dir, `fixture-${++fixtureSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  const db = openInboundDb(dbPath);
  openInbound = db;
  return db;
}

/**
 * The session the sweep hands a tail duty. Recurrence is an inbound-only path,
 * so the outbound accessor throws and `outboundPresent` is false: an accidental
 * outbound read fails loudly rather than silently answering empty.
 */
function sessionFor(db: Database.Database): NanoclawMailboxSession {
  return composeNanoclawSession(
    db,
    () => {
      throw new Error('a scheduling duty must not touch outbound.db');
    },
    undefined,
    false,
  );
}

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
    ...over,
  } as Session;
}

/**
 * Seed the central `sessions` row a duty's context session stands for.
 *
 * The production precondition, not fixture decoration: a session reaches a
 * sweep duty because `getActiveSessions()` returned its row, so an ACTIVE
 * central row exists by construction. `withQuietInvalidationSync` (the
 * quiet-mark invalidation every due-ness write goes through) refuses when no
 * active row matches — which is the point, since a re-arm into a session the
 * sweep will never enumerate is invisible work — so a fixture that hands the
 * duty a `Session` object with no row behind it is testing a state production
 * cannot produce.
 *
 * `messaging_group_id` is NULL because `foreign_keys = ON` here and the fake
 * session's 'mg-test' has no row; nothing in these duties reads that column
 * off the central row.
 */
function seedCentralSession(session: Session): void {
  getRawDb()
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status,
                                       container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, NULL, @thread_id, @status, @container_status, @last_active, @created_at)`,
    )
    .run({
      id: session.id,
      agent_group_id: session.agent_group_id,
      thread_id: session.thread_id,
      status: session.status,
      container_status: session.container_status,
      last_active: session.last_active,
      created_at: session.created_at,
    });
}

function duty(name: string): SweepDuty {
  const found = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
  if (!found) throw new Error(`duty ${name} is not registered`);
  return found;
}

function makeCtx(over: Partial<SweepSessionContext> = {}): SweepSessionContext {
  const session = over.session ?? fakeSession();
  const mailbox = over.mailbox ?? null;
  for (const s of over.sessions ?? [session]) seedCentralSession(s);
  seedCentralSession(session);
  return {
    now: Date.now(),
    sessions: over.sessions ?? [session],
    activeContainerSessionIds: new Set<string>(),
    session,
    agentGroupId: session.agent_group_id,
    agentGroupFolder: 'g-test',
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
    run: async <T>(action: (m: NanoclawMailboxSession) => T | Promise<T>) => action(mailbox as NanoclawMailboxSession),
    runIn: async <T>(_window: unknown, action: (m: NanoclawMailboxSession) => T | Promise<T>) =>
      action(mailbox as NanoclawMailboxSession),
    reportWoke: () => undefined,
    reportWake: () => undefined,
    ...over,
  } as SweepSessionContext;
}

/** A series whose last `fails` occurrences landed FAILED (script-skip runs). */
function seedFailedStreak(db: Database.Database, fails: number): string {
  const rows = Math.max(fails, 1);
  for (let i = 0; i < rows; i++) {
    insertTaskRow(db, {
      id: `task-s-${i}`,
      seriesId: 'task-s-0',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: i === rows - 1 ? '* * * * *' : null,
      content: JSON.stringify({ prompt: 'monitor', script: 'exit 1' }),
    });
    db.prepare(`UPDATE messages_in SET status = ? WHERE id = ?`).run(
      fails === 0 ? 'completed' : 'failed',
      `task-s-${i}`,
    );
  }
  return `task-s-${rows - 1}`;
}

const clone = (db: Database.Database) =>
  db.prepare(`SELECT id, status, process_after, recurrence FROM messages_in WHERE id NOT LIKE 'task-s-%'`).get() as {
    id: string;
    status: string;
    process_after: string;
    recurrence: string | null;
  };

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createAgentGroup({
    id: 'ag-test',
    name: 'ag-test',
    folder: 'g-test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  calls.order = [];
  calls.kills = [];
  calls.archives = [];
  calls.updates = [];
  calls.hostScripts = [];
  calls.admissions = [];
  calls.recurrences = [];
  calls.running = false;
  calls.admittedTasks = 0;
  calls.admitImpl = null;
  calls.hostScriptFails = false;
  calls.deferKillExit = false;
  calls.killExit = undefined;
  spawns.length = 0;
});

afterEach(async () => {
  expect(spawns).toEqual([]);
  openInbound?.close();
  openInbound = null;
  await closeDb();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(roots.dir, { recursive: true, force: true });
});

// ─── F-11.1 ──────────────────────────────────────────────────────────────────

describe('S2-PR11 scheduling + thread-close', () => {
  it('recurrence re-arms the next pending row and clears the predecessor in one transaction', async () => {
    const db = freshInbound();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    const mailbox = sessionFor(db);
    const session = fakeSession();
    await duty(SWEEP_DUTY_INVENTORY.S18).run(makeCtx({ session, mailbox }));

    // The registered wrapper reached the real fan-out with the window's OWN
    // session — never a second open on the same key (constraint 18).
    expect(calls.recurrences).toHaveLength(1);
    expect(calls.recurrences[0]![0]).toBe(mailbox);
    expect(calls.recurrences[0]![1]).toBe(session);

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    // Insert + clear are one transaction: a half-applied pair would leave the
    // predecessor still recurrence-armed beside a live successor → double-fire.
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
    // Cron is read in TIMEZONE, not UTC: 09:00 Asia/Tokyo is 00:00Z sharp.
    expect(follow.process_after).toMatch(/T00:00:00/);
  });

  // ─── F-11.2 ────────────────────────────────────────────────────────────────

  it('recurrence runs before the spent task-session GC', async () => {
    // Declared order is the constraint (plan §4.3, constraint 13).
    const tail = _listSweepRegistrationsForTesting()
      .duties.filter((d) => d.phase === 'session:tail')
      .map((d) => [d.name, d.order] as const);
    expect(tail).toEqual([
      [SWEEP_DUTY_INVENTORY.S17, 10],
      [SWEEP_DUTY_INVENTORY.S18, 20],
      [SWEEP_DUTY_INVENTORY.S19, 30],
    ]);

    const db = freshInbound();
    insertTaskRow(db, {
      id: 'task-s-0',
      seriesId: 'task-s-0',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-s-0'`).run();

    const mailbox = sessionFor(db);
    const session = fakeSession({ id: 'sess-task', thread_id: TASK_THREAD });
    const ctx = makeCtx({ session, mailbox });

    // Run the tail phase in its declared order, as the driver does.
    for (const d of _listSweepRegistrationsForTesting().duties.filter((x) => x.phase === 'session:tail')) {
      if (d.name === SWEEP_DUTY_INVENTORY.S17) continue; // another family's duty
      await d.run(ctx);
    }

    // The just-fired series re-armed a pending successor, so the GC sees a live
    // task and the session is NOT collected in the same tick.
    expect(mailbox.countLiveTasks()).toBe(1);
    expect(calls.updates).toEqual([]);

    // Control: with nothing re-armed, the same GC duty does close the session.
    const bare = freshInbound();
    const bareCtx = makeCtx({ session, mailbox: sessionFor(bare) });
    await duty(SWEEP_DUTY_INVENTORY.S19).run(bareCtx);
    expect(calls.updates).toEqual([{ id: 'sess-task', patch: { status: 'closed' } }]);
  });

  // ─── F-11.3 ────────────────────────────────────────────────────────────────

  it('script-failure backoff and auto-pause at 8 consecutive failures are unchanged', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(scriptBackoffMinutes)).toEqual([2, 4, 8, 16, 32, 60, 60]);

    // A failing streak pushes the clone past the raw 1-minute cron cadence.
    const failing = freshInbound();
    seedFailedStreak(failing, 3);
    await duty(SWEEP_DUTY_INVENTORY.S18).run(makeCtx({ mailbox: sessionFor(failing) }));
    const backedOff = clone(failing);
    expect(backedOff.status).toBe('pending');
    expect((new Date(backedOff.process_after).getTime() - Date.now()) / 60_000).toBeGreaterThan(7);
    failing.close();

    // A healthy series re-arms on the raw cron grid, with no backoff.
    const healthy = freshInbound();
    seedFailedStreak(healthy, 0);
    await duty(SWEEP_DUTY_INVENTORY.S18).run(makeCtx({ mailbox: sessionFor(healthy) }));
    expect((new Date(clone(healthy).process_after).getTime() - Date.now()) / 60_000).toBeLessThan(2);
    healthy.close();

    // At the cap the series auto-pauses in place instead of re-arming.
    const paused = freshInbound();
    const liveId = seedFailedStreak(paused, 8);
    await duty(SWEEP_DUTY_INVENTORY.S18).run(makeCtx({ mailbox: sessionFor(paused) }));
    const next = paused
      .prepare(
        `SELECT id, status, recurrence FROM messages_in WHERE id NOT LIKE 'task-s-%' AND id NOT LIKE 'task-paused-%'`,
      )
      .get() as { status: string; recurrence: string | null };
    expect(next.status).toBe('paused');
    expect(next.recurrence).toBe('* * * * *');
    expect(
      (paused.prepare(`SELECT recurrence FROM messages_in WHERE id = ?`).get(liveId) as { recurrence: string | null })
        .recurrence,
    ).toBeNull();

    // The paused notice is an obligation due NOW, not on-wake: the series that
    // just paused may have been the only thing that ever woke this container.
    const note = paused.prepare(`SELECT * FROM messages_in WHERE id = ?`).get('task-paused-task-s-0') as {
      content: string;
      process_after: string | null;
      on_wake: number;
    };
    expect(note).toBeTruthy();
    expect(note.on_wake).toBe(0);
    expect(new Date(note.process_after!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(JSON.parse(note.content).text as string).toContain('ncl tasks resume task-s-0');
  });

  // ─── F-11.4 ────────────────────────────────────────────────────────────────

  it('thread-close advance stops the container, then clears saved work and archives, in that order', async () => {
    const thread = 'slack:C1:1.1';
    getRawDb()
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status,
                               last_active, created_at)
         VALUES ('s1', 'ag-test', NULL, ?, 'active', 'stopped', ?, ?)`,
      )
      .run(thread, new Date().toISOString(), new Date().toISOString());
    getRawDb()
      .prepare(
        `INSERT INTO thread_closures (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state)
         VALUES (?, 'admin', ?, NULL, 0, '["s1"]', 'awaiting_confirmation')`,
      )
      .run(thread, new Date(Date.now() - CLOSE_CONFIRM_WINDOW_MS - 1_000).toISOString());
    calls.running = true;
    // Hold the exit callback: the gap between "the kill was requested" and "the
    // container is actually gone" is where a regression would write, and firing
    // `onExit` inline collapses it (Codex delta).
    calls.deferKillExit = true;

    await duty(SWEEP_DUTY_INVENTORY.T8).run(makeCtx());

    // The kill has been REQUESTED and nothing else has happened. `outbound.db`
    // still has its one writer, so a clear here would be the defect.
    expect(calls.order, 'saved work was touched before the container went').toEqual(['kill']);

    // The child closes: ownership drops, then the callback runs.
    expect(calls.killExit, 'the close path was never handed a finalizer').toBeDefined();
    calls.running = false;
    calls.order.push('exit');
    calls.killExit!();
    // The finalizer's work floats off the callback and nothing here returns a
    // promise to await, so wait for its last observable effect — the archive —
    // bounded, so a finalizer that never runs fails an assertion below rather
    // than hanging.
    for (let i = 0; i < 200 && !calls.order.includes('archive'); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Mirrors src/dashboard/thread-close.test.ts's "kills first, then clears
    // once the process is gone, then archives" (the `recordingDeps()` default:
    // a container running throughout, no wake race). Mailbox seam round 6-8
    // inverted this ordering from the pre-guard shape (clear, then kill only
    // if still running, then clear+archive in onExit): outbound.db has one
    // writer, so the host may not clear it while a container still owns it —
    // kill first, then clear once `onExit` proves the process is gone, then
    // archive. This case drives that ordering against a REAL gap: the mock holds
    // `onExit` (`deferKillExit`), the case asserts nothing happened while the
    // container still owned outbound.db, and only then drops ownership and
    // fires the callback itself.
    //
    // Kill requested, container gone, THEN clear, then archive — with 'exit'
    // recorded by this case, so the ordering is asserted against a real gap
    // rather than against a callback the recorder fired for itself.
    expect(calls.order).toEqual(['kill', 'exit', 'clear', 'archive']);
    expect(
      calls.order.filter((step) => step === 'clear'),
      'more than one clear — one of them ran before the exit',
    ).toEqual(['clear']);
    expect(calls.kills).toEqual([{ sessionId: 's1', reason: `thread close ${thread}` }]);
    expect(calls.archives).toEqual(['s1']);

    // …and the closure is still `finalizing`, which is the documented outcome
    // of a REAL deferred exit and the half the old inline-callback fixture hid.
    // `advanceThreadClosures` marks a closure closed only when its sessions are
    // already archived by the time its loop ends, and the archive happens
    // inside `onExit` — which the real `killContainer` fires on a later tick.
    // Its own comment says so: "a session stopping right now is still open and
    // this closure simply advances on the next tick".
    expect(
      (getRawDb().prepare(`SELECT state FROM thread_closures WHERE thread_id = ?`).get(thread) as { state: string })
        .state,
    ).toBe('finalizing');

    // The next tick: the session is archived now, so the duty skips it and
    // closes the row. No second kill — `calls.kills` above is still the one.
    await duty(SWEEP_DUTY_INVENTORY.T8).run(makeCtx());

    expect(calls.kills).toHaveLength(1);
    expect(
      (getRawDb().prepare(`SELECT state FROM thread_closures WHERE thread_id = ?`).get(thread) as { state: string })
        .state,
    ).toBe('closed');
  });

  // ─── Registered-duty wrappers (family-case rule, plan §8) ──────────────────

  it('the registered due-admission duty hands the window session to the host-gated scripts and the admission seam', async () => {
    const db = freshInbound();
    insertTaskRow(db, {
      id: 'task-due',
      seriesId: 'task-due',
      processAfter: new Date(Date.now() - 1_000).toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'fire' }),
    });
    db.prepare(`UPDATE messages_in SET trigger = 1 WHERE id = 'task-due'`).run();
    const mailbox = sessionFor(db);
    const session = fakeSession({ id: 'sess-due' });
    const ctx = makeCtx({ session, mailbox });
    calls.admittedTasks = 1;

    await duty(SWEEP_DUTY_INVENTORY.S5).run(ctx);

    // The window's OWN session, never a second open on the same key — and the
    // GROUP id between it and the session id. `runHostGatedTaskScripts` grew
    // that middle argument with product #251 (per-group timezone): it resolves
    // the owning group's zone for its local-time gate, and a session parameter
    // names the mailbox, not the group whose override applies. This case still
    // pinned the two-argument call, which is precisely why the family move
    // could drop the argument and stay green here — the driver's own body had
    // it, the moved copy did not.
    expect(calls.hostScripts).toHaveLength(1);
    expect(calls.hostScripts[0]![0]).toBe(mailbox);
    expect(calls.hostScripts[0]!.slice(1)).toEqual(['ag-test', 'sess-due']);
    // The admission seam takes the window's own session (mailbox PR 7).
    expect(calls.admissions).toHaveLength(1);
    expect(calls.admissions[0]![0]).toBe(mailbox);
    expect(calls.admissions[0]!.slice(1)).toEqual(['ag-test', 'sess-due']);
    expect(ctx.plan.admittedTasks).toBe(1);
    expect(ctx.plan.dueCount).toBe(1);
    expect(ctx.plan.wakePriority).toBe('scheduled');
  });

  it('a due-admission failure propagates so the registry can log it and retry next tick', async () => {
    calls.hostScriptFails = true;
    const db = freshInbound();
    await expect(duty(SWEEP_DUTY_INVENTORY.S5).run(makeCtx({ mailbox: sessionFor(db) }))).rejects.toThrow(
      /host-gated script blew up/,
    );
  });

  it('the registered thread-close duty swallows an advance failure with its preserved warning', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const boom = new Error('thread-close exploded');
    const threadClose = await import('../../dashboard/thread-close.js');
    vi.spyOn(threadClose, 'advanceThreadClosures').mockRejectedValue(boom);

    await expect(duty(SWEEP_DUTY_INVENTORY.T8).run(makeCtx())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('thread-close sweep step failed', { err: boom });
  });

  it('the registered spent-task GC duty leaves a non-task session alone', async () => {
    const db = freshInbound();
    await duty(SWEEP_DUTY_INVENTORY.S19).run(
      makeCtx({ session: fakeSession({ id: 'sess-chat', thread_id: 'slack:C1:1.1' }), mailbox: sessionFor(db) }),
    );
    expect(calls.updates).toEqual([]);
  });

  // ── Codex final, CRITICAL ─────────────────────────────────────────────────
  //
  // A move in flight is indistinguishable from a spent session by the cheap
  // predicate: it cancels the SOURCE series before inserting into the target,
  // so in between the source holds zero live rows and no container. S19 runs in
  // `session:tail` on every tick; `recoverMoveIntents` (T11, tick:housekeeping)
  // deliberately ignores intents younger than one sweep interval, so on a
  // stopped session the GC always gets there first. Closing the row makes the
  // repair impossible: every later restore's `withQuietInvalidationSync`
  // refuses on a non-active session, the recovery's catch leaves the intent
  // unresolved, and the series stays cancelled with nothing left to fix it.
  it('the registered spent-task GC duty keeps a session an unresolved move intent still names', async () => {
    const db = freshInbound();
    const session = fakeSession({ id: 'sess-moving', thread_id: TASK_THREAD });
    const ctx = makeCtx({ session, mailbox: sessionFor(db) });
    // The audit row the move writes before it cancels the source.
    getRawDb()
      .prepare(
        `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, correlation_id)
         VALUES (?, 'u-owner', 'move_intent', 'ag-test', 'sess-moving', 'ser-moving', 'corr-ser-moving')`,
      )
      .run(new Date().toISOString());

    await duty(SWEEP_DUTY_INVENTORY.S19).run(ctx);

    expect(calls.updates, 'the GC closed the session a move intent still needs').toEqual([]);
    expect(getRawDb().prepare("SELECT status FROM sessions WHERE id = 'sess-moving'").get()).toEqual({
      status: 'active',
    });
  });

  it('the registered spent-task GC duty closes the session once the move intent resolves', async () => {
    const db = freshInbound();
    const session = fakeSession({ id: 'sess-moved', thread_id: TASK_THREAD });
    const ctx = makeCtx({ session, mailbox: sessionFor(db) });
    // Same row, but resolved — which is what `purgeIntentBody` stamps when the
    // move completes or the recovery gives up. The guard must not leak into a
    // permanent leases-forever, so this is the discriminating half: without it
    // the case above would pass for a GC that simply stopped collecting.
    getRawDb()
      .prepare(
        `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, correlation_id, resolved_at)
         VALUES (?, 'u-owner', 'move_intent', 'ag-test', 'sess-moved', 'ser-moved', 'corr-ser-moved', ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());

    await duty(SWEEP_DUTY_INVENTORY.S19).run(ctx);

    expect(calls.updates).toEqual([{ id: 'sess-moved', patch: { status: 'closed' } }]);
  });

  it('the registered spent-task GC duty keeps a session whose container is still running', async () => {
    calls.running = true;
    const db = freshInbound();
    await duty(SWEEP_DUTY_INVENTORY.S19).run(
      makeCtx({ session: fakeSession({ id: 'sess-task', thread_id: TASK_THREAD }), mailbox: sessionFor(db) }),
    );
    expect(calls.updates).toEqual([]);
  });

  // ─── Moved from src/host-sweep.test.ts, assertions unchanged ───────────────

  describe('scheduled due admission precedes wake classification', () => {
    it('counts and classifies the trigger inserted by the admission seam', async () => {
      const inDb = freshInbound();
      const mailbox = sessionFor(inDb);
      // The sweep hands `admitDueTaskContexts` the SESSION now, not a handle
      // (invariant I-9). The stub writes the admitted trigger straight into the
      // fixture DB behind that session, which is what the assertions below read.
      calls.admitImpl = () => {
        inDb
          .prepare(
            `INSERT INTO messages_in
               (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, content)
             VALUES ('task-admitted', 2, 'task', ?, 'pending', ?, NULL, 'task-admitted', 1, '{}')`,
          )
          .run(new Date().toISOString(), new Date(Date.now() - 1_000).toISOString());
        return 1;
      };

      const result = await _prepareDueWakeForTesting(mailbox, 'ag-test', 'sess-test');

      expect(calls.admissions).toEqual([[mailbox, 'ag-test', 'sess-test']]);
      expect(result).toEqual({ admittedTasks: 1, dueCount: 1, wakePriority: 'scheduled' });
    });
  });

  describe('shouldCloseTaskSession', () => {
    it('closes a spent per-task session (no live tasks, no container)', () => {
      expect(shouldCloseTaskSession('system:tasks:task-1', false, 0)).toBe(true);
    });

    it('keeps it while a task is still live (recurring re-armed, or pending/paused)', () => {
      expect(shouldCloseTaskSession('system:tasks:task-1', false, 1)).toBe(false);
    });

    it('keeps it while its container is running (mid-fire)', () => {
      expect(shouldCloseTaskSession('system:tasks:task-1', true, 0)).toBe(false);
    });

    it('never touches non-task sessions', () => {
      expect(shouldCloseTaskSession('telegram:12345', false, 0)).toBe(false);
      expect(shouldCloseTaskSession(null, false, 0)).toBe(false);
    });
  });

  // ─── Tripwire self-check (brief-common.md HARD RULE step 3) ────────────────

  it('the child_process tripwire bites when a seam mock is removed', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });

  it('every fixture path stays under the per-run temp root', () => {
    expect(roots.dir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(roots.dir)).toBe(true);
  });
});
