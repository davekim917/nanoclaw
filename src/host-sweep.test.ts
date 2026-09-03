/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * Also contains C3 watchdog integration tests.
 */
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
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  CONTINUATION_WAKE_MIN_INTERVAL_MS,
  SESSION_ARTIFACT_IDLE_MS,
  SPAWN_GRACE_MS,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  PROVIDER_HEAL_COOLDOWN_MS,
  PROVIDER_HEAL_MAX_ATTEMPTS,
  _applyCeilingFollowUpForTesting,
  _hasWorkContinuationForTesting,
  _resetProviderHealTicksForTesting,
  _sweepProviderHealForTesting,
  countProviderHealAttemptsSinceRealInbound,
  decideProviderHeal,
  notifyProviderHealParked,
  observeProviderStatus,
  _notifyKillCeilingForTesting,
  _reportContainerOomTelemetryForTesting,
  _prepareDueWakeForTesting,
  _resetStuckProcessingRowsForTesting,
  _sweepSessionForTesting,
  _sweepTaskWatchdogForTesting,
  autoArchiveOldCompleted,
  canAttemptContinuationRecovery,
  countToolRecoveryAttemptsSinceRealInbound,
  decideCeilingFollowUp,
  decideContinuationWake,
  decideStuckAction,
  hasDueRecoveryWake,
  parseSqliteUtc,
  parkDueRecoveryWakes,
  pruneIdleSessionArtifacts,
  pruneIdleThreadArtifacts,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  notifyContinuationParked,
  shouldCloseTaskSession,
  shouldSkipUsageRollup,
} from './host-sweep.js';
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

const mockGetActiveTasks = vi.fn();
const mockTransitionToTerminal = vi.fn();
const mockGetCapabilityConfig = vi.fn();
const mockPendingTerminalDispatchOutboundSeenAt = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockAdmitDueTaskContexts = vi.fn().mockReturnValue(0);
const mockWakeContainer = vi.fn();
const mockIsContainerRunning = vi.fn();
const mockHasContainerEverRun = vi.fn();
const mockGetSession = vi.fn();
const mockRunReconcilerSweep = vi.fn();

vi.mock('./modules/orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: (...args: unknown[]) => mockGetActiveTasks(...args),
    transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
    getOrphanedTasks: vi.fn().mockReturnValue([]),
  };
});

vi.mock('./modules/orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: (...args: unknown[]) => mockGetCapabilityConfig(...args),
}));

vi.mock('./modules/orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalSpawnOutboundSeenAt: (...args: unknown[]) => mockPendingTerminalDispatchOutboundSeenAt(...args),
  };
});

vi.mock('./session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
    writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
    outboundDbPath: real.outboundDbPath,
  };
});

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
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

vi.mock('./modules/orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => mockRunReconcilerSweep(),
  runReconcilerOnStartup: vi.fn(),
}));

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('extends the ceiling while a native Codex item is in flight', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // Native Codex subagents can legitimately run past the default
      // 30-minute ceiling without emitting app-server notifications.
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-codex', 45 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('keeps the native Codex extension bounded by its declared timeout', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - oneHrMs - 1,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - oneHrMs - 1).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance while a native Codex item is in flight', () => {
    const oneHrMs = 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 6 * 60 * 1000,
      containerState: {
        current_tool: 'CodexItem',
        tool_declared_timeout_ms: oneHrMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-codex', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill a fresh container for a claim made before it spawned', () => {
    // Pre-existing claim from a long-dead prior container; new one just
    // spawned and hasn't reached its agent-runner startup cleanup hook
    // yet. Without the grace window, every recovery attempt would be
    // killed within ms of spawn — the deadlock that stranded the
    // plugin-updater session for 4 days post-cutover.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // fresh container, no heartbeat yet
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - 10_000, // spawned 10s ago, well within grace
    });
    expect(res.action).toBe('ok');
  });

  it('still kills for a fresh-container claim that aged past tolerance during the grace window', () => {
    // Claim was made AFTER spawn (so it's the current container's own work)
    // and has aged past tolerance with no heartbeat. The grace window only
    // covers pre-existing claims, not new ones produced by the live
    // container — those still need to be enforced normally.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const spawnedAtMs = BASE - claimedAgeMs - 1_000; // spawn predates the claim
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
      spawnedAtMs,
    });
    expect(res.action).toBe('kill-claim');
  });

  it('kills for a pre-existing claim once the grace window has elapsed', () => {
    // Container spawned > SPAWN_GRACE_MS ago and the stale claim is still
    // there — startup cleanup either failed to run or didn't cover this
    // row. After the grace window, the kill path runs as before so a
    // permanently-broken container can't camp on a session forever.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000,
    });
    expect(res.action).toBe('kill-claim');
  });

  it('does not kill-ceiling when stale heartbeat predates spawn and we are in grace', () => {
    // Heartbeat on disk is from a long-dead prior container instance; the
    // fresh container has only been alive for 10s and hasn't touched the
    // heartbeat file yet. Without this protection, a host restart would
    // SIGKILL every freshly-spawned container whose previous heartbeat was
    // already past the ceiling — the exact respawn loop seen in the
    // 2026-05-15 incident.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS, // 1h stale
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 10_000, // 10s ago
    });
    expect(res.action).toBe('ok');
  });

  it('does kill-ceiling once spawn-grace has elapsed without a fresh heartbeat', () => {
    // Container has been alive long enough that the agent-runner should
    // have written its first heartbeat. Still seeing prior-container's
    // stale mtime → kill is the right call (the new container is wedged).
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS,
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000, // past grace
    });
    expect(res.action).toBe('kill-ceiling');
  });

  it('does kill-ceiling when heartbeat predates spawn but ages past ceiling AFTER spawn', () => {
    // Pathological: heartbeat is newer than spawn (so it's the current
    // container's own write), but it's still > 30 min old. That means the
    // current container has gone genuinely silent for the full ceiling
    // window — kill is correct.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 35 * 60 * 1000, // 35 min ago
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 40 * 60 * 1000, // spawned before the heartbeat
    });
    expect(res.action).toBe('kill-ceiling');
  });
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

describe('decideProviderHeal', () => {
  const base = {
    alive: true,
    providerStatus: 'failed' as string | null,
    consecutiveFailedTicks: 2,
    priorAttempts: 0,
    msSinceLastAttempt: null as number | null,
  };

  it('ignores containers that are not alive', () => {
    expect(decideProviderHeal({ ...base, alive: false })).toBe('none');
  });

  it('ignores every provider status other than failed', () => {
    for (const providerStatus of ['active', 'healthy', 'idle', 'suspect', 'recovering', null, undefined]) {
      expect(decideProviderHeal({ ...base, providerStatus })).toBe('none');
    }
  });

  it('waits on the first failed tick and acts on the second', () => {
    expect(decideProviderHeal({ ...base, consecutiveFailedTicks: 1 })).toBe('wait');
    expect(decideProviderHeal({ ...base, consecutiveFailedTicks: 2 })).toBe('heal');
  });

  it('waits inside the cooldown and heals once it elapses', () => {
    expect(decideProviderHeal({ ...base, priorAttempts: 1, msSinceLastAttempt: PROVIDER_HEAL_COOLDOWN_MS - 1 })).toBe(
      'wait',
    );
    expect(decideProviderHeal({ ...base, priorAttempts: 1, msSinceLastAttempt: PROVIDER_HEAL_COOLDOWN_MS })).toBe(
      'heal',
    );
  });

  it('parks once the attempt budget is spent, cooldown notwithstanding', () => {
    expect(decideProviderHeal({ ...base, priorAttempts: PROVIDER_HEAL_MAX_ATTEMPTS, msSinceLastAttempt: 0 })).toBe(
      'park',
    );
  });
});

describe('observeProviderStatus — two-tick debounce', () => {
  beforeEach(() => _resetProviderHealTicksForTesting());

  it('counts consecutive failed ticks', () => {
    expect(observeProviderStatus('s1', 'failed')).toBe(1);
    expect(observeProviderStatus('s1', 'failed')).toBe(2);
  });

  it('cancels the debounce on any healthy write in between', () => {
    for (const healthy of ['active', 'healthy', 'idle']) {
      _resetProviderHealTicksForTesting();
      expect(observeProviderStatus('s1', 'failed')).toBe(1);
      expect(observeProviderStatus('s1', healthy)).toBe(0);
      expect(observeProviderStatus('s1', 'failed')).toBe(1);
    }
  });

  it('tracks sessions independently', () => {
    expect(observeProviderStatus('s1', 'failed')).toBe(1);
    expect(observeProviderStatus('s2', 'failed')).toBe(1);
    expect(observeProviderStatus('s1', 'failed')).toBe(2);
  });
});

describe('sweepProviderHeal — bounds, actions, and accountability', () => {
  const FAILED = { provider_status: 'failed', provider_failure_reason: 'stream closed' } as unknown as ContainerState;

  function healRows(inDb: Database.Database) {
    return inDb
      .prepare("SELECT id, on_wake, content FROM messages_in WHERE id LIKE 'provider-heal-%' ORDER BY seq")
      .all() as Array<{ id: string; on_wake: number; content: string }>;
  }

  /** Backdate every marker row so the 10-minute cooldown does not block. */
  function agePastCooldown(inDb: Database.Database) {
    inDb
      .prepare("UPDATE messages_in SET timestamp = ? WHERE id LIKE 'provider-heal-%'")
      .run(new Date(Date.now() - PROVIDER_HEAL_COOLDOWN_MS - 1_000).toISOString());
  }

  /**
   * The production writer opens the real outbound.db by path; these tests hold
   * an in-memory one, so inject a writer that lands in it.
   */
  function intoOutDb(outDb: Database.Database) {
    return (message: {
      id: string;
      kind: string;
      platformId: string | null;
      channelType: string | null;
      threadId: string | null;
      content: string;
    }) => {
      outDb
        .prepare(
          `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, content)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?)`,
        )
        .run(message.id, new Date().toISOString(), message.kind, message.content);
    };
  }

  /** Two failed ticks — the first only arms the debounce. */
  async function twoFailedTicks(
    mailbox: NanoclawMailboxSession,
    outDb: Database.Database,
    state = FAILED,
  ): Promise<boolean> {
    await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', state, intoOutDb(outDb));
    return _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', state, intoOutDb(outDb));
  }

  beforeEach(() => {
    // resolveSpawnProvider consults provider_health in the central DB.
    const db = initTestDb();
    runMigrations(db);
    armSelfHeal(true);
    _resetProviderHealTicksForTesting();
    mockKillContainer.mockReset();
    mockMarkProviderUnavailable.mockReset();
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'codex' });
    mockGetSession.mockReset().mockReturnValue(fakeSession());
    mockWakeContainer.mockReset();
  });
  afterEach(() => {
    armSelfHeal(false);
    closeDb();
  });

  it('does nothing on the first failed tick, heals on the second', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(healRows(inDb)).toHaveLength(0);

    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(true);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal', expect.any(Function));
  });

  it('cancels the debounce when a healthy status lands in between', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED);
    await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', {
      provider_status: 'active',
    } as unknown as ContainerState);
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('writes the accountability artifact that respawns the container', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    expect(await twoFailedTicks(mailbox, outDb)).toBe(true);

    const rows = healRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].on_wake).toBe(1);
    const content = JSON.parse(rows[0].content);
    expect(content.sender).toBe('system');
    expect(content._system.kind).toBe('agent_provider_heal');
    expect(content._system.failure_reason).toBe('stream closed');
    expect(content.text).toContain('done / lost / next');

    // The kill's onExit is what actually respawns the session.
    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();
    expect(mockWakeContainer).toHaveBeenCalledOnce();
  });

  it('routes to the declared fallback by recording a health window first', async () => {
    mockReadContainerConfig.mockReturnValue({ provider: 'codex', providerFallback: { provider: 'claude' } });
    const { inDb, outDb, mailbox } = makeSessionDbs();
    await twoFailedTicks(mailbox, outDb);
    expect(mockMarkProviderUnavailable).toHaveBeenCalledWith('ag-test', 'codex', 'unavailable', {
      message: 'stream closed',
    });
  });

  it('respawns on the primary and records no health window without a declared fallback', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    await twoFailedTicks(mailbox, outDb);
    expect(mockMarkProviderUnavailable).not.toHaveBeenCalled();
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal', expect.any(Function));
  });

  it('holds off inside the 10-minute cooldown', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    await twoFailedTicks(mailbox, outDb);
    expect(healRows(inDb)).toHaveLength(1);

    mockKillContainer.mockClear();
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(healRows(inDb)).toHaveLength(1);
  });

  it('parks with one notice after the attempt budget is spent', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    inDb.prepare("INSERT INTO session_routing VALUES (1, 'slack', 'C123', 'thread-1')").run();

    for (let i = 0; i < PROVIDER_HEAL_MAX_ATTEMPTS; i++) {
      _resetProviderHealTicksForTesting();
      expect(await twoFailedTicks(mailbox, outDb)).toBe(true);
      agePastCooldown(inDb);
    }
    expect(healRows(inDb)).toHaveLength(PROVIDER_HEAL_MAX_ATTEMPTS);
    expect(countProviderHealAttemptsSinceRealInbound(mailbox)).toBe(PROVIDER_HEAL_MAX_ATTEMPTS);

    mockKillContainer.mockClear();
    _resetProviderHealTicksForTesting();
    expect(await twoFailedTicks(mailbox, outDb)).toBe(true);
    // Parked: killed but NOT respawned, and no further marker row written.
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal-parked');
    expect(healRows(inDb)).toHaveLength(PROVIDER_HEAL_MAX_ATTEMPTS);

    const notices = outDb
      .prepare("SELECT content FROM messages_out WHERE id LIKE 'provider-heal-parked-%'")
      .all() as Array<{ content: string }>;
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0].content)._system.kind).toContain('provider_heal_parked:');

    // Idempotent across later ticks.
    _resetProviderHealTicksForTesting();
    await twoFailedTicks(mailbox, outDb);
    expect(
      outDb.prepare("SELECT COUNT(*) AS c FROM messages_out WHERE id LIKE 'provider-heal-parked-%'").get(),
    ).toEqual({ c: 1 });
  });

  it('resets the attempt budget after a real inbound message', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    await twoFailedTicks(mailbox, outDb);
    agePastCooldown(inDb);
    expect(countProviderHealAttemptsSinceRealInbound(mailbox)).toBe(1);

    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('user-1', 900, 'chat', ?, 'pending', 1, ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ text: 'hello', senderId: 'U1' }));
    expect(countProviderHealAttemptsSinceRealInbound(mailbox)).toBe(0);
  });

  it('shadow mode detects and logs without killing, respawning, or writing', async () => {
    armSelfHeal(false);
    const { inDb, outDb, mailbox } = makeSessionDbs();
    inDb.prepare("INSERT INTO session_routing VALUES (1, 'slack', 'C123', 'thread-1')").run();

    expect(await twoFailedTicks(mailbox, outDb)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(mockWakeContainer).not.toHaveBeenCalled();
    expect(mockMarkProviderUnavailable).not.toHaveBeenCalled();
    expect(healRows(inDb)).toHaveLength(0);
    expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('stays silent when the session has no routing to post into', () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    expect(notifyProviderHealParked(mailbox, fakeSession(), 'boom')).toBe(false);
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
    mockAdmitDueTaskContexts.mockImplementationOnce((db: Database.Database) => {
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, content)
         VALUES ('task-admitted', 2, 'task', ?, 'pending', ?, NULL, 'task-admitted', 1, '{}')`,
      ).run(new Date().toISOString(), new Date(Date.now() - 1_000).toISOString());
      return 1;
    });

    const result = await _prepareDueWakeForTesting(mailbox, 'ag-test', 'sess-test');

    expect(mockAdmitDueTaskContexts).toHaveBeenCalledWith(inDb, 'ag-test', 'sess-test');
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
// C3: Task watchdog integration tests
//
// Tests the sweepTaskWatchdog() pass that runs after the per-session sweep loop.
// Uses vi.mock (hoisted at top of file) to intercept DB and container calls.
// ─────────────────────────────────────────────────────────────────────────────

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

describe('sweepTaskWatchdog (C3)', () => {
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

    await _sweepTaskWatchdogForTesting();

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

  it('test_watchdog_skips_when_drain_active: task with recent terminal outbound is not reaped', async () => {
    const task = makeTask({
      last_progress_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    // Drain guard: terminal action seen 30s ago, within 120s grace
    mockPendingTerminalDispatchOutboundSeenAt.mockReturnValue(new Date(NOW - 30 * 1000).toISOString());
    mockGetActiveTasks.mockReturnValue([task]);

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await _sweepTaskWatchdogForTesting();

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

    await _sweepTaskWatchdogForTesting();

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

    await _sweepTaskWatchdogForTesting();

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

    await _sweepTaskWatchdogForTesting();

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

    await _sweepTaskWatchdogForTesting();

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

      await _sweepTaskWatchdogForTesting();

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

    await _sweepTaskWatchdogForTesting();

    expect(mockTransitionToTerminal).not.toHaveBeenCalledWith(
      task.task_id,
      'failed',
      expect.objectContaining({ fail_reason: 'container_exit' }),
    );
  });
});

describe('autoArchiveOldCompleted', () => {
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

describe('pruneIdleSessionArtifacts', () => {
  let tmpRoot: string;
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    mockIsContainerRunning.mockReset();
    mockIsContainerRunning.mockReturnValue(false);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-prune-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSession(opts: {
    group: string;
    sess: string;
    dbAgeMs: number;
    withNodeModules?: boolean;
    withPnpmStore?: boolean;
    nodeModulesInWorktree?: boolean;
  }): string {
    const dir = path.join(tmpRoot, opts.group, opts.sess);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'inbound.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE messages_in (
      status TEXT NOT NULL DEFAULT 'completed',
      trigger INTEGER NOT NULL DEFAULT 1,
      process_after TEXT
    )`);
    db.close();
    const mtime = (Date.now() - opts.dbAgeMs) / 1000;
    fs.utimesSync(dbPath, mtime, mtime);
    if (opts.withNodeModules) {
      const nm = path.join(dir, 'node_modules');
      fs.mkdirSync(nm);
      fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
    }
    if (opts.withPnpmStore) {
      const ps = path.join(dir, '.pnpm-store');
      fs.mkdirSync(ps);
      fs.writeFileSync(path.join(ps, 'index.db'), 'x');
    }
    if (opts.nodeModulesInWorktree) {
      const nested = path.join(dir, 'worktrees', 'repo', 'node_modules');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'pkg.json'), '{}');
    }
    return dir;
  }

  it('removes node_modules and .pnpm-store from idle sessions', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-old',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withNodeModules: true,
      withPnpmStore: true,
      nodeModulesInWorktree: true,
    });

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.pnpm-store'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'worktrees', 'repo', 'node_modules'))).toBe(false);
    // Session dir and DB file untouched
    expect(fs.existsSync(path.join(dir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'worktrees', 'repo'))).toBe(true);
  });

  it('leaves recently-active sessions alone', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-fresh',
      dbAgeMs: HOUR, // 1 hour < 24 hour default
      withNodeModules: true,
    });

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });

  it('skips sessions whose container is currently running', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-running',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withNodeModules: true,
    });
    mockIsContainerRunning.mockImplementation((sid: string) => sid === 'sess-running');

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });

  it('ignores non-sess dirs (e.g. .claude-shared, .claude-memory)', () => {
    const sharedDir = path.join(tmpRoot, 'ag-1', '.claude-shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    const nmInShared = path.join(sharedDir, 'node_modules');
    fs.mkdirSync(nmInShared);
    fs.writeFileSync(path.join(nmInShared, 'pkg.json'), '{}');

    pruneIdleSessionArtifacts(Date.now(), tmpRoot);

    expect(fs.existsSync(nmInShared)).toBe(true);
  });

  it('does not follow symlinks out of the session subtree', () => {
    const dir = makeSession({
      group: 'ag-1',
      sess: 'sess-symlink',
      dbAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-store-'));
    const outsideNm = path.join(outside, 'node_modules');
    fs.mkdirSync(outsideNm);
    fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
    try {
      fs.symlinkSync(outside, path.join(dir, 'shared-link'));

      pruneIdleSessionArtifacts(Date.now(), tmpRoot);

      expect(fs.existsSync(outsideNm)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('no-ops on a non-existent sessions root', () => {
    expect(() => pruneIdleSessionArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'))).not.toThrow();
  });
});

describe('pruneIdleThreadArtifacts', () => {
  let tmpRoot: string;
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-thread-prune-'));
    mockIsContainerRunning.mockReset();
    mockIsContainerRunning.mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeThread(opts: {
    key: string;
    activityAgeMs: number;
    withPnpmStore?: boolean;
    withNodeModules?: boolean;
  }): { worktreeDir: string; repoDir: string } {
    const worktreeDir = path.join(tmpRoot, opts.key, 'worktrees');
    const repoDir = path.join(worktreeDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    if (opts.withPnpmStore) {
      const store = path.join(worktreeDir, '.pnpm-store');
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'index.db'), 'x');
    }
    if (opts.withNodeModules) {
      const nm = path.join(repoDir, 'node_modules');
      fs.mkdirSync(nm, { recursive: true });
      fs.writeFileSync(path.join(nm, 'pkg.json'), '{}');
    }
    const mtime = (Date.now() - opts.activityAgeMs) / 1000;
    fs.utimesSync(worktreeDir, mtime, mtime);
    return { worktreeDir, repoDir };
  }

  it('removes package caches from idle thread worktrees but preserves repos', () => {
    const { worktreeDir, repoDir } = makeThread({
      key: 'thread-old',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
      withNodeModules: true,
    });

    pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(repoDir)).toBe(true);
  });

  it('leaves recently active thread worktrees alone', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-fresh',
      activityAgeMs: HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('uses session activity when supplied instead of stale filesystem mtime', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-db-active',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(
      Date.now(),
      tmpRoot,
      new Map([
        [worktreeDir, { lastActivityMs: Date.now() - HOUR, hasRunningContainer: false, hasBusySession: false }],
      ]),
    );

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('skips thread worktrees with a running container', () => {
    const { worktreeDir } = makeThread({
      key: 'thread-running',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
      withPnpmStore: true,
    });

    pruneIdleThreadArtifacts(
      Date.now(),
      tmpRoot,
      new Map([
        [
          worktreeDir,
          {
            lastActivityMs: Date.now() - SESSION_ARTIFACT_IDLE_MS - HOUR,
            hasRunningContainer: true,
            hasBusySession: false,
          },
        ],
      ]),
    );

    expect(fs.existsSync(path.join(worktreeDir, '.pnpm-store'))).toBe(true);
  });

  it('does not follow symlinks out of the thread worktree subtree', () => {
    const { repoDir } = makeThread({
      key: 'thread-symlink',
      activityAgeMs: SESSION_ARTIFACT_IDLE_MS + HOUR,
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-thread-store-'));
    const outsideNm = path.join(outside, 'node_modules');
    fs.mkdirSync(outsideNm);
    fs.writeFileSync(path.join(outsideNm, 'pkg.json'), '{}');
    try {
      fs.symlinkSync(outside, path.join(repoDir, 'shared-link'));

      pruneIdleThreadArtifacts(Date.now(), tmpRoot, new Map());

      expect(fs.existsSync(outsideNm)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('no-ops on a non-existent thread root', () => {
    expect(() => pruneIdleThreadArtifacts(Date.now(), path.join(tmpRoot, 'does-not-exist'), new Map())).not.toThrow();
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

// ─── D3: move-intent recovery + D4: audit body prune ──────────────────────────
// Self-contained: these helpers take an explicit central-DB handle + options,
// so they don't rely on the file-level getDb/session-manager mocks above.
describe('recoverMoveIntents (D3) + pruneAuditBodies (D4)', () => {
  // Lazy import inside the describe so the helpers resolve against the real
  // host-sweep module (already imported at top).
  let recoverMoveIntents: typeof import('./host-sweep.js').recoverMoveIntents;
  let pruneAuditBodies: typeof import('./host-sweep.js').pruneAuditBodies;
  let migration043: typeof import('./db/migrations/043-scheduled-audit.js').migration043;
  let ensureSchema: typeof import('./db/session-db.js').ensureSchema;
  let openInboundDb: typeof import('./db/session-db.js').openInboundDb;

  // Unique per-file temp root (mkdtempSync) so parallel vitest workers never
  // share a fixed path and clobber each other's rmSync.
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-d3d4-test-'));
  const NOW = Date.parse('2026-06-13T12:00:00Z');
  const SWEEP_MS = 60_000;

  beforeEach(async () => {
    ({ recoverMoveIntents, pruneAuditBodies } = await import('./host-sweep.js'));
    ({ migration043 } = await import('./db/migrations/043-scheduled-audit.js'));
    ({ ensureSchema, openInboundDb } = await import('./db/session-db.js'));
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
  });

  function centralDb(): Database.Database {
    const db = new Database(':memory:');
    migration043.up(db);
    // Recovery resolves the target channel-root session id from `sessions`
    // (M1 scoped count); provide the table so the lookup is exercised, not a
    // missing-table fallback.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
        thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    return db;
  }

  function addTargetSession(db: Database.Database, id: string, ag: string, mg: string): void {
    db.prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status) VALUES (?, ?, ?, NULL, 'active')",
    ).run(id, ag, mg);
  }

  function seedInbound(agentGroupId: string, sessionId: string): string {
    const dir = path.join(DIR, 'v2-sessions', agentGroupId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'inbound.db');
    ensureSchema(p, 'inbound');
    return p;
  }

  function insertLive(inboundPath: string, seriesId: string): void {
    const db = openInboundDb(inboundPath);
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
       VALUES (?, ?, 'task', datetime('now'), 'pending', ?, '0 9 * * *', ?, '{}')`,
    ).run(`live-${seriesId}`, seq, new Date(NOW + 3600_000).toISOString(), seriesId);
    db.close();
  }

  function writeIntent(
    db: Database.Database,
    opts: {
      seriesId: string;
      ag: string;
      sess: string;
      tsMs: number;
      snapshot?: object | null;
      noSnapshot?: boolean;
      targetAgentGroupId?: string;
      targetMessagingGroupId?: string;
    },
  ): void {
    const snapshot = opts.snapshot ?? {
      id: `orig-${opts.seriesId}`,
      series_id: opts.seriesId,
      status: 'pending',
      process_after: new Date(NOW + 3600_000).toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
      platform_id: 'p:1',
      channel_type: 'discord',
      thread_id: null,
      kind: 'task',
    };
    const detail: Record<string, unknown> = opts.noSnapshot ? {} : { snapshot };
    if (opts.targetAgentGroupId) detail.targetAgentGroupId = opts.targetAgentGroupId;
    if (opts.targetMessagingGroupId) detail.targetMessagingGroupId = opts.targetMessagingGroupId;
    db.prepare(
      `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, detail_json, correlation_id)
       VALUES (?, 'owner', 'move_intent', ?, ?, ?, ?, ?)`,
    ).run(
      new Date(opts.tsMs).toISOString(),
      opts.ag,
      opts.sess,
      opts.seriesId,
      opts.noSnapshot ? null : JSON.stringify(detail),
      `corr-${opts.seriesId}`,
    );
  }

  it('test_recover_stamps_when_live_row_exists', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess');
    insertLive(inbound, 'ser-1'); // a live row exists for the series
    writeIntent(db, { seriesId: 'ser-1', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-1'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // stamped
    expect(row.detail_json).toBeNull(); // body purged
    // No restore performed — the existing live row is the only one.
    const live = openInboundDb(inbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-1' AND status='pending'")
      .get() as { c: number };
    expect(live.c).toBe(1);
    db.close();
  });

  it('test_recover_restores_when_zero_live_rows', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess'); // empty — simulates crash post-cancel
    writeIntent(db, { seriesId: 'ser-2', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // restoreTaskRow inserted a live row from the snapshot.
    const live = openInboundDb(inbound)
      .prepare(
        "SELECT series_id, status, recurrence FROM messages_in WHERE series_id='ser-2' AND status IN ('pending','paused')",
      )
      .all() as Array<{ series_id: string; status: string; recurrence: string | null }>;
    expect(live).toHaveLength(1);
    expect(live[0].recurrence).toBe('0 9 * * *');
    const row = db
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-2'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy();
    expect(row.detail_json).toBeNull(); // body purged
    db.close();
  });

  it('test_recover_idempotent_no_double_restore', () => {
    const db = centralDb();
    const inbound = seedInbound('src-ag', 'src-sess');
    writeIntent(db, { seriesId: 'ser-3', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 2 * SWEEP_MS });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW }); // first pass restores
    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW }); // second pass must be a no-op

    const live = openInboundDb(inbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-3' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(live.c).toBe(1); // exactly one — no double restore
    db.close();
  });

  it('does not recover an intent younger than one sweep interval', () => {
    const db = centralDb();
    seedInbound('src-ag', 'src-sess');
    writeIntent(db, { seriesId: 'ser-4', ag: 'src-ag', sess: 'src-sess', tsMs: NOW - 5_000 }); // 5s old

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-4'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeNull(); // too young — left alone
    db.close();
  });

  // ── M1: scoped {source,target} count — an UNRELATED group's same series_id ─────
  // must NOT cause a false resolve. The crashed source still gets restored.
  it('test_recover_scoped_count_ignores_unrelated_group', () => {
    const db = centralDb();
    // Source session is EMPTY (crashed post-cancel, before the target insert).
    const srcInbound = seedInbound('src-ag', 'src-sess');
    // Target session exists but has NO live row (insert never landed).
    seedInbound('tgt-ag', 'tgt-sess');
    addTargetSession(db, 'tgt-sess', 'tgt-ag', 'tgt-mg');
    // An UNRELATED group has a live row reusing the SAME series_id — the exact
    // condition the bare-series_id fleet scan over-counted (M1 false-resolve).
    const unrelated = seedInbound('other-ag', 'other-sess');
    insertLive(unrelated, 'ser-scoped');

    writeIntent(db, {
      seriesId: 'ser-scoped',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      targetAgentGroupId: 'tgt-ag',
      targetMessagingGroupId: 'tgt-mg',
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // The scoped {source,target} count is 0 → the crashed source IS restored,
    // the unrelated group's row is ignored.
    const restored = openInboundDb(srcInbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-scoped' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(restored.c).toBe(1);
    const row = db
      .prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-scoped'")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // resolved after restore
    db.close();
  });

  it('test_recover_scoped_count_stamps_when_target_has_live_row', () => {
    // The move SUCCEEDED (target has the live row) but the intent was never
    // stamped (crash after insert). Scoped count sees the target row → stamp, do
    // NOT restore the source (would double the live rows).
    const db = centralDb();
    const srcInbound = seedInbound('src-ag', 'src-sess'); // empty source
    const tgtInbound = seedInbound('tgt-ag', 'tgt-sess');
    addTargetSession(db, 'tgt-sess', 'tgt-ag', 'tgt-mg');
    insertLive(tgtInbound, 'ser-tgt'); // target carries the live row

    writeIntent(db, {
      seriesId: 'ser-tgt',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      targetAgentGroupId: 'tgt-ag',
      targetMessagingGroupId: 'tgt-mg',
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    // Source NOT restored (the target's live row is the one live row).
    const srcCount = openInboundDb(srcInbound)
      .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE series_id='ser-tgt' AND status IN ('pending','paused')")
      .get() as { c: number };
    expect(srcCount.c).toBe(0);
    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-tgt'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeTruthy();
    db.close();
  });

  // ── ADV-S2: a dangling unrecoverable intent must resolve (no permanent zombie) ─
  it('test_recover_no_snapshot_resolves_intent', () => {
    const db = centralDb();
    seedInbound('src-ag', 'src-sess');
    // Intent with NO snapshot body (purged-but-still-unresolved) → unrecoverable,
    // but it must NOT surface forever as a repair row: stamp resolved_at.
    writeIntent(db, {
      seriesId: 'ser-nosnap',
      ag: 'src-ag',
      sess: 'src-sess',
      tsMs: NOW - 2 * SWEEP_MS,
      noSnapshot: true,
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db
      .prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-nosnap'")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeTruthy(); // resolved — no permanent zombie
    db.close();
  });

  it('test_recover_source_dir_missing_resolves_intent', () => {
    const db = centralDb();
    // No source inbound.db on disk at all → cannot restore, but must resolve so
    // it does not surface as an unclearable stalled repair row forever.
    writeIntent(db, {
      seriesId: 'ser-nodir',
      ag: 'gone-ag',
      sess: 'gone-sess',
      tsMs: NOW - 2 * SWEEP_MS,
    });

    recoverMoveIntents(db, { dataDir: DIR, nowMs: NOW });

    const row = db.prepare("SELECT resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-ser-nodir'").get() as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBeTruthy(); // resolved — no permanent zombie
    db.close();
  });

  // ── D4 ──
  function insertAudit(db: Database.Database, opts: { action: string; tsMs: number; bodies?: boolean }): number {
    const r = db
      .prepare(
        `INSERT INTO scheduled_audit (ts, actor, action, agent_group_id, session_id, series_id, before_preview, after_preview, detail_json)
       VALUES (?, 'owner', ?, 'ag', 'sess', 'ser', ?, ?, ?)`,
      )
      .run(
        new Date(opts.tsMs).toISOString(),
        opts.action,
        opts.bodies === false ? null : 'before body',
        opts.bodies === false ? null : 'after body',
        opts.bodies === false ? null : '{"x":1}',
      );
    return Number(r.lastInsertRowid);
  }

  it('test_prune_nulls_bodies_after_90d', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'edit', tsMs: NOW - 91 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db
      .prepare('SELECT actor, action, before_preview, after_preview, detail_json FROM scheduled_audit WHERE id = ?')
      .get(id) as Record<string, unknown>;
    expect(row.before_preview).toBeNull();
    expect(row.after_preview).toBeNull();
    expect(row.detail_json).toBeNull();
    expect(row.actor).toBe('owner'); // metadata intact
    expect(row.action).toBe('edit');
    db.close();
  });

  it('test_prune_keeps_recent_bodies', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'edit', tsMs: NOW - 10 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db.prepare('SELECT before_preview FROM scheduled_audit WHERE id = ?').get(id) as {
      before_preview: string | null;
    };
    expect(row.before_preview).toBe('before body'); // unchanged
    db.close();
  });

  it('test_prune_preserves_cancel_metadata', () => {
    const db = centralDb();
    const id = insertAudit(db, { action: 'cancel', tsMs: NOW - 100 * 24 * 3600_000 });
    pruneAuditBodies(db, { nowMs: NOW });
    const row = db.prepare('SELECT action FROM scheduled_audit WHERE id = ?').get(id) as { action: string };
    expect(row.action).toBe('cancel'); // row survives so history can still label the cancellation
    db.close();
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

describe('shouldSkipUsageRollup', () => {
  it('skips when the cached mtime matches the current outbound.db mtime (unchanged since last rollup)', () => {
    expect(shouldSkipUsageRollup(1000, 1000)).toBe(true);
  });

  it('does not skip when the outbound.db mtime moved (new turn_usage rows written)', () => {
    expect(shouldSkipUsageRollup(1000, 2000)).toBe(false);
  });

  it('does not skip a session never seen before (no cache entry)', () => {
    expect(shouldSkipUsageRollup(undefined, 1000)).toBe(false);
  });
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

describe('reportContainerOomTelemetry', () => {
  function oomSession(id: string): Session {
    return { ...fakeSession(), id };
  }
  function noticeRows(
    inDb: Database.Database,
  ): Array<{ id: string; trigger: number; on_wake: number; content: string }> {
    return inDb
      .prepare("SELECT id, trigger, on_wake, content FROM messages_in WHERE kind = 'chat' ORDER BY id")
      .all() as Array<{ id: string; trigger: number; on_wake: number; content: string }>;
  }
  function state(overrides: Partial<ContainerState>): ContainerState {
    return {
      current_tool: null,
      tool_declared_timeout_ms: null,
      tool_started_at: null,
      ...overrides,
    } as ContainerState;
  }

  it('writes ONE notice for a burst of kills, carrying the cumulative count', () => {
    const { inDb, mailbox } = makeNotifyTestDbs();
    const session = oomSession('oom-burst');

    for (let i = 1; i <= 346; i++) {
      _reportContainerOomTelemetryForTesting(mailbox, session, 'ag-test', state({ memory_oom_kill_events: i }));
    }

    const rows = noticeRows(inDb);
    expect(rows).toHaveLength(1);
    // Cumulative, not per-kill: the count in the text is the count at notice
    // time, and no later kill adds a message inside the interval.
    expect(JSON.parse(rows[0].content).text).toContain('killed 1 process');
    expect(JSON.parse(rows[0].content)._system.kind).toBe('agent_container_oom');
  });

  it('never wakes a container — notices are trigger=0 and on_wake=0', () => {
    const { inDb, mailbox } = makeNotifyTestDbs();

    _reportContainerOomTelemetryForTesting(
      mailbox,
      oomSession('oom-nowake'),
      'ag-test',
      state({ memory_oom_kill_events: 7 }),
    );

    const rows = noticeRows(inDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0);
    expect(rows[0].on_wake).toBe(0);
    // countDueMessages only counts trigger=1, so this row cannot spawn a
    // container — it rides along with the next real turn instead.
    expect(countDueMessages(inDb)).toBe(0);
  });

  it('writes nothing when there are no kills and no pressure', () => {
    const { inDb, mailbox } = makeNotifyTestDbs();

    for (let i = 0; i < 10; i++) {
      _reportContainerOomTelemetryForTesting(
        mailbox,
        oomSession('oom-quiet'),
        'ag-test',
        state({ memory_oom_kill_events: 0, memory_max_events: 4 }),
      );
    }

    expect(noticeRows(inDb)).toHaveLength(0);
  });

  it('writes the quieter pressure notice when the cgroup thrashes with no kills', () => {
    const { inDb, mailbox } = makeNotifyTestDbs();
    const session = oomSession('oom-pressure');

    for (let i = 0; i < 5; i++) {
      _reportContainerOomTelemetryForTesting(
        mailbox,
        session,
        'ag-test',
        state({ memory_oom_kill_events: 0, memory_max_events: 760 + i }),
      );
    }

    const rows = noticeRows(inDb);
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content._system.kind).toBe('agent_container_memory_pressure');
    expect(content.text).toContain('Nothing has been killed yet');
    expect(rows[0].trigger).toBe(0);
  });
});
