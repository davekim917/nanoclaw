#!/usr/bin/env -S pnpm exec tsx
/**
 * scripts/host-health.ts — quick observability snapshot for the running host.
 *
 * Run after a host restart (or any time) to spot the four ghost-cycle
 * signals that the host-sweep age-out and spawn-grace logic is designed to
 * keep at zero:
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
import { LOG_STAMP_RE, parseLogStamp } from '../src/log.js';

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
 * Boot wallclock from systemd. Returns epoch-ms of the current
 * nanoclaw-v2 service start, or null if unavailable. Used as the
 * "since restart" cutoff for log filtering — robust to log files that
 * span multiple days where lexical compare on `[HH:MM:SS.mmm]` prefixes
 * would conflate yesterday's 23:58 with today's 23:58.
 */
function hostBootEpochMs(): number | null {
  try {
    const out = execSync('systemctl show -p ActiveEnterTimestamp --value nanoclaw-v2', { encoding: 'utf-8' });
    const started = Date.parse(out.trim());
    return Number.isNaN(started) ? null : started;
  } catch {
    return null;
  }
}

function hostUptimeSec(bootMs: number | null): number | null {
  return bootMs === null ? null : Math.floor((Date.now() - bootMs) / 1000);
}

/**
 * Iterate matching lines in `logPath` BACKWARDS until we cross the
 * `cutoffMs` boundary. Each visited line is mapped to a wallclock by
 * parsing its `[YYYY-MM-DD HH:MM:SS.mmm]` prefix directly — the date is
 * embedded per line, so no midnight-crossing reconstruction is needed.
 * Callback returns false to stop early.
 *
 * Assumes the log is the server-local TZ — both this script and the host
 * log writer pull time-of-day from the same Node process TZ.
 */
function walkLinesBackToCutoff(
  logPath: string,
  cutoffMs: number,
  onLine: (line: string, ts: number) => void,
): { sawInexact: boolean } {
  if (!existsSync(logPath)) return { sawInexact: false };
  const lines = readFileSync(logPath, 'utf-8').split('\n');
  let sawInexact = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(LOG_STAMP_RE);
    if (!m) {
      // continuation line, or a pre-upgrade line without a date prefix —
      // attribute to most-recently-seen timestamp (not counted toward cutoff)
      continue;
    }
    // `cutoffMs` comes from systemd's UTC boot stamp, so the line's instant
    // has to be absolute too. Rebuilding it from local getters (what this did
    // before) is off by the host process's UTC offset whenever the logger's
    // zone differs from this script's — `TZ=America/New_York` in the unit vs
    // a UTC `/etc/localtime` here — which pushed every line below the cutoff
    // and ended the walk on its first iteration. The counters then read 0 for
    // events that had in fact occurred (5 ceiling kills, 101 expired-pending
    // on 2026-09-22), and a zero is indistinguishable from a healthy host.
    const parsed = parseLogStamp(m[1], m[2]);
    if (!parsed) continue;
    if (!parsed.exact) sawInexact = true;
    if (parsed.ms < cutoffMs) return { sawInexact };
    onLine(line, parsed.ms);
  }
  return { sawInexact };
}

/**
 * Count matching lines since boot.
 *
 * `inexact` is not cosmetic. Lines written before src/log.ts started stamping
 * a UTC offset carry only local wall-clock, so their instant is reconstructed
 * in THIS process's zone. When the logger ran in a different one — the unit
 * sets `TZ=America/New_York` against a UTC `/etc/localtime` — every line lands
 * hours early, drops below `bootMs`, and ends the backward walk on its first
 * iteration. The count then reads 0 for events that did occur (on 2026-09-22:
 * 5 ceiling kills and 101 expired-pending reported as 0/0). A zero that cannot
 * be trusted must not be printed as a clean zero, so callers render the caveat.
 */
function countSinceBoot(
  logPath: string,
  pattern: RegExp,
  bootMs: number | null,
): { n: number; inexact: boolean } {
  if (bootMs === null) return { n: -1, inexact: false };
  if (!existsSync(logPath)) return { n: -1, inexact: false };
  let n = 0;
  const { sawInexact } = walkLinesBackToCutoff(logPath, bootMs, (line) => {
    if (pattern.test(line)) n++;
  });
  return { n, inexact: sawInexact };
}

/**
 * Identify message_ids in `Killing container — message claimed then silent`
 * warnings that appear more than `repeatThreshold` times since boot.
 * Repeated kills against the same id indicate a stuck claim that never
 * clears (the old task-plugin-updater pattern).
 */
function stuckClaimHotspots(
  repeatThreshold: number,
  bootMs: number | null,
): Array<{ messageId: string; count: number }> {
  if (bootMs === null) return [];
  const counts = new Map<string, number>();
  const idRe = /messageId[^=]*="([^"]+)"/g;
  walkLinesBackToCutoff(LOG_ERROR, bootMs, (line) => {
    if (!line.includes('claimed then silent')) return;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(line)) !== null) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  });
  return [...counts.entries()]
    .filter(([, n]) => n >= repeatThreshold)
    .map(([messageId, count]) => ({ messageId, count }))
    .sort((a, b) => b.count - a.count);
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
const bootMs = hostBootEpochMs();
const waitDeferred = countSinceBoot(LOG_ERROR, /wake deferred/, bootMs);
const ceilingKills = countSinceBoot(LOG_ERROR, /past absolute ceiling/, bootMs);
const expiredEvents = countSinceBoot(LOG_INFO, /Expired stale pending/, bootMs);
const stuck = stuckClaimHotspots(3, bootMs);
const uptime = hostUptimeSec(bootMs);

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
/** A clean tick is only earned by a zero the stamps can actually support. */
function fmtSinceBoot(c: { n: number; inexact: boolean }, tickOnZero = true): string {
  const body = fmtCount(c.n);
  if (c.inexact) return `${body} (unverified — pre-offset stamps)`;
  if (!tickOnZero) return body;
  return `${body} ${c.n === 0 ? '✓' : '⚠'}`;
}

console.log('  wake-deferred warnings:                     ', fmtSinceBoot(waitDeferred));
console.log('  absolute-ceiling kills:                     ', fmtSinceBoot(ceilingKills));
console.log('  expired-pending events:                     ', fmtSinceBoot(expiredEvents, false));
if (waitDeferred.inexact || ceilingKills.inexact || expiredEvents.inexact) {
  console.log(
    '\n  ⚠ Some log lines in this window predate the UTC-offset stamp, so their\n' +
      '    instant was reconstructed in this process\'s zone and the counts above\n' +
      '    may be low (possibly 0 when events did occur). Resolved for lines\n' +
      '    written after the next host restart.',
  );
}
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
