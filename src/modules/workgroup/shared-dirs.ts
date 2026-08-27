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
 * while host tooling reads the canonical data/workgroups root directly) but
 * resolves correctly inside the container via the mount, so
 * existing `/workspace/agent/<name>` reader paths keep working with no repoint.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';

/** Host path of a workgroup's shared directory. */
export function workgroupSharedDir(workgroupId: string, dataDir: string = DATA_DIR): string {
  return path.resolve(dataDir, 'workgroups', workgroupId);
}

/** Container path the shared dir is mounted at. */
export const WORKGROUP_CONTAINER_PATH = '/workspace/workgroup';
export const WORKGROUP_MEMORY_CONTAINER_PATH = `${WORKGROUP_CONTAINER_PATH}/memory`;

export interface InventoriedSource {
  groupId: string;
  folder: string;
  path: string;
  type: 'missing' | 'directory' | 'symlink' | 'file' | 'unsupported';
  size: number;
  linkTarget?: string;
}

export type WorkgroupMemoryState =
  | { status: 'canonical'; basis: 'exact-links-and-canon' | 'verified-manifest' }
  | { status: 'exact-empty' }
  | { status: 'migration-required'; sources: InventoriedSource[] };

export interface WorkgroupMemoryReport {
  workgroupId: string;
  state: WorkgroupMemoryState;
  changed: boolean;
}

export interface WorkgroupMemoryDirs {
  groupsDir?: string;
  dataDir?: string;
  workgroupIds?: string[];
}

const MEMORY_MANIFEST = '.memory-migration.json';
// Canonical memory has its own lossless inventory/migration/reconciliation
// lifecycle below. The older generic shared-directory migrator must never move,
// adopt, repoint, or report this name, even during crash recovery.
const RESERVED_SHARED_DIR_NAMES = new Set(['memory']);
const MEMORY_TEMPLATES_DIR = fileURLToPath(
  new URL('../../../container/agent-runner/src/memory/templates/', import.meta.url),
);

function assertTrustedPathSegment(value: string, label: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

/** Canonical host path. Container-only compatibility links must never be dereferenced by host tools. */
export function workgroupMemoryDir(workgroupId: string, dataDir: string = DATA_DIR): string {
  assertTrustedPathSegment(workgroupId, 'workgroup id');
  return path.resolve(dataDir, 'workgroups', workgroupId, 'memory');
}

export function workgroupMemoryManifestPath(workgroupId: string, dataDir: string = DATA_DIR): string {
  return path.join(path.dirname(workgroupMemoryDir(workgroupId, dataDir)), MEMORY_MANIFEST);
}

export function memoryTreeSha256(root: string): string {
  const hash = createHash('sha256');
  const visit = (absolute: string, relative: string): void => {
    const st = fs.lstatSync(absolute);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      hash.update(`symlink\0${relative}\0${Buffer.byteLength(target)}\0${target}\n`);
      return;
    }
    if (st.isFile()) {
      const bytes = fs.readFileSync(absolute);
      hash.update(`file\0${relative}\0${bytes.length}\0`);
      hash.update(bytes);
      hash.update('\n');
      return;
    }
    if (!st.isDirectory()) {
      hash.update(`unsupported\0${relative}\0${st.mode}\0${st.size}\n`);
      return;
    }
    hash.update(`directory\0${relative}\n`);
    for (const child of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

function memoryMembers(db: Database.Database, workgroupId: string): Array<{ id: string; folder: string }> {
  return db
    .prepare(`SELECT id, folder FROM agent_groups WHERE workgroup_id = ? ORDER BY folder, id`)
    .all(workgroupId) as Array<{ id: string; folder: string }>;
}

function sourceFor(group: { id: string; folder: string }, groupsDir: string): InventoriedSource {
  assertTrustedPathSegment(group.folder, 'agent group folder');
  const sourcePath = path.join(groupsDir, group.folder, 'memory');
  const st = lstatOrNull(sourcePath);
  if (!st) {
    return { groupId: group.id, folder: group.folder, path: sourcePath, type: 'missing', size: 0 };
  }
  if (st.isSymbolicLink()) {
    return {
      groupId: group.id,
      folder: group.folder,
      path: sourcePath,
      type: 'symlink',
      size: st.size,
      linkTarget: safeReadlink(sourcePath) ?? undefined,
    };
  }
  if (st.isDirectory()) {
    return { groupId: group.id, folder: group.folder, path: sourcePath, type: 'directory', size: st.size };
  }
  if (st.isFile()) {
    return { groupId: group.id, folder: group.folder, path: sourcePath, type: 'file', size: st.size };
  }
  return { groupId: group.id, folder: group.folder, path: sourcePath, type: 'unsupported', size: st.size };
}

function sameTreeExact(actual: string, expected: string): boolean {
  let actualEntries: fs.Dirent[];
  let expectedEntries: fs.Dirent[];
  try {
    actualEntries = fs.readdirSync(actual, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    expectedEntries = fs.readdirSync(expected, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
  if (actualEntries.length !== expectedEntries.length) return false;
  for (let i = 0; i < expectedEntries.length; i++) {
    const a = actualEntries[i];
    const e = expectedEntries[i];
    if (a.name !== e.name || a.isDirectory() !== e.isDirectory() || a.isFile() !== e.isFile()) return false;
    const actualPath = path.join(actual, a.name);
    const expectedPath = path.join(expected, e.name);
    if (e.isDirectory()) {
      if (!sameTreeExact(actualPath, expectedPath)) return false;
    } else if (e.isFile()) {
      if (!fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function isExactShippedMemoryScaffold(memoryPath: string): boolean {
  const st = lstatOrNull(memoryPath);
  return !!st && st.isDirectory() && !st.isSymbolicLink() && sameTreeExact(memoryPath, MEMORY_TEMPLATES_DIR);
}

/**
 * Prepare one member's view of canonical memory.
 *
 * This is the only policy seam that may create a missing canon or replace an
 * exact shipped scaffold with the container-absolute compatibility link.
 * Substantive or ambiguous paths always require the operator migration.
 */
export function prepareWorkgroupMemoryMember(
  member: { id: string; folder: string },
  workgroupId: string,
  dirs: { groupsDir?: string; dataDir?: string } = {},
): { canonicalPath: string; changed: boolean } {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  assertTrustedPathSegment(member.folder, 'agent group folder');
  const canonicalPath = workgroupMemoryDir(workgroupId, dataDir);
  const local = path.join(groupsDir, member.folder, 'memory');
  const canonicalStat = lstatOrNull(canonicalPath);
  const localStat = lstatOrNull(local);

  if (canonicalStat && (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink())) {
    throw new Error(`workgroup memory migration-required: canonical path is not a real directory: ${canonicalPath}`);
  }

  const exactLink = localStat?.isSymbolicLink() === true && safeReadlink(local) === WORKGROUP_MEMORY_CONTAINER_PATH;
  const exactScaffold = localStat?.isDirectory() === true && isExactShippedMemoryScaffold(local);
  if (localStat && !exactLink && !exactScaffold) {
    throw new Error(`workgroup memory migration-required: substantive provider-local path: ${local}`);
  }
  if (exactLink && !canonicalStat) {
    throw new Error(`workgroup memory migration-required: compatibility link has no real canon: ${local}`);
  }

  let changed = false;
  if (!canonicalStat) {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    if (exactScaffold) {
      fs.cpSync(local, canonicalPath, { recursive: true, errorOnExist: true, force: false });
    } else {
      fs.mkdirSync(canonicalPath);
    }
    changed = true;
  }

  if (!exactLink) {
    if (exactScaffold) fs.rmSync(local, { recursive: true });
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, local);
    changed = true;
  }
  // Per-person preference files live here; write_memory_file cannot create
  // parent directories, so the host provisions the folder for every workgroup.
  const preferencesDir = path.join(canonicalPath, 'preferences');
  if (!lstatOrNull(preferencesDir)) {
    fs.mkdirSync(preferencesDir);
    changed = true;
  }
  return { canonicalPath, changed };
}

function hasVerifiedManifest(workgroupId: string, dataDir: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(workgroupMemoryManifestPath(workgroupId, dataDir), 'utf8')) as {
      version?: number;
      workgroupId?: string;
      status?: string;
      reportPath?: string;
      snapshotDir?: string;
      canonicalSha256?: string;
    };
    return (
      manifest.version === 1 &&
      manifest.workgroupId === workgroupId &&
      manifest.status === 'applied' &&
      typeof manifest.reportPath === 'string' &&
      path.isAbsolute(manifest.reportPath) &&
      fs.existsSync(manifest.reportPath) &&
      typeof manifest.snapshotDir === 'string' &&
      path.isAbsolute(manifest.snapshotDir) &&
      fs.existsSync(manifest.snapshotDir) &&
      typeof manifest.canonicalSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.canonicalSha256)
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

/**
 * Inventory one workgroup without mutation. A real provider-local tree is
 * substantive unless it is byte-for-byte the shipped missing-only scaffold.
 */
export function inspectWorkgroupMemoryState(
  db: Database.Database,
  workgroupId: string,
  dirs: WorkgroupMemoryDirs = {},
): WorkgroupMemoryState {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const canonical = workgroupMemoryDir(workgroupId, dataDir);
  const canonicalStat = lstatOrNull(canonical);
  const sources = memoryMembers(db, workgroupId).map((member) => sourceFor(member, groupsDir));

  const substantive = sources.filter((source) => {
    if (source.type === 'missing') return false;
    if (source.type === 'symlink') return source.linkTarget !== WORKGROUP_MEMORY_CONTAINER_PATH;
    return source.type !== 'directory' || !isExactShippedMemoryScaffold(source.path);
  });

  if (!canonicalStat) {
    // A dangling compatibility link is not proof of canon. It needs the
    // operator migration rather than silently manufacturing an authority.
    if (substantive.length > 0 || sources.some((source) => source.type === 'symlink')) {
      return { status: 'migration-required', sources: sources.filter((source) => source.type !== 'missing') };
    }
    return { status: 'exact-empty' };
  }

  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink() || substantive.length > 0) {
    return {
      status: 'migration-required',
      sources: [
        {
          groupId: workgroupId,
          folder: workgroupId,
          path: canonical,
          type: canonicalStat.isSymbolicLink()
            ? 'symlink'
            : canonicalStat.isFile()
              ? 'file'
              : canonicalStat.isDirectory()
                ? 'directory'
                : 'unsupported',
          size: canonicalStat.size,
          linkTarget: canonicalStat.isSymbolicLink() ? (safeReadlink(canonical) ?? undefined) : undefined,
        },
        ...substantive,
      ],
    };
  }

  return {
    status: 'canonical',
    basis: hasVerifiedManifest(workgroupId, dataDir) ? 'verified-manifest' : 'exact-links-and-canon',
  };
}

function linkMembersToCanonical(
  db: Database.Database,
  workgroupId: string,
  groupsDir: string,
  dataDir: string,
): boolean {
  let changed = false;
  const members = memoryMembers(db, workgroupId).sort((left, right) => {
    const leftScaffold = isExactShippedMemoryScaffold(path.join(groupsDir, left.folder, 'memory'));
    const rightScaffold = isExactShippedMemoryScaffold(path.join(groupsDir, right.folder, 'memory'));
    return Number(rightScaffold) - Number(leftScaffold);
  });
  for (const member of members) {
    const prepared = prepareWorkgroupMemoryMember(member, workgroupId, { groupsDir, dataDir });
    changed = prepared.changed || changed;
  }
  return changed;
}

/**
 * Canonical-only automatic reconciliation. It may materialize a genuinely
 * empty/scaffold-only canon and compatibility links, but never imports or
 * replaces substantive provider-local bytes.
 */
export function reconcileWorkgroupMemory(
  db: Database.Database,
  dirs: WorkgroupMemoryDirs = {},
): WorkgroupMemoryReport[] {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const selected = dirs.workgroupIds ? new Set(dirs.workgroupIds) : null;
  const workgroups = db.prepare(`SELECT id FROM workgroups ORDER BY id`).all() as Array<{ id: string }>;
  const reports: WorkgroupMemoryReport[] = [];

  for (const { id } of workgroups) {
    if (selected && !selected.has(id)) continue;
    const before = inspectWorkgroupMemoryState(db, id, { groupsDir, dataDir });
    if (before.status === 'migration-required') {
      reports.push({ workgroupId: id, state: before, changed: false });
      continue;
    }

    let changed = false;
    const canonical = workgroupMemoryDir(id, dataDir);
    if (before.status === 'exact-empty' && memoryMembers(db, id).length === 0) {
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.mkdirSync(canonical);
      changed = true;
    }
    changed = linkMembersToCanonical(db, id, groupsDir, dataDir) || changed;
    reports.push({
      workgroupId: id,
      state: inspectWorkgroupMemoryState(db, id, { groupsDir, dataDir }),
      changed,
    });
  }
  return reports;
}

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
  // RE-RUNS EVERY STARTUP, deliberately. This used to `return` here on the
  // marker, which made the shared tree a one-shot snapshot of whenever it first
  // ran. On one install a workgroup's marker predated a later seed dir by two
  // months — the release desk's board, ledger and runbook — so the
  // union rule below (share any seed dir a sibling already symlinks) never got
  // to see it. It ended up reachable only by the three siblings someone
  // remembered to hand-symlink it into and invisible to the two QA agents,
  // which is exactly the scattered-symlink drift docs/workgroups.md says
  // workgroups exist to end.
  //
  // Every step below already skips when it is already correct, so a re-run on
  // settled state touches nothing and rewrites nothing. The marker is now a
  // record (it keeps its original `migratedAt`), not a latch.
  const priorReport = readMigrationReport(markerPath);

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
    if (RESERVED_SHARED_DIR_NAMES.has(entry.name)) continue; // owned by a dedicated migrator
    const full = path.join(seedDir, entry.name);
    if (entry.name === 'sources' || entry.name === 'conversations' || isGitRepo(full)) {
      shared.add(entry.name);
    } else {
      candidates.push(entry.name);
    }
  }
  // Union in any dir a sibling already symlinks (the established shared set,
  // e.g. dbt/retail/wiki) as long as the seed has a real dir of that name.
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
      if (e.name.startsWith('.') || e.name === 'node_modules') continue; // match the seed scan: never share dot/build dirs
      if (RESERVED_SHARED_DIR_NAMES.has(e.name)) continue;
      const seedEntry = path.join(seedDir, e.name);
      if (isRealDir(seedEntry)) {
        shared.add(e.name);
        const ci = candidates.indexOf(e.name);
        if (ci >= 0) candidates.splice(ci, 1);
      }
    }
  }

  // Crash recovery: any real dir already in wgDir was moved by a prior
  // interrupted run (we only reach here when `.migrated` is absent — a
  // completed run returned early above). A crash AFTER the move but BEFORE the
  // compat symlink/sibling-repoint would otherwise drop that name from the
  // seed-derived set above (its source is already gone), orphaning the
  // `/workspace/agent/<name>` path. Re-include it so the move loop finishes the
  // cutover. Staging dirs are hidden (`.<name>.partial`) and shared dirs are
  // never dot-named (both the seed scan and the sibling union exclude dot dirs),
  // so the single dotfile skip cleanly excludes incomplete copies WITHOUT
  // excluding a real shared dir whose name happens to end in `.partial`.
  try {
    for (const e of fs.readdirSync(wgDir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && !RESERVED_SHARED_DIR_NAMES.has(e.name)) {
        shared.add(e.name);
      }
    }
  } catch {
    /* wgDir doesn't exist yet (first run) — nothing to recover */
  }

  // Defense in depth: a reserved name can never reach the mutating loop even
  // if another discovery source is added without applying the filters above.
  for (const name of RESERVED_SHARED_DIR_NAMES) shared.delete(name);

  if (shared.size === 0) {
    log.info('reconcileWorkgroupSharedDirs: nothing to consolidate', { workgroupId });
    return;
  }

  // ── Choose move strategy (rename within a filesystem, else copy) ──────────
  fs.mkdirSync(wgDir, { recursive: true });
  const strategy: 'rename' | 'copy' = sameFilesystem(groupsDir, dataDir) ? 'rename' : 'copy';

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
  // `changed` gates the marker rewrite and the log line below: a re-run that
  // finds everything already in place must be a true no-op, or the "reversible
  // record" gets a fresh `migratedAt` every boot and stops being a record.
  let changed = false;
  const moved: string[] = [];
  for (const name of [...shared].sort()) {
    const src = path.join(seedDir, name);
    const dst = path.join(wgDir, name);

    if (!fs.existsSync(dst)) {
      // Not yet in the shared dir — move src in. Both strategies make dst
      // appear ATOMICALLY (rename; or copy-to-staging then rename), so a crash
      // mid-move can never leave a partial tree at dst that the idempotency
      // check would later mistake for a completed move.
      if (!isRealDir(src)) continue; // nothing real to move (already a symlink / gone)
      changed = true;
      if (strategy === 'rename') {
        fs.renameSync(src, dst); // atomic within the filesystem
      } else {
        // Hidden staging name so the crash-recovery wgDir scan (which skips
        // dotfiles) never mistakes an incomplete copy for a moved dir — and so
        // it never collides with a real shared dir whose name ends in `.partial`.
        const staging = path.join(wgDir, `.${name}.partial`);
        fs.rmSync(staging, { recursive: true, force: true }); // clear any stale partial
        fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
        fs.renameSync(staging, dst); // atomic into place — dst is now complete-or-absent
        fs.rmSync(src, { recursive: true, force: true });
      }
    } else if (isRealDir(src)) {
      // dst already exists AND src is still a real dir → a crash landed between
      // the atomic move and the source cleanup. dst is complete (both paths
      // create it atomically), so finish the cleanup. Safe: the migration runs
      // before any container spawn, so src cannot have been modified since.
      fs.rmSync(src, { recursive: true, force: true });
      changed = true;
    }
    if (ensureCompatSymlink(seedDir, name)) changed = true;
    moved.push(name);
  }

  // ── Repoint every sibling's old symlink to the shared mount ───────────────
  for (const sf of siblingFolders) {
    const sdir = path.join(groupsDir, sf);
    if (!fs.existsSync(sdir)) continue;
    for (const name of moved) {
      const linkPath = path.join(sdir, name);
      const lst = lstatOrNull(linkPath);
      // Already pointing at the mount — nothing to do. Without this a re-run
      // would unlink and re-create every sibling's every link on every boot.
      if (lst?.isSymbolicLink() && safeReadlink(linkPath) === `${WORKGROUP_CONTAINER_PATH}/${name}`) continue;
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
      changed = true;
    }
  }

  if (!changed) return; // settled — re-run is a true no-op

  // ── Write the marker + report (reversible record) ─────────────────────────
  const report: MigrationReport = {
    migratedAt: priorReport?.migratedAt ?? new Date().toISOString(),
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
/** @returns true if it actually wrote a link (i.e. state changed). */
function ensureCompatSymlink(dir: string, name: string): boolean {
  const linkPath = path.join(dir, name);
  const target = `${WORKGROUP_CONTAINER_PATH}/${name}`;
  const st = lstatOrNull(linkPath);
  if (st) {
    if (st.isSymbolicLink() && safeReadlink(linkPath) === target) return false; // already correct
    if (st.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      // A real entry reappeared at the seed path — do not clobber.
      log.warn('reconcileWorkgroupSharedDirs: refusing to overwrite real seed entry with compat symlink', {
        dir,
        name,
      });
      return false;
    }
  }
  fs.symlinkSync(target, linkPath);
  return true;
}

/** Prior `.migrated` report, or null when absent/unreadable/malformed. */
function readMigrationReport(markerPath: string): MigrationReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as MigrationReport;
    return typeof parsed?.migratedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
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
