/**
 * Continuation and ceiling accountability — S2-PR13 acceptance cases
 * (F-13.1..F-13.5, docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * The `decideCeilingFollowUp`, `applyCeilingFollowUp`, `durable continuation
 * wake` and `notifyKillCeiling` cases are ported verbatim from
 * `src/host-sweep.test.ts` (pre-move), assertions unchanged. The five F-13.x
 * cases are new: the pre-move suite exercised the bodies directly and never
 * the registrations, and the plan's family-case rule (§8) requires each moved
 * duty to be driven through the registry.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations, getRawDb } from '../../db/index.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from '../mailbox/index.js';
import { type ContainerState } from '../mailbox/ops/sweep.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  SWEEP_DUTY_INVENTORY,
  _listSweepRegistrationsForTesting,
  _sweepSessionForTesting,
  type SweepSessionContext,
  type WakePlan,
} from '../../host-sweep.js';
import {
  CONTINUATION_WAKE_MIN_INTERVAL_MS,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  _applyCeilingFollowUpForTesting,
  _hasWorkContinuationForTesting,
  _notifyKillCeilingForTesting,
  canAttemptContinuationRecovery,
  countToolRecoveryAttemptsSinceRealInbound,
  decideCeilingFollowUp,
  decideContinuationWake,
  hasDueRecoveryWake,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  notifyContinuationParked,
  parkDueRecoveryWakes,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  _settleDetachedWakesForTesting,
  _detachedWakeCountForTesting,
  _resetDetachedWakesForTesting,
} from './index.js';
// The post-kill follow-up chain is started from `killContainer`'s `onExit` and
// therefore outlives the tick (Codex final); this is how a case waits for it.
import { _settlePostKillForTesting } from '../sweep-container-health/index.js';
// Importing the module registers S6/S7/S8/S9a/S9b/S15/S10 as a duty source —
// needed so the registry lookups below and `_sweepSessionForTesting` (F-13.2,
// F-13.4) see the real duties rather than the driver's remaining set.
import './index.js';
// PR 14 integration: the kill-sequence case drives the SLA duty (S14,
// S2-PR10) and the post-kill orphan-claim reset (S17, S2-PR9).
import '../sweep-container-health/index.js';
import '../sweep-session-core/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// ─── Hermeticity tripwire (brief-common.md HARD RULE) ────────────────────────
// F-13.2 and F-13.4 drive real duty bodies through `_sweepSessionForTesting`.
// A tripwire, not a functional mock: it records the call and throws, so a body
// that reaches an unmocked git/docker/GitHub spawn fails loudly instead of
// silently doing real process work under a test.
const spawns = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`continuation.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

afterEach(() => {
  expect(spawns).toEqual([]);
});

// ─── Module mocks ────────────────────────────────────────────────────────────
// The same seams host-sweep.test.ts already mocks, copied here because this is
// a separate test file (vi.mock is per-file).

const selfHeal = vi.hoisted(() => ({ enabled: false }));
const testDataDir = await vi.hoisted(async () => {
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-continuation-')) };
});
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get SELF_HEAL_ENABLED() {
      return selfHeal.enabled;
    },
    get DATA_DIR() {
      return testDataDir.dir;
    },
  };
});

function armSelfHeal(enabled: boolean): void {
  selfHeal.enabled = enabled;
}

const mockKillContainer = vi.fn();
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockIsContainerSpawning = vi.fn();
const mockHasContainerEverRun = vi.fn();
const mockGetContainerSpawnedAt = vi.fn().mockReturnValue(0);
const mockGetSession = vi.fn();
const mockAdmitDueTaskContexts = vi.fn().mockReturnValue(0);
const mockSyncDoneProposalMirror = vi.fn();

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    isContainerSpawning: (...args: unknown[]) => mockIsContainerSpawning(...args),
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (mailbox PR 4 round 8 — thread-close's finalizer is its second caller).
    // Composed from the MOCKED checks: spreading `...real` alone leaves the
    // real predicate reading live module state, so every guard in this suite's
    // duty graph would silently bypass this mock. Same composition
    // src/host-sweep.test.ts uses.
    containerOwnsOutbound: (sessionId: string) =>
      Boolean(mockIsContainerRunning(sessionId)) || Boolean(mockIsContainerSpawning(sessionId)),
    hasContainerEverRun: (...args: unknown[]) => mockHasContainerEverRun(...args),
    getContainerSpawnedAt: (...args: unknown[]) => mockGetContainerSpawnedAt(...args),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
    killContainer: (...args: unknown[]) => mockKillContainer(...args),
  };
});

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return { ...real, getSession: (...args: unknown[]) => mockGetSession(...args) };
});

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
    writeSessionMessage: async () => undefined,
  };
});

vi.mock('../../dashboard/thread-close.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/thread-close.js')>();
  return { ...real, syncDoneProposalMirror: (...args: unknown[]) => mockSyncDoneProposalMirror(...args) };
});

vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return { ...real, getActiveTasks: () => [], getOrphanedTasks: () => [], transitionToTerminal: () => false };
});

vi.mock('../orchestrator-dispatch/db/agent-group-capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrator-dispatch/db/agent-group-capabilities.js')>()),
  getCapabilityConfig: async () => undefined,
}));

vi.mock('../orchestrator-dispatch/reconciler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrator-dispatch/reconciler.js')>()),
  runReconcilerSweep: () => undefined,
  runReconcilerOnStartup: () => undefined,
}));

vi.mock('../../db/provider-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/provider-health.js')>();
  return { ...real, markProviderUnavailable: () => undefined };
});

vi.mock('../../container-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-config.js')>();
  return { ...real, readContainerConfig: () => ({}) };
});

function makeSessionDbs(): {
  inDb: Database.Database;
  outDb: Database.Database;
  mailbox: NanoclawMailboxSession;
} {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_routing (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type  TEXT,
      platform_id   TEXT,
      thread_id     TEXT
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    -- Mirrors src/db/schema.ts's messages_out. The four routing/scheduling
    -- columns were missing here, so any case that drove a real outbound write
    -- (the ceiling notice, the parked notice) failed on 'no column named
    -- platform_id' and was silently swallowed by the notifier's own try/catch.
    CREATE TABLE messages_out (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      in_reply_to   TEXT,
      timestamp     TEXT NOT NULL,
      deliver_after TEXT,
      recurrence    TEXT,
      kind          TEXT NOT NULL,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // The exact session surface the registered mailbox hands an action, built
  // over these in-memory handles by the production composer — so a test drives
  // the same ops the sweep does, without a temp directory.
  return { inDb, outDb, mailbox: composeNanoclawSession(inDb, () => outDb) };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function makeNotifyTestDbs(opts?: { withRouting?: boolean; recentNotice?: boolean }): {
  inDb: Database.Database;
  outDb: Database.Database;
  mailbox: NanoclawMailboxSession;
} {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE session_routing (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type  TEXT,
      platform_id   TEXT,
      thread_id     TEXT,
      spawn_task_id TEXT,
      session_id    TEXT
    );
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL,
      source_session_id TEXT,
      on_wake       INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (opts?.withRouting !== false) {
    inDb
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, 'slack', 'C-TEST', 'T-TEST')`,
      )
      .run();
  }
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE messages_out (
      id           TEXT PRIMARY KEY,
      seq          INTEGER UNIQUE,
      in_reply_to  TEXT,
      timestamp    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      platform_id  TEXT,
      channel_type TEXT,
      thread_id    TEXT,
      content      TEXT NOT NULL
    );
  `);
  if (opts?.recentNotice) {
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content)
         VALUES ('prior', 1, datetime('now'), 'chat', '{"_system":{"kind":"agent_restart_inactivity"}}')`,
      )
      .run();
  }
  return { inDb, outDb, mailbox: composeNanoclawSession(inDb, () => outDb) };
}

describe('decideCeilingFollowUp', () => {
  const NOW = Date.parse('2026-07-28T12:00:00.000Z');

  it('wakes when a fresh tool was in flight at kill time', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - 5 * 60_000).toISOString(),
        priorToolAttempts: 0,
        now: NOW,
      }),
    ).toEqual({
      action: 'wake-accountable',
      reason: 'tool',
    });
  });

  it('wakes for an explicit durable continuation', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: true,
        currentTool: null,
        toolStartedAt: null,
        priorToolAttempts: 0,
        now: NOW,
      }),
    ).toEqual({
      action: 'wake-accountable',
      reason: 'continuation',
    });
  });

  it('stays quiet without an explicit continuation or fresh tool', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: null,
        toolStartedAt: null,
        priorToolAttempts: 0,
        now: NOW,
      }),
    ).toEqual({ action: 'none' });
  });

  // Contract change (owner-approved): the bound is the ceiling that actually
  // fired plus one sweep interval, not ABSOLUTE_CEILING_MS flat. Starting a
  // tool emits a provider event which touches the heartbeat, so at kill time
  // the tool is always at LEAST as old as the heartbeat age that just crossed
  // the ceiling — the old bound made this branch unreachable and every wedged
  // tool went dark with no accountability wake.
  it('wakes for a tool wedged since exactly the ceiling that fired', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - ABSOLUTE_CEILING_MS - 1).toISOString(),
        priorToolAttempts: 0,
        now: NOW,
        ceilingMs: ABSOLUTE_CEILING_MS,
      }),
    ).toEqual({ action: 'wake-accountable', reason: 'tool' });
  });

  // The sweep-lag slack belongs to the kill path only. host-restart-warn asks
  // "is a tool in flight right now" against live state and omits ceilingMs, so
  // it must keep the plain ABSOLUTE_CEILING_MS freshness window.
  it('keeps the un-widened freshness window when no ceiling is supplied', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - ABSOLUTE_CEILING_MS - 1).toISOString(),
        priorToolAttempts: 0,
        now: NOW,
      }),
    ).toEqual({ action: 'none' });
  });

  it('honors a ceiling widened by the tool’s own declared timeout', () => {
    const widened = 60 * 60 * 1000;
    const args = {
      hasContinuation: false,
      currentTool: 'Bash' as const,
      // Detected one sweep tick after a 60-min ceiling elapsed.
      toolStartedAt: new Date(NOW - widened - 30_000).toISOString(),
      priorToolAttempts: 0,
      now: NOW,
    };
    expect(decideCeilingFollowUp({ ...args, ceilingMs: widened })).toEqual({
      action: 'wake-accountable',
      reason: 'tool',
    });
    // Without the widened ceiling the same tool reads as stale garbage.
    expect(decideCeilingFollowUp(args)).toEqual({ action: 'none' });
  });

  it('still rejects a tool older than the ceiling plus one sweep interval', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - ABSOLUTE_CEILING_MS - 60_000 - 1).toISOString(),
        priorToolAttempts: 0,
        now: NOW,
        ceilingMs: ABSOLUTE_CEILING_MS,
      }),
    ).toEqual({ action: 'none' });
  });

  it('rejects future and malformed tool timestamps', () => {
    for (const toolStartedAt of [new Date(NOW + 1).toISOString(), 'not-a-time']) {
      expect(
        decideCeilingFollowUp({
          hasContinuation: false,
          currentTool: 'Bash',
          toolStartedAt,
          priorToolAttempts: 0,
          now: NOW,
        }),
      ).toEqual({ action: 'none' });
    }
  });

  it('caps a wedged tool at the ceiling once the attempt budget is spent', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - ABSOLUTE_CEILING_MS - 1).toISOString(),
        priorToolAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
        now: NOW,
        ceilingMs: ABSOLUTE_CEILING_MS,
      }),
    ).toEqual({ action: 'none' });
  });

  it('caps tool-only recovery after two attempts without real inbound', () => {
    expect(
      decideCeilingFollowUp({
        hasContinuation: false,
        currentTool: 'Bash',
        toolStartedAt: new Date(NOW - 5 * 60_000).toISOString(),
        priorToolAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
        now: NOW,
      }),
    ).toEqual({ action: 'none' });
  });
});

describe('applyCeilingFollowUp — accountability wake rows', () => {
  const HB_AGE = 35 * 60 * 1000;

  beforeEach(() => armSelfHeal(false));
  afterEach(() => armSelfHeal(false));

  function respawnRows(inDb: Database.Database) {
    return inDb
      .prepare(
        "SELECT id, kind, status, trigger, on_wake, content FROM messages_in WHERE id LIKE 'ceiling-respawn-%' ORDER BY seq",
      )
      .all() as Array<{ id: string; kind: string; status: string; trigger: number; on_wake: number; content: string }>;
  }

  const continuation = {
    id: 'cont-1',
    task: 'write the dbt tests',
    source_message_id: 'origin-1',
    phase: 'queued' as const,
    chain: 1,
    resume_attempts: 0,
    recovery_episode: 0,
  };

  it('writes one deterministic deferred on_wake pair for a continuation', () => {
    const { inDb, mailbox } = makeSessionDbs();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('legacy-user', 2, 'chat', ?, 'completed', 1, 'legacy plain-text inbound')`,
      )
      .run('2026-07-28T11:59:00.000Z');
    const res = _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, continuation, HB_AGE);
    expect(res).toEqual({ action: 'wake-accountable', reason: 'continuation' });
    const rows = respawnRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].trigger).toBe(0);
    expect(rows[0].on_wake).toBe(1);
    const content = JSON.parse(rows[0].content);
    expect(content.sender).toBe('system');
    expect(content._system.kind).toBe('agent_ceiling_respawn');
    expect(content._system.reason).toBe('continuation');
    expect(content.text).toContain('idle ceiling');
    // The wake must name the saved task, or the agent can't tell this wake IS
    // its continuation and re-derives (or redoes) the promised work.
    expect(content.text).toContain('write the dbt tests');
    expect(content.text).toContain('cont-1');
    const recall = inDb
      .prepare("SELECT trigger, on_wake, content FROM messages_in WHERE id LIKE 'recall-ceiling-respawn-%'")
      .get() as { trigger: number; on_wake: number; content: string };
    expect(recall.trigger).toBe(0);
    expect(recall.on_wake).toBe(1);
    expect(JSON.parse(recall.content)).toEqual({ subtype: 'recall_context', deferred: true });
    _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, continuation, HB_AGE);
    expect(respawnRows(inDb)).toHaveLength(1);
  });

  it('writes a fresh wake after real inbound starts a new recovery episode', () => {
    const { inDb, mailbox } = makeSessionDbs();
    _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, continuation, HB_AGE);
    _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, { ...continuation, recovery_episode: 1 }, HB_AGE);

    const rows = respawnRows(inDb);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it('wakes on a fresh in-flight-tool signal', () => {
    armSelfHeal(true);
    const { inDb, mailbox } = makeSessionDbs();
    const res = _applyCeilingFollowUpForTesting(
      mailbox,
      fakeSession(),
      { current_tool: 'Bash', tool_started_at: new Date().toISOString() } as ContainerState,
      null,
      HB_AGE,
    );
    expect(res).toEqual({ action: 'wake-accountable', reason: 'tool' });
    const rows = respawnRows(inDb);
    expect(rows).toHaveLength(1);
    // A tool-only wake has no saved task to name.
    expect(JSON.parse(rows[0].content).text).not.toContain('saved continuation');
  });

  // Class 2's accountability artifact: a container killed at the ceiling with a
  // wedged tool must leave behind an on_wake row that respawns it.
  it('writes the wedged-tool accountability artifact for a tool stuck since the ceiling', () => {
    armSelfHeal(true);
    const { inDb, mailbox } = makeSessionDbs();
    const res = _applyCeilingFollowUpForTesting(
      mailbox,
      fakeSession(),
      {
        current_tool: 'Bash',
        tool_started_at: new Date(Date.now() - ABSOLUTE_CEILING_MS - 1_000).toISOString(),
      } as ContainerState,
      null,
      HB_AGE,
    );
    expect(res).toEqual({ action: 'wake-accountable', reason: 'tool' });
    const rows = respawnRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].on_wake).toBe(1);
    const content = JSON.parse(rows[0].content);
    expect(content._system.kind).toBe('agent_ceiling_respawn');
    expect(content._system.reason).toBe('tool');
    expect(content.text).toContain('done / lost / next');
  });

  it('shadow mode logs but writes nothing for the wedged-tool wake', () => {
    armSelfHeal(false);
    const { inDb, mailbox } = makeSessionDbs();
    const res = _applyCeilingFollowUpForTesting(
      mailbox,
      fakeSession(),
      { current_tool: 'Bash', tool_started_at: new Date().toISOString() } as ContainerState,
      null,
      HB_AGE,
    );
    expect(res).toEqual({ action: 'none' });
    expect(respawnRows(inDb)).toHaveLength(0);
  });

  it('shadow mode never withholds the long-shipped continuation wake', () => {
    armSelfHeal(false);
    const { inDb, mailbox } = makeSessionDbs();
    const res = _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, continuation, HB_AGE);
    expect(res).toEqual({ action: 'wake-accountable', reason: 'continuation' });
    expect(respawnRows(inDb)).toHaveLength(1);
  });

  it('does not fire for a quiet idle container', () => {
    const { inDb, mailbox } = makeSessionDbs();
    const res = _applyCeilingFollowUpForTesting(mailbox, fakeSession(), null, null, HB_AGE);
    expect(res).toEqual({ action: 'none' });
    expect(respawnRows(inDb)).toHaveLength(0);
  });
});

describe('durable continuation wake', () => {
  const continuation = {
    id: 'cont-1',
    task: 'write the dbt tests',
    source_message_id: 'origin-1',
    phase: 'queued' as const,
    chain: 1,
    resume_attempts: 0,
    recovery_episode: 0,
  };

  it('throttles respins after a recent spawn', () => {
    const now = Date.now();
    expect(decideContinuationWake({ now, spawnedAtMs: now - 60_000 })).toBe(false);
    expect(decideContinuationWake({ now, spawnedAtMs: now - CONTINUATION_WAKE_MIN_INTERVAL_MS - 1 })).toBe(true);
    expect(decideContinuationWake({ now, spawnedAtMs: 0 })).toBe(true);
    expect(
      decideContinuationWake({
        now,
        spawnedAtMs: 0,
        lastRecoveryAttemptAtMs: now - 60_000,
      }),
    ).toBe(false);
  });

  it('reads valid current and legacy stored work', () => {
    const { outDb } = makeSessionDbs();
    expect(_hasWorkContinuationForTesting(outDb)).toBe(false);
    outDb.prepare('INSERT INTO session_state VALUES (?, ?, ?)').run(
      'work_continuation',
      JSON.stringify({
        id: continuation.id,
        task: continuation.task,
        phase: continuation.phase,
        chain: continuation.chain,
        resume_attempts: continuation.resume_attempts,
      }),
      new Date().toISOString(),
    );
    expect(_hasWorkContinuationForTesting(outDb)).toBe(true);
    expect(readWorkContinuation(outDb)?.recovery_episode).toBe(0);
    outDb
      .prepare('UPDATE session_state SET value = ? WHERE key = ?')
      .run(JSON.stringify({ ...continuation, task: '  ' }), 'work_continuation');
    expect(_hasWorkContinuationForTesting(outDb)).toBe(false);
    outDb.prepare('DELETE FROM session_state').run();
    outDb
      .prepare('INSERT INTO session_state VALUES (?, ?, ?)')
      .run('pending_next', JSON.stringify({ task: 'legacy task', chain: 2 }), new Date().toISOString());
    expect(_hasWorkContinuationForTesting(outDb)).toBe(true);
  });

  it('exposes the shared recovery cap', () => {
    expect(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS).toBe(2);
  });

  it('increments exactly twice, rejects a third attempt, and restores a rejected wake', () => {
    const { outDb } = makeSessionDbs();
    outDb
      .prepare('INSERT INTO session_state VALUES (?, ?, ?)')
      .run(
        'work_continuation',
        JSON.stringify({ ...continuation, phase: 'running', runner_id: 'stopped-runner' }),
        new Date().toISOString(),
      );

    const previous = readWorkContinuation(outDb)!;
    const first = incrementWorkContinuationResumeAttempt(outDb, continuation.id);
    expect(first?.resume_attempts).toBe(1);
    expect(first?.source_message_id).toBe('origin-1');
    expect(first).toMatchObject({ phase: 'queued' });
    expect(first?.runner_id).toBeUndefined();
    expect(readContinuationRecoveryAttemptAt(outDb, first!)).toBeGreaterThan(Date.now() - 1_000);
    expect(restoreWorkContinuationResumeAttempt(outDb, first!, previous)).toMatchObject({
      phase: 'running',
      runner_id: 'stopped-runner',
      resume_attempts: 0,
    });

    const retriedFirst = incrementWorkContinuationResumeAttempt(outDb, continuation.id);
    const second = incrementWorkContinuationResumeAttempt(outDb, continuation.id);
    expect(second?.resume_attempts).toBe(2);
    expect(canAttemptContinuationRecovery(second!)).toBe(false);
    expect(incrementWorkContinuationResumeAttempt(outDb, continuation.id)).toBeNull();

    expect(restoreWorkContinuationResumeAttempt(outDb, second!, retriedFirst!)?.resume_attempts).toBe(1);
    expect(restoreWorkContinuationResumeAttempt(outDb, second!, retriedFirst!)).toBeNull();
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);
  });

  it('migrates a legacy promise into a counted one-shot recovery record', () => {
    const { outDb } = makeSessionDbs();
    outDb
      .prepare('INSERT INTO session_state VALUES (?, ?, ?)')
      .run('pending_next', JSON.stringify({ task: 'legacy task', chain: 2 }), new Date().toISOString());
    const migrated = migrateLegacyWorkContinuationForRecovery(outDb);
    expect(migrated?.id).not.toBe('legacy-pending-next');
    expect(migrated?.resume_attempts).toBe(1);
    expect(outDb.prepare("SELECT 1 FROM session_state WHERE key = 'pending_next'").get()).toBeUndefined();
    expect(readWorkContinuation(outDb)?.id).toBe(migrated?.id);
  });

  it('restores the legacy promise exactly when its recovery spawn is rejected', () => {
    const { outDb } = makeSessionDbs();
    outDb
      .prepare('INSERT INTO session_state VALUES (?, ?, ?)')
      .run('pending_next', JSON.stringify({ task: 'legacy task', chain: 2 }), new Date().toISOString());

    const previous = readWorkContinuation(outDb)!;
    const attempted = migrateLegacyWorkContinuationForRecovery(outDb)!;
    expect(restoreWorkContinuationResumeAttempt(outDb, attempted, previous)).toEqual(previous);
    expect(outDb.prepare("SELECT 1 FROM session_state WHERE key = 'work_continuation'").get()).toBeUndefined();
    expect(outDb.prepare("SELECT value FROM session_state WHERE key = 'pending_next'").get()).toEqual({
      value: JSON.stringify({ task: 'legacy task', chain: 2 }),
    });
    expect(readWorkContinuation(outDb)).toEqual(previous);
  });

  it('parks only due recovery rows at the cap and leaves real inbound wakeable', () => {
    const { inDb } = makeSessionDbs();
    const now = new Date().toISOString();
    const insert = inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', ?, 'pending', 1, ?)`,
    );
    insert.run('ceiling-respawn-cont-1', 2, now, JSON.stringify({ sender: 'system' }));
    insert.run('host-restart-cont-1', 4, now, JSON.stringify({ sender: 'system' }));
    insert.run('user-1', 6, now, JSON.stringify({ sender: 'Alice' }));

    expect(hasDueRecoveryWake(inDb, now)).toBe(true);
    expect(parkDueRecoveryWakes(inDb, now)).toBe(2);
    expect(hasDueRecoveryWake(inDb, now)).toBe(false);
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'user-1'").get()).toEqual({ status: 'pending' });
  });

  it('caps tool-only episodes and resets the count after real inbound', () => {
    const { inDb, mailbox } = makeSessionDbs();
    const insert = inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', ?, 'completed', 1, ?)`,
    );
    insert.run('ceiling-respawn-tool-1', 2, '2026-07-28T12:00:00.000Z', JSON.stringify({ sender: 'system' }));
    insert.run('ceiling-respawn-tool-2', 4, '2026-07-28T12:01:00.000Z', JSON.stringify({ sender: 'system' }));
    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(2);
    insert.run('user-1', 6, '2026-07-28T12:02:00.000Z', JSON.stringify({ sender: 'user' }));
    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(0);
    insert.run('ceiling-respawn-tool-3', 8, '2026-07-28T12:03:00.000Z', JSON.stringify({ sender: 'system' }));
    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(1);
  });

  it('treats historical non-JSON content as real inbound when counting tool recovery attempts', () => {
    const { inDb, mailbox } = makeSessionDbs();
    const insert = inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', ?, 'completed', 1, ?)`,
    );
    insert.run('ceiling-respawn-tool-1', 2, '2026-07-28T12:00:00.000Z', JSON.stringify({ sender: 'system' }));
    insert.run('legacy-user-1', 4, '2026-07-28T12:01:00.000Z', 'legacy plain-text inbound');
    insert.run('ceiling-respawn-tool-2', 6, '2026-07-28T12:02:00.000Z', JSON.stringify({ sender: 'system' }));

    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(1);
  });

  it('orders mixed ISO and SQLite-style timestamps chronologically when resetting tool attempts', () => {
    const { inDb, mailbox } = makeSessionDbs();
    const insert = inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', ?, 'completed', 1, ?)`,
    );
    insert.run('user-old', 2, '2026-07-28T01:00:00.000Z', JSON.stringify({ sender: 'user' }));
    insert.run('ceiling-respawn-tool-old', 4, '2026-07-28T01:30:00.000Z', JSON.stringify({ sender: 'system' }));
    insert.run('user-new', 6, '2026-07-28 02:00:00', JSON.stringify({ sender: 'user' }));
    insert.run('ceiling-respawn-tool-new', 8, '2026-07-28T02:30:00.000Z', JSON.stringify({ sender: 'system' }));

    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(1);
  });

  it('writes exactly one public parked accounting for repeated sweeps', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    inDb.prepare('INSERT INTO session_routing VALUES (1, ?, ?, ?)').run('slack', 'C-1', 'T-1');
    const capped = { ...continuation, resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS };
    const write = (message: { id: string; kind: string; content: string }) => {
      outDb
        .prepare(
          `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, content)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?)`,
        )
        .run(message.id, new Date().toISOString(), message.kind, message.content);
    };

    expect(notifyContinuationParked(mailbox, fakeSession(), capped, write)).toBe(true);
    expect(notifyContinuationParked(mailbox, fakeSession(), capped, write)).toBe(false);
    expect(notifyContinuationParked(mailbox, fakeSession(), { ...capped, recovery_episode: 1 }, write)).toBe(true);
    expect(
      outDb.prepare("SELECT COUNT(*) AS count FROM messages_out WHERE id LIKE 'continuation-parked-%'").get(),
    ).toEqual({ count: 2 });
  });

  it('routes parked accounting through the continuation source in an agent-shared session', () => {
    const { inDb, mailbox } = makeSessionDbs();
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, 2, 'chat', ?, 'completed', 1, 'C-SHARED', 'slack', 'T-SHARED', '{}')`,
      )
      .run('origin-1', new Date().toISOString());
    const writes: Array<{ platformId: string | null; channelType: string | null; threadId: string | null }> = [];

    expect(
      notifyContinuationParked(mailbox, fakeSession(), continuation, (message) =>
        writes.push({
          platformId: message.platformId,
          channelType: message.channelType,
          threadId: message.threadId,
        }),
      ),
    ).toBe(true);
    expect(writes).toEqual([{ platformId: 'C-SHARED', channelType: 'slack', threadId: 'T-SHARED' }]);
  });
});

describe('notifyKillCeiling (Layer-3 fix)', () => {
  // `pendingClaims=1` means the container had an in-flight inbound when we
  // killed it — i.e. a user was actually waiting. That's the only case
  // where the notify should fire (see the spam-gate test below for the
  // claims=0 case).
  it('writes a visible chat outbound with the session route before killContainer', () => {
    const { outDb, mailbox } = makeNotifyTestDbs();
    const heartbeatAgeMs = 32 * 60_000;

    _notifyKillCeilingForTesting(mailbox, fakeSession(), heartbeatAgeMs, 1);

    const rows = outDb
      .prepare('SELECT timestamp, kind, platform_id, channel_type, thread_id, content FROM messages_out')
      .all() as Array<{
      timestamp: string;
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].channel_type).toBe('slack');
    expect(rows[0].platform_id).toBe('C-TEST');
    expect(rows[0].thread_id).toBe('T-TEST');
    const body = JSON.parse(rows[0].content) as { text: string; _system?: { kind: string } };
    expect(body.text).toContain('32 minutes');
    expect(body.text).toContain('picked up automatically');
    expect(body.text).toContain('no need to resend');
    expect(body._system?.kind).toBe('agent_restart_inactivity');
  });

  it('reports a persisted Codex control-plane failure instead of calling it generic silence', () => {
    const { outDb, mailbox } = makeNotifyTestDbs();
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 62 * 60_000, 1, {
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: 3_600_000,
      tool_started_at: '2026-07-15T11:22:53.000Z',
      provider_status: 'failed',
      provider_failure_reason: 'three JSON-RPC health probes timed out',
    });

    const row = outDb.prepare('SELECT content FROM messages_out').get() as { content: string };
    const body = JSON.parse(row.content) as {
      text: string;
      _system: { provider_status: string; provider_failure_reason: string };
    };
    expect(body.text).toContain('Codex control-plane recovery did not complete');
    expect(body.text).toContain('three JSON-RPC health probes timed out');
    expect(body.text).not.toContain('went silent');
    expect(body._system.provider_status).toBe('failed');
  });

  it('skips when no inbound was claimed at kill time (idle session, no user waiting)', () => {
    // The kill-ceiling sweep fires on every container that hits the 30-min
    // idle ceiling, not just ones with users waiting on a reply. Without
    // this gate, every quiet operator gets a restart notice every half
    // hour across every wired session. Routing is present (session DID
    // wake before) — the only thing that distinguishes "user waiting" from
    // "idle" is whether any inbound was claimed (processing_ack) when we
    // killed.
    const { outDb, mailbox } = makeNotifyTestDbs();
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 0);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('skips when the session has never been routed (fresh session_routing row missing)', () => {
    const { outDb, mailbox } = makeNotifyTestDbs({ withRouting: false });
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 1);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('is idempotent within 60s — a re-firing sweep tick does not duplicate the notice', () => {
    const { outDb, mailbox } = makeNotifyTestDbs({ recentNotice: true });
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 1);
    // Only the seed row should be present; the second call recognized the
    // marker and skipped.
    const rows = outDb.prepare('SELECT id FROM messages_out').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('prior');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The five plan §8 acceptance cases, plus the family-case rule's requirement
// that every moved registration be driven THROUGH the registry: a case that
// calls a moved body directly proves nothing about the `run` wrapper this PR
// actually wrote. Each case below fetches its duty from
// `_listSweepRegistrationsForTesting()` by inventory name and invokes
// `run`/`claims` itself, or drives the whole session through
// `_sweepSessionForTesting`.
// ─────────────────────────────────────────────────────────────────────────────

const CONTINUATION = {
  id: 'cont-1',
  task: 'write the dbt tests',
  source_message_id: 'origin-1',
  phase: 'queued' as const,
  chain: 1,
  resume_attempts: 0,
  recovery_episode: 0,
};

function emptyPlan(overrides: Partial<WakePlan> = {}): WakePlan {
  return {
    dueCount: 0,
    wakePriority: 'interactive',
    admittedTasks: 0,
    workContinuation: null,
    continuationWakeEligible: false,
    hasOutbound: true,
    ...overrides,
  };
}

/** A session context with only the fields the moved duties actually read. */
function sessionCtx(
  mailbox: NanoclawMailboxSession,
  plan: WakePlan,
  extra: Partial<SweepSessionContext> & { windowsSeen?: string[] } = {},
): SweepSessionContext {
  const { windowsSeen, ...rest } = extra;
  return {
    session: fakeSession(),
    agentGroupId: 'ag-test',
    agentGroupFolder: 'ag-folder',
    mailbox,
    plan,
    killSnapshot: null,
    run: async (action: (m: NanoclawMailboxSession) => unknown) => action(mailbox),
    runIn: async (window: string, action: (m: NanoclawMailboxSession) => unknown) => {
      windowsSeen?.push(window);
      return action(mailbox);
    },
    reportWoke: () => undefined,
    reportWake: () => undefined,
    ...rest,
  } as unknown as SweepSessionContext;
}

function duty(name: string) {
  const { duties } = _listSweepRegistrationsForTesting();
  const found = duties.find((d) => d.name === name);
  if (!found) throw new Error(`duty ${name} is not registered`);
  return found;
}

function killFollowUp(name: string) {
  const { killFollowUps } = _listSweepRegistrationsForTesting();
  const found = killFollowUps.find((f) => f.name === name);
  if (!found) throw new Error(`kill follow-up ${name} is not registered`);
  return found;
}

function saveContinuation(outDb: Database.Database, record: Record<string, unknown>): void {
  outDb
    .prepare(
      `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify(record), new Date().toISOString());
}

beforeEach(() => {
  // Keyed by session id, and every case here uses 'sess-test' — an entry left
  // behind would suppress the next case's wake (#359 dedupe) and the case would
  // pass for the wrong reason.
  _resetDetachedWakesForTesting();
  armSelfHeal(false);
  mockKillContainer.mockReset();
  mockWakeContainer.mockReset().mockResolvedValue(true);
  mockIsContainerRunning.mockReset().mockReturnValue(false);
  mockIsContainerSpawning.mockReset().mockReturnValue(false);
  mockHasContainerEverRun.mockReset().mockReturnValue(true);
  mockGetContainerSpawnedAt.mockReset().mockReturnValue(0);
  mockGetSession.mockReset();
  mockAdmitDueTaskContexts.mockReset().mockReturnValue(0);
  mockSyncDoneProposalMirror.mockReset();
});

describe('S2-PR13 — continuation and ceiling accountability, through the registry', () => {
  // ── F-13.1 ─────────────────────────────────────────────────────────────────
  it('the durable continuation wake keeps its throttle, cap and attempt restore', async () => {
    const s9a = duty(SWEEP_DUTY_INVENTORY.S9a);
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    expect([s9a.phase, s9a.order]).toEqual(['session:plan', 80]);
    expect([s9b.phase, s9b.order]).toEqual(['session:wake', 10]);

    // Throttle: a spawn inside the 10-minute window makes the session
    // ineligible even though a resumable continuation is saved.
    {
      const { outDb, mailbox } = makeSessionDbs();
      saveContinuation(outDb, CONTINUATION);
      mockGetContainerSpawnedAt.mockReturnValue(Date.now() - 60_000);
      const plan = emptyPlan({ workContinuation: readWorkContinuation(outDb) });
      await s9a.run(sessionCtx(mailbox, plan));
      expect(plan.continuationWakeEligible).toBe(false);
    }

    // Cap: the same continuation past WORK_CONTINUATION_RESUME_MAX_ATTEMPTS is
    // ineligible however old the last attempt is.
    {
      const { outDb, mailbox } = makeSessionDbs();
      saveContinuation(outDb, { ...CONTINUATION, resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS });
      mockGetContainerSpawnedAt.mockReturnValue(0);
      const plan = emptyPlan({ workContinuation: readWorkContinuation(outDb) });
      await s9a.run(sessionCtx(mailbox, plan));
      expect(plan.continuationWakeEligible).toBe(false);
    }

    // Eligible: throttle elapsed and budget unspent.
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);
    mockGetContainerSpawnedAt.mockReturnValue(Date.now() - CONTINUATION_WAKE_MIN_INTERVAL_MS - 1);
    const plan = emptyPlan({ workContinuation: readWorkContinuation(outDb) });
    await s9a.run(sessionCtx(mailbox, plan));
    expect(plan.continuationWakeEligible).toBe(true);

    // Attempt restore: the wake is REFUSED, so the attempt S9b consumed has to
    // go back — otherwise a rejected spawn silently burns half the budget.
    mockWakeContainer.mockResolvedValue(false);
    const windowsSeen: string[] = [];
    await s9b.run(sessionCtx(mailbox, plan, { windowsSeen }));
    // The wake is DETACHED (#359), so the restore that hangs off it is no
    // longer synchronous with the duty. Settling is the sanctioned wait; the
    // assertions themselves are unchanged.
    await _settleDetachedWakesForTesting();

    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    expect(windowsSeen).toEqual(['session:wake', 'session:wake']);
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(0);

    // …and an accepted wake keeps the consumed attempt.
    mockWakeContainer.mockResolvedValue(true);
    plan.continuationWakeEligible = true;
    plan.workContinuation = readWorkContinuation(outDb);
    await s9b.run(sessionCtx(mailbox, plan));
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);
  });

  // ── F-13.2 ─────────────────────────────────────────────────────────────────
  it('every stopped-session wake passes through continuation admission even when a scheduled row is due', async () => {
    const s9a = duty(SWEEP_DUTY_INVENTORY.S9a);
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    // Admission (S9a) is the LAST session:plan duty; the wake (S9b) is the only
    // session:wake duty. A due row cannot reach the wake without passing
    // through admission first (constraint 9).
    expect(s9a.order).toBeGreaterThan(duty(SWEEP_DUTY_INVENTORY.S7).order);
    expect(SWEEP_DUTY_INVENTORY.S9b).toBe('container-wake');

    // The fixture has to be work the runner WOULD resume if admission were
    // wrong, or the case proves nothing. Ownership is the mechanism, not the
    // attempt count: the runner never reads `resume_attempts`, and a queued
    // record with no `runner_id` is runnable on sight. What holds saved work
    // back after a crash is the DEAD RUNNER'S CLAIM still on the record, and
    // `incrementWorkContinuationResumeAttempt` (ops/continuation.ts) is the
    // only thing that clears it — "so the container can distinguish this
    // authorized start from a capped attempt that has already run and is
    // merely hitchhiking on an unrelated wake."
    //
    // So: valid, under the cap, one throttle away from resumable, still
    // claimed by the container that crashed holding it.
    const owned = { ...CONTINUATION, phase: 'running' as const, runner_id: 'crashed-runner', resume_attempts: 0 };

    async function scheduledWakeWith(
      record: Record<string, unknown>,
      spawnedAtMs: number,
    ): Promise<{ outDb: Database.Database; before: unknown; mailbox: NanoclawMailboxSession; plan: WakePlan }> {
      const { outDb, mailbox } = makeSessionDbs();
      saveContinuation(outDb, record);
      const before = outDb.prepare("SELECT value, updated_at FROM session_state WHERE key = 'work_continuation'").get();
      mockGetContainerSpawnedAt.mockReturnValue(spawnedAtMs);

      // An unrelated scheduled row IS due, which on its own wakes the container.
      const plan = emptyPlan({
        dueCount: 1,
        wakePriority: 'scheduled',
        workContinuation: readWorkContinuation(outDb),
      });
      await s9a.run(sessionCtx(mailbox, plan));
      await s9b.run(sessionCtx(mailbox, plan));
      // One simulated TICK per call, and S9b keeps at most one detached
      // follow-up per session (#359). Every call here reuses 'sess-test', so
      // without settling the previous one the next tick is suppressed as a
      // duplicate — which is correct in production, where ticks are 60 s apart,
      // and an artefact here.
      await _settleDetachedWakesForTesting();
      return { outDb, before, mailbox, plan };
    }

    // ── Throttled: under the cap, but the last spawn was a minute ago. ────────
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const throttled = await scheduledWakeWith(owned, Date.now() - 60_000);
    expect(throttled.plan.continuationWakeEligible).toBe(false);

    // The container woke — for the SCHEDULED row, at scheduled priority, and
    // the wake names no continuation.
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    expect(mockWakeContainer.mock.calls[0][1]).toBe('scheduled');
    const wakeLog = info.mock.calls.find((c) => c[0] === 'Waking container for due messages')!;
    expect(wakeLog).toBeDefined();
    expect((wakeLog[1] as { priority: string; continuationId?: string }).priority).toBe('scheduled');
    expect((wakeLog[1] as { continuationId?: string }).continuationId).toBeUndefined();
    info.mockRestore();

    // …and the saved work did not ride along. The row is byte-identical,
    // updated_at included, so the crashed runner's claim is still on it and the
    // fresh container cannot read this scheduled wake as an authorized resume.
    expect(
      throttled.outDb.prepare("SELECT value, updated_at FROM session_state WHERE key = 'work_continuation'").get(),
    ).toEqual(throttled.before);
    const stillOwned = readWorkContinuation(throttled.outDb)!;
    expect(stillOwned.runner_id).toBe('crashed-runner');
    expect(stillOwned.phase).toBe('running');
    expect(stillOwned.resume_attempts).toBe(0);
    expect(readContinuationRecoveryAttemptAt(throttled.outDb, stillOwned)).toBe(0);

    // ── Capped: throttle long elapsed, budget spent. Same conclusion. ─────────
    mockWakeContainer.mockClear();
    const capped = await scheduledWakeWith({ ...owned, resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS }, 0);
    expect(capped.plan.continuationWakeEligible).toBe(false);
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    expect(
      capped.outDb.prepare("SELECT value, updated_at FROM session_state WHERE key = 'work_continuation'").get(),
    ).toEqual(capped.before);
    expect(readWorkContinuation(capped.outDb)?.runner_id).toBe('crashed-runner');

    // ── Control: the SAME fixture, admitted. Ownership transfers, which is
    //    exactly the state the two assertions above deny — so they discriminate
    //    rather than merely observing a row nothing was going to touch.
    mockWakeContainer.mockClear();
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, owned);
    mockGetContainerSpawnedAt.mockReturnValue(0);
    const admitted = emptyPlan({
      dueCount: 1,
      wakePriority: 'scheduled',
      workContinuation: readWorkContinuation(outDb),
    });
    await s9a.run(sessionCtx(mailbox, admitted));
    expect(admitted.continuationWakeEligible).toBe(true);
    await s9b.run(sessionCtx(mailbox, admitted));

    const resumed = readWorkContinuation(outDb)!;
    expect(resumed.runner_id).toBeUndefined();
    expect(resumed.phase).toBe('queued');
    expect(resumed.resume_attempts).toBe(1);
  });

  // ── F-13.3 ─────────────────────────────────────────────────────────────────
  it('ceiling-kill accountability queues at most WORK_CONTINUATION_RESUME_MAX_ATTEMPTS wakes', async () => {
    const s10 = killFollowUp(SWEEP_DUTY_INVENTORY.S10);
    expect(s10.order).toBe(30);

    armSelfHeal(true);
    const { inDb, mailbox } = makeSessionDbs();
    const outcome = { action: 'kill-ceiling' as const, heartbeatAgeMs: 35 * 60_000, ceilingMs: ABSOLUTE_CEILING_MS };

    // Three consecutive ceiling kills, each interrupting a DIFFERENT wedged
    // tool (a repeated tool_started_at would dedupe on the row id instead, and
    // prove nothing about the cap).
    for (let i = 0; i < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS + 1; i++) {
      const ctx = sessionCtx(mailbox, emptyPlan(), {
        killSnapshot: {
          reason: 'absolute-ceiling',
          containerState: {
            current_tool: 'Bash',
            tool_started_at: new Date(Date.now() - 60_000 * (i + 1)).toISOString(),
          } as ContainerState,
          pendingClaims: 1,
          workContinuation: null,
        },
      } as Partial<SweepSessionContext>);
      await s10.run(ctx, outcome, mailbox);
    }

    const rows = inDb.prepare("SELECT id FROM messages_in WHERE id LIKE 'ceiling-respawn-tool-%'").all();
    expect(rows).toHaveLength(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS);
    expect(countToolRecoveryAttemptsSinceRealInbound(mailbox)).toBe(WORK_CONTINUATION_RESUME_MAX_ATTEMPTS);
    armSelfHeal(false);
  });

  // ── F-13.4 ─────────────────────────────────────────────────────────────────
  it('the kill sequence is kill, notify, reset, follow-up, with claims snapshotted before the kill', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-ceiling', 'ceiling', 'ceiling-folder', ?)`,
    ).run(new Date().toISOString());

    const session: Session = { ...fakeSession(), id: 'sess-ceiling', agent_group_id: 'ag-ceiling' };
    mockIsContainerRunning.mockReturnValue(true);
    mockGetSession.mockReturnValue(session);

    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const dir = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id);
    const inboundPath = path.join(dir, 'inbound.db');
    const outboundPath = path.join(dir, 'outbound.db');

    // A stale heartbeat past the absolute ceiling is what fires the branch.
    const heartbeat = path.join(dir, '.heartbeat');
    fs.writeFileSync(heartbeat, '');
    const stale = new Date(Date.now() - ABSOLUTE_CEILING_MS - 5 * 60_000);
    fs.utimesSync(heartbeat, stale, stale);

    let raw = new Database(outboundPath);
    // A live claim means a user WAS waiting — S15's only gate — and it also
    // keeps both idle reaps from claiming the exclusive chain, so the SLA
    // branch runs.
    raw
      .prepare(`INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', ?)`)
      .run(new Date().toISOString());
    raw.close();
    // Routing is inbound-side; the ceiling notice needs it to know where to post.
    const inRaw = new Database(inboundPath);
    inRaw
      .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
      .run('slack', 'C-CEILING', 'T-CEILING');
    inRaw.close();
    raw = new Database(outboundPath);
    raw
      .prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(CONTINUATION), new Date().toISOString());
    raw.close();

    // The discriminator for "notify AFTER the kill": count the outbound notices
    // that exist at the moment killContainer is called.
    let outboundAtKill = -1;
    mockKillContainer.mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      const h = new Database(outboundPath, { readonly: true });
      outboundAtKill = (h.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
      h.close();
      // A real kill stops the container, so the post-kill window sees it gone.
      // Leaving it "running" here would model a REPLACEMENT wake landing in the
      // kill's yield gap, which the ownership guard deliberately skips — that
      // case has its own two cases in the container-health suite (mailbox seam
      // PR 5 round 8, 3b6cbb5f).
      mockIsContainerRunning.mockReturnValue(false);
      // …and the child's `close` is what carries the follow-up chain now
      // (Codex final): the kill only requests the stop, so without firing this
      // the notify/reset/follow-up assertions below have nothing to observe.
      onExit?.();
    });

    await _sweepSessionForTesting(session);
    await _settlePostKillForTesting();

    // 1. kill
    // Three arguments now: the post-kill chain rides on `onExit` (Codex final).
    expect(mockKillContainer).toHaveBeenCalledWith('sess-ceiling', 'absolute-ceiling', expect.any(Function));
    // 2. notify — written only after the kill returned, and only because the
    //    claim count was snapshotted in the observe session BEFORE the reset
    //    below cleared it. A post-kill read would have seen 0 claims and
    //    written nothing.
    expect(outboundAtKill).toBe(0);
    const out = new Database(outboundPath, { readonly: true });
    const notices = out.prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0].content)._system.kind).toBe('agent_restart_inactivity');
    // 3. reset — the orphan claim is gone
    expect(out.prepare('SELECT COUNT(*) AS c FROM processing_ack').get()).toEqual({ c: 0 });
    out.close();
    // 4. follow-up — the accountability wake names the snapshotted continuation
    const respawn = new Database(inboundPath, { readonly: true })
      .prepare("SELECT id, on_wake, content FROM messages_in WHERE id LIKE 'ceiling-respawn-%'")
      .all() as Array<{ id: string; on_wake: number; content: string }>;
    expect(respawn).toHaveLength(1);
    expect(respawn[0].on_wake).toBe(1);
    expect(JSON.parse(respawn[0].content).text).toContain(CONTINUATION.task);

    // …and the follow-ups are declared in that order.
    const { killFollowUps } = _listSweepRegistrationsForTesting();
    expect(killFollowUps.map((f) => [f.name, f.order])).toEqual([
      [SWEEP_DUTY_INVENTORY.S15, 10],
      [SWEEP_DUTY_INVENTORY.S17, 20],
      [SWEEP_DUTY_INVENTORY.S10, 30],
    ]);

    // A follow-up failure does not break the kill path: S10 swallows it with
    // the preserved warning rather than unwinding the post-kill session.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const exploding = {
      countRecoveryAttemptsSinceRealInbound: () => {
        throw new Error('outbound gone');
      },
    } as unknown as NanoclawMailboxSession;
    await expect(
      Promise.resolve(
        killFollowUp(SWEEP_DUTY_INVENTORY.S10).run(
          sessionCtx(exploding, emptyPlan(), {
            killSnapshot: {
              reason: 'absolute-ceiling',
              containerState: null,
              pendingClaims: 1,
              workContinuation: null,
            },
          } as Partial<SweepSessionContext>),
          { action: 'kill-ceiling', heartbeatAgeMs: 35 * 60_000, ceilingMs: ABSOLUTE_CEILING_MS },
          exploding,
        ),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'ceiling-kill follow-up failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warn.mockRestore();

    await closeDb();
  });

  // ── F-13.5 ─────────────────────────────────────────────────────────────────
  it('the parked-continuation notice is posted once per continuation id and recovery episode', async () => {
    const s8 = duty(SWEEP_DUTY_INVENTORY.S8);
    expect([s8.phase, s8.order]).toEqual(['session:plan', 70]);

    const { outDb, mailbox } = makeNotifyTestDbs();
    const capped = { ...CONTINUATION, resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS };

    const parkedCount = () =>
      (
        outDb.prepare("SELECT COUNT(*) AS c FROM messages_out WHERE id LIKE 'continuation-parked-%'").get() as {
          c: number;
        }
      ).c;

    // Same id, same episode, three sweeps → one notice.
    for (let i = 0; i < 3; i++) await s8.run(sessionCtx(mailbox, emptyPlan({ workContinuation: capped })));
    expect(parkedCount()).toBe(1);

    // A new recovery episode is a new promise, so it gets its own notice.
    await s8.run(sessionCtx(mailbox, emptyPlan({ workContinuation: { ...capped, recovery_episode: 1 } })));
    expect(parkedCount()).toBe(2);

    // A different continuation id likewise.
    await s8.run(sessionCtx(mailbox, emptyPlan({ workContinuation: { ...capped, id: 'cont-2' } })));
    expect(parkedCount()).toBe(3);
  });
});

describe('registered S6/S7/S8/S9a/S9b/S15/S10 entries reach their bodies', () => {
  it('S6: the registered done-proposal mirror forwards the parsed proposal and survives a mirror failure', async () => {
    const s6 = duty(SWEEP_DUTY_INVENTORY.S6);
    expect([s6.phase, s6.order]).toEqual(['session:plan', 50]);

    const { outDb, mailbox } = makeSessionDbs();
    outDb
      .prepare(`INSERT INTO session_state (key, value, updated_at) VALUES ('done_proposal', ?, ?)`)
      .run(JSON.stringify({ reason: 'shipped', proposed_at: '2026-09-03T10:00:00.000Z' }), new Date().toISOString());

    await s6.run(sessionCtx(mailbox, emptyPlan()));
    // The PARSED proposal is what crosses the seam — no handle leaves the
    // session (mailbox seam PR 4).
    expect(mockSyncDoneProposalMirror).toHaveBeenCalledWith('sess-test', {
      reason: 'shipped',
      proposed_at: '2026-09-03T10:00:00.000Z',
    });

    // The isolation the body's own try/catch buys: a mirror failure costs this
    // session nothing, and keeps its log string.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    mockSyncDoneProposalMirror.mockImplementationOnce(() => {
      throw new Error('central db locked');
    });
    // `run` is synchronous here; Promise.resolve keeps the assertion honest
    // for either shape without changing what is being asserted.
    await expect(Promise.resolve(s6.run(sessionCtx(mailbox, emptyPlan())))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'done_proposal mirror failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warn.mockRestore();

    // No outbound file → nothing read, nothing mirrored (constraint 20).
    mockSyncDoneProposalMirror.mockClear();
    const noOutbound = { hasOutbound: () => false } as unknown as NanoclawMailboxSession;
    await s6.run(sessionCtx(noOutbound, emptyPlan()));
    expect(mockSyncDoneProposalMirror).not.toHaveBeenCalled();
  });

  it('S7: the registered continuation read puts the stored record on the WakePlan', async () => {
    const s7 = duty(SWEEP_DUTY_INVENTORY.S7);
    expect([s7.phase, s7.order]).toEqual(['session:plan', 60]);

    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);
    const plan = emptyPlan();
    await s7.run(sessionCtx(mailbox, plan));
    expect(plan.workContinuation).toMatchObject({ id: 'cont-1', task: CONTINUATION.task, resume_attempts: 0 });
  });

  it('S8: the registered recovery parking parks due recovery rows and re-counts the plan', async () => {
    const s8 = duty(SWEEP_DUTY_INVENTORY.S8);
    const { inDb, mailbox } = makeSessionDbs();
    const now = new Date().toISOString();
    const insert = inDb.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', ?, 'pending', 1, ?)`,
    );
    insert.run('ceiling-respawn-cont-1', 2, now, JSON.stringify({ sender: 'system' }));
    insert.run('user-1', 4, now, JSON.stringify({ sender: 'Alice' }));

    const plan = emptyPlan({
      dueCount: 2,
      workContinuation: { ...CONTINUATION, resume_attempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS },
    });
    await s8.run(sessionCtx(mailbox, plan));

    expect(hasDueRecoveryWake(inDb, new Date().toISOString())).toBe(false);
    // Real inbound survives, and the plan's due count is the re-read one.
    expect(plan.dueCount).toBe(1);
    expect(inDb.prepare("SELECT status FROM messages_in WHERE id = 'user-1'").get()).toEqual({ status: 'pending' });
  });

  it('S9a: the registered eligibility gate consults the container state and the stored attempt clock', async () => {
    const s9a = duty(SWEEP_DUTY_INVENTORY.S9a);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);
    mockGetContainerSpawnedAt.mockReturnValue(0);

    // A RUNNING container is never eligible, whatever the throttle says.
    mockIsContainerRunning.mockReturnValue(true);
    const running = emptyPlan({ workContinuation: readWorkContinuation(outDb) });
    await s9a.run(sessionCtx(mailbox, running));
    expect(running.continuationWakeEligible).toBe(false);
    expect(mockIsContainerRunning).toHaveBeenCalledWith('sess-test');

    mockIsContainerRunning.mockReturnValue(false);
    const stopped = emptyPlan({ workContinuation: readWorkContinuation(outDb) });
    await s9a.run(sessionCtx(mailbox, stopped));
    expect(stopped.continuationWakeEligible).toBe(true);
  });

  it('S9b: the registered wake opens its own short windows and holds none across wakeContainer', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);

    const order: string[] = [];
    mockWakeContainer.mockImplementation(async () => {
      order.push('wake');
      return true;
    });
    const windowsSeen: string[] = [];
    const plan = emptyPlan({ continuationWakeEligible: true, workContinuation: readWorkContinuation(outDb) });
    const ctx = sessionCtx(mailbox, plan, {
      runIn: async (window: string, action: (m: NanoclawMailboxSession) => unknown) => {
        windowsSeen.push(window);
        order.push(`open:${window}`);
        const result = await action(mailbox);
        order.push(`close:${window}`);
        return result;
      },
    } as Partial<SweepSessionContext>);

    await s9b.run(ctx);

    // The increment's window CLOSES before the wake — nothing is held across it.
    expect(order).toEqual(['open:session:wake', 'close:session:wake', 'wake']);
    expect(windowsSeen).toEqual(['session:wake']);
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);
  });

  // ── #359 ───────────────────────────────────────────────────────────────────
  //
  // The per-session loop is serial and a container spawn can take 20-47 s, so
  // awaiting the wake here made a tick's cost track the number of containers
  // that happened to be due rather than the number of sessions. These three
  // cases pin the detach: the duty returns without the spawn, the follow-up
  // still happens, and a failed follow-up cannot reach the tick.

  it('a wake that takes five seconds does not hold the per-session loop (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { mailbox } = makeSessionDbs();

    // A spawn that never settles during the case: if the duty awaited it, the
    // `await` below would never resolve and the case would time out rather
    // than fail — which is exactly the signal we want, so it is also asserted
    // positively against a wake that is still pending afterwards.
    let releaseWake: (woke: boolean) => void = () => undefined;
    const spawn = new Promise<boolean>((resolve) => {
      releaseWake = resolve;
    });
    mockWakeContainer.mockImplementation(() => spawn);

    const plan = emptyPlan({ dueCount: 1, wakePriority: 'scheduled' });
    const reported: { awaited: boolean; waitMs: number }[] = [];
    let woke: boolean | undefined;
    const ctx = sessionCtx(mailbox, plan, {
      reportWake: (stats: { awaited: boolean; waitMs: number }) => reported.push(stats),
      reportWoke: (v: boolean) => {
        woke = v;
      },
    } as Partial<SweepSessionContext>);

    await s9b.run(ctx);

    // The duty is DONE while the spawn is still in flight.
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    // Instrumentation: one wake started, none awaited, and the loop spent only
    // the call's synchronous prologue inside it.
    expect(reported).toHaveLength(1);
    expect(reported[0]!.awaited).toBe(false);
    expect(reported[0]!.waitMs).toBeLessThan(1_000);
    // …and the session still counts as woken for the rest of this tick, so the
    // observe read and the health chain stay skipped for a container that is
    // starting.
    expect(woke).toBe(true);

    releaseWake(true);
    await _settleDetachedWakesForTesting();
  });

  it('a stalled wake gets ONE follow-up however many ticks pass over it (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { mailbox } = makeSessionDbs();

    // One spawn, queued behind others on the projection worker, unresolved for
    // the whole case — production's 20-47 s, which is tens of ticks.
    let releaseWake: (woke: boolean) => void = () => undefined;
    const spawn = new Promise<boolean>((resolve) => {
      releaseWake = resolve;
    });
    mockWakeContainer.mockImplementation(() => spawn);

    const plan = emptyPlan({ dueCount: 1, wakePriority: 'scheduled' });
    await s9b.run(sessionCtx(mailbox, plan));
    expect(_detachedWakeCountForTesting()).toBe(1);

    // Ticks two and three see the same session with the same due row. Each one
    // used to wrap the SAME deduped promise in a fresh `.then()`, retaining a
    // context and a snapshot per tick.
    await s9b.run(sessionCtx(mailbox, plan));
    await s9b.run(sessionCtx(mailbox, plan));

    expect(_detachedWakeCountForTesting(), 'a follow-up accumulated per tick').toBe(1);
    // …and the later ticks did not ask for a second spawn either.
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);

    releaseWake(true);
    await _settleDetachedWakesForTesting();
    expect(_detachedWakeCountForTesting(), 'the entry did not clear when the wake settled').toBe(0);
  });

  it('a spawn this duty did not start also suppresses a second wake (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { mailbox } = makeSessionDbs();
    // Router ingress or agent-route got there first: the container is spawning,
    // so there is nothing for this duty to add.
    mockIsContainerSpawning.mockReturnValue(true);

    let woke: boolean | undefined;
    const plan = emptyPlan({ dueCount: 1, wakePriority: 'scheduled' });
    await s9b.run(
      sessionCtx(mailbox, plan, {
        reportWoke: (v: boolean) => {
          woke = v;
        },
      } as Partial<SweepSessionContext>),
    );

    expect(mockWakeContainer).not.toHaveBeenCalled();
    expect(_detachedWakeCountForTesting()).toBe(0);
    // Still justWoke, so the observe read and the quiet mark stay closed for a
    // container that is coming up.
    expect(woke).toBe(true);
  });

  it('the deferred attempt restore runs when the detached wake resolves false (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);

    let releaseWake: (woke: boolean) => void = () => undefined;
    mockWakeContainer.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWake = resolve;
        }),
    );

    const plan = emptyPlan({ continuationWakeEligible: true, workContinuation: readWorkContinuation(outDb) });
    await s9b.run(sessionCtx(mailbox, plan));

    // The attempt is consumed synchronously, before the wake — unchanged.
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);

    // The refusal arrives after the duty returned; the restore still lands.
    releaseWake(false);
    await _settleDetachedWakesForTesting();
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(0);
  });

  it('a refused deferred restore costs the tick nothing and is logged at info (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    let releaseWake: (woke: boolean) => void = () => undefined;
    mockWakeContainer.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWake = resolve;
        }),
    );

    const plan = emptyPlan({ continuationWakeEligible: true, workContinuation: readWorkContinuation(outDb) });
    await s9b.run(sessionCtx(mailbox, plan));
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);

    // The window the detach opens: 20-47 s later the wake answers "refused",
    // but by then something else has started a container, so the host may not
    // write outbound.db. `withStoppedContainerSession` answers `undefined` and
    // the restore does not run — which is correct, not a fault: the running
    // container owns the continuation record and rewrites it itself.
    mockIsContainerRunning.mockReturnValue(true);
    releaseWake(false);
    await _settleDetachedWakesForTesting();

    // No throw reached the tick, and nothing was written behind the container.
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);
    expect(
      info.mock.calls.some(
        (c) => c[0] === 'Deferred continuation-attempt restore skipped — the host may not write outbound.db',
      ),
      'a refused restore was not reported at info',
    ).toBe(true);
    info.mockRestore();
  });

  it('a deferred restore lands when no container took the session (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);

    let releaseWake: (woke: boolean) => void = () => undefined;
    mockWakeContainer.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWake = resolve;
        }),
    );

    const plan = emptyPlan({ continuationWakeEligible: true, workContinuation: readWorkContinuation(outDb) });
    await s9b.run(sessionCtx(mailbox, plan));
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);

    // The case the attempt budget exists for: the spawn was refused and NO
    // container came up, so the guard permits the write and the attempt goes
    // back for the next tick to spend.
    mockIsContainerRunning.mockReturnValue(false);
    releaseWake(false);
    await _settleDetachedWakesForTesting();

    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(0);
  });

  it('a detached wake that rejects is logged and never thrown into the tick (#359)', async () => {
    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const { outDb, mailbox } = makeSessionDbs();
    saveContinuation(outDb, CONTINUATION);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    mockWakeContainer.mockRejectedValue(new Error('spawn exploded'));

    const plan = emptyPlan({ continuationWakeEligible: true, workContinuation: readWorkContinuation(outDb) });
    // The duty itself resolves — the rejection is not its business.
    await expect(s9b.run(sessionCtx(mailbox, plan))).resolves.toBeUndefined();
    await expect(_settleDetachedWakesForTesting()).resolves.toBeUndefined();

    expect(
      warn.mock.calls.some((c) => c[0] === 'Detached container wake follow-up failed'),
      'the rejection was not logged',
    ).toBe(true);
    // The attempt stays consumed: nothing told us the wake was refused, only
    // that it failed, and inventing a restore from a rejection would hand the
    // budget back for a spawn that may well have started.
    expect(readWorkContinuation(outDb)?.resume_attempts).toBe(1);
    warn.mockRestore();
  });

  it('S15: the registered kill-ceiling notice writes from the pre-kill snapshot and only for a ceiling kill', () => {
    const s15 = killFollowUp(SWEEP_DUTY_INVENTORY.S15);
    expect(s15.order).toBe(10);

    const { outDb, mailbox } = makeNotifyTestDbs();
    const snapshot = {
      reason: 'absolute-ceiling',
      containerState: null,
      pendingClaims: 1,
      workContinuation: null,
    };
    const ctx = sessionCtx(mailbox, emptyPlan(), { killSnapshot: snapshot } as Partial<SweepSessionContext>);

    // A claim-stuck kill has never notified.
    void s15.run(
      ctx,
      { action: 'kill-claim', messageId: 'm1', claimAgeMs: 90_000, toleranceMs: CLAIM_STUCK_MS },
      mailbox,
    );
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });

    void s15.run(ctx, { action: 'kill-ceiling', heartbeatAgeMs: 32 * 60_000, ceilingMs: ABSOLUTE_CEILING_MS }, mailbox);
    const row = outDb.prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content)._system.kind).toBe('agent_restart_inactivity');

    // The gate is the SNAPSHOT's claim count, not a fresh read.
    const quiet = makeNotifyTestDbs();
    void s15.run(
      sessionCtx(quiet.mailbox, emptyPlan(), {
        killSnapshot: { ...snapshot, pendingClaims: 0 },
      } as Partial<SweepSessionContext>),
      { action: 'kill-ceiling', heartbeatAgeMs: 32 * 60_000, ceilingMs: ABSOLUTE_CEILING_MS },
      quiet.mailbox,
    );
    expect(quiet.outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('S10: the registered accountability follow-up runs only for a ceiling kill, over the snapshot', async () => {
    const s10 = killFollowUp(SWEEP_DUTY_INVENTORY.S10);
    const { inDb, mailbox } = makeSessionDbs();
    const ctx = sessionCtx(mailbox, emptyPlan(), {
      killSnapshot: {
        reason: 'absolute-ceiling',
        containerState: null,
        pendingClaims: 1,
        workContinuation: CONTINUATION,
      },
    } as Partial<SweepSessionContext>);

    await s10.run(
      ctx,
      { action: 'kill-claim', messageId: 'm1', claimAgeMs: 90_000, toleranceMs: CLAIM_STUCK_MS },
      mailbox,
    );
    expect(inDb.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'ceiling-respawn-%'").get()).toEqual({
      c: 0,
    });

    await s10.run(
      ctx,
      { action: 'kill-ceiling', heartbeatAgeMs: 35 * 60_000, ceilingMs: ABSOLUTE_CEILING_MS },
      mailbox,
    );
    const row = inDb
      .prepare("SELECT content FROM messages_in WHERE id LIKE 'ceiling-respawn-continuation-%'")
      .get() as {
      content: string;
    };
    expect(JSON.parse(row.content).text).toContain(CONTINUATION.task);
  });
});

// ── Tripwire self-check (brief-common.md HARD RULE step 3) ───────────────────
it('the child_process tripwire bites when a seam mock is removed', () => {
  const record: string[] = [];
  const tripwire = childProcessTripwire(record);
  expect(() => tripwire.execFileSync!('docker')).toThrow(/real process spawn attempted/);
  expect(record).toEqual(['execFileSync']);
});
// ─── Ownership guards on the outbound writes (mailbox seam PR 5 / 5b) ────────
describe('host outbound writes yield to a container that takes the session', () => {
  // Round 7's case, under its reserved title. The TOCTOU: opening the wake
  // window is a yield, and a concurrent inbound wake can start a container
  // inside it. Writing then pushes the continuation back to `queued`, drops the
  // fresh runner's runner_id and consumes a recovery attempt it never got —
  // saved work duplicated, parked early, or lost.
  it('a container that starts during the open leaves the continuation and its attempt count untouched', async () => {
    const { outDb, mailbox } = makeSessionDbs();
    const saved = { ...CONTINUATION, phase: 'running' as const, runner_id: 'runner-fresh', resume_attempts: 0 };
    saveContinuation(outDb, saved);
    const before = readWorkContinuation(outDb);

    const s9b = duty(SWEEP_DUTY_INVENTORY.S9b);
    const plan = emptyPlan({ workContinuation: before, continuationWakeEligible: true });
    // The wake landed: by the time the window is open, a container owns this
    // session and its outbound.db.
    mockIsContainerRunning.mockReturnValue(true);

    await s9b.run(sessionCtx(mailbox, plan));

    // No attempt consumed, no wake issued, and the record is byte-for-byte what
    // the fresh runner left.
    expect(mockWakeContainer).not.toHaveBeenCalled();
    expect(readWorkContinuation(outDb)).toEqual(before);
  });

  // Round 8 + Codex's follow-on: a single guard at the top of the post-kill
  // window is NOT sufficient. `runSweepKillFollowUps` awaits after every
  // registered follow-up, so ownership can flip at a microtask boundary between
  // them — after S15's notice, before S17's reset and before S10's wake row.
  it('a wake that takes ownership between post-kill follow-ups stops the later follow-ups from writing', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    // notifyKillCeiling posts only when a user WAS waiting (pendingClaims > 0)
    // and only when it knows where to post, so both preconditions are set here.
    inDb.prepare('INSERT INTO session_routing VALUES (1, ?, ?, ?)').run('slack', 'C-1', 'T-1');
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-live', 'processing', ?)")
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    const claims = (): number => (outDb.prepare('SELECT COUNT(*) AS c FROM processing_ack').get() as { c: number }).c;
    const notices = (): number => (outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;

    const ctx = sessionCtx(mailbox, emptyPlan(), {
      killSnapshot: { reason: 'absolute-ceiling', pendingClaims: 1, containerState: null, workContinuation: null },
    });
    const outcome = {
      action: 'kill-ceiling' as const,
      heartbeatAgeMs: ABSOLUTE_CEILING_MS + 1,
      ceilingMs: ABSOLUTE_CEILING_MS,
    };

    // Stopped for S15's notice, then a replacement takes the session in the
    // await between follow-ups — exactly the boundary the window guard misses.
    mockIsContainerRunning.mockReturnValue(false);
    await killFollowUp(SWEEP_DUTY_INVENTORY.S15).run(ctx, outcome, mailbox);
    const noticesAfterS15 = notices();
    const claimsBefore = claims();

    mockIsContainerRunning.mockReturnValue(true);
    await killFollowUp(SWEEP_DUTY_INVENTORY.S10).run(ctx, outcome, mailbox);

    // S15 wrote while stopped; S10 did not write after ownership flipped, and
    // the fresh runner's claim survives for S17 to leave alone as well.
    expect(noticesAfterS15).toBe(1);
    expect(claims()).toBe(claimsBefore);
    expect(notices()).toBe(noticesAfterS15);
  });
});
