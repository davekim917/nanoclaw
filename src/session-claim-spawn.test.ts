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
  /** Parks inside `getSessionClaim`, i.e. immediately before the claim. */
  preClaimGate: null as Promise<void> | null,
  /** Parks `releaseSessionClaim` for one incarnation, keyed by that number. */
  releaseGates: new Map<number, Promise<void>>(),
  /** Parks the wake at its first await (background storage admission). */
  storageGate: null as Promise<void> | null,
  reset(): void {
    this.events.length = 0;
    this.staleRead = false;
    this.claimWriteFails = false;
    this.preClaimGate = null;
    this.releaseGates.clear();
    this.storageGate = null;
  },
}));

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
    releaseSessionClaim: async (args: Parameters<typeof real.releaseSessionClaim>[0]) => {
      hooks.events.push(`release:${args.sessionId}:${args.incarnation}`);
      const gate = hooks.releaseGates.get(args.incarnation);
      if (gate) await gate;
      return real.releaseSessionClaim(args);
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
import fsNode from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import ts from 'typescript';
import type fs from 'fs';

import {
  hasContainerEverRun,
  isContainerRunning,
  killContainer,
  stopAllContainers,
  wakeContainer,
  _resetEverSeenRunningForTest,
} from './container-runner.js';
import { getSessionClaim } from './db/coordination.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeDb, getDb, initDb } from './db/connection.js';
import { runMigrations } from './db/index.js';
import { startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';
import type { Session } from './types.js';

const AGENT_GROUP_ID = 'ag-session-claim';
// Deliberately a folder that does not exist under groups/: readContainerConfig
// returns the empty config for it, so the spawn path runs end to end with no
// disk fixture — the same lever src/container-runner.test.ts pulls.
const AGENT_GROUP_FOLDER = '__session-claim-test__';

async function seedSession(id: string): Promise<void> {
  // A real inbound/outbound mailbox under the temp DATA_DIR: the spawn path
  // refuses a session it cannot prove a mailbox for, and that refusal sits
  // above the claim.
  fsNode.mkdirSync(path.join(TEST_DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'active', 'stopped', NULL, '2026-09-05T00:00:00.000Z')`,
    id,
    AGENT_GROUP_ID,
  );
}

function callerSnapshot(id: string): Session {
  return {
    id,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-09-05T00:00:00.000Z',
  };
}

/** The `wakeContainer failed` errors, which is how a refused spawn surfaces. */
function wakeFailures(): string[] {
  return vi
    .mocked(log.warn)
    .mock.calls.filter((call) => String(call[0]).startsWith('wakeContainer failed'))
    .map((call) => String((call[1] as { err?: unknown }).err));
}

/** Wait until the spawn path announces the event, or give up loudly. */
async function untilEvent(event: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !hooks.events.includes(event); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(hooks.events, `the spawn path never reached ${event}`).toContain(event);
}

/** Wait for the ENOENT child's close/error to drive finalizeContainer. */
async function waitForFinalize(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && isContainerRunning(sessionId); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The claim release is a detached tail on the exit handler; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('claim-first spawn', () => {
  beforeEach(async () => {
    hooks.reset();
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
    // Another live claimant already holds this session at incarnation 5.
    await getDb().run(
      `INSERT INTO session_claims (session_id, incarnation, claimed_by, claimed_at, container_ref, updated_at)
       VALUES ('sess-lost', 5, 'peer-host', ?, 'nanoclaw-v2-peer', ?)`,
      '2026-09-05T00:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
    );
    // ...and bumped it again between our read and our compare-and-set.
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

    await wakeContainer(callerSnapshot('sess-lease'));

    const claim = await getSessionClaim('sess-lease');
    expect(claim?.claimed_by).toBe(instanceId);
    await waitForFinalize('sess-lease');
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

    // Not vacuous: the scanner does see awaits in this span. The only one is
    // the claim release, and it is reachable only when the spawn is refused.
    expect(inSpan.map(text).length).toBeGreaterThan(0);
    expect(inSpan.filter((node) => !inCatch(node)).map(text)).toEqual([]);
    expect(inSpan.map((node) => text(node.expression).split('(')[0])).toEqual(['releaseClaimQuietly']);
  });
});
