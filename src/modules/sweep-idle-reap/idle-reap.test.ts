/**
 * Acceptance cases for the idle-reap sweep family (seam 2, S2-PR3 — F-3.1,
 * F-3.2 in docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * Hermeticity (brief-common.md HARD RULE): nothing here reaches outside the
 * per-run temp fixture. The mailbox store is a fake registered over the real
 * `session-manager.ts` nesting guard, and every duty body whose real
 * implementation would touch docker, git, GitHub, Discord, an LLM or a
 * worker thread is mocked at the seam host-sweep.ts already imports. The
 * `child_process` tripwire records and throws on any real spawn; F-3.2 (which
 * drives a full sweep tick through the registry) asserts it stayed empty.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMailbox, MailboxSessionKey } from '../../mailbox/types.js';
import type { MailboxSession } from '../../mailbox/types.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import type { Session } from '../../types.js';

import { shouldReapIdleChatContainer, shouldReapIdleTaskContainer, CHAT_IDLE_REAP_MS } from './index.js';
// PR 14 integration: the exclusive-chain case below asserts the WHOLE
// session:health chain, and S11/S14 moved to the container-health family
// (S2-PR10). Side-effect import so the registry the case reads holds them.
import '../sweep-container-health/index.js';

// ── F-3.1: the 13 ported pure-predicate cases, assertions unchanged ─────────

describe('shouldReapIdleTaskContainer and shouldReapIdleChatContainer keep their existing decisions', () => {
  describe('shouldReapIdleTaskContainer', () => {
    it('reaps an idle scheduled-task container with no claimed or due work', () => {
      expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, false, false)).toBe(true);
    });

    it('keeps a scheduled-task container while work is due or claimed', () => {
      expect(shouldReapIdleTaskContainer('system:tasks:task-1', 1, 0, false, false)).toBe(false);
      expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 1, false, false)).toBe(false);
    });

    it('keeps a scheduled-task container while the provider is executing a turn', () => {
      // Runner-pushed follow-up turns (wrapping-retry nudges, post-compaction
      // bootstrap re-injection) execute with no processing claim at all.
      expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, true, false)).toBe(false);
    });

    it('keeps a scheduled-task container holding a work continuation', () => {
      // `continue_work` is the sanctioned follow-up promise. Between turn end
      // and continuation admission there is no claim and no execution, and
      // reaping there demotes the agent to the throttled recovery path.
      expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, false, true)).toBe(false);
    });

    it('never reaps an interactive session through the scheduled-task policy', () => {
      expect(shouldReapIdleTaskContainer('discord:guild:channel:thread', 0, 0, false, false)).toBe(false);
      expect(shouldReapIdleTaskContainer(null, 0, 0, false, false)).toBe(false);
    });
  });

  describe('shouldReapIdleChatContainer', () => {
    const THREAD = 'discord:guild:channel:thread';
    const NOW = 1_700_000_000_000;
    const LONG_QUIET = NOW - CHAT_IDLE_REAP_MS - 1;
    const JUST_QUIET = NOW - CHAT_IDLE_REAP_MS + 1;

    it('reaps a chat container quiet past the floor with nothing pending', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, LONG_QUIET, LONG_QUIET, NOW)).toBe(true);
    });

    it('keeps a chat container inside the quiet floor', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, JUST_QUIET, JUST_QUIET, NOW)).toBe(false);
    });

    it('keeps a chat container while work is due or claimed', () => {
      expect(shouldReapIdleChatContainer(THREAD, 1, 0, false, LONG_QUIET, LONG_QUIET, NOW)).toBe(false);
      expect(shouldReapIdleChatContainer(THREAD, 0, 1, false, LONG_QUIET, LONG_QUIET, NOW)).toBe(false);
    });

    it('keeps a chat container with a pending work_continuation promise', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, true, LONG_QUIET, LONG_QUIET, NOW)).toBe(false);
    });

    it('keeps a chat container that has never produced output', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, null, LONG_QUIET, NOW)).toBe(false);
    });

    it('never reaps a task-thread session through the chat policy', () => {
      expect(shouldReapIdleChatContainer('system:tasks:task-1', 0, 0, false, LONG_QUIET, LONG_QUIET, NOW)).toBe(false);
    });

    // The live failure: a user message arrives 16 min after the previous reply,
    // the container consumes it (so dueCount is already 0) and is killed 11s
    // into the turn before emitting its first status. Outbound alone cannot see
    // this; inbound can.
    it('keeps a chat container that just consumed a message but has not replied yet', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, LONG_QUIET, JUST_QUIET, NOW)).toBe(false);
    });

    it('still reaps when the newest inbound is also past the floor', () => {
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, JUST_QUIET, LONG_QUIET, NOW)).toBe(false);
      expect(shouldReapIdleChatContainer(THREAD, 0, 0, false, LONG_QUIET, null, NOW)).toBe(true);
    });
  });
});

// ── F-3.2: the exclusive chain — idle reaps win over ceiling enforcement ────
//
// Drives a real sweep tick through the registry (host-sweep.ts's driver, with
// this module's S12/S13 registered as a side effect of the import above) so
// the assertion is about the ACTUAL exclusive chain, not a re-statement of
// its declared order. Harness follows src/host-sweep-registry.test.ts (R-10 /
// R-4's pattern) — mocks every seam host-sweep.ts reaches for on this path.

const h = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-idle-reap-')),
    sessions: [] as Session[],
    agentGroup: { id: 'ag-1', name: 'ag', folder: 'ag-folder' } as unknown,
    running: new Set<string>(),
    heartbeatFile: '',
    kills: [] as { sessionId: string; reason: string; depth: number }[],
    spawns: [] as string[],
    exists: true,
    mailbox: null as NanoclawMailboxSession | null,
    oomWritten: 0,
  };
});

/** Filled in after the imports below; the mock factory below cannot import. */
const probe = vi.hoisted(() => ({ depth: (): number => 0 }));

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`idle-reap.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

vi.mock('child_process', () => childProcessTripwire(h.spawns));
vi.mock('node:child_process', () => childProcessTripwire(h.spawns));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get SELF_HEAL_ENABLED() {
      return false;
    },
    get DATA_DIR() {
      return h.dataDir;
    },
  };
});

vi.mock('../../egress-lockdown.js', () => ({ ensureEgressNetwork: () => undefined }));

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getActiveSessions: () => h.sessions,
    getSession: (id: string) => h.sessions.find((s) => s.id === id),
    updateSession: () => undefined,
  };
});

vi.mock('../../db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/agent-groups.js')>();
  return { ...real, getAgentGroup: () => h.agentGroup };
});

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (id: string) => h.running.has(id),
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (mailbox PR 4 round 8 — thread-close's finalizer is its second caller).
    // Composed from the MOCKED checks: spreading `...real` alone leaves the
    // real predicate reading live module state, so every guard in this suite's
    // duty graph would silently bypass this mock. Same composition
    // src/host-sweep.test.ts uses.
    containerOwnsOutbound: (sessionId: string) => h.running.has(sessionId) || real.isContainerSpawning(sessionId),
    hasContainerEverRun: () => false,
    getContainerSpawnedAt: () => 0,
    getActiveContainerSessionIds: () => [...h.running],
    killContainer: (sessionId: string, reason: string, onExit?: () => void) => {
      h.kills.push({ sessionId, reason, depth: probe.depth() });
      h.running.delete(sessionId);
      onExit?.();
    },
    wakeContainer: async () => true,
  };
});

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: () => 0,
    writeSessionMessage: async () => undefined,
    deferMessageForFreshContextRetry: () => undefined,
    heartbeatPath: () => h.heartbeatFile,
  };
});

vi.mock('../scheduling/host-script.js', () => ({ runHostGatedTaskScripts: async () => undefined }));
vi.mock('../scheduling/recurrence.js', () => ({ handleRecurrence: async () => undefined }));
vi.mock('../../dashboard/thread-close.js', () => ({
  advanceThreadClosures: () => undefined,
  syncDoneProposalMirror: () => undefined,
}));
vi.mock('../orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => undefined,
  runReconcilerOnStartup: () => undefined,
}));
vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: () => [],
    getOrphanedTasks: () => [],
    autoArchiveCompletedBefore: () => 0,
    transitionToTerminal: () => false,
  };
});
vi.mock('../orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: () => undefined,
}));
vi.mock('../orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/watchdog.js')>();
  return { ...real, pendingTerminalSpawnOutboundSeenAt: () => null, decideTaskAction: () => ({ action: 'ok' }) };
});
vi.mock('../../storage-maintenance-worker.js', () => ({
  runStorageMaintenanceInBackground: async () => null,
  stopStorageMaintenanceWorker: () => undefined,
}));
vi.mock('../../storage-pressure-alert.js', () => ({ handleStoragePressureAlert: () => undefined }));
vi.mock('../claims/reconcile.js', () => ({ reconcileMergedClaims: async () => undefined }));
vi.mock('../claims/self-heal.js', () => ({ sweepClaimsSelfHeal: async () => undefined }));
vi.mock('../../repo-fence-recovery.js', () => ({ sweepOrphanedRepoIngressFences: async () => null }));
vi.mock('../../db/channel-ingress-receipts.js', () => ({ pruneChannelIngressReceipts: () => undefined }));
vi.mock('../../db/usage.js', () => ({ rollupSessionUsage: () => 0, pruneOldTurnUsage: () => undefined }));
vi.mock('../../github-app-token.js', () => ({ refreshExpiringGitHubAppTokens: async () => undefined }));
vi.mock('../approvals/index.js', () => ({ sweepAwaitingReasonRejects: async () => undefined }));
vi.mock('../../dashboard/session-title-sweep.js', () => ({ runSessionTitleSweep: async () => undefined }));
vi.mock('../../topic-title.js', () => ({ retryPendingThreadTitles: async () => undefined }));
vi.mock('../../dashboard/db/dashboard-tokens.js', () => ({ pruneDashboardTokens: () => undefined }));
vi.mock('../../container-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-config.js')>();
  return { ...real, readContainerConfig: () => ({}) };
});
vi.mock('../../provider-fallback.js', () => ({
  resolveSpawnProvider: () => ({ provider: 'claude', primaryProvider: 'claude' }),
}));
vi.mock('../../db/provider-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/provider-health.js')>();
  return { ...real, markProviderUnavailable: () => undefined };
});
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
  }),
}));

import { registerAgentMailbox, resetAgentMailboxForTesting } from '../../mailbox/index.js';
import {
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
  _sweepOnceForTesting,
  SWEEP_DUTY_INVENTORY,
  type SweepSessionContext,
} from '../../host-sweep.js';
import { _mailboxSessionDepthForTesting } from '../../host-sweep-depth-probe.js';

probe.depth = _mailboxSessionDepthForTesting;

function fakeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    status: 'active',
    created_at: '2026-04-20T12:00:00.000Z',
    last_active: '2026-04-20T12:00:00.000Z',
    agent_provider: null,
    ...overrides,
  } as unknown as Session;
}

function fakeMailbox(overrides: Record<string, unknown> = {}): NanoclawMailboxSession {
  const base: Record<string, unknown> = {
    syncProcessingAcks: () => undefined,
    expireStalePending: () => 0,
    getProcessingClaimRows: () => [],
    hasOutbound: () => true,
    legacyInboundHandle: () => ({}),
    legacyOutboundHandle: () => ({}),
    countDueMessages: () => 0,
    getDueWakePriority: () => 'interactive',
    readWorkContinuation: () => null,
    readContinuationRecoveryAttemptAt: () => 0,
    parkDueRecoveryWakes: () => 0,
    getContainerState: () => null,
    latestOutboundTimestamp: () => null,
    latestInboundTimestamp: () => null,
    countLiveTasks: () => 0,
    getNextFutureProcessAfter: () => null,
    countRecoveryAttemptsSinceRealInbound: () => 0,
    latestRecoveryMarkerTimestamp: () => null,
    latestRecoveryMarkerId: () => null,
    readSessionRouting: () => null,
    outboundHasContentLike: () => false,
    outboundHasRecentContentLike: () => false,
    writeOutboundDirect: () => undefined,
    deleteOrphanProcessingClaims: () => 0,
    getMessageForRetry: () => undefined,
    hasNonStatusReplyTo: () => false,
    markInboundCompletedIfPending: () => undefined,
    markMessageFailed: () => undefined,
    insertDeferredMessageWithContextIfNew: () => {
      h.oomWritten += 1;
      return true;
    },
    incrementWorkContinuationResumeAttempt: () => null,
    migrateLegacyWorkContinuationForRecovery: () => null,
    restoreWorkContinuationResumeAttempt: () => undefined,
  };
  return { ...base, ...overrides } as unknown as NanoclawMailboxSession;
}

const fakeStore: AgentMailbox = {
  exists: async () => h.exists,
  prepare: () => undefined,
  destroy: async () => undefined,
  runnerContext: async () => ({}),
  runnerEnvironment: async () => ({}),
  session: async <T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> =>
    action(h.mailbox as unknown as MailboxSession),
};

/** Heartbeat older than ABSOLUTE_CEILING_MS → decideStuckAction would return kill-ceiling. */
function armCeilingHeartbeat(): void {
  const hb = path.join(h.dataDir, `hb-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(hb, 'x');
  const old = Date.now() - 90 * 60_000;
  fs.utimesSync(hb, new Date(old), new Date(old));
  h.heartbeatFile = hb;
}

describe('the idle reaps win over ceiling enforcement in the exclusive chain', () => {
  beforeEach(() => {
    resetAgentMailboxForTesting();
    registerAgentMailbox(() => fakeStore);
    h.sessions = [];
    h.running = new Set();
    h.heartbeatFile = path.join(h.dataDir, 'no-such-heartbeat');
    h.kills = [];
    h.spawns.length = 0;
    h.exists = true;
    h.mailbox = fakeMailbox();
    h.oomWritten = 0;
  });

  afterEach(() => {
    // A default (builtins-restoring) reset replays every registered duty
    // source in order — the in-file host-sweep.ts builtins AND this module's
    // `registerSweepDutySource('sweep-idle-reap', ...)` — so S12/S13 come
    // back without re-registering them by hand here.
    _resetSweepRegistryForTesting();
    vi.restoreAllMocks();
  });

  it('kills a scheduled-task container idle AND past the ceiling as scheduled-task-idle, not absolute-ceiling', async () => {
    const session = fakeSession('sess-task-vs-ceiling', { thread_id: 'system:tasks:series-1' });
    h.sessions = [session];
    h.running.add(session.id);
    armCeilingHeartbeat();
    // Idle by shouldReapIdleTaskContainer: no due/claimed work, provider not
    // executing, no continuation — AND the heartbeat is past ABSOLUTE_CEILING_MS.
    h.mailbox = fakeMailbox({ getContainerState: () => ({ provider_executing: 0 }) });

    await _sweepOnceForTesting();

    expect(h.kills).toEqual([{ sessionId: session.id, reason: 'scheduled-task-idle', depth: 0 }]);
    // The SLA branch never ran, so no OOM/SLA telemetry row was written.
    expect(h.oomWritten).toBe(0);
    expect(h.spawns).toEqual([]);
  });

  it('kills a chat container idle AND past the ceiling as chat-idle-reap, not absolute-ceiling', async () => {
    const session = fakeSession('sess-chat-vs-ceiling');
    h.sessions = [session];
    h.running.add(session.id);
    armCeilingHeartbeat();
    const quietSince = new Date(Date.now() - 60 * 60_000).toISOString();
    // Idle by shouldReapIdleChatContainer: no due/claimed work, no
    // continuation, last activity (either direction) past CHAT_IDLE_REAP_MS —
    // AND the heartbeat is past ABSOLUTE_CEILING_MS.
    h.mailbox = fakeMailbox({
      getContainerState: () => ({ provider_executing: 0 }),
      latestOutboundTimestamp: () => quietSince,
      latestInboundTimestamp: () => quietSince,
    });

    await _sweepOnceForTesting();

    expect(h.kills).toEqual([{ sessionId: session.id, reason: 'chat-idle-reap', depth: 0 }]);
    expect(h.oomWritten).toBe(0);
    expect(h.spawns).toEqual([]);
  });

  it('the declared chain is heal (10) -> idle task (20) -> idle chat (30) -> SLA (40, fallthrough)', () => {
    const { duties } = _listSweepRegistrationsForTesting();
    // The registry's OWN returned order, not a re-sort — a re-sort by `order`
    // alone would still pass if the registry silently returned duties in a
    // different sequence than it actually runs them in.
    const health = duties.filter((d) => d.phase === 'session:health');
    expect(health.map((d) => ({ name: d.name, order: d.order }))).toEqual([
      { name: SWEEP_DUTY_INVENTORY.S11, order: 10 },
      { name: SWEEP_DUTY_INVENTORY.S12, order: 20 },
      { name: SWEEP_DUTY_INVENTORY.S13, order: 30 },
      { name: SWEEP_DUTY_INVENTORY.S14, order: 40 },
    ]);
    // The exclusive-chain contract is `claims()` on every duty but the
    // fallthrough — sorting on name/order alone would stay green even if S14
    // (the SLA) acquired a predicate, which the registry's own validation
    // permits (a second `claims()`-bearing duty is legal; only a SECOND
    // no-claims duty in the same exclusive phase throws). That would let an
    // unclaimed running container silently skip ceiling enforcement.
    const byName = new Map(health.map((d) => [d.name, d]));
    expect(typeof byName.get(SWEEP_DUTY_INVENTORY.S11)!.claims).toBe('function');
    expect(typeof byName.get(SWEEP_DUTY_INVENTORY.S12)!.claims).toBe('function');
    expect(typeof byName.get(SWEEP_DUTY_INVENTORY.S13)!.claims).toBe('function');
    expect(byName.get(SWEEP_DUTY_INVENTORY.S14)!.claims).toBeUndefined();
  });

  // ── "Acceptance tests must drive the REGISTERED duty" (brief-family-template.md,
  // rule added 2026-09-03 14:35Z) — a case that calls the moved body directly
  // proves nothing about the move itself: the registered `run`/`claims` could
  // be wired to the wrong predicate, drop a field off `ctx`, or (per Codex's
  // finding above) the exclusive-chain contract could quietly break while
  // name/order still matched. These obtain S12/S13 from the registry by name
  // (`_listSweepRegistrationsForTesting`, the same accessor R-7 uses) and
  // drive their real `claims(ctx)`/`run(ctx)` with a hand-built context.
  describe('the registered S12/S13 duties, driven directly', () => {
    function fakeHealthCtx(overrides: {
      threadId?: string | null;
      dueCount?: number;
      processingClaimCount?: number;
      providerExecuting?: boolean;
      hasContinuation?: boolean;
      lastOutboundAtMs?: number | null;
      lastInboundAtMs?: number | null;
    }): SweepSessionContext {
      return {
        session: { id: 'sess-direct', thread_id: overrides.threadId ?? null } as unknown,
        plan: {
          dueCount: overrides.dueCount ?? 0,
          workContinuation: overrides.hasContinuation ? { id: 'c1' } : null,
        } as unknown,
        observed: {
          containerState: { provider_executing: overrides.providerExecuting ? 1 : 0 },
          processingClaimCount: overrides.processingClaimCount ?? 0,
          lastOutboundAtMs: overrides.lastOutboundAtMs ?? null,
          lastInboundAtMs: overrides.lastInboundAtMs ?? null,
        } as unknown,
      } as unknown as SweepSessionContext;
    }

    function getHealthDuty(name: string) {
      const duty = _listSweepRegistrationsForTesting().duties.find(
        (d) => d.phase === 'session:health' && d.name === name,
      );
      if (!duty) throw new Error(`duty not registered: ${name}`);
      return duty;
    }

    it('S12 (idle-task-reap): claims() true when idle, false when work is due; run() kills scheduled-task-idle at depth 0', async () => {
      const duty = getHealthDuty(SWEEP_DUTY_INVENTORY.S12);
      const idleCtx = fakeHealthCtx({ threadId: 'system:tasks:series-direct' });
      const busyCtx = fakeHealthCtx({ threadId: 'system:tasks:series-direct', dueCount: 1 });

      expect(await duty.claims!(idleCtx)).toBe(true);
      expect(await duty.claims!(busyCtx)).toBe(false);

      await duty.run(idleCtx);

      expect(h.kills).toEqual([{ sessionId: 'sess-direct', reason: 'scheduled-task-idle', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });

    it('S13 (idle-chat-reap): claims() true when quiet past the floor, false when recently active; run() kills chat-idle-reap at depth 0', async () => {
      const duty = getHealthDuty(SWEEP_DUTY_INVENTORY.S13);
      const longQuiet = Date.now() - CHAT_IDLE_REAP_MS - 1;
      const quietCtx = fakeHealthCtx({ lastOutboundAtMs: longQuiet, lastInboundAtMs: longQuiet });
      const activeCtx = fakeHealthCtx({ lastOutboundAtMs: Date.now(), lastInboundAtMs: Date.now() });

      expect(await duty.claims!(quietCtx)).toBe(true);
      expect(await duty.claims!(activeCtx)).toBe(false);

      await duty.run(quietCtx);

      expect(h.kills).toEqual([{ sessionId: 'sess-direct', reason: 'chat-idle-reap', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });
  });

  // ── Tripwire self-check (brief-common.md HARD RULE step 3) ─────────────────
  // Same direct proof as src/host-sweep-registry.test.ts's own self-check: the
  // factory itself throws and records the call, so a seam mock that forgot to
  // route through it (rather than one of the ABOVE tests happening not to
  // exercise a code path that would call it) is what would go undetected —
  // this proves the tripwire mechanism itself is not a silent no-op.
  it('the child_process tripwire bites when a seam mock is removed', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });
});
