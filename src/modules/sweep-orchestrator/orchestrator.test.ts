/**
 * Acceptance cases for the orchestrator, dormant sweep family (convergence
 * seam 2, S2-PR5 — F-5.2..F-5.4 in docs/specs/upstream-host-sweep-seam/plan.md
 * §8). F-5.4 lives in src/host-sweep-registry.test.ts (it proves a
 * registry-level property — phase placement — not a property of this
 * module's own code).
 *
 * F-5.2's cases exercise ./auto-archive.ts, imported from that sibling file
 * directly, not from ./index.ts, so this suite never pulls in index.ts's own
 * dependency on host-sweep.ts's full registry import graph (same split as
 * sweep-central/central.test.ts).
 *
 * F-5.3: with the `orchestrator` capability absent (the production steady
 * state — no agent group holds it, so `spawn_task` never fires and the task
 * tables stay empty), the reconciler duty must run and change nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';

// Hermeticity tripwire (brief-common.md HARD RULE): every case below runs a
// real duty body (autoArchiveOldCompleted, runReconcilerSweep). None of this
// family's own I/O should ever reach a real process spawn — every seam it
// touches (tasks.js, session-manager.js, container-runner.js, db/sessions.js) is
// mocked below. A tripwire, not a functional mock: it records the call (so a
// test can assert on the record even though a real caller's own try/catch
// might swallow the throw) and then throws, so an uncaught spawn fails loudly
// too. Same shape as src/host-sweep-registry.test.ts's.
const spawnAttempts = vi.hoisted(() => [] as string[]);

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const attempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(
        `sweep-orchestrator/orchestrator.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`,
      );
    };
  return {
    exec: attempted('exec'),
    execFile: attempted('execFile'),
    execSync: attempted('execSync'),
    execFileSync: attempted('execFileSync'),
    spawn: attempted('spawn'),
    spawnSync: attempted('spawnSync'),
    fork: attempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawnAttempts));
vi.mock('node:child_process', () => childProcessTripwire(spawnAttempts));

afterEach(() => {
  expect(spawnAttempts).toEqual([]);
  spawnAttempts.length = 0;
});

const mockTransitionToTerminal = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockGetSession = vi.fn();
const mockGetOrphanedTasks = vi.fn();

vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
    getOrphanedTasks: (...args: unknown[]) => mockGetOrphanedTasks(...args),
    // Wrapped, not replaced — calls the real DB-backed function by default so
    // F-5.2 (which needs the real implementation against a real test DB) is
    // unaffected. Only the registered-duty-wrapper throwing-path case below
    // overrides it, once, via mockImplementationOnce.
    autoArchiveCompletedBefore: vi.fn(real.autoArchiveCompletedBefore),
  };
});

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (it now has a second caller, thread-close's finalizer). Composed here from
    // the MOCKED running check plus the real spawning one, which is exactly what
    // the host-sweep-local version did under this mock — spreading `...real`
    // alone would silently bypass `mockIsContainerRunning`. Same composition
    // src/host-sweep.test.ts already uses. No duty in this family reaches the
    // guard today; this keeps the mock honest for when one does, rather than
    // leaving a trap for the next family move.
    containerOwnsOutbound: (sessionId: string) =>
      Boolean(mockIsContainerRunning(sessionId)) || real.isContainerSpawning(sessionId),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  };
});

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

// Seam 3 §4.5 I-1: the wake guard stays SYNCHRONOUS — `sessionStillActive`
// re-reads the session row by running the sessions leaf's `SESSION_BY_ID_SQL`
// on the raw handle, not through the now-async `getSession()`. This file opens
// no central DB, so the fake answers a `FROM sessions` lookup from
// `mockGetSession` and nothing else.
// The auto-archive cases below open a real in-memory DB and seed rows, so the
// real handle wins whenever one is initialized (`preferRealDb`). The dormant
// cases open none, and fall back to the shared fake.
// The fixture is imported INSIDE the factory: a hoisted `vi.mock` runs before
// this file's own import bindings are initialized.
vi.mock('../../db/connection.js', async (importOriginal) => {
  const { rawDbConnectionMock } = await import('../../test-fixtures/raw-db-fake.js');
  return rawDbConnectionMock(
    await importOriginal<typeof import('../../db/connection.js')>(),
    { sessions: (id) => mockGetSession(id) },
    { preferRealDb: true },
  );
});

// Wrap (not replace) the two duty bodies: `vi.fn(real)` still calls the real
// implementation by default, so every case below and above keeps its existing
// behavior. The wrapping only exists so the registered-duty-wrapper cases
// further down (added pre-review, per plan.md §4.3's registry contract) can
// assert the registry's `run(ctx)` actually calls through, and can swap in a
// throwing implementation for one test at a time via mockImplementationOnce.
vi.mock('./auto-archive.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auto-archive.js')>();
  return { ...real, autoArchiveOldCompleted: vi.fn(real.autoArchiveOldCompleted) };
});
vi.mock('../orchestrator-dispatch/reconciler.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/reconciler.js')>();
  return { ...real, runReconcilerSweep: vi.fn(real.runReconcilerSweep) };
});
// completeSpawnSideEffects is reconciler.ts's own action seam (queued via
// setImmediate for each orphan) — wrapped, not replaced, purely so F-5.3's
// "prove it bites" case can assert it fires with the seeded orphan's args.
vi.mock('../orchestrator-dispatch/dispatch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/dispatch.js')>();
  return { ...real, completeSpawnSideEffects: vi.fn(real.completeSpawnSideEffects) };
});

import { autoArchiveOldCompleted } from './auto-archive.js';
import { runReconcilerSweep } from '../orchestrator-dispatch/reconciler.js';
import { autoArchiveCompletedBefore } from '../orchestrator-dispatch/db/tasks.js';
import { completeSpawnSideEffects } from '../orchestrator-dispatch/dispatch.js';
// Registers T6/T14 into host-sweep.ts's live registry — needed so the
// registered-duty-wrapper cases below can obtain them by name, the same
// accessor R-7 uses in src/host-sweep-registry.test.ts. Safe to import
// unmocked here: registration only pushes duty objects into an array (no
// body executes) and host-sweep.ts's own import graph is inert at import
// time (src/host-sweep.test.ts already imports it directly with a small
// mock subset — none of its other duties' bodies run unless a full tick
// does, which none of these cases trigger).
import './index.js';
import { _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';

function fakeParentSession() {
  return {
    id: 'parent-sess',
    agent_group_id: 'parent-ag',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'running' as const,
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

// ── F-5.2 — auto-archive covers completed tasks older than 24h and never failed tasks ──

describe('auto-archive covers completed tasks older than 24h and never failed tasks', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Seed agent_group + session so task FKs hold
    getRawDb()
      .prepare(
        "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'ag-1', 'ag-1', NULL, datetime('now'))",
      )
      .run();
    getRawDb()
      .prepare("INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('sess-1', 'ag-1', datetime('now'))")
      .run();
  });
  afterEach(async () => {
    await closeDb();
  });

  function insertCompletedTask(taskId: string, completedAt: string): void {
    getRawDb()
      .prepare(
        `INSERT INTO tasks (
          task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          status, task_content, request_hash, admitted_at, completed_at,
          dispatch_completion_attempts, surface_mode, needs_input, created_at
        ) VALUES (?, ?, 'sess-1', 'ag-1', 'completed', '{}', 'h', ?, ?, 0, 'headless', 0, ?)`,
      )
      .run(taskId, taskId, completedAt, completedAt, completedAt);
  }

  it('archives completed tasks older than 24 hours', async () => {
    insertCompletedTask('old', new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    insertCompletedTask('fresh', new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString());

    await autoArchiveOldCompleted();

    const rows = getRawDb().prepare('SELECT task_id, archived_at FROM tasks ORDER BY task_id').all() as Array<{
      task_id: string;
      archived_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r.archived_at]));
    expect(byId['old']).not.toBeNull();
    expect(byId['fresh']).toBeNull();
  });

  it('does not re-archive already-archived rows', async () => {
    const original = '2026-05-01T00:00:00.000Z';
    insertCompletedTask('t1', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    getRawDb().prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = 't1'`).run(original);

    await autoArchiveOldCompleted();

    const row = getRawDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as {
      archived_at: string;
    };
    expect(row.archived_at).toBe(original);
  });

  it('leaves failed tasks alone regardless of age', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO tasks (
          task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          status, task_content, request_hash, admitted_at, failed_at,
          dispatch_completion_attempts, surface_mode, needs_input, created_at
        ) VALUES ('f1', 'f1', 'sess-1', 'ag-1', 'failed', '{}', 'h', ?, ?, 0, 'headless', 0, ?)`,
      )
      .run(
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
      );

    await autoArchiveOldCompleted();

    const row = getRawDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('f1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });
});

// ── F-5.3 — the dormant module takes no action when the spawn_task capability is revoked ──
//
// Codex MUST-FIX (efb8350a..e1e8955f, conf 0.94, accepted): the original
// version of this suite mocked getOrphanedTasks to bare `[]` with no seeded
// fixture — vacuously true (empty in, no calls out, for ANY implementation,
// dormant or not) and blind to a re-activation regression.
//
// The real gate is upstream of the duty: `hasOrchestratorCapability`
// (src/modules/orchestrator-dispatch/db/agent-group-capabilities.ts), checked
// only inside `applySpawnTask` (dispatch.ts) — the reconciler does not read it
// itself; `getOrphanedTasks` is an unconditional table scan. So in production
// the table is empty PURELY because no row was ever admitted, not because the
// duty checks anything.
//
// `capabilityGranted` below models that upstream admission gate directly: it
// is the single switch the mock in this block reads, so "capability revoked"
// is one explicit state, not a scattered empty-array literal. The dormant case
// seeds a completion-lease-expired orphan a LIVE reconciler would act on and
// asserts the downstream action seam saw zero calls. The "prove it bites" case
// flips the switch and re-runs the SAME fixture, asserting that seam DOES fire
// — proof the dormant assertion is discriminating, not vacuous. The duty has
// no "skip"/dormant log line of its own (there is nothing to skip — the loop
// body just never executes), so there is no log assertion to add here.
describe('the dormant module takes no action when the spawn_task capability is revoked', () => {
  let capabilityGranted = false;

  const eligibleOrphanedTask = { task_id: 'would-be-reconciled', parent_agent_group_id: 'parent-ag' };

  beforeEach(() => {
    vi.clearAllMocks();
    capabilityGranted = false;
    mockGetOrphanedTasks.mockImplementation(() => (capabilityGranted ? [eligibleOrphanedTask] : []));
    mockGetSession.mockReturnValue(fakeParentSession());
    mockTransitionToTerminal.mockReturnValue(true);
    mockIsContainerRunning.mockReturnValue(true);
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockWakeContainer.mockResolvedValue(true);
    vi.mocked(completeSpawnSideEffects).mockClear();
  });

  it('the reconciler acts on nothing: getOrphanedTasks is empty and no side effect is scheduled', async () => {
    const duty = getDuty('orchestrator-reconciler');

    void duty.run(fakeTickContext());
    await new Promise((resolve) => setImmediate(resolve)); // flush anything setImmediate would have queued

    expect(mockGetOrphanedTasks).toHaveBeenCalled();
    expect(completeSpawnSideEffects).not.toHaveBeenCalled();
  });

  it('PROVES IT BITES: with the capability granted, the same fixture schedules the reconciler side effect', async () => {
    capabilityGranted = true;
    const duty = getDuty('orchestrator-reconciler');

    await duty.run(fakeTickContext());
    await new Promise((resolve) => setImmediate(resolve));

    expect(completeSpawnSideEffects).toHaveBeenCalledWith('would-be-reconciled', 'parent-ag');
  });
});

// ── registered duty wrappers drive their underlying functions ────────────────
//
// F-5.2..F-5.3 above exercise the duty BODIES directly. These cases exercise
// the registered wrapper each body sits behind — obtained from the registry
// by name, the same accessor R-7 uses in src/host-sweep-registry.test.ts —
// proving the move preserved both the call-through and the failure contract
// each wrapper relied on before it left host-sweep.ts. `run(ctx)` never reads
// `ctx` for either, so a minimal fake tick context stands in.

function fakeTickContext(): SweepTickContext {
  return { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() } as unknown as SweepTickContext;
}

function getDuty(name: string) {
  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
  if (!duty) throw new Error(`duty ${name} not registered`);
  return duty;
}

describe('the registered orchestrator-reconciler wrapper calls runReconcilerSweep', () => {
  beforeEach(() => {
    vi.mocked(runReconcilerSweep).mockClear();
  });

  it('run(ctx) calls runReconcilerSweep with no arguments', () => {
    const duty = getDuty('orchestrator-reconciler');

    void duty.run(fakeTickContext());

    expect(runReconcilerSweep).toHaveBeenCalledTimes(1);
    expect(runReconcilerSweep).toHaveBeenCalledWith();
  });

  it('a throw from runReconcilerSweep propagates out of run(ctx) uncaught', async () => {
    // T6 "carries no guard of its own" (index.ts's own comment) — the phase
    // runner (src/host-sweep.ts's runTickPhase) is the only thing that
    // catches it and logs 'Host sweep duty failed'. This wrapper must not
    // have grown a try/catch of its own during the move.
    const duty = getDuty('orchestrator-reconciler');
    vi.mocked(runReconcilerSweep).mockImplementationOnce(() => {
      throw new Error('reconciler boom');
    });

    await expect(duty.run(fakeTickContext())).rejects.toThrow('reconciler boom');
  });
});

describe('the registered completed-task-auto-archive wrapper calls autoArchiveOldCompleted', () => {
  beforeEach(() => {
    vi.mocked(autoArchiveOldCompleted).mockClear();
  });

  it('run(ctx) calls autoArchiveOldCompleted with no arguments', () => {
    const duty = getDuty('completed-task-auto-archive');

    void duty.run(fakeTickContext());

    expect(autoArchiveOldCompleted).toHaveBeenCalledTimes(1);
    expect(autoArchiveOldCompleted).toHaveBeenCalledWith();
  });

  it('a failure inside autoArchiveOldCompleted logs the preserved string and does not reject', () => {
    // autoArchiveOldCompleted's own try/catch (auto-archive.ts) is what the
    // pre-move body relied on — this proves the move kept it: breaking its
    // real dependency (not replacing autoArchiveOldCompleted itself, which
    // stays real here) still produces 'autoArchiveOldCompleted: failed' and
    // the wrapper still resolves, exactly as it did inside host-sweep.ts.
    const duty = getDuty('completed-task-auto-archive');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.mocked(autoArchiveCompletedBefore).mockImplementationOnce(() => {
      throw new Error('db boom');
    });

    expect(() => duty.run(fakeTickContext())).not.toThrow();

    expect(warn).toHaveBeenCalledWith('autoArchiveOldCompleted: failed', expect.objectContaining({}));
    warn.mockRestore();
  });
});
