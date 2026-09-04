/**
 * Container health — S2-PR10 acceptance cases (F-10.1..F-10.6,
 * docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * decideStuckAction / decideProviderHeal / observeProviderStatus /
 * sweepProviderHeal / reportContainerOomTelemetry cases below are ported
 * verbatim from src/host-sweep.test.ts (pre-move). F-10.2 through F-10.5 are
 * new — the plan names them but the pre-move suite never exercised the
 * registry-level exclusivity or the CodexItem-specific widening in isolation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { type ContainerState } from '../mailbox/ops/sweep.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from '../mailbox/index.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  SPAWN_GRACE_MS,
  SWEEP_DUTY_INVENTORY,
  _listSweepRegistrationsForTesting,
  _sweepSessionForTesting,
  providerFailedTicks,
} from '../../host-sweep.js';
// PR 3 moved this threshold out of host-sweep.ts with the idle-reap family; it
// is imported from its owner, not re-exported by the driver (F-3.3 pins that
// host-sweep.ts no longer exports it).
import { CHAT_IDLE_REAP_MS } from '../sweep-idle-reap/index.js';
import {
  PROVIDER_HEAL_COOLDOWN_MS,
  PROVIDER_HEAL_MAX_ATTEMPTS,
  _resetProviderHealTicksForTesting,
  _sweepProviderHealForTesting,
  _reportContainerOomTelemetryForTesting,
  countProviderHealAttemptsSinceRealInbound,
  decideProviderHeal,
  decideStuckAction,
  notifyProviderHealParked,
  observeProviderStatus,
} from './index.js';
// Importing the module registers S11/S14/S16 as a duty source — needed so
// `_sweepSessionForTesting` (F-10.2) sees the real exclusive chain rather
// than the two idle-reap duties alone.
import './index.js';
import type { Session } from '../../types.js';

// ─── Hermeticity tripwire (brief-common.md HARD RULE) ────────────────────────
// F-10.2 drives real duty bodies via `_sweepSessionForTesting`. A tripwire, not
// a functional mock: records the call and throws, so a body that reaches an
// unmocked git/docker/GitHub spawn fails loudly instead of silently doing real
// process work under a test.
const spawns = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`health.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
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

// ─── Module mocks for the F-10.2 integration test ────────────────────────────
// Same seam host-sweep.test.ts already mocks at, copied here because this is
// a separate test file (vi.mock is per-file).

const selfHeal = vi.hoisted(() => ({ enabled: false }));
const testDataDir = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sweep-container-health-')) };
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
const mockReadContainerConfig = vi.fn();
const mockMarkProviderUnavailable = vi.fn();

vi.mock('../../container-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-config.js')>();
  return {
    ...real,
    readContainerConfig: (...args: unknown[]) => mockReadContainerConfig(...args),
  };
});

vi.mock('../../db/provider-health.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/provider-health.js')>();
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

vi.mock('../orchestrator-dispatch/db/tasks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/db/tasks.js')>();
  return {
    ...real,
    getActiveTasks: (...args: unknown[]) => mockGetActiveTasks(...args),
    transitionToTerminal: (...args: unknown[]) => mockTransitionToTerminal(...args),
    getOrphanedTasks: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../orchestrator-dispatch/db/agent-group-capabilities.js', () => ({
  getCapabilityConfig: (...args: unknown[]) => mockGetCapabilityConfig(...args),
}));

vi.mock('../orchestrator-dispatch/watchdog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../orchestrator-dispatch/watchdog.js')>();
  return {
    ...real,
    pendingTerminalSpawnOutboundSeenAt: (...args: unknown[]) => mockPendingTerminalDispatchOutboundSeenAt(...args),
  };
});

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    admitDueTaskContexts: (...args: unknown[]) => mockAdmitDueTaskContexts(...args),
    writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
    outboundDbPath: real.outboundDbPath,
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
    // `containerOwnsOutbound` moved from host-sweep.ts into container-runner.ts
    // (it now has a second caller, thread-close's finalizer). Composed here from
    // the MOCKED running check plus the real spawning one, which is exactly what
    // the host-sweep-local version did under this mock — spreading `...real`
    // alone would silently bypass `mockIsContainerRunning`. Same composition
    // src/host-sweep.test.ts already uses; this suite was written against the
    // older base where the helper was local to host-sweep.ts.
    containerOwnsOutbound: (sessionId: string) =>
      Boolean(mockIsContainerRunning(sessionId)) || real.isContainerSpawning(sessionId),
    hasContainerEverRun: (...args: unknown[]) => mockHasContainerEverRun(...args),
    wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
    killContainer: (...args: unknown[]) => mockKillContainer(...args),
  };
});

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

vi.mock('../orchestrator-dispatch/reconciler.js', () => ({
  runReconcilerSweep: () => mockRunReconcilerSweep(),
  runReconcilerOnStartup: vi.fn(),
}));

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

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

/**
 * `NanoclawAgentMailbox.prepare()` (src/modules/mailbox/index.ts) creates
 * container_state via upstream's minimal (tool-only) CREATE TABLE and then
 * idempotently ALTERs in `provider_executing` alone — `CREATE TABLE IF NOT
 * EXISTS` no-ops the richer columns onto an already-created table. Widens a
 * freshly-`prepare()`d session's real outbound.db the same way the
 * CONTAINER's own forwardColumns would, in production, on first connect —
 * needed by every real-session (`_sweepSessionForTesting`) case below that
 * writes provider/memory columns.
 */
function widenContainerStateSchema(outboundPath: string): void {
  const raw = new Database(outboundPath);
  raw.exec(`
    ALTER TABLE container_state ADD COLUMN provider_status TEXT;
    ALTER TABLE container_state ADD COLUMN provider_last_event_at TEXT;
    ALTER TABLE container_state ADD COLUMN provider_last_probe_at TEXT;
    ALTER TABLE container_state ADD COLUMN provider_probe_failures INTEGER;
    ALTER TABLE container_state ADD COLUMN provider_recovery_attempts INTEGER;
    ALTER TABLE container_state ADD COLUMN provider_failure_reason TEXT;
    ALTER TABLE container_state ADD COLUMN memory_current_bytes INTEGER;
    ALTER TABLE container_state ADD COLUMN memory_peak_bytes INTEGER;
    ALTER TABLE container_state ADD COLUMN memory_max_bytes INTEGER;
    ALTER TABLE container_state ADD COLUMN memory_oom_events INTEGER;
    ALTER TABLE container_state ADD COLUMN memory_oom_kill_events INTEGER;
    ALTER TABLE container_state ADD COLUMN memory_telemetry_at TEXT;
    ALTER TABLE container_state ADD COLUMN memory_max_events INTEGER;
  `);
  raw.close();
}

// ── F-10.1 ───────────────────────────────────────────────────────────────────
describe('decideStuckAction keeps all 19 existing decisions', () => {
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
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
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
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000,
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
      heartbeatMtimeMs: BASE - 2_000,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000,
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
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
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-stale', CLAIM_STUCK_MS + 10_000 + SPAWN_GRACE_MS)],
      spawnedAtMs: BASE - 10_000,
    });
    expect(res.action).toBe('ok');
  });

  it('still kills for a fresh-container claim that aged past tolerance during the grace window', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const spawnedAtMs = BASE - claimedAgeMs - 1_000;
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
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS,
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 10_000,
    });
    expect(res.action).toBe('ok');
  });

  it('does kill-ceiling once spawn-grace has elapsed without a fresh heartbeat', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2 * ABSOLUTE_CEILING_MS,
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - SPAWN_GRACE_MS - 5_000,
    });
    expect(res.action).toBe('kill-ceiling');
  });

  it('does kill-ceiling when heartbeat predates spawn but ages past ceiling AFTER spawn', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 35 * 60 * 1000,
      containerState: null,
      claims: [],
      spawnedAtMs: BASE - 40 * 60 * 1000,
    });
    expect(res.action).toBe('kill-ceiling');
  });
});

// ── F-10.4 / F-10.5 ──────────────────────────────────────────────────────────
describe('decideStuckAction — CodexItem widening (F-10.4, F-10.5)', () => {
  it('a CodexItem tool declaring a timeout beyond the ceiling widens the ceiling', () => {
    const declaredMs = 45 * 60 * 1000;
    const codexAt = (heartbeatAgeMs: number): ContainerState => ({
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: declaredMs,
      tool_started_at: new Date(BASE - heartbeatAgeMs).toISOString(),
    });

    // No kill at 35 min heartbeat age — under the widened 45-min ceiling.
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 35 * 60 * 1000,
        containerState: codexAt(35 * 60 * 1000),
        claims: [],
      }).action,
    ).toBe('ok');

    // kill-ceiling at 50 min — past the widened 45-min ceiling.
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 50 * 60 * 1000,
        containerState: codexAt(50 * 60 * 1000),
        claims: [],
      }).action,
    ).toBe('kill-ceiling');

    // A Bash control behaves identically.
    const bashAt35: ContainerState = {
      current_tool: 'Bash',
      tool_declared_timeout_ms: declaredMs,
      tool_started_at: new Date(BASE - 35 * 60 * 1000).toISOString(),
    };
    expect(
      decideStuckAction({ now: BASE, heartbeatMtimeMs: BASE - 35 * 60 * 1000, containerState: bashAt35, claims: [] })
        .action,
    ).toBe('ok');

    // Control with no declared-timeout-eligible tool in flight: the ceiling
    // stays at the default 30 min, so 35 min already kills. This is the
    // behavior CodexItem support exists to change — the two assertions above
    // MUST fail if that support is deleted from activeOperationTimeoutMs.
    const noTool: ContainerState = { current_tool: null, tool_declared_timeout_ms: null, tool_started_at: null };
    expect(
      decideStuckAction({ now: BASE, heartbeatMtimeMs: BASE - 35 * 60 * 1000, containerState: noTool, claims: [] })
        .action,
    ).toBe('kill-ceiling');
  });

  it('a CodexItem declared timeout widens the claim tolerance', () => {
    const declaredMs = 20 * 60 * 1000;
    const state: ContainerState = {
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: declaredMs,
      tool_started_at: new Date(BASE).toISOString(),
    };
    // 5-min-old claim: under the 20-min widened tolerance, not stuck — where
    // the 60s default would have killed it.
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: 0,
        containerState: state,
        claims: [claim('m1', 5 * 60 * 1000)],
      }).action,
    ).toBe('ok');

    // 25-min-old claim: past the 20-min widened tolerance.
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: 0,
        containerState: state,
        claims: [claim('m1', 25 * 60 * 1000)],
      }).action,
    ).toBe('kill-claim');
  });
});

// ── decideProviderHeal ────────────────────────────────────────────────────────
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

// ── observeProviderStatus — two-tick debounce, plus F-10.3 ───────────────────
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

  // F-10.3 — through the real driver's `!alive` path (constraint 14), not by
  // calling a clear function directly: `providerFailedTicks` is a
  // driver-owned export of host-sweep.ts precisely so its own `!alive`
  // cleanup can stay synchronous (see that export's doc comment).
  it('the two-tick provider debounce is cleared when the container is not alive', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-debounce', 'debounce', 'debounce-folder', ?)`,
    ).run(new Date().toISOString());

    _resetProviderHealTicksForTesting();
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockHasContainerEverRun.mockReset().mockReturnValue(true);
    mockAdmitDueTaskContexts.mockReset().mockReturnValue(0);

    const session: Session = { ...fakeSession(), id: 'sess-debounce', agent_group_id: 'ag-debounce' };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    widenContainerStateSchema(outboundPath);
    const raw = new Database(outboundPath);
    raw
      .prepare(
        `INSERT INTO container_state (id, updated_at, provider_status, provider_failure_reason)
         VALUES (1, ?, 'failed', 'gone')`,
      )
      .run(new Date().toISOString());
    raw.close();

    // Tick 1, alive: arms the debounce to 1.
    await _sweepSessionForTesting(session);
    expect(providerFailedTicks.get(session.id)).toBe(1);
    expect(mockKillContainer).not.toHaveBeenCalled();

    // Tick 2, NOT alive: session:health never runs (the driver gates it on
    // `alive`), but the driver's own `!alive` cleanup (outside that gate)
    // must still fire and drop the entry.
    mockIsContainerRunning.mockReturnValue(false);
    await _sweepSessionForTesting(session);
    expect(providerFailedTicks.has(session.id)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();

    // Tick 3, alive again: a fresh debounce starts at 1, not 3 — proof the
    // cleanup actually ran rather than the count merely not yet reaching the
    // kill threshold.
    mockIsContainerRunning.mockReturnValue(true);
    await _sweepSessionForTesting(session);
    expect(providerFailedTicks.get(session.id)).toBe(1);
    expect(mockKillContainer).not.toHaveBeenCalled();

    closeDb();
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
    const db = initTestDb();
    runMigrations(db);
    armSelfHeal(true);
    _resetProviderHealTicksForTesting();
    mockMarkProviderUnavailable.mockReset();
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'codex' });
    mockGetSession.mockReset().mockReturnValue(fakeSession());
    mockWakeContainer.mockReset();
    // Both of this duty's container preconditions, stated rather than
    // inherited from whatever an earlier describe left on these shared spies.
    //
    // A heal is only ever decided for a container the driver saw ALIVE (the
    // whole session:health phase is gated on it), and #343's re-check reads
    // that same fact back immediately before acting — so the default here is
    // `true`. The park path then kills the container and only afterwards
    // writes its notice, and "no container owns outbound" is the production
    // precondition for that write (mailbox seam PR 5b's
    // `writeOutboundWhenStopped`). `killContainer` is mocked, so nothing would
    // flip the flag on its own: give the mock production's own side effect
    // instead of hard-coding one end of the sequence and breaking the other.
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockKillContainer.mockReset().mockImplementation((_sessionId: string, _reason: string, onExit?: () => void) => {
      // Production's own side effect, in the order the duty depends on: the
      // container is gone the moment the kill lands. A HEAL kill hands its
      // respawn to `onExit`, so the container comes back and the next attempt
      // in a budget-exhaustion loop still starts from a live one; a PARK kill
      // passes no `onExit` and the container stays down, which is exactly the
      // precondition the parked notice's `writeOutboundWhenStopped` guard
      // checks a moment later.
      mockIsContainerRunning.mockReturnValue(Boolean(onExit));
    });
  });
  afterEach(() => {
    armSelfHeal(false);
    closeDb();
  });

  it('does nothing on the first failed tick, heals on the second', async () => {
    const { inDb, mailbox } = makeSessionDbs();
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(healRows(inDb)).toHaveLength(0);

    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED)).toBe(true);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal', expect.any(Function));
  });

  it('cancels the debounce when a healthy status lands in between', async () => {
    const { mailbox } = makeSessionDbs();
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
    const { outDb, mailbox } = makeSessionDbs();
    await twoFailedTicks(mailbox, outDb);
    expect(mockMarkProviderUnavailable).toHaveBeenCalledWith('ag-test', 'codex', 'unavailable', {
      message: 'stream closed',
    });
  });

  it('respawns on the primary and records no health window without a declared fallback', async () => {
    const { outDb, mailbox } = makeSessionDbs();
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
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal-parked');
    expect(healRows(inDb)).toHaveLength(PROVIDER_HEAL_MAX_ATTEMPTS);

    const notices = outDb
      .prepare("SELECT content FROM messages_out WHERE id LIKE 'provider-heal-parked-%'")
      .all() as Array<{ content: string }>;
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0].content)._system.kind).toContain('provider_heal_parked:');

    // The idempotency rerun needs its own precondition. The park kill above
    // hands `killContainer` no `onExit`, so the mock leaves the container
    // stopped — and #343's re-check would then claim the pass and return
    // before the notice logic ran at all, making "still one notice" true for
    // the wrong reason. State that a container is there to park again, so the
    // rerun reaches `notifyProviderHealParked` and the per-episode marker is
    // what suppresses the second write.
    mockIsContainerRunning.mockReturnValue(true);
    mockKillContainer.mockClear();
    _resetProviderHealTicksForTesting();
    await twoFailedTicks(mailbox, outDb);
    // It really did take the park branch again — otherwise the assertion below
    // proves nothing about idempotency.
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal-parked');
    expect(
      outDb.prepare("SELECT COUNT(*) AS c FROM messages_out WHERE id LIKE 'provider-heal-parked-%'").get(),
    ).toEqual({ c: 1 });
  });

  /**
   * #343 — the kill decision rests on reads two mailbox opens old.
   *
   * `containerState` is the driver's observe read and the `alive` verdict that
   * admitted this session to the health phase is older still; the budget read
   * inside the duty awaits between them. A container that self-exits in that
   * window needs no kill, and the accountability wake row is what would cost
   * it: written before the kill and counted forever afterwards, so the next
   * genuine failure would start one attempt down and park early.
   */
  it('a container that has already exited consumes no heal attempt', async () => {
    const { inDb, outDb, mailbox } = makeSessionDbs();
    // Arm the debounce on a live container, exactly as the two-tick path does.
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED, intoOutDb(outDb))).toBe(
      false,
    );
    // …then the container goes away on its own, before the tick that would act.
    mockIsContainerRunning.mockReturnValue(false);

    // TRUE, not false: this is the exclusive chain's first claimant, and `false`
    // would hand S12/S13/S14 the same stale observation to act on. The slot is
    // claimed with nothing done — which is what the pre-#343 code achieved by
    // killing a dead container and spending an attempt for it.
    expect(await _sweepProviderHealForTesting(mailbox, fakeSession(), 'group-folder', FAILED, intoOutDb(outDb))).toBe(
      true,
    );

    expect(mockKillContainer).not.toHaveBeenCalled();
    // The budget is untouched: no attempt row, so a later real failure still
    // has both attempts.
    expect(healRows(inDb)).toHaveLength(0);
    expect(countProviderHealAttemptsSinceRealInbound(mailbox)).toBe(0);
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
    const { mailbox } = makeSessionDbs();
    expect(notifyProviderHealParked(mailbox, fakeSession(), 'boom')).toBe(false);
  });
});

// ── F-10.6 ───────────────────────────────────────────────────────────────────
describe('OOM and memory-pressure notices are written only on the SLA path, with onWake=0', () => {
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

  // F-10.6's "chain claimed earlier by an idle reap → no row" half, for BOTH
  // reaps, each driven through the real registry via `_sweepSessionForTesting`
  // (S12/S13 are S2-PR3's family, registered in host-sweep.ts — this proves
  // MY module's S14/S16 correctly yield to them, not that S12/S13 themselves
  // are correct). Each case changes the OOM count between tick 1 (a baseline
  // notice, SLA legitimately ran) and tick 2 (the reap wins instead) — a
  // fixed count would let the observer's own kill-delta dedup mask a real
  // regression where the SLA branch ran a second time and simply had nothing
  // new to report.
  it('the idle-task reap winning the chain suppresses the SLA branch, discriminated by a changed OOM count', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-task-reap', 'task-reap', 'task-reap-folder', ?)`,
    ).run(new Date().toISOString());

    armSelfHeal(false);
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockHasContainerEverRun.mockReset().mockReturnValue(true);
    mockAdmitDueTaskContexts.mockReset().mockReturnValue(0);

    const session: Session = {
      ...fakeSession(),
      id: 'sess-task-reap',
      agent_group_id: 'ag-task-reap',
      thread_id: 'system:tasks:series-1',
    };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    const inboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'inbound.db');
    widenContainerStateSchema(outboundPath);

    let raw = new Database(outboundPath);
    // A live processing claim keeps shouldReapIdleTaskContainer from
    // claiming on tick 1 (processingClaimCount !== 0) — the chain falls
    // through to the SLA branch, which legitimately writes a baseline OOM
    // notice for count=3.
    raw
      .prepare(`INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('claim-1', 'processing', ?)`)
      .run(new Date().toISOString());
    raw
      .prepare(`INSERT INTO container_state (id, updated_at, memory_oom_kill_events) VALUES (1, ?, 3)`)
      .run(new Date().toISOString());
    raw.close();

    await _sweepSessionForTesting(session);
    expect(mockKillContainer).not.toHaveBeenCalled();
    const idsAfterTick1 = new Set(
      (new Database(inboundPath).prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((r) => r.id),
    );
    expect([...idsAfterTick1].some((id) => id.startsWith('oom-'))).toBe(true);

    // Clear the claim (S12 can now claim) and bump the OOM count — if the
    // SLA branch ran again this tick, THIS delta (3 -> 9) would produce a
    // new, distinguishable notice.
    raw = new Database(outboundPath);
    raw.prepare('DELETE FROM processing_ack').run();
    raw.prepare('UPDATE container_state SET memory_oom_kill_events = 9 WHERE id = 1').run();
    raw.close();

    await _sweepSessionForTesting(session);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-task-reap', 'scheduled-task-idle');

    const rowsAfterTick2 = new Database(inboundPath).prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
    }>;
    const newIds = rowsAfterTick2.map((r) => r.id).filter((id) => !idsAfterTick1.has(id));
    expect(newIds.some((id) => id.startsWith('oom-') || id.startsWith('recall-oom-'))).toBe(false);

    closeDb();
  });

  it('the idle-chat reap winning the chain suppresses the SLA branch, discriminated by a changed OOM count', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-chat-reap', 'chat-reap', 'chat-reap-folder', ?)`,
    ).run(new Date().toISOString());

    armSelfHeal(false);
    mockKillContainer.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockHasContainerEverRun.mockReset().mockReturnValue(true);
    mockAdmitDueTaskContexts.mockReset().mockReturnValue(0);

    const session: Session = { ...fakeSession(), id: 'sess-chat-reap', agent_group_id: 'ag-chat-reap' };
    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    const inboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'inbound.db');
    widenContainerStateSchema(outboundPath);

    // A due message keeps shouldReapIdleChatContainer from claiming on tick 1
    // (dueMessageCount !== 0) — the chain falls through to the SLA branch,
    // which legitimately writes a baseline OOM notice for count=3. A recent
    // outbound reply means the idle floor has not been reached either way.
    const rawIn = new Database(inboundPath);
    rawIn
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES ('due-1', 900, 'chat', ?, 'pending', 1, ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ text: 'hi', senderId: 'U1' }));
    rawIn.close();

    let raw = new Database(outboundPath);
    raw
      .prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('out-1', 1, ?, 'chat', '{}')`)
      .run(new Date().toISOString());
    raw
      .prepare(`INSERT INTO container_state (id, updated_at, memory_oom_kill_events) VALUES (1, ?, 3)`)
      .run(new Date().toISOString());
    raw.close();

    await _sweepSessionForTesting(session);
    expect(mockKillContainer).not.toHaveBeenCalled();
    const idsAfterTick1 = new Set(
      (new Database(inboundPath).prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((r) => r.id),
    );
    expect([...idsAfterTick1].some((id) => id.startsWith('oom-'))).toBe(true);

    // Complete the due message (S13 can now claim) and age the last outbound
    // reply past CHAT_IDLE_REAP_MS; bump the OOM count — if the SLA branch
    // ran again this tick, THIS delta (3 -> 9) would produce a new,
    // distinguishable notice.
    // Delete rather than mark completed: `latestInboundTimestamp()` (which
    // feeds `lastInboundAtMs`, and the idle floor is measured against
    // whichever of inbound/outbound is more recent) has no status filter, so
    // a merely-completed row at "just now" would still read as fresh
    // activity and defeat the aged-outbound timestamp below. The tick-1 OOM
    // notice itself (host-written, on the inbound side) is the same kind of
    // confound — age it too, or it alone keeps `lastInboundAtMs` fresh.
    const rawIn2 = new Database(inboundPath);
    rawIn2.prepare(`DELETE FROM messages_in WHERE id = 'due-1'`).run();
    rawIn2
      .prepare(`UPDATE messages_in SET timestamp = ? WHERE id LIKE 'oom-%' OR id LIKE 'recall-oom-%'`)
      .run(new Date(Date.now() - CHAT_IDLE_REAP_MS - 60_000).toISOString());
    rawIn2.close();
    raw = new Database(outboundPath);
    raw
      .prepare('UPDATE messages_out SET timestamp = ? WHERE id = ?')
      .run(new Date(Date.now() - CHAT_IDLE_REAP_MS - 60_000).toISOString(), 'out-1');
    raw.prepare('UPDATE container_state SET memory_oom_kill_events = 9 WHERE id = 1').run();
    raw.close();

    await _sweepSessionForTesting(session);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-chat-reap', 'chat-idle-reap');

    const rowsAfterTick2 = new Database(inboundPath).prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
    }>;
    const newIds = rowsAfterTick2.map((r) => r.id).filter((id) => !idsAfterTick1.has(id));
    expect(newIds.some((id) => id.startsWith('oom-') || id.startsWith('recall-oom-'))).toBe(false);

    closeDb();
  });
});

// ── F-10.2 ───────────────────────────────────────────────────────────────────
describe('provider self-heal claims the health phase and the later branches do not run', () => {
  it('a heal that kills stops the exclusive chain: no idle reap, no SLA branch, no OOM row', async () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-health', 'health', 'health-folder', ?)`,
    ).run(new Date().toISOString());

    armSelfHeal(true);
    _resetProviderHealTicksForTesting();
    mockKillContainer.mockReset();
    mockWakeContainer.mockReset();
    mockGetSession.mockReset();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockHasContainerEverRun.mockReset().mockReturnValue(true);
    mockAdmitDueTaskContexts.mockReset().mockReturnValue(0);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'codex' });

    const session: Session = { ...fakeSession(), id: 'sess-health', agent_group_id: 'ag-health' };
    mockGetSession.mockReturnValue(session);

    getAgentMailbox().prepare({ agentGroupId: session.agent_group_id, sessionId: session.id });

    // This row also carries OOM telemetry that WOULD trigger a notice on the
    // SLA path, so a row appearing in messages_in below would mean the chain
    // did not actually stop at S11.
    const outboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db');
    widenContainerStateSchema(outboundPath);
    const raw = new Database(outboundPath);
    raw
      .prepare(
        `INSERT INTO container_state (id, updated_at, provider_status, provider_failure_reason, memory_oom_kill_events)
         VALUES (1, ?, 'failed', 'gone', 3)`,
      )
      .run(new Date().toISOString());
    raw.close();

    // Tick 1 only arms the two-tick debounce — decideProviderHeal returns
    // 'wait', so the chain falls through to the SLA branch (S12/S13 don't
    // claim either), which legitimately writes an OOM notice (plus its
    // recall-marker row) for the telemetry above. That is the baseline this
    // test exists to contrast with tick 2.
    await _sweepSessionForTesting(session);
    expect(mockKillContainer).not.toHaveBeenCalled();

    const inboundPath = path.join(testDataDir.dir, 'v2-sessions', session.agent_group_id, session.id, 'inbound.db');
    const idsAfterTick1 = new Set(
      (new Database(inboundPath).prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((r) => r.id),
    );
    expect([...idsAfterTick1].some((id) => id.startsWith('oom-'))).toBe(true);

    // Bump the OOM count before tick 2 — a FIXED count would let the
    // observer's own kill-delta dedup mask a real regression: if the SLA
    // branch ran a second time, it would see the same cumulative count and
    // correctly emit nothing, indistinguishable from the chain having
    // stopped at S11. A changed count makes "no new row" mean the SLA
    // branch's own observation hook was never reached this tick.
    const bump = new Database(outboundPath);
    bump.prepare('UPDATE container_state SET memory_oom_kill_events = 9 WHERE id = 1').run();
    bump.close();

    // Tick 2: two consecutive 'failed' observations — decideProviderHeal
    // returns 'heal', claims() is true, and the exclusive chain must stop.
    await _sweepSessionForTesting(session);

    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-health', 'provider-failed-selfheal', expect.any(Function));
    // Not reaped, not killed for the ceiling or a stuck claim.
    for (const wrongReason of ['scheduled-task-idle', 'chat-idle-reap', 'absolute-ceiling', 'claim-stuck']) {
      expect(mockKillContainer).not.toHaveBeenCalledWith('sess-health', wrongReason, expect.anything());
    }

    const rowsAfterTick2 = new Database(inboundPath).prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
    }>;
    const newIds = rowsAfterTick2.map((r) => r.id).filter((id) => !idsAfterTick1.has(id));
    // Exactly the provider-heal accountability wake (plus its recall marker)
    // — no SECOND SLA observe session ran this tick, so no additional OOM
    // notice and no kill-ceiling notice, even though the container_state row
    // now carries a CHANGED OOM count (3 -> 9) that would have produced a new,
    // distinguishable notice had the SLA branch run again.
    expect(newIds).toHaveLength(2);
    expect(newIds.every((id) => /^(recall-)?provider-heal-\d+$/.test(id))).toBe(true);
    expect(newIds.some((id) => id.startsWith('oom-') || id.startsWith('recall-oom-'))).toBe(false);
    expect(newIds.some((id) => id.startsWith('sys-kill-ceiling-'))).toBe(false);

    closeDb();
    armSelfHeal(false);
  });
});

// ── Registered-entry coverage (pre-review addition: drive the REGISTRATION,
// not only the underlying body — same pattern Codex flagged on two sibling
// families) ───────────────────────────────────────────────────────────────
//
// F-10.2 above already does this for S11's `claims()` and S16's SLA hook end
// to end — it obtains them from the registry (via `_sweepSessionForTesting`'s
// real call into `runExclusiveSessionPhase` / `runSlaObservationHooks`, not a
// hand-built stand-in) and asserts on `sweepProviderHeal`'s and
// `reportContainerOomTelemetry`'s real dependencies (killContainer,
// writeSystemWake's row). The three cases below are the lighter, targeted
// complement: each fetches the duty/hook directly from
// `_listSweepRegistrationsForTesting()` by its inventory name and invokes
// `claims`/`run` itself, pinning the registration's own wiring (which fields
// of `ctx` it reads, in what order) independently of the full driver.
describe('registered S11/S14/S16 entries reach their bodies', () => {
  beforeEach(() => {
    mockKillContainer.mockReset();
    mockGetSession.mockReset();
    mockWakeContainer.mockReset();
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'codex' });
    _resetProviderHealTicksForTesting();
  });

  it('S11: the registered claims() delegates to sweepProviderHeal and reaches killContainer', async () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const s11 = duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.S11)!;
    expect(s11.phase).toBe('session:health');
    expect(s11.order).toBe(10);
    expect(s11.claims).toBeDefined();

    armSelfHeal(true);
    const { mailbox } = makeSessionDbs();
    const session = fakeSession();
    mockGetSession.mockReturnValue(session);
    const FAILED = { provider_status: 'failed', provider_failure_reason: 'gone' } as unknown as ContainerState;
    const ctx = {
      session,
      agentGroupFolder: 'group-folder',
      observed: { containerState: FAILED, processingClaimCount: 0, lastOutboundAtMs: null, lastInboundAtMs: null },
      run: async (action: (m: NanoclawMailboxSession) => unknown) => action(mailbox),
    } as unknown as Parameters<NonNullable<typeof s11.claims>>[0];

    // Two consecutive ticks — the debounce s11.claims() itself advances.
    expect(await s11.claims!(ctx)).toBe(false);
    expect(await s11.claims!(ctx)).toBe(true);
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'provider-failed-selfheal', expect.any(Function));

    // run() is the no-op log branch taken when claims() already handled it.
    expect(() => s11.run(ctx)).not.toThrow();
    armSelfHeal(false);
  });

  /**
   * #343, at the level the bug actually lives: the exclusive chain.
   *
   * `runExclusiveSessionPhase` walks `session:health` in order, calls each
   * duty's `claims()`, and stops at the first one that answers true; a `false`
   * from S11 hands the slot to S12 (idle-task reap), S13 (idle-chat reap) and
   * finally S14 (the SLA fallthrough) — all of which would then act on the
   * SAME stale observation, against a container that has already exited.
   *
   * So this walks the REGISTERED duties exactly as the driver does, recording
   * who is consulted, and pins that S11 claims the pass on its own.
   */
  it('S11 claims the pass when the heal target has already exited, so S12/S13/S14 never run', async () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const chain = duties.filter((d) => d.phase === 'session:health').sort((a, b) => a.order - b.order);
    // The chain this case is about: heal (10) → idle-task (20) → idle-chat (30)
    // → SLA (40, the fallthrough with no claims()).
    expect(chain.map((d) => d.name)).toEqual([
      SWEEP_DUTY_INVENTORY.S11,
      SWEEP_DUTY_INVENTORY.S12,
      SWEEP_DUTY_INVENTORY.S13,
      SWEEP_DUTY_INVENTORY.S14,
    ]);

    armSelfHeal(true);
    const { inDb, mailbox } = makeSessionDbs();
    const session = fakeSession();
    mockGetSession.mockReturnValue(session);
    const FAILED_STATE = { provider_status: 'failed', provider_failure_reason: 'gone' } as unknown as ContainerState;
    const ctx = {
      session,
      agentGroupId: session.agent_group_id,
      agentGroupFolder: 'group-folder',
      killSnapshot: null,
      observed: {
        containerState: FAILED_STATE,
        processingClaimCount: 0,
        lastOutboundAtMs: null,
        lastInboundAtMs: null,
      },
      run: async (action: (m: NanoclawMailboxSession) => unknown) => action(mailbox),
      runIn: async (_window: string, action: (m: NanoclawMailboxSession) => unknown) => action(mailbox),
    } as unknown as Parameters<NonNullable<(typeof chain)[number]['claims']>>[0];

    // Tick 1 on a LIVE container only arms the two-tick debounce.
    mockIsContainerRunning.mockReturnValue(true);
    expect(await chain[0].claims!(ctx)).toBe(false);

    // The container exits on its own inside the window the driver cannot see:
    // `alive` was read before the observe open, and the budget read awaits
    // again after it.
    mockIsContainerRunning.mockReturnValue(false);
    mockKillContainer.mockClear();

    // The driver's own loop, verbatim (src/host-sweep.ts runExclusiveSessionPhase).
    const consulted: string[] = [];
    let claimedBy: string | null = null;
    for (const duty of chain) {
      if (!duty.claims) continue;
      consulted.push(duty.name);
      if (await duty.claims(ctx)) {
        claimedBy = duty.name;
        await duty.run(ctx);
        break;
      }
    }
    if (!claimedBy) {
      const fallthrough = chain.find((d) => !d.claims)!;
      consulted.push(fallthrough.name);
      await fallthrough.run(ctx);
    }

    // S11 took the pass; nothing after it was even asked.
    expect(claimedBy).toBe(SWEEP_DUTY_INVENTORY.S11);
    expect(consulted).toEqual([SWEEP_DUTY_INVENTORY.S11]);
    // …and it did nothing while holding the slot: no kill of any kind, and no
    // accountability wake row, so the attempt budget is intact.
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(inDb.prepare("SELECT id FROM messages_in WHERE id LIKE 'provider-heal-%'").all()).toHaveLength(0);
    expect(countProviderHealAttemptsSinceRealInbound(mailbox)).toBe(0);

    armSelfHeal(false);
  });

  it('S14: the fallthrough run() opens its own observe session, decides via decideStuckAction, and kills', async () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const s14 = duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.S14)!;
    expect(s14.phase).toBe('session:health');
    expect(s14.order).toBe(40);
    expect(s14.claims).toBeUndefined(); // the fallthrough — exclusive-phase contract

    const { outDb, mailbox } = makeSessionDbs();
    outDb
      .prepare(`INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', ?)`)
      .run(new Date(Date.now() - CLAIM_STUCK_MS - 10_000).toISOString());

    const session = fakeSession();
    const windowsSeen: string[] = [];
    const ctx = {
      session,
      agentGroupId: session.agent_group_id,
      agentGroupFolder: 'group-folder',
      killSnapshot: null,
      runIn: async (window: string, action: (m: NanoclawMailboxSession) => unknown) => {
        windowsSeen.push(window);
        return action(mailbox);
      },
    } as unknown as Parameters<typeof s14.run>[0];

    await s14.run(ctx);

    expect(windowsSeen).toContain('session:health:sla-observe');
    expect(mockKillContainer).toHaveBeenCalledWith('sess-test', 'claim-stuck');
  });

  it('S16: the registered SLA-observation hook calls reportContainerOomTelemetry with the observed snapshot', () => {
    const { slaObservationHooks } = _listSweepRegistrationsForTesting();
    const s16 = slaObservationHooks.find((h) => h.name === SWEEP_DUTY_INVENTORY.S16)!;
    expect(s16.order).toBe(10);

    const { inDb, mailbox } = makeNotifyTestDbs();
    const session = fakeSession();
    const state = {
      current_tool: null,
      tool_declared_timeout_ms: null,
      tool_started_at: null,
      memory_oom_kill_events: 5,
    } as ContainerState;
    const ctx = { session, agentGroupFolder: 'ag-test' } as unknown as Parameters<typeof s16.run>[0];

    s16.run(ctx, state, mailbox);

    const rows = inDb.prepare("SELECT id FROM messages_in WHERE kind = 'chat'").all() as Array<{ id: string }>;
    expect(rows.some((r) => r.id.startsWith('oom-kill-'))).toBe(true);
  });
});

// ── Tripwire self-check (brief-common.md HARD RULE step 3) ─────────────────
it('the child_process tripwire bites when a seam mock is removed', () => {
  const record: string[] = [];
  const tripwire = childProcessTripwire(record);
  expect(() => tripwire.execFileSync!('docker')).toThrow(/real process spawn attempted/);
  expect(record).toEqual(['execFileSync']);
});
