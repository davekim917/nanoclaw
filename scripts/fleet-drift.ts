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
 *      the last 24h from logs/nanoclaw.error.log(.1) (ANSI-stripped; src/log.ts
 *      wraps the level tag in color codes and stamps local wall-clock plus an
 *      explicit UTC offset, which is what makes the instant recoverable here),
 *      and fleet-wide scheduled-task health (paused
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
 *      days of history → print a warm-up notice and exit 0 (the instruction-
 *      stack tripwire below has no history dependency and still runs).
 *   3b. instructionStack (no history, no band): a banned-pattern scan for
 *      dates/issue-refs/"Current Focus" headers over container/CLAUDE.md, the
 *      repo-root CLAUDE.md (the dev-facing doc, not the in-container agent
 *      surface) and every group's standing files (persona, plus a legacy
 *      CLAUDE.local.md if one is present — symlinks resolved, a shared file
 *      flagged once fleet-wide), plus a safety walk of the composed doc each
 *      container agent actually receives — provider-aware (container.json):
 *      codex/opencode read their on-disk AGENTS.md directly; claude/default
 *      walk CLAUDE.md's own @-import chain and any legacy CLAUDE.local.md,
 *      which Claude Code still auto-discovers even though compose retired
 *      it. No byte ceilings — see checkInstructionStack.
 *      docs/specs/instruction-stack-prune/plan.md.
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
import { flattenClaudeMd } from '../src/agents-md-flatten.js';
import { parseLogStamp } from '../src/log.js';

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

/** A paused series is an absorbing state (see src/modules/scheduling/recurrence.ts) — flag it once it's been sitting unresumed for a few days. */
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
 *     predicate in src/modules/scheduling/db.ts exactly, so intervening
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
 * The stamp is LOCAL wall-clock (src/log.ts `ts()` uses local Date getters)
 * followed by an explicit UTC offset, so `parseLogStamp` recovers the
 * absolute instant without assuming anything about this script's own zone.
 *
 * That assumption used to be stated here as "both are plain host processes,
 * no TZ override" — and it was false: the systemd unit sets
 * `TZ=America/New_York` while `/etc/localtime` is `Etc/UTC`, so logger and
 * reader sat 4h apart and the 24h window silently dropped its oldest 4h.
 * Lines predating the offset (rotated logs, kept 30 days) still parse, as
 * local and inexact — the same best-effort reading as before, no worse.
 */
// eslint-disable-next-line no-control-regex -- deliberately matches the ANSI CSI escape byte to strip src/log.ts's color codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ERROR_LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})([+-]\d{2}:\d{2})?\] ERROR\b/;
export function countRecentErrorLines(content: string, nowMs: number, windowMs = 24 * 60 * 60 * 1000): number {
  let count = 0;
  for (const rawLine of content.split('\n')) {
    const m = ERROR_LINE_RE.exec(rawLine.replace(ANSI_RE, ''));
    if (!m) continue;
    const parsed = parseLogStamp(m[1], m[2]);
    if (parsed && nowMs - parsed.ms <= windowMs) count++;
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
    throw new Error(`cannot read log ${p}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
    throw new Error(`cannot read pause-tracking state ${p}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
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
          .prepare(
            `SELECT id, series_id, status, seq, timestamp FROM messages_in WHERE kind = 'task' ORDER BY seq DESC`,
          )
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
  ruleDescription: string;
  /** Banded metrics only. The instruction-stack tripwire is a static tree check with no numeric series behind it. */
  todayValue?: number;
  last7RawValues?: number[];
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

// ────────────────────── L4: instruction-stack tripwire ─────────────────────
//
// Staleness guard for the always-on instruction surface
// (docs/specs/instruction-stack-prune/plan.md): a banned-pattern scan (dates,
// issue/PR refs, "Current Focus" headers) that would mean an agent wrote
// point-in-time facts into a file that's supposed to hold only timeless
// rules, plus the unscannable-file reporting that falls out of walking a
// container-writable tree to do it. Size is deliberately not a signal — a
// standing file is judged by what it says, not how long it is. No LLM, no
// history, no new timer — this reads the current tree and reports, same as
// any other check here.

// The banned-pattern scan lives in ./instruction-surface.ts so it can be
// imported without loading this module (and better-sqlite3 with it).
// Re-exported here so existing callers and tests are unchanged.
import { scanBannedPatterns } from './instruction-surface.js';

export { scanBannedPatterns };

/**
 * A group's standing-instructions file, plus the retired CLAUDE.local.md.
 * Compose no longer creates or composes the latter, but Claude Code still
 * auto-loads one if it exists, so a leftover is still scanned.
 */
const GROUP_STANDING_FILENAMES = ['standing-instructions.md', 'CLAUDE.local.md'];

export interface InstructionStackBreach {
  metric: 'container' | 'trunkDoc' | 'groupStanding' | 'effectiveStack';
  scope: string; // 'container/CLAUDE.md', or the sorted group name(s) sharing the flagged file(s)
  bannedHits: Array<{ file: string; patterns: string[] }>;
  unscannable: Array<{ file: string; reason: string }>;
}

/** container/CLAUDE.md banned-pattern check. Returns null when clean. */
export function checkContainerPatterns(containerClaudeMdPath: string): InstructionStackBreach | null {
  const patterns = scanBannedPatterns(fs.readFileSync(containerClaudeMdPath, 'utf-8'));
  if (patterns.length === 0) return null;
  return {
    metric: 'container',
    scope: 'container/CLAUDE.md',
    bannedHits: [{ file: containerClaudeMdPath, patterns }],
    unscannable: [],
  };
}

/** Repo-root CLAUDE.md banned-pattern check. Returns null when clean. */
export function checkTrunkDocPatterns(trunkClaudeMdPath: string): InstructionStackBreach | null {
  const patterns = scanBannedPatterns(fs.readFileSync(trunkClaudeMdPath, 'utf-8'));
  if (patterns.length === 0) return null;
  return {
    metric: 'trunkDoc',
    scope: 'CLAUDE.md',
    bannedHits: [{ file: trunkClaudeMdPath, patterns }],
    unscannable: [],
  };
}

interface StandingFileInfo {
  realPath: string;
  bannedHits: string[];
}

interface UnscannableFile {
  group: string;
  path: string;
  reason: string;
}

/**
 * `groups/<name>/` is container-writable, so a candidate standing-file path
 * cannot be trusted blind: a symlink to a FIFO would hang this (daily-timer)
 * process forever on read, a symlink/file to something huge or a device
 * would exhaust memory, and a symlink resolving outside groups/ would cross
 * the trust boundary into host-side content. lstat first; a symlink is only
 * followed if its resolved target stays inside `groupsRootResolved`
 * (mirrors the containment check in src/group-persona.ts readGroupPersona,
 * minus the O_NOFOLLOW fd gymnastics — not needed for a read-only metrics
 * job); the resolved target (or the path itself, if not a symlink) must be a
 * regular file under the size cap. Nothing unsafe is ever read — a null
 * return means "doesn't exist" (normal; most groups don't have every
 * candidate filename), a `skip` return means "exists but unsafe to read."
 */
function resolveStandingFile(p: string, groupsRootResolved: string): { realPath: string } | { skip: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch (err) {
    // ENOENT is the normal case — most groups don't have every candidate
    // filename. Anything else (EACCES, a race mid-scan, ...) is unexpected —
    // fail closed like every other collector in this file, don't swallow it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let realPath = p;
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.realpathSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skip: 'broken symlink' };
      throw err;
    }
    if (target !== groupsRootResolved && !target.startsWith(groupsRootResolved + path.sep)) {
      return { skip: `symlink escapes groups/ (-> ${target})` };
    }
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skip: 'broken symlink target' };
      throw err;
    }
    realPath = target;
  }

  const check = checkRegularSize(stat);
  return check.ok ? { realPath } : { skip: check.reason };
}

/** ponytail: sanity cap, not a precision limit — 100x+ the real ceiling is plenty of headroom for any legitimate standing file, small enough that a planted huge file/device is never read into memory. */
const MAX_STANDING_FILE_BYTES = 1_000_000;

/** Shared tail check for every safety gate in this file: given an already-obtained `Stats`, is it a regular file under the size cap? */
function checkRegularSize(stat: fs.Stats): { ok: true } | { ok: false; reason: string } {
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
  if (stat.size > MAX_STANDING_FILE_BYTES)
    return { ok: false, reason: `exceeds ${MAX_STANDING_FILE_BYTES} B safety cap (${stat.size} B)` };
  return { ok: true };
}

/** Reads one group's standing files, resolving symlinks to their real target so a shared file is read (and counted) once. Unsafe candidates are skipped, never read. */
function readGroupStandingFiles(
  groupDir: string,
  groupsRootResolved: string,
): { files: StandingFileInfo[]; unscannable: UnscannableFile[] } {
  const files: StandingFileInfo[] = [];
  const unscannable: UnscannableFile[] = [];
  const group = path.basename(groupDir);
  for (const name of GROUP_STANDING_FILENAMES) {
    const p = path.join(groupDir, name);
    const resolved = resolveStandingFile(p, groupsRootResolved);
    if (resolved === null) continue;
    if ('skip' in resolved) {
      unscannable.push({ group, path: p, reason: resolved.skip });
      continue;
    }
    files.push({
      realPath: resolved.realPath,
      bannedHits: scanBannedPatterns(fs.readFileSync(resolved.realPath, 'utf-8')),
    });
  }
  return { files, unscannable };
}

/**
 * Banned-pattern check over every group's standing files under `groupsRoot`.
 *
 * Scanned per real file fleet-wide, not per group: sibling groups commonly
 * symlink some or all of their standing files to one source group (e.g. a
 * codex/opencode sibling → its Claude counterpart), and a clone can share
 * only SOME of them (one common persona across a sibling trio, another group
 * in the same workgroup keeping its own). Keying on the resolved real path reports a shared file's hit
 * once, scoped to every group that reaches it, however the sharing is shaped.
 */
export function checkGroupStandingPatterns(groupsRoot: string): InstructionStackBreach[] {
  if (!fs.existsSync(groupsRoot)) return [];
  const groupsRootResolved = fs.realpathSync(groupsRoot);
  const groupNames = fs
    .readdirSync(groupsRoot)
    .filter((name) => fs.statSync(path.join(groupsRoot, name)).isDirectory());

  const byRealPath = new Map<string, { bannedHits: string[]; groups: Set<string> }>();
  const allUnscannable: UnscannableFile[] = [];

  for (const group of groupNames) {
    const { files, unscannable } = readGroupStandingFiles(path.join(groupsRoot, group), groupsRootResolved);
    allUnscannable.push(...unscannable);

    for (const f of files) {
      const existing = byRealPath.get(f.realPath);
      if (existing) existing.groups.add(group);
      else byRealPath.set(f.realPath, { bannedHits: f.bannedHits, groups: new Set([group]) });
    }
  }

  const breaches: InstructionStackBreach[] = [];

  for (const [realPath, { bannedHits, groups }] of byRealPath) {
    if (bannedHits.length === 0) continue;
    breaches.push({
      metric: 'groupStanding',
      scope: [...groups].sort().join(', '),
      bannedHits: [{ file: realPath, patterns: bannedHits }],
      unscannable: [],
    });
  }

  breaches.push(...unscannableBreaches('groupStanding', allUnscannable));
  return breaches;
}

/** One breach per group with any unscannable candidate file — shared by every metric that gates reads through resolveStandingFile. */
function unscannableBreaches(
  metric: InstructionStackBreach['metric'],
  items: UnscannableFile[],
): InstructionStackBreach[] {
  const byGroup = new Map<string, UnscannableFile[]>();
  for (const u of items) {
    const arr = byGroup.get(u.group);
    if (arr) arr.push(u);
    else byGroup.set(u.group, [u]);
  }
  return [...byGroup.entries()].map(([group, files]) => ({
    metric,
    scope: group,
    bannedHits: [],
    unscannable: files.map(({ path: p, reason }) => ({ file: p, reason })),
  }));
}

// Defensive translation only — compose (`src/claude-md-compose.ts`) no longer
// writes any `.claude-shared.md`/`.claude-fragments/` symlink pointing at
// these container paths (every section is read from its host path and
// inlined directly),
// so a freshly composed CLAUDE.md never contains an `@`-import that resolves
// through this map. It stays here for two reasons: a group whose CLAUDE.md
// predates that change still carries the old `@`-import text until its next
// spawn recomposes it, and flattenClaudeMd's `@`-line handling (see
// agents-md-flatten.ts) translates ANY literal `@/app/...` reference, symlink
// or not, so this is also insurance against a stray hand-written one. Keep it
// in sync with compose's shared-base/module-fragment host paths if those ever
// move.
const COMPOSE_CONTAINER_TO_HOST = (repoRoot: string): Record<string, string> => ({
  '/app/CLAUDE.md': path.join(repoRoot, 'container', 'CLAUDE.md'),
  '/app/skills': path.join(repoRoot, 'container', 'skills'),
  '/app/src/mcp-tools': path.join(repoRoot, 'container', 'agent-runner', 'src', 'mcp-tools'),
});

/**
 * Which provider actually reads this group's composed doc, read from
 * `groups/<g>/container.json` (container-writable, so gated the same way as
 * any standing file). Absent field, absent file, or `'default'` all mean
 * claude — mirrors `resolveProviderName`'s container-config half
 * (`src/db/container-configs.ts`) without needing the session-level override
 * that only exists at spawn time. A present-but-unsafe or malformed file
 * returns `skip` rather than guessing: source selection depends on this, so
 * an unreadable provider must block measurement, not silently default.
 */
function readGroupProvider(groupDir: string, groupsRootResolved: string): { provider: string } | { skip: string } {
  const p = path.join(groupDir, 'container.json');
  const resolved = resolveStandingFile(p, groupsRootResolved);
  if (resolved === null) return { provider: 'claude' }; // no container.json — default
  if ('skip' in resolved) return { skip: resolved.skip };

  let content: string;
  try {
    content = fs.readFileSync(resolved.realPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skip: 'container.json vanished mid-scan' };
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    // Content error (bad JSON), not an infra error — always a skip, never rethrown.
    return { skip: `malformed container.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rawProvider =
    raw && typeof raw === 'object' && typeof (raw as { provider?: unknown }).provider === 'string'
      ? (raw as { provider: string }).provider
      : '';
  return { provider: (rawProvider || 'claude').toLowerCase() };
}

/**
 * `flattenClaudeMd`'s `validateRead` gate for one group's @-import chain.
 * `groups/<g>/` is container-writable, so a nested import is exactly as
 * untrusted as a top-level standing file — the same FIFO-hang /
 * huge-file-memory / trust-boundary-escape vectors apply to every hop of
 * the chain, not just the file `flattenClaudeMd` was first pointed at.
 * Allowed roots: the group's own tree (legitimate cross-group persona
 * symlinks) plus the known host-side prefixes compose's own containerToHost
 * map translates to (the shared base, skills, mcp-tools instructions —
 * host-controlled, not container-writable, but still real-file/size-capped
 * for consistency). Violations are recorded into `unscannable` via closure
 * so the caller can report them; the flattener gets back only a reason
 * string to inline as its own skip marker.
 */
function makeFlattenGuard(
  group: string,
  allowedRoots: string[],
  unscannable: UnscannableFile[],
): (realPath: string) => string | undefined {
  return (realPath: string) => {
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(realPath);
    } catch (err) {
      // Missing target = a stale/dangling @-import — not a security issue,
      // let flattenClaudeMd's own "failed to read" marker handle it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    if (lst.isSymbolicLink()) {
      // resolveSymlinkChain (agents-md-flatten.ts) already tried to resolve
      // this and gave up — either the target is genuinely dangling (benign:
      // e.g. a stale fragment symlink pointing at a source file a later
      // trunk change deleted) or it resolves to something non-regular like
      // a FIFO (unsafe: reading it would hang). Both land here identically
      // because resolveSymlinkChain's translation step (container-path
      // prefixes aren't real host paths) means a plain follow-up stat can't
      // tell them apart without redoing that translation.
      //
      // ponytail: treat both as unscannable rather than reimplementing
      // resolveSymlinkChain's translation-aware resolution a second time
      // just to split "dangling" from "unsafe" — safe either way (never
      // read), and a dangling fragment symlink is itself a real staleness
      // signal this tripwire wants surfaced. Upgrade path if the dangling
      // case turns out to be common/noisy enough to want quieted: export
      // resolveSymlinkChain (or a variant that reports why it gave up) from
      // agents-md-flatten.ts and call it here instead of this lstat check.
      const reason = 'symlink does not resolve to a readable regular file (dangling target or non-regular type)';
      unscannable.push({ group, path: realPath, reason });
      return reason;
    }
    const check = checkRegularSize(lst);
    if (!check.ok) {
      unscannable.push({ group, path: realPath, reason: check.reason });
      return check.reason;
    }
    const contained = allowedRoots.some((root) => realPath === root || realPath.startsWith(root + path.sep));
    if (!contained) {
      const reason = `import escapes the trusted set (-> ${realPath})`;
      unscannable.push({ group, path: realPath, reason });
      return reason;
    }
    return undefined;
  };
}

/**
 * Walks the composed doc one group's container agent actually receives, so
 * anything unsafe along that chain is reported rather than read. Source
 * depends on which harness actually reads it (container.json's `provider`):
 *
 * - codex/opencode: AGENTS.md alone IS the complete artifact; their harnesses
 *   read nothing else from the group folder.
 * - claude/default: compose already writes CLAUDE.md fully flat (no
 *   `@`-imports left to resolve — the flatten call below is a no-op unless a
 *   group's CLAUDE.md predates that cutover), but Claude Code auto-discovers a
 *   CLAUDE.local.md independently of compose. Compose retired that file, yet a
 *   leftover still loads, so walk CLAUDE.md's own chain plus any
 *   CLAUDE.local.md rather than trusting AGENTS.md's spawn-time snapshot.
 *
 * The flatten call's OUTPUT is deliberately discarded — it is made for its
 * `validateRead` gate, the only thing that walks nested `@`-imports and can
 * refuse an unsafe hop. Nothing to walk (never spawned, nothing composed yet)
 * is not a finding.
 */
function scanEffectiveStack(groupDir: string, groupsRootResolved: string): UnscannableFile[] {
  const group = path.basename(groupDir);
  const unscannable: UnscannableFile[] = [];

  const providerResult = readGroupProvider(groupDir, groupsRootResolved);
  if ('skip' in providerResult) {
    unscannable.push({ group, path: path.join(groupDir, 'container.json'), reason: providerResult.skip });
    return unscannable;
  }

  if (providerResult.provider === 'codex' || providerResult.provider === 'opencode') {
    const agentsPath = path.join(groupDir, 'AGENTS.md');
    const agents = resolveStandingFile(agentsPath, groupsRootResolved);
    if (agents !== null && 'skip' in agents) unscannable.push({ group, path: agentsPath, reason: agents.skip });
    return unscannable;
  }

  // claude / default — walk CLAUDE.md's own chain; never trust AGENTS.md's snapshot for this provider.
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const claudeMd = resolveStandingFile(claudeMdPath, groupsRootResolved);
  if (claudeMd === null) return unscannable; // never spawned — nothing composed yet
  if ('skip' in claudeMd) {
    unscannable.push({ group, path: claudeMdPath, reason: claudeMd.skip });
    return unscannable;
  }

  const repoRoot = path.resolve(groupsRootResolved, '..');
  const containerToHost = COMPOSE_CONTAINER_TO_HOST(repoRoot);
  const allowedRoots = [groupsRootResolved, ...Object.values(containerToHost)];
  flattenClaudeMd(claudeMd.realPath, {
    containerToHost,
    validateRead: makeFlattenGuard(group, allowedRoots, unscannable),
  });

  const localPath = path.join(groupDir, 'CLAUDE.local.md');
  const local = resolveStandingFile(localPath, groupsRootResolved);
  if (local !== null && 'skip' in local) unscannable.push({ group, path: localPath, reason: local.skip });

  return unscannable;
}

/**
 * Per-group safety walk of the composed doc a container agent actually
 * receives — not just the authored standing files (which is what
 * checkGroupStandingPatterns covers). `groups/` is container-writable, so
 * every hop of that chain is a trust boundary: anything this refuses to read
 * (a symlink escaping the trusted set, a FIFO, a file over the size cap, an
 * unreadable container.json) is reported and never read.
 *
 * No banned-pattern scan here: that content was already scanned at its source
 * file by checkGroupStandingPatterns/checkContainerPatterns, and re-scanning
 * the flattened doc would re-flag the same hit under a second metric and
 * false-positive on shared-base example text that happens to get inlined.
 */
export function checkEffectiveStackSafety(groupsRoot: string): InstructionStackBreach[] {
  if (!fs.existsSync(groupsRoot)) return [];
  const groupsRootResolved = fs.realpathSync(groupsRoot);
  const groupNames = fs
    .readdirSync(groupsRoot)
    .filter((name) => fs.statSync(path.join(groupsRoot, name)).isDirectory());

  const allUnscannable: UnscannableFile[] = [];
  for (const group of groupNames) {
    allUnscannable.push(...scanEffectiveStack(path.join(groupsRoot, group), groupsRootResolved));
  }

  return unscannableBreaches('effectiveStack', allUnscannable);
}

/** All four surfaces together — the core L4 check. Each reports on its own files: a hit in a shared base file must not be re-reported once per group that inherits it. */
export function checkInstructionStack(
  containerClaudeMdPath: string,
  groupsRoot: string,
  trunkClaudeMdPath: string,
): InstructionStackBreach[] {
  const containerBreach = checkContainerPatterns(containerClaudeMdPath);
  const trunkBreach = checkTrunkDocPatterns(trunkClaudeMdPath);
  return [
    ...(containerBreach ? [containerBreach] : []),
    ...(trunkBreach ? [trunkBreach] : []),
    ...checkGroupStandingPatterns(groupsRoot),
    ...checkEffectiveStackSafety(groupsRoot),
  ];
}

function describeInstructionStackBreach(b: InstructionStackBreach): string {
  const parts: string[] = [];
  for (const hit of b.bannedHits) parts.push(`banned pattern(s) [${hit.patterns.join(', ')}] in ${hit.file}`);
  for (const u of b.unscannable) parts.push(`unscannable standing file ${u.file} (${u.reason}) — skipped, never read`);
  return parts.join('; ');
}

/** pattern / unscannable breaches for the same scope must not share a metric identity, or the same-day issue-title dedup collapses two distinct findings into one filed issue. */
export function instructionStackBreachKind(b: InstructionStackBreach): string {
  return b.unscannable.length > 0 ? 'unscannable' : 'pattern';
}

function detectInstructionStackBreaches(
  containerClaudeMdPath: string,
  groupsRoot: string,
  trunkClaudeMdPath: string,
): Breach[] {
  return checkInstructionStack(containerClaudeMdPath, groupsRoot, trunkClaudeMdPath).map((b) => ({
    metric: `instructionStack:${b.metric}:${instructionStackBreachKind(b)}:${b.scope}`,
    ruleDescription: describeInstructionStackBreach(b),
  }));
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
    ...(breach.todayValue === undefined ? [] : [`Today's value: ${breach.todayValue}`]),
    `Rule: ${breach.ruleDescription}`,
    ...(breach.last7RawValues === undefined ? [] : [`Last 7 raw values: ${breach.last7RawValues.join(', ')}`]),
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

function logAndFileBreaches(breaches: Breach[], dryRun: boolean): void {
  for (const b of breaches) console.log(`fleet-drift: BREACH ${b.metric} — ${b.ruleDescription}`);
  if (breaches.length === 0) return;
  if (dryRun) {
    console.log(`fleet-drift: dry run — skipping gh issue create for: ${breaches.map((b) => b.metric).join(', ')}`);
  } else {
    fileBreachIssues(breaches);
  }
}

// ──────────────────────────────────── main ─────────────────────────────────

function main(): number {
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
    const { state: newPauseState, oldestPausedDays } = advancePauseState(
      prevPauseState,
      raw.taskHealth.pausedSeriesKeys,
      nowIso,
    );

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

    // Instruction-stack tripwire (L4): a static tree check, independent of the
    // banded metrics' daily history — runs (and can file) even during warm-up.
    const instructionStackBreaches = detectInstructionStackBreaches(
      path.join(REPO_ROOT, 'container', 'CLAUDE.md'),
      path.join(REPO_ROOT, 'groups'),
      path.join(REPO_ROOT, 'CLAUDE.md'),
    );

    if (isWarmingUp(priorMetrics.length)) {
      console.log(`fleet-drift: warming up (${priorMetrics.length}/7 runs of history)`);
      logAndFileBreaches(instructionStackBreaches, dryRun);
      return 0;
    }

    const breaches = [...detectBreaches(metrics, priorMetrics), ...instructionStackBreaches];
    const status = breaches.length > 0 ? 'breach' : 'ok';
    console.log(`fleet-drift: ${status} metrics=${JSON.stringify(metrics)}`);
    logAndFileBreaches(breaches, dryRun);

    return 0;
  } catch (err) {
    console.error(`fleet-drift: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
