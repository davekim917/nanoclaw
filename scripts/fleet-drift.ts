#!/usr/bin/env tsx
/**
 * Daily control-band fleet-health check, run by a systemd timer (data/systemd/ holds reference
 * copies). Fail-closed: any unreadable source throws, never a silent zero. Banded metrics breach at
 * median + 3×MAD of the prior days (warm-up below 7 days, except the instruction-stack tripwire). A
 * breach files one `fleet-drift` issue per metric; an open issue with that title prefix IS the
 * cooldown, and closing it re-arms.
 *
 * FLEET_DRIFT_DRY_RUN=1 writes to a temp path and never files, but still reads the REAL history.
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

export interface BandResult {
  breach: boolean;
  median: number;
  madScaled: number;
  threshold: number;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** MAD scaled ×1.4826. MAD 0 (flat history) would flag any nonzero value, hence `flatZeroGuardAbs`. */
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

/** A paused series is an absorbing state: flag it once it's been sitting unresumed for a few days. */
export function pausedSeriesBreach(pausedSeries: number, oldestPausedDays: number): boolean {
  return pausedSeries > 0 && oldestPausedDays >= 3;
}

/** Below recurrence.ts SCRIPT_FAIL_PAUSE_CAP (8), to catch the streak before it pauses itself. */
export function failedStreakBreach(failedStreakMax: number): boolean {
  return failedStreakMax >= 6;
}

export function isDuplicateBreach(openTitles: string[], metric: string): boolean {
  const prefix = `fleet-drift: ${metric}`;
  return openTitles.some((t) => t.startsWith(prefix));
}

export function isWarmingUp(priorLineCount: number): boolean {
  return priorLineCount < 7;
}

/** Excludes cancelled/paused series: nothing resets a dead series' streak, so it would breach forever. */
export function isLiveForStreak(latestStatus: string): boolean {
  return latestStatus !== 'cancelled' && latestStatus !== 'paused';
}

export interface PauseState {
  [seriesKey: string]: string; // ISO timestamp this script first observed the series paused
}

/**
 * `pauseTask` stamps no timestamp, so first-observed-paused is tracked across runs: a LOWER bound
 * on pause duration.
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
 * Input ordered by seq DESC. `failedStreak` must match `trailingFailedRuns` in
 * src/modules/scheduling/db.ts: only 'completed'/'failed' rows count.
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

// eslint-disable-next-line no-control-regex -- deliberately matches the ANSI CSI escape byte to strip src/log.ts's color codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ERROR_LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})([+-]\d{2}:\d{2})?\] ERROR\b/;
// An offset-less legacy line's true instant is unrecoverable, so its window membership is best-effort.
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

/** Missing state.json is a normal first run; a present-but-corrupt one fails closed. */
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

interface Breach {
  metric: string;
  ruleDescription: string;
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

// The scan lives in ./instruction-surface.ts so it imports without loading better-sqlite3.
import { scanBannedPatterns } from './instruction-surface.js';

export { scanBannedPatterns };

/** Claude Code still auto-loads a leftover CLAUDE.local.md, so it is scanned too. */
const GROUP_STANDING_FILENAMES = ['standing-instructions.md', 'CLAUDE.local.md'];

export interface InstructionStackBreach {
  metric: 'container' | 'trunkDoc' | 'groupStanding' | 'effectiveStack';
  scope: string; // 'container/CLAUDE.md', or the sorted group name(s) sharing the flagged file(s)
  bannedHits: Array<{ file: string; patterns: string[] }>;
  unscannable: Array<{ file: string; reason: string }>;
}

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
 * `groups/<name>/` is container-writable: a FIFO symlink would hang, a huge file exhaust memory, a
 * symlink outside groups/ cross the trust boundary. `null`: absent; `skip`: exists but unsafe.
 */
function resolveStandingFile(p: string, groupsRootResolved: string): { realPath: string } | { skip: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch (err) {
    // ENOENT is normal; anything else fails closed.
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

const MAX_STANDING_FILE_BYTES = 1_000_000;

function checkRegularSize(stat: fs.Stats): { ok: true } | { ok: false; reason: string } {
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
  if (stat.size > MAX_STANDING_FILE_BYTES)
    return { ok: false, reason: `exceeds ${MAX_STANDING_FILE_BYTES} B safety cap (${stat.size} B)` };
  return { ok: true };
}

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

/** Keyed by real path: siblings symlink standing files to one source, so a shared hit reports once. */
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

// Kept for older CLAUDE.md files and hand-written `@/app/...` imports; keep in sync with compose's host paths.
const COMPOSE_CONTAINER_TO_HOST = (repoRoot: string): Record<string, string> => ({
  '/app/CLAUDE.md': path.join(repoRoot, 'container', 'CLAUDE.md'),
  '/app/skills': path.join(repoRoot, 'container', 'skills'),
  '/app/src/mcp-tools': path.join(repoRoot, 'container', 'agent-runner', 'src', 'mcp-tools'),
});

/**
 * Absent or `'default'` means claude. An unsafe or malformed container.json returns `skip`, never a guess.
 * Group config only: a session-level provider override applied at spawn is outside this scan.
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
    return { skip: `malformed container.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rawProvider =
    raw && typeof raw === 'object' && typeof (raw as { provider?: unknown }).provider === 'string'
      ? (raw as { provider: string }).provider
      : '';
  return { provider: (rawProvider || 'claude').toLowerCase() };
}

/** Every hop of a group's @-import chain is as untrusted as a top-level standing file. */
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
      // Missing target = a stale @-import, not a security issue: flattenClaudeMd reports it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    if (lst.isSymbolicLink()) {
      // Dangling and non-regular (e.g. FIFO) targets are unscannable: never read.
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
 * Codex/opencode read AGENTS.md alone; Claude walks CLAUDE.md's @-import chain plus any
 * CLAUDE.local.md. The flatten output is discarded: the call is made for its `validateRead` gate.
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

/** No banned-pattern scan here: the content was scanned at its source, and re-scanning would double-report. */
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

/** Each surface reports on its own files: a hit in a shared base file must not be re-reported per group. */
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

/** Pattern and unscannable breaches must not share a metric identity, or the issue-title dedup collapses them. */
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

    // A static tree check with no history: runs (and can file) even during warm-up.
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
