/**
 * Acceptance cases for the sweep duty registry (convergence seam 2, PR 2 —
 * R-1..R-12 in docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * Hermeticity (brief-common.md HARD RULE): nothing here reaches outside the
 * per-run temp fixture. The mailbox store is a fake registered over the real
 * `session-manager.ts` nesting guard — so R-10's depth probe still measures the
 * production guard — and every duty body whose real implementation would touch
 * docker, git, GitHub, Discord, an LLM or a worker thread is mocked at the seam
 * host-sweep.ts already imports. The `child_process` tripwire below records and
 * throws on any real spawn; each case that runs duty bodies asserts it stayed
 * empty.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMailbox, MailboxSessionKey } from './mailbox/types.js';
import type { MailboxSession } from './mailbox/types.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import type { Session } from './types.js';

// ── hoisted state every mock factory reads ───────────────────────────────────

const h = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-registry-')),
    selfHeal: false,
    sessions: [] as Session[],
    agentGroup: { id: 'ag-1', name: 'ag', folder: 'ag-folder' } as unknown,
    running: new Set<string>(),
    spawnedAtMs: 0,
    heartbeatFile: '',
    wakeResult: true,
    kills: [] as { sessionId: string; reason: string; depth: number }[],
    opensAtKill: [] as number[],
    wakes: [] as { sessionId: string; depth: number }[],
    spawns: [] as string[],
    watchdogAction: null as string | null,
    // The fake mailbox store.
    exists: true,
    opens: [] as string[],
    failNextOpen: null as unknown,
    mailbox: null as NanoclawMailboxSession | null,
  };
});

/** Filled in after the imports below; the mock factories cannot import. */
const probe = vi.hoisted(() => ({ depth: (): number => 0 }));

/**
 * A tripwire, not a functional mock. It records the call (so the test can
 * assert on that record even though the thrown error itself may be swallowed —
 * every caller here already wraps its real work in try/catch or .catch,
 * precisely so a git/network failure never crashes the host, which means an
 * uncaught-throw-only tripwire could fire and still leave a test green) and
 * then throws, so a caller that does NOT catch it fails loudly too.
 */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`host-sweep-registry.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

vi.mock('./config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./config.js')>();
  return {
    ...real,
    get SELF_HEAL_ENABLED() {
      return h.selfHeal;
    },
    get DATA_DIR() {
      return h.dataDir;
    },
  };
});

vi.mock('./egress-lockdown.js', () => ({ ensureEgressNetwork: () => undefined }));

vi.mock('./db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/sessions.js')>();
  return {
    ...real,
    getActiveSessions: () => h.sessions,
    getSession: (id: string) => h.sessions.find((s) => s.id === id),
    updateSession: () => undefined,
  };
});

vi.mock('./db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/agent-groups.js')>();
  return { ...real, getAgentGroup: () => h.agentGroup };
});

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (id: string) => h.running.has(id),
    hasContainerEverRun: () => false,
    getContainerSpawnedAt: () => h.spawnedAtMs,
    getActiveContainerSessionIds: () => [...h.running],
    killContainer: (sessionId: string, reason: string, onExit?: () => void) => {
      h.kills.push({ sessionId, reason, depth: probe.depth() });
      h.opensAtKill.push(h.opens.length);
      h.running.delete(sessionId);
      onExit?.();
    },
    wakeContainer: async (session: { id: string }) => {
      h.wakes.push({ sessionId: session.id, depth: probe.depth() });
      return h.wakeResult;
    },
  };
});

vi.mock('./session-manager.js', async (importOriginal) => {
  // The nesting guard and withExistingMailboxSession stay REAL — R-10 measures
  // the production guard, not a stand-in.
  const real = await importOriginal<typeof import('./session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: () => 0,
    writeSessionMessage: async () => undefined,
    deferMessageForFreshContextRetry: () => undefined,
    heartbeatPath: () => h.heartbeatFile,
  };
});

vi.mock('./modules/scheduling/host-script.js', () => ({ runHostGatedTaskScripts: async () => undefined }));
vi.mock('./modules/scheduling/recurrence.js', () => ({ handleRecurrence: async () => undefined }));
vi.mock('./dashboard/thread-close.js', () => ({
  advanceThreadClosures: () => undefined,
  syncDoneProposalMirror: () => undefined,
}));
vi.mock('./modules/orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => undefined,
  runReconcilerOnStartup: () => undefined,
}));
vi.mock('./modules/orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: () => [],
    getOrphanedTasks: () => [],
    autoArchiveCompletedBefore: () => 0,
    transitionToTerminal: () => false,
  };
});
vi.mock('./modules/orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: () => undefined,
}));
vi.mock('./modules/orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalSpawnOutboundSeenAt: () => null,
    decideTaskAction: () => (h.watchdogAction ? { action: h.watchdogAction } : { action: 'ok' }),
  };
});
vi.mock('./storage-maintenance-worker.js', () => ({
  runStorageMaintenanceInBackground: async () => null,
  stopStorageMaintenanceWorker: () => undefined,
}));
vi.mock('./storage-pressure-alert.js', () => ({ handleStoragePressureAlert: () => undefined }));
vi.mock('./modules/claims/reconcile.js', () => ({ reconcileMergedClaims: async () => undefined }));
vi.mock('./modules/claims/self-heal.js', () => ({ sweepClaimsSelfHeal: async () => undefined }));
vi.mock('./repo-fence-recovery.js', () => ({ sweepOrphanedRepoIngressFences: async () => null }));
vi.mock('./db/channel-ingress-receipts.js', () => ({ pruneChannelIngressReceipts: () => undefined }));
vi.mock('./db/usage.js', () => ({ rollupSessionUsage: () => 0, pruneOldTurnUsage: () => undefined }));
vi.mock('./github-app-token.js', () => ({ refreshExpiringGitHubAppTokens: async () => undefined }));
vi.mock('./modules/approvals/index.js', () => ({ sweepAwaitingReasonRejects: async () => undefined }));
vi.mock('./dashboard/session-title-sweep.js', () => ({ runSessionTitleSweep: async () => undefined }));
vi.mock('./topic-title.js', () => ({ retryPendingThreadTitles: async () => undefined }));
vi.mock('./dashboard/db/dashboard-tokens.js', () => ({ pruneDashboardTokens: () => undefined }));
vi.mock('./container-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-config.js')>();
  return { ...real, readContainerConfig: () => ({}) };
});
vi.mock('./provider-fallback.js', () => ({
  resolveSpawnProvider: () => ({ provider: 'claude', primaryProvider: 'claude' }),
}));
vi.mock('./db/provider-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db/provider-health.js')>();
  return { ...real, markProviderUnavailable: () => undefined };
});
vi.mock('./db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
  }),
}));

import { registerAgentMailbox, resetAgentMailboxForTesting } from './mailbox/index.js';
import {
  SWEEP_DUTY_INVENTORY,
  SWEEP_PHASES,
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
  _sweepOnceForTesting,
  registerSlaObservationHook,
  registerSweepDuty,
  registerSweepKillFollowUp,
  type SweepDuty,
  type SweepSessionContext,
  type SweepTickContext,
} from './host-sweep.js';
import { log } from './log.js';
import { SessionDbMissingError, SessionDbUnopenableError } from './modules/mailbox/index.js';
import { _mailboxSessionDepthForTesting } from './modules/mailbox/session.js';

probe.depth = _mailboxSessionDepthForTesting;

// ── fixtures ─────────────────────────────────────────────────────────────────

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

/**
 * Every mailbox member the driver or a built-in duty reaches for on the paths
 * these cases drive. A member that is missing fails loudly as "not a function"
 * rather than silently answering undefined.
 */
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
    insertDeferredMessageWithContextIfNew: () => true,
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
  session: async <T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> => {
    h.opens.push(key.sessionId);
    if (h.failNextOpen) {
      const err = h.failNextOpen;
      h.failNextOpen = null;
      throw err;
    }
    return action(h.mailbox as unknown as MailboxSession);
  },
};

function probeDuty(
  name: string,
  phase: SweepDuty['phase'],
  order: number,
  seen: string[],
  extra: Partial<SweepDuty> = {},
): SweepDuty {
  return {
    name,
    phase,
    order,
    run: () => {
      seen.push(name);
    },
    ...extra,
  };
}

describe('sweep duty registry (S2-PR2)', () => {
  beforeEach(() => {
    resetAgentMailboxForTesting();
    registerAgentMailbox(() => fakeStore);
    h.selfHeal = false;
    h.sessions = [];
    h.running = new Set();
    h.spawnedAtMs = 0;
    h.heartbeatFile = path.join(h.dataDir, 'no-such-heartbeat');
    h.wakeResult = true;
    h.kills = [];
    h.opensAtKill = [];
    h.wakes = [];
    // Truncate, never reassign: the tripwire factory closed over THIS array.
    h.spawns.length = 0;
    h.watchdogAction = null;
    h.exists = true;
    h.opens = [];
    h.failNextOpen = null;
    h.mailbox = fakeMailbox();
  });

  afterEach(() => {
    _resetSweepRegistryForTesting();
    vi.restoreAllMocks();
  });

  /**
   * The steady state the parameterized error cases drive: alive, outbound
   * present, nothing due. Ids are unique per call — `quietSessions` is a
   * module-level Map with a 30-minute bound, so a session another case backed
   * off would be skipped here for the rest of the file.
   */
  let sessionSeq = 0;
  function aliveSession(id = `sess-${++sessionSeq}`): Session {
    const session = fakeSession(id);
    h.sessions = [session];
    h.running.add(id);
    return session;
  }

  // ── R-1 ────────────────────────────────────────────────────────────────────
  it('duties run in SWEEP_PHASES order and by order within a phase', async () => {
    _resetSweepRegistryForTesting({ builtins: false });
    const seen: string[] = [];
    const session = fakeSession('sess-order');
    h.sessions = [session];
    h.running.add(session.id);

    // Registered out of order on purpose, and interleaved within each phase.
    registerSweepDuty(probeDuty('tail-20', 'session:tail', 20, seen));
    registerSweepDuty(probeDuty('house-10', 'tick:housekeeping', 10, seen));
    registerSweepDuty(probeDuty('plan-20', 'session:plan', 20, seen));
    registerSweepDuty(probeDuty('pre-10', 'tick:pre-session', 10, seen));
    registerSweepDuty(probeDuty('post-20', 'tick:post-session', 20, seen));
    registerSweepDuty(probeDuty('health-40', 'session:health', 40, seen));
    registerSweepDuty(probeDuty('wake-10', 'session:wake', 10, seen));
    registerSweepDuty(probeDuty('tail-10', 'session:tail', 10, seen));
    registerSweepDuty(probeDuty('plan-10', 'session:plan', 10, seen));
    registerSweepDuty(probeDuty('post-10', 'tick:post-session', 10, seen));
    registerSweepDuty(probeDuty('house-5', 'tick:housekeeping', 5, seen));

    await _sweepOnceForTesting();

    expect(seen).toEqual([
      'pre-10',
      'plan-10',
      'plan-20',
      'wake-10',
      'health-40',
      'tail-10',
      'tail-20',
      'post-10',
      'post-20',
      'house-5',
      'house-10',
    ]);
    // The declared list is what the driver walks, in exactly that order.
    expect(SWEEP_PHASES).toEqual([
      'tick:pre-session',
      'session:plan',
      'session:wake',
      'session:health',
      'session:tail',
      'tick:post-session',
      'tick:housekeeping',
    ]);
    expect(h.spawns).toEqual([]);
  });

  // ── R-2 ────────────────────────────────────────────────────────────────────
  it('a duplicate (phase, order) pair is a registration error, and claims() is required exactly in exclusive phases', () => {
    _resetSweepRegistryForTesting({ builtins: false });
    const seen: string[] = [];

    registerSweepDuty(probeDuty('first', 'tick:housekeeping', 10, seen));
    expect(() => registerSweepDuty(probeDuty('second', 'tick:housekeeping', 10, seen))).toThrow(
      /already held by first/,
    );

    // The single fallthrough is legal; a second no-claims duty in an exclusive
    // phase is not — that is the if/else-if chain losing its else.
    registerSweepDuty(probeDuty('sla-fallthrough', 'session:health', 40, seen));
    expect(() => registerSweepDuty(probeDuty('second-fallthrough', 'session:health', 50, seen))).toThrow(
      /already has a fallthrough \(sla-fallthrough\)/,
    );
    expect(() =>
      registerSweepDuty(probeDuty('predicated', 'session:health', 10, seen, { claims: () => true })),
    ).not.toThrow();

    // An 'all' phase runs every duty, so a predicate there would be silently ignored.
    expect(() =>
      registerSweepDuty(probeDuty('predicated-all', 'session:tail', 10, seen, { claims: () => true })),
    ).toThrow(/claims\(\) is forbidden/);
  });

  // ── R-2b ───────────────────────────────────────────────────────────────────
  it('the driver is session-major: session A completes every phase and yields before session B starts', async () => {
    _resetSweepRegistryForTesting({ builtins: false });
    const seen: string[] = [];
    h.sessions = [fakeSession('A'), fakeSession('B')];
    h.running.add('A');
    h.running.add('B');

    const label = (phase: string) => (ctx: SweepTickContext | SweepSessionContext) => {
      seen.push(`${(ctx as SweepSessionContext).session.id}-${phase}`);
    };
    registerSweepDuty({ name: 'p', phase: 'session:plan', order: 10, run: label('plan') });
    registerSweepDuty({ name: 'w', phase: 'session:wake', order: 10, run: label('wake') });
    registerSweepDuty({ name: 't', phase: 'session:tail', order: 10, run: label('tail') });
    registerSweepDuty({
      name: 'pre',
      phase: 'tick:pre-session',
      order: 10,
      run: () => {
        seen.push('tick-pre');
      },
    });
    registerSweepDuty({
      name: 'post',
      phase: 'tick:post-session',
      order: 10,
      run: () => {
        seen.push('tick-post');
      },
    });

    await _sweepOnceForTesting();

    expect(seen).toEqual(['tick-pre', 'A-plan', 'A-wake', 'A-tail', 'B-plan', 'B-wake', 'B-tail', 'tick-post']);
    // Not phase-major: A's whole sequence precedes B's first phase.
    expect(seen.indexOf('A-tail')).toBeLessThan(seen.indexOf('B-plan'));
    // The tick phases ran exactly once each, around the loop.
    expect(seen.filter((s) => s === 'tick-pre')).toHaveLength(1);
    expect(seen.filter((s) => s === 'tick-post')).toHaveLength(1);
    expect(h.spawns).toEqual([]);
  });

  // ── R-3 ────────────────────────────────────────────────────────────────────
  it('one getActiveSessions call per tick regardless of duty count', async () => {
    _resetSweepRegistryForTesting({ builtins: false });
    const sessionsModule = await import('./db/sessions.js');
    const scan = vi.spyOn(sessionsModule, 'getActiveSessions');
    h.sessions = [fakeSession('A'), fakeSession('B')];
    const seenRefs: unknown[] = [];
    const capture = (ctx: SweepTickContext) => {
      seenRefs.push(ctx.sessions);
    };
    registerSweepDuty({ name: 'a', phase: 'session:plan', order: 10, run: capture });
    registerSweepDuty({ name: 'b', phase: 'tick:post-session', order: 10, run: capture });
    registerSweepDuty({ name: 'c', phase: 'tick:housekeeping', order: 10, run: capture });

    await _sweepOnceForTesting();

    expect(scan).toHaveBeenCalledTimes(1);
    // Four reads (two sessions × the plan duty, plus the two tick duties), one array.
    expect(seenRefs).toHaveLength(4);
    for (const ref of seenRefs) expect(ref).toBe(seenRefs[0]);
    expect(h.spawns).toEqual([]);
  });

  // ── R-4 ────────────────────────────────────────────────────────────────────
  describe('a duty that throws in any window logs Host sweep duty failed and the session is never quiet-cached', () => {
    const windows: Array<{
      label: string;
      window: string;
      arm: (boom: () => never) => void;
    }> = [
      {
        label: 'session:plan',
        window: 'session:plan',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:plan', order: 15, run: boom }),
      },
      {
        label: 'session:wake',
        window: 'session:wake',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:wake', order: 20, run: boom }),
      },
      {
        label: 'the driver observe read (a claims() consulting ctx.observed)',
        window: 'session:health',
        arm: (boom) =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:health',
            order: 5,
            claims: (ctx) => {
              expect(ctx.observed).not.toBeNull();
              return boom();
            },
            run: () => undefined,
          }),
      },
      {
        label: 'session:health',
        window: 'session:health',
        arm: (boom) =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:health',
            order: 5,
            claims: () => true,
            run: boom,
          }),
      },
      {
        label: 'session:tail',
        window: 'session:tail',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:tail', order: 15, run: boom }),
      },
      {
        label: 'the SLA observation hook list',
        window: 'session:health:sla-observe',
        arm: (boom) => registerSlaObservationHook({ name: 'probe', order: 99, run: boom }),
      },
    ];

    for (const { label, window, arm } of windows) {
      it(`in ${label}`, async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const session = aliveSession();
        arm((): never => {
          throw new Error('duty boom');
        });

        await _sweepOnceForTesting();

        expect(error).toHaveBeenCalledWith(
          'Host sweep duty failed',
          expect.objectContaining({ sessionId: session.id, duty: 'probe', window }),
        );
        expect(error).not.toHaveBeenCalledWith('Host sweep mailbox unopenable', expect.anything());
        // Not quiet-cached: the mailbox is fine and the work is still due, so
        // the very next tick sweeps it again.
        h.opens = [];
        await _sweepOnceForTesting();
        expect(h.opens.length).toBeGreaterThan(0);
        expect(h.spawns).toEqual([]);
      });
    }

    it('in the kill follow-up list', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      const session = aliveSession();
      armCeilingKill();
      registerSweepKillFollowUp({
        name: 'probe',
        order: 99,
        run: () => {
          throw new Error('duty boom');
        },
      });

      await _sweepOnceForTesting();

      expect(h.kills.map((k) => k.reason)).toContain('absolute-ceiling');
      expect(error).toHaveBeenCalledWith(
        'Host sweep duty failed',
        expect.objectContaining({ sessionId: session.id, duty: 'probe', window: 'session:health:post-kill' }),
      );
      expect(h.spawns).toEqual([]);
    });
  });

  /** Heartbeat older than the ceiling → decideStuckAction returns kill-ceiling. */
  function armCeilingKill(): void {
    const hb = path.join(h.dataDir, `hb-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(hb, 'x');
    const old = Date.now() - 90 * 60_000;
    fs.utimesSync(hb, new Date(old), new Date(old));
    h.heartbeatFile = hb;
  }

  // ── R-5 ────────────────────────────────────────────────────────────────────
  describe('an unopenable mailbox backs the session off at W1 and only at W1', () => {
    it('W1: logs Host sweep mailbox unopenable and takes the quiet mark', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      const session = aliveSession();
      h.failNextOpen = new SessionDbUnopenableError('/tmp/inbound.db', new Error('boom'));

      await _sweepOnceForTesting();

      expect(error).toHaveBeenCalledWith(
        'Host sweep mailbox unopenable',
        expect.objectContaining({ sessionId: session.id, window: 'session:plan' }),
      );
      expect(error).not.toHaveBeenCalledWith('Host sweep duty failed', expect.anything());
      // Backed off: the next tick skips the session entirely.
      h.opens = [];
      await _sweepOnceForTesting();
      expect(h.opens).toEqual([]);
      expect(h.spawns).toEqual([]);
    });

    const laterWindows: Array<{ label: string; window: string; arm: () => void }> = [
      {
        label: 'session:wake',
        window: 'session:wake',
        arm: () =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:wake',
            order: 20,
            run: async (ctx) => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/inbound.db', new Error('boom'));
              await (ctx as SweepSessionContext).run(() => undefined);
            },
          }),
      },
      {
        label: 'the driver observe read',
        window: 'session:observe',
        arm: () =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:plan',
            order: 90,
            run: () => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/outbound.db', new Error('boom'));
            },
          }),
      },
      {
        label: 'the SLA observe session',
        window: 'session:health:sla-observe',
        // Order 35 — after every other predicate has had its own opens, and
        // immediately before the SLA fallthrough at 40.
        arm: () =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:health',
            order: 35,
            claims: () => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/outbound.db', new Error('boom'));
              return false;
            },
            run: () => undefined,
          }),
      },
      {
        label: 'the post-kill session',
        window: 'session:health:post-kill',
        arm: () => {
          armCeilingKill();
          registerSlaObservationHook({
            name: 'probe',
            order: 99,
            run: () => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/outbound.db', new Error('boom'));
            },
          });
        },
      },
      {
        label: 'session:tail',
        window: 'session:tail',
        arm: () =>
          registerSweepDuty({
            name: 'probe',
            phase: 'session:health',
            order: 5,
            claims: () => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/inbound.db', new Error('boom'));
              return true;
            },
            run: () => undefined,
          }),
      },
    ];

    for (const { label, window, arm } of laterWindows) {
      it(`${label}: same string with its window field, and no quiet mark`, async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const session = aliveSession();
        arm();

        await _sweepOnceForTesting();

        expect(error).toHaveBeenCalledWith(
          'Host sweep mailbox unopenable',
          expect.objectContaining({ sessionId: session.id, window }),
        );
        // Single-cause: one failure never emits both gate strings.
        expect(error).not.toHaveBeenCalledWith('Host sweep duty failed', expect.anything());
        // No backoff — W1 already proved the mailbox openable this tick.
        h.opens = [];
        h.failNextOpen = null;
        await _sweepOnceForTesting();
        expect(h.opens.length).toBeGreaterThan(0);
        expect(h.spawns).toEqual([]);
      });
    }
  });

  // ── R-6 ────────────────────────────────────────────────────────────────────
  describe('a vanished mailbox backs off silently at any window', () => {
    it('W1: quiet mark, and no error line of either string', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      aliveSession();
      h.failNextOpen = new SessionDbMissingError('/gone/inbound.db');

      await _sweepOnceForTesting();

      expect(error).not.toHaveBeenCalledWith('Host sweep mailbox unopenable', expect.anything());
      expect(error).not.toHaveBeenCalledWith('Host sweep duty failed', expect.anything());
      h.opens = [];
      await _sweepOnceForTesting();
      expect(h.opens).toEqual([]);
      expect(h.spawns).toEqual([]);
    });

    it('after W1: a mid-tick vanish is retried, not treated as a fault', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      aliveSession();
      registerSweepDuty({
        name: 'probe',
        phase: 'session:plan',
        order: 90,
        run: () => {
          h.failNextOpen = new SessionDbMissingError('/gone/outbound.db');
        },
      });

      await _sweepOnceForTesting();

      expect(error).not.toHaveBeenCalledWith('Host sweep mailbox unopenable', expect.anything());
      expect(error).not.toHaveBeenCalledWith('Host sweep duty failed', expect.anything());
      // Retried, not backed off.
      h.opens = [];
      h.failNextOpen = null;
      await _sweepOnceForTesting();
      expect(h.opens.length).toBeGreaterThan(0);
      expect(h.spawns).toEqual([]);
    });
  });

  // ── R-7 ────────────────────────────────────────────────────────────────────
  it('the registered duty set matches the seam-2 inventory', () => {
    const { duties, slaObservationHooks, killFollowUps } = _listSweepRegistrationsForTesting();
    const registrations = [...duties, ...slaObservationHooks, ...killFollowUps];

    expect(registrations).toHaveLength(39);
    const names = new Set(registrations.map((r) => r.name));
    expect(names.size).toBe(38);
    expect(names).toEqual(new Set(Object.values(SWEEP_DUTY_INVENTORY)));
    expect(Object.keys(SWEEP_DUTY_INVENTORY)).toHaveLength(38);
    // The one duty registered twice is the orphan-claim reset: once in the tail
    // window, once as the post-kill follow-up (rev-3 grounding §2, S17).
    const twice = registrations.filter((r) => r.name === SWEEP_DUTY_INVENTORY.S17);
    expect(twice).toHaveLength(2);
  });

  // ── R-9 ────────────────────────────────────────────────────────────────────
  // Placed here rather than in host-sweep.test.ts (plan §8 names that file):
  // the quiet cache lives in the tick, and driving a whole tick needs the mock
  // set above. host-sweep.test.ts has no such set, so a tick there would reach
  // docker, GitHub and an LLM — the hermeticity rule wins over file placement.
  describe('quiet-session cache keeps its time bound and last_active invalidation', () => {
    it('a fully quiet session is skipped until the earlier of its next due row and 30 minutes', async () => {
      const session = fakeSession('sess-quiet');
      h.sessions = [session];
      h.mailbox = fakeMailbox({ getNextFutureProcessAfter: () => null });

      await _sweepOnceForTesting();
      expect(h.opens.length).toBeGreaterThan(0);

      // Second tick: skipped entirely, no mailbox opened.
      h.opens = [];
      await _sweepOnceForTesting();
      expect(h.opens).toEqual([]);

      // A due row sooner than the cap shortens the skip.
      _resetSweepRegistryForTesting();
      const soon = new Date(Date.now() + 5_000).toISOString();
      h.mailbox = fakeMailbox({ getNextFutureProcessAfter: () => soon });
      const nudged = fakeSession('sess-quiet-due', { last_active: '2026-04-20T13:00:00.000Z' });
      h.sessions = [nudged];
      h.opens = [];
      await _sweepOnceForTesting();
      expect(h.opens).toContain(nudged.id);
      // Past its next due row but well inside the 30-minute cap: swept again.
      h.opens = [];
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + 10_000);
      await _sweepOnceForTesting();
      vi.useRealTimers();
      expect(h.opens).toContain(nudged.id);
      expect(h.spawns).toEqual([]);
    });

    it('a last_active change invalidates the mark immediately', async () => {
      const session = fakeSession('sess-invalidate');
      h.sessions = [session];

      await _sweepOnceForTesting();
      h.opens = [];
      await _sweepOnceForTesting();
      expect(h.opens).toEqual([]);

      h.sessions = [fakeSession('sess-invalidate', { last_active: '2026-04-20T13:30:00.000Z' })];
      await _sweepOnceForTesting();
      expect(h.opens).toContain('sess-invalidate');
      expect(h.spawns).toEqual([]);
    });
  });

  // ── R-10 ───────────────────────────────────────────────────────────────────
  describe('every real wake and kill runs at mailbox depth zero', () => {
    it('W2 wakeContainer', async () => {
      const session = fakeSession('sess-wake');
      h.sessions = [session];
      h.mailbox = fakeMailbox({ countDueMessages: () => 1 });

      await _sweepOnceForTesting();

      expect(h.wakes).toEqual([{ sessionId: 'sess-wake', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });

    it('the task watchdog’s parent wake', async () => {
      const { _sweepTaskWatchdogForTesting } = await import('./host-sweep.js');
      const tasksModule = await import('./modules/orchestrator-dispatch/db/tasks.js');
      const parent = fakeSession('sess-parent');
      h.sessions = [parent];
      h.watchdogAction = 'fail-deadline';
      vi.spyOn(tasksModule, 'getActiveTasks').mockReturnValue([
        {
          task_id: 't1',
          parent_agent_group_id: 'ag-1',
          parent_session_id: 'sess-parent',
          child_session_id: null,
        },
      ] as never);
      vi.spyOn(tasksModule, 'transitionToTerminal').mockReturnValue(true);

      await _sweepTaskWatchdogForTesting();

      expect(h.wakes).toEqual([{ sessionId: 'sess-parent', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });

    it('provider self-heal: the heal kill, its onExit wake, and the parked kill', async () => {
      h.selfHeal = true;
      aliveSession('sess-heal');
      h.mailbox = fakeMailbox({
        getContainerState: () => ({ provider_status: 'failed', provider_failure_reason: 'gone' }),
      });

      // Two consecutive 'failed' observations are required before it acts.
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([]);
      h.running.add('sess-heal');
      await _sweepOnceForTesting();

      expect(h.kills).toEqual([{ sessionId: 'sess-heal', reason: 'provider-failed-selfheal', depth: 0 }]);
      // killForProviderHeal's onExit respawn, still at depth zero.
      expect(h.wakes).toEqual([{ sessionId: 'sess-heal', depth: 0 }]);

      // Budget spent → the park branch kills without a respawn.
      h.kills = [];
      h.wakes = [];
      h.running.add('sess-heal');
      h.mailbox = fakeMailbox({
        getContainerState: () => ({ provider_status: 'failed', provider_failure_reason: 'gone' }),
        countRecoveryAttemptsSinceRealInbound: () => 2,
      });
      await _sweepOnceForTesting();
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([{ sessionId: 'sess-heal', reason: 'provider-failed-selfheal-parked', depth: 0 }]);
      expect(h.wakes).toEqual([]);
      expect(h.spawns).toEqual([]);
    });

    it('the two idle reaps', async () => {
      const task = fakeSession('sess-task', { thread_id: 'system:tasks:series-1' });
      h.sessions = [task];
      h.running.add(task.id);
      h.mailbox = fakeMailbox({ getContainerState: () => ({ provider_executing: 0 }) });
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([{ sessionId: 'sess-task', reason: 'scheduled-task-idle', depth: 0 }]);

      h.kills = [];
      const chat = fakeSession('sess-chat');
      h.sessions = [chat];
      h.running.add(chat.id);
      h.mailbox = fakeMailbox({
        getContainerState: () => ({ provider_executing: 0 }),
        latestOutboundTimestamp: () => new Date(Date.now() - 60 * 60_000).toISOString(),
        latestInboundTimestamp: () => new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([{ sessionId: 'sess-chat', reason: 'chat-idle-reap', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });

    it('the SLA’s absolute-ceiling and claim-stuck kills', async () => {
      aliveSession('sess-ceiling');
      armCeilingKill();
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([{ sessionId: 'sess-ceiling', reason: 'absolute-ceiling', depth: 0 }]);

      h.kills = [];
      const stuck = fakeSession('sess-stuck');
      h.sessions = [stuck];
      h.running.add(stuck.id);
      h.heartbeatFile = path.join(h.dataDir, 'no-such-heartbeat');
      const claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      h.mailbox = fakeMailbox({
        getProcessingClaimRows: () => [{ message_id: 'm1', status_changed: claimedAt }],
      });
      await _sweepOnceForTesting();
      expect(h.kills).toEqual([{ sessionId: 'sess-stuck', reason: 'claim-stuck', depth: 0 }]);
      expect(h.spawns).toEqual([]);
    });
  });

  // ── R-11 ───────────────────────────────────────────────────────────────────
  it('kill follow-ups run in order in a session opened only after the kill returns', async () => {
    aliveSession('sess-followups');
    armCeilingKill();
    const seen: string[] = [];
    const openCountAtRun: number[] = [];
    for (const order of [230, 210, 220]) {
      registerSweepKillFollowUp({
        name: `probe-${order}`,
        order,
        run: () => {
          seen.push(`probe-${order}`);
          openCountAtRun.push(h.opens.length);
        },
      });
    }

    await _sweepOnceForTesting();

    expect(h.kills.map((k) => k.reason)).toEqual(['absolute-ceiling']);
    // Registered 230, 210, 220 — run 210, 220, 230, after the three built-in
    // follow-ups, all inside ONE session opened after the kill.
    expect(seen).toEqual(['probe-210', 'probe-220', 'probe-230']);
    // One session for all of them...
    expect(new Set(openCountAtRun).size).toBe(1);
    // ...and it was opened strictly AFTER killContainer returned: the open
    // count when the follow-ups ran is exactly one more than at the kill.
    expect(openCountAtRun[0]).toBe(h.opensAtKill[0]! + 1);
    expect(h.spawns).toEqual([]);
  });

  // ── R-12 ───────────────────────────────────────────────────────────────────
  it('a swept session opens no more windows than the PR 5 baseline', async () => {
    // Worst path: W1, the wake attempt increment, the driver observe read, the
    // provider-heal budget read, the provider-heal action, the SLA observe, the
    // SLA post-kill, W5. plan.md §1 bounds that at EIGHT.
    h.selfHeal = true;
    const session = aliveSession('sess-budget');
    armCeilingKill();
    h.wakeResult = false; // forces the attempt restore, the extra open
    h.mailbox = fakeMailbox({
      countDueMessages: () => 1,
      getContainerState: () => ({ provider_status: 'failed', provider_failure_reason: 'gone' }),
      readWorkContinuation: () => ({ id: 'c1', task: 't', resume_attempts: 0, recovery_episode: 0 }),
      incrementWorkContinuationResumeAttempt: () => ({ id: 'c1', task: 't', resume_attempts: 1, recovery_episode: 0 }),
      getProcessingClaimRows: () => [],
    });

    await _sweepOnceForTesting();
    const worstPathOpens = h.opens.filter((id) => id === session.id).length;
    expect(worstPathOpens).toBeGreaterThan(0);
    expect(worstPathOpens).toBeLessThanOrEqual(8);

    // A quiet session opens ZERO — the bound the whole cache exists for.
    _resetSweepRegistryForTesting();
    h.selfHeal = false;
    h.heartbeatFile = path.join(h.dataDir, 'no-such-heartbeat');
    h.mailbox = fakeMailbox();
    const quiet = fakeSession('sess-quiet-budget');
    h.sessions = [quiet];
    h.running.delete(quiet.id);
    await _sweepOnceForTesting();
    h.opens = [];
    await _sweepOnceForTesting();
    expect(h.opens).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  // ── Tripwire self-check (brief-common.md HARD RULE step 3) ─────────────────
  it('the child_process tripwire bites when a seam mock is removed', async () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });

  it('a fixture path never leaves the per-run temp root', () => {
    expect(h.dataDir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(h.dataDir)).toBe(true);
  });
});
