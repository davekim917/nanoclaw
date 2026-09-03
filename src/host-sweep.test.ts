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

import { countDueMessages, type ContainerState } from './modules/mailbox/ops/sweep.js';
import { composeNanoclawSession, type NanoclawMailboxSession } from './modules/mailbox/index.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { ABSOLUTE_CEILING_MS, CLAIM_STUCK_MS, _sweepSessionForTesting, parseSqliteUtc } from './host-sweep.js';
// The error-rule case below drives a THROW through the due-admission duty
// (S5), which now lives in the scheduling family module (S2-PR11) — importing
// it registers that duty so the case keeps its original vehicle.
import './modules/sweep-scheduling/index.js';
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

// shouldReapIdleTaskContainer / shouldReapIdleChatContainer cases moved to
// src/modules/sweep-idle-reap/idle-reap.test.ts (seam 2, S2-PR3 — F-3.1).

// shouldSkipUsageRollup moved to src/modules/sweep-usage/usage.test.ts (S2-PR12, F-12.1).

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
