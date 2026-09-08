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
import { closeDb } from '../../db/connection.js';
import { initMigratedTestDb } from '../../db/index.js';
import { readFailureStreak, recordTaskRunOutcome } from '../../db/task-run-outcomes.js';
import {
  TASK_FAILURE_ESCALATION_THRESHOLD,
  formatTaskFailureAlert,
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

afterEach(() => closeDb());

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
