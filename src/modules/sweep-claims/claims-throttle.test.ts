/**
 * F-6.1 (plan.md §8, exact title), real-behavior case (Codex PR6 review
 * finding F3, accepted). claims.test.ts's "registered claims-self-heal
 * wrapper" cases prove the wrapper reaches a MOCKED sweepClaimsSelfHeal —
 * that proves the move preserved the call-through, not that the throttle and
 * cooldown behavior itself survived. This file does NOT mock self-heal.js:
 * it drives the REGISTERED T21 duty's `run(ctx)` (obtained from the registry
 * exactly as claims.test.ts does) through the REAL `sweepClaimsSelfHeal`,
 * mocking only its I/O seams — GitHub-adjacent task dispatch — the same way
 * `../claims/self-heal.test.ts` does for its own "REAL createTask path" case.
 *
 * Owner resolution goes through a REAL central-DB `wiredCandidates` query
 * (same fixture shape as self-heal.test.ts's own
 * `describe('wiredCandidates — where a claim can actually be reached', ...)`)
 * rather than an injected `resolveOwner`, because the wrapper's `run(ctx)`
 * calls `sweepClaimsSelfHeal()` with NO deps — exactly as production does —
 * so there is no injection seam to use here. The claim's owner name is
 * chosen to match the wired agent group's raw name on the first candidate
 * check, so resolution never needs `resolveAssistantName`/container config
 * (a container-runner/container-config dependency this hermetic test has no
 * reason to touch).
 *
 * `claimsBaseDir` (from `../claims/escalation.js`) is mocked to point at a
 * per-test tmp fixture, since the bare wrapper call never supplies
 * `deps.root` — production always resolves the real claims directory, but a
 * hermetic test must not.
 *
 * Hermeticity (brief-common.md HARD RULE): the child_process tripwire is
 * armed; nothing on this path should ever reach it (dispatch is mocked,
 * `wiredCandidates` hits an in-memory DB, everything else is fs-only).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAttempts = vi.hoisted(() => [] as string[]);

function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const attempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(
        `sweep-claims/claims-throttle.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`,
      );
    };
  return {
    exec: attempted('exec'),
    execFile: attempted('execFile'),
    execSync: attempted('execSync'),
    execFileSync: attempted('execFileSync'),
    spawn: attempted('spawn'),
    spawnSync: attempted('spawnSync'),
    fork: attempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawnAttempts));
vi.mock('node:child_process', () => childProcessTripwire(spawnAttempts));

afterEach(() => {
  expect(spawnAttempts).toEqual([]);
  spawnAttempts.length = 0;
});

const h = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { root: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'claims-throttle-')) };
});

const mockDispatch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));

vi.mock('../../cli/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cli/dispatch.js')>()),
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

vi.mock('../claims/escalation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../claims/escalation.js')>();
  return { ...real, claimsBaseDir: () => h.root };
});

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, SELF_HEAL_ENABLED: true, SELF_HEAL_TAKEOVER_ENABLED: true };
});

// Registers T20/T21 into host-sweep.ts's live registry, same as claims.test.ts.
import './index.js';
import { _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { _resetSelfHealThrottleForTesting, SELF_HEAL_MAX_NUDGES } from '../claims/self-heal.js';

function fakeTickContext(): SweepTickContext {
  return { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() } as unknown as SweepTickContext;
}

function getDuty(name: string) {
  const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
  if (!duty) throw new Error(`duty ${name} not registered`);
  return duty;
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-08-20T12:00:00Z');
const WORKGROUP = 'wg-a';
const SLUG = 'seam';

function claimDir(): string {
  return path.join(h.root, WORKGROUP, 'claims');
}

function writeClaim(claimedAtMs: number): void {
  fs.mkdirSync(claimDir(), { recursive: true });
  fs.writeFileSync(
    path.join(claimDir(), `${SLUG}.json`),
    JSON.stringify(
      {
        owner: 'agent-a', // matches agent_groups.name below on the FIRST candidate check
        claimed_at: new Date(claimedAtMs).toISOString(),
        ttl_hours: 4,
        note: 'wallet tie-out seam',
        thread_id: 'slack:C0AAA:1786621514.008659',
      },
      null,
      2,
    ),
  );
}

function readStamp(): { auto_nudge_count?: number; auto_nudged_at?: string } {
  return JSON.parse(fs.readFileSync(path.join(claimDir(), `${SLUG}.json`), 'utf8')) as {
    auto_nudge_count?: number;
    auto_nudged_at?: string;
  };
}

describe('F-6.1', () => {
  beforeEach(() => {
    _resetSelfHealThrottleForTesting();
    mockDispatch.mockClear();
    vi.useFakeTimers();
    // 30h stale, well past the 4h ttl + 2h grace, and stays stale for the
    // whole 24h+ span these ticks cover.
    writeClaim(NOW - 30 * HOUR);

    const db = initTestDb();
    db.exec(`
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
        agent_provider TEXT, workgroup_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE messaging_groups (
        id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
        instance TEXT, name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
      );
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL, agent_group_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO agent_groups VALUES ('ag-1', 'agent-a', 'agent-a', 'claude', 'wg-a', '2026-08-01T00:00:00Z');
      INSERT INTO messaging_groups VALUES ('mg-1', 'slack-example', 'slack:C0AAA', NULL, '#channel-a', '2026-08-01T00:00:00Z');
      INSERT INTO messaging_group_agents VALUES ('w-1', 'mg-1', 'ag-1', '2026-08-01T00:00:00Z');
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('the self-heal nudge ladder keeps its 24h per-claim cooldown and 10-minute scan throttle', async () => {
    const duty = getDuty('claims-self-heal');
    expect(SELF_HEAL_MAX_NUDGES).toBeGreaterThan(1); // the ladder must have a second rung for tick 4 below

    // Tick 1 @ t0: fresh scan, claim is stale, count=0 → first nudge.
    vi.setSystemTime(NOW);
    await duty.run(fakeTickContext());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(readStamp().auto_nudge_count).toBe(1);

    // Tick 2 @ t0+5min: SCAN throttle (10-minute interval) — no read at all,
    // so not even a "cooling-down" decision, and no second dispatch.
    vi.setSystemTime(NOW + 5 * MIN);
    await duty.run(fakeTickContext());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(readStamp().auto_nudge_count).toBe(1);

    // Tick 3 @ t0+15min: scan is no longer throttled (>10min), but the claim's
    // own 24h per-claim cooldown blocks a repeat nudge — still no dispatch.
    vi.setSystemTime(NOW + 15 * MIN);
    await duty.run(fakeTickContext());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(readStamp().auto_nudge_count).toBe(1);

    // Tick 4 @ t0+24h15min: past both the scan throttle and the 24h cooldown —
    // the ladder advances to nudge 2.
    vi.setSystemTime(NOW + 24 * HOUR + 15 * MIN);
    await duty.run(fakeTickContext());
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(readStamp().auto_nudge_count).toBe(2);
  });
});
