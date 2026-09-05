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

/** Parks the wake at its first await, so a kill can arrive mid-spawn. */
const hooks = vi.hoisted(() => ({
  storageGate: null as Promise<void> | null,
  reset(): void {
    this.storageGate = null;
  },
}));

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

import {
  honorPendingStopIntents,
  killContainer,
  wakeContainer,
  _markPendingAdoptionForTesting,
  _resetAdoptionRetryStateForTesting,
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

async function seedSession(id: string, status: 'active' | 'closed' = 'active'): Promise<void> {
  fs.mkdirSync(sessionDir(id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: AGENT_GROUP_ID, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at)
     VALUES (?, ?, NULL, ?, NULL, ?, 'stopped', NULL, ?)`,
    id,
    AGENT_GROUP_ID,
    id,
    status,
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

  it('killContainer records a respawn intent when an onExit is supplied, and a plain stop otherwise', async () => {
    await seedSession('sess-respawn');
    await seedSession('sess-plain');

    const respawning = await parkSpawningWake('sess-respawn');
    killContainer('sess-respawn', 'restart with a message', () => {});
    // The write is a `shadowWrite` fired without an await — `killContainer` is
    // synchronous and every caller depends on that — so let it settle.
    await vi.waitFor(async () => expect(await storedIntent('sess-respawn')).toBe('respawn_after_stop'));
    respawning.release();
    await respawning.wake;

    const plain = await parkSpawningWake('sess-plain');
    killContainer('sess-plain', 'thread close');
    await vi.waitFor(async () => expect(await storedIntent('sess-plain')).toBe('stop'));
    plain.release();
    await plain.wake;

    // `onExit` is the whole signal: a caller that supplied one wants the
    // session back, and only that intent arms a respawn at the next boot.
    expect(await storedIntent('sess-respawn')).toBe('respawn_after_stop');
    expect(await storedIntent('sess-plain')).toBe('stop');
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

  it("an archived session's intent is cleared without a respawn", async () => {
    await seedSession('sess-archived', 'closed');
    await setStopIntent('sess-archived', 'respawn_after_stop', STAMP);

    const woke: string[] = [];
    await honorPendingStopIntents(
      async (session) => {
        woke.push(session.id);
        return true;
      },
      () => false,
    );

    expect(woke).toEqual([]);
    expect(await storedIntent('sess-archived')).toBeNull();
  });
});
