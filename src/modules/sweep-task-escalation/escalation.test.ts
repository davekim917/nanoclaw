/**
 * T24 acceptance. The incident under test (2026-09-07): a group migrated
 * codex → claude kept tasks pinned to `gpt-6-astra`; `pr-watch-a1b2` failed
 * 21 consecutive times over 14 hours and nobody was told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notifyOperators: vi.fn<(text: string, ctx?: Record<string, unknown>) => Promise<boolean>>(),
}));

vi.mock('../../operator-alert.js', () => ({
  notifyOperators: (...args: [string, Record<string, unknown>?]) => mocks.notifyOperators(...args),
}));
vi.mock('../../db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/agent-groups.js')>()),
  getAgentGroup: async () => ({ id: 'ag-1', name: 'watcher-agent', folder: 'watcher-agent' }),
}));
vi.mock('../../db/container-configs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/container-configs.js')>()),
  getContainerConfig: async () => ({ provider: 'claude' }),
  resolveProviderName: (_a: string | null, b: string | undefined) => b ?? 'claude',
}));
vi.mock('../../container-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-config.js')>()),
  resolveGroupTimezone: async () => 'America/New_York',
}));
// host-sweep.ts is imported for `registerSweepDuty` only; stub it so importing
// this module does not drag the whole sweep driver into the test worker.
vi.mock('../../host-sweep.js', () => ({
  SWEEP_DUTY_INVENTORY: { T24: 'task-failure-escalation' },
  registerSweepDuty: vi.fn(),
  registerSweepDutySource: vi.fn(),
}));

// Seeded through the shared fixture rather than `runMigrations(getRawDb())`:
// the raw synchronous handle is under a shrink-only pin
// (`src/db/raw-db-ratchet.test.ts`), so naming it here would be an addition.
import Database from 'better-sqlite3';

import { closeDb } from '../../db/connection.js';
import { initMigratedTestDb } from '../../db/index.js';
import {
  readFailureStreak,
  readGateEpisode,
  recordTaskRunOutcome,
  upsertGateOutcome,
  type GateOutcomeUpsert,
} from '../../db/task-run-outcomes.js';
import type { GateObservation } from '../scheduling/observation.js';
import {
  TASK_FAILURE_ESCALATION_THRESHOLD,
  formatTaskFailureAlert,
  gateEpisodeDeadlineMs,
  runTaskFailureEscalation,
  shouldEscalateTaskFailures,
} from './index.js';

const MODEL_ERROR =
  "Prompt is too long · automatic compaction failed: There's an issue with the selected model (gpt-6-astra).";

let n = 0;
async function fire(outcome: 'ok' | 'failed') {
  n += 1;
  await recordTaskRunOutcome({
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    seriesId: 'pr-watch-a1b2',
    outboundId: `out-${n}`,
    outcome,
    model: outcome === 'failed' ? 'gpt-6-astra' : 'claude-fable-5-1',
    detail: outcome === 'failed' ? MODEL_ERROR : 'no PR state changes',
  });
}

beforeEach(async () => {
  n = 0;
  mocks.notifyOperators.mockReset();
  mocks.notifyOperators.mockResolvedValue(true);
  await initMigratedTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  return closeDb();
});

describe('escalation decision', () => {
  it('escalates at the threshold and not before', () => {
    expect(shouldEscalateTaskFailures(1, false)).toBe(false);
    expect(shouldEscalateTaskFailures(2, false)).toBe(false);
    expect(shouldEscalateTaskFailures(3, false)).toBe(true);
    expect(shouldEscalateTaskFailures(21, false)).toBe(true);
  });

  it('stays silent while the streak already carries a stamp — one alert per episode', () => {
    expect(shouldEscalateTaskFailures(3, true)).toBe(false);
    expect(shouldEscalateTaskFailures(21, true)).toBe(false);
  });

  it('never fires on a healthy series', () => {
    expect(shouldEscalateTaskFailures(0, false)).toBe(false);
    expect(shouldEscalateTaskFailures(0, true)).toBe(false);
  });

  it('does not borrow the pause cap, which counts a signal it cannot see', () => {
    // SCRIPT_FAIL_PAUSE_CAP is 8, but it belongs to recurrence.ts's streak over
    // occurrence STATUS — which never observes an agent-turn failure at all.
    expect(TASK_FAILURE_ESCALATION_THRESHOLD).toBe(3);
  });
});

describe('escalation text', () => {
  it('names the pin, the current provider, the count and the window', () => {
    const text = formatTaskFailureAlert({
      seriesId: 'pr-watch-a1b2',
      groupName: 'watcher-agent',
      streak: 21,
      firstFailureAt: 'Sep 7, 2026 at 12:16 AM',
      lastFailureAt: 'Sep 7, 2026 at 2:16 PM',
      model: 'gpt-6-astra',
      provider: 'claude',
      detail: MODEL_ERROR,
    });
    expect(text).toContain('pr-watch-a1b2');
    expect(text).toContain('watcher-agent');
    expect(text).toContain('21 consecutive failed runs');
    expect(text).toContain('Sep 7, 2026 at 12:16 AM');
    expect(text).toContain('Sep 7, 2026 at 2:16 PM');
    expect(text).toContain('gpt-6-astra');
    expect(text).toContain('claude');
    expect(text).toContain('issue with the selected model');
  });

  it('says so plainly when the run carried no model pin', () => {
    const text = formatTaskFailureAlert({
      seriesId: 's',
      groupName: 'g',
      streak: 3,
      firstFailureAt: 'a',
      lastFailureAt: 'b',
      model: null,
      provider: 'claude',
      detail: null,
    });
    expect(text).toContain('No per-task model pin recorded');
    expect(text).toContain('(no text returned)');
  });
});

describe('escalation sweep', () => {
  it('says nothing for one or two failures', async () => {
    await fire('failed');
    await runTaskFailureEscalation();
    await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).not.toHaveBeenCalled();
  });

  it('escalates once on the third consecutive failure, then stays quiet for the next 18', async () => {
    await fire('failed');
    await fire('failed');
    await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperators.mock.calls[0]![0]).toContain('3 consecutive failed runs');

    // The real episode ran 21 fires. Every later tick must add nothing.
    for (let i = 0; i < 18; i += 1) {
      await fire('failed');
      await runTaskFailureEscalation();
    }
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it('re-arms after a success and escalates a second, later episode', async () => {
    for (let i = 0; i < 3; i += 1) await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);

    await fire('ok');
    // Recovery re-arms with no write: the success ends the streak, so the next
    // one starts unstamped.
    expect((await readFailureStreak('ag-1', 'pr-watch-a1b2')).escalated).toBe(false);

    for (let i = 0; i < 3; i += 1) await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(2);
  });

  it('leaves the alert armed when nobody could be reached', async () => {
    // A failed send must never stamp the episode — that false receipt is what
    // silenced the health sentinel for three days (#538).
    mocks.notifyOperators.mockResolvedValue(false);
    for (let i = 0; i < 3; i += 1) await fire('failed');
    await runTaskFailureEscalation();
    expect((await readFailureStreak('ag-1', 'pr-watch-a1b2')).escalated).toBe(false);

    mocks.notifyOperators.mockResolvedValue(true);
    await runTaskFailureEscalation();
    expect((await readFailureStreak('ag-1', 'pr-watch-a1b2')).escalated).toBe(true);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(2);
  });

  it('still alerts only once across an episode longer than any read limit', async () => {
    // Codex round 1, P2: the marker must stay visible however long the episode
    // runs, or the duty re-alerts every read-limit-many failures.
    for (let i = 0; i < 3; i += 1) await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 120; i += 1) await fire('failed');
    await runTaskFailureEscalation();
    expect((await readFailureStreak('ag-1', 'pr-watch-a1b2')).streak).toBe(123);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it('reaches the threshold when a fast series fires repeatedly into one stream', async () => {
    // Codex round 4, P1. A recurring task can fire again before its long-lived
    // provider stream is reaped, so several occurrences are admitted into one
    // `processQuery` call. The old runner held ONE outcome slot per call and
    // dropped the rest, so a frequently failing series stayed below the
    // threshold indefinitely — the feature silently not firing for the fastest
    // crons, which are the ones most worth watching.
    //
    // Each admitted turn now records its own row, so three such fires are three
    // failures and the escalation lands.
    for (const occ of ['occ-1', 'occ-2', 'occ-3']) {
      await recordTaskRunOutcome({
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
        seriesId: 'pr-watch-a1b2',
        outboundId: `log-${occ}`,
        outcome: 'failed',
        model: 'gpt-6-astra',
        detail: MODEL_ERROR,
      });
    }

    expect((await readFailureStreak('ag-1', 'pr-watch-a1b2')).streak).toBe(3);
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperators.mock.calls[0]![0]).toContain('3 consecutive failed runs');
  });

  it('does not escalate a series whose failures are not consecutive', async () => {
    await fire('failed');
    await fire('ok');
    await fire('failed');
    await fire('ok');
    await fire('failed');
    await runTaskFailureEscalation();
    expect(mocks.notifyOperators).not.toHaveBeenCalled();
  });
});

// ─── Gate lane: deadline, not count ──────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-09-26T12:00:00.000Z');
let occ = 0;

/** One pre-task execution recorded at `atMs`, as the host or the delivery recorder would. */
async function gateAt(
  atMs: number,
  observation: GateObservation,
  over: Partial<GateOutcomeUpsert> = {},
): Promise<void> {
  occ += 1;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(atMs);
  try {
    await upsertGateOutcome({
      agentGroupId: 'ag-1',
      sessionId: 'sess-gate',
      seriesId: 'pr-watch-a1b2',
      occurrenceId: `occ-${occ}`,
      observation,
      outcome: observation === 'empty' || observation === 'wake' ? 'ok' : 'failed',
      boundMs: observation === 'wake' ? null : HOUR,
      since: null,
      detail: observation === 'unreadable' ? 'GitHub API returned 502' : null,
      ...over,
    });
  } finally {
    vi.useRealTimers();
  }
}

async function tickAt(nowMs: number): Promise<void> {
  await runTaskFailureEscalation(nowMs);
}

describe('gate lane escalation', () => {
  beforeEach(() => {
    occ = 0;
  });

  it('DMs once the deadline passes, with no further fire, and names what the operator needs', async () => {
    await gateAt(T0, 'unreadable');

    await tickAt(T0 + 59 * MIN);
    expect(mocks.notifyOperators).not.toHaveBeenCalled();

    await tickAt(T0 + 60 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    const text = mocks.notifyOperators.mock.calls[0]![0];
    expect(text).toContain('pr-watch-a1b2');
    expect(text).toContain('watcher-agent');
    expect(text).toContain('Sep 26, 2026, 8:00 AM'); // the episode start, in the group's zone
    expect(text).toContain('`unreadable`');
    expect(text).toContain('GitHub API returned 502');
    expect(text).toContain('1h bound');

    await tickAt(T0 + 5 * HOUR);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it('latches the deadline: a later, larger bound does not extend it', async () => {
    await gateAt(T0, 'unreadable', { boundMs: HOUR });
    await gateAt(T0 + 30 * MIN, 'unreadable', { boundMs: 4 * HOUR });

    await tickAt(T0 + 60 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it('a newer, smaller bound brings the deadline forward', async () => {
    await gateAt(T0, 'blocked', { boundMs: 4 * HOUR });
    await gateAt(T0 + 10 * MIN, 'blocked', { boundMs: 15 * MIN });

    await tickAt(T0 + 14 * MIN);
    expect(mocks.notifyOperators).not.toHaveBeenCalled();
    await tickAt(T0 + 15 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it('an earlier since pulls the start back', async () => {
    await gateAt(T0, 'unfinished', { boundMs: 4 * HOUR, since: new Date(T0 - 3 * HOUR).toISOString() });

    await tickAt(T0 + 59 * MIN);
    expect(mocks.notifyOperators).not.toHaveBeenCalled();
    await tickAt(T0 + 60 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperators.mock.calls[0]![0]).toContain('Sep 26, 2026, 5:00 AM');
  });

  it('empty and wake each end the episode, so its deadline never arrives', async () => {
    await gateAt(T0, 'unreadable');
    await gateAt(T0 + 30 * MIN, 'empty');
    await tickAt(T0 + 5 * HOUR);

    await gateAt(T0 + 6 * HOUR, 'error');
    await gateAt(T0 + 6 * HOUR + 30 * MIN, 'wake');
    await tickAt(T0 + 10 * HOUR);

    expect(mocks.notifyOperators).not.toHaveBeenCalled();
  });

  it('re-arms after an ok: a later episode alerts again', async () => {
    await gateAt(T0, 'unreadable');
    await tickAt(T0 + HOUR);
    await gateAt(T0 + 2 * HOUR, 'empty');
    await gateAt(T0 + 3 * HOUR, 'unreadable');
    await tickAt(T0 + 3 * HOUR + 30 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);

    await tickAt(T0 + 4 * HOUR);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(2);
  });

  it('leaves the alert armed when the DM fails, and retries it next tick', async () => {
    mocks.notifyOperators.mockResolvedValue(false);
    await gateAt(T0, 'unreadable');
    await tickAt(T0 + HOUR);
    expect((await readGateEpisode('ag-1', 'pr-watch-a1b2'))?.escalated).toBe(false);

    mocks.notifyOperators.mockResolvedValue(true);
    await tickAt(T0 + HOUR + MIN);
    expect((await readGateEpisode('ag-1', 'pr-watch-a1b2'))?.escalated).toBe(true);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(2);
  });

  it('healthy turnover: settling K1 and admitting K2 in one fire never alerts', async () => {
    const bound = 4 * HOUR;
    // K1 held for three hours, reported unfinished with its own start every fire.
    for (let t = 0; t <= 3 * HOUR; t += 30 * MIN) {
      await gateAt(T0 + t, 'unfinished', { boundMs: bound, since: new Date(T0).toISOString() });
      await tickAt(T0 + t);
    }
    // One fire settles K1 and admits K2: empty, with the turnover as evidence.
    await gateAt(T0 + 3 * HOUR + 30 * MIN, 'empty', { detail: '{"settled":"K1","admitted":"K2"}' });
    // K2 held for three more hours from its own start.
    const k2 = T0 + 3 * HOUR + 30 * MIN;
    for (let t = 30 * MIN; t <= 3 * HOUR; t += 30 * MIN) {
      await gateAt(k2 + t, 'unfinished', { boundMs: bound, since: new Date(k2).toISOString() });
      await tickAt(k2 + t);
    }
    expect(mocks.notifyOperators).not.toHaveBeenCalled();
  });

  it('without the turnover, unfinished work whose since keeps advancing still alerts at the first start', async () => {
    const bound = 4 * HOUR;
    for (let t = 0; t <= 4 * HOUR; t += 30 * MIN) {
      await gateAt(T0 + t, 'unfinished', { boundMs: bound, since: new Date(T0 + t).toISOString() });
      await tickAt(T0 + t);
    }
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperators.mock.calls[0]![0]).toContain('Sep 26, 2026, 8:00 AM');
  });

  it('keeps the lanes apart: gate ok rows never reset a failing turn streak', async () => {
    await fire('failed');
    await gateAt(T0, 'empty');
    await fire('failed');
    await gateAt(T0 + MIN, 'empty');
    await fire('failed');

    await tickAt(T0 + 2 * MIN);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperators.mock.calls[0]![0]).toContain('3 consecutive failed runs');
  });

  it('computes the deadline from minima only', () => {
    expect(
      gateEpisodeDeadlineMs({
        firstRecordedAt: '2026-09-26T12:00:00.000Z',
        earliestSince: '2026-09-26T10:00:00.000Z',
        boundMs: HOUR,
      }),
    ).toEqual({ startMs: T0 - 2 * HOUR, deadlineMs: T0 - HOUR });
    // A since later than the first row cannot push the start forward.
    expect(
      gateEpisodeDeadlineMs({
        firstRecordedAt: '2026-09-26T12:00:00.000Z',
        earliestSince: '2026-09-26T13:00:00.000Z',
        boundMs: HOUR,
      }).startMs,
    ).toBe(T0);
  });
});

describe('gate lane escalation across a host restart', () => {
  it('a fresh module state does not DM an episode that was already escalated', async () => {
    const dbPath = `${uniqueTmpRoot('t24-restart')}/v2.db`;
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(dbPath), { recursive: true });

    const boot = async () => {
      vi.resetModules();
      const db = await import('../../db/index.js');
      const migrator = new Database(dbPath);
      try {
        db.runMigrations(migrator);
      } finally {
        migrator.close();
      }
      await db.initDb(dbPath);
      return { db, t24: await import('./index.js'), ledger: await import('../../db/task-run-outcomes.js') };
    };

    let host = await boot();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await host.ledger.upsertGateOutcome({
      agentGroupId: 'ag-1',
      sessionId: 'sess-gate',
      seriesId: 'pr-watch-a1b2',
      occurrenceId: 'occ-restart',
      observation: 'unreadable',
      outcome: 'failed',
      boundMs: HOUR,
      since: null,
      detail: 'GitHub API returned 502',
    });
    vi.useRealTimers();
    await host.t24.runTaskFailureEscalation(T0 + HOUR);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    await host.db.closeDb();

    host = await boot();
    await host.t24.runTaskFailureEscalation(T0 + 2 * HOUR);
    expect(mocks.notifyOperators).toHaveBeenCalledTimes(1);
    await host.db.closeDb();
  });
});
