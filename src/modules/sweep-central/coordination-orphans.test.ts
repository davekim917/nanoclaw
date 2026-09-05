/**
 * Acceptance cases for the `coordination-orphans` housekeeping duty (issue
 * #430, seam 4 series A′).
 *
 * The duty exists because migration 071 declares no foreign key: teardown
 * deletes a session's coordination rows, but a write that lands after the
 * delete — a mid-flight delivery failing, or the spawn path holding a claim —
 * recreates one that nothing else removes. Each case seeds one orphan and one
 * live row per table and asserts only the orphan is gone, so a `DELETE` that
 * lost its predicate fails here rather than in production.
 *
 * The logger is a complete stub, never `importOriginal()`: log.ts installs
 * process-wide uncaughtException/unhandledRejection handlers at module scope
 * (src/log-mock-tripwire.test.ts). The central DB is a real migrated file
 * opened through a throwaway handle, so this file never names the transitional
 * raw handle (src/db/raw-db-ratchet.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { closeDb, getDb, initDb, runMigrations } from '../../db/index.js';
import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY, type SweepTickContext } from '../../host-sweep.js';
import { log } from '../../log.js';
import { sweepCoordinationOrphans } from './coordination-orphans.js';
// Registers the family's duties (including this one) as a side effect.
import './index.js';

const LIVE = 'sess-live';
const GONE = 'sess-deleted';
const STAMP = '2026-09-05T00:00:00.000Z';

/** Rows in all three coordination tables, for a live session and a dead one. */
async function seedBothWays(): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'orphans', 'orphans', ?)`,
    STAMP,
  );
  await db.run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
     VALUES (?, 'ag-1', NULL, NULL, 'active', 'stopped', ?)`,
    LIVE,
    STAMP,
  );
  for (const sessionId of [LIVE, GONE]) {
    await db.run(
      `INSERT INTO delivery_attempts (message_id, session_id, attempts, last_attempt_at) VALUES (?, ?, 2, ?)`,
      `msg-${sessionId}`,
      sessionId,
      STAMP,
    );
    await db.run(
      `INSERT INTO session_claims (session_id, incarnation, claimed_by, updated_at) VALUES (?, 1, 'host-a', ?)`,
      sessionId,
      STAMP,
    );
    await db.run(
      `INSERT INTO wake_signals (id, session_id, reason, created_at) VALUES (?, ?, 'test', ?)`,
      `wake-${sessionId}`,
      sessionId,
      STAMP,
    );
  }
}

async function sessionIds(table: string): Promise<string[]> {
  const rows = await getDb().all<{ session_id: string }>(`SELECT session_id FROM ${table} ORDER BY session_id`);
  return rows.map((row) => row.session_id);
}

describe('coordination-orphans sweeps rows whose session is gone', () => {
  beforeEach(async () => {
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    // A migrated file DB rather than the in-memory helper: `runMigrations` is
    // still synchronous and takes a raw handle, so it runs on a throwaway
    // connection to the same file and the driver opens it after.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordination-orphans-'));
    const dbPath = path.join(dir, `central-${crypto.randomUUID()}.db`);
    const seed = new BetterSqlite3(dbPath);
    runMigrations(seed);
    seed.close();
    await initDb(dbPath, { role: 'test' });
  });

  afterEach(() => closeDb());

  it('deletes the orphan row and leaves the live session untouched, in all three tables', async () => {
    await seedBothWays();

    await sweepCoordinationOrphans();

    expect(await sessionIds('delivery_attempts')).toEqual([LIVE]);
    expect(await sessionIds('session_claims')).toEqual([LIVE]);
    expect(await sessionIds('wake_signals')).toEqual([LIVE]);
  });

  it('logs the counts once, and only when it removed something', async () => {
    await sweepCoordinationOrphans();
    expect(vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Coordination orphans swept')).toEqual([]);

    await seedBothWays();
    await sweepCoordinationOrphans();

    expect(vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Coordination orphans swept')).toEqual([
      ['Coordination orphans swept', { delivery_attempts: 1, session_claims: 1, wake_signals: 1 }],
    ]);

    // Nothing left to sweep, so the second pass is silent again — the steady
    // state this line has to stay quiet in.
    vi.mocked(log.info).mockClear();
    await sweepCoordinationOrphans();
    expect(vi.mocked(log.info).mock.calls.filter((call) => call[0] === 'Coordination orphans swept')).toEqual([]);
  });

  it('warns and resolves when the sweep cannot run, rather than throwing into the tick', async () => {
    await getDb().exec('DROP TABLE delivery_attempts');

    await expect(sweepCoordinationOrphans()).resolves.toBeUndefined();

    expect(vi.mocked(log.warn).mock.calls.map((call) => call[0])).toContain('Coordination orphan sweep failed');
  });

  it('is the registered duty body, not just a function this file calls', async () => {
    await seedBothWays();
    const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === SWEEP_DUTY_INVENTORY.FORK2);
    expect(duty, 'coordination-orphans is not registered').toBeDefined();
    expect([duty!.phase, duty!.order]).toEqual(['tick:housekeeping', 130]);

    const ctx: SweepTickContext = { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() };
    await duty!.run(ctx);

    expect(await sessionIds('delivery_attempts')).toEqual([LIVE]);
    expect(await sessionIds('session_claims')).toEqual([LIVE]);
    expect(await sessionIds('wake_signals')).toEqual([LIVE]);
  });
});
