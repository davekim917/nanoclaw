/**
 * Acceptance cases for boot-time container adoption (seam 4 series E,
 * docs/specs/upstream-restart-survival-seam/plan.md §7.E).
 *
 * `adoptRunningSessions()` takes over the containers a previous host process
 * left running: it lists them from the runtime, claims each session under
 * `{ adopting: true }` (the same fence the spawn path uses, with the container
 * half skipped), and registers an `adopted` entry supervised by a `docker wait`
 * observer. These cases pin the properties §7.E names:
 *
 *  1. claim before adopt, and never adopt unfenced — every failed or lost claim
 *     leaves the container running and untracked, recorded for retry;
 *  2. an untracked survivor cannot be spawned into — a wake for a pending
 *     adoption retries the adoption (P4) and only a vanished container falls
 *     through to a spawn;
 *  3. a container with no owner is stopped, never adopted;
 *  4. an adopted session's ceiling anchor is the adoption instant.
 *
 * The runtime is a fake listing plus fake waiter processes; the coordination
 * accessors, the mailbox and the central DB are real (src/test-fixtures/claim-harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => {
  const root = uniqueTmpRoot('container-adoption');
  return { TEST_DATA_DIR: `${root}/data`, TEST_GROUPS_DIR: `${root}/groups` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

/**
 * The fake runtime. `listing` is what `docker ps` would show; `arm` hands out
 * a fake `docker wait` child per adopted container; `running` answers the
 * truth re-read. `stopped` records every `docker stop`.
 */
const fakes = vi.hoisted(() => {
  type Scope = { name: string; workgroupId: string | null; sessionId: string | null; groupId: string | null };
  type Waiter = import('node:events').EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    pid: number;
    stdout: null;
    stderr: null;
    kill: () => boolean;
  };
  return {
    listing: [] as Scope[],
    listingFails: false,
    /** `docker stop` throws and the container keeps running. */
    stopFails: false,
    running: new Set<string>(),
    stopped: [] as string[],
    waiters: [] as Array<{ name: string; waiter: Waiter }>,
    /** Injected into the `waitForContainerExit` mock; set below the imports. */
    makeWaiter: null as null | (() => Waiter),
    list(): Scope[] {
      if (fakes.listingFails) throw new Error('Cannot connect to the Docker daemon');
      return fakes.listing.map((scope) => ({ ...scope }));
    },
    arm(name: string): Waiter {
      const waiter = fakes.makeWaiter!();
      fakes.waiters.push({ name, waiter });
      return waiter;
    },
    waitersFor(name: string): Waiter[] {
      return fakes.waiters.filter((entry) => entry.name === name).map((entry) => entry.waiter);
    },
    /** The container exited: its newest waiter closes with the exit code. */
    exit(name: string, code: number | null = 0): void {
      const waiter = fakes.waitersFor(name).at(-1);
      if (!waiter) throw new Error(`no waiter armed for ${name}`);
      waiter.exitCode = code ?? 1;
      waiter.emit('close', code);
    },
    reset(): void {
      this.listing = [];
      this.listingFails = false;
      this.stopFails = false;
      this.running.clear();
      this.stopped = [];
      this.waiters = [];
    },
  };
});

const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  // The fall-through spawn case creates a real ChildProcess that ENOENTs into
  // the real close/error finalization; nothing leaves the process.
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
  listInstallContainersWithScope: () => fakes.list(),
  stopContainer: (name: string) => {
    if (fakes.stopFails) throw new Error('docker stop failed');
    fakes.stopped.push(name);
    fakes.running.delete(name);
    fakes.listing = fakes.listing.filter((scope) => scope.name !== name);
  },
  runtimeShowsRunning: (name: string) => {
    if (fakes.listingFails) throw new Error('Cannot connect to the Docker daemon');
    return fakes.running.has(name);
  },
  waitForContainerExit: (name: string) => fakes.arm(name),
  killContainerHard: vi.fn(),
}));

const hooks = vi.hoisted(() => ({
  /** `tryClaimSession` rejects — a claim that cannot be recorded. */
  claimWriteFails: false,
}));

vi.mock('./db/coordination.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/coordination.js')>();
  return {
    ...real,
    tryClaimSession: async (args: Parameters<typeof real.tryClaimSession>[0]) => {
      if (hooks.claimWriteFails) throw new Error('session_claims write failed');
      return real.tryClaimSession(args);
    },
  };
});

// The spawn path's live round-trips, answered so the fall-through case can
// reach `spawn()` (the same stubs src/session-claim-spawn.test.ts uses).
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
vi.mock('./onecli-apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-apply.js')>()),
  applyOnecliContainerConfig: async () => ({ applied: true, attempts: 1, durationsMs: [0], diagnosis: null }),
}));
vi.mock('./onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-secrets.js')>()),
  ensureOnecliAgent: async () => undefined,
  applyOnecliSecrets: async () => undefined,
}));
vi.mock('./storage-maintenance-worker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage-maintenance-worker.js')>()),
  assertStorageAdmissionInBackground: async () =>
    ({ allowed: true }) as Awaited<
      ReturnType<typeof import('./storage-maintenance-worker.js').assertStorageAdmissionInBackground>
    >,
}));
/**
 * A memory-admission controller that keeps real reservations (the real one
 * sizes its budget from a `docker info` probe at first use, which a unit test
 * must not make). `budgetMb` is what a case lowers to make a survivor not fit;
 * the request/queue/reject verdicts mirror the real controller's.
 */
const memoryStub = vi.hoisted(() => ({
  budgetMb: 1_000_000,
  reservations: new Map<string, number>(),
  reservedMb(): number {
    let total = 0;
    for (const amount of this.reservations.values()) total += amount;
    return total;
  },
  reset(): void {
    this.budgetMb = 1_000_000;
    this.reservations.clear();
  },
}));
vi.mock('./memory-admission.js', () => {
  class TrackingAdmission<T> {
    readonly budgetMb: number;
    constructor(budgetMb: number) {
      this.budgetMb = budgetMb;
    }
    get reservedMb(): number {
      return memoryStub.reservedMb();
    }
    get queuedCount(): number {
      return 0;
    }
    isQueued(): boolean {
      return false;
    }
    hasReservation(id: string): boolean {
      return memoryStub.reservations.has(id);
    }
    request(id: string, requestMb: number, _payload: T): MemoryAdmissionResult {
      const budgetMb = memoryStub.budgetMb;
      if (requestMb > budgetMb) return { status: 'rejected', reason: 'request_exceeds_budget', budgetMb, requestMb };
      if (memoryStub.reservations.has(id)) return { status: 'admitted', budgetMb, requestMb };
      if (memoryStub.reservedMb() + requestMb > budgetMb) return { status: 'queued', budgetMb, requestMb, position: 1 };
      memoryStub.reservations.set(id, requestMb);
      return { status: 'admitted', budgetMb, requestMb };
    }
    release(id: string): T[] {
      memoryStub.reservations.delete(id);
      return [];
    }
    cancel(id: string): T[] {
      memoryStub.reservations.delete(id);
      return [];
    }
    shutdown(): void {
      memoryStub.reservations.clear();
    }
  }
  return {
    MemoryAdmissionController:
      TrackingAdmission as unknown as typeof import('./memory-admission.js').MemoryAdmissionController,
  };
});

import { EventEmitter } from 'node:events';

import {
  adoptRunningSessions,
  containerOwnsOutbound,
  getAdoptedSessionIds,
  getContainerSpawnedAt,
  hasContainerEverRun,
  hasPendingAdoption,
  isAdoptedContainer,
  isContainerRunning,
  wakeContainer,
  _resetAdoptionStateForTesting,
  _resetEverSeenRunningForTest,
} from './container-runner.js';
import { resolveContainerResources } from './container-resources.js';
import { closeDb } from './db/connection.js';
import { getSessionClaim } from './db/coordination.js';
import { getHostInstanceId, stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import { withExistingMailboxSession } from './session-manager.js';
import {
  CLAIM_HARNESS_AGENT_GROUP_ID,
  callerSnapshot,
  containerStatusOf,
  openClaimHarnessDb,
  seedForeignClaim,
  seedHostInstance,
  seedSession,
  until,
} from './test-fixtures/claim-harness.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';

fakes.makeWaiter = () => {
  const waiter = new EventEmitter() as ReturnType<NonNullable<typeof fakes.makeWaiter>>;
  waiter.exitCode = null;
  waiter.killed = false;
  waiter.pid = 4242;
  waiter.stdout = null;
  waiter.stderr = null;
  waiter.kill = () => {
    waiter.killed = true;
    setImmediate(() => waiter.emit('close', null));
    return true;
  };
  return waiter;
};

const WORKGROUP_ID = 'wg-session-claim';

function survivor(sessionId: string): (typeof fakes.listing)[number] {
  return {
    name: `nanoclaw-v2-${sessionId}`,
    workgroupId: WORKGROUP_ID,
    sessionId,
    groupId: CLAIM_HARNESS_AGENT_GROUP_ID,
  };
}

function warnings(message: string): unknown[][] {
  return vi.mocked(log.warn).mock.calls.filter((call) => call[0] === message);
}

function infos(message: string): unknown[][] {
  return vi.mocked(log.info).mock.calls.filter((call) => call[0] === message);
}

/** The `wakeContainer failed` errors, which is how a refused wake surfaces. */
function wakeFailures(): string[] {
  return warnings('wakeContainer failed — host-sweep will retry').map((call) =>
    String((call[1] as { err?: unknown }).err),
  );
}

/**
 * Let every adopted container exit so no waiter or registry entry outlives its
 * case. Loops because a case may leave a re-arm pending: the waiter armed
 * after the backoff is the one whose close finalizes the entry.
 */
async function drainAdopted(): Promise<void> {
  fakes.running.clear();
  fakes.listingFails = false;
  for (let attempt = 0; attempt < 50 && getAdoptedSessionIds().length > 0; attempt += 1) {
    for (const sessionId of getAdoptedSessionIds()) {
      const waiter = fakes.waitersFor(`nanoclaw-v2-${sessionId}`).at(-1);
      if (waiter && waiter.exitCode === null) fakes.exit(`nanoclaw-v2-${sessionId}`, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(getAdoptedSessionIds(), 'an adopted entry outlived its case').toEqual([]);
}

describe('adoptRunningSessions', () => {
  beforeEach(async () => {
    fakes.reset();
    memoryStub.reset();
    hooks.claimWriteFails = false;
    _resetAdoptionStateForTesting();
    _resetEverSeenRunningForTest();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.error).mockClear();
    await openClaimHarnessDb(TEST_DATA_DIR, TEST_GROUPS_DIR);
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(async () => {
    await drainAdopted();
    await stopHostInstanceLease();
    vi.unstubAllEnvs();
    await closeDb();
  });

  it('a running container for an active session is adopted and registered', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-adopt');
    fakes.listing = [survivor('sess-adopt')];

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 1, stopped: 0, pendingClaim: 0, fencedInbound: 0 });
    expect(isContainerRunning('sess-adopt')).toBe(true);
    expect(isAdoptedContainer('sess-adopt')).toBe(true);
    expect(hasContainerEverRun('sess-adopt')).toBe(true);
    // `markContainerRunning` landed, and the claim is held by THIS host with
    // the survivor's name as its container_ref.
    expect(await containerStatusOf('sess-adopt')).toBe('running');
    const claim = await getSessionClaim('sess-adopt');
    expect(claim?.claimed_by).toBe(getHostInstanceId());
    expect(claim?.container_ref).toBe('nanoclaw-v2-sess-adopt');
    // One waiter armed, nothing stopped, one INFO with all four counts.
    expect(fakes.waitersFor('nanoclaw-v2-sess-adopt')).toHaveLength(1);
    expect(fakes.stopped).toEqual([]);
    expect(infos('Reconciled sessions at startup')).toEqual([
      ['Reconciled sessions at startup', { adopted: 1, stopped: 0, pendingClaim: 0, fencedInbound: 0 }],
    ]);
  });

  it('a container whose session is archived is stopped, not adopted', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-archived', { archivedAt: '2026-09-04T00:00:00.000Z' });
    fakes.listing = [survivor('sess-archived')];

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 0, stopped: 1, pendingClaim: 0, fencedInbound: 0 });
    expect(fakes.stopped).toEqual(['nanoclaw-v2-sess-archived']);
    expect(isContainerRunning('sess-archived')).toBe(false);
    expect(fakes.waiters).toEqual([]);
    expect(await getSessionClaim('sess-archived')).toBeUndefined();
  });

  it('a listed container outside the survivable partition is stopped, not adopted', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-survivable');
    await seedSession(TEST_DATA_DIR, 'sess-must-stop');
    fakes.listing = [survivor('sess-survivable'), survivor('sess-must-stop')];

    // D1's partition is the candidate set; a container the door meant to stop
    // but the listing still shows is stopped here, fail-closed.
    const reconciled = await adoptRunningSessions({
      list: fakes.list,
      survivableSessionIds: ['sess-survivable'],
    });

    expect(reconciled).toEqual({ adopted: 1, stopped: 1, pendingClaim: 0, fencedInbound: 0 });
    expect(fakes.stopped).toEqual(['nanoclaw-v2-sess-must-stop']);
    expect(isAdoptedContainer('sess-survivable')).toBe(true);
    expect(isContainerRunning('sess-must-stop')).toBe(false);
    expect(await getSessionClaim('sess-must-stop')).toBeUndefined();
  });

  it('a container with no session label is stopped', async () => {
    fakes.listing = [{ name: 'nanoclaw-v2-unlabeled', workgroupId: WORKGROUP_ID, sessionId: null, groupId: null }];

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 0, stopped: 1, pendingClaim: 0, fencedInbound: 0 });
    expect(fakes.stopped).toEqual(['nanoclaw-v2-unlabeled']);
    expect(fakes.waiters).toEqual([]);
  });

  it('a lost claim leaves the container running and unadopted', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-held');
    await seedHostInstance('peer-live', 'live');
    await seedForeignClaim('sess-held', 'peer-live', 5);
    fakes.listing = [survivor('sess-held')];

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 0, stopped: 0, pendingClaim: 1, fencedInbound: 0 });
    expect(fakes.stopped).toEqual([]);
    expect(isContainerRunning('sess-held')).toBe(false);
    expect(fakes.waiters).toEqual([]);
    expect(warnings('Session adoption skipped — another live host process holds the claim')).toHaveLength(1);
    // The peer's row is untouched.
    const claim = await getSessionClaim('sess-held');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([5, 'peer-live']);
  });

  it('a failed claim write records a pending adoption and stops nothing', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-pending');
    fakes.listing = [survivor('sess-pending')];
    hooks.claimWriteFails = true;

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 0, stopped: 0, pendingClaim: 1, fencedInbound: 0 });
    expect(hasPendingAdoption('sess-pending')).toBe(true);
    expect(fakes.stopped).toEqual([]);
    expect(isContainerRunning('sess-pending')).toBe(false);
    expect(fakes.waiters).toEqual([]);
    expect(
      vi
        .mocked(log.error)
        .mock.calls.filter(
          (call) =>
            call[0] === 'Session claim write failed during adoption — leaving the container unadopted for retry',
        ),
    ).toHaveLength(1);
  });

  it('a wake for a pending adoption retries the adoption instead of spawning', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-retry');
    fakes.listing = [survivor('sess-retry')];
    hooks.claimWriteFails = true;
    await adoptRunningSessions({ list: fakes.list });
    expect(hasPendingAdoption('sess-retry')).toBe(true);

    hooks.claimWriteFails = false;
    await expect(wakeContainer(callerSnapshot('sess-retry'))).resolves.toBe(true);

    expect(infos('Spawning container')).toEqual([]);
    expect(isContainerRunning('sess-retry')).toBe(true);
    expect(isAdoptedContainer('sess-retry')).toBe(true);
    expect(hasPendingAdoption('sess-retry')).toBe(false);
    expect(fakes.waitersFor('nanoclaw-v2-sess-retry')).toHaveLength(1);
    expect(await containerStatusOf('sess-retry')).toBe('running');
    expect((await getSessionClaim('sess-retry'))?.claimed_by).toBe(getHostInstanceId());
  });

  it('a pending adoption whose container has vanished falls through to a fresh spawn', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-vanished');
    fakes.listing = [survivor('sess-vanished')];
    hooks.claimWriteFails = true;
    await adoptRunningSessions({ list: fakes.list });
    expect(hasPendingAdoption('sess-vanished')).toBe(true);

    // The re-list shows nothing: the survivor exited on its own meanwhile.
    fakes.listing = [];
    hooks.claimWriteFails = false;
    await expect(wakeContainer(callerSnapshot('sess-vanished'))).resolves.toBe(true);

    expect(hasPendingAdoption('sess-vanished')).toBe(false);
    expect(infos('Spawning container')).toHaveLength(1);
    expect(fakes.waiters).toEqual([]);
    // The absent runtime binary ENOENTs the spawned child into finalization.
    await until(() => !isContainerRunning('sess-vanished'), 'the spawned container never finalized');
  });

  it('a pending adoption whose claim is lost to a live host throws rather than spawning', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-peer');
    await seedHostInstance('peer-live', 'live');
    await seedForeignClaim('sess-peer', 'peer-live', 5);
    fakes.listing = [survivor('sess-peer')];
    await adoptRunningSessions({ list: fakes.list });
    expect(hasPendingAdoption('sess-peer')).toBe(true);

    await expect(wakeContainer(callerSnapshot('sess-peer'))).resolves.toBe(false);

    expect(wakeFailures()).toEqual([
      'Error: session sess-peer has a running container this host could not claim — not spawning',
    ]);
    expect(infos('Spawning container')).toEqual([]);
    expect(hasContainerEverRun('sess-peer')).toBe(false);
    // Still pending: the next wake asks again, and never spawns while refused.
    expect(hasPendingAdoption('sess-peer')).toBe(true);
    const claim = await getSessionClaim('sess-peer');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([5, 'peer-live']);
  });

  it('adoption counts a session whose inbound DB is fenced', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-fenced');
    await withExistingMailboxSession(CLAIM_HARNESS_AGENT_GROUP_ID, 'sess-fenced', (mailbox) =>
      mailbox.activateRepoIngressFence('epoch-dead-host'),
    );
    fakes.listing = [survivor('sess-fenced')];

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 1, stopped: 0, pendingClaim: 0, fencedInbound: 1 });
    // Counted, not released: `releaseOrphanedRepoIngressFencesAtStartup` owns that.
    const fence = await withExistingMailboxSession(CLAIM_HARNESS_AGENT_GROUP_ID, 'sess-fenced', (mailbox) =>
      mailbox.readRepoIngressFence(),
    );
    expect(fence?.state).toBe('active');
  });

  it('a runtime listing failure adopts nothing and does not throw', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-unlisted');
    fakes.listing = [survivor('sess-unlisted')];
    fakes.listingFails = true;

    // With the door's partition, the survivors it named are held pending —
    // owned and leased — rather than left for the sweep to treat as unowned.
    const reconciled = await adoptRunningSessions({ list: fakes.list, survivableSessionIds: ['sess-unlisted'] });

    expect(reconciled).toEqual({ adopted: 0, stopped: 0, pendingClaim: 1, fencedInbound: 0 });
    expect(warnings('Session adoption listing failed — holding every survivable session as pending')).toHaveLength(1);
    expect(isContainerRunning('sess-unlisted')).toBe(false);
    expect(hasPendingAdoption('sess-unlisted')).toBe(true);
    expect(containerOwnsOutbound('sess-unlisted')).toBe(true);
    expect(fakes.stopped).toEqual([]);
    expect(await getSessionClaim('sess-unlisted')).toBeUndefined();

    // Without a partition there is nothing to hold: zeros, one WARN.
    fakes.reset();
    fakes.listingFails = true;
    expect(await adoptRunningSessions({ list: fakes.list })).toEqual({
      adopted: 0,
      stopped: 0,
      pendingClaim: 0,
      fencedInbound: 0,
    });
    expect(warnings('Session adoption skipped — runtime listing failed')).toHaveLength(1);
  });

  it('a failed stop keeps the claim and the pending entry', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-unstoppable');
    fakes.listing = [survivor('sess-unstoppable')];
    fakes.running.add('nanoclaw-v2-sess-unstoppable');
    fakes.stopFails = true;
    // Memory refuses the survivor, so adoption tries to stop it — and cannot.
    memoryStub.budgetMb = 1;

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    // Still running, still claimed by THIS host, still owned: a later wake
    // retries the adoption rather than spawning a second writer beside it.
    expect(reconciled).toEqual({ adopted: 0, stopped: 0, pendingClaim: 1, fencedInbound: 0 });
    expect(hasPendingAdoption('sess-unstoppable')).toBe(true);
    expect(containerOwnsOutbound('sess-unstoppable')).toBe(true);
    const claim = await getSessionClaim('sess-unstoppable');
    expect([claim?.claimed_by, claim?.container_ref]).toEqual([getHostInstanceId(), 'nanoclaw-v2-sess-unstoppable']);
    expect(
      warnings(
        'Adoption refused for memory but the container is not proven gone — keeping its claim and retrying on wake',
      ),
    ).toHaveLength(1);
    expect(memoryStub.reservedMb()).toBe(0);
  });

  it('an adopted container holds a memory reservation until it finishes', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-reserved');
    fakes.listing = [survivor('sess-reserved')];
    // Sized exactly as a spawn of this group would be: the group has no
    // container.json, so the install defaults apply on both paths.
    const requestMb = resolveContainerResources(undefined).memory.requestMb;

    await adoptRunningSessions({ list: fakes.list });

    expect(memoryStub.reservedMb()).toBe(requestMb);
    expect(memoryStub.reservations.get('sess-reserved')).toBe(requestMb);

    fakes.exit('nanoclaw-v2-sess-reserved', 0);
    await until(() => !isContainerRunning('sess-reserved'), 'the adopted entry never finalized');
    expect(memoryStub.reservedMb()).toBe(0);
  });

  it('adoption never exceeds the budget it would refuse a spawn for', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-fits');
    await seedSession(TEST_DATA_DIR, 'sess-too-big');
    fakes.listing = [survivor('sess-fits'), survivor('sess-too-big')];
    const requestMb = resolveContainerResources(undefined).memory.requestMb;
    // Room for exactly one survivor: the second would be queued as a spawn.
    memoryStub.budgetMb = requestMb;

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    expect(reconciled).toEqual({ adopted: 1, stopped: 1, pendingClaim: 0, fencedInbound: 0 });
    expect(fakes.stopped).toEqual(['nanoclaw-v2-sess-too-big']);
    expect(isContainerRunning('sess-too-big')).toBe(false);
    // Stopped under this host's own claim, which went back with it; nothing
    // reserved for it, and the budget is exactly spent.
    const stoppedClaim = await getSessionClaim('sess-too-big');
    expect([stoppedClaim?.claimed_by, stoppedClaim?.container_ref]).toEqual([null, null]);
    expect(memoryStub.reservedMb()).toBe(requestMb);
    expect(
      warnings('Adoption refused — the container does not fit the memory admission budget; stopping it'),
    ).toHaveLength(1);
  });

  it('a survivor held by a live peer is never stopped for memory', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-peer-memory');
    await seedHostInstance('peer-live', 'live');
    await seedForeignClaim('sess-peer-memory', 'peer-live', 5);
    fakes.listing = [survivor('sess-peer-memory')];
    // No room at all — a spawn would be refused outright.
    memoryStub.budgetMb = 1;

    const reconciled = await adoptRunningSessions({ list: fakes.list });

    // The claim decides first: an unclaimed survivor is the peer's turn, and
    // local admission pressure is never a reason to stop it.
    expect(reconciled).toEqual({ adopted: 0, stopped: 0, pendingClaim: 1, fencedInbound: 0 });
    expect(fakes.stopped).toEqual([]);
    expect(hasPendingAdoption('sess-peer-memory')).toBe(true);
    expect(warnings('Adoption refused — the container does not fit the memory admission budget; stopping it')).toEqual(
      [],
    );
    expect(memoryStub.reservedMb()).toBe(0);
  });

  it("a pending adoption keeps the session's outbound owned", async () => {
    await seedSession(TEST_DATA_DIR, 'sess-owned');
    fakes.listing = [survivor('sess-owned')];
    hooks.claimWriteFails = true;

    await adoptRunningSessions({ list: fakes.list });

    // Alive, untracked, still writing: the host must not touch its outbound.db.
    expect(hasPendingAdoption('sess-owned')).toBe(true);
    expect(isContainerRunning('sess-owned')).toBe(false);
    expect(containerOwnsOutbound('sess-owned')).toBe(true);
  });

  it('a vanished pending container releases ownership', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-released');
    fakes.listing = [survivor('sess-released')];
    hooks.claimWriteFails = true;
    await adoptRunningSessions({ list: fakes.list });
    expect(containerOwnsOutbound('sess-released')).toBe(true);

    // The re-list proves it gone: the pending entry clears and the ordinary
    // path spawns (an ENOENT child here, which finalizes itself).
    fakes.listing = [];
    hooks.claimWriteFails = false;
    await expect(wakeContainer(callerSnapshot('sess-released'))).resolves.toBe(true);
    expect(hasPendingAdoption('sess-released')).toBe(false);
    await until(() => !isContainerRunning('sess-released'), 'the spawned container never finalized');
    expect(containerOwnsOutbound('sess-released')).toBe(false);
  });

  it("an adopted session's ceiling uses the adoption instant", async () => {
    await seedSession(TEST_DATA_DIR, 'sess-ceiling');
    fakes.listing = [survivor('sess-ceiling')];
    const before = Date.now();

    await adoptRunningSessions({ list: fakes.list });

    const spawnedAt = getContainerSpawnedAt('sess-ceiling');
    expect(spawnedAt).toBeGreaterThanOrEqual(before);
    expect(spawnedAt).toBeLessThanOrEqual(Date.now());
  });
});
