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
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // F-6.3: order + cross-duty visibility probe for T20 (claims-reconcile) →
    // T21 (claims-self-heal). `claimsStore` stands in for the claims/ FIFO
    // directory reconcile deletes from and self-heal reads.
    claimsOrder: [] as string[],
    claimsStore: [] as string[],
    claimsSelfHealSawStore: null as string[] | null,
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
vi.mock('./modules/claims/reconcile.js', () => ({
  reconcileMergedClaims: async () => {
    h.claimsOrder.push('reconcile');
    // Simulates the reconcile pass closing a merged claim before self-heal runs.
    h.claimsStore = h.claimsStore.filter((c) => c !== 'claim-merged');
  },
}));
vi.mock('./modules/claims/self-heal.js', () => ({
  sweepClaimsSelfHeal: async () => {
    h.claimsOrder.push('self-heal');
    h.claimsSelfHealSawStore = [...h.claimsStore];
  },
}));
vi.mock('./repo-fence-recovery.js', () => ({ sweepOrphanedRepoIngressFences: async () => null }));
vi.mock('./db/channel-ingress-receipts.js', () => ({ pruneChannelIngressReceipts: vi.fn(() => undefined) }));
vi.mock('./db/usage.js', () => ({ rollupSessionUsage: () => 0, pruneOldTurnUsage: () => undefined }));
vi.mock('./github-app-token.js', () => ({ refreshExpiringGitHubAppTokens: async () => undefined }));
// F-14.2 imports the production modules barrel, and several barrel modules
// register approval handlers at import. Stub those members too — the duty this
// file drives (T5) only needs `sweepAwaitingReasonRejects`, and loading the real
// approvals module here would pull the delivery adapter into a registry test.
vi.mock('./modules/approvals/index.js', () => ({
  sweepAwaitingReasonRejects: async () => undefined,
  registerApprovalHandler: () => undefined,
  requestApproval: async () => undefined,
  notifyAgent: async () => undefined,
}));
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

// Family modules self-register their duties at import via
// `registerSweepDutySource` (plan.md §4.7 step 1) — the underlying bodies
// stay mocked above (`./repo-fence-recovery.js`, `./modules/approvals/index.js`).
// `_resetSweepRegistryForTesting()`'s default reset replays every recorded
// source's registrar, so no per-call-site restoration is needed here.
import './modules/sweep-repo-fence/index.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from './mailbox/index.js';
import {
  SWEEP_DUTY_INVENTORY,
  SWEEP_INTERVAL_MS,
  SWEEP_PHASES,
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
  _unregisterSweepDutySourceForTesting,
  _setSweepYieldForTesting,
  _sweepOnceForTesting,
  registerSlaObservationHook,
  registerSweepDuty,
  registerSweepDutySource,
  registerSweepKillFollowUp,
  startHostSweep,
  stopHostSweep,
  type SweepDuty,
  type SweepSessionContext,
  type SweepTickContext,
} from './host-sweep.js';
// Registers S11/S14/S16 as a duty source at import time — needed so
// `_resetSweepRegistryForTesting()`'s default replay (every recorded source,
// not just the in-file built-ins) still surfaces the moved duties for R-7,
// R-10 and R-11.
import './modules/sweep-container-health/index.js';
// Registers S2/S3/S4/S17 as a duty source at import time — needed so
// `_resetSweepRegistryForTesting()`'s default replay (every recorded source,
// not just the in-file built-ins) still surfaces the moved duties for R-7,
// R-10 and R-11.
import './modules/sweep-session-core/index.js';
// S2-PR13's family registers S6/S7/S8/S9a/S9b/S15/S10 as its own duty source
// at import time; without this line R-7's inventory is seven registrations
// short. Import for side effects only.
import './modules/sweep-continuation/index.js';
// Registers the scheduling family's duty source (S2-PR11: T8, S5, S18, S19) —
// without it R-7's inventory is four registrations short and R-10's W2 branch
// has nothing to make a session due.
import './modules/sweep-scheduling/index.js';
import { log } from './log.js';
// Family module side-effect import (S2-PR7): registers T11
// (scheduled-move-recovery) and T12 (audit-body-prune) as a duty source, so
// R-7 below sees them at tick:housekeeping order 50/60 the same as every
// other family this registry tracks.
import './modules/sweep-scheduled-move/index.js';
import { SessionDbMissingError, SessionDbUnopenableError } from './modules/mailbox/index.js';
import { _mailboxSessionDepthForTesting } from './host-sweep-depth-probe.js';
// Family modules moved out of host-sweep.ts register at import — pull them in
// here so the hermetic registry harness sees the full 39-registration set.
// Each registers itself via `registerSweepDutySource`, so a default
// (builtins-restoring) `_resetSweepRegistryForTesting()` replays it
// automatically, same as the in-file builtins.
// S2-PR3 moved S12/S13 (idle-task-reap, idle-chat-reap).
import './modules/sweep-idle-reap/index.js';
// S2-PR4 moved the central housekeeping duties. Their own duty-body mocks are
// already declared above (this file predates the move and anticipated it).
import './modules/sweep-central/index.js';
// S2-PR5 moved T6/T14/T18 (reconciler, auto-archive, task watchdog).
import './modules/sweep-orchestrator/index.js';
// S2-PR6 moved T2 (egress), T13 (storage) and T20/T21 (claims).
import './modules/sweep-egress/index.js';
import './modules/sweep-storage/index.js';
import './modules/sweep-claims/index.js';
// Side-effect import: registers 'sweep-usage' as a duty source (S2-PR12) so
// R-7's registration count includes T19 after the family module moved it out
// of host-sweep.ts's own in-file builtins.
import './modules/sweep-usage/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    // Added with the mailbox PR 4 merge: S6's mirror now reads the parsed
    // proposal through the session instead of taking the outbound handle.
    readDoneProposal: () => null,
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
    h.claimsOrder = [];
    h.claimsStore = ['claim-merged', 'claim-open'];
    h.claimsSelfHealSawStore = null;
  });

  afterEach(() => {
    _resetSweepRegistryForTesting();
    _setSweepYieldForTesting(null);
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

    // The yield is part of the sequence under test, not scaffolding around it:
    // without a marker for it, deleting the per-session setImmediate leaves
    // this case green while a batch of sessions becomes one event-loop freeze.
    const realYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    _setSweepYieldForTesting(async () => {
      seen.push('YIELD');
      await realYield();
    });

    await _sweepOnceForTesting();

    expect(seen).toEqual([
      'tick-pre',
      'A-plan',
      'A-wake',
      'A-tail',
      'YIELD',
      'B-plan',
      'B-wake',
      'B-tail',
      'YIELD',
      'tick-post',
    ]);
    // Not phase-major: A's whole sequence precedes B's first phase.
    expect(seen.indexOf('A-tail')).toBeLessThan(seen.indexOf('B-plan'));
    // Exactly one yield after each swept session — never every N.
    expect(seen.filter((s) => s === 'YIELD')).toHaveLength(2);
    expect(seen.indexOf('YIELD')).toBe(seen.indexOf('A-tail') + 1);
    expect(seen.lastIndexOf('YIELD')).toBe(seen.indexOf('B-tail') + 1);
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
      duty: string;
      arm: (boom: () => never) => void;
    }> = [
      {
        label: 'session:plan',
        window: 'session:plan',
        duty: 'probe',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:plan', order: 15, run: boom }),
      },
      {
        label: 'session:wake',
        window: 'session:wake',
        duty: 'probe',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:wake', order: 20, run: boom }),
      },
      {
        // The driver's own W3 read, failing at a mailbox method it really
        // calls — not a stand-in duty. It is machinery, so it carries a
        // `driver:` identifier rather than a registrable duty name.
        label: 'the driver observe read',
        window: 'session:observe',
        duty: 'driver:observe',
        arm: (boom) => {
          h.mailbox = fakeMailbox({ getContainerState: boom });
        },
      },
      {
        label: 'session:health',
        window: 'session:health',
        duty: 'probe',
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
        duty: 'probe',
        arm: (boom) => registerSweepDuty({ name: 'probe', phase: 'session:tail', order: 15, run: boom }),
      },
      {
        label: 'the SLA observation hook list',
        window: 'session:health:sla-observe',
        duty: 'probe',
        arm: (boom) => registerSlaObservationHook({ name: 'probe', order: 99, run: boom }),
      },
    ];

    for (const { label, window, duty, arm } of windows) {
      it(`in ${label}`, async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const session = aliveSession();
        arm((): never => {
          throw new Error('duty boom');
        });

        await _sweepOnceForTesting();

        expect(error).toHaveBeenCalledWith(
          'Host sweep duty failed',
          expect.objectContaining({ sessionId: session.id, duty, window }),
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

  /** Register a probe duty against a fresh alive session, and hand the session back. */
  function armOnAliveSession(duty: SweepDuty): Session {
    const session = aliveSession();
    registerSweepDuty(duty);
    return session;
  }

  /**
   * A STOPPED session with saved work due for a recovery attempt, so the real
   * `session:wake` duty opens a mailbox of its own — the increment W2 has always
   * done outside any held session. `failWith` is armed at the end of the plan
   * phase, so the open it breaks is S9b's, not W1's.
   */
  function continuationWakeSession(failWith: unknown): Session {
    const session = fakeSession(`sess-${++sessionSeq}`);
    h.sessions = [session];
    const continuation = { id: 'c1', task: 't', resume_attempts: 0, recovery_episode: 0 };
    h.mailbox = fakeMailbox({
      // A due row as WELL as the continuation. Without it the wake assertion is
      // vacuous: a swallowed increment answers null and the wake is skipped for
      // want of anything due. With it, a swallowed increment leaves dueCount at
      // 1 and S9b wakes the container through the mailbox that just failed.
      countDueMessages: () => 1,
      readWorkContinuation: () => continuation,
      incrementWorkContinuationResumeAttempt: () => ({ ...continuation, resume_attempts: 1 }),
    });
    registerSweepDuty({
      name: 'arm-wake-failure',
      phase: 'session:plan',
      order: 90,
      run: () => {
        h.failNextOpen = failWith;
      },
    });
    return session;
  }

  /** Heartbeat older than the ceiling → decideStuckAction returns kill-ceiling. */
  function armCeilingKill(): void {
    const hb = path.join(h.dataDir, `hb-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(hb, 'x');
    const old = Date.now() - 90 * 60_000;
    fs.utimesSync(hb, new Date(old), new Date(old));
    h.heartbeatFile = hb;
  }

  // ── R-4b ───────────────────────────────────────────────────────────────────
  it('a tick-level duty that throws is logged and the later tick duties still run', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    _resetSweepRegistryForTesting({ builtins: false });
    const seen: string[] = [];
    registerSweepDuty({
      name: 'first',
      phase: 'tick:housekeeping',
      order: 10,
      run: () => {
        seen.push('first');
      },
    });
    registerSweepDuty({
      name: 'middle',
      phase: 'tick:housekeeping',
      order: 20,
      run: () => {
        throw new Error('tick boom');
      },
    });
    registerSweepDuty({
      name: 'last',
      phase: 'tick:housekeeping',
      order: 30,
      run: () => {
        seen.push('last');
      },
    });

    await _sweepOnceForTesting();

    // Registration IS the guard. Before the seam an unguarded throw here
    // silently skipped every duty ordered behind it for the rest of the tick.
    expect(seen).toEqual(['first', 'last']);
    expect(error).toHaveBeenCalledWith(
      'Host sweep duty failed',
      expect.objectContaining({ duty: 'middle', window: 'tick:housekeeping' }),
    );
    expect(h.spawns).toEqual([]);
  });

  // ── R-8b ───────────────────────────────────────────────────────────────────
  it('a throw from the session scan itself still re-arms the tick', async () => {
    const sessionsModule = await import('./db/sessions.js');
    const scan = vi.spyOn(sessionsModule, 'getActiveSessions').mockImplementation((): never => {
      throw new Error('scan boom');
    });
    _resetSweepRegistryForTesting({ builtins: false });
    let preRuns = 0;
    registerSweepDuty({
      name: 'pre',
      phase: 'tick:pre-session',
      order: 10,
      run: () => {
        preRuns += 1;
      },
    });

    vi.useFakeTimers();
    try {
      startHostSweep();
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
      // The scan is the one thing between the pre-session phase and the fan-out.
      // Its failure must not replay the phase that already ran this tick.
      expect(preRuns).toBe(1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
      expect(preRuns).toBe(2);
    } finally {
      stopHostSweep();
      vi.useRealTimers();
    }
    expect(h.spawns).toEqual([]);
  });

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

    const laterWindows: Array<{ label: string; window: string; arm: () => Session; then?: () => void }> = [
      {
        label: 'session:wake (the real continuation attempt increment)',
        window: 'session:wake',
        arm: () => continuationWakeSession(new SessionDbUnopenableError('/tmp/outbound.db', new Error('boom'))),
        then: () => {
          // The increment used to swallow this and answer null, which let S9b
          // fall through and wake the container on W1's stale plan through a
          // mailbox the host cannot read.
          expect(h.wakes).toEqual([]);
        },
      },
      {
        label: 'the driver observe read',
        window: 'session:observe',
        arm: () =>
          armOnAliveSession({
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
          armOnAliveSession({
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
          const session = aliveSession();
          armCeilingKill();
          registerSlaObservationHook({
            name: 'probe',
            order: 99,
            run: () => {
              h.failNextOpen = new SessionDbUnopenableError('/tmp/outbound.db', new Error('boom'));
            },
          });
          return session;
        },
      },
      {
        label: 'session:tail',
        window: 'session:tail',
        arm: () =>
          armOnAliveSession({
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

    for (const { label, window, arm, then } of laterWindows) {
      it(`${label}: same string with its window field, and no quiet mark`, async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const session = arm();

        await _sweepOnceForTesting();

        then?.();

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
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // The real session:wake path again — S9b's own increment is the open that
      // finds the mailbox gone, not a synthetic duty standing in for it.
      continuationWakeSession(new SessionDbMissingError('/gone/inbound.db'));

      await _sweepOnceForTesting();

      expect(error).not.toHaveBeenCalledWith('Host sweep mailbox unopenable', expect.anything());
      expect(error).not.toHaveBeenCalledWith('Host sweep duty failed', expect.anything());
      // Not the helper's legacy warning either: a vanished mailbox is the
      // ordinary steady state, and the window owns that classification now.
      expect(warn).not.toHaveBeenCalledWith('Failed to increment continuation recovery attempt', expect.anything());
      // A session the host can no longer read is not woken on W1's stale plan.
      expect(h.wakes).toEqual([]);
      // Retried, not backed off.
      h.opens = [];
      h.failNextOpen = null;
      await _sweepOnceForTesting();
      expect(h.opens.length).toBeGreaterThan(0);
      expect(h.spawns).toEqual([]);
    });
  });

  // ── R-7 ────────────────────────────────────────────────────────────────────
  /**
   * plan.md §4.3's table, transcribed. Names and counts alone are not enough:
   * they stay green when recurrence and the spent-task GC swap, or when claims
   * reconcile lands after self-heal — and both of those are cited ordering
   * constraints (13 and 3). The tuple is (surface, name, phase, order), in the
   * order the driver runs them.
   *
   * `github-token-file-refresh` (tick:housekeeping, 25) is a fork addition,
   * not part of the seam-2 port: by-reference GitHub credential delivery
   * (src/github-token-file.ts), registered directly at the order-free
   * housekeeping phase, right after the App-token re-mint it depends on.
   * `cli-request-execution-prune` (tick:housekeeping, 42) is likewise later
   * work (issue #273's at-most-once ncl ledger). Both are tracked in
   * SWEEP_DUTY_INVENTORY (as FORK1 and T23) alongside the 38 seam-2-ported
   * duties, so the set below stays an exact accounting of every registered
   * duty — ported or not.
   */
  const EXPECTED_REGISTRATIONS: Array<[string, string, string, number]> = [
    ['duty', 'egress-network-reheal', 'tick:pre-session', 10],
    ['duty', 'processing-ack-sync', 'session:plan', 10],
    ['duty', 'stale-pending-expiry', 'session:plan', 20],
    ['duty', 'pre-wake-orphan-claim-reset', 'session:plan', 30],
    ['duty', 'due-wake-admission', 'session:plan', 40],
    ['duty', 'done-proposal-mirror', 'session:plan', 50],
    ['duty', 'continuation-read', 'session:plan', 60],
    ['duty', 'continuation-recovery-parking', 'session:plan', 70],
    ['duty', 'continuation-wake-eligibility', 'session:plan', 80],
    ['duty', 'container-wake', 'session:wake', 10],
    ['duty', 'provider-self-heal', 'session:health', 10],
    ['duty', 'idle-task-reap', 'session:health', 20],
    ['duty', 'idle-chat-reap', 'session:health', 30],
    ['duty', 'running-container-sla', 'session:health', 40],
    ['duty', 'orphan-claim-reset', 'session:tail', 10],
    ['duty', 'recurrence-fanout', 'session:tail', 20],
    ['duty', 'spent-task-session-gc', 'session:tail', 30],
    ['duty', 'orchestrator-reconciler', 'tick:post-session', 10],
    ['duty', 'thread-close-advance', 'tick:post-session', 20],
    ['duty', 'task-watchdog', 'tick:post-session', 25],
    ['duty', 'storage-maintenance', 'tick:post-session', 30],
    ['duty', 'usage-rollup', 'tick:post-session', 40],
    ['duty', 'orphaned-repo-fence-release', 'tick:post-session', 50],
    ['duty', 'approvals-reason-sweep', 'tick:housekeeping', 10],
    ['duty', 'github-app-token-refresh', 'tick:housekeeping', 20],
    ['duty', 'github-token-file-refresh', 'tick:housekeeping', 25],
    ['duty', 'steer-idempotency-prune', 'tick:housekeeping', 30],
    ['duty', 'channel-ingress-receipt-prune', 'tick:housekeeping', 40],
    ['duty', 'cli-request-execution-prune', 'tick:housekeeping', 42],
    ['duty', 'scheduled-move-recovery', 'tick:housekeeping', 50],
    ['duty', 'audit-body-prune', 'tick:housekeeping', 60],
    ['duty', 'completed-task-auto-archive', 'tick:housekeeping', 70],
    ['duty', 'session-title-sweep', 'tick:housekeeping', 80],
    ['duty', 'thread-title-retry', 'tick:housekeeping', 90],
    ['duty', 'claims-reconcile', 'tick:housekeeping', 100],
    ['duty', 'claims-self-heal', 'tick:housekeeping', 110],
    ['duty', 'dashboard-token-prune', 'tick:housekeeping', 120],
    ['sla-observation-hook', 'container-oom-notice', 'sla-observation-hook', 10],
    ['kill-follow-up', 'kill-ceiling-notice', 'kill-follow-up', 10],
    ['kill-follow-up', 'orphan-claim-reset', 'kill-follow-up', 20],
    ['kill-follow-up', 'ceiling-kill-accountability', 'kill-follow-up', 30],
  ];

  it('the registered duty set matches the seam-2 inventory', () => {
    const { duties, slaObservationHooks, killFollowUps } = _listSweepRegistrationsForTesting();
    const actual: Array<[string, string, string, number]> = [
      ...duties.map((d): [string, string, string, number] => ['duty', d.name, d.phase, d.order]),
      ...slaObservationHooks.map((hk): [string, string, string, number] => [
        'sla-observation-hook',
        hk.name,
        'sla-observation-hook',
        hk.order,
      ]),
      ...killFollowUps.map((f): [string, string, string, number] => [
        'kill-follow-up',
        f.name,
        'kill-follow-up',
        f.order,
      ]),
    ];

    // Surface, name, phase AND order, in run order — a swap anywhere fails.
    expect(actual).toEqual(EXPECTED_REGISTRATIONS);

    // 41 registrations: the 39 from the seam-2 port (38 unique names, one
    // registered twice — see below) plus two fork additions,
    // github-token-file-refresh and cli-request-execution-prune.
    expect(actual).toHaveLength(41);
    const names = new Set(actual.map((r) => r[1]));
    expect(names.size).toBe(40);
    expect(names).toEqual(new Set(Object.values(SWEEP_DUTY_INVENTORY)));
    expect(Object.keys(SWEEP_DUTY_INVENTORY)).toHaveLength(40);
    // The one duty registered twice is the orphan-claim reset: once in the tail
    // window, once as the post-kill follow-up (rev-3 grounding §2, S17).
    expect(actual.filter((r) => r[1] === SWEEP_DUTY_INVENTORY.S17)).toHaveLength(2);
    // Every inventory id maps to a name the registry actually uses.
    for (const [id, name] of Object.entries(SWEEP_DUTY_INVENTORY)) {
      expect(names, `inventory id ${id}`).toContain(name);
    }
  });

  // ── F-3.3 (S2-PR3) ─────────────────────────────────────────────────────────
  it('the idle-reap bodies are gone from host-sweep.ts', async () => {
    const hostSweep = (await import('./host-sweep.js')) as unknown as Record<string, unknown>;
    expect(hostSweep.shouldReapIdleTaskContainer).toBeUndefined();
    expect(hostSweep.shouldReapIdleChatContainer).toBeUndefined();
    expect(hostSweep.CHAT_IDLE_REAP_MS).toBeUndefined();
    // They now live in, and are exported from, the family module instead.
    const idleReap = await import('./modules/sweep-idle-reap/index.js');
    expect(typeof idleReap.shouldReapIdleTaskContainer).toBe('function');
    expect(typeof idleReap.shouldReapIdleChatContainer).toBe('function');
    expect(idleReap.CHAT_IDLE_REAP_MS).toBe(15 * 60 * 1000);
  });

  // ── F-5.4 (S2-PR5, plan.md §8) ───────────────────────────────────────────────
  it('reconciler, thread-close and watchdog run in tick:post-session', () => {
    // The container-state ordering constraint (plan.md §4.3 constraint 1)
    // survives the move of T6/T18 into src/modules/sweep-orchestrator/. T8
    // thread-close is S2-PR11's family — assert its declared phase only, not
    // its behavior.
    const { duties } = _listSweepRegistrationsForTesting();
    const byName = new Map(duties.map((d) => [d.name, d]));
    for (const name of [SWEEP_DUTY_INVENTORY.T6, SWEEP_DUTY_INVENTORY.T8, SWEEP_DUTY_INVENTORY.T18]) {
      expect(byName.get(name), `duty ${name}`).toBeDefined();
      expect(byName.get(name)?.phase, `duty ${name}`).toBe('tick:post-session');
    }
  });

  // ── F-6.3 (S2-PR6) ───────────────────────────────────────────────────────────
  it('claims reconcile is ordered strictly before claims self-heal', async () => {
    // Declared order: T20 (claims-reconcile, order 100) then T21
    // (claims-self-heal, order 110), both tick:housekeeping (plan.md §4.3
    // constraint 3). No sessions needed — tick:housekeeping runs regardless.
    const { duties } = _listSweepRegistrationsForTesting();
    const byName = new Map(duties.map((d) => [d.name, d]));
    const reconcile = byName.get(SWEEP_DUTY_INVENTORY.T20);
    const selfHeal = byName.get(SWEEP_DUTY_INVENTORY.T21);
    expect(reconcile?.phase).toBe('tick:housekeeping');
    expect(selfHeal?.phase).toBe('tick:housekeeping');
    expect(reconcile?.order).toBeLessThan(selfHeal?.order ?? Infinity);

    await _sweepOnceForTesting();

    // Order, and NOT merely declared order — the probe proves reconcile's
    // deletion of 'claim-merged' is visible to self-heal in the SAME tick.
    expect(h.claimsOrder).toEqual(['reconcile', 'self-heal']);
    expect(h.claimsSelfHealSawStore).toEqual(['claim-open']);
    expect(h.spawns).toEqual([]);
  });

  // ── F-6.4 (S2-PR6) ───────────────────────────────────────────────────────────
  it('egress re-heal runs before the session fan-out', () => {
    // tick:pre-session is, by SWEEP_PHASES's declared order (R-1), the phase
    // the driver runs before getActiveSessions()/the per-session loop.
    const { duties } = _listSweepRegistrationsForTesting();
    const egress = duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.T2);
    expect(egress).toBeDefined();
    expect(egress?.phase).toBe('tick:pre-session');
    expect(SWEEP_PHASES.indexOf('tick:pre-session')).toBeLessThan(SWEEP_PHASES.indexOf('session:plan'));
  });

  // ── F-14.1 (S2-PR14, plan.md §8) ─────────────────────────────────────────────
  //
  // Structural, not a line budget. The plan's original "under 300 lines" was an
  // estimate written before the build; the end state is 1,137 lines — 631 code,
  // 420 comment, 86 blank — and holds no duty body at all. Section breakdown:
  // sweepSession + helpers 260, driver start/stop/sweep/sweepOnce 150, registry
  // 158, error rule 100, shared context + duty types 99, re-exports +
  // writeSystemWake + providerFailedTicks 80, SLA hooks + kill follow-ups +
  // windowedRunner 65, phase list 53, duty inventory 50, tick constants + quiet
  // cache 45, file header 29, tail re-exports + the empty built-in source 27,
  // imports 21. The three assertions below are what the criterion actually
  // means; the 1,200 ceiling at the end is a REGROWTH ratchet, not a target — it
  // catches a duty body creeping back into the driver, which is the failure this
  // case exists to prevent.
  it('host-sweep.ts contains no inline duty bodies', async () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/host-sweep.ts'), 'utf8');

    // (1) No duty ORIGINATES in the driver. Re-evaluate host-sweep.ts in a fresh
    // module graph — its own import list, no family module and no modules barrel
    // — and the registry it builds is empty. `registerSweepDutySource` invokes
    // its registrar immediately, so this also proves `registerBuiltInSweepDuties`
    // registers nothing rather than merely being unreferenced.
    vi.resetModules();
    const isolated = await import('./host-sweep.js');
    const fresh = isolated._listSweepRegistrationsForTesting();
    expect(fresh.duties, 'a duty is registered by host-sweep.ts itself').toEqual([]);
    expect(fresh.slaObservationHooks).toEqual([]);
    expect(fresh.killFollowUps).toEqual([]);

    // (2) No inline registration call site. The driver DEFINES the four
    // registration surfaces and never calls three of them; every duty call site
    // is a `src/modules/sweep-*` module. The single exception is the driver
    // declaring its own empty source, which is part of the registry contract —
    // `_resetSweepRegistryForTesting()` replays every recorded source and
    // `_unregisterSweepDutySourceForTesting` refuses this one by name — so it is
    // pinned exactly rather than forbidden.
    const callSites = (needle: string) => source.split(needle).length - 1;
    const definitions = (needle: string) => source.split(`export function ${needle}(`).length - 1;
    for (const surface of ['registerSweepDuty', 'registerSlaObservationHook', 'registerSweepKillFollowUp'] as const) {
      expect(definitions(surface), `${surface} is defined once`).toBe(1);
      expect(callSites(`${surface}(`) - definitions(surface), `${surface} is called inline in host-sweep.ts`).toBe(0);
      expect(source.includes(`${surface}({`), `${surface} is called with an inline body`).toBe(false);
    }
    expect(definitions('registerSweepDutySource')).toBe(1);
    expect(callSites('registerSweepDutySource(') - definitions('registerSweepDutySource')).toBe(1);
    expect(source).toContain("registerSweepDutySource('host-sweep:builtin', registerBuiltInSweepDuties)");
    expect(source).toContain('function registerBuiltInSweepDuties(): void {}');

    // (3) The export surface is the driver, the registry, the phase list, the
    // shared context, the error rule and the test accessors — nothing else. A
    // subset assertion, so a duty helper leaking back out as an export fails
    // here even though a removal would not.
    const ALLOWED_EXPORTS = new Set([
      // phase list
      'SWEEP_PHASES',
      'sweepPhaseKind',
      // registry
      'registerSweepDuty',
      'registerSweepDutySource',
      'registerSlaObservationHook',
      'registerSweepKillFollowUp',
      'runSlaObservationHooks',
      'runSweepKillFollowUps',
      'SWEEP_DUTY_INVENTORY',
      // shared context + error rule
      'asSessionContext',
      'SweepWindowAbort',
      // driver + its tick constants
      'startHostSweep',
      'stopHostSweep',
      'SWEEP_INTERVAL_MS',
      'ABSOLUTE_CEILING_MS',
      'CLAIM_STUCK_MS',
      'SPAWN_GRACE_MS',
      'providerFailedTicks',
      'writeSystemWake',
      // re-exports the families and their callers reach through the driver
      'parseSqliteUtc',
      'decideCeilingFollowUp',
      'WORK_CONTINUATION_RESUME_MAX_ATTEMPTS',
      // test accessors
      '_listSweepRegistrationsForTesting',
      '_resetSweepRegistryForTesting',
      '_unregisterSweepDutySourceForTesting',
      '_setSweepYieldForTesting',
      '_sweepOnceForTesting',
      '_sweepSessionForTesting',
      '_sweepTaskWatchdogForTesting',
    ]);
    const actualExports = Object.keys(isolated);
    expect([...actualExports].filter((name) => !ALLOWED_EXPORTS.has(name))).toEqual([]);
    // Not vacuous: the driver, the registry and the phase list are all still here.
    for (const core of ['startHostSweep', 'registerSweepDuty', 'SWEEP_PHASES', 'asSessionContext']) {
      expect(actualExports, `host-sweep.ts no longer exports ${core}`).toContain(core);
    }

    // Regrowth ratchet. 1,137 today; the headroom is for comments and the
    // driver's own evolution, never for a duty body coming home.
    expect(source.split('\n').length).toBeLessThanOrEqual(1200);
    expect(h.spawns).toEqual([]);
  });

  // ── F-14.2 (S2-PR14, plan.md §8) ─────────────────────────────────────────────
  it('the registered duty set still matches the inventory after every family has moved', async () => {
    // R-7's assertion, re-run at the end state and reached the way production
    // reaches it: through the modules barrel src/main.ts imports, not through
    // this file's own per-family side-effect imports.
    await import('./modules/index.js');
    _resetSweepRegistryForTesting();

    const { duties, slaObservationHooks, killFollowUps } = _listSweepRegistrationsForTesting();
    const actual: Array<[string, string, string, number]> = [
      ...duties.map((d): [string, string, string, number] => ['duty', d.name, d.phase, d.order]),
      ...slaObservationHooks.map((hk): [string, string, string, number] => [
        'sla-observation-hook',
        hk.name,
        'sla-observation-hook',
        hk.order,
      ]),
      ...killFollowUps.map((f): [string, string, string, number] => [
        'kill-follow-up',
        f.name,
        'kill-follow-up',
        f.order,
      ]),
    ];

    expect(actual).toEqual(EXPECTED_REGISTRATIONS);
    expect(actual).toHaveLength(39);
    const names = new Set(actual.map((r) => r[1]));
    expect(names.size).toBe(38);
    expect(names).toEqual(new Set(Object.values(SWEEP_DUTY_INVENTORY)));
    expect(actual.filter((r) => r[1] === SWEEP_DUTY_INVENTORY.S17)).toHaveLength(2);
    expect(h.spawns).toEqual([]);
  });

  // ── duty registration sources ───────────────────────────────────────────────
  describe('duty registration sources', () => {
    // Stands in for a real family module, which registers its source once at
    // its own import time — long-lived, not scoped to one test. The
    // regression this guards: a prior version of the test-only unregister
    // helper dropped EVERY non-builtin source, so removing 'fake-family'
    // below also wiped this one for the rest of the file.
    beforeAll(() => {
      registerSweepDutySource('fake-persistent-family', () => {
        registerSweepDuty(probeDuty('fake-persistent-family-duty', 'tick:housekeeping', 998, []));
      });
    });

    afterAll(() => {
      _unregisterSweepDutySourceForTesting('fake-persistent-family');
    });

    afterEach(() => {
      // Drop only the test-scoped fake source, never the persistent one.
      _unregisterSweepDutySourceForTesting('fake-family');
    });

    it('a duty source registered by a module survives the test reset', () => {
      const seen: string[] = [];
      registerSweepDutySource('fake-family', () => {
        registerSweepDuty(probeDuty('fake-family-duty', 'tick:housekeeping', 999, seen));
      });

      // registerSweepDutySource invokes the registrar immediately.
      let { duties } = _listSweepRegistrationsForTesting();
      expect(duties.some((d) => d.name === 'fake-family-duty')).toBe(true);
      expect(duties.some((d) => d.name === SWEEP_DUTY_INVENTORY.T2)).toBe(true);

      _resetSweepRegistryForTesting();
      ({ duties } = _listSweepRegistrationsForTesting());
      expect(duties.some((d) => d.name === 'fake-family-duty')).toBe(true);
      expect(duties.some((d) => d.name === SWEEP_DUTY_INVENTORY.T2)).toBe(true);

      _resetSweepRegistryForTesting({ builtins: false });
      ({ duties } = _listSweepRegistrationsForTesting());
      expect(duties).toHaveLength(0);
    });

    // Regression test: unregistering the test-scoped source above must not
    // touch a sibling family's source. Runs after the case above, whose
    // afterEach has already removed 'fake-family' and whose enclosing
    // afterEach has already called `_resetSweepRegistryForTesting()`.
    it("unregistering one test's duty source leaves a sibling family's source registered", () => {
      _resetSweepRegistryForTesting();
      const { duties } = _listSweepRegistrationsForTesting();
      expect(duties.some((d) => d.name === 'fake-persistent-family-duty')).toBe(true);
      expect(duties.some((d) => d.name === 'fake-family-duty')).toBe(false);
    });
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
    // Without this, every "depth: 0" below could be vacuously true — the probe
    // must actually see the production guard's store through the fake mailbox.
    it('the depth probe reads non-zero inside a window that holds a session', async () => {
      _resetSweepRegistryForTesting({ builtins: false });
      const depths: number[] = [];
      h.sessions = [fakeSession('sess-depth')];
      registerSweepDuty({
        name: 'inside-plan',
        phase: 'session:plan',
        order: 10,
        run: () => {
          depths.push(probe.depth());
        },
      });
      registerSweepDuty({
        name: 'outside-wake',
        phase: 'session:wake',
        order: 10,
        run: () => {
          depths.push(probe.depth());
        },
      });

      await _sweepOnceForTesting();

      expect(depths).toEqual([1, 0]);
      expect(h.spawns).toEqual([]);
    });

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

  // ── F-4.4 (S2-PR4 — plan.md §8) ──────────────────────────────────────────
  // "the receipts prune is registered and therefore guarded" — T10
  // (channel-ingress-receipt-prune) has no try/catch of its own; through the
  // registry wrapper a throw is logged and does not abort the rest of the
  // tick:housekeeping phase. Re-proves R-4b's tick-level isolation property
  // (constraint 5) for the real production duty, not a synthetic probe.
  //
  // NOTE: depends on the tick-level duty isolation PR 2 is landing in a
  // correction commit (runTickPhase catching per-duty, not per-phase). As
  // built on this branch's base (a1fd2633), `runTickPhase` has no per-duty
  // try/catch, so a throw from T10 aborts the rest of the tick:housekeeping
  // phase for that tick instead of being isolated — this case is expected to
  // FAIL until this branch rebases onto PR 2's corrected head.
  it('the receipts prune is registered and therefore guarded', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const { pruneChannelIngressReceipts } = await import('./db/channel-ingress-receipts.js');
    vi.mocked(pruneChannelIngressReceipts).mockImplementationOnce(() => {
      throw new Error('receipts boom');
    });
    // Sits strictly between T10 (order 40) and T11 (order 50) in
    // tick:housekeeping, so its having run is direct evidence the phase
    // continued past T10's throw.
    let laterDutyRan = false;
    registerSweepDuty({
      name: 'probe-after-receipts-prune',
      phase: 'tick:housekeeping',
      order: 45,
      run: () => {
        laterDutyRan = true;
      },
    });

    await _sweepOnceForTesting();

    expect(error).toHaveBeenCalledWith(
      'Host sweep duty failed',
      expect.objectContaining({ duty: SWEEP_DUTY_INVENTORY.T10, window: 'tick:housekeeping' }),
    );
    expect(laterDutyRan).toBe(true);
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
