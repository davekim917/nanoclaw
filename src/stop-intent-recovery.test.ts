/**
 * Acceptance cases for the durable stop intent (seam 4 series F2,
 * docs/specs/upstream-restart-survival-seam/plan.md §7.F).
 *
 * A kill-with-respawn used to live only in a volatile `onExit` callback. A host
 * that died between the kill and the callback forgot the restart entirely — the
 * operator saw "rebuild applied" and nothing came back. `killContainer` now
 * writes the intent to `session_claims` BEFORE issuing the stop, and
 * `honorPendingStopIntents()` consumes it at the next startup.
 *
 * This is also what makes the one genuinely first-poll row shape safe:
 * `restartAgentGroupContainers` writes the `on_wake` wake row and THEN kills, so
 * a host that dies in that window leaves a row nothing will ever consume — the
 * container it was written for is still running and long past its first poll.
 * The re-issued kill is what puts a fresh container in front of that row.
 *
 * The coordination accessors are the REAL ones over a real migrated central DB:
 * the upsert and the clear are the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => {
  const root = uniqueTmpRoot('stop-intent-recovery');
  return { TEST_DATA_DIR: `${root}/data`, TEST_GROUPS_DIR: `${root}/groups` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers at module scope, so importOriginal() would install those in this
// file's worker (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// A container runtime binary that does not exist: nothing here may reach a
// daemon, and the memory-admission budget probe (`docker info`) stays off the
// wire. No case below lets a spawn get as far as `docker run` anyway.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
}));

// The image deps-drift check is a `docker inspect` round-trip, which a unit
// test must not make and which the absent runtime binary above turns into a
// hard spawn refusal. Answer it as "in sync": the completed-restart case needs
// a respawn that actually reaches `docker run`.
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
// round-trips on every spawn. Answered as "applied, nothing to assign"; the
// gateway contract has its own suites, and a spawn that cannot reach it is
// refused before it ever registers.
vi.mock('./onecli-apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-apply.js')>()),
  applyOnecliContainerConfig: async () => ({ applied: true, attempts: 1, durationsMs: [0], diagnosis: null }),
}));
vi.mock('./onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-secrets.js')>()),
  ensureOnecliAgent: async () => undefined,
  applyOnecliSecrets: async () => undefined,
}));

/** Gates inside the spawn path, so a kill can arrive at a chosen instant. */
const hooks = vi.hoisted(() => ({
  /** Parks the wake at its FIRST await, before any cancellation point. */
  storageGate: null as Promise<void> | null,
  /**
   * Parks the wake at `markContainerRunning`, which is AFTER the container is
   * registered and after the last cancellation check — the only window in
   * which a kill request and a wake that still resolves `true` overlap.
   */
  runningGate: null as Promise<void> | null,
  /** How many times the spawn path has reached that gate. */
  runningGateHits: 0,
  reset(): void {
    this.storageGate = null;
    this.runningGate = null;
    this.runningGateHits = 0;
  },
}));

vi.mock('./session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...actual,
    markContainerRunning: async (sessionId: string) => {
      hooks.runningGateHits += 1;
      if (hooks.runningGate) await hooks.runningGate;
      return actual.markContainerRunning(sessionId);
    },
  };
});

vi.mock('./storage-maintenance-worker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage-maintenance-worker.js')>()),
  assertStorageAdmissionInBackground: async () => {
    if (hooks.storageGate) await hooks.storageGate;
    return { allowed: true } as Awaited<
      ReturnType<typeof import('./storage-maintenance-worker.js').assertStorageAdmissionInBackground>
    >;
  },
}));

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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import ts from 'typescript';

import {
  honorPendingStopIntents,
  isContainerRunning,
  killContainer,
  wakeContainer,
  _markPendingAdoptionForTesting,
  _resetAdoptionRetryStateForTesting,
  _respawnIntentTokenForTesting,
  _resetStopIntentStateForTesting,
} from './container-runner.js';
import { getSessionClaim, setStopIntent } from './db/coordination.js';
import { closeDb, getDb, initDb } from './db/connection.js';
import { runMigrations } from './db/index.js';
import { stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import { getAgentMailbox } from './mailbox/index.js';
import { insertMessage } from './modules/mailbox/ops/ingress.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { MemoryAdmissionResult } from './memory-admission.js';
import type { Session } from './types.js';

const STAMP = '2026-09-05T00:00:00.000Z';
const AGENT_GROUP_ID = 'ag-stop-intent';
// A folder that does not exist under groups/: `readContainerConfig` returns the
// empty config for it, so the spawn path runs with no disk fixture.
const AGENT_GROUP_FOLDER = '__stop-intent-test__';

function sessionDir(sessionId: string): string {
  return path.join(TEST_DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, sessionId);
}

/**
 * `archived` is the archive-ONLY close: `archiveSessionById` stamps
 * `archived_at` and leaves `status` reading `active`, which is the ordinary
 * outcome of a thread close and the representation a `status` test misses.
 */
async function seedSession(id: string, state: 'active' | 'closed' | 'archived' = 'active'): Promise<void> {
  fs.mkdirSync(sessionDir(id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at, archived_at)
     VALUES (?, ?, NULL, ?, NULL, ?, 'stopped', NULL, ?, ?)`,
    id,
    AGENT_GROUP_ID,
    id,
    state === 'closed' ? 'closed' : 'active',
    STAMP,
    state === 'archived' ? STAMP : null,
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
    created_at: STAMP,
  };
}

/** The `on_wake` row `restartAgentGroupContainers` writes before it kills. */
function seedWakeRow(sessionId: string, id: string): void {
  const inbound = new BetterSqlite3(path.join(sessionDir(sessionId), 'inbound.db'));
  insertMessage(inbound, {
    id,
    kind: 'chat',
    timestamp: STAMP,
    platformId: AGENT_GROUP_ID,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: 'restarting to apply a rebuild', sender: 'system', senderId: 'system' }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
  inbound.close();
}

/**
 * The runner's selection predicate for a container's FIRST poll, transcribed.
 *
 * `container/agent-runner/src/modules/mailbox/selection.ts` opens its handles
 * through `bun:sqlite` and cannot be imported here. The distinguishing clause is
 * the one reproduced: `AND on_wake = 0` is added for every poll AFTER the first,
 * so a first poll is the only one that can see this row.
 */
function firstPollSelects(sessionId: string, messageId: string): boolean {
  const inbound = new BetterSqlite3(path.join(sessionDir(sessionId), 'inbound.db'), { readonly: true });
  try {
    return (
      inbound
        .prepare(
          `SELECT 1 FROM messages_in
            WHERE id = ?
              AND status = 'pending'
              AND trigger = 1
              AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
        )
        .get(messageId) !== undefined
    );
  } finally {
    inbound.close();
  }
}

function loggedAt(level: 'info' | 'warn', message: string): boolean {
  return vi.mocked(log[level]).mock.calls.some((call) => call[0] === message);
}

async function storedIntent(sessionId: string): Promise<string | null | undefined> {
  return (await getSessionClaim(sessionId))?.stop_intent;
}

describe('durable stop intent', () => {
  beforeEach(async () => {
    hooks.reset();
    _resetAdoptionRetryStateForTesting();
    _resetStopIntentStateForTesting();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    // A real, fully migrated central DB rather than a hand-rolled subset: the
    // coordination upsert and the spawn prelude read a dozen tables between
    // them, and a partial schema turns a missing table into a refusal that
    // looks exactly like the behavior under test. Migrated through a throwaway
    // handle so this file never names the raw central handle
    // (src/db/raw-db-ratchet.test.ts).
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, AGENT_GROUP_FOLDER), { recursive: true });
    const dbPath = path.join(TEST_DATA_DIR, `central-${crypto.randomUUID()}.db`);
    const seed = new BetterSqlite3(dbPath);
    runMigrations(seed);
    seed.close();
    await initDb(dbPath, { role: 'test' });
    await getDb().run(
      'INSERT INTO workgroups (id, display_name, created_at) VALUES (?, ?, ?)',
      'wg-stop-intent',
      'stop intent',
      STAMP,
    );
    await getDb().run(
      'INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
      AGENT_GROUP_ID,
      'stop intent',
      AGENT_GROUP_FOLDER,
      'wg-stop-intent',
      STAMP,
    );
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(async () => {
    await stopHostInstanceLease();
    _resetAdoptionRetryStateForTesting();
    vi.unstubAllEnvs();
    hooks.reset();
    await closeDb();
    fs.rmSync(path.join(TEST_DATA_DIR, 'v2-sessions'), { recursive: true, force: true });
  });

  /**
   * Park a wake at its first await and hand back the release.
   *
   * A spawning session is a kill request `killContainer` ACCEPTS without a
   * container runtime, which is the only way a unit test can watch the door
   * every stop goes through.
   */
  async function parkSpawningWake(id: string): Promise<{ release: () => void; wake: Promise<boolean> }> {
    let release!: () => void;
    hooks.storageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake = wakeContainer(callerSnapshot(id));
    await vi.waitFor(() => expect(hooks.storageGate).not.toBeNull());
    await Promise.resolve();
    return { release, wake };
  }

  it('a ceiling kill with a bookkeeping onExit records `stop`, not `respawn_after_stop`', async () => {
    await seedSession('sess-ceiling');
    const parked = await parkSpawningWake('sess-ceiling');

    // The shape `killThenFollowUp` uses in sweep-container-health: an `onExit`
    // that resets the orphaned claims and posts the ceiling accounting, and
    // nothing that brings the session back. Deriving the promise from the
    // callback's PRESENCE would resurrect this session at the next boot.
    const bookkeeping: string[] = [];
    killContainer('sess-ceiling', 'absolute-ceiling', () => {
      bookkeeping.push('reset-claims-and-account');
    });

    // The write is a `shadowWrite` fired without an await — `killContainer` is
    // synchronous and every caller depends on that — so let it settle.
    await vi.waitFor(async () => expect(await storedIntent('sess-ceiling')).toBe('stop'));
    parked.release();
    await parked.wake;

    // The callback still ran; it simply says nothing about the durable intent.
    expect(bookkeeping).toEqual(['reset-claims-and-account']);
    expect(await storedIntent('sess-ceiling')).toBe('stop');
  });

  it('a restart-with-message records `respawn_after_stop`', async () => {
    await seedSession('sess-restart-msg');
    const parked = await parkSpawningWake('sess-restart-msg');

    // The shape `ncl groups restart --message` and `restartAgentGroupContainers`
    // use: the same callback shape as the ceiling kill above, and the opposite
    // durable intent — which is the whole point of it being explicit.
    killContainer('sess-restart-msg', 'restarted via ncl', () => {}, 'respawn_after_stop');

    await vi.waitFor(async () => expect(await storedIntent('sess-restart-msg')).toBe('respawn_after_stop'));
    parked.release();
    await parked.wake;
  });

  it('a completed restart leaves no pending intent for the next boot', async () => {
    await seedSession('sess-completed');
    const parked = await parkSpawningWake('sess-completed');

    // Production shape end to end: kill with a respawn promise, the callback
    // wakes the session, the wake succeeds.
    let respawn: Promise<boolean> | null = null;
    killContainer(
      'sess-completed',
      'restarted via ncl',
      () => {
        respawn = wakeContainer(callerSnapshot('sess-completed'));
      },
      'respawn_after_stop',
    );
    await vi.waitFor(async () => expect(await storedIntent('sess-completed')).toBe('respawn_after_stop'));

    parked.release();
    await parked.wake;
    await vi.waitFor(() => expect(respawn).not.toBeNull());
    // The discharge is gated on a wake that SUCCEEDED, so the case is only
    // meaningful once this is true. A refused respawn has to leave the promise
    // standing instead, which is what the clears-only-on-success case covers.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the waitFor above
    await expect(respawn!).resolves.toBe(true);

    // Nothing is owed any more, so the row must not survive: only
    // `honorPendingStopIntents` used to clear it, which meant a restart that
    // COMPLETED normally was replayed at every later boot, forever.
    await vi.waitFor(async () => expect(await storedIntent('sess-completed')).toBeNull());

    const replayed: string[] = [];
    await honorPendingStopIntents(
      async (session) => {
        replayed.push(session.id);
        return true;
      },
      () => false,
    );
    expect(replayed).toEqual([]);
  });

  it('a host that died between the wake write and the kill re-issues the kill at the next boot', async () => {
    await seedSession('sess-interrupted');
    // The exact window: the wake row is durable, the kill never happened, and
    // the container this row was written for is still up and past its first
    // poll — so nothing will ever consume it.
    seedWakeRow('sess-interrupted', 'restart-wake-1');
    await setStopIntent('sess-interrupted', 'respawn_after_stop', STAMP);

    const woke: string[] = [];
    const parked = await parkSpawningWake('sess-interrupted');
    await honorPendingStopIntents(
      async (session) => {
        woke.push(session.id);
        return true;
      },
      // The survivor is in the registry at the next boot, which is what makes
      // this the re-issue branch rather than a plain respawn.
      () => true,
    );

    expect(loggedAt('info', 'Re-issuing interrupted restart')).toBe(true);
    // The deferred kill settles when the parked wake does, and its `onExit` is
    // what drives the respawn.
    parked.release();
    await parked.wake;
    await vi.waitFor(() => expect(woke).toEqual(['sess-interrupted']));

    // The row survived the recovery untouched, so the fresh container's FIRST
    // poll is what finally consumes it — the note lands where it was meant to.
    expect(firstPollSelects('sess-interrupted', 'restart-wake-1')).toBe(true);
    await vi.waitFor(async () => expect(await storedIntent('sess-interrupted')).toBeNull());
  });

  it('the intent clears only after the respawn wake succeeds', async () => {
    await seedSession('sess-retry');
    await setStopIntent('sess-retry', 'respawn_after_stop', STAMP);

    await honorPendingStopIntents(
      async () => false,
      () => false,
    );

    // A wake that failed leaves the promise outstanding: clearing here would
    // drop the restart for good, with nothing to retry it.
    expect(await storedIntent('sess-retry')).toBe('respawn_after_stop');

    await honorPendingStopIntents(
      async () => true,
      () => false,
    );
    expect(await storedIntent('sess-retry')).toBeNull();
  });

  it('a session awaiting claim-fenced adoption defers its intent', async () => {
    await seedSession('sess-pending-adoption');
    await setStopIntent('sess-pending-adoption', 'respawn_after_stop', STAMP);
    // Its container is alive but not yet re-fenced. Acting on the intent now
    // could kill or respawn the wrong incarnation.
    _markPendingAdoptionForTesting('sess-pending-adoption');

    const woke: string[] = [];
    await honorPendingStopIntents(
      async (session) => {
        woke.push(session.id);
        return true;
      },
      () => true,
    );

    expect(loggedAt('warn', 'Deferring stop intent — session awaits claim-fenced adoption')).toBe(true);
    expect(woke).toEqual([]);
    expect(loggedAt('info', 'Re-issuing interrupted restart')).toBe(false);
    // The row stays for the next recovery pass.
    expect(await storedIntent('sess-pending-adoption')).toBe('respawn_after_stop');
  });

  it('a plain stop row is cleared by the boot pass once the respawn promises are handled (#474)', async () => {
    await seedSession('sess-stopped-1');
    await seedSession('sess-stopped-2');
    await setStopIntent('sess-stopped-1', 'stop', STAMP);
    await setStopIntent('sess-stopped-2', 'stop', STAMP);

    const woke: string[] = [];
    await honorPendingStopIntents(
      async (session) => {
        woke.push(session.id);
        return true;
      },
      () => false,
    );

    // Nothing was owed: the stop each row recorded was honoured by the exit.
    expect(woke).toEqual([]);
    expect(await storedIntent('sess-stopped-1')).toBeNull();
    expect(await storedIntent('sess-stopped-2')).toBeNull();
    expect(
      vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Cleared honoured stop intents at startup'),
    ).toEqual([
      ['Cleared honoured stop intents at startup', { cleared: 2, deferredPendingAdoption: 0, deferredRunning: 0 }],
    ]);
  });

  it('the clear leaves a respawn_after_stop row alone', async () => {
    await seedSession('sess-stopped');
    await seedSession('sess-owed');
    await setStopIntent('sess-stopped', 'stop', STAMP);
    await setStopIntent('sess-owed', 'respawn_after_stop', STAMP);

    // The respawn wake fails, so its promise must stand for the next boot while
    // the plain row beside it is cleared.
    await honorPendingStopIntents(
      async () => false,
      () => false,
    );

    expect(await storedIntent('sess-stopped')).toBeNull();
    expect(await storedIntent('sess-owed')).toBe('respawn_after_stop');
  });

  it('the clear leaves a plain stop row alone while its session awaits adoption', async () => {
    await seedSession('sess-stopped');
    await seedSession('sess-pending-stop');
    await setStopIntent('sess-stopped', 'stop', STAMP);
    await setStopIntent('sess-pending-stop', 'stop', STAMP);
    // Its container is alive and not yet re-fenced: the row is not evidence of
    // anything this pass may act on, and stays for the next one.
    _markPendingAdoptionForTesting('sess-pending-stop');

    await honorPendingStopIntents(
      async () => true,
      () => false,
    );

    expect(await storedIntent('sess-stopped')).toBeNull();
    expect(await storedIntent('sess-pending-stop')).toBe('stop');
    expect(
      vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Cleared honoured stop intents at startup'),
    ).toEqual([
      ['Cleared honoured stop intents at startup', { cleared: 1, deferredPendingAdoption: 1, deferredRunning: 0 }],
    ]);
  });

  it('a plain stop row rewritten after the read is left for the next boot', async () => {
    await seedSession('sess-owed');
    await seedSession('sess-stopped');
    await seedSession('sess-reissued');
    await setStopIntent('sess-owed', 'respawn_after_stop', STAMP);
    await setStopIntent('sess-stopped', 'stop', STAMP);
    await setStopIntent('sess-reissued', 'stop', STAMP);

    const LATER = '2026-09-05T00:00:01.000Z';
    await honorPendingStopIntents(
      async () => {
        // The window: a kill for a session whose plain row the pass already
        // read lands while an earlier respawn is awaited. The row it writes is
        // a newer version than the one read, and is not the pass's to clear.
        await setStopIntent('sess-reissued', 'stop', LATER);
        return true;
      },
      () => false,
    );

    expect(await storedIntent('sess-stopped')).toBeNull();
    expect(await storedIntent('sess-reissued')).toBe('stop');
    expect((await getSessionClaim('sess-reissued'))?.updated_at).toBe(LATER);
    expect(
      vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Cleared honoured stop intents at startup'),
    ).toEqual([
      ['Cleared honoured stop intents at startup', { cleared: 1, deferredPendingAdoption: 0, deferredRunning: 0 }],
    ]);
  });

  it('a boot that defers every plain stop row still logs the count', async () => {
    await seedSession('sess-pending-only');
    await setStopIntent('sess-pending-only', 'stop', STAMP);
    _markPendingAdoptionForTesting('sess-pending-only');

    await honorPendingStopIntents(
      async () => true,
      () => false,
    );

    expect(await storedIntent('sess-pending-only')).toBe('stop');
    // Distinguishable from a boot with no plain rows: the line says why
    // nothing was cleared.
    expect(
      vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Cleared honoured stop intents at startup'),
    ).toEqual([
      ['Cleared honoured stop intents at startup', { cleared: 0, deferredPendingAdoption: 1, deferredRunning: 0 }],
    ]);
  });

  it('the clear leaves a plain stop row alone while its container is running', async () => {
    await seedSession('sess-stopped');
    await seedSession('sess-live');
    await setStopIntent('sess-stopped', 'stop', STAMP);
    await setStopIntent('sess-live', 'stop', STAMP);

    // The host died between recording the stop and issuing it; this boot
    // adopted the container. The row is the only record that a stop was asked
    // for, and the stop it records has not happened.
    await honorPendingStopIntents(
      async () => true,
      (sessionId) => sessionId === 'sess-live',
    );

    expect(await storedIntent('sess-stopped')).toBeNull();
    expect(await storedIntent('sess-live')).toBe('stop');
    expect(
      vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Cleared honoured stop intents at startup'),
    ).toEqual([
      ['Cleared honoured stop intents at startup', { cleared: 1, deferredPendingAdoption: 0, deferredRunning: 1 }],
    ]);
  });

  it('a boot with no plain stop rows logs no clear', async () => {
    await seedSession('sess-owed');
    await setStopIntent('sess-owed', 'respawn_after_stop', STAMP);

    await honorPendingStopIntents(
      async () => false,
      () => false,
    );

    expect(loggedAt('info', 'Cleared honoured stop intents at startup')).toBe(false);
  });

  it('a wake in flight across the kill does not clear the intent', async () => {
    await seedSession('sess-inflight');

    // Park PAST the registration and past the last cancellation check, so the
    // kill below takes the running path and this wake still resolves `true`.
    // That overlap is the whole bug: the original wake's `true` used to
    // discharge a promise made for the container it was about to lose, and the
    // replacement wake merely JOINED it, so the session went down with nothing
    // left for the next boot to recover.
    let releaseRunning!: () => void;
    hooks.runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const inFlight = wakeContainer(callerSnapshot('sess-inflight'));
    // Reaching the gate proves the container was registered and the last
    // cancellation check is behind us. `isContainerRunning` is deliberately NOT
    // the sync point: the fixture's container binary does not exist, so the
    // child can die and finalize while this wake is still parked here — and the
    // wake still resolves `true`, which is exactly the state under test.
    await vi.waitFor(() => expect(hooks.runningGateHits).toBe(1));

    // A restart whose callback never gets to run its wake — a host that died
    // between the kill and the respawn, which is the case the durable intent
    // exists for.
    const fired: string[] = [];
    killContainer(
      'sess-inflight',
      'restarted via ncl',
      () => {
        fired.push('onExit');
      },
      'respawn_after_stop',
    );
    const token = _respawnIntentTokenForTesting('sess-inflight');
    expect(token).toBeDefined();

    releaseRunning();
    await expect(inFlight).resolves.toBe(true);

    // The promise is still outstanding: this wake read no token, so its `true`
    // cannot discharge a promise made after it started.
    expect(_respawnIntentTokenForTesting('sess-inflight')).toBe(token);
    expect(await storedIntent('sess-inflight')).toBe('respawn_after_stop');
    expect(fired).toEqual(['onExit']);

    // The post-stop replacement wake is the one that qualifies: it starts after
    // the kill, so it reads the current token.
    await vi.waitFor(() => expect(isContainerRunning('sess-inflight')).toBe(false));
    hooks.runningGate = null;
    await expect(wakeContainer(callerSnapshot('sess-inflight'))).resolves.toBe(true);
    await vi.waitFor(async () => expect(await storedIntent('sess-inflight')).toBeNull());
    expect(_respawnIntentTokenForTesting('sess-inflight')).toBeUndefined();
  });

  it("an archived session's intent is cleared without a respawn", async () => {
    // Both representations of a session that can no longer take a wake. The
    // second is the one a `status` test misses: `archiveSessionById` stamps
    // only `archived_at`, so the row still reads `active` while
    // `wakeContainer` refuses it — and the intent would sit there being
    // reread and declined at every boot, forever.
    await seedSession('sess-closed', 'closed');
    await seedSession('sess-archived-active', 'archived');
    await setStopIntent('sess-closed', 'respawn_after_stop', STAMP);
    await setStopIntent('sess-archived-active', 'respawn_after_stop', STAMP);

    const woke: string[] = [];
    await honorPendingStopIntents(
      async (session) => {
        woke.push(session.id);
        return true;
      },
      () => false,
    );

    expect(woke).toEqual([]);
    expect(await storedIntent('sess-closed')).toBeNull();
    expect(await storedIntent('sess-archived-active')).toBeNull();
  });
});

/**
 * The startup position, pinned at the source rather than by driving `main()`.
 *
 * `honorPendingStopIntents` is the first thing in startup that deliberately
 * spawns, so it has to sit below every startup-only reset: the storage reset
 * recursively deletes the active-lease directory, and the phantom-status reset
 * rewrites every `running` row to `stopped` on the premise that nothing
 * survived. Either one, above the recovery, corrupts the container it just
 * brought back.
 */
describe('honorPendingStopIntents runs after the startup-only resets', () => {
  /**
   * Every startup gate the recovery has to follow, in the order `main()` runs
   * them. The load-bearing claim is that `honorPendingStopIntents` is LAST;
   * the four ahead of it are listed in their current order so that moving any
   * one of them past the recovery fails here rather than in production.
   */
  const ORDERED = [
    // Series E moved both resets ahead of adoption (#456 round 2): a reset
    // after adoption would strip an adopted entry's storage lease or flip its
    // `running` row back to `stopped` under a live container.
    'resetStorageActivityState',
    'resetPhantomContainerStatus',
    'releaseOrphanedRepoIngressFencesAtStartup',
    'runOnecliBootPreflight',
    'honorPendingStopIntents',
  ] as const;

  /** Call positions inside `main()`, in source order, for the names given. */
  function mainCallOrder(wanted: readonly string[]): string[] {
    const file = path.join(__dirname, 'main.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found: Array<{ name: string; pos: number }> = [];
    const enclosingIsMain = (node: ts.Node): boolean => {
      for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
        if (ts.isFunctionDeclaration(cursor)) return cursor.name?.getText() === 'main';
      }
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wanted.includes(node.expression.text)) {
        if (enclosingIsMain(node)) found.push({ name: node.expression.text, pos: node.getStart(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found.sort((a, b) => a.pos - b.pos).map((entry) => entry.name);
  }

  it('the recovery is the last of the startup gates, after both resets', () => {
    const order = mainCallOrder(ORDERED);
    // Each gate is called exactly once from main(), so the sequence is total.
    expect(order).toEqual([...ORDERED]);
    // Stated separately from the sequence above, because this is the property
    // the fix is about and it must survive any future reshuffle of the rest.
    expect(order.at(-1)).toBe('honorPendingStopIntents');
    expect(order.indexOf('honorPendingStopIntents')).toBeGreaterThan(order.indexOf('resetStorageActivityState'));
    expect(order.indexOf('honorPendingStopIntents')).toBeGreaterThan(order.indexOf('resetPhantomContainerStatus'));
  });
});
