/**
 * scripts/restore-session-mtimes.ts — one-off recovery for the 2026-08-15
 * migration burst.
 *
 * The startup pass that lazily migrates every session's `inbound.db` ran real
 * DDL against ~5,030 files in ninety seconds on 2026-08-15. Session reclaim
 * reads `max(newest file mtime, central last_active)` as the idle clock, so
 * every one of those sessions now reads as days old instead of months, and
 * archival has produced nothing since. The code fix (session-storage-health
 * C1) stops the next recurrence; it cannot recover the mtimes already lost.
 *
 * This script reconstructs a TRUTHFUL, deliberately conservative clock: for
 * each affected session it takes the newest surviving signal it did not touch
 * — `outbound.db` / `archive.db` / `central.db` / `.heartbeat` mtimes, or the
 * central DB's `COALESCE(last_active, created_at)` — and restores `inbound.db`
 * to that. Those were never mass-touched (outbound.db mtimes still span back
 * to April), so the result is never NEWER than the session's real activity and
 * never older than its newest surviving evidence.
 *
 * ORDERING IS LOAD-BEARING. Run this only after the capped archiver is
 * deployed and verified live. Against the uncapped code, handing ~5,800
 * suddenly-eligible sessions to a single sweep tick is a tar+rm stampede.
 *
 * Usage:
 *   tsx scripts/restore-session-mtimes.ts --dry-run [--window <ISO>[±<min>]]...
 *   tsx scripts/restore-session-mtimes.ts --execute --manifest <path>
 *
 * `--dry-run` only reads. `--execute` acts ONLY on entries whose inode and
 * mtime still match the manifest, writes a preimage manifest before touching
 * anything, and is a no-op on rerun.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { tryRunWithStorageCleanupClaim } from '../src/storage-activity.js';
import { sessionHasOpenWork } from '../src/storage-manager.js';

/** The observed burst: 2,102 files at 20:21Z and 2,925 at 20:22Z, install TZ UTC. */
export const DEFAULT_BURST_WINDOW = { centerIso: '2026-08-15T20:21:00.000Z', radiusMinutes: 10 };

/** Signals the migration pass never wrote, newest-first preference is by mtime. */
const SIGNAL_FILES = ['outbound.db', 'archive.db', 'central.db', '.heartbeat'] as const;
const ACTIVE_MARKER_DIR = '.nanoclaw-storage-active';

export interface BurstWindow {
  label: string;
  startMs: number;
  endMs: number;
}

export interface RestoreEntry {
  sessionId: string;
  agentGroupId: string;
  inboundPath: string;
  inode: number;
  currentMtimeMs: number;
  restoreMtimeMs: number;
  /** Which surviving signal supplied `restoreMtimeMs`. */
  provenance: string;
}

export type SkipReason =
  | 'outside-burst-window'
  | 'central-row-missing'
  | 'central-activity-after-burst'
  | 'container-active'
  | 'open-work'
  | 'unreadable-session'
  | 'no-older-signal';

export interface RestoreManifest {
  generatedAt: string;
  dataDir: string;
  windows: BurstWindow[];
  entries: RestoreEntry[];
  skipped: Array<{ sessionId: string; reason: SkipReason }>;
}

export interface PreimageManifest {
  appliedAt: string;
  sourceManifest: string;
  entries: Array<{ sessionId: string; inboundPath: string; inode: number; mtimeMs: number }>;
}

export function parseWindow(spec: string): BurstWindow {
  const match = /^(.+?)(?:[±+]([0-9]+))?$/.exec(spec.trim());
  const iso = match?.[1]?.trim() ?? spec.trim();
  const radiusMinutes = match?.[2] ? Number(match[2]) : DEFAULT_BURST_WINDOW.radiusMinutes;
  const centerMs = Date.parse(iso);
  if (!Number.isFinite(centerMs)) throw new Error(`unparseable window center: ${spec}`);
  if (!Number.isFinite(radiusMinutes) || radiusMinutes <= 0) throw new Error(`bad window radius: ${spec}`);
  const radiusMs = radiusMinutes * 60 * 1000;
  return { label: `${iso}±${radiusMinutes}m`, startMs: centerMs - radiusMs, endMs: centerMs + radiusMs };
}

/** The window this mtime falls in, or null. Each window carries its own bound. */
function matchWindow(mtimeMs: number, windows: BurstWindow[]): BurstWindow | null {
  return windows.find((window) => mtimeMs >= window.startMs && mtimeMs <= window.endMs) ?? null;
}

function parseSqliteUtc(value: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

function mtimeOf(target: string): number | null {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The newest evidence of real activity that ISN'T the file the migration
 * bumped. Newest, not oldest: reclaim must never act on a clock that claims
 * more idleness than the session can prove.
 */
export function chooseRestoreTarget(
  sessPath: string,
  centralActivityMs: number | null,
): { mtimeMs: number; provenance: string } | null {
  let best: { mtimeMs: number; provenance: string } | null = null;
  for (const name of SIGNAL_FILES) {
    const mtimeMs = mtimeOf(path.join(sessPath, name));
    if (mtimeMs === null) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, provenance: name };
  }
  if (centralActivityMs !== null && Number.isFinite(centralActivityMs)) {
    if (!best || centralActivityMs > best.mtimeMs)
      best = { mtimeMs: centralActivityMs, provenance: 'central:last_active' };
  }
  return best;
}

function hasActivityMarker(sessPath: string): boolean {
  try {
    return fs.readdirSync(path.join(sessPath, ACTIVE_MARKER_DIR)).length > 0;
  } catch {
    return false;
  }
}

export function planRestore(options: {
  dataDir?: string;
  windows: BurstWindow[];
  centralDb: Database.Database;
}): RestoreManifest {
  const dataDir = options.dataDir ?? DATA_DIR;
  const sessionsRoot = path.join(dataDir, 'v2-sessions');
  const entries: RestoreEntry[] = [];
  const skipped: RestoreManifest['skipped'] = [];
  const centralRow = options.centralDb.prepare(
    'SELECT status, COALESCE(last_active, created_at) AS last_activity FROM sessions WHERE id = ?',
  );

  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { generatedAt: new Date().toISOString(), dataDir, windows: options.windows, entries, skipped };
  }

  for (const group of groups) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue;
    const groupPath = path.join(sessionsRoot, group.name);
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const session of sessions) {
      if (!session.isDirectory() || session.isSymbolicLink()) continue;
      if (!session.name.startsWith('sess-')) continue;
      const sessionId = session.name;
      const sessPath = path.join(groupPath, sessionId);
      const inboundPath = path.join(sessPath, 'inbound.db');

      let stat: fs.Stats;
      try {
        stat = fs.statSync(inboundPath);
      } catch {
        continue;
      }
      // Bound against THIS mtime's own window. With two disjoint windows a
      // shared minimum would reject a session whose activity predates its own
      // burst but follows the earlier one.
      const window = matchWindow(stat.mtimeMs, options.windows);
      if (!window) continue;

      const row = centralRow.get(sessionId) as { status: string; last_activity: string | null } | undefined;
      if (!row) {
        skipped.push({ sessionId, reason: 'central-row-missing' });
        continue;
      }
      const centralActivityMs = row.last_activity ? parseSqliteUtc(row.last_activity) : NaN;
      // The whole premise: the central DB says this session was already idle
      // BEFORE the burst, so the bumped file mtime is the migration's, not the
      // session's.
      if (!Number.isFinite(centralActivityMs) || centralActivityMs >= window.startMs) {
        skipped.push({ sessionId, reason: 'central-activity-after-burst' });
        continue;
      }
      if (hasActivityMarker(sessPath)) {
        skipped.push({ sessionId, reason: 'container-active' });
        continue;
      }
      const busy = sessionHasOpenWork(group.name, sessionId, sessPath);
      if (busy === null) {
        skipped.push({ sessionId, reason: 'unreadable-session' });
        continue;
      }
      if (busy) {
        skipped.push({ sessionId, reason: 'open-work' });
        continue;
      }

      const target = chooseRestoreTarget(sessPath, centralActivityMs);
      if (!target || target.mtimeMs >= stat.mtimeMs) {
        skipped.push({ sessionId, reason: 'no-older-signal' });
        continue;
      }

      entries.push({
        sessionId,
        agentGroupId: group.name,
        inboundPath,
        inode: stat.ino,
        currentMtimeMs: stat.mtimeMs,
        restoreMtimeMs: target.mtimeMs,
        provenance: target.provenance,
      });
    }
  }

  return { generatedAt: new Date().toISOString(), dataDir, windows: options.windows, entries, skipped };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Rebuild the path from validated components under the manifest's own data
 * root, then require it to still be that path after realpath. A manifest is an
 * editable JSON file on disk; its `inboundPath` string is a hint, not authority.
 */
export function resolveEntryPath(dataDir: string, entry: RestoreEntry): string | null {
  if (!SAFE_ID.test(entry.agentGroupId) || !SAFE_ID.test(entry.sessionId)) return null;
  const sessPath = path.join(dataDir, 'v2-sessions', entry.agentGroupId, entry.sessionId);
  const inboundPath = path.join(sessPath, 'inbound.db');
  let realSessions: string;
  let realSess: string;
  try {
    realSessions = fs.realpathSync(path.join(dataDir, 'v2-sessions'));
    realSess = fs.realpathSync(sessPath);
  } catch (err) {
    // A session archived between the dry-run and now is absent, not unsafe —
    // the caller's lstat reports it as missing.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return inboundPath;
    return null;
  }
  const relative = path.relative(realSessions, realSess);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return inboundPath;
}

function writeJsonFsynced(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Never overwrite an existing preimage — it is somebody's only way back. */
function writeNewJsonFsynced(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(target, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite an existing preimage manifest: ${target}`, { cause: err });
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readManifest(manifestPath: string): RestoreManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RestoreManifest;
}

export interface ExecuteResult {
  restored: number;
  alreadyRestored: number;
  changed: number;
  missing: number;
  claimBusy: number;
  unsafePath: number;
  preimagePath: string;
}

/**
 * Apply a manifest. Every entry is pinned by inode AND mtime, so anything that
 * moved since the dry-run is reported rather than acted on, and a rerun after a
 * successful pass is a no-op. The utimes happens inside the same exclusive
 * cleanup claim the storage manager takes, so a concurrent archival of that
 * session cannot interleave.
 */
export function executeRestore(manifestPath: string, preimagePath?: string): ExecuteResult {
  const manifest = readManifest(manifestPath);
  const actionable: Array<{ entry: RestoreEntry; path: string }> = [];
  const result: ExecuteResult = {
    restored: 0,
    alreadyRestored: 0,
    changed: 0,
    missing: 0,
    claimBusy: 0,
    unsafePath: 0,
    // A preimage is the record of what a PARTICULAR run overwrote. Deriving it
    // from the manifest name meant a rerun truncated the real one.
    preimagePath: preimagePath ?? `${manifestPath.replace(/\.json$/, '')}.preimage.${Date.now()}.json`,
  };

  for (const entry of manifest.entries) {
    const safePath = resolveEntryPath(manifest.dataDir, entry);
    if (!safePath) {
      result.unsafePath += 1;
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(safePath);
    } catch {
      result.missing += 1;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.unsafePath += 1;
      continue;
    }
    if (stat.mtimeMs === entry.restoreMtimeMs) {
      result.alreadyRestored += 1;
      continue;
    }
    if (stat.ino !== entry.inode || stat.mtimeMs !== entry.currentMtimeMs) {
      result.changed += 1;
      continue;
    }
    actionable.push({ entry, path: safePath });
  }

  // Preimage BEFORE the first utimes — the exact restoration path back.
  const preimage: PreimageManifest = {
    appliedAt: new Date().toISOString(),
    sourceManifest: path.resolve(manifestPath),
    entries: actionable.map(({ entry }) => ({
      sessionId: entry.sessionId,
      inboundPath: entry.inboundPath,
      inode: entry.inode,
      mtimeMs: entry.currentMtimeMs,
    })),
  };
  writeNewJsonFsynced(result.preimagePath, preimage);

  for (const { entry, path: inboundPath } of actionable) {
    const claimed = tryRunWithStorageCleanupClaim(path.dirname(inboundPath), () => {
      // O_NOFOLLOW + futimes: the check and the write land on the same inode,
      // so nothing can swap a symlink in between them.
      let fd: number;
      try {
        fd = fs.openSync(inboundPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch {
        result.unsafePath += 1;
        return;
      }
      try {
        const current = fs.fstatSync(fd);
        if (current.ino !== entry.inode || current.mtimeMs !== entry.currentMtimeMs) {
          result.changed += 1;
          return;
        }
        const seconds = entry.restoreMtimeMs / 1000;
        fs.futimesSync(fd, seconds, seconds);
        result.restored += 1;
      } finally {
        fs.closeSync(fd);
      }
    });
    if (!claimed) result.claimBusy += 1;
  }

  return result;
}

function summarize(manifest: RestoreManifest): string {
  const byReason = new Map<SkipReason, number>();
  for (const skip of manifest.skipped) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
  const byProvenance = new Map<string, number>();
  for (const entry of manifest.entries) {
    byProvenance.set(entry.provenance, (byProvenance.get(entry.provenance) ?? 0) + 1);
  }
  const ages = manifest.entries.map((entry) => entry.restoreMtimeMs).sort((a, b) => a - b);
  const lines = [
    `windows: ${manifest.windows.map((window) => window.label).join(', ')}`,
    `selected: ${manifest.entries.length}`,
    ...[...byProvenance.entries()].sort().map(([source, count]) => `  provenance ${source}: ${count}`),
    `skipped: ${manifest.skipped.length}`,
    ...[...byReason.entries()].sort().map(([reason, count]) => `  ${reason}: ${count}`),
  ];
  if (ages.length > 0) {
    lines.push(
      `restored-clock range: ${new Date(ages[0]!).toISOString()} .. ${new Date(ages[ages.length - 1]!).toISOString()}`,
    );
  }
  return lines.join('\n');
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  tsx scripts/restore-session-mtimes.ts --dry-run [--window <ISO>[±<minutes>]]... [--out <path>]',
      '  tsx scripts/restore-session-mtimes.ts --execute --manifest <path> [--preimage <path>]',
      '',
      'Run --execute ONLY after the capped archiver is deployed and verified live.',
    ].join('\n'),
  );
  process.exit(2);
}

export function runCli(argv = process.argv.slice(2)): void {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const windowSpecs = argv.reduce<string[]>((acc, arg, index) => {
    if (arg === '--window' && argv[index + 1]) acc.push(argv[index + 1]!);
    return acc;
  }, []);

  if (argv.includes('--dry-run')) {
    const windows =
      windowSpecs.length > 0
        ? windowSpecs.map(parseWindow)
        : [parseWindow(`${DEFAULT_BURST_WINDOW.centerIso}±${DEFAULT_BURST_WINDOW.radiusMinutes}`)];
    const centralDb = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
    try {
      const manifest = planRestore({ windows, centralDb });
      const out = flag('out') ?? path.join(DATA_DIR, `restore-session-mtimes-${Date.now()}.json`);
      writeJsonFsynced(out, manifest);
      console.log(summarize(manifest));
      console.log(`manifest: ${out}`);
    } finally {
      centralDb.close();
    }
    return;
  }

  if (argv.includes('--execute')) {
    const manifestPath = flag('manifest');
    if (!manifestPath) usage();
    const result = executeRestore(manifestPath, flag('preimage'));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
