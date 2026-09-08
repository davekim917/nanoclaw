import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from './connection.js';
// Seeded through the shared fixture, not `runMigrations(getRawDb())`: the raw
// synchronous handle is seam-3 scaffolding under a SHRINK-ONLY pin
// (`src/db/raw-db-ratchet.test.ts`), so a new test file naming it is an
// addition the ratchet refuses — which is exactly how #545 turned main red.
import { initMigratedTestDb } from './index.js';
import {
  listSeriesWithFailures,
  markEscalated,
  pruneTaskRunOutcomes,
  readFailureStreak,
  recordTaskRunOutcome,
} from './task-run-outcomes.js';

let n = 0;
async function record(outcome: 'ok' | 'failed', over: Partial<Parameters<typeof recordTaskRunOutcome>[0]> = {}) {
  n += 1;
  await recordTaskRunOutcome({
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    seriesId: 'watch-1',
    outboundId: `out-${n}`,
    outcome,
    model: 'gpt-6-astra',
    detail: outcome === 'failed' ? "There's an issue with the selected model (gpt-6-astra)." : 'watched, nothing new',
    ...over,
  });
}

beforeEach(async () => {
  n = 0;
  await initMigratedTestDb();
});

afterEach(() => closeDb());

describe('task run outcomes', () => {
  it('counts only the TRAILING failures, stopping at the first success', async () => {
    await record('failed');
    await record('ok');
    await record('failed');
    await record('failed');
    const { streak, newest } = await readFailureStreak('ag-1', 'watch-1');
    expect(streak).toBe(2);
    expect(newest?.outcome).toBe('failed');
  });

  it('reports a clean series as a zero streak', async () => {
    await record('failed');
    await record('failed');
    await record('ok');
    expect((await readFailureStreak('ag-1', 'watch-1')).streak).toBe(0);
  });

  it('names both ends of the window: the newest failure and when the episode started', async () => {
    await record('failed', { detail: 'older' });
    await record('failed', { detail: 'newer' });
    const { newest, firstFailureAt, streak } = await readFailureStreak('ag-1', 'watch-1');
    expect(streak).toBe(2);
    expect(newest?.detail).toBe('newer');
    // The episode's start, not the newest row's stamp.
    const rows = await getDb().all<{ recorded_at: string }>(
      "SELECT recorded_at FROM task_run_outcomes WHERE detail = 'older'",
    );
    expect(firstFailureAt).toBe(rows[0]!.recorded_at);
  });

  it('does not let a redelivered outbound row inflate the streak', async () => {
    // delivery.ts retries a row after a transient failure. The same fire must
    // not count twice — a duplicate would manufacture an escalation.
    for (let i = 0; i < 2; i += 1) {
      await recordTaskRunOutcome({
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
        seriesId: 'watch-1',
        outboundId: 'out-dup',
        outcome: 'failed',
        model: null,
        detail: 'boom',
      });
    }
    expect((await readFailureStreak('ag-1', 'watch-1')).streak).toBe(1);
  });

  it('keeps series and groups separate', async () => {
    await record('failed');
    await record('failed', { seriesId: 'watch-2' });
    await record('failed', { agentGroupId: 'ag-2' });
    expect((await readFailureStreak('ag-1', 'watch-1')).streak).toBe(1);
    expect(await listSeriesWithFailures()).toEqual(
      expect.arrayContaining([
        { agent_group_id: 'ag-1', series_id: 'watch-1' },
        { agent_group_id: 'ag-1', series_id: 'watch-2' },
        { agent_group_id: 'ag-2', series_id: 'watch-1' },
      ]),
    );
  });

  it('does not put a series that has only ever succeeded in front of the sweep', async () => {
    await record('ok', { seriesId: 'healthy' });
    await record('ok', { seriesId: 'healthy' });
    expect(await listSeriesWithFailures()).toEqual([]);
  });

  it('carries the escalation stamp inside the streak, so recovery re-arms with no write', async () => {
    await record('failed');
    await record('failed');
    const first = await readFailureStreak('ag-1', 'watch-1');
    expect(first.escalated).toBe(false);

    // Stamp the newest failure — what the sweep does after a delivered alert.
    await markEscalated(first.newest!.id);
    expect((await readFailureStreak('ag-1', 'watch-1')).escalated).toBe(true);

    // More failures in the SAME episode still read as escalated.
    await record('failed');
    const still = await readFailureStreak('ag-1', 'watch-1');
    expect(still.streak).toBe(3);
    expect(still.escalated).toBe(true);

    // A success ends the streak, so the next failure starts a fresh, unstamped
    // one. No close operation exists, and none can be forgotten.
    await record('ok');
    await record('failed');
    const rearmed = await readFailureStreak('ag-1', 'watch-1');
    expect(rearmed.streak).toBe(1);
    expect(rearmed.escalated).toBe(false);
  });

  it('keeps the episode marker visible past any streak length (Codex round 1, P2)', async () => {
    // The capped-slice version lost the marker once it sat further back than
    // the 50-row limit, reported `escalated: false`, and re-alerted — then
    // again every 50 failures. A daily series failing for two months hits this;
    // the 21-fire incident would not have, which is why it needed fixing
    // rather than dismissing on scale.
    await record('failed');
    const first = await readFailureStreak('ag-1', 'watch-1');
    await markEscalated(first.newest!.id);
    for (let i = 0; i < 120; i += 1) await record('failed');

    const long = await readFailureStreak('ag-1', 'watch-1');
    expect(long.streak).toBe(121);
    expect(long.escalated).toBe(true);
  });

  it('never prunes a stamped failure while its episode is still open (Codex round 2, P2)', async () => {
    // A series broken for longer than the retention window would lose its
    // marker to the age-only delete, report escalated:false, and alert again —
    // the round-1 capped-slice bug wearing a different hat.
    await record('failed');
    const first = await readFailureStreak('ag-1', 'watch-1');
    await markEscalated(first.newest!.id);
    await record('failed');
    // Age the WHOLE open episode past the window.
    await getDb().run("UPDATE task_run_outcomes SET recorded_at = '2020-01-01T00:00:00.000Z'");

    expect(await pruneTaskRunOutcomes(30)).toBe(0);
    const after = await readFailureStreak('ag-1', 'watch-1');
    expect(after.streak).toBe(2);
    expect(after.escalated).toBe(true);
  });

  it('still ages out history that a success has closed', async () => {
    await record('failed');
    await record('ok');
    await getDb().run("UPDATE task_run_outcomes SET recorded_at = '2020-01-01T00:00:00.000Z'");
    await record('failed'); // the new, live episode
    expect(await pruneTaskRunOutcomes(30)).toBe(2);
    expect((await readFailureStreak('ag-1', 'watch-1')).streak).toBe(1);
  });

  it('prunes only outcomes past the retention window AND already closed by a success', async () => {
    // Both predicates are required. Age alone would delete a row inside a live
    // episode; the episode boundary alone would keep closed history forever.
    await record('failed'); // out-1, old and closed by the success below
    await record('ok'); // out-2, old
    await getDb().run(
      "UPDATE task_run_outcomes SET recorded_at = '2020-01-01T00:00:00.000Z' WHERE outbound_id IN ('out-1','out-2')",
    );
    await record('failed'); // out-3, recent and live

    expect(await pruneTaskRunOutcomes(30)).toBe(2);
    expect((await readFailureStreak('ag-1', 'watch-1')).streak).toBe(1);
  });
});
