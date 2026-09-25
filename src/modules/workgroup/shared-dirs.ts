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
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR, GROUPS_DIR, WORKGROUP_SHARED_FS } from '../../config.js';
import type { RawStatements } from '../../db/central-lease.js';
import { log } from '../../log.js';

/** Host path of a workgroup's shared directory. */
export function workgroupSharedDir(workgroupId: string, dataDir: string = DATA_DIR): string {
  return path.resolve(dataDir, 'workgroups', workgroupId);
}

/** Container path the shared dir is mounted at. */
export const WORKGROUP_CONTAINER_PATH = '/workspace/workgroup';
export const WORKGROUP_MEMORY_CONTAINER_PATH = `${WORKGROUP_CONTAINER_PATH}/memory`;

interface InventoriedSource {
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
  /** Restrict BOTH the report set and the mutations to these workgroups. */
  workgroupIds?: string[];
  /**
   * Restrict only the MUTATIONS. Every workgroup still gets a report, built
   * from the non-mutating inventory, so a caller that derives work from the
   * report set keeps seeing all of them.
   *
   * This exists because the boot door may mutate only the workgroups it proved
   * quiescent, while `src/main.ts` derives the pending-pre-turn-context targets
   * and the migration-required operator warnings from the SAME reports. Scoping
   * the report set to the changed workgroups would make an ordinary boot — one
   * where nothing would change — skip both.
   */
  mutateWorkgroupIds?: string[];
}

const MEMORY_MANIFEST = '.memory-migration.json';
/**
 * The per-workgroup consolidation marker. Also the second half of the
 * `/workspace/workgroup` mount predicate in container-runner.ts: the mount is
 * made when `WORKGROUP_SHARED_FS` is set OR this file is present, so a
 * workgroup migrated before the flag was turned off keeps its mount.
 */
const MIGRATION_MARKER = '.migrated';
// Canonical memory has its own lossless inventory/migration/reconciliation
// lifecycle below. The older generic shared-directory migrator must never move,
// adopt, repoint, or report this name, even during crash recovery.
/** The workgroup's shared work-product directory, in the house rather than a bedroom. */
export const SHARED_WORK_DIR_NAME = 'artifacts';
// `memory` has its own lifecycle (above); `artifacts` is created empty and
// ahead of the migrator by `ensureWorkgroupWorkDirs`, which breaks the move
// loop's premise that a present `dst` is a COMPLETE one (the interrupted-move
// branch at the `isRealDir(src)` arm deletes `src` on that basis). Reserving
// the name keeps it out of every discovery source, including the wgDir
// crash-recovery scan that would otherwise re-add it on every boot.
const RESERVED_SHARED_DIR_NAMES = new Set(['memory', SHARED_WORK_DIR_NAME]);
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

function memoryMembers(db: RawStatements, workgroupId: string): Array<{ id: string; folder: string }> {
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
  db: RawStatements,
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

/**
 * Would `reconcileWorkgroupMemory` change anything for this workgroup?
 *
 * Pure. It re-reads exactly the `lstat` facts the reconcile acts on and
 * returns true when any of its mutations would fire: the canonical directory
 * being created, a member's local path not already being the exact
 * container-absolute compatibility link, `preferences/` being created, or the
 * `exact-empty`-with-no-members canon creation. `migration-required` reports
 * false — the reconcile skips those workgroups untouched, so nothing has to be
 * stopped for them.
 *
 * The boot quiescence door (src/container-restart.ts) uses this to decide
 * which workgroups' containers must be stopped before the cutover. Only the
 * member-symlink branch actually invalidates a live container's mount targets;
 * the predicate is deliberately a superset, because over-stopping is safe and
 * under-stopping is not. Its agreement with the reconcile's own `changed`
 * report is asserted over a fixture matrix in shared-dirs.wouldchange.test.ts.
 */
export function workgroupMemoryReconcileWouldChange(
  db: RawStatements,
  workgroupId: string,
  dirs: WorkgroupMemoryDirs = {},
): boolean {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const before = inspectWorkgroupMemoryState(db, workgroupId, { groupsDir, dataDir });
  if (before.status === 'migration-required') return false;

  const members = memoryMembers(db, workgroupId);
  // reconcileWorkgroupMemory's own no-member canon creation (`:388-392`).
  if (before.status === 'exact-empty' && members.length === 0) return true;

  const canonical = workgroupMemoryDir(workgroupId, dataDir);
  const canonExists = lstatOrNull(canonical) !== null;
  // Each mutation below is monotone — the first member that would write makes
  // the reconcile's `changed` true — so the first hit can return without
  // simulating the state a mutation would have left for later members.
  for (const member of members) {
    if (!canonExists) return true;
    const local = path.join(groupsDir, member.folder, 'memory');
    const localStat = lstatOrNull(local);
    const exactLink = localStat?.isSymbolicLink() === true && safeReadlink(local) === WORKGROUP_MEMORY_CONTAINER_PATH;
    if (!exactLink) return true;
    if (!lstatOrNull(path.join(canonical, 'preferences'))) return true;
  }
  return false;
}

function linkMembersToCanonical(db: RawStatements, workgroupId: string, groupsDir: string, dataDir: string): boolean {
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
 *
 * Two selectors, and the difference matters: `workgroupIds` narrows the whole
 * pass (report and mutation), while `mutateWorkgroupIds` narrows only the
 * mutations and still reports every workgroup from the inventory. See
 * `WorkgroupMemoryDirs`.
 */
export function reconcileWorkgroupMemory(db: RawStatements, dirs: WorkgroupMemoryDirs = {}): WorkgroupMemoryReport[] {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const selected = dirs.workgroupIds ? new Set(dirs.workgroupIds) : null;
  const mutable = dirs.mutateWorkgroupIds ? new Set(dirs.mutateWorkgroupIds) : null;
  const workgroups = db.prepare(`SELECT id FROM workgroups ORDER BY id`).all() as Array<{ id: string }>;
  const reports: WorkgroupMemoryReport[] = [];

  for (const { id } of workgroups) {
    if (selected && !selected.has(id)) continue;
    const before = inspectWorkgroupMemoryState(db, id, { groupsDir, dataDir });
    if (before.status === 'migration-required') {
      reports.push({ workgroupId: id, state: before, changed: false });
      continue;
    }
    if (mutable && !mutable.has(id)) {
      // Outside the quiesced scope: inventory only. `changed: false` is the
      // truth here — nothing was written — and the report still reaches the
      // callers that derive per-workgroup work from it.
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
 * half-migrated tree. Runs at startup only from inside a quiescence door
 * (docs/specs/upstream-restart-survival-seam/plan.md §4.2), so the containers
 * whose mounts this cutover invalidates are already stopped.
 *
 * `workgroupIds` narrows the pass to the named workgroups, the same selector
 * `reconcileWorkgroupMemory` already accepts, so the boot door can confine the
 * cutover to the workgroups it proved quiescent.
 */
export function reconcileWorkgroupSharedDirs(
  db: RawStatements,
  dirs: { groupsDir?: string; dataDir?: string; workgroupIds?: string[] } = {},
): void {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const selected = dirs.workgroupIds ? new Set(dirs.workgroupIds) : null;
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  for (const wg of workgroups) {
    if (selected && !selected.has(wg.id)) continue;
    migrateWorkgroup(db, wg.id, groupsDir, dataDir);
  }
}

interface SharedDirPlan {
  seedDir: string;
  wgDir: string;
  siblingFolders: string[];
  shared: Set<string>;
  candidates: string[];
}

/**
 * The consolidation set for one workgroup, computed without mutation.
 *
 * Discovery is shared by `migrateWorkgroup` and `sharedDirsReconcileWouldChange`
 * so the predicate cannot drift from the reconcile it predicts. Returns null
 * when there is no seed folder to consolidate.
 */
function planWorkgroupSharedDirs(
  db: RawStatements,
  workgroupId: string,
  groupsDir: string,
  dataDir: string,
): SharedDirPlan | null {
  const seedDir = path.join(groupsDir, workgroupId); // seed folder == workgroup_id
  if (!fs.existsSync(seedDir)) return null; // no seed data to consolidate

  const wgDir = path.join(dataDir, 'workgroups', workgroupId);

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
  // interrupted run. A crash AFTER the move but BEFORE the compat
  // symlink/sibling-repoint would otherwise drop that name from the
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

  return { seedDir, wgDir, siblingFolders, shared, candidates };
}

/**
 * Would `reconcileWorkgroupSharedDirs` change anything for this workgroup?
 *
 * Pure, and a mirror of `migrateWorkgroup`'s `changed` decision: it shares the
 * discovery pass above and then asks each mutation the migrator would make
 * whether it is already satisfied. Used by the boot quiescence door to scope
 * the stop set (plan §7.D). `changed` is what gates the marker rewrite, so a
 * true here is exactly a boot at which the shared tree moves under a container.
 */
export function sharedDirsReconcileWouldChange(
  db: RawStatements,
  workgroupId: string,
  dirs: { groupsDir?: string; dataDir?: string } = {},
): boolean {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const plan = planWorkgroupSharedDirs(db, workgroupId, groupsDir, dataDir);
  if (!plan) return false;
  const { seedDir, wgDir, siblingFolders, shared } = plan;
  if (shared.size === 0) return false;

  const moved: string[] = [];
  for (const name of [...shared].sort()) {
    const src = path.join(seedDir, name);
    const dst = path.join(wgDir, name);
    if (!fs.existsSync(dst)) {
      if (!isRealDir(src)) continue; // nothing real to move — the migrator skips it whole
      return true; // a move would fire
    } else if (isRealDir(src)) {
      return true; // interrupted move — the source cleanup would fire
    }
    if (compatSymlinkWouldChange(seedDir, name)) return true;
    moved.push(name);
  }

  for (const link of siblingSharedLinks(groupsDir, siblingFolders, moved)) {
    if (link.state === 'repoint') return true; // the repoint would fire
  }
  return false;
}

interface SiblingSharedLink {
  sibling: string;
  name: string;
  linkPath: string;
  lst: fs.Stats | null;
  /** `current`: already points at the mount. `real`: the sibling owns a real entry — never clobbered. */
  state: 'current' | 'real' | 'repoint';
}

function* siblingSharedLinks(
  groupsDir: string,
  siblingFolders: string[],
  moved: string[],
): Generator<SiblingSharedLink> {
  for (const sibling of siblingFolders) {
    const sdir = path.join(groupsDir, sibling);
    if (!fs.existsSync(sdir)) continue;
    for (const name of moved) {
      const linkPath = path.join(sdir, name);
      const lst = lstatOrNull(linkPath);
      const state =
        lst?.isSymbolicLink() && safeReadlink(linkPath) === `${WORKGROUP_CONTAINER_PATH}/${name}`
          ? 'current'
          : lst && !lst.isSymbolicLink()
            ? 'real'
            : 'repoint';
      yield { sibling, name, linkPath, lst, state };
    }
  }
}

function migrateWorkgroup(db: RawStatements, workgroupId: string, groupsDir: string, dataDir: string): void {
  const plan = planWorkgroupSharedDirs(db, workgroupId, groupsDir, dataDir);
  if (!plan) return; // no seed data to consolidate
  const { seedDir, wgDir, siblingFolders, shared, candidates } = plan;

  const markerPath = path.join(wgDir, MIGRATION_MARKER);
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
  for (const { sibling, name, linkPath, lst, state } of siblingSharedLinks(groupsDir, siblingFolders, moved)) {
    // Already pointing at the mount — nothing to do. Without this a re-run
    // would unlink and re-create every sibling's every link on every boot.
    if (state === 'current') continue;
    if (state === 'real') {
      log.warn('reconcileWorkgroupSharedDirs: sibling has a real entry, not overlaying', {
        workgroupId,
        sibling,
        name,
      });
      continue;
    }
    if (lst) fs.unlinkSync(linkPath); // remove the now-broken relative symlink
    fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/${name}`, linkPath);
    changed = true;
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

/**
 * Guarantee every workgroup has ONE shared place for work products, reachable
 * from every member's own folder.
 *
 * Why this cannot ride on `reconcileWorkgroupSharedDirs`: that pass only moves
 * a directory it DISCOVERS, and every one of its three discovery sources reads
 * existing state — a readdir of the seed member's folder (`planWorkgroupSharedDirs`,
 * the `sources`/`conversations`/`isGitRepo` scan), the union of any dir a
 * sibling already symlinks, and a readdir of `wgDir` for crash recovery. A
 * workgroup whose seed never had this directory therefore never gets one, and
 * every sibling writes work products into its own private `/workspace/agent`.
 * That is the mechanism behind an agent reporting a sibling's file as
 * unreachable.
 *
 * This function creates `data/workgroups/<id>/artifacts/` and links each member
 * to it. `SHARED_WORK_DIR_NAME` is in `RESERVED_SHARED_DIR_NAMES`, so the
 * generic migrator treats the name as owned here and never moves, adopts,
 * repoints or reports it — without that, creating `dst` empty and ahead of the
 * migrator makes its `existsSync(dst)` arm read "interrupted move" and delete a
 * seed's real `artifacts/`.
 *
 * Gated per workgroup on the SAME predicate as the `/workspace/workgroup` mount
 * (`WORKGROUP_SHARED_FS`, or a `.migrated` marker): without that mount the link
 * target does not exist in the container, and `container/CLAUDE.md` would be
 * sending work products into container-local storage that `--rm` destroys.
 *
 * Links only where nothing is there. `ensureCompatSymlink` replaces any
 * non-matching symlink, which is correct for its own callers — they repoint a
 * name AFTER moving its content — but wrong here, where nothing is moved: a
 * member whose `artifacts` is a host-resolvable relative link would be
 * retargeted at an empty directory and its content left unreachable.
 *
 * Idempotent, and cheap enough to run on every boot: a settled workgroup does
 * one `mkdirSync` on an existing dir plus one `lstat` per member.
 */
export function ensureWorkgroupWorkDirs(db: RawStatements, dirs: { groupsDir?: string; dataDir?: string } = {}): void {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const target = `${WORKGROUP_CONTAINER_PATH}/${SHARED_WORK_DIR_NAME}`;
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  for (const wg of workgroups) {
    // Per workgroup, because this runs BEFORE runBootMountQuiescence proves
    // container absence (src/main.ts) — every check-then-act below spans a
    // window in which the previous host's containers still hold these
    // directories read-write. An agent creating `artifacts` between the lstat
    // and the symlinkSync is an EEXIST, and one uncaught throw here is
    // `process.exit(1)` in reconcileWorkgroupFsState's caller: a whole host
    // that will not boot because one member lost one race. Nothing here is
    // destructive and the next boot's lstat sees the entry, so warn and carry
    // on. A bad `workgroups` row is caught the same way rather than being
    // permanently fatal.
    try {
      ensureOneWorkgroupWorkDir(db, wg.id, { groupsDir, dataDir, target });
    } catch (err) {
      log.warn('ensureWorkgroupWorkDirs: skipped workgroup', { workgroupId: wg.id, err });
    }
  }
}

function ensureOneWorkgroupWorkDir(
  db: RawStatements,
  workgroupId: string,
  ctx: { groupsDir: string; dataDir: string; target: string },
): void {
  assertTrustedPathSegment(workgroupId, 'workgroup id');
  const wgDir = workgroupSharedDir(workgroupId, ctx.dataDir);
  // Same predicate as the mount in container-runner.ts. A link whose target
  // is not mounted is worse than no link.
  if (!WORKGROUP_SHARED_FS && !fs.existsSync(path.join(wgDir, MIGRATION_MARKER))) return;
  fs.mkdirSync(path.join(wgDir, SHARED_WORK_DIR_NAME), { recursive: true });
  const members = db.prepare(`SELECT folder FROM agent_groups WHERE workgroup_id = ?`).all(workgroupId) as Array<{
    folder: string;
  }>;
  for (const member of members) {
    assertTrustedPathSegment(member.folder, 'agent group folder');
    const memberDir = path.join(ctx.groupsDir, member.folder);
    // A member whose folder has not been created yet is not an error: the
    // group's first spawn runs initGroupFilesystem, and the next boot links
    // it. Creating the folder here would race that scaffold.
    if (!fs.existsSync(memberDir)) continue;
    const linkPath = path.join(memberDir, SHARED_WORK_DIR_NAME);
    let st = lstatOrNull(linkPath);
    if (st?.isSymbolicLink() && safeReadlink(linkPath) === ctx.target) continue; // already correct
    if (st?.isDirectory()) {
      // A member that kept its own real directory here is the divergence this
      // whole mechanism exists to end: its agent reads an instruction naming
      // the shared tree while writing into private storage no sibling can
      // read. Consolidate it, then fall through and link.
      consolidateMemberWorkDir(linkPath, path.join(wgDir, SHARED_WORK_DIR_NAME), {
        workgroupId,
        member: member.folder,
      });
      st = lstatOrNull(linkPath);
    }
    if (st) {
      // Still something here: a file, or a symlink addressing content this
      // function did not put there (the clone-as-codex `../<seed>/x` shape).
      // Nothing was moved, so repointing would strand what it addresses.
      log.warn('ensureWorkgroupWorkDirs: member already has an entry at the shared work dir name', {
        workgroupId,
        member: member.folder,
        name: SHARED_WORK_DIR_NAME,
        kind: st.isSymbolicLink() ? `symlink -> ${safeReadlink(linkPath) ?? '?'}` : 'real entry',
      });
      continue;
    }
    try {
      fs.symlinkSync(ctx.target, linkPath);
    } catch (err) {
      // Lost the lstat→symlink race with a live container. Not destructive;
      // the next boot's lstat takes the branch above.
      log.warn('ensureWorkgroupWorkDirs: could not link member', { workgroupId, member: member.folder, err });
    }
  }
}

/**
 * Drain a member's own real `artifacts/` into the workgroup's shared tree, so
 * the caller can replace it with the compat link.
 *
 * Every path here is writable by a live container: the shared tree is mounted
 * read-write into every sibling, this runs before `runBootMountQuiescence`
 * proves container absence, and the member's own folder is that member's
 * `/workspace/agent`. The rules below are what makes that survivable.
 *
 * - **A file is published with `link(2)`, never renamed onto a name.**
 *   `rename(2)` replaces an existing file silently, so anything that renames
 *   onto a name in this tree — even over a reservation it made itself — can
 *   destroy bytes a sibling wrote there. `link` fails `EEXIST` in the kernel:
 *   the name appears only with the content already in it, and a name that is
 *   taken stays the sibling's. There is no claim, so there is nothing to
 *   release and no empty name for a hard death to leave behind.
 * - **A directory is published by claim, then rename.** Directories cannot be
 *   hard-linked. A non-recursive `mkdir` reserves the name (`EEXIST` if taken),
 *   and renaming onto a directory fails `ENOTEMPTY` if a sibling has written
 *   into the claim — the kernel's refusal, not a check.
 * - **A taken name is not merged.** It moves to `<name>.from-<member>`, so the
 *   content still becomes shared and neither side loses a byte; taken twice,
 *   the entry stays put. `name` is either a `readdir` component or the capture
 *   of `HELD_NAME` from one, with `.` and `..` rejected at the call site, and
 *   `ctx.member` passed `assertTrustedPathSegment` there — so the derived
 *   names are single safe segments too.
 * - **The source directory is removed with `rmdirSync`**, which fails
 *   `ENOTEMPTY` rather than recursing. A member whose entries could not all
 *   move keeps its directory and everything in it.
 *
 * The cross-device branch is the one place that copies instead of renaming,
 * and its source removal spans the whole copy — bytes written into the source
 * during it are lost. It cannot be made atomic without a rewrite this does not
 * need, so it is entered only when the two paths are PROVEN to be on different
 * filesystems. An unreadable `stat` is not that proof: it skips the member for
 * this boot rather than picking the destructive strategy, which is the
 * opposite of `sameFilesystem`'s own "unknown → copy" advice — written for the
 * migrator, where copy is the safe fallback, and wrong for this caller.
 *
 * Failures are per entry: one unreadable file does not abandon the rest, and
 * the next boot retries whatever is left. A file interrupted mid-publish is
 * left holding its bytes under `.<name>.publishing` and resumes next boot;
 * under the rename strategy an already-linked file is additionally recognised
 * by inode and simply finished, while under copy it republishes to
 * `.from-<member>` (a duplicate, never a loss). A hard death between a
 * directory claim and its move leaves an empty directory at the real name,
 * which the next boot moves aside to `.from-<member>`. No bytes are lost in
 * any of these.
 */
function consolidateMemberWorkDir(
  memberWorkDir: string,
  sharedWorkDir: string,
  ctx: { workgroupId: string; member: string },
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(memberWorkDir);
  } catch (err) {
    log.warn('ensureWorkgroupWorkDirs: could not read member work dir', { ...ctx, err });
    return;
  }
  if (entries.length > 0) {
    const strategy = moveStrategy(memberWorkDir, sharedWorkDir);
    if (strategy === null) {
      log.warn('ensureWorkgroupWorkDirs: cannot prove a safe move strategy, leaving the member alone', ctx);
      return;
    }
    const moved: string[] = [];
    const renamed: string[] = [];
    for (const entry of entries) {
      // `.<name>.publishing` is this function's own hold from an earlier boot
      // that died mid-publish: the bytes of `<name>`, already moved off their
      // real name. Publish them under the name they were taken from.
      const held = HELD_NAME.exec(entry);
      // `.` and `..` are not names: a member file called `...publishing`
      // captures one, and the derived path would address the shared tree
      // itself or its parent. Publish such an entry under its own literal
      // name instead.
      const leftover = held && held[1] !== '.' && held[1] !== '..' ? held : null;
      const name = leftover ? leftover[1] : entry;
      const src = path.join(memberWorkDir, entry);
      let srcIsDir: boolean;
      try {
        srcIsDir = fs.lstatSync(src).isDirectory();
      } catch (err) {
        log.warn('ensureWorkgroupWorkDirs: could not stat entry', { ...ctx, name, err });
        continue;
      }
      const dstName = srcIsDir
        ? publishDir(src, sharedWorkDir, name, strategy, ctx)
        : publishFile(src, sharedWorkDir, name, strategy, ctx, leftover !== null);
      if (dstName === null) continue;
      moved.push(name);
      if (dstName !== name) renamed.push(`${name} -> ${dstName}`);
    }
    if (moved.length > 0) {
      log.info('ensureWorkgroupWorkDirs: consolidated member work dir', {
        ...ctx,
        strategy,
        moved: moved.length,
        renamedOnCollision: renamed,
      });
    }
  }
  try {
    fs.rmdirSync(memberWorkDir); // ENOTEMPTY rather than recursing — nothing unmoved is lost
  } catch {
    /* entries remain; the caller's warning names the member and the next boot retries */
  }
}

/**
 * `rename` when both paths are proven to be on one filesystem, `copy` when
 * they are proven to be on two, and `null` when neither is proven.
 *
 * Deliberately not `sameFilesystem`, whose `catch` answers "different" so its
 * caller takes the copy path. That is the safe default for the directory
 * migrator; here copy is the branch with the unguarded window, so an unknown
 * device must decline rather than choose it.
 */
function moveStrategy(a: string, b: string): 'rename' | 'copy' | null {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev ? 'rename' : 'copy';
  } catch {
    return null;
  }
}

type PublishCtx = { workgroupId: string; member: string };

/** The member's own name first, then the aside name a collision falls back to. */
function candidateNames(name: string, ctx: PublishCtx): [string, string] {
  return [name, `${name}.from-${ctx.member}`];
}

function warnNoName(name: string, ctx: PublishCtx, err?: unknown): void {
  // Both names are taken. The second may be an earlier consolidation of this
  // same member, or anything a sibling wrote — the shared tree is read-write
  // to all of them, so this cannot be narrowed further from here. Either way
  // the entry stays put, and the caller's `rmdirSync` then refuses the member.
  log.warn('ensureWorkgroupWorkDirs: could not claim a name in the shared tree, left in place', {
    ...ctx,
    name,
    attempted: candidateNames(name, ctx)[1],
    err,
  });
}

/**
 * This function's own hold on an entry whose real name it has already taken.
 *
 * Recognised by PATTERN, never derived: the random segment is what makes the
 * hold path unforgeable, so `rename(2)` — which cannot refuse a name — can
 * still be used to take it. A guess-able hold name would need a check before
 * that rename, and a check is what a live member's write races.
 */
const HELD_NAME = /^\.(.+)\.[0-9a-f]{12}\.publishing$/;

function newHoldPath(dir: string, name: string): string {
  return path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.publishing`);
}

/**
 * Publish a non-directory entry into the shared tree and return the name it
 * landed under, or `null` when it stays in the member (logged).
 *
 * Three steps, in this order, because each one closes a window the others
 * cannot:
 *
 * 1. **`rename` the entry off its real name**, to `.<name>.<random>.publishing`
 *    beside it. This is the member-side reservation. `unlink`ing the source
 *    after the link instead would remove whatever sits at that PATH — and the
 *    member's own container is live here, so an agent saving the file (write
 *    temp, rename over it) between the link and the unlink would have its new
 *    version deleted while the shared tree kept the old one. After the rename
 *    the member may recreate `<name>` freely; this function never touches that
 *    path again, and the next boot publishes it as a separate entry.
 *    `rename(2)` cannot refuse an occupied name, so the hold path is made
 *    UNFORGEABLE rather than checked: 48 random bits the live member cannot
 *    guess, recognised next boot by pattern.
 * 2. **`link` the held bytes into the shared tree**, which fails `EEXIST` in
 *    the kernel. That is the sibling-side reservation: the shared name appears
 *    only with content already in it, and a name a sibling holds stays theirs
 *    — ours goes to `<name>.from-<member>`. Cross-device, where `link(2)`
 *    cannot reach, the held bytes are copied to a staging name in the shared
 *    tree and that copy is linked.
 * 3. **Remove the hold.** By then it is a second name for a published inode —
 *    but the removal is by PATH, and once step 1 has run the hold is an
 *    ordinary visible entry in the member's live folder. A member writing
 *    there in the microseconds before this `rmSync` loses those bytes. POSIX
 *    has no unlink-by-inode, so the window cannot be closed; the hold's name
 *    is unguessable in ADVANCE, which is what step 1 needs, and merely obscure
 *    afterwards.
 *
 * A death between 1 and 3 leaves the hold in the member folder. `HELD_NAME`
 * matches it on the next boot, which resumes at step 2 (`heldAlready`), so no
 * bytes are stranded under a name nothing looks for.
 */
function publishFile(
  src: string,
  sharedWorkDir: string,
  name: string,
  strategy: 'rename' | 'copy',
  ctx: PublishCtx,
  heldAlready = false,
): string | null {
  const held = heldAlready ? src : newHoldPath(path.dirname(src), name);
  let holdMade = heldAlready;
  let staged: string | null = null;
  let landed: string | null = null;
  try {
    if (!heldAlready) {
      // Nothing can be at `held`: the name carries 48 random bits a live
      // member cannot guess, so this rename lands on an unused name without a
      // check in front of it. An earlier boot's hold has a different random
      // segment, is its own readdir entry, and is published on its own.
      fs.renameSync(src, held);
      holdMade = true;
    }
    let from = held;
    if (strategy === 'copy') {
      staged = path.join(sharedWorkDir, `.${name}.from-${ctx.member}.publishing`);
      fs.rmSync(staged, { force: true }); // a leftover copy; the held bytes are still intact
      fs.cpSync(held, staged, { verbatimSymlinks: true });
      from = staged;
    }
    for (const candidate of candidateNames(name, ctx)) {
      const dst = path.join(sharedWorkDir, candidate);
      try {
        fs.linkSync(from, dst);
        landed = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Taken — unless it is this very inode, which an earlier boot linked
        // and died before removing the hold. Then only the cleanup is left.
        if (sameInode(from, dst)) {
          landed = candidate;
          break;
        }
      }
    }
    if (landed === null) {
      warnNoName(name, ctx);
      releaseHold(held, name, ctx);
      return null;
    }
    fs.rmSync(held, { force: true }); // by path: see step 3 on the window this leaves
    return landed;
  } catch (err) {
    log.warn('ensureWorkgroupWorkDirs: could not move entry into the shared tree', { ...ctx, name, err });
    // Only when there is a hold to give back: a rename that itself threw made
    // none, and `releaseHold` would then warn about one that never existed.
    if (landed === null && holdMade) releaseHold(held, name, ctx);
    return null;
  } finally {
    // Only ever the copy branch's own staging. Removed once the link exists
    // (it is then a second name for it) and also when nothing landed, because
    // `held` still holds the bytes either way.
    if (staged) fs.rmSync(staged, { force: true });
  }
}

/**
 * Give an unpublished hold its real name back, so the entry is where its agent
 * expects it and the next boot retries from the ordinary path.
 *
 * `link` then remove, NOT `lstat` then `rename`. The member's container is
 * live and the whole reason a hold exists is that the member may write a new
 * `<name>` at any moment; `rename(2)` would replace that file silently, and a
 * check before it is the same window this function's caller was rewritten to
 * remove. `EEXIST` from `link` is the kernel refusing instead — the hold then
 * keeps its hidden name and is resumed on the next boot.
 */
function releaseHold(held: string, name: string, ctx: PublishCtx): void {
  const real = path.join(path.dirname(held), name);
  try {
    fs.linkSync(held, real); // EEXIST if the member wrote a new one
    fs.rmSync(held, { force: true }); // by path: see step 3 on the window this leaves
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; // theirs; resumed next boot
    log.warn('ensureWorkgroupWorkDirs: left an unfinished hold in the member folder', { ...ctx, name, err });
  }
}

/**
 * Publish a directory: claim the name with a non-recursive `mkdir`, then
 * rename (or copy then rename) over that claim. Returns the name used, or
 * `null` when the directory stays in the member (logged).
 *
 * Directories cannot be hard-linked, so a claim is unavoidable here. It is
 * safe for a directory in a way it is not for a file: renaming onto a
 * directory a sibling has written into fails `ENOTEMPTY`, and giving back a
 * claim is an `rmdir` that fails the same way — the kernel refuses in both
 * places, so nothing a sibling put there can be replaced or removed.
 */
function publishDir(
  src: string,
  sharedWorkDir: string,
  name: string,
  strategy: 'rename' | 'copy',
  ctx: PublishCtx,
): string | null {
  let dstName: string | null = null;
  let lastErr: unknown;
  for (const candidate of candidateNames(name, ctx)) {
    try {
      fs.mkdirSync(path.join(sharedWorkDir, candidate)); // non-recursive: EEXIST if taken
      dstName = candidate;
      break;
    } catch (err) {
      lastErr = err; // EACCES and ENOSPC land here too — don't report them as "taken"
    }
  }
  if (dstName === null) {
    warnNoName(name, ctx, lastErr);
    return null;
  }
  const dst = path.join(sharedWorkDir, dstName);
  // The rename CONSUMES the claim. Anything that throws after it — the copy
  // branch's source removal — must not give the claim back, which would
  // remove the content just moved.
  let consumed = false;
  try {
    if (strategy === 'rename') {
      fs.renameSync(src, dst);
      consumed = true;
    } else {
      const staging = path.join(sharedWorkDir, `.${dstName}.${process.pid}.partial`);
      try {
        fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
        fs.renameSync(staging, dst); // ENOTEMPTY if a sibling filled the claim
        consumed = true;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true }); // ours, by pid
      }
      fs.rmSync(src, { recursive: true, force: true });
    }
    return dstName;
  } catch (err) {
    if (!consumed) {
      try {
        fs.rmdirSync(dst); // ENOTEMPTY if a sibling filled it — their content stays
      } catch {
        /* somebody else's now, or already gone — either way not ours to remove */
      }
    }
    log.warn('ensureWorkgroupWorkDirs: could not move entry into the shared tree', { ...ctx, name, err });
    return consumed ? dstName : null;
  }
}

function sameInode(a: string, b: string): boolean {
  const sa = lstatOrNull(a);
  const sb = lstatOrNull(b);
  return !!sa && !!sb && sa.dev === sb.dev && sa.ino === sb.ino;
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

/** Non-mutating mirror of `ensureCompatSymlink`: would it write a link? */
function compatSymlinkWouldChange(dir: string, name: string): boolean {
  const linkPath = path.join(dir, name);
  const target = `${WORKGROUP_CONTAINER_PATH}/${name}`;
  const st = lstatOrNull(linkPath);
  if (!st) return true;
  if (st.isSymbolicLink()) return safeReadlink(linkPath) !== target;
  return false; // a real seed entry is never clobbered
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

/**
 * Remove a member's workgroup compat symlinks whose shared target is gone.
 *
 * `migrateWorkgroup` drops `<name> -> /workspace/workgroup/<name>` into the
 * seed and every sibling for each consolidated name, and re-runs every boot.
 * It only ever ADDS: when an agent later deletes the shared entry those links
 * stay, one per member, dangling inside every container at `/workspace/agent/`
 * forever. Nothing else prunes them — on this install 137 had accumulated
 * across 18 of 24 groups, the oldest three months old, mirrored sibling for
 * sibling because that is how they are created.
 *
 * The blast radius if the predicate is wrong is every compat link in the
 * fleet, so it is deliberately narrow — an entry is removed only when ALL of:
 *
 * - the workgroup carries the `.migrated` marker (see the gate's own comment:
 *   the flag alone is fail-OPEN here, unlike in the steps that copy it);
 * - it is a symlink. This one is a FAST PATH, not the guarantee: `readlink`
 *   below already fails on every real entry, so a real directory survives on
 *   the clause after this one even with this removed — no test can kill it
 *   alone, and it is kept because saying so explicitly is cheaper to read than
 *   re-deriving it;
 * - its text is EXACTLY `/workspace/workgroup/<its own name>`, the one shape
 *   `ensureCompatSymlink` writes. An agent's `foo -> /workspace/workgroup/bar`
 *   or a clone-as-codex `../<seed>/x` is somebody else's link and is left;
 * - its name is not in `RESERVED_SHARED_DIR_NAMES`, which dedicated
 *   reconcilers own and repair rather than delete;
 * - the name is absent from a SUCCESSFUL `readdir` of the shared tree;
 * - it is STILL absent on a re-confirming `lstat` taken immediately before the
 *   unlink, which closes the window between that listing and this member's
 *   scan;
 * - the SEED holds no real dir of that name. That one is not hygiene: the
 *   sibling union at `:567` re-derives the shared set from exactly these
 *   links later in the same boot, so deleting one silently un-shares a
 *   directory. Do not remove it without reading that union.
 *
 * The `readdir` clause is why the listing is read once per workgroup and a
 * failure returns instead of continuing. `existsSync` per link would answer
 * "gone" for every name the moment the shared tree is unreadable — a transient
 * mount problem would then delete every compat link in the workgroup, which is
 * the one outcome worse than the stale links this removes.
 *
 * Deleting a broken symlink destroys no data, so unlike the movers here this
 * needs no claim protocol: a container racing it either sees the link or does
 * not, and both answers were already wrong before the unlink.
 */
export function pruneDanglingWorkgroupCompatLinks(
  db: RawStatements,
  dirs: { groupsDir?: string; dataDir?: string } = {},
): void {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  for (const wg of workgroups) {
    // Contained per workgroup for the same reason as `ensureWorkgroupWorkDirs`:
    // this runs before `runBootMountQuiescence`, and one bad row or one lost
    // race must not be a host that will not boot.
    try {
      pruneOneWorkgroupCompatLinks(db, wg.id, { groupsDir, dataDir });
    } catch (err) {
      log.warn('pruneDanglingWorkgroupCompatLinks: skipped workgroup', { workgroupId: wg.id, err });
    }
  }
}

function pruneOneWorkgroupCompatLinks(
  db: RawStatements,
  workgroupId: string,
  ctx: { groupsDir: string; dataDir: string },
): void {
  assertTrustedPathSegment(workgroupId, 'workgroup id');
  const wgDir = workgroupSharedDir(workgroupId, ctx.dataDir);
  // The marker, NOT the mount predicate the other steps use. A link of the
  // shape this function deletes can only have been written by
  // `migrateWorkgroup`, which writes the marker at `:782` — so no marker means
  // nothing of that shape is this function's to judge. (`ensureWorkgroupWorkDirs`
  // also writes a compat link under the flag alone, but only for `artifacts`,
  // which is reserved and never reaches the loop below.)
  //
  // Accepting the flag alone here would be fail-OPEN in the shape most likely
  // to occur. If `wgDir` is lost — an unmounted volume, a partial restore, an
  // agent's `rm -rf` — the marker goes with it, and step 2's
  // `mkdirSync(wgDir/artifacts, { recursive: true })` (`:861`) RECREATES the
  // directory before this runs. The listing below then succeeds, returning
  // `['artifacts']`, and every real name reads as gone: on a six-member
  // workgroup that is every compat link deleted in one boot. The
  // `readdir`-throws bail cannot catch it, because nothing throws.
  if (!fs.existsSync(path.join(wgDir, MIGRATION_MARKER))) return;

  // One listing, and a failure means "cannot tell", never "nothing is there".
  let sharedNames: Set<string>;
  try {
    sharedNames = new Set(fs.readdirSync(wgDir));
  } catch (err) {
    log.warn('pruneDanglingWorkgroupCompatLinks: shared tree unreadable, pruned nothing', { workgroupId, err });
    return;
  }

  const members = db.prepare(`SELECT folder FROM agent_groups WHERE workgroup_id = ?`).all(workgroupId) as Array<{
    folder: string;
  }>;
  for (const member of members) {
    assertTrustedPathSegment(member.folder, 'agent group folder');
    const memberDir = path.join(ctx.groupsDir, member.folder);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(memberDir, { withFileTypes: true });
    } catch {
      continue; // folder not scaffolded yet, or unreadable — nothing to judge
    }
    const pruned: string[] = [];
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      if (RESERVED_SHARED_DIR_NAMES.has(entry.name)) continue;
      if (sharedNames.has(entry.name)) continue;
      const linkPath = path.join(memberDir, entry.name);
      if (safeReadlink(linkPath) !== `${WORKGROUP_CONTAINER_PATH}/${entry.name}`) continue;
      // The listing above was taken before this member was scanned, and this
      // runs before runBootMountQuiescence proves containers are gone, so a
      // live agent can have created the target in between — `mkdir
      // /workspace/workgroup/foo` then `ln -s` into its own bedroom. Without
      // this the link is unlinked while its target exists, which is wrong at
      // the moment it happens rather than already-wrong. `lstat`, NOT
      // `existsSync`: the listing counts a name whether or not it resolves, so
      // `existsSync` here would prune links whose shared entry is itself a
      // dangling symlink — the opposite of what the listing decided. This can
      // only ever KEEP more links than the listing did.
      if (lstatOrNull(path.join(wgDir, entry.name))) continue;
      // `reconcileWorkgroupSharedDirs` runs LATER in this same boot and
      // re-derives the established shared set from exactly these links: a
      // sibling symlink whose name the seed still holds as a real dir is
      // unioned back in (`planWorkgroupSharedDirs`, gated on
      // `isRealDir(seedEntry)`; seed folder == workgroup id).
      // Deleting one first would silently un-share that directory —
      // it falls into `candidates` and stays private to the seed, with no
      // warn. Keep the link and let the migrator re-point it; the empty
      // `wgDir` entry it is waiting for is the migrator's to create.
      if (isRealDir(path.join(ctx.groupsDir, workgroupId, entry.name))) continue;
      try {
        fs.unlinkSync(linkPath);
        pruned.push(entry.name);
      } catch (err) {
        log.warn('pruneDanglingWorkgroupCompatLinks: could not remove link', {
          workgroupId,
          member: member.folder,
          name: entry.name,
          err,
        });
      }
    }
    if (pruned.length > 0) {
      log.info('pruneDanglingWorkgroupCompatLinks: removed dangling compat links', {
        workgroupId,
        member: member.folder,
        count: pruned.length,
        names: pruned.sort(),
      });
    }
  }
}
