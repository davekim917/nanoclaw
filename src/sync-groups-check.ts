/**
 * Agent-runner-src drift check.
 *
 * Runs the /sync-groups inspect script twice daily (10pm + 7am America/New_York).
 * If any group's overlay is drifted from trunk, posts a report to
 * `SYNC_GROUPS_NOTIFY_JID` (falls back to `PLUGIN_UPDATE_NOTIFY_JID`) recommending
 * the operator run `/sync-groups mode:apply` in Discord.
 *
 * Does NOT auto-sync — the slash command is the write path. The check's
 * only job is surfacing drift so it doesn't silently accumulate.
 *
 * Uses Intl.DateTimeFormat to recompute ET each re-arm so DST transitions
 * are handled automatically without a tz library.
 *
 * Catch-up: if the host was down across a scheduled fire, the first run
 * after startup is triggered immediately when the persisted last-run marker
 * is >24h old. Prevents an unlucky restart from silently skipping a day.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { runInspect, formatInspectReport } from './sync-groups-runner.js';

const SCHEDULE_HOURS_ET = [7, 22] as const; // 7am + 10pm Eastern
const TZ = 'America/New_York';
const CATCHUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000; // 1min quiet period after host start before catch-up fires

function markerPath(): string {
  return path.join(DATA_DIR, '.sync-groups-check-last.json');
}

function readLastRun(): number | null {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8');
    const parsed = JSON.parse(raw) as { ts?: number };
    return typeof parsed.ts === 'number' ? parsed.ts : null;
  } catch {
    return null;
  }
}

function writeLastRun(ts: number): void {
  try {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify({ ts }) + '\n');
  } catch (err) {
    log.warn('sync-groups-check: failed to write last-run marker', { err });
  }
}

/**
 * Milliseconds until the next scheduled hour in the target timezone.
 * Returns 86400000 (24h) if the target hour equals the current ET hour
 * and minute — prevents a same-tick re-fire loop after runOnce returns.
 */
function msUntilNextSchedule(hoursEt: readonly number[]): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.format(now).split(':').map((p) => Number(p));
  const [h, m, s] = parts;
  const secondsNow = h * 3600 + m * 60 + s;
  let best = Number.POSITIVE_INFINITY;
  for (const target of hoursEt) {
    const targetSec = target * 3600;
    const delta = (targetSec - secondsNow + 86400) % 86400;
    const deltaMs = (delta === 0 ? 86400 : delta) * 1000;
    if (deltaMs < best) best = deltaMs;
  }
  return best;
}

export interface SyncGroupsCheckDeps {
  notify?: (platformId: string, text: string) => Promise<void>;
}

async function runOnce(deps: SyncGroupsCheckDeps): Promise<void> {
  let report;
  try {
    report = await runInspect();
  } catch (err) {
    log.warn('sync-groups-check: inspect failed', { err });
    return;
  }

  writeLastRun(Date.now());

  const totalDrifted = report.groups.reduce((sum, g) => sum + g.drifted.length, 0);
  if (totalDrifted === 0) {
    log.debug('sync-groups-check: all groups in sync');
    return;
  }

  const notifyJid = process.env.SYNC_GROUPS_NOTIFY_JID || process.env.PLUGIN_UPDATE_NOTIFY_JID;
  if (!notifyJid || !deps.notify) {
    log.info('sync-groups-check: drift detected but no notify JID configured', { totalDrifted });
    return;
  }

  const body = formatInspectReport(report, { includeRecommendation: true });
  const msg = `**Agent-runner drift detected** (${totalDrifted} file(s))\n\n${body}`;
  deps.notify(notifyJid, msg).catch((err) => {
    log.warn('sync-groups-check: notify failed', { err });
  });
}

let timeoutHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;
let stopped = false;

function scheduleNext(deps: SyncGroupsCheckDeps): void {
  if (stopped) return;
  const delay = msUntilNextSchedule(SCHEDULE_HOURS_ET);
  log.debug('sync-groups-check: next run scheduled', { delayMs: delay, delayHours: (delay / 3_600_000).toFixed(2) });
  timeoutHandle = setTimeout(async () => {
    timeoutHandle = null;
    try {
      await runOnce(deps);
    } catch (err) {
      log.error('sync-groups-check scheduled run failed', { err });
    }
    scheduleNext(deps);
  }, delay);
}

export function startSyncGroupsCheck(deps: SyncGroupsCheckDeps = {}): void {
  if (timeoutHandle || startupHandle || stopped) return;
  startupHandle = setTimeout(async () => {
    startupHandle = null;
    const last = readLastRun();
    if (last === null || Date.now() - last > CATCHUP_THRESHOLD_MS) {
      log.info('sync-groups-check: catch-up run (last run >24h ago or never)');
      try {
        await runOnce(deps);
      } catch (err) {
        log.error('sync-groups-check catch-up run failed', { err });
      }
    }
    scheduleNext(deps);
  }, STARTUP_DELAY_MS);
}

export function stopSyncGroupsCheck(): void {
  stopped = true;
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
}
