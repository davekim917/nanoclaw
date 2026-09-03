/**
 * Acceptance cases for the scheduled-move-recovery sweep family (seam 2,
 * S2-PR7 — F-7.1, F-7.2, F-7.3 in
 * docs/specs/upstream-host-sweep-seam/plan.md §8).
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
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted state the mock factories read ────────────────────────────────────

const h = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-scheduled-move-')),
    spawns: [] as string[],
    centralDb: null as unknown,
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
      throw new Error(`scheduled-move.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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
// None of these bodies are exercised by this family's duties; they exist only
// so registerBuiltInSweepDuties() (which runs at host-sweep.ts's own import
// time) and the OTHER 36 duties it registers never reach outside the fixture.

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

// getDb is THE dependency this family's two duties consume — a spy, not a
// stub, so the registered-duty cases below can assert on it directly (F-7's
// "acceptance tests must drive the REGISTERED duty" rule).
const mockGetDb = vi.fn(() => h.centralDb);
vi.mock('../../db/connection.js', () => ({ getDb: () => mockGetDb() }));

// ── imports (after every mock above) ─────────────────────────────────────────

import {
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
  SWEEP_DUTY_INVENTORY,
} from '../../host-sweep.js';
import { log } from '../../log.js';
// Side-effect import: registers 'sweep-scheduled-move' as a duty source
// (registerSweepDutySource calls the registrar immediately, and records it
// so it survives `_resetSweepRegistryForTesting()` below) — without this
// static import at file load, the lazy `await import('./index.js')` inside
// the D3/D4 describe's beforeEach would register it too late for the
// "registered duty" describe above, which runs first.
import './index.js';

describe('the child_process tripwire bites when a seam mock is removed', () => {
  it('throws and records the attempted spawn', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });
});

// ── F-7.3 + registry acceptance: the registered duties, not the raw bodies ──

describe('registered scheduled-move-recovery / audit-body-prune duties', () => {
  beforeEach(() => {
    h.spawns.length = 0;
    mockGetDb.mockClear();
    _resetSweepRegistryForTesting();
  });

  function getDuty(name: string) {
    const { duties } = _listSweepRegistrationsForTesting();
    const duty = duties.find((d) => d.name === name);
    if (!duty) throw new Error(`duty not registered: ${name}`);
    return duty;
  }

  it('T11/T12 are registered on tick:housekeeping at order 50/60', () => {
    const t11 = getDuty(SWEEP_DUTY_INVENTORY.T11);
    const t12 = getDuty(SWEEP_DUTY_INVENTORY.T12);
    expect(t11.phase).toBe('tick:housekeeping');
    expect(t11.order).toBe(50);
    expect(t12.phase).toBe('tick:housekeeping');
    expect(t12.order).toBe(60);
    expect(h.spawns).toEqual([]);
  });

  it('scheduled-move-recovery forwards the exact getDb() handle to recoverMoveIntents', async () => {
    // A sentinel central-db stub — proves recoverMoveIntents ran against the
    // SAME object getDb() returned (forwarding), not a re-derived handle.
    const prepare = vi.fn(() => ({ all: () => [] }));
    h.centralDb = { prepare };
    const duty = getDuty(SWEEP_DUTY_INVENTORY.T11);

    await duty.run({} as never);

    expect(mockGetDb).toHaveBeenCalledTimes(1);
    // recoverMoveIntents's first statement is the move_intent select.
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('move_intent'));
    expect(h.spawns).toEqual([]);
  });

  it('audit-body-prune forwards the exact getDb() handle to pruneAuditBodies', async () => {
    const run = vi.fn(() => ({ changes: 0 }));
    const prepare = vi.fn(() => ({ run }));
    h.centralDb = { prepare };
    const duty = getDuty(SWEEP_DUTY_INVENTORY.T12);

    await duty.run({} as never);

    expect(mockGetDb).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('scheduled_audit'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.spawns).toEqual([]);
  });

  it('scheduled-move-recovery logs the preserved failure string when getDb() throws', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    mockGetDb.mockImplementationOnce(() => {
      throw new Error('central db unopenable');
    });
    const duty = getDuty(SWEEP_DUTY_INVENTORY.T11);

    await duty.run({} as never);

    expect(warnSpy).toHaveBeenCalledWith('scheduled-move-recovery: sweep hook failed', expect.anything());
    warnSpy.mockRestore();
    expect(h.spawns).toEqual([]);
  });

  it('audit-body-prune logs the SAME preserved failure string when getDb() throws', async () => {
    // PR 2 split the formerly shared try/catch into two guarded
    // registrations but kept the identical warn string on both, so a log
    // search for it still finds every failure it used to.
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    mockGetDb.mockImplementationOnce(() => {
      throw new Error('central db unopenable');
    });
    const duty = getDuty(SWEEP_DUTY_INVENTORY.T12);

    await duty.run({} as never);

    expect(warnSpy).toHaveBeenCalledWith('scheduled-move-recovery: sweep hook failed', expect.anything());
    warnSpy.mockRestore();
    expect(h.spawns).toEqual([]);
  });
});

// ── F-7.1 (11 ported cases) + F-7.2 ──────────────────────────────────────────
// Self-contained: recoverMoveIntents/pruneAuditBodies take an explicit
// central-DB handle + options, so they don't rely on the mocks above.
describe('recoverMoveIntents (D3) + pruneAuditBodies (D4)', () => {
  // Lazy import inside the describe so the helpers resolve against the real
  // module (registered mocks above don't affect these pure-handle calls).
  let recoverMoveIntents: typeof import('./index.js').recoverMoveIntents;
  let pruneAuditBodies: typeof import('./index.js').pruneAuditBodies;
  let migration043: typeof import('../../db/migrations/043-scheduled-audit.js').migration043;
  let ensureSchema: typeof import('../../db/session-db.js').ensureSchema;
  let openInboundDb: typeof import('../../db/session-db.js').openInboundDb;

  // Unique per-file temp root (mkdtempSync) so parallel vitest workers never
  // share a fixed path and clobber each other's rmSync.
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-d3d4-test-'));
  const NOW = Date.parse('2026-06-13T12:00:00Z');
  const SWEEP_MS = 60_000;

  beforeEach(async () => {
    ({ recoverMoveIntents, pruneAuditBodies } = await import('./index.js'));
    ({ migration043 } = await import('../../db/migrations/043-scheduled-audit.js'));
    ({ ensureSchema, openInboundDb } = await import('../../db/session-db.js'));
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
