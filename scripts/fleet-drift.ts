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
 *      days of history → print a warm-up notice and exit 0 (the instruction-
 *      stack tripwire below has no history dependency and still runs).
 *   3b. instructionStack (no history, no band): container/CLAUDE.md ceiling,
 *      per-group standing-file ceiling (persona + CLAUDE.local.md, symlinks
 *      resolved, shared files counted/flagged once fleet-wide) with a
 *      banned-pattern scan for dates/issue-refs/"Current Focus" headers, and
 *      per-group effectiveStackBytes ceiling on the FLATTENED composed doc a
 *      container agent actually receives — provider-aware (container.json):
 *      codex/opencode read their on-disk AGENTS.md directly (their harnesses
 *      embed CLAUDE.local.md there at compose time); claude/default flatten
 *      CLAUDE.md themselves and add CLAUDE.local.md's bytes on top, since
 *      Claude Code auto-discovers it independently and AGENTS.md is only a
 *      spawn-time snapshot that can miss a newer local edit. Size only, no
 *      pattern scan — see checkInstructionStack.
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

// ────────────────────── L4: instruction-stack tripwire ─────────────────────
//
// Re-inflation / staleness guard for the always-on instruction surface
// (docs/specs/instruction-stack-prune/plan.md). Two independent byte
// ceilings — container/CLAUDE.md alone, and each group's standing files —
// plus a banned-pattern scan (dates, issue/PR refs, "Current Focus" headers)
// that would mean an agent wrote point-in-time facts into a file that's
// supposed to hold only timeless rules. No LLM, no history, no new timer —
// this reads the current tree and reports, same as any other check here.

/** container/CLAUDE.md alone (shared base, not persona/fragments). */
export const CONTAINER_BYTES_CEILING = 10_240;
/** Per group: its standing-instructions/persona file(s) + CLAUDE.local.md. */
export const GROUP_STANDING_BYTES_CEILING = 8_192;

/** A group's standing-instructions file plus its CLAUDE.local.md. */
const GROUP_STANDING_FILENAMES = ['standing-instructions.md', 'CLAUDE.local.md'];

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'xzo_ref', re: /\bXZO-\d+\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
];

/** Names every banned pattern found in `content` — point-in-time facts that don't belong in a standing instruction file. */
export function scanBannedPatterns(content: string): string[] {
  return BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
}

export interface InstructionStackBreach {
  metric: 'containerBytes' | 'groupStandingBytes' | 'effectiveStackBytes';
  scope: string; // 'container/CLAUDE.md', or the sorted group name(s) sharing the flagged file(s)
  bytes: number;
  ceiling: number;
  overCeiling: boolean;
  bannedHits: Array<{ file: string; patterns: string[] }>;
  unscannable: Array<{ file: string; reason: string }>;
}

/** container/CLAUDE.md ceiling + banned-pattern check. Returns null when clean. */
export function checkContainerBytes(
  containerClaudeMdPath: string,
  ceiling = CONTAINER_BYTES_CEILING,
): InstructionStackBreach | null {
  const content = fs.readFileSync(containerClaudeMdPath, 'utf-8');
  const bytes = Buffer.byteLength(content, 'utf-8');
  const patterns = scanBannedPatterns(content);
  const overCeiling = bytes > ceiling;
  if (!overCeiling && patterns.length === 0) return null;
  return {
    metric: 'containerBytes',
    scope: 'container/CLAUDE.md',
    bytes,
    ceiling,
    overCeiling,
    bannedHits: patterns.length ? [{ file: containerClaudeMdPath, patterns }] : [],
    unscannable: [],
  };
}

interface StandingFileInfo {
  realPath: string;
  bytes: number;
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
    const content = fs.readFileSync(resolved.realPath, 'utf-8');
    files.push({
      realPath: resolved.realPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
      bannedHits: scanBannedPatterns(content),
    });
  }
  return { files, unscannable };
}

/**
 * Per-group standing-file ceiling + banned-pattern check across every group
 * under `groupsRoot`.
 *
 * Ceiling: sibling groups commonly symlink their ENTIRE standing file set to
 * one source group (e.g. a codex/opencode sibling → its Claude counterpart)
 * — those groups are clustered by the exact set of real files they resolve
 * to, and the cluster's total is checked once against the per-group ceiling
 * (it's the same total for every member, so one breach covers the cluster).
 *
 * Banned patterns: deliberately NOT scoped to those clusters — a normal
 * clone shares only SOME standing files (e.g. one common CLAUDE.local.md,
 * each group keeping its own persona), which puts those groups in different
 * clusters. Scanned per real file fleet-wide instead, independent of cluster
 * shape, so a shared file's hit is reported once no matter how many groups
 * reference it.
 */
export function checkGroupStandingBytes(
  groupsRoot: string,
  ceiling = GROUP_STANDING_BYTES_CEILING,
): InstructionStackBreach[] {
  if (!fs.existsSync(groupsRoot)) return [];
  const groupsRootResolved = fs.realpathSync(groupsRoot);
  const groupNames = fs
    .readdirSync(groupsRoot)
    .filter((name) => fs.statSync(path.join(groupsRoot, name)).isDirectory());

  const clusters = new Map<string, { groups: string[]; files: Map<string, StandingFileInfo> }>();
  const byRealPath = new Map<string, { bannedHits: string[]; groups: Set<string> }>();
  const allUnscannable: UnscannableFile[] = [];

  for (const group of groupNames) {
    const { files, unscannable } = readGroupStandingFiles(path.join(groupsRoot, group), groupsRootResolved);
    allUnscannable.push(...unscannable);
    if (files.length === 0) continue;

    for (const f of files) {
      const existing = byRealPath.get(f.realPath);
      if (existing) existing.groups.add(group);
      else byRealPath.set(f.realPath, { bannedHits: f.bannedHits, groups: new Set([group]) });
    }

    const signature = files
      .map((f) => f.realPath)
      .sort()
      .join('|');
    let cluster = clusters.get(signature);
    if (!cluster) {
      cluster = { groups: [], files: new Map(files.map((f) => [f.realPath, f])) };
      clusters.set(signature, cluster);
    }
    cluster.groups.push(group);
  }

  const breaches: InstructionStackBreach[] = [];

  for (const { groups, files } of clusters.values()) {
    const bytes = [...files.values()].reduce((sum, f) => sum + f.bytes, 0);
    if (bytes > ceiling) {
      breaches.push({
        metric: 'groupStandingBytes',
        scope: [...groups].sort().join(', '),
        bytes,
        ceiling,
        overCeiling: true,
        bannedHits: [],
        unscannable: [],
      });
    }
  }

  for (const [realPath, { bannedHits, groups }] of byRealPath) {
    if (bannedHits.length === 0) continue;
    breaches.push({
      metric: 'groupStandingBytes',
      scope: [...groups].sort().join(', '),
      bytes: 0, // pattern-only finding; the cluster's ceiling breach (if any) carries the byte total
      ceiling,
      overCeiling: false,
      bannedHits: [{ file: realPath, patterns: bannedHits }],
      unscannable: [],
    });
  }

  breaches.push(...unscannableBreaches('groupStandingBytes', ceiling, allUnscannable));
  return breaches;
}

/** One breach per group with any unscannable candidate file — shared by every metric that gates reads through resolveStandingFile. */
function unscannableBreaches(
  metric: InstructionStackBreach['metric'],
  ceiling: number,
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
    bytes: 0,
    ceiling,
    overCeiling: false,
    bannedHits: [],
    unscannable: files.map(({ path: p, reason }) => ({ file: p, reason })),
  }));
}

/** ponytail: sanity cap on the flattened doc, same reasoning as MAX_STANDING_FILE_BYTES — no legitimate composed stack gets remotely close. */
export const EFFECTIVE_STACK_BYTES_CEILING = 24_576;

// Mirrors src/claude-md-compose.ts:219-273's containerToHost map exactly (not
// imported — those are module-private consts there, and this is a read-only
// metrics job in a different file, not a shared library). If compose's
// container-path scheme changes, update both.
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
 * The bytes one group's container agent actually receives as its always-on
 * project doc — not just the authored top-level file. Source depends on
 * which harness actually reads it (container.json's `provider`):
 *
 * - codex/opencode: their harnesses don't auto-discover CLAUDE.local.md —
 *   compose embeds it raw into AGENTS.md at spawn time, so AGENTS.md alone
 *   IS the complete artifact.
 * - claude/default: Claude Code resolves CLAUDE.md's @-imports itself and
 *   auto-discovers CLAUDE.local.md independently — neither is embedded in
 *   AGENTS.md's generation inputs in a way that stays current for Claude,
 *   and AGENTS.md is only regenerated at spawn time, so it can miss a
 *   CLAUDE.local.md edited since. Flatten CLAUDE.md ourselves and add
 *   CLAUDE.local.md's bytes on top instead of trusting the snapshot.
 *
 * Returns bytes: null when nothing can be measured (never spawned, or the
 * provider itself couldn't be safely read) — not a breach on its own; an
 * unsafe file along the way is reported via `unscannable` separately.
 */
function measureEffectiveStack(
  groupDir: string,
  groupsRootResolved: string,
): { bytes: number | null; unscannable: UnscannableFile[] } {
  const group = path.basename(groupDir);
  const unscannable: UnscannableFile[] = [];

  const providerResult = readGroupProvider(groupDir, groupsRootResolved);
  if ('skip' in providerResult) {
    unscannable.push({ group, path: path.join(groupDir, 'container.json'), reason: providerResult.skip });
    return { bytes: null, unscannable };
  }

  if (providerResult.provider === 'codex' || providerResult.provider === 'opencode') {
    const agentsPath = path.join(groupDir, 'AGENTS.md');
    const agents = resolveStandingFile(agentsPath, groupsRootResolved);
    if (agents === null) return { bytes: null, unscannable }; // never spawned — nothing composed yet
    if ('skip' in agents) {
      unscannable.push({ group, path: agentsPath, reason: agents.skip });
      return { bytes: null, unscannable };
    }
    const content = fs.readFileSync(agents.realPath, 'utf-8');
    return { bytes: Buffer.byteLength(content, 'utf-8'), unscannable };
  }

  // claude / default — flatten CLAUDE.md ourselves; never trust AGENTS.md's snapshot for this provider.
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const claudeMd = resolveStandingFile(claudeMdPath, groupsRootResolved);
  if (claudeMd === null) return { bytes: null, unscannable }; // never spawned — nothing composed yet
  if ('skip' in claudeMd) {
    unscannable.push({ group, path: claudeMdPath, reason: claudeMd.skip });
    return { bytes: null, unscannable };
  }

  const repoRoot = path.resolve(groupsRootResolved, '..');
  const containerToHost = COMPOSE_CONTAINER_TO_HOST(repoRoot);
  const allowedRoots = [groupsRootResolved, ...Object.values(containerToHost)];
  const flattened = flattenClaudeMd(claudeMd.realPath, {
    containerToHost,
    validateRead: makeFlattenGuard(group, allowedRoots, unscannable),
  });
  let bytes = Buffer.byteLength(flattened, 'utf-8');

  const localPath = path.join(groupDir, 'CLAUDE.local.md');
  const local = resolveStandingFile(localPath, groupsRootResolved);
  if (local !== null) {
    if ('skip' in local) unscannable.push({ group, path: localPath, reason: local.skip });
    else bytes += Buffer.byteLength(fs.readFileSync(local.realPath, 'utf-8'), 'utf-8');
  }

  return { bytes, unscannable };
}

/**
 * Per-group effective-stack ceiling — the flattened doc a container agent
 * actually receives, not just the authored standing files (which is what
 * groupStandingBytes measures). Size only: banned-pattern content was
 * already scanned at its source file by groupStandingBytes/containerBytes;
 * re-scanning the flattened doc would just re-flag the same hit under a
 * different metric and false-positive on shared-base example text that
 * happens to get inlined here.
 */
export function checkEffectiveStackBytes(
  groupsRoot: string,
  ceiling = EFFECTIVE_STACK_BYTES_CEILING,
): InstructionStackBreach[] {
  if (!fs.existsSync(groupsRoot)) return [];
  const groupsRootResolved = fs.realpathSync(groupsRoot);
  const groupNames = fs
    .readdirSync(groupsRoot)
    .filter((name) => fs.statSync(path.join(groupsRoot, name)).isDirectory());

  const breaches: InstructionStackBreach[] = [];
  const allUnscannable: UnscannableFile[] = [];

  for (const group of groupNames) {
    const { bytes, unscannable } = measureEffectiveStack(path.join(groupsRoot, group), groupsRootResolved);
    allUnscannable.push(...unscannable);
    if (bytes !== null && bytes > ceiling) {
      breaches.push({
        metric: 'effectiveStackBytes',
        scope: group,
        bytes,
        ceiling,
        overCeiling: true,
        bannedHits: [],
        unscannable: [],
      });
    }
  }

  breaches.push(...unscannableBreaches('effectiveStackBytes', ceiling, allUnscannable));
  return breaches;
}

/** All three metrics together — the core L4 check. Kept as separate ceilings (never summed): a shared base file must not guarantee a false breach of every group's ceiling. */
export function checkInstructionStack(containerClaudeMdPath: string, groupsRoot: string): InstructionStackBreach[] {
  const containerBreach = checkContainerBytes(containerClaudeMdPath);
  return [
    ...(containerBreach ? [containerBreach] : []),
    ...checkGroupStandingBytes(groupsRoot),
    ...checkEffectiveStackBytes(groupsRoot),
  ];
}

function describeInstructionStackBreach(b: InstructionStackBreach): string {
  const parts: string[] = [];
  if (b.overCeiling) parts.push(`${b.bytes} B > ceiling ${b.ceiling} B`);
  for (const hit of b.bannedHits) parts.push(`banned pattern(s) [${hit.patterns.join(', ')}] in ${hit.file}`);
  for (const u of b.unscannable) parts.push(`unscannable standing file ${u.file} (${u.reason}) — skipped, never read`);
  return parts.join('; ');
}

/** ceiling / pattern / unscannable breaches for the same scope must not share a metric identity, or the same-day issue-title dedup collapses two distinct findings into one filed issue. */
export function instructionStackBreachKind(b: InstructionStackBreach): string {
  if (b.overCeiling) return 'ceiling';
  if (b.unscannable.length > 0) return 'unscannable';
  return 'pattern';
}

function detectInstructionStackBreaches(containerClaudeMdPath: string, groupsRoot: string): Breach[] {
  return checkInstructionStack(containerClaudeMdPath, groupsRoot).map((b) => ({
    metric: `instructionStack:${b.metric}:${instructionStackBreachKind(b)}:${b.scope}`,
    todayValue: b.bytes,
    ruleDescription: describeInstructionStackBreach(b),
    last7RawValues: [b.bytes],
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
