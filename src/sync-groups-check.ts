/**
 * Daily agent-runner-src drift check.
 *
 * Runs the /sync-groups inspect script once per day. If any group's overlay
 * is drifted from trunk, posts a report to `SYNC_GROUPS_NOTIFY_JID` (falls
 * back to `PLUGIN_UPDATE_NOTIFY_JID`) recommending the operator run
 * `/sync-groups mode:apply` in Discord.
 *
 * Does NOT auto-sync — the slash command is the write path. The check's
 * only job is surfacing drift so it doesn't silently accumulate.
 *
 * Modeled on plugin-updater.ts: setInterval + startup delay, fire-and-forget
 * notify callback injected at startup.
 */
import { log } from './log.js';
import { runInspect, formatInspectReport } from './sync-groups-runner.js';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const STARTUP_DELAY_MS = 10 * 60 * 1000; // 10min after host start

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

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startSyncGroupsCheck(deps: SyncGroupsCheckDeps = {}): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    runOnce(deps).catch((err) => log.error('sync-groups-check startup run failed', { err }));
  }, STARTUP_DELAY_MS);
  intervalHandle = setInterval(() => {
    runOnce(deps).catch((err) => log.error('sync-groups-check periodic run failed', { err }));
  }, INTERVAL_MS);
}

export function stopSyncGroupsCheck(): void {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
