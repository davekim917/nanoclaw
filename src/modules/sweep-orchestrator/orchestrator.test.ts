/**
 * Acceptance cases for the orchestrator, dormant sweep family (convergence
 * seam 2, S2-PR5 — F-5.1..F-5.4 in docs/specs/upstream-host-sweep-seam/plan.md
 * §8). F-5.4 lives in src/host-sweep-registry.test.ts (it proves a
 * registry-level property — phase placement — not a property of this
 * module's own code).
 *
 * F-5.1's and F-5.2's cases are MOVED, unchanged, from src/host-sweep.test.ts
 * (`describe('sweepTaskWatchdog (C3)')` and `describe('autoArchiveOldCompleted')`)
 * — the bodies they exercise moved from src/host-sweep.ts to
 * ./task-watchdog.ts and ./auto-archive.ts in this same commit. Imports come
 * from those sibling files directly, not from ./index.ts, so this suite never
 * pulls in index.ts's own dependency on host-sweep.ts's full registry import
 * graph (same split as sweep-central/central.test.ts).
 *
 * F-5.3 is new: with the `orchestrator` capability absent (the production
 * steady state — no agent group holds it, so `spawn_task` never fires and the
 * task tables stay empty), both the reconciler and the watchdog duties must
 * run and change nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';

// Hermeticity tripwire (brief-common.md HARD RULE): every case below runs a
// real duty body (sweepTaskWatchdog, autoArchiveOldCompleted,
// runReconcilerSweep). None of this family's own I/O should ever reach a real
// process spawn — every seam it touches (tasks.js, agent-group-capabilities.js,
// watchdog.js, session-manager.js, container-runner.js, db/sessions.js) is
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

const mockGetActiveTasks = vi.fn();
const mockTransitionToTerminal = vi.fn();
const mockGetCapabilityConfig = vi.fn();
const mockPendingTerminalDispatchOutboundSeenAt = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockHasContainerEverRun = vi.fn();
const mockGetSession = vi.fn();
const mockGetOrphanedTasks = vi.fn();

vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: (...args: unknown[]) => mockGetActiveTasks(...args),
    transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
    getOrphanedTasks: (...args: unknown[]) => mockGetOrphanedTasks(...args),
    // Wrapped, not replaced — calls the real DB-backed function by default so
    // F-5.2 (which needs the real implementation against a real test DB) is
    // unaffected. Only the registered-duty-wrapper throwing-path case below
    // overrides it, once, via mockImplementationOnce.
    autoArchiveCompletedBefore: vi.fn(real.autoArchiveCompletedBefore),
  };
});

vi.mock('../orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: (...args: unknown[]) => mockGetCapabilityConfig(...args),
}));

vi.mock('../orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalSpawnOutboundSeenAt: (...args: unknown[]) => mockPendingTerminalDispatchOutboundSeenAt(...args),
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
    hasContainerEverRun: (...args: unknown[]) => mockHasContainerEverRun(...args),
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

// Wrap (not replace) the three duty bodies: `vi.fn(real)` still calls the real
// implementation by default, so every case below and above keeps its existing
// behavior. The wrapping only exists so the registered-duty-wrapper cases
// further down (added pre-review, per plan.md §4.3's registry contract) can
// assert the registry's `run(ctx)` actually calls through, and can swap in a
// throwing implementation for one test at a time via mockImplementationOnce.
vi.mock('./auto-archive.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auto-archive.js')>();
  return { ...real, autoArchiveOldCompleted: vi.fn(real.autoArchiveOldCompleted) };
});
vi.mock('./task-watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./task-watchdog.js')>();
  return { ...real, sweepTaskWatchdog: vi.fn(real.sweepTaskWatchdog) };
});
vi.mock('../orchestrator-dispatch/reconciler.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/reconciler.js')>();
  return { ...real, runReconcilerSweep: vi.fn(real.runReconcilerSweep) };
});

import { autoArchiveOldCompleted } from './auto-archive.js';
import { sweepTaskWatchdog } from './task-watchdog.js';
import { runReconcilerSweep } from '../orchestrator-dispatch/reconciler.js';
import { autoArchiveCompletedBefore } from '../orchestrator-dispatch/db/tasks.js';
// Registers T6/T14/T18 into host-sweep.ts's live registry — needed so the
// registered-duty-wrapper cases below can obtain them by name, the same
// accessor R-7 uses in src/host-sweep-registry.test.ts. Safe to import
// unmocked here: registration only pushes duty objects into an array (no
// body executes) and host-sweep.ts's own import graph is inert at import
// time (src/host-sweep.test.ts already imports it directly with a small
// mock subset — none of its other duties' bodies run unless a full tick
// does, which none of these cases trigger).
import './index.js';
import { _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';

// ── F-5.1 — the task watchdog transitions and parent notifications are unchanged ──

const NOW = Date.parse('2026-04-20T12:00:00.000Z');

function makeTask(
  overrides: Partial<{
    task_id: string;
    parent_session_id: string;
    parent_agent_group_id: string;
    child_session_id: string | null;
    status: 'pending' | 'running';
    admitted_at: string;
    started_at: string | null;
    last_progress_at: string | null;
    deadline: string | null;
  }> = {},
) {
  return {
    task_id: 'task-watchdog-1',
    idempotency_key: 'idem-w1',
    parent_session_id: 'parent-sess',
    parent_agent_group_id: 'parent-ag',
    parent_messaging_group_id: null,
    child_session_id: 'child-sess',
    status: 'running' as const,
    task_content: '{}',
    request_hash: 'hash',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    started_at: new Date(NOW - 9 * 60 * 1000).toISOString(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless' as const,
    created_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

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

describe('the task watchdog transitions and parent notifications are unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue(fakeParentSession());
    mockIsContainerRunning.mockReturnValue(true);
    // Default: container has been observed running. Individual tests that
    // need the "never started yet" case override per-call.
    mockHasContainerEverRun.mockReturnValue(true);
    mockWakeContainer.mockResolvedValue(true);
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockGetCapabilityConfig.mockReturnValue(null); // use defaults
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_watchdog_terminates_no_progress_task: reaped task gets failed + parent notified', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago — past 30 min default
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
    // Watchdog now writes kind='chat' so the orchestrator surfaces the
    // failure to the user via a normal turn input (the prior `kind='system'`
    // envelope had no consumer and sat silently in the inbound).
    expect(mockWriteSessionMessage).toHaveBeenCalledWith(
      task.parent_agent_group_id,
      task.parent_session_id,
      expect.objectContaining({ kind: 'chat' }),
    );
    const writeCallArgs = mockWriteSessionMessage.mock.calls[0]?.[2];
    const parsed = writeCallArgs ? JSON.parse(writeCallArgs.content) : {};
    expect(parsed.text).toContain('Task failed (watchdog)');
    expect(parsed.text).toContain('no_progress_timeout');
    expect(parsed._task_update).toMatchObject({
      task_id: task.task_id,
      status: 'failed',
      fail_reason: 'no_progress_timeout',
      source: 'watchdog',
    });
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  /**
   * The parent can be archived while the notification is being written.
   *
   * `parentSession` is fetched before the awaited mailbox write and was handed
   * straight to `wakeContainer` after it. A reclaim inside that window leaves a
   * snapshot that still says `active`, and waking on it spawns a container
   * `getActiveSessions()` will never return — no stuck detection, no heartbeat
   * ceiling, no claim tolerance, for as long as it runs.
   *
   * The notification itself still lands: the row is durable and the parent may
   * come back. Only the wake is withheld.
   */
  it('hands the parent wake a guard that refuses a session archived under it', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);
    // The reclaim lands while the wake is in flight, which is exactly the window
    // a caller-side re-read cannot observe.
    let parentGone = false;
    mockWriteSessionMessage.mockImplementation(async () => {
      parentGone = true;
    });
    mockGetSession.mockImplementation(() => (parentGone ? undefined : fakeParentSession()));

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockWriteSessionMessage).toHaveBeenCalled();
    // Issued with a guard rather than skipped: the parent can also be archived
    // during the wake's own awaits, which a re-read here could never see.
    const { guard } = mockWakeContainer.mock.calls[0][2] as { guard: () => unknown };
    expect(guard()).toEqual({ ok: false, reason: 'session no longer exists' });
  });

  it('test_watchdog_skips_when_drain_active: task with recent terminal outbound is not reaped', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    // Drain guard: terminal action seen 30s ago, within 120s grace
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(new Date(NOW - 30 * 1000).toISOString());
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('CAS guard: 0-rows transitionToTerminal skips parent notification', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(false); // CAS failed — already terminal

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockTransitionToTerminal).toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('test_one_task_failure_doesnt_skip_others: error in one task does not prevent processing others', async () => {
    // Both tasks have stale progress — both should trigger transitionToTerminal.
    // The first call throws (simulates a corrupt task failing mid-reap).
    const badTask = makeTask({
      task_id: 'bad-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — triggers reap
    });
    const goodTask = makeTask({
      task_id: 'good-task',
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // stale — should also be reaped
    });
    mockGetActiveTasks.mockReturnValue([badTask, goodTask]);
    // First call (bad task) — throws to simulate a corrupt/unrecoverable failure mid-loop
    // Second call (good task) — returns true
    mockTransitionToTerminal
      .mockImplementationOnce(() => {
        throw new Error('synthetic failure');
      })
      .mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    // Both tasks were attempted — try/catch isolation ensures good task ran
    expect(mockTransitionToTerminal).toHaveBeenCalledTimes(2);
    // Only good task (second call) succeeded, so only one parent notification
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('uses per-orchestrator config when available', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago
    });
    // Custom timeout of 60 min — 35 min is within timeout, so no reap
    mockGetCapabilityConfig.mockReturnValue({
      noProgressTimeoutSec: 3600,
      spawnDeadlineSec: 600,
      drainGraceSec: 180,
      concurrencyCap: 5,
    });
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
  });

  it('falls back to default timeouts when capability config is absent', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 35 * 60 * 1000).toISOString(), // 35 min ago — past 30 min default
    });
    mockGetCapabilityConfig.mockReturnValue(null); // no config
    mockGetActiveTasks.mockReturnValue([task]);
    mockTransitionToTerminal.mockReturnValue(true);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    // Default 1800s = 30 min; 35 min ago should trigger no-progress reap
    expect(mockTransitionToTerminal).toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'no_progress_timeout' }),
    );
  });

  // test_watchdog_fail_reason_canonical: all 4 watchdog actions produce canonical fail_reason values
  it.each([
    {
      label: 'no-progress → no_progress_timeout',
      taskOverrides: { last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
      expectedFailReason: 'no_progress_timeout',
    },
    {
      label: 'deadline → deadline_exceeded',
      taskOverrides: {
        deadline: new Date(NOW - 60 * 60 * 1000).toISOString(),
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
      },
      expectedFailReason: 'deadline_exceeded',
    },
    {
      label: 'spawn-deadline → spawn_deadline',
      taskOverrides: {
        status: 'pending' as const,
        started_at: null,
        last_progress_at: null,
        admitted_at: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10 min > 5 min spawn deadline
      },
      expectedFailReason: 'spawn_deadline',
    },
    {
      label: 'container-exit → container_exit',
      taskOverrides: {
        child_session_id: 'child-sess',
        last_progress_at: new Date(NOW - 2 * 60 * 1000).toISOString(), // recent progress
      },
      expectedFailReason: 'container_exit',
      childContainerStopped: true,
    },
  ])(
    'test_watchdog_fail_reason_canonical: $label',
    async ({ taskOverrides, expectedFailReason, childContainerStopped }) => {
      const task = makeTask(taskOverrides);
      mockGetActiveTasks.mockReturnValue([task]);
      mockTransitionToTerminal.mockReturnValue(true);
      if (childContainerStopped) {
        mockIsContainerRunning.mockReturnValue(false);
        // Sticky bit: container WAS observed running, now stopped — the
        // case `fail-container-exit` is designed for. Without this the
        // bug-fix logic treats the child as "never started" and returns ok.
        mockHasContainerEverRun.mockReturnValue(true);
      }

      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      await sweepTaskWatchdog();

      expect(mockTransitionToTerminal).toHaveBeenCalledWith(
        task.task_id,
        'failed',
        expect.objectContaining({ fail_reason: expectedFailReason }),
      );
    },
  );

  it('test_watchdog_does_not_reap_container_exit_before_container_ever_started', async () => {
    // Regression: under concurrency cap the 4th-of-4 spawned child created
    // its session row immediately but waited 78s for an actual container.
    // The watchdog ran during the gap, saw `isContainerRunning(child) === false`,
    // and reaped as `fail-container-exit` — terminally failing a task before
    // it had a chance to start. Observed against the spawn-board build for
    // task spawn-80a5ba9b2f8b532b at 01:53:10 UTC on 2026-05-11; the
    // container then actually spawned, the child completed the work, and
    // its `spawn_complete` was discarded because the task was already
    // terminal.
    //
    // Correct behavior: when the container has never been observed running,
    // `childContainerStatus` is null, not 'stopped', and the watchdog must
    // not reap as container_exit. (Other reapers — no_progress_timeout,
    // spawn_deadline — still cover legitimate stuck-spawn failure modes.)
    const task = makeTask({
      child_session_id: 'child-sess-queued',
      last_progress_at: new Date(NOW - 30 * 1000).toISOString(), // 30s old, well within timeout
    });
    mockGetActiveTasks.mockReturnValue([task]);
    mockIsContainerRunning.mockReturnValue(false);
    mockHasContainerEverRun.mockReturnValue(false); // critical: never started

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await sweepTaskWatchdog();

    expect(mockTransitionToTerminal).not.toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'container_exit' }),
    );
  });
});

// ── F-5.2 — auto-archive covers completed tasks older than 24h and never failed tasks ──

describe('auto-archive covers completed tasks older than 24h and never failed tasks', () => {
  beforeEach(() => {
    const db = initTestDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Seed agent_group + session so task FKs hold
    getDb()
      .prepare(
        "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'ag-1', 'ag-1', NULL, datetime('now'))",
      )
      .run();
    getDb()
      .prepare("INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('sess-1', 'ag-1', datetime('now'))")
      .run();
  });
  afterEach(() => {
    closeDb();
  });

  function insertCompletedTask(taskId: string, completedAt: string): void {
    getDb()
      .prepare(
        `INSERT INTO tasks (
          task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          status, task_content, request_hash, admitted_at, completed_at,
          dispatch_completion_attempts, surface_mode, needs_input, created_at
        ) VALUES (?, ?, 'sess-1', 'ag-1', 'completed', '{}', 'h', ?, ?, 0, 'headless', 0, ?)`,
      )
      .run(taskId, taskId, completedAt, completedAt, completedAt);
  }

  it('archives completed tasks older than 24 hours', () => {
    insertCompletedTask('old', new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    insertCompletedTask('fresh', new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString());

    autoArchiveOldCompleted();

    const rows = getDb().prepare('SELECT task_id, archived_at FROM tasks ORDER BY task_id').all() as Array<{
      task_id: string;
      archived_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r.archived_at]));
    expect(byId['old']).not.toBeNull();
    expect(byId['fresh']).toBeNull();
  });

  it('does not re-archive already-archived rows', () => {
    const original = '2026-05-01T00:00:00.000Z';
    insertCompletedTask('t1', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    getDb().prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = 't1'`).run(original);

    autoArchiveOldCompleted();

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('t1') as { archived_at: string };
    expect(row.archived_at).toBe(original);
  });

  it('leaves failed tasks alone regardless of age', () => {
    getDb()
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

    autoArchiveOldCompleted();

    const row = getDb().prepare('SELECT archived_at FROM tasks WHERE task_id = ?').get('f1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });
});

// ── F-5.3 — the dormant module takes no action when the spawn_task capability is revoked ──

describe('the dormant module takes no action when the spawn_task capability is revoked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The capability-absent steady state: no agent group has ever admitted a
    // task or an orphaned one, because spawn_task never fires
    // (src/modules/orchestrator-dispatch/index.ts — PARKED 2026-08-11).
    mockGetActiveTasks.mockReturnValue([]);
    mockGetOrphanedTasks.mockReturnValue([]);
  });

  it('the watchdog reads the empty task table and changes nothing', async () => {
    await sweepTaskWatchdog();

    expect(mockGetActiveTasks).toHaveBeenCalled();
    expect(mockTransitionToTerminal).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('the reconciler reads the empty orphaned-task table and schedules nothing', () => {
    // runReconcilerSweep is the real function (not mocked) — only its own
    // getOrphanedTasks dependency is faked to the dormant-capability state.
    // With no orphans it returns immediately, before ever touching
    // completeSpawnSideEffects/setImmediate.
    expect(() => runReconcilerSweep()).not.toThrow();
    expect(mockGetOrphanedTasks).toHaveBeenCalled();
  });
});

// ── registered duty wrappers drive their underlying functions ────────────────
//
// F-5.1..F-5.3 above exercise the duty BODIES directly. These cases exercise
// the registered wrapper each body sits behind — obtained from the registry
// by name, the same accessor R-7 uses in src/host-sweep-registry.test.ts —
// proving the move preserved both the call-through and the failure contract
// each wrapper relied on before it left host-sweep.ts. `run(ctx)` never reads
// `ctx` for any of the three, so a minimal fake tick context stands in.

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

    duty.run(fakeTickContext());

    expect(runReconcilerSweep).toHaveBeenCalledTimes(1);
    expect(runReconcilerSweep).toHaveBeenCalledWith();
  });

  it('a throw from runReconcilerSweep propagates out of run(ctx) uncaught', () => {
    // T6 "carries no guard of its own" (index.ts's own comment) — the phase
    // runner (src/host-sweep.ts's runTickPhase) is the only thing that
    // catches it and logs 'Host sweep duty failed'. This wrapper must not
    // have grown a try/catch of its own during the move.
    const duty = getDuty('orchestrator-reconciler');
    vi.mocked(runReconcilerSweep).mockImplementationOnce(() => {
      throw new Error('reconciler boom');
    });

    expect(() => duty.run(fakeTickContext())).toThrow('reconciler boom');
  });
});

describe('the registered task-watchdog wrapper calls sweepTaskWatchdog', () => {
  beforeEach(() => {
    vi.mocked(sweepTaskWatchdog).mockClear();
    mockGetActiveTasks.mockReturnValue([]);
  });

  it('run(ctx) calls sweepTaskWatchdog with no arguments', async () => {
    const duty = getDuty('task-watchdog');

    await duty.run(fakeTickContext());

    expect(sweepTaskWatchdog).toHaveBeenCalledTimes(1);
    expect(sweepTaskWatchdog).toHaveBeenCalledWith();
  });

  it('a failure inside sweepTaskWatchdog logs the preserved string and does not reject', async () => {
    // sweepTaskWatchdog's own top-level try/catch (task-watchdog.ts) is what
    // the pre-move body relied on — this proves the move kept it: a failure
    // this deep still produces 'Task watchdog: failed to load active tasks'
    // and the wrapper still resolves, exactly as it did inside host-sweep.ts.
    const duty = getDuty('task-watchdog');
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    mockGetActiveTasks.mockImplementationOnce(() => {
      throw new Error('db boom');
    });

    await expect(duty.run(fakeTickContext())).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith('Task watchdog: failed to load active tasks', expect.objectContaining({}));
    error.mockRestore();
  });
});

describe('the registered completed-task-auto-archive wrapper calls autoArchiveOldCompleted', () => {
  beforeEach(() => {
    vi.mocked(autoArchiveOldCompleted).mockClear();
  });

  it('run(ctx) calls autoArchiveOldCompleted with no arguments', () => {
    const duty = getDuty('completed-task-auto-archive');

    duty.run(fakeTickContext());

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
