/**
 * Seam 3 PR 5b acceptance case §8.5: the wake guard the health tick consults
 * is SYNCHRONOUS.
 *
 * `sweepProviderHeal`'s `providerHealTargetUnavailableReason` evaluates
 * `sessionStillActive(sessionId)()` immediately before it spends a heal
 * attempt and kills the container. Seam 3 moved `getSession` onto the async
 * driver; the guard did NOT follow it (plan §4.5, I-1) — it executes the
 * sessions leaf's exported `SESSION_BY_ID_SQL` on the raw handle instead, so
 * no suspension point opens between "the row still allows a wake" and the act
 * the answer protects.
 *
 * The failure this pins is silent, not loud: a `WakeGuard` returning a promise
 * is TRUTHY, so `liveness !== true` would take the unavailable branch for a
 * perfectly live session (or, with the comparison written the other way, wave
 * a kill through against a closed one). Nothing in the type checker catches
 * it, which is why the assertion is on thenability at the call shape rather
 * than on a signature.
 *
 * Until PR 6 lands `evaluateGuardSync` (plan §8.5: "asserts `evaluateGuardSync`
 * is the call path once PR 6 lands; until then, asserts the guard's return is
 * not thenable") this file asserts the return value. The structural case below
 * is the other half: it pins that the health tick still calls the guard
 * without `await`, so a later edit cannot reintroduce the window by awaiting a
 * guard that happens to stay synchronous.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hermeticity tripwire (brief-common.md HARD RULE) ────────────────────────
// Importing container-runner.js pulls in its `child_process` surface. Nothing
// in this file should ever reach a real spawn; the tripwire records and throws
// so an accidental one fails loudly instead of doing real process work.
const spawns = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(
        `sweep-container-health/index.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`,
      );
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

// `log.js` is NOT mocked: `secret-scrubber.ts` calls `setLogScrubber` at module
// scope on the way in, so a factory that returns only `log` breaks the import
// graph (src/log-mock-tripwire.test.ts is the standing rule). The guard path
// under test logs nothing anyway.

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { sessionStillActive } from '../../container-runner.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * The columns `unwakeableReason` reads, and nothing else. A hand-cut table
 * rather than `runMigrations`, so this file never has to name the transitional
 * raw handle (src/db/raw-db-ratchet.test.ts pins that set, and it only
 * shrinks).
 */
async function seedSessions(): Promise<void> {
  await getDb().exec(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY,
       agent_group_id TEXT,
       status TEXT NOT NULL,
       archived_at TEXT
     )`,
  );
}

describe('wake guard is evaluated synchronously at the health tick', () => {
  beforeEach(async () => {
    await initTestDb();
    await seedSessions();
  });

  afterEach(async () => {
    await closeDb();
    expect(spawns).toEqual([]);
  });

  it('returns a plain verdict, never a thenable, for a live session', async () => {
    await getDb().run(
      `INSERT INTO sessions (id, agent_group_id, status, archived_at) VALUES (?, ?, ?, NULL)`,
      'sess-live',
      'ag-1',
      'active',
    );

    const verdict = sessionStillActive('sess-live')();

    expect(verdict).toBe(true);
    expect(typeof (verdict as { then?: unknown }).then).not.toBe('function');
  });

  it('returns a plain refusal, never a thenable, for a closed or archived session', async () => {
    await getDb().run(
      `INSERT INTO sessions (id, agent_group_id, status, archived_at) VALUES (?, ?, ?, NULL)`,
      'sess-closed',
      'ag-1',
      'closed',
    );
    await getDb().run(
      `INSERT INTO sessions (id, agent_group_id, status, archived_at) VALUES (?, ?, ?, ?)`,
      'sess-archived',
      'ag-1',
      'active',
      '2026-09-05T00:00:00.000Z',
    );

    for (const [sessionId, reason] of [
      ['sess-closed', 'session is closed'],
      ['sess-archived', 'session is archived'],
      ['sess-missing', 'session no longer exists'],
    ] as const) {
      const verdict = sessionStillActive(sessionId)();
      expect(verdict).toEqual({ ok: false, reason });
      expect(typeof (verdict as { then?: unknown }).then).not.toBe('function');
    }
  });

  it('the health tick consults the guard without awaiting it', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/modules/sweep-container-health/index.ts'), 'utf8');

    // Not vacuous: the duty really does reach the guard.
    expect(source).toContain('sessionStillActive(');
    // …and never behind an await, which is what would reopen the window.
    expect(source).not.toMatch(/await\s+sessionStillActive\s*\(/);
    // The immediate call form `sessionStillActive(x)()` is how the reason
    // helper spends it; an `await` on that call is the same regression wearing
    // a different shape.
    expect(source).not.toMatch(/await\s+\(?\s*sessionStillActive\s*\([^)]*\)\s*\)?\s*\(/);
  });
});
