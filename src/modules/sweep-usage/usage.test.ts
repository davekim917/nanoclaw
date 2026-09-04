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
    // ctx.sessions, no extra query). readSessionOutbound / rollupSessionUsage
    // are THE dependencies this family's duty consumes — spies, not stubs, so
    // the registered-duty cases below can assert on them directly (the
    // "acceptance tests must drive the REGISTERED duty" rule).
    //
    // openOutboundDb is spied for the OPPOSITE reason: it is the raw opener
    // this duty must never call. Mailbox seam PR 6 routes the rollup through
    // the read-only funnel, and a move that quietly restored the raw opener
    // would still pass every other case here — so it is asserted absent.
    //
    // `vi` is available here even though it isn't `require`d: the
    // `import { vi } from 'vitest'` below is a real ES import, hoisted by
    // the module system itself before this factory runs.
    mockGetActiveSessions: vi.fn(() => [] as unknown[]),
    mockOpenOutboundDb: vi.fn((_path: string) => ({ close: () => undefined }) as unknown),
    mockReadSessionOutbound: vi.fn((_location: unknown, action: (mailbox: unknown) => unknown, _options?: unknown) =>
      action({ listTurnUsageSince: (_afterId: number) => [] as unknown[] }),
    ),
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
vi.mock('../mailbox/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mailbox/index.js')>();
  return {
    ...real,
    readSessionOutbound: (location: unknown, action: unknown, options?: unknown) =>
      h.mockReadSessionOutbound(location, action as (mailbox: unknown) => unknown, options),
  };
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

// ── F-12.1 ───────────────────────────────────────────────────────────────────
// Exact it() title per plan.md §8 (series rule added 2026-09-03: every case
// must exist under its verbatim title, not folded into an aggregate describe
// name — see src/modules/sweep-claims/claims.test.ts's F-6.1 for precedent).

describe('F-12.1', () => {
  it('shouldSkipUsageRollup keeps its mtime gate', () => {
    // The 3 ported cases.
    expect(shouldSkipUsageRollup(1000, 1000)).toBe(true); // unchanged since last rollup
    expect(shouldSkipUsageRollup(1000, 2000)).toBe(false); // outbound.db mtime moved
    expect(shouldSkipUsageRollup(undefined, 1000)).toBe(false); // never seen before, no cache entry
  });
});

// The same three, under the verbatim titles they carry in
// src/host-sweep.test.ts on main. F-12.1 above is the plan's own aggregate
// criterion and keeps its exact title; folding main's three named cases into it
// would have retired three case names this move is only supposed to relocate.
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

// ── registered usage-rollup duty (T19): F-12.2, F-12.3 + supporting cases ────

describe('registered usage-rollup duty (T19)', () => {
  beforeEach(() => {
    h.spawns.length = 0;
    h.mockGetActiveSessions.mockClear();
    h.mockOpenOutboundDb.mockClear();
    h.mockReadSessionOutbound.mockClear();
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

  it("the rollup reuses the tick's session list and opens only changed sessions", async () => {
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
    expect(h.mockReadSessionOutbound).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledWith(expect.anything(), 'ag-test', 'ag-test/sess-changed');
    expect(h.mockPruneOldTurnUsage).toHaveBeenCalledTimes(1);
    expect(h.spawns).toEqual([]);
  });

  it('logs the preserved failure string when the rollup throws, without blocking pruneOldTurnUsage', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    h.mockReadSessionOutbound.mockImplementationOnce(() => {
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

  // F-12.2, exact title, corrected by the orchestrator (plan.md amended):
  // confirmed the raw-opener funnel is deliberate as-built (mailbox PR 6
  // never routed this call through withExistingNanoclawSession — my earlier
  // brief's framing was stale). Three assertions, each on its own session id:
  //  1. inbound.db GONE while outbound.db remains → the rollup STILL runs on
  //     outbound alone and the cache updates (constraint 21's purpose:
  //     turn_usage reaches central totals).
  //  2. a rollup that fails before completing (rollupSessionUsage throws) →
  //     cache UNCHANGED, no throw escapes the duty beyond the preserved log,
  //     and the session is re-attempted next tick.
  //  3. a real rollup updates the cache to the outbound mtime, and a second
  //     tick with an unchanged mtime skips (shouldSkipUsageRollup) — while a
  //     THIRD tick with a genuinely new mtime rolls up again, proving the
  //     cached value is the real mtime, not a placeholder truthy flag.
  it('the usage mtime cache is written only after a rollup actually ran', async () => {
    const duty = getDuty();

    // (1) inbound gone, outbound remains — still a REAL rollup.
    const goneId = 'sess-inbound-gone';
    const goneDir = path.join(h.dataDir, 'v2-sessions', 'ag-test', goneId);
    fs.mkdirSync(goneDir, { recursive: true });
    fs.writeFileSync(path.join(goneDir, 'outbound.db'), '');
    expect(fs.existsSync(path.join(goneDir, 'inbound.db'))).toBe(false);

    await duty.run(tickContext([fakeSession(goneId)]) as never);
    expect(h.mockReadSessionOutbound).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);
    // Cache written: an immediate re-tick over the unchanged file skips.
    h.mockReadSessionOutbound.mockClear();
    h.mockRollupSessionUsage.mockClear();
    await duty.run(tickContext([fakeSession(goneId)]) as never);
    expect(h.mockReadSessionOutbound).not.toHaveBeenCalled();
    expect(h.mockRollupSessionUsage).not.toHaveBeenCalled();

    // (2) a rollup that fails before completing — cache unchanged, no throw
    // escapes the duty, retried next tick.
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const failId = 'sess-rollup-throws';
    const failDir = path.join(h.dataDir, 'v2-sessions', 'ag-test', failId);
    fs.mkdirSync(failDir, { recursive: true });
    fs.writeFileSync(path.join(failDir, 'outbound.db'), '');
    h.mockRollupSessionUsage.mockImplementationOnce(() => {
      throw new Error('rollup failed mid-write');
    });
    // No throw escapes the duty — the try/catch in sweepUsageRollup swallows
    // it (and logs); awaiting duty.run would itself throw if this regressed.
    // The preserved string is 'Usage rollup failed for session' (this duty's
    // OWN per-session catch, unchanged from the pre-move body) — NOT the
    // registry driver's generic 'Host sweep duty failed', which only fires
    // when a duty's run(ctx) itself throws uncaught (runDutyBody/runTickPhase,
    // host-sweep.ts:544-561). T19 deliberately never lets that happen: "a
    // rollup failure never blocks the rest of the tick" (module doc comment)
    // means every failure is caught here, one level below the driver.
    await duty.run(tickContext([fakeSession(failId)]) as never);
    expect(warnSpy).toHaveBeenCalledWith(
      'Usage rollup failed for session',
      expect.objectContaining({ sessionId: failId }),
    );
    h.mockReadSessionOutbound.mockClear();
    h.mockRollupSessionUsage.mockClear();
    // usageRollupMtimeCache has no entry for this session (it's module-
    // private, no test accessor — proven behaviorally, the same style as
    // shouldSkipUsageRollup's own cache tests): same (unchanged) outbound.db
    // mtime, next tick: retried, not skipped, because tick 1 never reached
    // the cache write (rollupSessionUsage threw before it).
    await duty.run(tickContext([fakeSession(failId)]) as never);
    expect(h.mockReadSessionOutbound).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();

    // (3) a real rollup updates the cache to the outbound mtime specifically
    // (not a placeholder): a genuinely NEW mtime rolls up again even though
    // the cache is already populated from this same session's earlier ticks.
    h.mockReadSessionOutbound.mockClear();
    h.mockRollupSessionUsage.mockClear();
    fs.utimesSync(path.join(failDir, 'outbound.db'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    await duty.run(tickContext([fakeSession(failId)]) as never);
    expect(h.mockReadSessionOutbound).toHaveBeenCalledTimes(1);
    expect(h.mockRollupSessionUsage).toHaveBeenCalledTimes(1);

    expect(h.spawns).toEqual([]);
  });

  // The read goes through the SEAM, not a raw opener, and carries the raw
  // opener's durability options. Both halves matter and neither is implied by
  // the cases above, which only assert that some read happened:
  //
  //  - `openOutboundDb` never called: mailbox seam PR 6 moved this projection
  //    behind `readSessionOutbound`, and that is why this module is no longer
  //    on src/mailbox/RATCHET.json. A move that quietly restored the raw
  //    opener would pass every other case in this file and silently put the
  //    file back on the wrong side of the ratchet.
  //  - the options object: the funnel defaults to a 1s busy_timeout and does
  //    NOT recover a hot journal, because its first caller was a fleet-wide
  //    console read that must degrade rather than stall or write. The raw
  //    opener this replaced did both. Dropping the options is therefore
  //    invisible until a container crashes mid-write, after which that
  //    session throws on every tick and its turn_usage rows never reach the
  //    central ledger — exactly the regression this case exists to catch.
  it("T19 reads through readSessionOutbound with the raw opener's durability options, never openOutboundDb", async () => {
    const sessionId = 'sess-funnel';
    const dir = path.join(h.dataDir, 'v2-sessions', 'ag-test', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbound.db'), '');

    const duty = getDuty();
    await duty.run(tickContext([fakeSession(sessionId)]) as never);

    expect(h.mockOpenOutboundDb).not.toHaveBeenCalled();
    expect(h.mockReadSessionOutbound).toHaveBeenCalledTimes(1);
    expect(h.mockReadSessionOutbound).toHaveBeenCalledWith(
      { agentGroupId: 'ag-test', sessionId },
      expect.any(Function),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );
    // And the funnel's own session object is what reaches the rollup — the
    // op-shaped read, not a raw better-sqlite3 handle.
    expect(h.mockRollupSessionUsage).toHaveBeenCalledWith(
      expect.objectContaining({ listTurnUsageSince: expect.any(Function) }),
      'ag-test',
      `ag-test/${sessionId}`,
    );
    expect(h.spawns).toEqual([]);
  });
});
