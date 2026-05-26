/**
 * Workgroup shared filesystem — "same house, own bedrooms".
 *
 * Consolidates each workgroup's shared directories out of the seed sibling's
 * group folder into a dedicated `data/workgroups/<workgroup_id>/` directory
 * that is bind-mounted into EVERY member's container at `/workspace/workgroup`
 * (container-runner). Each member keeps its private `/workspace/agent` (the
 * bedroom). See docs/specs/workgroup-shared-fs.md for the full design.
 *
 * Gated by the `WORKGROUP_SHARED_FS` flag (caller checks it). The migration is
 * the live-data move; it is idempotent (per-workgroup `.migrated` marker +
 * per-entry skip-if-exists), EXDEV-safe (rename within a filesystem, else
 * copy→verify→remove), reversible (the `.migrated` report records every move),
 * and conservative: it moves only PROVABLY-shareable dirs (top-level git repos
 * + `sources` + `conversations` + any dir a sibling already symlinks). Other
 * top-level dirs (and all loose files) are left in the seed bedroom and logged
 * as candidates for manual sharing — the migration never mis-moves an
 * ambiguous directory.
 *
 * After a move, the seed's old path and every sibling's old symlink become a
 * CONTAINER-ABSOLUTE compat symlink `<name> -> /workspace/workgroup/<name>`.
 * That dangles on the host (so container-runner's symlink-overlay skips it,
 * and the mnemon daemon must use the data/workgroups discovery root — handled
 * separately) but resolves correctly inside the container via the mount, so
 * existing `/workspace/agent/<name>` reader paths keep working with no repoint.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';

/** Host path of a workgroup's shared directory. */
export function workgroupSharedDir(workgroupId: string): string {
  return path.resolve(DATA_DIR, 'workgroups', workgroupId);
}

/** Container path the shared dir is mounted at. */
export const WORKGROUP_CONTAINER_PATH = '/workspace/workgroup';

interface MigrationReport {
  migratedAt: string;
  seedFolder: string;
  workgroupId: string;
  moved: string[];
  /** Real top-level dirs left in the bedroom — review for manual sharing. */
  candidates: string[];
  strategy: 'rename' | 'copy';
}

/**
 * Consolidate every workgroup's shared dirs into `data/workgroups/<id>/`.
 * Idempotent + fail-closed: a per-workgroup failure throws so the caller
 * (src/index.ts) can `process.exit(1)` rather than spawn containers against a
 * half-migrated tree. Runs at startup BEFORE any container spawns.
 */
export function reconcileWorkgroupSharedDirs(
  db: Database.Database,
  dirs: { groupsDir?: string; dataDir?: string } = {},
): void {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  for (const wg of workgroups) {
    migrateWorkgroup(db, wg.id, groupsDir, dataDir);
  }
}

function migrateWorkgroup(db: Database.Database, workgroupId: string, groupsDir: string, dataDir: string): void {
  const seedDir = path.join(groupsDir, workgroupId); // seed folder == workgroup_id
  if (!fs.existsSync(seedDir)) return; // no seed data to consolidate

  const wgDir = path.join(dataDir, 'workgroups', workgroupId);
  const markerPath = path.join(wgDir, '.migrated');
  if (fs.existsSync(markerPath)) return; // already migrated — idempotent no-op

  // Sibling folders in this workgroup (excluding the seed itself).
  const members = db.prepare(`SELECT folder FROM agent_groups WHERE workgroup_id = ?`).all(workgroupId) as Array<{
    folder: string;
  }>;
  const siblingFolders = members.map((m) => m.folder).filter((f) => f !== workgroupId);

  // ── Compute the shared set ────────────────────────────────────────────────
  const shared = new Set<string>();
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue; // dirs only, not symlinks
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue; // dotdirs/build
    const full = path.join(seedDir, entry.name);
    if (entry.name === 'sources' || entry.name === 'conversations' || isGitRepo(full)) {
      shared.add(entry.name);
    } else {
      candidates.push(entry.name);
    }
  }
  // Union in any dir a sibling already symlinks (the established shared set,
  // e.g. dbt/mr/wiki) as long as the seed has a real dir of that name.
  for (const sf of siblingFolders) {
    const sdir = path.join(groupsDir, sf);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue;
      const seedEntry = path.join(seedDir, e.name);
      if (isRealDir(seedEntry)) {
        shared.add(e.name);
        const ci = candidates.indexOf(e.name);
        if (ci >= 0) candidates.splice(ci, 1);
      }
    }
  }

  if (shared.size === 0) {
    log.info('reconcileWorkgroupSharedDirs: nothing to consolidate', { workgroupId });
    return;
  }

  // ── Choose move strategy (rename within a filesystem, else copy) ──────────
  fs.mkdirSync(wgDir, { recursive: true });
  const strategy: 'rename' | 'copy' = sameFilesystem(GROUPS_DIR, DATA_DIR) ? 'rename' : 'copy';

  log.info('reconcileWorkgroupSharedDirs: plan', {
    workgroupId,
    seedDir,
    wgDir,
    strategy,
    moving: [...shared].sort(),
    leftInBedroom: candidates.sort(),
    siblings: siblingFolders,
  });

  // ── Move each shared dir, then drop a container-absolute compat symlink ───
  const moved: string[] = [];
  for (const name of [...shared].sort()) {
    const src = path.join(seedDir, name);
    const dst = path.join(wgDir, name);
    if (fs.existsSync(dst)) {
      // Already in the shared dir (partial prior run) — just ensure the seed
      // compat symlink exists, then continue.
      ensureCompatSymlink(seedDir, name);
      moved.push(name);
      continue;
    }
    if (!isRealDir(src)) continue; // moved already / not a real dir — skip defensively

    if (strategy === 'rename') {
      fs.renameSync(src, dst);
    } else {
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      if (!fs.existsSync(dst)) throw new Error(`copy verify failed for ${src} -> ${dst}`);
      fs.rmSync(src, { recursive: true, force: true });
    }
    ensureCompatSymlink(seedDir, name);
    moved.push(name);
  }

  // ── Repoint every sibling's old symlink to the shared mount ───────────────
  for (const sf of siblingFolders) {
    const sdir = path.join(groupsDir, sf);
    if (!fs.existsSync(sdir)) continue;
    for (const name of moved) {
      const linkPath = path.join(sdir, name);
      const lst = lstatOrNull(linkPath);
      if (lst && !lst.isSymbolicLink()) {
        // Sibling has its OWN real entry at this name — never clobber it.
        log.warn('reconcileWorkgroupSharedDirs: sibling has a real entry, not overlaying', {
          workgroupId,
          sibling: sf,
          name,
        });
        continue;
      }
      if (lst) fs.unlinkSync(linkPath); // remove the now-broken relative symlink
      fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/${name}`, linkPath);
    }
  }

  // ── Write the marker + report (reversible record) ─────────────────────────
  const report: MigrationReport = {
    migratedAt: new Date().toISOString(),
    seedFolder: workgroupId,
    workgroupId,
    moved: moved.sort(),
    candidates: candidates.sort(),
    strategy,
  };
  fs.writeFileSync(markerPath, JSON.stringify(report, null, 2) + '\n');
  try {
    fs.mkdirSync('logs', { recursive: true });
    fs.appendFileSync(path.join('logs', 'migration-shared-dirs.log'), JSON.stringify(report) + '\n');
  } catch {
    /* report log is best-effort */
  }
  log.info('reconcileWorkgroupSharedDirs: migrated', { workgroupId, moved: report.moved });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

function isRealDir(p: string): boolean {
  const st = lstatOrNull(p);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Create (or replace) a container-absolute compat symlink at `<dir>/<name>`. */
function ensureCompatSymlink(dir: string, name: string): void {
  const linkPath = path.join(dir, name);
  const target = `${WORKGROUP_CONTAINER_PATH}/${name}`;
  const st = lstatOrNull(linkPath);
  if (st) {
    if (st.isSymbolicLink() && safeReadlink(linkPath) === target) return; // already correct
    if (st.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      // A real entry reappeared at the seed path — do not clobber.
      log.warn('reconcileWorkgroupSharedDirs: refusing to overwrite real seed entry with compat symlink', {
        dir,
        name,
      });
      return;
    }
  }
  fs.symlinkSync(target, linkPath);
}

function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/** True when two existing paths are on the same filesystem (rename is atomic). */
function sameFilesystem(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false; // unknown → assume different → caller uses the safe copy path
  }
}
