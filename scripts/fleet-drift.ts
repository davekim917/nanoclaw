#!/usr/bin/env tsx
/**
 * Daily control-band fleet-health check.
 *
 * Runs once a day via a systemd timer (data/systemd/nanoclaw-fleet-drift.{service,timer}
 * — reference copies only, not installed by this script). No LLM calls; pure
 * arithmetic over collected metrics.
 *
 * Flow:
 *   1. Collect today's metrics — disk usage/pct for data/, ERROR-line count in
 *      the last 24h from logs/nanoclaw.error.log(.1) (ANSI-stripped, local-time
 *      parsed — src/log.ts wraps the level tag in color codes and timestamps in
 *      local wall-clock, not UTC), and fleet-wide scheduled-task health (paused
 *      series / oldest observed pause / worst live failure streak) via a
 *      per-session inbound.db fan-out. Fail-closed: any unreadable source
 *      throws, main() prints it and returns 1 — never silently treated as zero.
 *   2. Append one JSON line to data/fleet-drift/metrics.ndjson, and persist
 *      data/fleet-drift/state.json (first-observed-paused per series — see
 *      advancePauseState; the DB has no authoritative "when paused" signal).
 *   3. Compare today's value against a control band built from prior days:
 *      disk_growth_bytes and error_events_24h breach at median + 3×MAD (scaled
 *      ×1.4826) of the prior series, with a flat-zero guard when MAD is 0.
 *      paused_series and failed_streak_max use fixed thresholds instead (no
 *      band — see pausedSeriesBreach/failedStreakBreach). Fewer than 7 prior
 *      days of history → print a warm-up notice and exit 0.
 *   4. On breach, file one GitHub issue per breached metric on the origin repo
 *      via `gh`, labeled `fleet-drift`. An already-open issue whose title
 *      starts with `fleet-drift: <metric>` suppresses re-filing — the open
 *      issue IS the cooldown; closing it re-arms.
 *
 * FLEET_DRIFT_DRY_RUN=1: collect + print, write the ndjson line and pause-state
 * to a temp path instead of data/fleet-drift/, never call `gh issue create`.
 * Band computation still reads the REAL prior history (read-only) so the dry
 * run exercises genuine band logic against live data.
 *
 *   node_modules/.bin/tsx scripts/fleet-drift.ts
 *   FLEET_DRIFT_DRY_RUN=1 node_modules/.bin/tsx scripts/fleet-drift.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { DATA_DIR, REPO_ROOT } from '../src/config.js';

// ─────────────────────────── pure logic (exported for tests) ──────────────

export interface BandResult {
  breach: boolean;
  median: number;
  madScaled: number;
  threshold: number;
}

/** Median of a numeric array. Empty input is treated as median 0. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Control-band breach check: today's `value` against the prior series'
 * median + 3×MAD (scaled ×1.4826 to be a normal-consistent std-dev estimate).
 * When MAD is 0 (flat/zero history), that check would flag any nonzero value,
 * so fall back to value > median×1.5 AND the absolute gap exceeds
 * `flatZeroGuardAbs` — guards a flat-zero history from a one-off small blip.
 */
export function checkBand(value: number, priorValues: number[], flatZeroGuardAbs: number): BandResult {
  const med = median(priorValues);
  const madRaw = median(priorValues.map((v) => Math.abs(v - med)));
  const madScaled = madRaw * 1.4826;
  if (madScaled === 0) {
    const threshold = med * 1.5;
    return { breach: value > threshold && value - med > flatZeroGuardAbs, median: med, madScaled, threshold };
  }
  const threshold = med + 3 * madScaled;
  return { breach: value > threshold, median: med, madScaled, threshold };
}

/** A paused series is an absorbing state (see recurrence.ts:34-47) — flag it once it's been sitting unresumed for a few days. */
export function pausedSeriesBreach(pausedSeries: number, oldestPausedDays: number): boolean {
  return pausedSeries > 0 && oldestPausedDays >= 3;
}

/** Auto-pause cap is 8 consecutive failures (recurrence.ts SCRIPT_FAIL_PAUSE_CAP) — catch the streak before it pauses itself. */
export function failedStreakBreach(failedStreakMax: number): boolean {
  return failedStreakMax >= 6;
}

/** True if an already-open fleet-drift issue covers this metric (the open issue IS the cooldown). */
export function isDuplicateBreach(openTitles: string[], metric: string): boolean {
  const prefix = `fleet-drift: ${metric}`;
  return openTitles.some((t) => t.startsWith(prefix));
}

/** Fewer than 7 prior days of history → too little signal for a control band. */
export function isWarmingUp(priorLineCount: number): boolean {
  return priorLineCount < 7;
}

/**
 * failed_streak_max is a leading indicator for a series about to auto-pause
 * (recurrence.ts SCRIPT_FAIL_PAUSE_CAP) — exclude a series whose newest row
 * is already 'cancelled' (dead, cancelTask clears its recurrence — src/modules/scheduling/db.ts)
 * or already 'paused' (that state is separately captured by paused_series;
 * the streak that got it there isn't "about to" happen, it already did).
 * Without this a long-dead cancelled series' historical streak would breach
 * forever, since nothing ever appends a fresh non-failed row to reset it.
 */
export function isLiveForStreak(latestStatus: string): boolean {
  return latestStatus !== 'cancelled' && latestStatus !== 'paused';
}

export interface PauseState {
  [seriesKey: string]: string; // ISO timestamp this script first observed the series paused
}

/**
 * `pauseTask` (src/modules/scheduling/db.ts) only flips `status`; it never
 * stamps a fresh timestamp, so there's no authoritative "when did this
 * pause" signal in the DB — a paused row's `timestamp` is whenever that row
 * was originally inserted, not when it was paused. Track it ourselves:
 * first-observed-paused per series, persisted across runs in state.json.
 *
 * oldest_paused_days = age of the earliest first-seen among currently-paused
 * series. This measures OBSERVED pause duration (since fleet-drift started
 * watching), which LOWER-BOUNDS true pause duration — a series paused before
 * this script ever ran reads as "just paused" on first observation. A series
 * that resumes and later re-pauses is treated as newly first-seen (dropped
 * from state while resumed, so it doesn't inherit its old age).
 */
export function advancePauseState(
  prevState: PauseState,
  currentlyPausedKeys: string[],
  nowIso: string,
): { state: PauseState; oldestPausedDays: number } {
  const state: PauseState = {};
  for (const key of currentlyPausedKeys) state[key] = prevState[key] ?? nowIso;

  const firstSeenMs = Object.values(state).map((iso) => Date.parse(iso));
  if (firstSeenMs.length === 0) return { state, oldestPausedDays: 0 };
  const oldestPausedDays = (Date.parse(nowIso) - Math.min(...firstSeenMs)) / (24 * 60 * 60 * 1000);
  return { state, oldestPausedDays };
}

interface TaskRow {
  id: string;
  series_id: string | null;
  status: string;
  seq: number;
  timestamp: string;
}

interface SeriesStat {
  latestStatus: string;
  latestTimestamp: string;
  failedStreak: number;
}

/**
 * Fleet-wide scheduled-task health from one session's task rows, ordered by
 * seq DESC. Per series (keyed by COALESCE(series_id, id)):
 *   - latestStatus/latestTimestamp: the row with the highest seq (first row
 *     seen per series, since input is already seq-DESC).
 *   - failedStreak: leading run of 'failed' rows within the subsequence
 *     filtered to status IN ('completed','failed') — mirrors trailingFailedRuns'
 *     predicate in src/modules/scheduling/db.ts:258 exactly, so intervening
 *     pending/paused/cancelled/expired rows don't break or pad the streak.
 */
export function computeSeriesStats(rowsDescBySeq: TaskRow[]): Map<string, SeriesStat> {
  const bySeries = new Map<string, TaskRow[]>();
  for (const row of rowsDescBySeq) {
    const key = row.series_id ?? row.id;
    const arr = bySeries.get(key);
    if (arr) arr.push(row);
    else bySeries.set(key, [row]);
  }
  const result = new Map<string, SeriesStat>();
  for (const [key, rows] of bySeries) {
    let failedStreak = 0;
    for (const r of rows) {
      if (r.status !== 'completed' && r.status !== 'failed') continue;
      if (r.status !== 'failed') break;
      failedStreak++;
    }
    result.set(key, { latestStatus: rows[0].status, latestTimestamp: rows[0].timestamp, failedStreak });
  }
  return result;
}

/**
 * Count `[<stamp>] ERROR ...` lines in `content` whose timestamp is within
 * `windowMs` of `nowMs`. src/log.ts wraps the level tag in ANSI color codes
 * (`\x1b[31mERROR\x1b[39m`) and the message in another color, so a plain
 * `] ERROR` prefix match misses every real line — strip ANSI escapes first.
 * The stamp itself is LOCAL wall-clock time (src/log.ts `ts()` uses local
 * Date getters, not UTC), so it's parsed as local — correct as long as this
 * script runs on the same host/TZ as the logger, which it does (both are
 * plain host processes, no TZ override).
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ERROR_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] ERROR\b/;
export function countRecentErrorLines(content: string, nowMs: number, windowMs = 24 * 60 * 60 * 1000): number {
  let count = 0;
  for (const rawLine of content.split('\n')) {
    const m = ERROR_LINE_RE.exec(rawLine.replace(ANSI_RE, ''));
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts) && nowMs - ts <= windowMs) count++;
  }
  return count;
}

// ─────────────────────────────── collectors (I/O) ──────────────────────────

function collectDisk(dataDir: string): { usedBytes: number; pct: number } {
  const out = execFileSync('df', ['--output=used,pcent', dataDir], { encoding: 'utf-8' });
  const lastLine = out.trim().split('\n').pop() ?? '';
  const parts = lastLine.trim().split(/\s+/);
  const usedKb = Number(parts[0]);
  const pct = Number((parts[1] ?? '').replace('%', ''));
  if (!Number.isFinite(usedKb) || !Number.isFinite(pct)) {
    throw new Error(`could not parse df output for ${dataDir}: ${JSON.stringify(out)}`);
  }
  return { usedBytes: usedKb * 1024, pct };
}

function readLogFile(p: string, requiredToExist: boolean): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !requiredToExist) return '';
    throw new Error(`cannot read log ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function collectErrorEvents24h(logsDir: string, nowMs: number): number {
  const primary = readLogFile(path.join(logsDir, 'nanoclaw.error.log'), true);
  const rotated = readLogFile(path.join(logsDir, 'nanoclaw.error.log.1'), false);
  return countRecentErrorLines(primary, nowMs) + countRecentErrorLines(rotated, nowMs);
}

/** Missing state.json (first run ever) is a normal empty state; a present-but-corrupt one is fail-closed like every other source. */
function readPauseState(p: string): PauseState {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PauseState;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new Error(`cannot read pause-tracking state ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function collectScheduledTaskHealth(dataDir: string): { pausedSeriesKeys: string[]; failedStreakMax: number } {
  const sessionsRoot = path.join(dataDir, 'v2-sessions');
  const pausedSeriesKeys: string[] = [];
  let failedStreakMax = 0;

  if (!fs.existsSync(sessionsRoot)) return { pausedSeriesKeys, failedStreakMax };

  for (const groupDir of fs.readdirSync(sessionsRoot)) {
    const groupPath = path.join(sessionsRoot, groupDir);
    if (!fs.statSync(groupPath).isDirectory()) continue;
    for (const sessDir of fs.readdirSync(groupPath)) {
      const inboundPath = path.join(groupPath, sessDir, 'inbound.db');
      if (!fs.existsSync(inboundPath)) continue;

      const db = new Database(inboundPath, { readonly: true });
      try {
        const rows = db
          .prepare(`SELECT id, series_id, status, seq, timestamp FROM messages_in WHERE kind = 'task' ORDER BY seq DESC`)
          .all() as TaskRow[];
        for (const [seriesKey, stat] of computeSeriesStats(rows)) {
          if (isLiveForStreak(stat.latestStatus) && stat.failedStreak > failedStreakMax) {
            failedStreakMax = stat.failedStreak;
          }
          if (stat.latestStatus === 'paused') pausedSeriesKeys.push(seriesKey);
        }
      } finally {
        db.close();
      }
    }
  }

  return { pausedSeriesKeys, failedStreakMax };
}

interface StoredMetrics {
  ts: string;
  disk_used_bytes: number;
  disk_pct: number;
  error_events_24h: number;
  paused_series: number;
  oldest_paused_days: number;
  failed_streak_max: number;
}

/** Raw fleet facts for `now` — everything except oldest_paused_days, which needs cross-run state (see advancePauseState). */
function collectRaw(now: Date): {
  disk: { usedBytes: number; pct: number };
  errorEvents24h: number;
  taskHealth: { pausedSeriesKeys: string[]; failedStreakMax: number };
} {
  return {
    disk: collectDisk(DATA_DIR),
    errorEvents24h: collectErrorEvents24h(path.join(REPO_ROOT, 'logs'), now.getTime()),
    taskHealth: collectScheduledTaskHealth(DATA_DIR),
  };
}

function loadPriorMetrics(ndjsonPath: string): StoredMetrics[] {
  if (!fs.existsSync(ndjsonPath)) return [];
  return fs
    .readFileSync(ndjsonPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as StoredMetrics);
}

// ────────────────────────────── breach detection ───────────────────────────

interface Breach {
  metric: string;
  todayValue: number;
  ruleDescription: string;
  last7RawValues: number[];
}

function detectBreaches(metrics: StoredMetrics, priorMetrics: StoredMetrics[]): Breach[] {
  const breaches: Breach[] = [];

  const priorDiskUsed = priorMetrics.map((m) => m.disk_used_bytes);
  const priorDiskGrowths: number[] = [];
  for (let i = 1; i < priorDiskUsed.length; i++) priorDiskGrowths.push(priorDiskUsed[i] - priorDiskUsed[i - 1]);
  const lastPriorDiskUsed = priorDiskUsed[priorDiskUsed.length - 1];
  const todayDiskGrowth = metrics.disk_used_bytes - lastPriorDiskUsed;
  const diskBand = checkBand(todayDiskGrowth, priorDiskGrowths, 512 * 1024 * 1024);
  if (diskBand.breach) {
    breaches.push({
      metric: 'disk_growth_bytes',
      todayValue: todayDiskGrowth,
      ruleDescription:
        `today's growth ${todayDiskGrowth} bytes > median ${diskBand.median.toFixed(0)} + 3×MAD(1.4826) ` +
        `${diskBand.madScaled.toFixed(0)} = threshold ${diskBand.threshold.toFixed(0)} (n=${priorDiskGrowths.length} prior days)`,
      last7RawValues: [...priorDiskGrowths, todayDiskGrowth].slice(-7),
    });
  }

  const priorErrors = priorMetrics.map((m) => m.error_events_24h);
  const errorBand = checkBand(metrics.error_events_24h, priorErrors, 20);
  if (errorBand.breach) {
    breaches.push({
      metric: 'error_events_24h',
      todayValue: metrics.error_events_24h,
      ruleDescription:
        `today's count ${metrics.error_events_24h} > median ${errorBand.median.toFixed(1)} + 3×MAD(1.4826) ` +
        `${errorBand.madScaled.toFixed(1)} = threshold ${errorBand.threshold.toFixed(1)} (n=${priorErrors.length} prior days)`,
      last7RawValues: [...priorErrors, metrics.error_events_24h].slice(-7),
    });
  }

  if (pausedSeriesBreach(metrics.paused_series, metrics.oldest_paused_days)) {
    breaches.push({
      metric: 'paused_series',
      todayValue: metrics.paused_series,
      ruleDescription:
        `paused_series=${metrics.paused_series} > 0 AND oldest_paused_days=${metrics.oldest_paused_days} >= 3 ` +
        `(fixed rule, no band — a paused series is an absorbing state)`,
      last7RawValues: [...priorMetrics.map((m) => m.paused_series), metrics.paused_series].slice(-7),
    });
  }

  if (failedStreakBreach(metrics.failed_streak_max)) {
    breaches.push({
      metric: 'failed_streak_max',
      todayValue: metrics.failed_streak_max,
      ruleDescription: `failed_streak_max=${metrics.failed_streak_max} >= 6 (fixed rule, no band — auto-pause cap is 8)`,
      last7RawValues: [...priorMetrics.map((m) => m.failed_streak_max), metrics.failed_streak_max].slice(-7),
    });
  }

  return breaches;
}

// ───────────────────────────── GitHub issue filing ─────────────────────────

function fetchOpenFleetDriftTitles(): string[] {
  const out = execFileSync(
    'gh',
    ['issue', 'list', '--state', 'open', '--label', 'fleet-drift', '--limit', '500', '--json', 'title'],
    { encoding: 'utf-8' },
  );
  return (JSON.parse(out) as Array<{ title: string }>).map((r) => r.title);
}

function buildIssueBody(breach: Breach): string {
  return [
    `Metric: ${breach.metric}`,
    `Today's value: ${breach.todayValue}`,
    `Rule: ${breach.ruleDescription}`,
    `Last 7 raw values: ${breach.last7RawValues.join(', ')}`,
    '',
    'Reproduce: `FLEET_DRIFT_DRY_RUN=1 node_modules/.bin/tsx scripts/fleet-drift.ts` ' +
      '(collects and prints, writes ndjson to a temp path, never files issues)',
    '',
    'Filed by scripts/fleet-drift.ts (deterministic; no model involved).',
  ].join('\n');
}

function fileBreachIssues(breaches: Breach[]): void {
  execFileSync(
    'gh',
    ['label', 'create', 'fleet-drift', '--description', 'filed by scripts/fleet-drift.ts', '--force'],
    { stdio: 'pipe' },
  );
  const openTitles = fetchOpenFleetDriftTitles();
  const dateStr = new Date().toISOString().slice(0, 10);
  for (const breach of breaches) {
    if (isDuplicateBreach(openTitles, breach.metric)) {
      console.log(`fleet-drift: ${breach.metric} suppressed (open issue exists)`);
      continue;
    }
    const title = `fleet-drift: ${breach.metric} out of band (${dateStr})`;
    const url = execFileSync(
      'gh',
      ['issue', 'create', '--title', title, '--body', buildIssueBody(breach), '--label', 'fleet-drift'],
      { encoding: 'utf-8' },
    ).trim();
    console.log(`fleet-drift: filed issue for ${breach.metric}: ${url}`);
  }
}

// ──────────────────────────────────── main ─────────────────────────────────

export function main(): number {
  try {
    const dryRun = process.env.FLEET_DRIFT_DRY_RUN === '1';
    const now = new Date();
    const nowIso = now.toISOString();
    const raw = collectRaw(now);

    const fleetDriftDir = path.join(DATA_DIR, 'fleet-drift');
    const realNdjsonPath = path.join(fleetDriftDir, 'metrics.ndjson');
    const realStatePath = path.join(fleetDriftDir, 'state.json');
    const priorMetrics = loadPriorMetrics(realNdjsonPath);
    const prevPauseState = readPauseState(realStatePath);
    const { state: newPauseState, oldestPausedDays } = advancePauseState(prevPauseState, raw.taskHealth.pausedSeriesKeys, nowIso);

    const metrics: StoredMetrics = {
      ts: nowIso,
      disk_used_bytes: raw.disk.usedBytes,
      disk_pct: raw.disk.pct,
      error_events_24h: raw.errorEvents24h,
      paused_series: raw.taskHealth.pausedSeriesKeys.length,
      oldest_paused_days: Math.round(oldestPausedDays * 100) / 100,
      failed_streak_max: raw.taskHealth.failedStreakMax,
    };

    let ndjsonWritePath = realNdjsonPath;
    let stateWritePath = realStatePath;
    if (dryRun) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drift-dry-'));
      ndjsonWritePath = path.join(tmpDir, 'metrics.ndjson');
      stateWritePath = path.join(tmpDir, 'state.json');
    } else {
      fs.mkdirSync(fleetDriftDir, { recursive: true });
    }
    fs.appendFileSync(ndjsonWritePath, `${JSON.stringify(metrics)}\n`);
    fs.writeFileSync(stateWritePath, JSON.stringify(newPauseState));
    if (dryRun) {
      console.log(
        `fleet-drift: dry run — wrote today's line to ${ndjsonWritePath} and pause-state to ${stateWritePath} (real files untouched)`,
      );
    }

    if (isWarmingUp(priorMetrics.length)) {
      console.log(`fleet-drift: warming up (${priorMetrics.length}/7 runs of history)`);
      return 0;
    }

    const breaches = detectBreaches(metrics, priorMetrics);
    const status = breaches.length > 0 ? 'breach' : 'ok';
    console.log(`fleet-drift: ${status} metrics=${JSON.stringify(metrics)}`);
    for (const b of breaches) console.log(`fleet-drift: BREACH ${b.metric} — ${b.ruleDescription}`);

    if (breaches.length > 0) {
      if (dryRun) {
        console.log(`fleet-drift: dry run — skipping gh issue create for: ${breaches.map((b) => b.metric).join(', ')}`);
      } else {
        fileBreachIssues(breaches);
      }
    }

    return 0;
  } catch (err) {
    console.error(`fleet-drift: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
