import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import {
  median,
  checkBand,
  pausedSeriesBreach,
  failedStreakBreach,
  isDuplicateBreach,
  isWarmingUp,
  isLiveForStreak,
  advancePauseState,
  computeSeriesStats,
  countRecentErrorLines,
  scanBannedPatterns,
  checkContainerBytes,
  checkGroupStandingBytes,
  checkInstructionStack,
  instructionStackBreachKind,
  CONTAINER_BYTES_CEILING,
  GROUP_STANDING_BYTES_CEILING,
} from './fleet-drift.js';

/** Mirrors src/log.ts's `ts()` — local wall-clock, not UTC. Kept TZ-agnostic by building both the log
 * stamp and the `now` argument from the SAME local-time basis, so these tests pass under any runner TZ. */
function localStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const p3 = (n: number) => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

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
  // Built from real local Date objects (not hardcoded UTC 'Z' strings), so
  // these assertions hold under any runner TZ — matching the fix: the logger
  // writes local wall-clock time, and this parses it as local too.
  const nowDate = new Date();
  const now = nowDate.getTime();

  it('counts ANSI-wrapped ERROR lines (the real src/log.ts format)', () => {
    const stamp = localStamp(new Date(now - 60_000));
    // src/log.ts emit(): `[${ts()}] ${COLORS.error}ERROR${RESET} ${MSG_COLOR}msg${RESET} key=value`
    const content = `[${stamp}] \x1b[31mERROR\x1b[39m \x1b[36msomething broke\x1b[39m key=value`;
    expect(countRecentErrorLines(content, now)).toBe(1);
  });

  it('still counts a plain (non-ANSI) ERROR line', () => {
    const stamp = localStamp(new Date(now - 60_000));
    const content = `[${stamp}] ERROR something broke`;
    expect(countRecentErrorLines(content, now)).toBe(1);
  });

  it('counts multiple ERROR lines within the last 24h', () => {
    const content = [
      `[${localStamp(new Date(now - 60 * 60_000))}] \x1b[31mERROR\x1b[39m \x1b[36mone\x1b[39m`,
      `[${localStamp(new Date(now - 18 * 60 * 60_000))}] \x1b[31mERROR\x1b[39m \x1b[36mtwo\x1b[39m`,
    ].join('\n');
    expect(countRecentErrorLines(content, now)).toBe(2);
  });

  it('excludes ERROR lines older than the 24h window', () => {
    const stamp = localStamp(new Date(now - 25 * 60 * 60 * 1000));
    const content = `[${stamp}] \x1b[31mERROR\x1b[39m \x1b[36mtoo old\x1b[39m`;
    expect(countRecentErrorLines(content, now)).toBe(0);
  });

  it('parses the stamp as LOCAL time, not UTC (no trailing Z appended)', () => {
    // A stamp built from UTC getters instead of local getters would misread
    // by the host's UTC offset. Skip this assertion when local time IS UTC
    // (can't distinguish the bug there) — it still runs under any other TZ.
    if (nowDate.getTimezoneOffset() === 0) return;
    const utcMisreadStamp = new Date(now - 60_000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
    const localCorrectStamp = localStamp(new Date(now - 60_000));
    expect(utcMisreadStamp).not.toBe(localCorrectStamp); // sanity: the two bases actually differ here
    expect(countRecentErrorLines(`[${localCorrectStamp}] ERROR local`, now)).toBe(1);
  });

  it('ignores non-ERROR levels and multi-line stderr continuation tails', () => {
    const stamp = localStamp(new Date(now - 60_000));
    const content = [
      `[${stamp}] \x1b[33mWARN\x1b[39m \x1b[36mnot an error\x1b[39m`,
      '    at someFunction (file.ts:10:5)', // stack-trace continuation, no timestamp prefix
      'unhandled rejection dump with no bracket prefix at all',
    ].join('\n');
    expect(countRecentErrorLines(content, now)).toBe(0);
  });
});

describe('isLiveForStreak', () => {
  it('excludes cancelled and paused series — a dead/already-paused series is not "about to" auto-pause', () => {
    expect(isLiveForStreak('cancelled')).toBe(false);
    expect(isLiveForStreak('paused')).toBe(false);
  });
  it('includes every other status (pending/completed/failed/expired)', () => {
    expect(isLiveForStreak('pending')).toBe(true);
    expect(isLiveForStreak('completed')).toBe(true);
    expect(isLiveForStreak('failed')).toBe(true);
    expect(isLiveForStreak('expired')).toBe(true);
  });
});

describe('advancePauseState', () => {
  it('stamps first observation as "now"', () => {
    const { state, oldestPausedDays } = advancePauseState({}, ['s1'], '2026-08-30T00:00:00.000Z');
    expect(state).toEqual({ s1: '2026-08-30T00:00:00.000Z' });
    expect(oldestPausedDays).toBe(0);
  });

  it('keeps the original first-seen timestamp on repeat observation (does not reset the clock)', () => {
    const prev = { s1: '2026-08-27T00:00:00.000Z' };
    const { state, oldestPausedDays } = advancePauseState(prev, ['s1'], '2026-08-30T00:00:00.000Z');
    expect(state).toEqual({ s1: '2026-08-27T00:00:00.000Z' });
    expect(oldestPausedDays).toBe(3);
  });

  it('drops a series no longer paused (resumed or gone)', () => {
    const prev = { s1: '2026-08-20T00:00:00.000Z', s2: '2026-08-29T00:00:00.000Z' };
    const { state } = advancePauseState(prev, ['s2'], '2026-08-30T00:00:00.000Z');
    expect(state).toEqual({ s2: '2026-08-29T00:00:00.000Z' });
  });

  it('a re-paused series (absent from prevState) is stamped fresh, not resuming its old age', () => {
    const { state, oldestPausedDays } = advancePauseState({}, ['s1'], '2026-08-30T00:00:00.000Z');
    expect(state.s1).toBe('2026-08-30T00:00:00.000Z');
    expect(oldestPausedDays).toBe(0);
  });

  it('no currently-paused series → empty state, zero age', () => {
    const { state, oldestPausedDays } = advancePauseState({ s1: '2026-08-01T00:00:00.000Z' }, [], '2026-08-30T00:00:00.000Z');
    expect(state).toEqual({});
    expect(oldestPausedDays).toBe(0);
  });

  it('oldest_paused_days breaches pausedSeriesBreach only after 3+ observed days', () => {
    const prev = { s1: '2026-08-27T12:00:00.000Z' };
    const under = advancePauseState(prev, ['s1'], '2026-08-30T11:59:00.000Z').oldestPausedDays;
    const over = advancePauseState(prev, ['s1'], '2026-08-30T12:01:00.000Z').oldestPausedDays;
    expect(pausedSeriesBreach(1, under)).toBe(false);
    expect(pausedSeriesBreach(1, over)).toBe(true);
  });
});

// ────────────────────── L4: instruction-stack tripwire ─────────────────────
// docs/specs/instruction-stack-prune/plan.md

/** Pure-ASCII filler so byte length == character length; lets fixtures hit exact sizes via slice(). */
function cleanContent(bytes: number): string {
  const line = 'This is a timeless standing rule with no dates or references.\n';
  let out = '';
  while (out.length < bytes) out += line;
  return out.slice(0, bytes);
}

describe('scanBannedPatterns', () => {
  it('flags an ISO date', () => {
    expect(scanBannedPatterns('Fixed on 2026-08-31 after investigation.')).toContain('iso_date');
  });
  it('flags an issue/PR reference', () => {
    expect(scanBannedPatterns('Root-caused in #123.')).toContain('issue_or_pr_ref');
  });
  it('flags a parenthesized issue/PR reference', () => {
    expect(scanBannedPatterns('Fixed the race condition (#207).')).toContain('issue_or_pr_ref');
  });
  it('flags an XZO ticket reference', () => {
    expect(scanBannedPatterns('Tracked in XZO-4521.')).toContain('xzo_ref');
  });
  it('flags a "Current Focus" header', () => {
    expect(scanBannedPatterns('## Current Focus\n\nShip the new dashboard.')).toContain('current_focus_header');
  });
  it('passes clean timeless prose', () => {
    expect(scanBannedPatterns('Always verify claims before reporting them done.')).toEqual([]);
  });
});

describe('checkContainerBytes', () => {
  const TMP = '/tmp/nanoclaw-fleet-drift-container-test';
  const containerPath = () => path.join(TMP, 'CLAUDE.md');

  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('passes a clean file under the ceiling', () => {
    fs.writeFileSync(containerPath(), cleanContent(5000));
    expect(checkContainerBytes(containerPath())).toBeNull();
  });

  it('flags a ceiling breach independently of any banned pattern', () => {
    fs.writeFileSync(containerPath(), cleanContent(CONTAINER_BYTES_CEILING + 500));
    const breach = checkContainerBytes(containerPath());
    expect(breach?.metric).toBe('containerBytes');
    expect(breach?.overCeiling).toBe(true);
    expect(breach?.bannedHits).toEqual([]);
  });

  it('flags a banned pattern even under the ceiling', () => {
    fs.writeFileSync(containerPath(), 'Fixed on 2026-08-31.\n');
    const breach = checkContainerBytes(containerPath());
    expect(breach?.overCeiling).toBe(false);
    expect(breach?.bannedHits[0].patterns).toContain('iso_date');
  });
});

describe('checkGroupStandingBytes', () => {
  const TMP = '/tmp/nanoclaw-fleet-drift-group-standing-test';
  const groupsRoot = () => path.join(TMP, 'groups');

  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('passes a clean group under the ceiling', () => {
    const g = path.join(groupsRoot(), 'clean-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'standing-instructions.md'), cleanContent(2000));
    fs.writeFileSync(path.join(g, 'CLAUDE.local.md'), cleanContent(500));
    expect(checkGroupStandingBytes(groupsRoot())).toEqual([]);
  });

  it('flags a ceiling breach for one group', () => {
    const g = path.join(groupsRoot(), 'big-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'standing-instructions.md'), cleanContent(GROUP_STANDING_BYTES_CEILING + 1000));
    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].scope).toBe('big-group');
    expect(breaches[0].overCeiling).toBe(true);
  });

  it('flags an ISO date in a group standing file', () => {
    const g = path.join(groupsRoot(), 'dated-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'standing-instructions.md'), 'Fixed on 2026-08-31 during triage.\n');
    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].bannedHits[0].patterns).toContain('iso_date');
  });

  it('flags a #123 issue reference', () => {
    const g = path.join(groupsRoot(), 'ref-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'CLAUDE.local.md'), 'Root-caused in #123.\n');
    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches[0].bannedHits[0].patterns).toContain('issue_or_pr_ref');
  });

  it('flags a "Current Focus" header', () => {
    const g = path.join(groupsRoot(), 'focus-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'standing-instructions.md'), '## Current Focus\n\nShip it.\n');
    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches[0].bannedHits[0].patterns).toContain('current_focus_header');
  });

  it('a clean file passes with zero breaches even alongside other flagged groups', () => {
    const clean = path.join(groupsRoot(), 'clean-group');
    const dated = path.join(groupsRoot(), 'dated-group');
    fs.mkdirSync(clean, { recursive: true });
    fs.mkdirSync(dated, { recursive: true });
    fs.writeFileSync(path.join(clean, 'standing-instructions.md'), cleanContent(1000));
    fs.writeFileSync(path.join(dated, 'standing-instructions.md'), 'Fixed on 2026-08-31.\n');
    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches.map((b) => b.scope)).toEqual(['dated-group']);
  });

  it('counts a symlinked CLAUDE.local.md once, not once per sibling group (no double-count, no double-flag)', () => {
    const source = path.join(groupsRoot(), 'acme');
    const sibling = path.join(groupsRoot(), 'acme-codex');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(source, 'standing-instructions.md'), 'Root-caused in #123.\n');
    fs.writeFileSync(path.join(source, 'CLAUDE.local.md'), cleanContent(200));
    fs.symlinkSync(path.join(source, 'standing-instructions.md'), path.join(sibling, 'standing-instructions.md'));
    fs.symlinkSync(path.join(source, 'CLAUDE.local.md'), path.join(sibling, 'CLAUDE.local.md'));

    const breaches = checkGroupStandingBytes(groupsRoot());
    // One breach entry covering both sibling names, not two duplicate entries for the same underlying file.
    expect(breaches).toHaveLength(1);
    expect(breaches[0].scope).toBe('acme, acme-codex');
    expect(breaches[0].bannedHits).toHaveLength(1);
  });

  it('returns empty when the groups root does not exist (e.g. a worktree without the groups checkout)', () => {
    expect(checkGroupStandingBytes(path.join(TMP, 'does-not-exist'))).toEqual([]);
  });

  // P2 regression: a normal clone shares only SOME standing files (a common
  // CLAUDE.local.md, each group keeping its own persona) — that puts the two
  // groups in DIFFERENT clusters (their full file sets differ), so the
  // shared file must still be pattern-scanned/reported once, not once per
  // cluster that happens to reference it.
  it('P2: scans a file shared by only some groups exactly once, even when their personas differ (partial cluster overlap)', () => {
    const groupA = path.join(groupsRoot(), 'group-a');
    const groupB = path.join(groupsRoot(), 'group-b');
    fs.mkdirSync(groupA, { recursive: true });
    fs.mkdirSync(groupB, { recursive: true });
    fs.writeFileSync(path.join(groupA, 'standing-instructions.md'), cleanContent(500)); // own, distinct
    fs.writeFileSync(path.join(groupB, 'standing-instructions.md'), cleanContent(600)); // own, distinct — different size so the cluster signature truly differs
    fs.writeFileSync(path.join(groupA, 'CLAUDE.local.md'), 'Root-caused in #123.\n'); // shared, real
    fs.symlinkSync(path.join(groupA, 'CLAUDE.local.md'), path.join(groupB, 'CLAUDE.local.md')); // shared, symlink

    const breaches = checkGroupStandingBytes(groupsRoot());
    const patternBreaches = breaches.filter((b) => b.bannedHits.length > 0);
    expect(patternBreaches).toHaveLength(1); // not one per cluster
    expect(patternBreaches[0].scope).toBe('group-a, group-b');
    expect(patternBreaches[0].bannedHits).toHaveLength(1);
    expect(patternBreaches[0].bannedHits[0].patterns).toContain('issue_or_pr_ref');
  });

  it('a full-cluster ceiling breach and a banned-pattern hit on the same shared file are two distinct breach entries, not merged or colliding', () => {
    const source = path.join(groupsRoot(), 'dup-source');
    const sibling = path.join(groupsRoot(), 'dup-sibling');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(source, 'standing-instructions.md'),
      `${cleanContent(GROUP_STANDING_BYTES_CEILING + 500)}Fixed on 2026-08-31.\n`,
    );
    fs.symlinkSync(path.join(source, 'standing-instructions.md'), path.join(sibling, 'standing-instructions.md'));

    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(2);
    const ceilingBreach = breaches.find((b) => b.overCeiling);
    const patternBreach = breaches.find((b) => b.bannedHits.length > 0);
    expect(ceilingBreach?.scope).toBe('dup-sibling, dup-source');
    expect(patternBreach?.scope).toBe('dup-sibling, dup-source');
    // Same scope string on both — they must still carry a distinct kind so the issue-title dedup doesn't collapse them.
    expect(instructionStackBreachKind(ceilingBreach!)).not.toBe(instructionStackBreachKind(patternBreach!));
  });
});

// P1: groups/ is container-writable, so a candidate standing-file path is a
// trust boundary, not just a file to read. These lock in that a planted
// symlink/FIFO/oversized file is skipped and reported as its own signal,
// never read.
describe('checkGroupStandingBytes safety (P1: symlink containment, non-regular files, size cap)', () => {
  const TMP = '/tmp/nanoclaw-fleet-drift-safety-test';
  const groupsRoot = () => path.join(TMP, 'groups');

  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('skips and flags a symlink that escapes the groups/ tree, never reading the target', () => {
    const outside = path.join(TMP, 'outside-secret.md');
    fs.writeFileSync(outside, 'host-side content with a date 2026-08-31 that must never surface.\n');
    const g = path.join(groupsRoot(), 'escape-group');
    fs.mkdirSync(g, { recursive: true });
    fs.symlinkSync(outside, path.join(g, 'CLAUDE.local.md'));

    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].scope).toBe('escape-group');
    expect(breaches[0].unscannable).toHaveLength(1);
    expect(breaches[0].unscannable[0].reason).toMatch(/escapes groups\//);
    // The banned date in the outside file's content must never surface — it was never read.
    expect(breaches[0].bannedHits).toEqual([]);
  });

  it('skips a FIFO placed directly (no symlink) without hanging', () => {
    const g = path.join(groupsRoot(), 'fifo-group');
    fs.mkdirSync(g, { recursive: true });
    const fifoPath = path.join(g, 'CLAUDE.local.md');
    execFileSync('mkfifo', [fifoPath]);

    const breaches = checkGroupStandingBytes(groupsRoot()); // must return promptly — a naive read would block forever
    expect(breaches).toHaveLength(1);
    expect(breaches[0].unscannable[0].reason).toBe('not a regular file');
  });

  it('skips a symlink to a FIFO without hanging', () => {
    const source = path.join(groupsRoot(), 'fifo-source');
    fs.mkdirSync(source, { recursive: true });
    const fifoPath = path.join(source, 'the-fifo');
    execFileSync('mkfifo', [fifoPath]);
    const g = path.join(groupsRoot(), 'fifo-symlink-group');
    fs.mkdirSync(g, { recursive: true });
    fs.symlinkSync(fifoPath, path.join(g, 'CLAUDE.local.md'));

    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].scope).toBe('fifo-symlink-group');
    expect(breaches[0].unscannable[0].reason).toBe('not a regular file');
  });

  it('skips a file over the safety cap without reading its content', () => {
    const g = path.join(groupsRoot(), 'huge-group');
    fs.mkdirSync(g, { recursive: true });
    // Sparse file: stat reports a huge size without allocating/reading real data.
    const hugePath = path.join(g, 'CLAUDE.local.md');
    fs.writeFileSync(hugePath, '');
    fs.truncateSync(hugePath, 5_000_000);

    const breaches = checkGroupStandingBytes(groupsRoot());
    expect(breaches).toHaveLength(1);
    expect(breaches[0].unscannable[0].reason).toMatch(/safety cap/);
  });

  it('still follows a symlink that stays inside groups/ (a legitimate sibling share) and reads it', () => {
    const source = path.join(groupsRoot(), 'legit-source');
    const sibling = path.join(groupsRoot(), 'legit-sibling');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(source, 'CLAUDE.local.md'), cleanContent(300));
    fs.symlinkSync(path.join(source, 'CLAUDE.local.md'), path.join(sibling, 'CLAUDE.local.md'));

    expect(checkGroupStandingBytes(groupsRoot())).toEqual([]); // clean, under ceiling, nothing unscannable
  });
});

describe('checkInstructionStack', () => {
  const TMP = '/tmp/nanoclaw-fleet-drift-instruction-stack-test';

  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('flags containerBytes and groupStandingBytes independently — a breaching shared base does not force every group over its own ceiling', () => {
    const containerPath = path.join(TMP, 'CLAUDE.md');
    fs.writeFileSync(containerPath, cleanContent(CONTAINER_BYTES_CEILING + 500));

    const groupsRoot = path.join(TMP, 'groups');
    const g = path.join(groupsRoot, 'fine-group');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'standing-instructions.md'), cleanContent(2000));

    const breaches = checkInstructionStack(containerPath, groupsRoot);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].metric).toBe('containerBytes');
  });

  it('passes a post-prune-shaped tree: ~8KB base + 2-3KB personas does not self-breach', () => {
    const containerPath = path.join(TMP, 'CLAUDE.md');
    fs.writeFileSync(containerPath, cleanContent(8000));

    const groupsRoot = path.join(TMP, 'groups');
    for (const [name, size] of [
      ['group-one', 2000],
      ['group-two', 3000],
      ['group-three', 2500],
    ] as const) {
      const g = path.join(groupsRoot, name);
      fs.mkdirSync(g, { recursive: true });
      fs.writeFileSync(path.join(g, 'standing-instructions.md'), cleanContent(size));
      fs.writeFileSync(path.join(g, 'CLAUDE.local.md'), cleanContent(100));
    }

    expect(checkInstructionStack(containerPath, groupsRoot)).toEqual([]);
  });
});
