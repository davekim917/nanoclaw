/**
 * Acceptance cases for claim-first spawn (seam 4 series A′,
 * docs/specs/upstream-restart-survival-seam/plan.md §7.A′).
 *
 * `session_claims` becomes the cross-process fence in front of every container
 * start: the spawn path takes a compare-and-set on the row's incarnation before
 * it touches any of the session's runtime state, and hands it back on every
 * refusal and at container exit. These cases pin the four properties that makes
 * or breaks:
 *
 *  1. the claim precedes the first runtime-state write (the heartbeat clear),
 *  2. a lost CAS or a failed claim write starts no container,
 *  3. every refusal between the claim and `spawn()` releases it, and
 *  4. the release is scoped to the incarnation the releasing runtime held, so a
 *     late release cannot unclaim a container that replaced it.
 *
 * The claim is also the LAST `await` in the spawn path — the guard point and
 * `spawn()` stay adjacent (seam 3 §4.5 I-1) — which is a source property, so it
 * is pinned by an AST case at the end of this file rather than at runtime.
 *
 * The coordination accessors are the REAL ones over a real SQLite test DB: the
 * CAS and the scoped release are the behavior under test, and a hand-rolled
 * in-memory claim store would prove only that this file agrees with itself. The
 * mock around them exists to (a) record call order and (b) inject the two
 * failures a single-process test cannot otherwise produce — a CAS that loses to
 * a concurrent claimant, and a write that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => {
  const root = uniqueTmpRoot('session-claim-spawn');
  return { TEST_DATA_DIR: `${root}/data`, TEST_GROUPS_DIR: `${root}/groups` };
});

// Both roots move under one temp tree: the spawn path reads the group's folder
// as well as its session directory, and neither may be the install's.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope, so importOriginal()
// would install those in this file's worker (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// A container runtime binary that does not exist: `spawn()` still returns a
// ChildProcess and registers, then fails with ENOENT and drives the real
// close/error finalization — which is exactly the terminal path case 8 needs.
// It also keeps the memory-admission budget probe (`docker info`) off the wire.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
  // The P2 probe (`docker ps`), answered from the test's own fake runtime so
  // no listing ever leaves the process. Every call is counted: the steady-state
  // proof is that a claim with no `container_ref` makes none.
  runtimeShowsRunning: (name: string) => {
    hooks.runtimeCalls += 1;
    if (hooks.runtimeListingFails) throw new Error('Cannot connect to the Docker daemon');
    return hooks.runtimeRunning.has(name);
  },
  // The adopter's supervision channel, faked so the P2-bypass case never
  // spawns a real `docker wait`. Never exits; the case releases it explicitly.
  waitForContainerExit: () => {
    const waiter = new (hooks.EventEmitter as typeof import('node:events').EventEmitter)() as unknown as {
      exitCode: number | null;
      kill: () => boolean;
      stdout: null;
      stderr: null;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    waiter.exitCode = null;
    waiter.stdout = null;
    waiter.stderr = null;
    waiter.kill = () => true;
    hooks.waiters.push(waiter);
    return waiter as unknown as import('child_process').ChildProcess;
  },
}));

/**
 * Test control surface, shared by the mock factories below.
 *
 * `events` is the ordered call log the ordering cases read; the two `*Gate`
 * promises park the spawn path at a chosen await so a test can act while it is
 * genuinely in flight.
 */
const hooks = vi.hoisted(() => ({
  events: [] as string[],
  /** `getSessionClaim` reports one incarnation behind — a lost CAS. */
  staleRead: false,
  /** `tryClaimSession` rejects — a claim that cannot be recorded. */
  claimWriteFails: false,
  /** `startHostInstanceLease` rejects — the host has no durable id at all. */
  leaseStartFails: false,
  /** How many times the spawn path entered the lease starter. */
  leaseStartCalls: 0,
  /** Parks inside `startHostInstanceLease`, so a second wake can pile onto it. */
  leaseStartGate: null as Promise<void> | null,
  /** Every `getHostInstanceId()` read, so a test can see callers arrive. */
  idReads: 0,
  /** `renewHostInstanceLease` rejects — a lapsed self lease cannot be re-armed. */
  leaseRenewalFails: false,
  /** Parks inside `getSessionClaim`, i.e. immediately before the claim. */
  preClaimGate: null as Promise<void> | null,
  /** Parks `releaseSessionClaim` for one incarnation, keyed by that number. */
  releaseGates: new Map<number, Promise<void>>(),
  /** Parks the wake at its first await (background storage admission). */
  storageGate: null as Promise<void> | null,
  /** Container names the fake runtime reports as running (P2). */
  runtimeRunning: new Set<string>(),
  /** `runtimeShowsRunning` throws — the runtime cannot be asked. */
  runtimeListingFails: false,
  /** How many times the claim asked the runtime. */
  runtimeCalls: 0,
  /**
   * `spawn()` hands back a child whose `error` fires in a MICROTASK queued
   * inside the spawn call — earlier than any continuation of the `await`
   * around the lease block can run. Real ENOENT/EACCES errors fire on
   * `process.nextTick`, which Node drains only after the microtask queue, so
   * the awaited continuation happens to win there; this hook removes that
   * scheduler dependence and pins the guarantee itself: the listeners exist
   * before the lease block returns the child.
   */
  spawnErrorsInMicrotask: false,
  /** Fake `docker wait` observers handed to the adopter. */
  waiters: [] as Array<{ exitCode: number | null; emit: (event: string, ...args: unknown[]) => boolean }>,
  EventEmitter: null as null | typeof import('node:events').EventEmitter,
  reset(): void {
    this.waiters = [];
    this.events.length = 0;
    this.runtimeRunning.clear();
    this.runtimeListingFails = false;
    this.runtimeCalls = 0;
    this.staleRead = false;
    this.claimWriteFails = false;
    this.leaseStartFails = false;
    this.leaseRenewalFails = false;
    this.leaseStartCalls = 0;
    this.leaseStartGate = null;
    this.idReads = 0;
    this.preClaimGate = null;
    this.releaseGates.clear();
    this.storageGate = null;
    this.spawnErrorsInMicrotask = false;
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((...spawnArgs: Parameters<typeof real.spawn>) => {
      if (!hooks.spawnErrorsInMicrotask) return real.spawn(...spawnArgs);
      const Emitter = hooks.EventEmitter as typeof import('node:events').EventEmitter;
      const child = new Emitter() as unknown as import('child_process').ChildProcess & {
        stdout: import('node:events').EventEmitter;
        stderr: import('node:events').EventEmitter;
      };
      Object.assign(child, {
        stdout: new Emitter(),
        stderr: new Emitter(),
        exitCode: null,
        pid: undefined,
        kill: () => true,
      });
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn nanoclaw-absent ENOENT'), { code: 'ENOENT' }));
        child.emit('close', null);
      });
      return child;
    }) as typeof real.spawn,
  };
});

vi.mock('./db/coordination.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/coordination.js')>();
  return {
    ...real,
    getSessionClaim: async (sessionId: string) => {
      // Announced BEFORE the gate, so a test can wait for the spawn to be
      // parked here — past every early refusal check, one await short of the
      // compare-and-set — instead of guessing at microtask counts.
      hooks.events.push(`pre-claim:${sessionId}`);
      if (hooks.preClaimGate) await hooks.preClaimGate;
      const row = await real.getSessionClaim(sessionId);
      // A concurrent claimant bumped the row between our read and our CAS. The
      // stale read is how a single process reproduces that race exactly.
      if (hooks.staleRead && row) return { ...row, incarnation: row.incarnation - 1 };
      return row;
    },
    tryClaimSession: async (args: Parameters<typeof real.tryClaimSession>[0]) => {
      if (hooks.claimWriteFails) throw new Error('session_claims write failed');
      const incarnation = await real.tryClaimSession(args);
      hooks.events.push(`claim:${args.sessionId}:${incarnation}`);
      return incarnation;
    },
    renewHostInstanceLease: async (instanceId: string, leaseExpiresAt: string) => {
      if (hooks.leaseRenewalFails) throw new Error('host_instances renewal failed');
      hooks.events.push(`renew:${instanceId}`);
      return real.renewHostInstanceLease(instanceId, leaseExpiresAt);
    },
    releaseSessionClaim: async (args: Parameters<typeof real.releaseSessionClaim>[0]) => {
      hooks.events.push(`release:${args.sessionId}:${args.incarnation}`);
      const gate = hooks.releaseGates.get(args.incarnation);
      if (gate) await gate;
      return real.releaseSessionClaim(args);
    },
  };
});

// The lease itself is real — `getHostInstanceId` must keep answering from the
// module's own state — but its registration can be made to fail, which is the
// state main.ts's fail-open boot leaves behind when the INSERT does not land.
vi.mock('./host-instance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./host-instance.js')>();
  return {
    ...real,
    getHostInstanceId: () => {
      hooks.idReads += 1;
      return real.getHostInstanceId();
    },
    startHostInstanceLease: async (options?: Parameters<typeof real.startHostInstanceLease>[0]) => {
      hooks.leaseStartCalls += 1;
      if (hooks.leaseStartGate) await hooks.leaseStartGate;
      if (hooks.leaseStartFails) throw new Error('host_instances INSERT failed');
      return real.startHostInstanceLease(options);
    },
  };
});

// The image deps-drift check is a `docker inspect` round-trip, which a unit
// test must not make and which the absent runtime binary above turns into a
// hard spawn refusal long before the claim. Answer it as "in sync".
vi.mock('./agent-runner-image-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-runner-image-check.js')>()),
  checkAgentRunnerDepsDrift: async (imageRef: string) => ({
    ok: true,
    imageRef,
    expected: 'test',
    actual: 'test',
    lookup: { kind: 'found' as const, value: 'test' },
    retried: false,
    message: 'in sync',
  }),
}));

// The OneCLI gateway apply and the secret assignment are live control-API
// round-trips on every spawn. Answered as "applied, nothing to assign": the
// gateway contract has its own suites, and a spawn that cannot reach it is a
// refusal ABOVE the claim, which would mask every case below.
vi.mock('./onecli-apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-apply.js')>()),
  applyOnecliContainerConfig: async () => ({ applied: true, attempts: 1, durationsMs: [0], diagnosis: null }),
}));
vi.mock('./onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-secrets.js')>()),
  ensureOnecliAgent: async () => undefined,
  applyOnecliSecrets: async () => undefined,
}));

vi.mock('./storage-maintenance-worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage-maintenance-worker.js')>();
  return {
    ...actual,
    assertStorageAdmissionInBackground: async () => {
      if (hooks.storageGate) await hooks.storageGate;
      return { allowed: true } as Awaited<
        ReturnType<typeof import('./storage-maintenance-worker.js').assertStorageAdmissionInBackground>
      >;
    },
  };
});

// Admission always succeeds: the real controller sizes its budget from a
// `docker info` probe at first use, which a unit test must not make.
vi.mock('./memory-admission.js', () => {
  class AlwaysAdmits<T> {
    readonly budgetMb: number;
    constructor(budgetMb: number) {
      this.budgetMb = budgetMb;
    }
    get reservedMb(): number {
      return 0;
    }
    get queuedCount(): number {
      return 0;
    }
    isQueued(): boolean {
      return false;
    }
    hasReservation(): boolean {
      return false;
    }
    request(_id: string, requestMb: number, _payload: T): MemoryAdmissionResult {
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }
    release(): T[] {
      return [];
    }
    cancel(): T[] {
      return [];
    }
    shutdown(): void {}
  }
  return {
    MemoryAdmissionController:
      AlwaysAdmits as unknown as typeof import('./memory-admission.js').MemoryAdmissionController,
  };
});

// Real fs, except that the heartbeat clear announces itself: case 1 asserts the
// claim resolved before this file's first write to the session's runtime state.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    const match = /v2-sessions\/[^/]+\/([^/]+)\/\.heartbeat$/.exec(String(target));
    if (match) hooks.events.push(`heartbeat-clear:${match[1]}`);
    return real.rmSync(target, options);
  }) as typeof real.rmSync;
  const asNamespace = real as unknown as { default?: typeof real };
  return { ...real, rmSync, default: { ...(asNamespace.default ?? real), rmSync } };
});

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsNode from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import ts from 'typescript';
import type fs from 'fs';

import {
  adoptRunningSessions,
  hasContainerEverRun,
  isContainerRunning,
  killContainer,
  stopAllContainers,
  wakeContainer,
  _resetAdoptionStateForTesting,
  _resetEverSeenRunningForTest,
} from './container-runner.js';
import { getSessionClaim } from './db/coordination.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeDb, getDb, initDb } from './db/connection.js';
import { runMigrations } from './db/index.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';
import type { Session } from './types.js';

hooks.EventEmitter = EventEmitter;

const STAMP = '2026-09-05T00:00:00.000Z';
const AGENT_GROUP_ID = 'ag-session-claim';
// Deliberately a folder that does not exist under groups/: readContainerConfig
// returns the empty config for it, so the spawn path runs end to end with no
// disk fixture — the same lever src/container-runner.test.ts pulls.
const AGENT_GROUP_FOLDER = '__session-claim-test__';

/**
 * `thread_id` is the session id, never null. `idx_sessions_active_triple` is
 * unique over (agent_group_id, messaging_group_id, thread_id), so two active
 * sessions of one group with null thread ids collide — which is exactly what a
 * case seeding two sessions needs to avoid.
 */
async function seedSession(id: string): Promise<void> {
  // A real inbound/outbound mailbox under the temp DATA_DIR: the spawn path
  // refuses a session it cannot prove a mailbox for, and that refusal sits
  // above the claim.
  fsNode.mkdirSync(path.join(TEST_DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at)
     VALUES (?, ?, NULL, ?, NULL, 'active', 'stopped', NULL, ?)`,
    id,
    AGENT_GROUP_ID,
    id,
    STAMP,
  );
}

function callerSnapshot(id: string): Session {
  return {
    id,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-09-05T00:00:00.000Z',
  };
}

/** A `session_claims` row held by someone else, at the given incarnation. */
async function seedForeignClaim(sessionId: string, holder: string, incarnation: number): Promise<void> {
  await getDb().run(
    `INSERT INTO session_claims (session_id, incarnation, claimed_by, claimed_at, container_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId,
    incarnation,
    holder,
    STAMP,
    `nanoclaw-v2-${holder}`,
    STAMP,
  );
}

/**
 * A `host_instances` row for a peer. `lease`: 'live' is an unexpired lease,
 * 'expired' is a host that crashed without stamping `stopped_at`, and 'stopped'
 * is one that shut down gracefully. Only the first reads as live.
 */
async function seedHostInstance(instanceId: string, lease: 'live' | 'expired' | 'stopped'): Promise<void> {
  await getDb().run(
    `INSERT INTO host_instances (instance_id, install_id, hostname, pid, started_at, lease_expires_at, stopped_at)
     VALUES (?, 'test-install', 'peer', 4242, ?, ?, ?)`,
    instanceId,
    STAMP,
    lease === 'expired' ? STAMP : new Date(Date.now() + 90_000).toISOString(),
    lease === 'stopped' ? new Date().toISOString() : null,
  );
}

/** The refusals `claimSessionRun` logs when a live peer holds the claim. */
function liveHolderRefusals(): Array<{ sessionId: string; holder: string }> {
  return vi
    .mocked(log.warn)
    .mock.calls.filter((call) => call[0] === 'Refusing session claim held by a live peer host')
    .map((call) => {
      const meta = call[1] as { sessionId: string; holder: string };
      return { sessionId: meta.sessionId, holder: meta.holder };
    });
}

/** The `wakeContainer failed` errors, which is how a refused spawn surfaces. */
function wakeFailures(): string[] {
  return vi
    .mocked(log.warn)
    .mock.calls.filter((call) => String(call[0]).startsWith('wakeContainer failed'))
    .map((call) => String((call[1] as { err?: unknown }).err));
}

/** Wait until the spawn path announces the event, or give up loudly. */
/**
 * Budget for every wait below. Deliberately generous and expressed as a
 * DEADLINE rather than a poll count: these are real timers over a real spawn
 * prelude (mailbox provisioning, group init, argument construction), and under
 * a loaded full-suite run that prelude takes seconds, not milliseconds. A
 * fixed count of short sleeps made the waits a function of host load — the
 * shutdown case below failed once at 22.9 s in a full run while passing alone.
 * A genuine hang still fails, just later and with the same message.
 */
const WAIT_BUDGET_MS = 30_000;

async function until(done: () => boolean, describeFailure: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done(), describeFailure).toBe(true);
}

async function untilEvent(event: string): Promise<void> {
  await until(() => hooks.events.includes(event), `the spawn path never reached ${event}`);
}

/** Wait for the ENOENT child's close/error to drive finalizeContainer. */
async function waitForFinalize(sessionId: string): Promise<void> {
  await until(() => !isContainerRunning(sessionId), `the container for ${sessionId} never finalized`);
  // The claim release is a detached tail on the exit handler; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('claim-first spawn', () => {
  beforeEach(async () => {
    hooks.reset();
    _resetAdoptionStateForTesting();
    _resetEverSeenRunningForTest();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    // A real, fully migrated central DB on disk rather than a hand-rolled
    // subset: the spawn path reads a dozen tables before it reaches the claim,
    // and a partial schema turns a missing table into a spawn refusal that
    // looks exactly like the refusals these cases are asserting. Migrated
    // through a throwaway handle so this file never names the raw central
    // handle (src/db/raw-db-ratchet.test.ts).
    fsNode.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fsNode.mkdirSync(path.join(TEST_GROUPS_DIR, AGENT_GROUP_FOLDER), { recursive: true });
    const dbPath = path.join(TEST_DATA_DIR, `central-${crypto.randomUUID()}.db`);
    const seed = new BetterSqlite3(dbPath);
    runMigrations(seed);
    seed.close();
    await initDb(dbPath, { role: 'test' });
    await getDb().run(
      "INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-session-claim', 'session claim', ?)",
      '2026-09-05T00:00:00.000Z',
    );
    await getDb().run(
      'INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
      AGENT_GROUP_ID,
      'session claim',
      AGENT_GROUP_FOLDER,
      'wg-session-claim',
      '2026-09-05T00:00:00.000Z',
    );
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(async () => {
    await stopHostInstanceLease();
    vi.unstubAllEnvs();
    hooks.reset();
    await closeDb();
  });

  it('a spawn claims before it touches session runtime state', async () => {
    await seedSession('sess-order');

    await wakeContainer(callerSnapshot('sess-order'));
    await waitForFinalize('sess-order');

    const claimed = hooks.events.findIndex((event) => event.startsWith('claim:sess-order:'));
    const heartbeat = hooks.events.indexOf('heartbeat-clear:sess-order');
    expect(claimed, 'no claim was taken for the spawn').toBeGreaterThan(-1);
    expect(heartbeat, 'the heartbeat was never cleared').toBeGreaterThan(-1);
    // Winning the claim is what licenses touching this session's runtime state,
    // and the heartbeat file is runtime state.
    expect(claimed).toBeLessThan(heartbeat);
  });

  it('a lost claim starts no container', async () => {
    await seedSession('sess-lost');
    // A holder with no `host_instances` row at all — an unknown claimant, which
    // reads as not-live and is therefore takeover-able. What loses this claim
    // is the CAS alone: someone bumped the incarnation between our read and our
    // compare-and-set.
    await seedForeignClaim('sess-lost', 'peer-host', 5);
    hooks.staleRead = true;

    await expect(wakeContainer(callerSnapshot('sess-lost'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-lost'), 'a container was started against a lost claim').toBe(false);
    expect(wakeFailures()).toEqual([
      'Error: session sess-lost is claimed by another live host process — not spawning a duplicate',
    ]);
    // The peer's row is untouched: a lost CAS writes nothing.
    hooks.staleRead = false;
    const claim = await getSessionClaim('sess-lost');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([5, 'peer-host']);
  });

  it('a claim held by a live host is refused and starts no container', async () => {
    await seedSession('sess-peer-live');
    // A peer host process that registered a lease and is still renewing it.
    await seedHostInstance('peer-instance', 'live');
    await seedForeignClaim('sess-peer-live', 'peer-instance', 3);

    await expect(wakeContainer(callerSnapshot('sess-peer-live'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-peer-live'), 'a second host started a duplicate container').toBe(false);
    expect(liveHolderRefusals()).toEqual([{ sessionId: 'sess-peer-live', holder: 'peer-instance' }]);
    expect(wakeFailures()).toEqual([
      'Error: session sess-peer-live is claimed by another live host process — not spawning a duplicate',
    ]);
    // Refused before the compare-and-set, so the peer's row is byte-for-byte
    // what it was: two live hosts never trade a session back and forth.
    const claim = await getSessionClaim('sess-peer-live');
    expect([claim?.incarnation, claim?.claimed_by, claim?.container_ref]).toEqual([
      3,
      'peer-instance',
      'nanoclaw-v2-peer-instance',
    ]);
  });

  it.each([
    ['crashed without stamping stopped_at', 'expired' as const],
    ['shut down gracefully', 'stopped' as const],
  ])('a claim held by a dead host is taken over — %s', async (_why, lease) => {
    const sessionId = `sess-peer-${lease}`;
    await seedSession(sessionId);
    await seedHostInstance(`peer-${lease}`, lease);
    await seedForeignClaim(sessionId, `peer-${lease}`, 3);

    await wakeContainer(callerSnapshot(sessionId));

    // A dead claimant must never wedge a session: the CAS ran on the
    // incarnation it left behind and the container started.
    expect(hooks.events).toContain(`claim:${sessionId}:4`);
    expect(hasContainerEverRun(sessionId), 'a dead host wedged the session').toBe(true);
    expect(liveHolderRefusals()).toEqual([]);
    await waitForFinalize(sessionId);
  });

  it('a host without a lease refuses to claim and starts no container', async () => {
    await seedSession('sess-no-lease');
    // Boot's lease registration is fail-open (`shadowWrite`), so a host whose
    // INSERT never landed runs on with no durable id. The retry from the spawn
    // path fails the same way here.
    hooks.leaseStartFails = true;

    await expect(wakeContainer(callerSnapshot('sess-no-lease'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-no-lease'), 'a container started under an unanswerable claimant').toBe(false);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter(
          (call) => call[0] === 'Refusing session claim: no durable host instance id — lease not started',
        )
        .map((call) => call[1] as { sessionId: string }),
    ).toEqual([{ sessionId: 'sess-no-lease' }]);
    // Nothing was written: a claim no peer can answer is worse than no claim.
    expect(await getSessionClaim('sess-no-lease')).toBeUndefined();
  });

  it('a late lease start recovers the claim', async () => {
    await seedSession('sess-late-lease');
    // No lease from boot — the id only exists because the spawn path started
    // one on its way to the claim.
    expect(getHostInstanceId()).toBeNull();

    await wakeContainer(callerSnapshot('sess-late-lease'));

    const instanceId = getHostInstanceId();
    expect(instanceId, 'the spawn path did not start a lease').not.toBeNull();
    const claim = await getSessionClaim('sess-late-lease');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([1, instanceId]);
    expect(hasContainerEverRun('sess-late-lease')).toBe(true);
    await waitForFinalize('sess-late-lease');
  });

  it('an expired self lease refuses the claim and starts no container', async () => {
    await seedSession('sess-lapsed');
    // A lease registered with an already-past expiry: `getHostInstanceId()`
    // still answers from process memory, exactly as it does after ~90 s of
    // failed renewals, but every peer reads this host as dead.
    const instanceId = await startHostInstanceLease({ leaseTtlMs: -60_000 });
    hooks.leaseRenewalFails = true;

    await expect(wakeContainer(callerSnapshot('sess-lapsed'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-lapsed'), 'a container started under a dead lease').toBe(false);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter((call) => call[0] === "Refusing session claim: this host's lease is not live")
        .map((call) => call[1] as { sessionId: string; instanceId: string }),
    ).toEqual([{ sessionId: 'sess-lapsed', instanceId }]);
    expect(await getSessionClaim('sess-lapsed')).toBeUndefined();
  });

  it('a lapsed self lease is renewed inline before the claim', async () => {
    await seedSession('sess-relapsed');
    const instanceId = await startHostInstanceLease({ leaseTtlMs: -60_000 });

    await wakeContainer(callerSnapshot('sess-relapsed'));

    // One inline renewal re-armed the row, so the claim went ahead rather than
    // waiting for the 30 s timer to fire.
    expect(hooks.events).toContain(`renew:${instanceId}`);
    const claim = await getSessionClaim('sess-relapsed');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([1, instanceId]);
    expect(hasContainerEverRun('sess-relapsed')).toBe(true);
    await waitForFinalize('sess-relapsed');
  });

  it('concurrent wakes without a lease share one late start', async () => {
    await seedSession('sess-race-a');
    await seedSession('sess-race-b');
    let letTheLeaseStart!: () => void;
    hooks.leaseStartGate = new Promise<void>((resolve) => {
      letTheLeaseStart = resolve;
    });

    const wakes = [wakeContainer(callerSnapshot('sess-race-a')), wakeContainer(callerSnapshot('sess-race-b'))];
    // Both wakes have read the (still null) instance id: the first is parked
    // inside the starter, the second is waiting on that same attempt.
    await until(() => hooks.idReads >= 2, 'the second wake never reached the claimant resolution');
    letTheLeaseStart();
    await Promise.all(wakes);

    // One registration, therefore one renewal timer and one row — not two, of
    // which the module would remember only the last.
    expect(hooks.leaseStartCalls).toBe(1);
    const instanceId = getHostInstanceId();
    expect(instanceId).not.toBeNull();
    const claims = await Promise.all([getSessionClaim('sess-race-a'), getSessionClaim('sess-race-b')]);
    expect(claims.map((claim) => claim?.claimed_by)).toEqual([instanceId, instanceId]);
    await waitForFinalize('sess-race-a');
    await waitForFinalize('sess-race-b');
  });

  it('a claim write failure starts no container', async () => {
    await seedSession('sess-unwritable');
    hooks.claimWriteFails = true;

    await expect(wakeContainer(callerSnapshot('sess-unwritable'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-unwritable'), 'a container was started on an unrecorded claim').toBe(false);
    expect(wakeFailures()).toEqual(['Error: session_claims write failed']);
    expect(await getSessionClaim('sess-unwritable')).toBeUndefined();
  });

  it('a guard refusal releases the claim', async () => {
    await seedSession('sess-guarded');

    // The guard is asked twice — once at the reserved-spawn boundary, once at
    // THE GUARD POINT — and both throw the same message. Refusing only once the
    // claim exists is what makes this the late refusal, the one that has a
    // claim to hand back.
    await expect(
      wakeContainer(callerSnapshot('sess-guarded'), 'interactive', {
        guard: () =>
          hooks.events.some((event) => event.startsWith('claim:sess-guarded:'))
            ? { ok: false, reason: 'thread was closed while this wake queued' }
            : true,
      }),
    ).resolves.toBe(false);

    expect(hasContainerEverRun('sess-guarded')).toBe(false);
    expect(wakeFailures()).toEqual([
      'Error: Container spawn refused by its guard: thread was closed while this wake queued',
    ]);
    const refused = await getSessionClaim('sess-guarded');
    expect([refused?.incarnation, refused?.claimed_by, refused?.container_ref]).toEqual([1, null, null]);

    // And the next wake wins by expecting the bumped incarnation, so the
    // refusal cost the session nothing but one incarnation.
    await wakeContainer(callerSnapshot('sess-guarded'));
    await waitForFinalize('sess-guarded');
    expect(hooks.events).toContain('claim:sess-guarded:2');
    expect(hasContainerEverRun('sess-guarded')).toBe(true);
  });

  it('a late kill cancellation releases the claim', async () => {
    await seedSession('sess-cancelled');
    let release!: () => void;
    // Parked one await short of the claim, i.e. past the early cancellation
    // check: the request below is only visible to the LATE check, which is the
    // one holding a claim.
    hooks.preClaimGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wake = wakeContainer(callerSnapshot('sess-cancelled'));
    await untilEvent('pre-claim:sess-cancelled');
    killContainer('sess-cancelled', 'thread close', () => {});
    release();

    await expect(wake).resolves.toBe(false);
    expect(hasContainerEverRun('sess-cancelled')).toBe(false);
    expect(wakeFailures()).toEqual(['Error: Container spawn cancelled by a kill request: thread close']);
    const cancelled = await getSessionClaim('sess-cancelled');
    expect([cancelled?.incarnation, cancelled?.claimed_by]).toEqual([1, null]);
  });

  it('container exit releases the claim at its own incarnation', async () => {
    await seedSession('sess-exit');

    await wakeContainer(callerSnapshot('sess-exit'));
    expect(hasContainerEverRun('sess-exit')).toBe(true);
    await waitForFinalize('sess-exit');

    expect(hooks.events).toContain('release:sess-exit:1');
    const released = await getSessionClaim('sess-exit');
    expect([released?.incarnation, released?.claimed_by, released?.container_ref]).toEqual([1, null, null]);
  });

  it('a child whose error fires before the lease block returns is finalized, never unhandled (#460 round 2)', async () => {
    await seedSession('sess-early-error');
    hooks.spawnErrorsInMicrotask = true;
    const unhandled: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      await wakeContainer(callerSnapshot('sess-early-error'));
      await waitForFinalize('sess-early-error');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    // The `error` listener existed when the event fired: it was logged, the
    // registry entry was finalized, and the claim came back — no unhandled
    // 'error' escaped the emitter.
    expect(unhandled).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      'Container spawn error',
      expect.objectContaining({ sessionId: 'sess-early-error' }),
    );
    expect(isContainerRunning('sess-early-error')).toBe(false);
    expect(hooks.events).toContain('release:sess-early-error:1');
  });

  it('a stale finish does not release a fresh claim', async () => {
    await seedSession('sess-stale');
    // Hold each runtime's release at its own incarnation, so the two land in an
    // order this test chooses rather than one the scheduler does.
    let letTheStaleReleaseLand!: () => void;
    let letTheFreshReleaseLand!: () => void;
    hooks.releaseGates.set(
      1,
      new Promise<void>((resolve) => {
        letTheStaleReleaseLand = resolve;
      }),
    );
    hooks.releaseGates.set(
      2,
      new Promise<void>((resolve) => {
        letTheFreshReleaseLand = resolve;
      }),
    );

    try {
      // Runtime A: spawned, claimed at incarnation 1, exited. Its release is
      // issued but not yet applied.
      await wakeContainer(callerSnapshot('sess-stale'));
      await waitForFinalize('sess-stale');
      expect(hooks.events).toContain('release:sess-stale:1');

      // Runtime B replaces it and wins incarnation 2 while A's release is still
      // in flight. The in-process fence (`active.process === container`) already
      // keeps A's exit handler off B's registry entry; this is the DURABLE half.
      await wakeContainer(callerSnapshot('sess-stale'));
      expect(hooks.events).toContain('claim:sess-stale:2');

      letTheStaleReleaseLand();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // A's release was scoped to the incarnation A held, so it matched no row.
      const fresh = await getSessionClaim('sess-stale');
      expect(fresh?.incarnation).toBe(2);
      expect(fresh?.claimed_by, "the stale finish unclaimed the fresh runtime's container").not.toBeNull();
    } finally {
      letTheFreshReleaseLand();
    }
  });

  it('the claimant id is the host instance id when the lease is running', async () => {
    await seedSession('sess-lease');
    const instanceId = await startHostInstanceLease({ leaseTtlMs: 90_000 });
    // Hold the exiting container's release so the respawn below runs against a
    // claim this same process still holds — the case the liveness check must
    // not refuse, since `host_instances` says THIS host is live.
    let letTheReleaseLand!: () => void;
    hooks.releaseGates.set(
      1,
      new Promise<void>((resolve) => {
        letTheReleaseLand = resolve;
      }),
    );

    try {
      await wakeContainer(callerSnapshot('sess-lease'));
      const claim = await getSessionClaim('sess-lease');
      expect(claim?.claimed_by).toBe(instanceId);
      await waitForFinalize('sess-lease');

      // A respawn while our own claim still stands: same claimant, so the
      // liveness check does not apply and the CAS wins the next incarnation.
      await wakeContainer(callerSnapshot('sess-lease'));
      expect(liveHolderRefusals()).toEqual([]);
      expect(hooks.events).toContain('claim:sess-lease:2');
      const respawned = await getSessionClaim('sess-lease');
      expect(respawned?.claimed_by).toBe(instanceId);
      await waitForFinalize('sess-lease');
    } finally {
      letTheReleaseLand();
    }
  });

  // ── P2, the container half of the fence (seam 4 series E, plan §4.3.4) ──

  it('a spawn is refused while an untracked container is still running for the session', async () => {
    await seedSession('sess-survivor');
    // The previous host crashed: its claim is takeover-able (no live lease),
    // but the container it started is still running. Divergence 3 — the
    // incarnation alone would let this spawn through.
    await seedForeignClaim('sess-survivor', 'dead-host', 3);
    hooks.runtimeRunning.add('nanoclaw-v2-dead-host');

    await expect(wakeContainer(callerSnapshot('sess-survivor'))).resolves.toBe(false);

    expect(hasContainerEverRun('sess-survivor'), 'a second container was started beside the survivor').toBe(false);
    expect(hooks.events.filter((event) => event.startsWith('claim:sess-survivor:'))).toEqual([]);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter(
          (call) => call[0] === 'Refusing session claim — a container is still running for this session',
        ),
    ).toHaveLength(1);
    // The survivor's row is untouched: a refused claim writes nothing.
    const claim = await getSessionClaim('sess-survivor');
    expect([claim?.incarnation, claim?.claimed_by, claim?.container_ref]).toEqual([
      3,
      'dead-host',
      'nanoclaw-v2-dead-host',
    ]);
  });

  it('a claim with a null container_ref never queries the runtime', async () => {
    await seedSession('sess-steady');

    // First spawn ever: no row at all.
    await wakeContainer(callerSnapshot('sess-steady'));
    await waitForFinalize('sess-steady');
    expect(hooks.runtimeCalls).toBe(0);

    // A respawn after a clean exit: the release nulled `container_ref`, so the
    // steady-state cost of P2 is one row read and no runtime call.
    const released = await getSessionClaim('sess-steady');
    expect(released?.container_ref).toBeNull();
    await wakeContainer(callerSnapshot('sess-steady'));
    await waitForFinalize('sess-steady');
    expect(hooks.runtimeCalls).toBe(0);
    expect(hooks.events).toContain('claim:sess-steady:2');
  });

  it('a runtime listing failure refuses the spawn', async () => {
    await seedSession('sess-unprovable');
    await seedForeignClaim('sess-unprovable', 'dead-host', 3);
    hooks.runtimeListingFails = true;

    await expect(wakeContainer(callerSnapshot('sess-unprovable'))).resolves.toBe(false);

    // Fails CLOSED: "cannot prove absence" never reads as "absent".
    expect(hasContainerEverRun('sess-unprovable')).toBe(false);
    expect(hooks.runtimeCalls).toBe(1);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter(
          (call) => call[0] === 'Refusing session claim — cannot prove the previous container is gone',
        ),
    ).toHaveLength(1);
    const claim = await getSessionClaim('sess-unprovable');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([3, 'dead-host']);
  });

  it('the adopter bypasses P2', async () => {
    await seedSession('sess-adopter');
    // The exact state P2 refuses a SPAWN in: a takeover-able claim whose
    // container is still running. The adopter is holding that container by
    // definition, so it must take the claim without asking the runtime.
    await seedForeignClaim('sess-adopter', 'dead-host', 3);
    hooks.runtimeRunning.add('nanoclaw-v2-dead-host');

    const reconciled = await adoptRunningSessions({
      list: () => [
        {
          name: 'nanoclaw-v2-dead-host',
          workgroupId: 'wg-session-claim',
          sessionId: 'sess-adopter',
          groupId: AGENT_GROUP_ID,
        },
      ],
    });

    expect(reconciled.adopted).toBe(1);
    expect(hooks.runtimeCalls, 'the adopter asked the runtime about its own container').toBe(0);
    expect(hooks.events).toContain('claim:sess-adopter:4');
    const claim = await getSessionClaim('sess-adopter');
    expect([claim?.incarnation, claim?.claimed_by, claim?.container_ref]).toEqual([
      4,
      getHostInstanceId(),
      'nanoclaw-v2-dead-host',
    ]);
    expect(isContainerRunning('sess-adopter')).toBe(true);

    // Let the survivor exit so the entry does not outlive the case.
    hooks.runtimeRunning.clear();
    const waiter = hooks.waiters.at(-1)!;
    waiter.exitCode = 0;
    waiter.emit('close', 0);
    await waitForFinalize('sess-adopter');
  });

  // LAST runtime case in the file, deliberately: `stopAllContainers()` latches
  // `containerShutdownInProgress` for the life of the module, and nothing
  // resets it — every later wake would be refused before it reached a claim.
  it('a shutdown-in-progress refusal releases the claim', async () => {
    await seedSession('sess-shutdown');
    let release!: () => void;
    // Park inside the claim read, i.e. past `spawnReservedContainer`'s own
    // shutdown check and immediately before the compare-and-set.
    hooks.preClaimGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wake = wakeContainer(callerSnapshot('sess-shutdown'));
    await untilEvent('pre-claim:sess-shutdown');
    await stopAllContainers(0);
    release();

    await expect(wake).resolves.toBe(false);
    expect(hasContainerEverRun('sess-shutdown')).toBe(false);
    expect(wakeFailures()).toEqual(['Error: Container spawn cancelled because host shutdown is in progress']);
    const cancelled = await getSessionClaim('sess-shutdown');
    expect([cancelled?.incarnation, cancelled?.claimed_by]).toEqual([1, null]);
  });
});

/**
 * The ordering argument, as a source property.
 *
 * The claim is the last `await` in `spawnContainer`, so the guard evaluation
 * and `spawn()` stay adjacent — a request landing in any earlier window is seen
 * at the guard point, and one landing after registration takes the ordinary
 * running-container path. Seam 3 §4.5 I-1 pins that adjacency; the release on
 * refusal is the one `await` in the span, and it sits in a `catch` clause,
 * which is unreachable from the path that reaches `spawn()`.
 */
describe('nothing is awaited between the guard and spawn', () => {
  it('has no await on the control-flow path from the guard point to spawn()', () => {
    const file = path.resolve(__dirname, 'container-runner.ts');
    const source = ts.createSourceFile(
      file,
      fsNode.readFileSync(file, 'utf8'),
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
    );

    let spawnContainerFn: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'spawnContainer') spawnContainerFn = node;
    });
    expect(spawnContainerFn, 'spawnContainer is no longer a top-level function declaration').toBeDefined();

    const calls: ts.CallExpression[] = [];
    const awaits: ts.AwaitExpression[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isAwaitExpression(node)) awaits.push(node);
      node.forEachChild(walk);
    };
    walk(spawnContainerFn!);

    const text = (node: ts.Node): string => node.getText(source);
    const guardCall = calls.find((call) => text(call.expression) === 'wakeRefusalFrom');
    const spawnCall = calls.find(
      (call) => text(call.expression) === 'spawn' && text(call.arguments[0]!) === 'CONTAINER_RUNTIME_BIN',
    );
    expect(guardCall, 'the guard point is gone from spawnContainer').toBeDefined();
    expect(spawnCall, 'the container is no longer created with spawn(CONTAINER_RUNTIME_BIN, …)').toBeDefined();
    expect(guardCall!.getEnd()).toBeLessThan(spawnCall!.getStart(source));

    const inSpan = awaits.filter(
      (node) => node.getStart(source) > guardCall!.getEnd() && node.getEnd() < spawnCall!.getStart(source),
    );
    const inCatch = (node: ts.Node): boolean => {
      for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
        if (ts.isCatchClause(cursor)) return true;
      }
      return false;
    };

    // Seam 3 PR 6: the guard and `spawn()` sit inside ONE `withCentralSync`
    // block, so the span between them holds NO await at all — the claim
    // release moved to the catch clause AROUND that block, after `spawn()` in
    // source order and reachable only when the spawn is refused.
    expect(inSpan.map(text)).toEqual([]);
    // Not vacuous: the scanner does see the release await in this function,
    // and it lives in a catch clause after the spawn call.
    const releases = awaits.filter((node) => text(node.expression).split('(')[0] === 'releaseClaimQuietly');
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(inCatch(release), 'the claim release is not in a catch clause').toBe(true);
      expect(release.getStart(source)).toBeGreaterThan(spawnCall!.getEnd());
    }
  });
});
