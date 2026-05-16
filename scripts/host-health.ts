#!/usr/bin/env -S pnpm exec tsx
/**
 * scripts/host-health.ts — quick observability snapshot for the running host.
 *
 * Run after a host restart (or any time) to spot the four ghost-cycle
 * signals that the host-sweep age-out + spawn-grace fixes (PRs #86 / #87)
 * are designed to keep at zero:
 *
 *   1. docker container count vs DB-claimed-running count    (should match)
 *   2. wake deferrals since last restart                      (should be 0)
 *   3. absolute-ceiling kills since last restart              (should be 0)
 *   4. stuck-claim warnings repeating against same message_id (should be empty)
 *
 * Plus two diagnostic counters:
 *
 *   - expired-pending events since restart  (small healthy steady-state, large = recurring wake-failure)
 *   - oldest claimed-running session         (if DB count > docker count, this is the phantom)
 *
 * Usage:
 *   pnpm exec tsx scripts/host-health.ts
 */
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CENTRAL_DB = join(process.cwd(), 'data', 'v2.db');
const LOG_INFO = join(process.cwd(), 'logs', 'nanoclaw.log');
const LOG_ERROR = join(process.cwd(), 'logs', 'nanoclaw.error.log');

function dockerSessionCount(): number {
  try {
    const out = execSync("docker ps --filter label=nanoclaw-install --format '{{.Names}}' | wc -l", {
      encoding: 'utf-8',
    });
    return Number(out.trim());
  } catch {
    return -1;
  }
}

function dbRunningCount(): { count: number; oldest?: { id: string; lastActive: string | null } } {
  if (!existsSync(CENTRAL_DB)) return { count: -1 };
  const db = new Database(CENTRAL_DB, { readonly: true });
  try {
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE container_status='running'").get() as { n: number }
    ).n;
    const oldest = db
      .prepare("SELECT id, last_active FROM sessions WHERE container_status='running' ORDER BY last_active ASC LIMIT 1")
      .get() as { id: string; last_active: string | null } | undefined;
    return { count, oldest: oldest ? { id: oldest.id, lastActive: oldest.last_active } : undefined };
  } finally {
    db.close();
  }
}

/**
 * The "Host sweep started" marker line appears in nanoclaw.log every time
 * `startHostSweep()` runs (i.e., on every host start). Find its timestamp
 * once, then reuse it as the cutoff for any log file. Returns null if the
 * info log is missing or has no marker (e.g., older host that didn't emit
 * this line).
 *
 * Format: `[HH:MM:SS.mmm] ...` — host log timestamps are in local TZ,
 * lexicographic compare is reliable within a single calendar day.
 */
function findLastRestartTimestamp(): string | null {
  if (!existsSync(LOG_INFO)) return null;
  const lines = readFileSync(LOG_INFO, 'utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('Host sweep started')) continue;
    const m = lines[i].match(/^\[(\d{2}:\d{2}:\d{2}\.\d+)\]/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Count lines in `logPath` matching `pattern` whose `[HH:MM:SS.mmm]`
 * prefix is >= `cutoffTs`. Returns -1 if the file is missing.
 *
 * Lines without a timestamp prefix (stack-trace continuations) are
 * counted only if the most recent timestamped line is past the cutoff —
 * tracks the same source event.
 */
function countSinceRestart(logPath: string, pattern: RegExp, cutoffTs: string): number {
  if (!existsSync(logPath)) return -1;
  const lines = readFileSync(logPath, 'utf-8').split('\n');
  let inWindow = false;
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d+)\]/);
    if (m) inWindow = m[1] >= cutoffTs;
    if (inWindow && pattern.test(line)) n++;
  }
  return n;
}

/**
 * Identify message_ids in `Killing container — message claimed then silent`
 * warnings that appear more than `repeatThreshold` times since the cutoff.
 * Repeated kills against the same id indicate a stuck claim that never
 * clears (the old task-plugin-updater pattern).
 */
function stuckClaimHotspots(
  repeatThreshold: number,
  cutoffTs: string | null,
): Array<{ messageId: string; count: number }> {
  if (!existsSync(LOG_ERROR)) return [];
  const lines = readFileSync(LOG_ERROR, 'utf-8').split('\n');
  const counts = new Map<string, number>();
  const re = /messageId[^=]*="([^"]+)"/g;
  let inWindow = cutoffTs === null;
  for (const line of lines) {
    if (cutoffTs !== null) {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d+)\]/);
      if (m) inWindow = m[1] >= cutoffTs;
    }
    if (!inWindow) continue;
    if (!line.includes('claimed then silent')) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= repeatThreshold)
    .map(([messageId, count]) => ({ messageId, count }))
    .sort((a, b) => b.count - a.count);
}

function hostUptimeSec(): number | null {
  try {
    const out = execSync('systemctl show -p ActiveEnterTimestamp --value nanoclaw-v2', { encoding: 'utf-8' });
    const started = Date.parse(out.trim());
    if (Number.isNaN(started)) return null;
    return Math.floor((Date.now() - started) / 1000);
  } catch {
    return null;
  }
}

function fmtCount(n: number): string {
  if (n < 0) return '(unknown)';
  return String(n);
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '(unknown)';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const dockerCount = dockerSessionCount();
const { count: dbCount, oldest } = dbRunningCount();
const restartTs = findLastRestartTimestamp();
const waitDeferred = restartTs ? countSinceRestart(LOG_ERROR, /wake deferred/, restartTs) : -1;
const ceilingKills = restartTs ? countSinceRestart(LOG_ERROR, /past absolute ceiling/, restartTs) : -1;
const expiredEvents = restartTs ? countSinceRestart(LOG_INFO, /Expired stale pending/, restartTs) : -1;
const stuck = stuckClaimHotspots(3, restartTs);
const uptime = hostUptimeSec();

const drift = dockerCount >= 0 && dbCount >= 0 ? dockerCount - dbCount : null;

console.log('Host uptime:                                  ', fmtDuration(uptime));
console.log('Docker containers (label=nanoclaw-install):  ', fmtCount(dockerCount));
console.log("DB sessions where container_status='running': ", fmtCount(dbCount));
console.log(
  '  → drift (docker − db):                       ',
  drift === null ? '(unknown)' : drift === 0 ? '0 ✓' : `${drift} ⚠`,
);
if (oldest && dbCount > 0) {
  console.log(`  → oldest DB-running session:                  ${oldest.id} (last_active=${oldest.lastActive ?? '?'})`);
}
console.log('');
console.log('Since last restart:');
console.log('  wake-deferred warnings:                     ', fmtCount(waitDeferred), waitDeferred === 0 ? '✓' : '⚠');
console.log('  absolute-ceiling kills:                     ', fmtCount(ceilingKills), ceilingKills === 0 ? '✓' : '⚠');
console.log('  expired-pending events:                     ', fmtCount(expiredEvents));
console.log('');
console.log(`Stuck-claim hotspots (same message_id ≥3 times in error log):`);
if (stuck.length === 0) {
  console.log('  (none) ✓');
} else {
  for (const { messageId, count } of stuck.slice(0, 5)) {
    console.log(`  ${count.toString().padStart(5)}  ${messageId}`);
  }
  if (stuck.length > 5) console.log(`  ...${stuck.length - 5} more`);
}
