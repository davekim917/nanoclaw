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
  finalizeSession,
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

/** Let every adopted container exit so no waiter or registry entry outlives its case. */
async function drainAdopted(): Promise<void> {
  fakes.running.clear();
  fakes.listingFails = false;
  for (const { name } of [...fakes.waiters]) {
    if (fakes.waitersFor(name).at(-1)?.exitCode === null) fakes.exit(name, 0);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('supervision channel', () => {
  beforeEach(async () => {
    fakes.reset();
    leases.acquired.length = 0;
    leases.released.length = 0;
    // A short re-arm backoff: the daemon-restart cases wait for the second waiter.
    _resetAdoptionStateForTesting({ waiterRearmMs: 5 });
    _resetEverSeenRunningForTest();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
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
    const exited = vi.mocked(log.info).mock.calls.find((call) => call[0] === 'Container exited');
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

  it('an adopted entry releases no storage-activity lease', async () => {
    await adopt('sess-no-lease');

    fakes.exit('nanoclaw-v2-sess-no-lease', 0);
    await until(() => !isContainerRunning('sess-no-lease'), 'the adopted entry never finalized');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // This host holds no lease for a container it did not spawn: nothing was
    // acquired at adoption, so nothing is released at exit.
    expect(leases.acquired).toEqual([]);
    expect(leases.released).toEqual([]);
  });
});
