/**
 * The supervision-channel union (seam 4 series E, plan §4.3.3 and §7.E).
 *
 * `activeContainers` entries are supervised one of two ways: a `spawned`
 * entry through its `docker run --rm` client child, whose `close` IS the
 * container's exit; an `adopted` entry through a `docker wait <name>` observer,
 * whose `close` is only a HINT that is checked against the runtime before
 * anything is finalized. These cases pin every site that must branch on the
 * union — and the one a naive union gets silently wrong: SIGKILL on an adopted
 * entry's WAITER would abandon the container rather than stop it.
 *
 * The spawned entry is a real child: `CONTAINER_RUNTIME_BIN` points at a shell
 * script under the fixture root that sleeps on `run` and fails every other
 * verb, so the client stays alive until the fallback kills it. The adopted
 * entry's waiter is a fake. Everything else is the session-claim harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, TEST_DATA_DIR, TEST_GROUPS_DIR, FAKE_RUNTIME_BIN } = vi.hoisted(() => {
  const root = uniqueTmpRoot('container-supervision');
  return {
    TEST_ROOT: root,
    TEST_DATA_DIR: `${root}/data`,
    TEST_GROUPS_DIR: `${root}/groups`,
    FAKE_RUNTIME_BIN: `${root}/fake-container-runtime`,
  };
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
 * The fake runtime. `calls` is the ordered log of every stop/kill the code
 * under test issued, which is what the fallback-order cases read.
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
    running: new Set<string>(),
    listingFails: false,
    stopThrows: false,
    calls: [] as string[],
    waiters: [] as Array<{ name: string; waiter: Waiter }>,
    makeWaiter: null as null | ((name: string) => Waiter),
    list(): Scope[] {
      return fakes.listing.map((scope) => ({ ...scope }));
    },
    arm(name: string): Waiter {
      const waiter = fakes.makeWaiter!(name);
      fakes.waiters.push({ name, waiter });
      return waiter;
    },
    waitersFor(name: string): Waiter[] {
      return fakes.waiters.filter((entry) => entry.name === name).map((entry) => entry.waiter);
    },
    exit(name: string, code: number | null = 0): void {
      const waiter = fakes.waitersFor(name).at(-1);
      if (!waiter) throw new Error(`no waiter armed for ${name}`);
      waiter.exitCode = code ?? 1;
      waiter.emit('close', code);
    },
    reset(): void {
      this.listing = [];
      this.running.clear();
      this.listingFails = false;
      this.stopThrows = false;
      this.calls = [];
      this.waiters = [];
    },
  };
});

vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: FAKE_RUNTIME_BIN,
  listInstallContainersWithScope: () => fakes.list(),
  stopContainer: (name: string) => {
    fakes.calls.push(`stop:${name}`);
    if (fakes.stopThrows) throw new Error('docker stop failed');
  },
  killContainerHard: (name: string) => {
    fakes.calls.push(`docker-kill:${name}`);
  },
  runtimeShowsRunning: (name: string) => {
    if (fakes.listingFails) throw new Error('Cannot connect to the Docker daemon');
    return fakes.running.has(name);
  },
  waitForContainerExit: (name: string) => fakes.arm(name),
}));

/** Parks the NEXT `getSessionClaim` read once — the finish's fence read, in the interleaving case. */
const claimReads = vi.hoisted(() => ({
  parkNext: null as Promise<void> | null,
  count: 0,
  /** The next N `getSessionClaim` reads throw — the central DB is unavailable. */
  failNext: 0,
  /** `tryClaimSession` rejects — a claim that cannot be recorded. */
  claimWriteFails: false,
}));
vi.mock('./db/coordination.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/coordination.js')>();
  return {
    ...real,
    getSessionClaim: async (sessionId: string) => {
      claimReads.count += 1;
      if (claimReads.failNext > 0) {
        claimReads.failNext -= 1;
        throw new Error('central DB unavailable');
      }
      const gate = claimReads.parkNext;
      if (gate) {
        claimReads.parkNext = null;
        await gate;
      }
      return real.getSessionClaim(sessionId);
    },
    tryClaimSession: async (args: Parameters<typeof real.tryClaimSession>[0]) => {
      if (claimReads.claimWriteFails) throw new Error('session_claims write failed');
      return real.tryClaimSession(args);
    },
  };
});

const leases = vi.hoisted(() => ({ acquired: [] as string[], released: [] as string[] }));
vi.mock('./storage-activity.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./storage-activity.js')>();
  return {
    ...real,
    acquireStorageActivityLease: async (root: string) => {
      leases.acquired.push(root);
      return {
        release: async () => {
          leases.released.push(root);
        },
      };
    },
  };
});

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

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import {
  adoptRunningSessions,
  getAdoptedSessionIds,
  hasPendingAdoption,
  beginContainerShutdown,
  finalizeSession,
  planContainerShutdown,
  isAdoptedContainer,
  isContainerRunning,
  killContainer,
  wakeContainer,
  _resetAdoptionStateForTesting,
  _resetEverSeenRunningForTest,
  type SupervisionChannel,
} from './container-runner.js';
import { closeDb } from './db/connection.js';
import { getSessionClaim } from './db/coordination.js';
import { stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import {
  CLAIM_HARNESS_AGENT_GROUP_ID,
  callerSnapshot,
  containerStatusOf,
  openClaimHarnessDb,
  seedSession,
  until,
} from './test-fixtures/claim-harness.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';

fakes.makeWaiter = (name) => {
  const waiter = new EventEmitter() as ReturnType<NonNullable<typeof fakes.makeWaiter>>;
  waiter.exitCode = null;
  waiter.killed = false;
  waiter.pid = 4242;
  waiter.stdout = null;
  waiter.stderr = null;
  waiter.kill = () => {
    fakes.calls.push(`waiter-kill:${name}`);
    waiter.killed = true;
    setImmediate(() => waiter.emit('close', null));
    return true;
  };
  return waiter;
};

function survivor(sessionId: string): (typeof fakes.listing)[number] {
  return {
    name: `nanoclaw-v2-${sessionId}`,
    workgroupId: 'wg-session-claim',
    sessionId,
    groupId: CLAIM_HARNESS_AGENT_GROUP_ID,
  };
}

function warnings(message: string): unknown[][] {
  return vi.mocked(log.warn).mock.calls.filter((call) => call[0] === message);
}

async function adopt(sessionId: string): Promise<void> {
  await seedSession(TEST_DATA_DIR, sessionId);
  fakes.listing = [survivor(sessionId)];
  const reconciled = await adoptRunningSessions({ list: fakes.list });
  expect(reconciled.adopted, `${sessionId} was not adopted`).toBe(1);
  expect(isAdoptedContainer(sessionId)).toBe(true);
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

describe('supervision channel', () => {
  beforeEach(async () => {
    fakes.reset();
    claimReads.parkNext = null;
    claimReads.count = 0;
    claimReads.failNext = 0;
    claimReads.claimWriteFails = false;
    leases.acquired.length = 0;
    leases.released.length = 0;
    // A short re-arm backoff: the daemon-restart cases wait for the second waiter.
    _resetAdoptionStateForTesting({ waiterRearmMs: 5 });
    _resetEverSeenRunningForTest();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.error).mockClear();
    await openClaimHarnessDb(TEST_DATA_DIR, TEST_GROUPS_DIR);
    // The fake client: alive on `run` (so a spawned entry has something to
    // kill), a prompt failure on every other verb.
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.writeFileSync(FAKE_RUNTIME_BIN, '#!/bin/sh\ncase "$1" in run) exec sleep 30 ;; *) exit 1 ;; esac\n', {
      mode: 0o755,
    });
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([FAKE_RUNTIME_BIN, 'sleep']);
  });

  afterEach(async () => {
    await drainAdopted();
    await stopHostInstanceLease();
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("an adopted entry's SIGKILL fallback targets the container, not the waiter", async () => {
    await adopt('sess-adopted-kill');
    fakes.stopThrows = true;
    fakes.running.add('nanoclaw-v2-sess-adopted-kill');

    killContainer('sess-adopted-kill', 'test');

    // `docker stop` failed, so the fallback went to the CONTAINER by name; the
    // waiter was only touched afterwards, and killing it did not finalize —
    // the truth re-read still shows the container running.
    expect(fakes.calls).toEqual([
      'stop:nanoclaw-v2-sess-adopted-kill',
      'docker-kill:nanoclaw-v2-sess-adopted-kill',
      'waiter-kill:nanoclaw-v2-sess-adopted-kill',
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(isContainerRunning('sess-adopted-kill')).toBe(true);
    expect(await containerStatusOf('sess-adopted-kill')).toBe('running');
  });

  it("a spawned entry's fallback is unchanged", async () => {
    await seedSession(TEST_DATA_DIR, 'sess-spawned-kill');
    await expect(wakeContainer(callerSnapshot('sess-spawned-kill'))).resolves.toBe(true);
    expect(isContainerRunning('sess-spawned-kill')).toBe(true);
    expect(isAdoptedContainer('sess-spawned-kill')).toBe(false);
    fakes.stopThrows = true;

    killContainer('sess-spawned-kill', 'test');

    // SIGKILL on the client child, exactly as today: the `sleep 30` client dies
    // at once and its close finalizes the entry; no `docker kill` is issued.
    await until(() => !isContainerRunning('sess-spawned-kill'), 'the SIGKILLed client never finalized');
    expect(fakes.calls).toHaveLength(1);
    expect(fakes.calls[0]).toMatch(/^stop:nanoclaw-v2-/);
    expect(fakes.waiters).toEqual([]);
    const exited = vi.mocked(log.info).mock.calls.find((call) => call[0] === 'Container stopped by host');
    expect(exited?.[1]).toMatchObject({ sessionId: 'sess-spawned-kill', code: null });
  });

  it('a waiter close finalizes the session', async () => {
    await adopt('sess-waiter-close');
    const claimed = await getSessionClaim('sess-waiter-close');
    expect(claimed?.claimed_by).not.toBeNull();

    fakes.exit('nanoclaw-v2-sess-waiter-close', 0);
    await until(() => !isContainerRunning('sess-waiter-close'), 'the adopted entry never finalized');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await containerStatusOf('sess-waiter-close')).toBe('stopped');
    const released = await getSessionClaim('sess-waiter-close');
    expect([released?.incarnation, released?.claimed_by, released?.container_ref]).toEqual([
      claimed?.incarnation,
      null,
      null,
    ]);
    expect(fakes.waitersFor('nanoclaw-v2-sess-waiter-close')).toHaveLength(1);
  });

  it('a waiter close while the container is still running re-arms instead of finalizing', async () => {
    await adopt('sess-daemon-restart');
    fakes.running.add('nanoclaw-v2-sess-daemon-restart');

    // The daemon restarted: every waiter exits at once with no container gone.
    fakes.exit('nanoclaw-v2-sess-daemon-restart', 1);

    expect(warnings('Adopted container waiter exited but the container is still running — re-arming')).toHaveLength(1);
    expect(isContainerRunning('sess-daemon-restart')).toBe(true);
    expect(await containerStatusOf('sess-daemon-restart')).toBe('running');
    await until(
      () => fakes.waitersFor('nanoclaw-v2-sess-daemon-restart').length === 2,
      'a second waiter was never armed',
    );
    expect(isContainerRunning('sess-daemon-restart')).toBe(true);
  });

  it('a truth read that fails treats the container as running', async () => {
    await adopt('sess-unreadable');
    fakes.listingFails = true;

    fakes.exit('nanoclaw-v2-sess-unreadable', 1);

    expect(
      warnings(
        'Adopted container waiter exited but the runtime could not be asked — treating it as running and re-arming',
      ),
    ).toHaveLength(1);
    expect(isContainerRunning('sess-unreadable')).toBe(true);
    expect(await containerStatusOf('sess-unreadable')).toBe('running');
    await until(() => fakes.waitersFor('nanoclaw-v2-sess-unreadable').length === 2, 'a second waiter was never armed');
    // The runtime answers again and the container really is gone: the second
    // waiter's close is the terminal.
    fakes.listingFails = false;
    fakes.exit('nanoclaw-v2-sess-unreadable', 0);
    await until(() => !isContainerRunning('sess-unreadable'), 'the adopted entry never finalized');
  });

  it('finalize is a no-op for a channel that is no longer registered', async () => {
    await adopt('sess-stale-channel');
    // A channel object the registry never held — the shape of a late terminal
    // from a runtime that was already replaced.
    const stale: SupervisionChannel = {
      kind: 'adopted',
      waiter: fakes.makeWaiter!(
        'nanoclaw-v2-sess-stale-channel',
      ) as unknown as import('node:child_process').ChildProcess,
      terminal: new EventEmitter(),
      settled: false,
    };

    finalizeSession('sess-stale-channel', stale, null, 'nanoclaw-v2-stale');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(warnings('Ignoring stale session finish')).toHaveLength(1);
    expect(isContainerRunning('sess-stale-channel')).toBe(true);
    expect(await containerStatusOf('sess-stale-channel')).toBe('running');
    expect((await getSessionClaim('sess-stale-channel'))?.claimed_by).not.toBeNull();
  });

  it('the stale-finish fence and the stopped stamp are one step — a replacement wake waits behind them', async () => {
    await adopt('sess-interleave');
    const first = await getSessionClaim('sess-interleave');
    expect(first?.incarnation).toBe(1);
    // Park the finish INSIDE its fence transaction, between its claim read and
    // its status write — the window where a replacement used to claim N+1.
    let letTheFinishContinue!: () => void;
    claimReads.parkNext = new Promise<void>((resolve) => {
      letTheFinishContinue = resolve;
    });

    fakes.exit('nanoclaw-v2-sess-interleave', 0);
    expect(isContainerRunning('sess-interleave')).toBe(false);
    // The replacement wake: its claim CAS is its own central transaction, so
    // it queues behind the parked finish instead of landing inside its window.
    const replacement = wakeContainer(callerSnapshot('sess-interleave'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isContainerRunning('sess-interleave'), 'the replacement claimed inside the finish window').toBe(false);
    letTheFinishContinue();

    await expect(replacement).resolves.toBe(true);
    // The finish stamped `stopped` at incarnation 1 BEFORE the replacement
    // claimed 2 and marked itself running, so the live container's status is
    // not overwritten by the old finalizer.
    expect(isContainerRunning('sess-interleave')).toBe(true);
    expect(await containerStatusOf('sess-interleave')).toBe('running');
    const claim = await getSessionClaim('sess-interleave');
    expect([claim?.incarnation, claim?.claimed_by]).toEqual([2, first?.claimed_by]);

    // The replacement is a real `sleep` client: kill it so it does not outlive the case.
    fakes.stopThrows = true;
    killContainer('sess-interleave', 'test');
    await until(() => !isContainerRunning('sess-interleave'), 'the replacement never finalized');
  });

  it('a pending survivor holds its storage leases; they release when the re-list shows it gone', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-pending-lease');
    fakes.listing = [survivor('sess-pending-lease')];
    claimReads.claimWriteFails = true;
    const reconciled = await adoptRunningSessions({ list: fakes.list });
    expect(reconciled.pendingClaim).toBe(1);
    expect(hasPendingAdoption('sess-pending-lease')).toBe(true);

    // Leased before the claim, and kept while pending: the storage manager
    // must not clean a root an untracked survivor is using.
    const pendingRoots = [...leases.acquired];
    expect(pendingRoots).toHaveLength(2);
    expect(leases.released).toEqual([]);

    // The re-list proves it gone: the lease goes back and the ordinary path
    // spawns (a real `sleep` client here, killed below).
    fakes.listing = [];
    claimReads.claimWriteFails = false;
    await expect(wakeContainer(callerSnapshot('sess-pending-lease'))).resolves.toBe(true);
    expect(hasPendingAdoption('sess-pending-lease')).toBe(false);
    for (const root of pendingRoots) expect(leases.released).toContain(root);

    fakes.stopThrows = true;
    killContainer('sess-pending-lease', 'test');
    await until(() => !isContainerRunning('sess-pending-lease'), 'the spawned client never finalized');
  });

  it('a listing failure seeds the survivable ids as pending, with their leases', async () => {
    await seedSession(TEST_DATA_DIR, 'sess-unlisted-lease');

    const reconciled = await adoptRunningSessions({
      list: () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      survivableSessionIds: ['sess-unlisted-lease'],
    });

    expect(reconciled.pendingClaim).toBe(1);
    expect(hasPendingAdoption('sess-unlisted-lease')).toBe(true);
    expect(leases.acquired).toHaveLength(2);
    expect(leases.released).toEqual([]);
  });

  it('a fence failure never writes unfenced', async () => {
    await adopt('sess-fence-down');
    // Every fence attempt fails: the central DB cannot answer the claim read.
    claimReads.failNext = 10;

    fakes.exit('nanoclaw-v2-sess-fence-down', 0);
    await until(() => !isContainerRunning('sess-fence-down'), 'the adopted entry never finalized');
    await until(
      () =>
        vi
          .mocked(log.error)
          .mock.calls.some((call) => call[0] === 'Stale-finish fence unavailable; leaving container_status untouched'),
      'the fence never gave up',
    );

    // The row keeps whatever it had — here `running` — rather than an unfenced
    // `stopped` that could overwrite a replacement's live status. The scoped
    // claim release still lands: it is a no-op against any newer incarnation.
    expect(await containerStatusOf('sess-fence-down')).toBe('running');
    expect(warnings('Stale-finish fence failed — retrying')).toHaveLength(3);
    claimReads.failNext = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await getSessionClaim('sess-fence-down'))?.claimed_by).toBeNull();
  });

  it('an adopted entry holds the storage-activity leases until it finishes', async () => {
    await adopt('sess-lease');

    // The same two roots a spawn of this session holds: its session directory
    // and its topic-worktrees directory. Held, not released, while it runs.
    expect(leases.acquired).toHaveLength(2);
    expect(leases.acquired.some((root) => root.endsWith('/sess-lease'))).toBe(true);
    expect(leases.released).toEqual([]);

    fakes.exit('nanoclaw-v2-sess-lease', 0);
    await until(() => !isContainerRunning('sess-lease'), 'the adopted entry never finalized');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect([...leases.released].sort()).toEqual([...leases.acquired].sort());
  });
  // LAST case in the file, deliberately: `beginContainerShutdown()` latches
  // `containerShutdownInProgress` for the life of the module, and nothing
  // resets it — every later wake would be refused before it reached a claim.
  it('beginContainerShutdown leaves a running container alone and closes the spawn path', async () => {
    await adopt('sess-door-1');
    // The warn's input, asked before the door: nothing running is stopped.
    expect([...planContainerShutdown()]).toEqual([]);

    const left = await beginContainerShutdown(0);

    expect(left).toEqual({ running: 1, adopted: 1, spawning: 0, stopping: 0 });
    expect(isContainerRunning('sess-door-1')).toBe(true);
    expect(fakes.calls).toEqual([]);
    expect(await containerStatusOf('sess-door-1')).toBe('running');
    await seedSession(TEST_DATA_DIR, 'sess-after-door');
    await expect(wakeContainer(callerSnapshot('sess-after-door'))).resolves.toBe(false);
  });
});
