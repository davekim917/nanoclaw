/**
 * Acceptance cases for the usage-rollup sweep family (seam 2, S2-PR12 —
 * F-12.1, F-12.2, F-12.3 in docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * Hermeticity (brief-common.md HARD RULE): nothing here reaches outside the
 * per-run temp fixture. Importing this module transitively imports
 * src/host-sweep.ts (for the registry surfaces), which itself imports every
 * seam host-sweep.ts reaches for (docker, git, GitHub, Discord, worker
 * threads) — all mocked below at the seam, following
 * src/host-sweep-registry.test.ts's pattern. The `child_process` tripwire
 * records and throws on any real spawn; every case that imports the module or
 * runs a duty body asserts it stayed empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted state the mock factories read ────────────────────────────────────

const h = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-usage-')),
    spawns: [] as string[],
    // getActiveSessions is spied so F-12.3 can assert it is NEVER called by
    // the registered duty (constraint 4: T19 reuses the tick's own
    // ctx.sessions, no extra query). openOutboundDb / listTurnUsageSince /
    // rollupSessionUsage are THE dependencies this family's duty consumes —
    // spies, not stubs, so the registered-duty cases below can assert on
    // them directly (the "acceptance tests must drive the REGISTERED duty"
    // rule). `vi` is available here even though it isn't `require`d: the
    // `import { vi } from 'vitest'` below is a real ES import, hoisted by
    // the module system itself before this factory runs.
    mockGetActiveSessions: vi.fn(() => [] as unknown[]),
    mockOpenOutboundDb: vi.fn((_path: string) => ({ close: () => undefined }) as unknown),
    mockListTurnUsageSince: vi.fn((_db: unknown, _afterId: number) => [] as unknown[]),
    mockRollupSessionUsage: vi.fn((_mailbox: unknown, _agentGroupId: string, _sessionDirKey: string) => 0),
    mockPruneOldTurnUsage: vi.fn(() => undefined),
  };
});

/**
 * A tripwire, not a functional mock. It records the call (so a test can
 * assert on that record even though the thrown error itself may be
 * swallowed) and then throws, so a caller that does NOT catch it fails
 * loudly too.
 */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`usage.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

// ── mocks that make importing src/host-sweep.ts (transitively, via
// ../../host-sweep.js) hermetic — same seams as src/host-sweep-registry.test.ts.
// None of these bodies are exercised by this family's duty; they exist only
// so registerBuiltInSweepDuties() (which runs at host-sweep.ts's own import
// time) and the OTHER 37 duties it registers never reach outside the fixture.

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return h.dataDir;
    },
  };
});
vi.mock('../../egress-lockdown.js', () => ({ ensureEgressNetwork: () => undefined }));
vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return { ...real, getActiveSessions: h.mockGetActiveSessions };
});
vi.mock('../../db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/agent-groups.js')>();
  return { ...real, getAgentGroup: () => undefined };
});
vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: () => false,
    hasContainerEverRun: () => false,
    getActiveContainerSessionIds: () => [],
    killContainer: () => undefined,
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
  };
});
vi.mock('../../modules/scheduling/host-script.js', () => ({ runHostGatedTaskScripts: async () => undefined }));
vi.mock('../../modules/scheduling/recurrence.js', () => ({ handleRecurrence: async () => undefined }));
vi.mock('../../dashboard/thread-close.js', () => ({
  advanceThreadClosures: async () => undefined,
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
vi.mock('../orchestrator-dispatch/db/agent-group-capabilities.js', () => ({ getCapabilityConfig: () => undefined }));
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
vi.mock('../../modules/scheduling/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../modules/scheduling/db.js')>();
  return { ...real, restoreTaskRow: () => undefined };
});
vi.mock('../../modules/scheduling/live-count.js', () => ({
  countLiveRowsInSessions: () => ({ count: 0, unreadable: false }),
}));
vi.mock('../../dashboard/api/scheduled-shared.js', () => ({ purgeIntentBody: () => undefined }));

vi.mock('../mailbox/openers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mailbox/openers.js')>();
  return { ...real, openOutboundDb: (p: string) => h.mockOpenOutboundDb(p) };
});
vi.mock('../mailbox/ops/reads.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mailbox/ops/reads.js')>();
  return { ...real, listTurnUsageSince: (db: unknown, afterId: number) => h.mockListTurnUsageSince(db, afterId) };
});
vi.mock('../../db/usage.js', () => ({
  rollupSessionUsage: (mailbox: unknown, agentGroupId: string, sessionDirKey: string) =>
    h.mockRollupSessionUsage(mailbox, agentGroupId, sessionDirKey),
  pruneOldTurnUsage: () => h.mockPruneOldTurnUsage(),
}));

// ── imports (after every mock above) ─────────────────────────────────────────

import fs from 'fs';
import path from 'path';

import {
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
  SWEEP_DUTY_INVENTORY,
  type SweepTickContext,
} from '../../host-sweep.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
// Side-effect import: registers 'sweep-usage' as a duty source
// (registerSweepDutySource calls the registrar immediately, and records it
// so it survives `_resetSweepRegistryForTesting()` below) — without this
// static import at file load, a lazy import inside a beforeEach would
// register it too late for the "registered duty" describe below, which runs
// first.
import { shouldSkipUsageRollup } from './index.js';
import './index.js';

function fakeSession(id: string, agentGroupId = 'ag-test'): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  } as Session;
}

/** Minimal tick context — only `sessions` is read by this family's duty. */
function tickContext(sessions: readonly Session[]): SweepTickContext {
  return {
    now: Date.now(),
    sessions,
    activeContainerSessionIds: new Set(),
  };
}

describe('the child_process tripwire bites when a seam mock is removed', () => {
  it('throws and records the attempted spawn', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });
});

// ── F-12.1 (the 3 ported cases) ──────────────────────────────────────────────

describe('shouldSkipUsageRollup keeps its mtime gate', () => {
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

// ── F-12.3 + registry acceptance: the registered duty, not the raw body ─────

describe('registered usage-rollup duty (T19)', () => {
  beforeEach(() => {
    h.spawns.length = 0;
    h.mockGetActiveSessions.mockClear();
    h.mockOpenOutboundDb.mockClear();
    h.mockListTurnUsageSince.mockClear();
    h.mockRollupSessionUsage.mockClear();
    h.mockPruneOldTurnUsage.mockClear();
    _resetSweepRegistryForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getDuty() {
    const { duties } = _listSweepRegistrationsForTesting();
    const duty = duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.T19);
    if (!duty) throw new Error(`duty not registered: ${SWEEP_DUTY_INVENTORY.T19}`);
    return duty;
  }

  it('T19 is registered on tick:post-session at order 40', () => {
    const duty = getDuty();
    expect(duty.phase).toBe('tick:post-session');
    expect(duty.order).toBe(40);
    expect(h.spawns).toEqual([]);
  });

  it('F-12.3: reuses the tick sessions list — no extra getActiveSessions call, one open per changed session', async () => {
    // Three sessions in ctx.sessions (the SAME array T3 already built this
    // tick — a sentinel, not re-derived): one has no outbound.db yet, one's
    // outbound.db mtime matches the cache (unchanged), one is new/changed.
    const changed = fakeSession('sess-changed');
    const noOutbound = fakeSession('sess-no-outbound');
    const sentinel = [changed, noOutbound];

    // sess-changed has a real outbound.db on disk so fs.statSync succeeds;
    // sess-no-outbound has none, so the duty's own `continue` (no outbound.db
    // yet) fires without ever calling openOutboundDb for it.
    const dir = path.join(h.dataDir, 'v2-sessions', 'ag-test', 'sess-changed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbound.db'), '');

    const duty = getDuty();
    await duty.run(tickContext(sentinel) as never);

    expect(h.mockGetActiveSessions).not.toHaveBeenCalled();
    expect(h.mockOpenOutboundDb).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledWith(expect.anything(), 'ag-test', 'ag-test/sess-changed');
    expect(h.mockPruneOldTurnUsage).toHaveBeenCalledTimes(1);
    expect(h.spawns).toEqual([]);
  });

  it('logs the preserved failure string when the rollup throws, without blocking pruneOldTurnUsage', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    h.mockOpenOutboundDb.mockImplementationOnce(() => {
      throw new Error('outbound.db unopenable');
    });
    const dir = path.join(h.dataDir, 'v2-sessions', 'ag-test', 'sess-fail');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbound.db'), '');

    const duty = getDuty();
    await duty.run(tickContext([fakeSession('sess-fail')]) as never);

    expect(warnSpy).toHaveBeenCalledWith(
      'Usage rollup failed for session',
      expect.objectContaining({ sessionId: 'sess-fail' }),
    );
    // The companion prune still runs even though the per-session rollup threw
    // — isolated so a rollup failure never blocks the rest of the tick.
    expect(h.mockPruneOldTurnUsage).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    expect(h.spawns).toEqual([]);
  });
});

// ── F-12.2 ───────────────────────────────────────────────────────────────────
//
// BUILDER NOTE (flagged to the orchestrator, unresolved as of this commit):
// plan.md's F-12.2 text reads "inbound gone while outbound remains → the
// session resolves undefined, the rollup does not run, the cache is
// unchanged and the session is retried next tick; a real rollup updates the
// cache." Taken as one flow, that contradicts constraint 21 and this very
// duty's own source comment (src/modules/sweep-usage/index.ts), which exist
// SPECIFICALLY so a session whose inbound.db is gone while outbound.db
// remains keeps being rolled up — verified against mailbox PR 6's actual
// diff (host-sweep.ts merge sha 47b71dcf): the sweep call was NOT changed to
// route through `withExistingNanoclawSession` (which is what "the session
// resolves undefined" would describe — that accessor's existence check is
// keyed on inbound.db, so it WOULD resolve undefined here). The two cases
// below are my best-effort reconciliation: the first proves "inbound gone,
// outbound remains" still gets a REAL rollup (matching constraint 21 and the
// code comment, and satisfying "a real rollup updates the cache"); the
// second proves the cache is untouched, and the session retried next tick,
// ONLY when the rollup itself does not run/complete (matching "the cache is
// unchanged and the session is retried next tick" read as the FAILURE arm,
// not the inbound-gone arm). If this split is wrong, plan.md needs the
// correction, not this test.
describe('the usage mtime cache is written only after a rollup actually ran', () => {
  beforeEach(() => {
    h.spawns.length = 0;
    h.mockGetActiveSessions.mockClear();
    h.mockOpenOutboundDb.mockClear();
    h.mockListTurnUsageSince.mockClear();
    h.mockRollupSessionUsage.mockClear();
    h.mockPruneOldTurnUsage.mockClear();
    _resetSweepRegistryForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getDuty() {
    const { duties } = _listSweepRegistrationsForTesting();
    const duty = duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.T19);
    if (!duty) throw new Error(`duty not registered: ${SWEEP_DUTY_INVENTORY.T19}`);
    return duty;
  }

  it('F-12.2a: inbound gone while outbound remains still gets a REAL rollup, and the cache is written', async () => {
    const sessionId = 'sess-inbound-gone';
    const dir = path.join(h.dataDir, 'v2-sessions', 'ag-test', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbound.db'), '');
    // No inbound.db written at all — the mailbox seam's own existence check
    // (invariant I-4) is keyed on inbound.db, so a session in this shape
    // would resolve `undefined` through withExistingNanoclawSession. T19
    // deliberately never calls that accessor (see the module doc comment);
    // this is the documentation half of that choice, not something the duty
    // itself checks.
    expect(fs.existsSync(path.join(dir, 'inbound.db'))).toBe(false);

    const duty = getDuty();
    await duty.run(tickContext([fakeSession(sessionId)]) as never);

    // A REAL rollup ran despite inbound being gone (constraint 21).
    expect(h.mockOpenOutboundDb).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);

    // The cache was written: a second tick over the SAME (unchanged)
    // outbound.db skips the open entirely.
    h.mockOpenOutboundDb.mockClear();
    h.mockRollupSessionUsage.mockClear();
    await duty.run(tickContext([fakeSession(sessionId)]) as never);
    expect(h.mockOpenOutboundDb).not.toHaveBeenCalled();
    expect(h.mockRollupSessionUsage).not.toHaveBeenCalled();
    expect(h.spawns).toEqual([]);
  });

  it('F-12.2b: the cache is unchanged and the session is retried next tick when the rollup does not actually run', async () => {
    const sessionId = 'sess-rollup-fails';
    const dir = path.join(h.dataDir, 'v2-sessions', 'ag-test', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbound.db'), '');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    // Tick 1: the open throws, so no rollup actually completed.
    h.mockOpenOutboundDb.mockImplementationOnce(() => {
      throw new Error('outbound.db unopenable');
    });
    const duty = getDuty();
    await duty.run(tickContext([fakeSession(sessionId)]) as never);
    expect(h.mockRollupSessionUsage).not.toHaveBeenCalled();

    // Tick 2, SAME (unchanged) outbound.db mtime: because tick 1 never wrote
    // the mtime cache, this session is retried rather than skipped — proving
    // the cache write is gated on a rollup that actually ran, not on merely
    // having visited the session.
    h.mockOpenOutboundDb.mockClear();
    await duty.run(tickContext([fakeSession(sessionId)]) as never);
    expect(h.mockOpenOutboundDb).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    expect(h.spawns).toEqual([]);
  });
});
