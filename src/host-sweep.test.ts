/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * Also contains C3 watchdog integration tests.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { getAgentMailbox } from './mailbox/index.js';
import { withExistingMailboxSession } from './session-manager.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
import {
  ABSOLUTE_CEILING_MS,
  _resetSweepRegistryForTesting,
  registerSweepKillFollowUp,
  _sweepSessionForTesting,
  parseSqliteUtc,
} from './host-sweep.js';
// S14 (the running-container SLA) and both post-kill write paths moved to the
// container-health family in S2-PR10; its test-only entry point moved with the
// body. These SLA cases are mailbox seam PR 5b's and B1's, and they still drive
// the same duty through the same registry.
import {
  _enforceRunningContainerSlaForTesting,
  _resetPostKillForTesting,
  _settlePostKillForTesting,
} from './modules/sweep-container-health/index.js';
// T19 (the usage rollup) moved to the sweep-usage family in S2-PR12, and the
// module exports its body directly. The two cases below are mailbox seam
// PR 6's (Codex P2, the hot-journal durability options): they exercise the
// REAL read funnel against real SQLite files and create a genuine hot journal
// with a killed child process, neither of which the family's own suite can do
// — it mocks `readSessionOutbound` and arms a `child_process` tripwire. So the
// cases stay on this file's fixture and reach across for the moved body, the
// same way the SLA cases above do.
import { sweepUsageRollup as _sweepUsageRollupForTesting } from './modules/sweep-usage/index.js';
// The TOCTOU entry point moved with `incrementStoppedContinuationAttempt` into
// the continuation family (S2-PR13); the case below is unchanged.
import { _incrementStoppedContinuationAttemptForTesting } from './modules/sweep-continuation/index.js';
// The error-rule case below drives a THROW through the due-admission duty
// (S5), which now lives in the scheduling family module (S2-PR11) — importing
// it registers that duty so the case keeps its original vehicle.
import './modules/sweep-scheduling/index.js';
// The post-kill follow-up chain this file asserts is now spread across three
// families: S15 (ceiling notice) and S10 (accountability wake) register from
// sweep-continuation, S17's post-kill orphan-claim reset from sweep-session-core.
// Without these side-effect imports `runSweepKillFollowUps` dispatches nothing
// and the control arm of the post-kill case fails — the sibling-family import
// S2-PR14's 23f0c4ab added to the family suites, owed here for the same reason.
import './modules/sweep-session-core/index.js';
import { getRawDb } from './db/connection.js';
import type { Session } from './types.js';

// ─── Module mocks for C3 watchdog integration tests ──────────────────────────
// These mocks are hoisted and only affect tests that use them. The existing
// decideStuckAction / resetStuckProcessingRows tests are pure and don't invoke
// these imports, so they are unaffected.

// Shadow-mode flag. host-sweep captures SELF_HEAL_ENABLED as a module-level
// const, so the mock exposes it as a getter over a mutable box.
const selfHeal = vi.hoisted(() => ({ enabled: false }));
// DATA_DIR is redirected at a per-run temp root so anything in this file that
// resolves a session path (the mailbox seam's `sessionMailboxPath`, heartbeats,
// `sessionsBaseDir`) can never reach the real install's data directory.
const testDataDir = await vi.hoisted(async () => {
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
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
    await initTestDb();
    const db = getRawDb();
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
      await closeDb();
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
      await closeDb();
      return;
    }

    await _sweepUsageRollupForTesting([session]);

    // The fix: readSessionOutbound recovers the journal before reading, so
    // the row that was already committed lands in the central ledger and the
    // watermark advances. Without it (default recoverJournal: false, 1s
    // timeout), the read throws, `sweepUsageRollup`'s per-session catch
    // swallows it, and this table stays empty forever.
    const rows = getRawDb().prepare('SELECT provider, model FROM turn_usage WHERE session_id = ?').all(session.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);
    await closeDb();
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
    await initTestDb();
    const db = getRawDb();
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
    await closeDb();
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
      withExistingMailboxSession(session.agent_group_id, session.id, action as never)) as never;
    return { session, claims, run };
  }

  it('a replacement container that wakes during the post-kill open keeps its claim (ceiling)', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    // Production's shape, which the old bare mock did not model: the kill only
    // REQUESTS the stop, and the post-kill chain runs from the container's own
    // `close` — so invoke `onExit` rather than letting the chain vanish.
    // `isContainerRunning` stays under each case's control, which is how they
    // express "a replacement took the session" versus "it stayed dead".
    _resetPostKillForTesting();
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      onExit?.();
    });
    // Live all the way through: the container is alive so the SLA runs, and it
    // is STILL alive after the kill because a wake replaced it in the gap.
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    const f = slaFixture('sess-sla-ceiling', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');
    await _settlePostKillForTesting();

    // `killContainer` now takes an `onExit` third argument (Codex final), which is
    // a function when a container was there to kill and `undefined` when it had
    // already gone. The identity assertion is the first two arguments.
    expect(mockKillContainer).toHaveBeenCalledWith('sess-sla-ceiling', 'absolute-ceiling', expect.any(Function));
    // Claim intact and no restart notice written: both writes were skipped.
    expect(f.claims()).toBe(before);
    await closeDb();
  });

  it('a replacement container that wakes during the post-kill open gets no stale ceiling wake', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    // Production's shape, which the old bare mock did not model: the kill only
    // REQUESTS the stop, and the post-kill chain runs from the container's own
    // `close` — so invoke `onExit` rather than letting the chain vanish.
    // `isContainerRunning` stays under each case's control, which is how they
    // express "a replacement took the session" versus "it stayed dead".
    _resetPostKillForTesting();
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      onExit?.();
    });
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
    await _settlePostKillForTesting();

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
    await closeDb();
  });

  it('a replacement container that wakes during the post-kill open keeps its claim (claim-stuck)', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    // Production's shape, which the old bare mock did not model: the kill only
    // REQUESTS the stop, and the post-kill chain runs from the container's own
    // `close` — so invoke `onExit` rather than letting the chain vanish.
    // `isContainerRunning` stays under each case's control, which is how they
    // express "a replacement took the session" versus "it stayed dead".
    _resetPostKillForTesting();
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      onExit?.();
    });
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    // Heartbeat older than the claim and inside the ceiling: kill-claim, not kill-ceiling.
    const f = slaFixture('sess-sla-claim', 10 * 60_000, 5 * 60_000);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');
    await _settlePostKillForTesting();

    // `killContainer` now takes an `onExit` third argument (Codex final), which is
    // a function when a container was there to kill and `undefined` when it had
    // already gone. The identity assertion is the first two arguments.
    expect(mockKillContainer).toHaveBeenCalledWith('sess-sla-claim', 'claim-stuck', expect.any(Function));
    expect(f.claims()).toBe(before);
    await closeDb();
  });

  // Shared by the post-kill cases below. Pure file readers — no dependency on
  // which central DB is installed, so they are safe at describe scope.
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

  // ── Codex final, HIGH ─────────────────────────────────────────────────────
  //
  // `killContainer` only REQUESTS the stop: it calls `stopContainer` and
  // returns, and `activeContainers` is cleared by the spawn path's own `close`
  // handler when the child actually goes. Running the follow-up chain on the
  // next line therefore raced the exit — `containerOwnsOutbound` was still
  // true, the early-out fired, and the ceiling notice, the orphan-claim reset
  // and the accountability wake were skipped with nothing to retry them. The
  // chain now hangs off `onExit`, which fires after that finalizer.
  //
  // The fixture is the point: ownership stays TRUE after `killContainer`
  // returns and flips false only when `onExit` runs, which is production's
  // ordering and the one the old mocks did not have.
  it('the post-kill chain runs after the container actually exits, not when the kill is requested', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    _resetPostKillForTesting();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    let exit: (() => void) | undefined;
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      // Requested, not done: the container still owns outbound.db here.
      exit = onExit;
    });

    const f = slaFixture('sess-postkill-onexit', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    plantContinuation(f.session);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');

    // Nothing yet — and this is exactly where the old code ran the chain.
    await _settlePostKillForTesting();
    expect(f.claims(), 'the chain ran while the container still owned outbound.db').toBe(before);
    expect(respawnWakes(f.session)).toBe(0);

    // The child closes: ownership drops, then `onExit` fires.
    expect(exit, 'no onExit was registered, so the chain could never run').toBeDefined();
    mockIsContainerRunning.mockReturnValue(false);
    exit!();
    await _settlePostKillForTesting();

    expect(f.claims(), 'S17 did not reset the orphan claim').toBe(0);
    expect(respawnWakes(f.session), 'S10 did not queue the accountability wake').toBe(1);
  });

  it('a replacement container that takes the session before the exit still refuses the chain', async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    _resetPostKillForTesting();
    mockIsContainerRunning.mockReset().mockReturnValue(true);
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    let exit: (() => void) | undefined;
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      exit = onExit;
    });

    const f = slaFixture('sess-postkill-replaced', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    plantContinuation(f.session);
    const before = f.claims();
    await _enforceRunningContainerSlaForTesting(f.run, f.session, 'ag-sla', 'sla');

    // The old container goes, a fresh one is already up: ownership never drops.
    exit!();
    await _settlePostKillForTesting();

    expect(f.claims(), 'the fresh runner lost its claim').toBe(before);
    expect(respawnWakes(f.session), 'a stale accountability wake greeted the replacement').toBe(0);
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
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-sla', 'sla', 'sla', ?)`).run(
      new Date().toISOString(),
    );
    mockReadContainerConfig.mockReset().mockReturnValue({ provider: 'claude' });

    // Control: ownership never flips, so every follow-up writes.
    // Production's shape, which the old bare mock did not model: the kill only
    // REQUESTS the stop, and the post-kill chain runs from the container's own
    // `close` — so invoke `onExit` rather than letting the chain vanish.
    // `isContainerRunning` stays under each case's control, which is how they
    // express "a replacement took the session" versus "it stayed dead".
    _resetPostKillForTesting();
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      onExit?.();
    });
    mockIsContainerRunning.mockReset().mockReturnValue(false);
    const control = slaFixture('sess-followups-control', ABSOLUTE_CEILING_MS + 60_000, 10_000);
    plantContinuation(control.session);
    await _enforceRunningContainerSlaForTesting(control.run, control.session, 'ag-sla', 'sla');
    await _settlePostKillForTesting();

    // `killContainer` now takes an `onExit` third argument (Codex final), which is
    // a function when a container was there to kill and `undefined` when it had
    // already gone. The identity assertion is the first two arguments.
    // No container to kill (`isContainerRunning` is false before the SLA runs),
    // so there is no `close` to hang the chain off and it runs inline —
    // ownership is already gone. Asserted rather than left implicit: the
    // callback's presence is what the whole fix turns on.
    expect(mockKillContainer).toHaveBeenCalledWith('sess-followups-control', 'absolute-ceiling', undefined);
    expect(control.claims()).toBe(0); // S17 cleared the orphan claim
    expect(respawnWakes(control.session)).toBe(1); // S10 queued the accountability wake

    // Guarded: a wake takes the session between S15 (order 10) and S17 (order
    // 20) — registered as a follow-up at order 15, which is exactly the yield
    // boundary the loop's `await` creates.
    // Production's shape, which the old bare mock did not model: the kill only
    // REQUESTS the stop, and the post-kill chain runs from the container's own
    // `close` — so invoke `onExit` rather than letting the chain vanish.
    // `isContainerRunning` stays under each case's control, which is how they
    // express "a replacement took the session" versus "it stayed dead".
    _resetPostKillForTesting();
    mockKillContainer.mockReset().mockImplementation((_id: string, _reason: string, onExit?: () => void) => {
      onExit?.();
    });
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
      await _settlePostKillForTesting();

      // `killContainer` now takes an `onExit` third argument (Codex final): a
      // function when a container was there to kill, `undefined` when it had
      // already gone and the chain runs inline.
      expect(mockKillContainer).toHaveBeenCalledWith('sess-followups-guarded', 'absolute-ceiling', undefined);
      // Both later follow-ups skipped: the fresh runner keeps its claim and no
      // stale accountability wake was queued against its recovery cap.
      expect(guarded.claims()).toBe(claimsBefore);
      expect(respawnWakes(guarded.session)).toBe(0);
    } finally {
      _resetSweepRegistryForTesting();
    }
    await closeDb();
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
    await initTestDb();
    const db = getRawDb();
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
    await closeDb();
  });

  // Round 4: the outbound handle opens LAZILY, after the duties have started,
  // so `enteredPlanSession` is already true when it fails. The error class, not
  // the position, has to decide — otherwise a present-but-unreadable
  // outbound.db is retried and logged every 60s instead of backing off, which
  // is the repeated-error load the backoff exists to contain.
  it('an unreadable outbound.db takes the mailbox backoff, not the per-tick duty retry', async () => {
    await initTestDb();
    const db = getRawDb();
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
    await closeDb();
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
    await initTestDb();
    const db = getRawDb();
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
    // The wake guard re-reads it on the RAW handle (seam-3 §4.5 I-1), so the
    // closed row has to exist in the test DB, not only behind the leaf mock.
    await createSession({ ...snapshot, status: 'closed' });
    mockGetSession.mockReset().mockReturnValue({ ...snapshot, status: 'closed' });

    await _sweepSessionForTesting(snapshot);

    // The liveness proof now travels WITH the wake instead of preceding it: a
    // re-read here proves the row live before the call, and the call then
    // awaits admission, an unbounded memory-queue wait and the whole spawn
    // preparation. The guard is asked where the process is created.
    expect(mockWakeContainer).toHaveBeenCalledTimes(1);
    const { guard } = mockWakeContainer.mock.calls[0][2] as { guard: () => unknown };
    expect(guard()).toEqual({ ok: false, reason: 'session is closed' });
    await closeDb();
  });

  // Round 2: the backoff belongs to an unopenable mailbox, never to a duty
  // that threw. A transient SQLite lock during admission must retry on the
  // next 60s tick — quiet-caching it would hold an already-due scheduled task
  // for the full 30 minutes, and `last_active` does not move on failure, so
  // nothing would clear it early.
  it('a duty that throws propagates for the next-tick retry instead of being quiet-cached', async () => {
    await initTestDb();
    const db = getRawDb();
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
    await closeDb();
  });
});
