/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * Also contains C3 watchdog integration tests.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getProcessingClaims,
  type ContainerState,
} from './modules/mailbox/ops/sweep.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from './modules/mailbox/index.js';
import { getAgentMailbox } from './mailbox/index.js';
import { withExistingNanoclawSession } from './modules/mailbox/session.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  CONTINUATION_WAKE_MIN_INTERVAL_MS,
  SPAWN_GRACE_MS,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  _applyCeilingFollowUpForTesting,
  _hasWorkContinuationForTesting,
  _notifyKillCeilingForTesting,
  _prepareDueWakeForTesting,
  _resetStuckProcessingRowsForTesting,
  _resetSweepRegistryForTesting,
  registerSweepKillFollowUp,
  _incrementStoppedContinuationAttemptForTesting,
  _sweepSessionForTesting,
  canAttemptContinuationRecovery,
  countToolRecoveryAttemptsSinceRealInbound,
  decideCeilingFollowUp,
  decideContinuationWake,
  hasDueRecoveryWake,
  parseSqliteUtc,
  parkDueRecoveryWakes,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  notifyContinuationParked,
  shouldCloseTaskSession,
} from './host-sweep.js';
// S14 (the running-container SLA) and both post-kill write paths moved to the
// container-health family in S2-PR10; its test-only entry point moved with the
// body. These SLA cases are mailbox seam PR 5b's and B1's, and they still drive
// the same duty through the same registry.
import { _enforceRunningContainerSlaForTesting } from './modules/sweep-container-health/index.js';
// T19 (the usage rollup) moved to the sweep-usage family in S2-PR12, and the
// module exports its body directly. The two cases below are mailbox seam
// PR 6's (Codex P2, the hot-journal durability options): they exercise the
// REAL read funnel against real SQLite files and create a genuine hot journal
// with a killed child process, neither of which the family's own suite can do
// — it mocks `readSessionOutbound` and arms a `child_process` tripwire. So the
// cases stay on this file's fixture and reach across for the moved body, the
// same way the SLA cases above do.
import { sweepUsageRollup as _sweepUsageRollupForTesting } from './modules/sweep-usage/index.js';
import { getDb } from './db/connection.js';
import type { Session } from './types.js';

// ─── Module mocks for C3 watchdog integration tests ──────────────────────────
// These mocks are hoisted and only affect tests that use them. The existing
// decideStuckAction / resetStuckProcessingRows tests are pure and don't invoke
// these imports, so they are unaffected.

// Shadow-mode flag. host-sweep captures SELF_HEAL_ENABLED as a module-level
// const, so the mock exposes it as a getter over a mutable box that individual
// tests flip via armSelfHeal().
const selfHeal = vi.hoisted(() => ({ enabled: false }));
// DATA_DIR is redirected at a per-run temp root so anything in this file that
// resolves a session path (the mailbox seam's `sessionMailboxPath`, heartbeats,
// `sessionsBaseDir`) can never reach the real install's data directory.
const testDataDir = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'host-sweep-data-')) };
});
vi.mock('./config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./config.js')>();
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
const mockReadContainerConfig = vi.fn();
const mockMarkProviderUnavailable = vi.fn();

vi.mock('./container-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-config.js')>();
  return {
    ...real,
    readContainerConfig: (...args: unknown[]) => mockReadContainerConfig(...args),
  };
});

vi.mock('./db/provider-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/provider-health.js')>();
  return {
    ...real,
    markProviderUnavailable: (...args: unknown[]) => mockMarkProviderUnavailable(...args),
  };
});

const mockAdmitDueTaskContexts = vi.fn().mockReturnValue(0);
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockHasContainerEverRun = vi.fn();
const mockGetSession = vi.fn();

vi.mock('./session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
    outboundDbPath: real.outboundDbPath,
  };
});

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (it now has a second caller, thread-close's finalizer). Composed here from
    // the MOCKED running check plus the real spawning one, which is exactly what
    // the host-sweep-local version did under this mock — spreading `...real`
    // alone would silently bypass `mockIsContainerRunning`.
    containerOwnsOutbound: (sessionId: string) =>
      Boolean(mockIsContainerRunning(sessionId)) || real.isContainerSpawning(sessionId),
    hasContainerEverRun: (...args: unknown[]) => mockHasContainerEverRun(...args),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
    killContainer: (...args: unknown[]) => mockKillContainer(...args),
  };
});

vi.mock('./db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/sessions.js')>();
  return {
    ...real,
    getSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

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

// ─── Class 1: failed-provider self-heal ──────────────────────────────────────

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
    const { inDb, outDb, mailbox } = makeSessionDbs();
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

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

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
    CREATE TABLE messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
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

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('scheduled due admission precedes wake classification', () => {
  it('counts and classifies the trigger inserted by the admission seam', async () => {
    const { inDb, mailbox } = makeSessionDbs();
    // The sweep hands `admitDueTaskContexts` the SESSION now, not a handle
    // (invariant I-9). The stub writes the admitted trigger straight into the
    // fixture DB behind that session, which is what the assertions below read.
    mockAdmitDueTaskContexts.mockImplementationOnce(() => {
      inDb
        .prepare(
          `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, content)
         VALUES ('task-admitted', 2, 'task', ?, 'pending', ?, NULL, 'task-admitted', 1, '{}')`,
        )
        .run(new Date().toISOString(), new Date(Date.now() - 1_000).toISOString());
      return 1;
    });

    const result = await _prepareDueWakeForTesting(mailbox, 'ag-test', 'sess-test');

    expect(mockAdmitDueTaskContexts).toHaveBeenCalledWith(mailbox, 'ag-test', 'sess-test');
    expect(result).toEqual({ admittedTasks: 1, dueCount: 1, wakePriority: 'scheduled' });
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(mailbox, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('makes a paired crashed turn inert with its recall until fresh due admission', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, tries, trigger, content)
         VALUES ('recall-m-paired', 2, 'system', ?, 'pending', ?, 0, 0, ?),
                ('m-paired', 4, 'chat', ?, 'pending', ?, 0, 1, ?)`,
      )
      .run(
        claimedAt,
        claimedAt,
        JSON.stringify({ subtype: 'recall_context', revision: 'before-crash' }),
        claimedAt,
        claimedAt,
        JSON.stringify({ text: 'retry me' }),
      );
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-paired', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(mailbox, fakeSession(), 'container-crash');

    const pair = inDb.prepare('SELECT id, trigger, tries, process_after FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      tries: number;
      process_after: string | null;
    }>;
    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({ id: 'recall-m-paired', trigger: 0, tries: 0 });
    expect(pair[1]).toMatchObject({ id: 'm-paired', trigger: 0, tries: 1 });
    expect(pair[0]!.process_after).not.toBeNull();
    expect(pair[0]!.process_after).toBe(pair[1]!.process_after);
    expect(
      (
        inDb
          .prepare(
            `SELECT COUNT(*) AS count
               FROM messages_in
              WHERE status = 'pending' AND trigger = 1
                AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(mailbox, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });

  it('retries an input that produced only progress/status rows', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-status-only', 3, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-status-only', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('progress-1', 2, 'm-status-only', ?, 'status', '{}')",
      )
      .run(new Date().toISOString());

    _resetStuckProcessingRowsForTesting(mailbox, fakeSession(), 'absolute-ceiling');

    const row = inDb
      .prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?')
      .get('m-status-only') as { status: string; tries: number; process_after: string | null };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('does not retry an input after a non-status response was written', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-answered', 4, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-answered', 'processing', ?)").run(claimedAt);
    outDb
      .prepare(
        "INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content) VALUES ('reply-1', 4, 'm-answered', ?, 'chat', '{}')",
      )
      .run(new Date().toISOString());

    _resetStuckProcessingRowsForTesting(mailbox, fakeSession(), 'absolute-ceiling');

    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-answered') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('completed');
    expect(row.tries).toBe(0);
    expect(row.process_after).toBeNull();
    expect(getProcessingClaims(outDb)).toEqual([]);
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// kill-ceiling notify (Layer-3 fix)
//
// Background: host-sweep used to silently reap a stale-heartbeat container
// after ABSOLUTE_CEILING_MS (30 min). Users waiting on a wedged agent saw
// nothing for the entire window, then the container came back as if
// nothing happened. `notifyKillCeiling` writes a chat outbound on the
// session's primary route before kill, so the user gets a "resend please"
// signal within a sweep tick of the heartbeat going stale.
// ─────────────────────────────────────────────────────────────────────────────

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

describe('notifyKillCeiling (Layer-3 fix)', () => {
  // `pendingClaims=1` means the container had an in-flight inbound when we
  // killed it — i.e. a user was actually waiting. That's the only case
  // where the notify should fire (see the spam-gate test below for the
  // claims=0 case).
  it('writes a visible chat outbound with the session route before killContainer', () => {
    const { inDb, outDb, mailbox } = makeNotifyTestDbs();
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
    const { inDb, outDb, mailbox } = makeNotifyTestDbs();
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
    const { inDb, outDb, mailbox } = makeNotifyTestDbs();
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 0);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('skips when the session has never been routed (fresh session_routing row missing)', () => {
    const { inDb, outDb, mailbox } = makeNotifyTestDbs({ withRouting: false });
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 1);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('is idempotent within 60s — a re-firing sweep tick does not duplicate the notice', () => {
    const { inDb, outDb, mailbox } = makeNotifyTestDbs({ recentNotice: true });
    _notifyKillCeilingForTesting(mailbox, fakeSession(), 32 * 60_000, 1);
    // Only the seed row should be present; the second call recognized the
    // marker and skipped.
    const rows = outDb.prepare('SELECT id FROM messages_out').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('prior');
  });
});


describe('shouldCloseTaskSession', () => {
  it('closes a spent per-task session (no live tasks, no container)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 0)).toBe(true);
  });

  it('keeps it while a task is still live (recurring re-armed, or pending/paused)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', false, 1)).toBe(false);
  });

  it('keeps it while its container is running (mid-fire)', () => {
    expect(shouldCloseTaskSession('system:tasks:task-1', true, 0)).toBe(false);
  });

  it('never touches non-task sessions', () => {
    expect(shouldCloseTaskSession('telegram:12345', false, 0)).toBe(false);
    expect(shouldCloseTaskSession(null, false, 0)).toBe(false);
  });
});

// shouldReapIdleTaskContainer / shouldReapIdleChatContainer cases moved to
// src/modules/sweep-idle-reap/idle-reap.test.ts (seam 2, S2-PR3 — F-3.1).

// shouldSkipUsageRollup moved to src/modules/sweep-usage/usage.test.ts (S2-PR12, F-12.1).

describe('sweepUsageRollup over a hot journal', () => {
  // Codex P2 (thread PRRT_kwDORfvfVM6fEn3q): the rollup's readSessionOutbound
  // call used the read-only wrapper's defaults (`recoverJournal: false`, 1s
  // busy_timeout — the console fleet-fan-out's, not a single named session's)
  // where the replaced `openOutboundDb` path always recovered a hot journal
  // and waited 5s. An ACTIVE session that keeps outbound.db but lost
  // inbound.db (or simply crashed mid-write and left a hot rollback journal
  // behind) then throws on every tick instead of reading — the watermark
  // never advances and those turn_usage rows never reach the central ledger.
  //
  // A hand-written junk `-journal` file will NOT reproduce this: SQLite
  // validates the journal header and silently ignores an invalid one. This
  // creates a GENUINE hot journal by killing a child process mid-transaction
  // (same technique as `db/session-db.test.ts`'s hot-journal-recovery cases).
  it('reads turn_usage and advances the watermark over a REAL hot journal with no inbound.db', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-usage-hot', 'usage hot', 'usage-hot', ?)`,
    ).run(new Date().toISOString());

    const session: Session = { ...fakeSession(), id: 'sess-usage-hot', agent_group_id: 'ag-usage-hot' };
    const dir = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'outbound.db');
    // Deliberately no inbound.db: the exact cohort the fix names — a session
    // whose inbound.db is gone (or was never woken) while outbound.db and its
    // turn_usage rows remain.

    const seed = new Database(dbPath);
    seed.pragma('journal_mode = DELETE');
    seed.exec(`
      CREATE TABLE turn_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL
      )
    `);
    seed
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, 'claude', 'sonnet', 100, 50, 0, 0, 0.01)`,
      )
      .run(new Date().toISOString());
    seed.close();

    const child = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = DELETE');
      db.prepare('BEGIN EXCLUSIVE').run();
      db.prepare(
        "INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, 'claude', 'sonnet', 1, 1, 0, 0, 0)",
      ).run(new Date().toISOString());
      process.kill(process.pid, 'SIGKILL');
    `;
    spawnSync(process.execPath, ['-e', child], { cwd: process.cwd() });

    if (!fs.existsSync(`${dbPath}-journal`)) {
      // Couldn't reproduce the crash residue on this platform — skip rather
      // than assert something we didn't actually set up.
      closeDb();
      return;
    }

    // Confirm the precondition is REAL: a genuinely hot journal makes a bare
    // read-only read fail. If the child's crash didn't leave one (timing or
    // platform dependent), skip rather than assert on a condition never
    // actually established.
    let reproduced = false;
    try {
      const ro = new Database(dbPath, { readonly: true });
      ro.prepare('SELECT id FROM turn_usage').all();
      ro.close();
    } catch (err) {
      reproduced = /readonly database/.test((err as Error).message);
    }
    if (!reproduced) {
      closeDb();
      return;
    }

    await _sweepUsageRollupForTesting([session]);

    // The fix: readSessionOutbound recovers the journal before reading, so
    // the row that was already committed lands in the central ledger and the
    // watermark advances. Without it (default recoverJournal: false, 1s
    // timeout), the read throws, `sweepUsageRollup`'s per-session catch
    // swallows it, and this table stays empty forever.
    const rows = getDb().prepare('SELECT provider, model FROM turn_usage WHERE session_id = ?').all(session.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);
    closeDb();
  });

  // The deterministic sibling of the case above — `passes the write path
  // options (recoverJournal, 5s busy_timeout) to readSessionOutbound` — moved
  // to src/modules/sweep-usage/usage.test.ts with the T19 body (S2-PR12),
  // where it drives the registered duty instead of a driver hook.
  //
  // The hot-journal case above could not follow it. That suite mocks
  // `readSessionOutbound` (the very seam this asserts through) and arms a
  // `child_process` tripwire, and this case needs the REAL funnel plus a
  // killed child process to leave a genuine hot journal behind. It stays on
  // this file's fixture and reaches across for the moved body, the same way
  // the S14 SLA cases above do.
});

// ─────────────────────────────────────────────────────────────────────────────
// Container OOM notices — detection already worked; these cover the half that
// puts it where the AGENT can read it, without waking anything.
// ─────────────────────────────────────────────────────────────────────────────

// ─── H-10 (mailbox seam §8): reads never provision ───────────────────────────
describe('sweepSession on a session with no mailbox', () => {
  it('sweep treats a missing mailbox as no-op via withExistingMailboxSession', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-nomailbox', 'no mailbox', 'no-mailbox', ?)`,
    ).run(new Date().toISOString());
    mockWakeContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    mockHasContainerEverRun.mockReset().mockReturnValue(false);

    const session: Session = { ...fakeSession(), id: 'sess-nomailbox', agent_group_id: 'ag-nomailbox' };
    const sessionPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id);
    expect(fs.existsSync(sessionPath)).toBe(false);

    await expect(_sweepSessionForTesting(session)).resolves.not.toThrow();

    // I-4: a read path never provisions. Nothing was created, and no container
    // was woken for a session the host cannot even read.
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(fs.existsSync(path.join(sessionPath, 'inbound.db'))).toBe(false);
    expect(mockWakeContainer).not.toHaveBeenCalled();
    closeDb();
  });

  // Round 8. The same TOCTOU class, on the two post-kill write paths that round
  // 7's audit claimed but did not actually land. `killContainer` is itself a
  // yield: the session below opens after it, and a replacement wake in that gap
  // owns outbound.db. Writing anyway deletes the FRESH runner's processing claim
  // and defers an input it is already working — duplicate execution.
  function slaFixture(id: string, heartbeatAgeMs: number, claimAgeMs: number) {
    const session: Session = { ...fakeSession(), id, agent_group_id: 'ag-sla' };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const dir = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id);
    const now = Date.now();
    fs.writeFileSync(path.join(dir, '.heartbeat'), '');
    fs.utimesSync(path.join(dir, '.heartbeat'), new Date(now - heartbeatAgeMs), new Date(now - heartbeatAgeMs));
    const out = new Database(path.join(dir, 'outbound.db'));
    out
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m-live', 'processing', ?)")
      .run(new Date(now - claimAgeMs).toISOString());
    out.close();
    const claims = (): number => {
      const db = new Database(path.join(dir, 'outbound.db'));
      const n = (db.prepare('SELECT COUNT(*) AS c FROM processing_ack').get() as { c: number }).c;
      const outRows = (db.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
      db.close();
      return n * 100 + outRows;
    };
    const run = (<T>(action: (m: never) => T | Promise<T>) =>
      withExistingNanoclawSession(session.agent_group_id, session.id, action as never)) as never;
    return { session, claims, run };
  }

  it('a replacement container that wakes during the post-kill open keeps its claim (ceiling)', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    mockKillContainer.mockReset();
    // Live all the way through: the container is alive so the SLA runs, and it
    // is STILL alive after the kill because a wake replaced it in the gap.
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    const f = slaFixture('sess-sla-ceiling', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');

    expect(mockKillContainer).toHaveBeenCalledWith('sess-sla-ceiling', 'absolute-ceiling');
    // Claim intact and no restart notice written: both writes were skipped.
    expect(f.claims()).toBe(before);
    closeDb();
  });

  it('a replacement container that wakes during the post-kill open gets no stale ceiling wake', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    const f = slaFixture('sess-sla-followup', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    // A resumable continuation is what makes decideCeilingFollowUp actually
    // WRITE. Without one it returns { action: 'none' } and the test would pass
    // whichever side of the guard the follow-up sits on.
    const outPath = path.join(testDataDir.dir, 'v2-sessions', 'ag-sla', 'sess-sla-followup', 'outbound.db');
    const plant = new Database(outPath);
    plant
      .prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(
        JSON.stringify({
          id: 'cont-followup',
          task: 'resume the migration',
          phase: 'running',
          chain: 0,
          resume_attempts: 0,
          recovery_episode: 0,
        }),
        new Date().toISOString(),
      );
    plant.close();

    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');

    // The accountability row is inbound, so no single-writer hazard — but it is
    // `on_wake = 1`, which the live replacement never consumes. Writing it here
    // would greet the NEXT fresh container with a stale "your previous
    // container was killed" notice and burn one of that class's recovery
    // attempts. The pre-refactor early return skipped it; so must the guard.
    const inbound = new Database(
      path.join(testDataDir.dir, 'v2-sessions', 'ag-sla', 'sess-sla-followup', 'inbound.db'),
    );
    const respawns = (
      inbound.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'ceiling-respawn-%'").get() as {
        c: number;
      }
    ).c;
    inbound.close();
    expect(respawns).toBe(0);
    closeDb();
  });

  it('a replacement container that wakes during the post-kill open keeps its claim (claim-stuck)', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    // Heartbeat older than the claim and inside the ceiling: kill-claim, not kill-ceiling.
    const f = slaFixture('sess-sla-claim', 10 * 60_000, 5 * 60_000);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');

    expect(mockKillContainer).toHaveBeenCalledWith('sess-sla-claim', 'claim-stuck');
    expect(f.claims()).toBe(before);
    closeDb();
  });

  // Codex round 9, on the seam-2 duty registry. Upstream guards the post-kill
  // window with ONE `writeOutboundWhenStopped` around all three follow-ups,
  // which is sound there because they are a single synchronous block. PR 2
  // runs them as SEPARATE awaited duties, so a single check authorizes writes
  // that happen two yields later: S15 writes the notice, the loop awaits, a
  // replacement wake takes outbound.db, and S17 then deletes the FRESH
  // runner's processing claim (duplicate execution) while S10 queues a stale
  // accountability wake against its recovery cap. Each follow-up therefore
  // guards its own write. The first half of this case is the control that
  // proves the second half is not vacuous.
  it('a wake that takes ownership between post-kill follow-ups stops the later follow-ups from writing', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    const sessionDir = (session: Session): string =>
      path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id);
    // A live continuation is what makes S10 (the accountability wake) write at
    // all — without one `decideCeilingFollowUp` returns 'none' and the S10 half
    // of the assertion would pass for the wrong reason.
    const plantContinuation = (session: Session): void => {
      const out = new Database(path.join(sessionDir(session), 'outbound.db'));
      out
        .prepare(
          `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(
          JSON.stringify({
            id: 'cont-followups',
            task: 'finish the migration',
            phase: 'running',
            chain: 0,
            runner_id: 'runner-old',
            resume_attempts: 0,
            recovery_episode: 0,
          }),
          new Date().toISOString(),
        );
      out.close();
    };
    const respawnWakes = (session: Session): number => {
      const inbound = new Database(path.join(sessionDir(session), 'inbound.db'));
      const n = (
        inbound.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'ceiling-respawn-%'").get() as {
          c: number;
        }
      ).c;
      inbound.close();
      return n;
    };

    // Control: ownership never flips, so every follow-up writes.
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    const control = slaFixture('sess-followups-control', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    plantContinuation(control.session);
    await _enforceRunningContainerSlaForTesting(control.run, control.session, 'ag-sla', 'sla');

    expect(mockKillContainer).toHaveBeenCalledWith('sess-followups-control', 'absolute-ceiling');
    expect(control.claims()).toBe(0); // S17 cleared the orphan claim
    expect(respawnWakes(control.session)).toBe(1); // S10 queued the accountability wake

    // Guarded: a wake takes the session between S15 (order 10) and S17 (order
    // 20) — registered as a follow-up at order 15, which is exactly the yield
    // boundary the loop's `await` creates.
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    registerSweepKillFollowUp({
      name: 'test:wake-between-post-kill-follow-ups',
      order: 15,
      run: () => {
        mockIsContainerRunning.mockReturnValue(true);
      },
    });
    try {
      const guarded = slaFixture('sess-followups-guarded', ABSOLUTE_CEILING_MS + 60_000, 10_000);
      plantContinuation(guarded.session);
      const claimsBefore = guarded.claims();
      await _enforceRunningContainerSlaForTesting(guarded.run, guarded.session, 'ag-sla', 'sla');

      expect(mockKillContainer).toHaveBeenCalledWith('sess-followups-guarded', 'absolute-ceiling');
      // Both later follow-ups skipped: the fresh runner keeps its claim and no
      // stale accountability wake was queued against its recovery cap.
      expect(guarded.claims()).toBe(claimsBefore);
      expect(respawnWakes(guarded.session)).toBe(0);
    } finally {
      _resetSweepRegistryForTesting();
    }
    closeDb();
  });

  // Round 7 (TOCTOU). Opening a mailbox session is a yield, and a concurrent
  // inbound wake can start a container inside it. Pre-seam this was a
  // synchronous check-then-write on an already-open handle, so no such gap
  // existed. If the container-state check stays outside, the helper writes the
  // container-owned outbound.db underneath a fresh runner: the continuation
  // goes back to `queued`, its runner_id is dropped, and a recovery attempt the
  // new runner never got is consumed — saved work duplicated, parked early, or
  // lost. This is continue_work's recovery path.
  it('a container that starts during the open leaves the continuation and its attempt count untouched', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-toctou', 'toctou', 'toctou', ?)`,
    ).run(new Date().toISOString());

    const session: Session = { ...fakeSession(), id: 'sess-toctou', agent_group_id: 'ag-toctou' };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    const saved = {
      id: 'cont-toctou',
      task: 'finish the migration',
      phase: 'running' as const,
      chain: 0,
      runner_id: 'runner-fresh',
      resume_attempts: 0,
      recovery_episode: 0,
    };
    const planted = new Database(outboundPath);
    planted
      .prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(saved), new Date().toISOString());
    planted.close();

    // The wake landed: by the time the mailbox is open, a container owns this
    // session and its outbound.db.
    mockIsContainerRunning.mockReset().mockReturnValue(true);

    const result = await _incrementStoppedContinuationAttemptForTesting(session, saved.id);

    // No attempt consumed, and nothing handed back to wake on.
    expect(result).toBeNull();
    // The fresh runner's record is byte-for-byte what it was.
    const after = new Database(outboundPath);
    const row = after.prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() as {
      value: string;
    };
    after.close();
    expect(JSON.parse(row.value)).toEqual(saved);
    closeDb();
  });

  // Round 4: the outbound handle opens LAZILY, after the duties have started,
  // so `enteredPlanSession` is already true when it fails. The error class, not
  // the position, has to decide — otherwise a present-but-unreadable
  // outbound.db is retried and logged every 60s instead of backing off, which
  // is the repeated-error load the backoff exists to contain.
  it('an unreadable outbound.db takes the mailbox backoff, not the per-tick duty retry', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-badout', 'bad outbound', 'bad-outbound', ?)`,
    ).run(new Date().toISOString());
    mockWakeContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    mockHasContainerEverRun.mockReset().mockReturnValue(false);
    mockAdmitDueTaskContexts.mockReturnValue(0);

    const session: Session = { ...fakeSession(), id: 'sess-badout', agent_group_id: 'ag-badout' };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    // Present, non-empty, and not a database — exactly what a corrupt file or a
    // failed hot-journal recovery leaves behind. The inbound side stays fine,
    // so the failure can only surface from the lazy outbound open mid-duty.
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    fs.writeFileSync(outboundPath, 'not a sqlite database at all');

    // Backoff, not a throw: a rethrow here is the per-tick retry this pins against.
    await expect(_sweepSessionForTesting(session)).resolves.toEqual(expect.any(Number));
    closeDb();
  });

  /**
   * The wake must be handed the session row as it is NOW, not the tick's
   * snapshot.
   *
   * `sessions` is read once per tick by `getActiveSessions()`, before a serial
   * per-session loop that awaits container spawns, so the object reaching this
   * duty can be many seconds old. The storage worker the same tick starts
   * closes rows with `UPDATE sessions SET status = 'archiving' … WHERE status =
   * 'active'`. `wakeContainer`'s only liveness gate reads `status` off the
   * object it is given, so a stale one defeats it and spawns a container
   * `getActiveSessions()` will never return — no stuck detection, no heartbeat
   * ceiling, no claim tolerance, for as long as it runs.
   */
  it('hands the wake the current session row, not the tick snapshot', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-stale', 'stale snapshot', 'stale-snapshot', ?)`,
    ).run(new Date().toISOString());
    mockWakeContainer.mockReset().mockResolvedValue(true);
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    mockHasContainerEverRun.mockReset().mockReturnValue(false);
    mockAdmitDueTaskContexts.mockReturnValue(0);

    const snapshot: Session = { ...fakeSession(), id: 'sess-stale', agent_group_id: 'ag-stale', status: 'active' };
    getAgentMailbox().prepare({ agentGroupId: snapshot.agent_group_id, sessionId: snapshot.id });
    const inboundPath = path.join(testDataDir.dir, 'v2-sessions', snapshot.agent_group_id, snapshot.id, 'inbound.db');
    const inDb = new Database(inboundPath);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('due-1', 2, 'chat', ?, 'pending', 1, ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ text: 'hello', senderId: 'U1' }));
    inDb.close();

    // The row was closed by the reclaim after the tick's snapshot was taken.
    mockGetSession.mockReset().mockReturnValue({ ...snapshot, status: 'closed' });

    await _sweepSessionForTesting(snapshot);

    // The liveness proof now travels WITH the wake instead of preceding it: a
    // re-read here proves the row live before the call, and the call then
    // awaits admission, an unbounded memory-queue wait and the whole spawn
    // preparation. The guard is asked where the process is created.
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    const { guard } = mockWakeContainer.mock.calls[0][2] as { guard: () => unknown };
    expect(guard()).toEqual({ ok: false, reason: 'session is closed' });
    closeDb();
  });

  // Round 2: the backoff belongs to an unopenable mailbox, never to a duty
  // that threw. A transient SQLite lock during admission must retry on the
  // next 60s tick — quiet-caching it would hold an already-due scheduled task
  // for the full 30 minutes, and `last_active` does not move on failure, so
  // nothing would clear it early.
  it('a duty that throws propagates for the next-tick retry instead of being quiet-cached', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-dutythrow', 'duty throw', 'duty-throw', ?)`,
    ).run(new Date().toISOString());
    mockWakeContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    mockHasContainerEverRun.mockReset().mockReturnValue(false);

    const session: Session = { ...fakeSession(), id: 'sess-dutythrow', agent_group_id: 'ag-dutythrow' };
    // A real mailbox, so the open succeeds and only the DUTY fails.
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    mockAdmitDueTaskContexts.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    await expect(_sweepSessionForTesting(session)).rejects.toThrow('database is locked');

    // Contrast: the same catch DOES back off when the mailbox itself is the
    // problem, which is the case the 30-minute quiet marker exists for.
    mockAdmitDueTaskContexts.mockReturnValue(0);
    const gone: Session = { ...fakeSession(), id: 'sess-dutythrow-gone', agent_group_id: 'ag-dutythrow' };
    await expect(_sweepSessionForTesting(gone)).resolves.toEqual(expect.any(Number));
    closeDb();
  });
});
