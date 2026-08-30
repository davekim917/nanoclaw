import { describe, it, expect } from 'vitest';

import {
  median,
  checkBand,
  pausedSeriesBreach,
  failedStreakBreach,
  isDuplicateBreach,
  isWarmingUp,
  computeSeriesStats,
  countRecentErrorLines,
} from './fleet-drift.js';

describe('median', () => {
  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 3, 5, 7])).toBe(4);
  });
  it('picks the middle value for an odd-length array', () => {
    expect(median([5, 1, 9])).toBe(5);
  });
  it('is 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('checkBand', () => {
  it('breaches when the value clears median + 3×MAD', () => {
    // prior series has real spread (median 100, MAD scaled ~148); a value far
    // above that should breach.
    const prior = [90, 95, 100, 105, 110, 100, 95];
    const r = checkBand(1000, prior, 20);
    expect(r.breach).toBe(true);
    expect(r.madScaled).toBeGreaterThan(0);
  });

  it('does not breach a value within normal spread', () => {
    const prior = [90, 95, 100, 105, 110, 100, 95];
    const r = checkBand(102, prior, 20);
    expect(r.breach).toBe(false);
  });

  it('MAD=0 guard: flat-zero history stays quiet on a small blip', () => {
    const prior = [0, 0, 0, 0, 0, 0, 0];
    // value > median*1.5 (0*1.5=0) is true, but the absolute gap (5) is below
    // the flat-zero guard (20), so no breach.
    const r = checkBand(5, prior, 20);
    expect(r.madScaled).toBe(0);
    expect(r.breach).toBe(false);
  });

  it('MAD=0 guard: flat-zero history breaches once the gap is meaningful', () => {
    const prior = [0, 0, 0, 0, 0, 0, 0];
    const r = checkBand(25, prior, 20);
    expect(r.madScaled).toBe(0);
    expect(r.breach).toBe(true);
  });

  it('MAD=0 guard: flat nonzero history uses the ×1.5 threshold', () => {
    const prior = [10, 10, 10, 10, 10, 10, 10];
    const under = checkBand(12, prior, 1); // 12 <= 15 (10*1.5)
    const over = checkBand(20, prior, 1); // 20 > 15 and gap (10) > guard (1)
    expect(under.breach).toBe(false);
    expect(over.breach).toBe(true);
  });
});

describe('pausedSeriesBreach', () => {
  it('breaches once a paused series is at least 3 days old', () => {
    expect(pausedSeriesBreach(1, 3)).toBe(true);
    expect(pausedSeriesBreach(2, 10)).toBe(true);
  });
  it('does not breach a fresh pause', () => {
    expect(pausedSeriesBreach(1, 2.9)).toBe(false);
  });
  it('does not breach when nothing is paused', () => {
    expect(pausedSeriesBreach(0, 999)).toBe(false);
  });
});

describe('failedStreakBreach', () => {
  it('breaches at the 6-run threshold, ahead of the 8-run auto-pause cap', () => {
    expect(failedStreakBreach(6)).toBe(true);
    expect(failedStreakBreach(8)).toBe(true);
  });
  it('does not breach below the threshold', () => {
    expect(failedStreakBreach(5)).toBe(false);
    expect(failedStreakBreach(0)).toBe(false);
  });
});

describe('isDuplicateBreach (dedup — stands in for a stubbed `gh issue list --json title` result)', () => {
  const openTitles = [
    'fleet-drift: error_events_24h out of band (2026-08-29)',
    'some unrelated issue',
  ];
  it('suppresses a metric with an already-open issue', () => {
    expect(isDuplicateBreach(openTitles, 'error_events_24h')).toBe(true);
  });
  it('does not suppress a metric with no open issue', () => {
    expect(isDuplicateBreach(openTitles, 'paused_series')).toBe(false);
  });
  it('matches on title prefix, not full equality (date suffix varies)', () => {
    expect(isDuplicateBreach(['fleet-drift: disk_growth_bytes out of band (2026-01-01)'], 'disk_growth_bytes')).toBe(
      true,
    );
  });
});

describe('isWarmingUp', () => {
  it('is warming up below 7 prior lines', () => {
    expect(isWarmingUp(0)).toBe(true);
    expect(isWarmingUp(6)).toBe(true);
  });
  it('is not warming up at 7 or more prior lines', () => {
    expect(isWarmingUp(7)).toBe(false);
    expect(isWarmingUp(30)).toBe(false);
  });
});

describe('computeSeriesStats', () => {
  const row = (id: string, series_id: string | null, status: string, seq: number, timestamp: string) => ({
    id,
    series_id,
    status,
    seq,
    timestamp,
  });

  it('reports the highest-seq row as the latest status/timestamp per series', () => {
    // Rows must be passed already ordered seq DESC, matching the SQL query.
    const rows = [
      row('t3', 's1', 'paused', 30, '2026-08-30T00:00:00.000Z'),
      row('t2', 's1', 'failed', 20, '2026-08-20T00:00:00.000Z'),
      row('t1', 's1', 'completed', 10, '2026-08-10T00:00:00.000Z'),
    ];
    const stats = computeSeriesStats(rows);
    // latestStatus/latestTimestamp come from the highest-seq row regardless of status (paused).
    // failedStreak is computed separately over the completed/failed subsequence only (t2 'failed'
    // then t1 'completed' breaks it) — the paused row isn't part of that subsequence at all.
    expect(stats.get('s1')).toEqual({ latestStatus: 'paused', latestTimestamp: '2026-08-30T00:00:00.000Z', failedStreak: 1 });
  });

  it('counts a trailing failed streak, stopping at the first completed row', () => {
    const rows = [
      row('t4', 's2', 'failed', 40, '2026-08-30T00:00:00.000Z'),
      row('t3', 's2', 'failed', 30, '2026-08-29T00:00:00.000Z'),
      row('t2', 's2', 'completed', 20, '2026-08-28T00:00:00.000Z'),
      row('t1', 's2', 'failed', 10, '2026-08-27T00:00:00.000Z'),
    ];
    expect(computeSeriesStats(rows).get('s2')?.failedStreak).toBe(2);
  });

  it('ignores pending/cancelled/expired rows when computing the streak (mirrors trailingFailedRuns)', () => {
    const rows = [
      row('t3', 's3', 'pending', 30, '2026-08-30T00:00:00.000Z'),
      row('t2', 's3', 'failed', 20, '2026-08-29T00:00:00.000Z'),
      row('t1', 's3', 'completed', 10, '2026-08-28T00:00:00.000Z'),
    ];
    expect(computeSeriesStats(rows).get('s3')?.failedStreak).toBe(1);
  });

  it('keys by id when series_id is null (a non-recurring one-shot task)', () => {
    const rows = [row('solo', null, 'failed', 5, '2026-08-30T00:00:00.000Z')];
    const stats = computeSeriesStats(rows);
    expect(stats.get('solo')?.failedStreak).toBe(1);
  });
});

describe('countRecentErrorLines', () => {
  const now = Date.parse('2026-08-30T14:00:00.000Z');

  it('counts ERROR-prefixed lines within the last 24h', () => {
    const content = [
      '[2026-08-30 13:00:00.000] ERROR something broke',
      '[2026-08-29 20:00:00.000] ERROR something else broke',
    ].join('\n');
    expect(countRecentErrorLines(content, now)).toBe(2);
  });

  it('excludes ERROR lines older than the window', () => {
    const content = '[2026-08-29 13:59:59.000] ERROR too old by 1 second';
    expect(countRecentErrorLines(content, now)).toBe(0);
  });

  it('ignores non-ERROR levels and multi-line stderr continuation tails', () => {
    const content = [
      '[2026-08-30 13:00:00.000] WARN not an error',
      '    at someFunction (file.ts:10:5)', // stack-trace continuation, no timestamp prefix
      'unhandled rejection dump with no bracket prefix at all',
    ].join('\n');
    expect(countRecentErrorLines(content, now)).toBe(0);
  });
});
