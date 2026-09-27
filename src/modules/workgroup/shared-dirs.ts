/**
 * Workgroup shared filesystem: each workgroup's shared dirs live in
 * `data/workgroups/<id>/`, bind-mounted into every member at `/workspace/workgroup`;
 * each member keeps its private `/workspace/agent`.
 *
 * The migration moves only provably-shareable dirs (top-level git repos,
 * `sources`, `conversations`, any dir a sibling already symlinks). A moved name
 * becomes a CONTAINER-ABSOLUTE compat symlink `<name> -> /workspace/workgroup/<name>`:
 * it dangles on the host (so the symlink overlay skips it) but resolves inside
 * the container.
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR, GROUPS_DIR, WORKGROUP_SHARED_FS } from '../../config.js';
import type { RawStatements } from '../../db/central-lease.js';
import { log } from '../../log.js';

export function workgroupSharedDir(workgroupId: string, dataDir: string = DATA_DIR): string {
  return path.resolve(dataDir, 'workgroups', workgroupId);
}

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
   * Restrict only the MUTATIONS; every workgroup still gets a report. Boot may
   * mutate only workgroups it proved quiescent, but derives other per-workgroup
   * work from the SAME reports, so they must cover everyone.
   */
  mutateWorkgroupIds?: string[];
}

const MEMORY_MANIFEST = '.memory-migration.json';
/**
 * The per-workgroup consolidation marker. Also half of the `/workspace/workgroup`
 * mount predicate: a workgroup migrated before the flag was turned off keeps its mount.
 */
const MIGRATION_MARKER = '.migrated';
export const SHARED_WORK_DIR_NAME = 'artifacts';
// `memory` has its own lifecycle; `artifacts` is created empty ahead of the
// migrator, which would read a present-but-empty `dst` as a completed move and
// delete the seed's `src`. Reserved names are kept out of every discovery source.
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
 * Prepare one member's view of canonical memory. The only seam that may create a
 * missing canon or replace an exact shipped scaffold with the compat link;
 * substantive or ambiguous paths require the operator migration.
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
 * Would `reconcileWorkgroupMemory` change anything for this workgroup? Pure.
 * The boot quiescence door uses it to pick which containers to stop. It must
 * agree with the reconcile's `changed` report, which is deliberately wider than
 * the member-symlink changes that invalidate live mounts: over-stopping is safe
 * and under-stopping is not.
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
 * Canonical-only automatic reconciliation: may materialize an empty/scaffold-only
 * canon and compat links, never imports or replaces substantive provider-local
 * bytes. `mutateWorkgroupIds` narrows only mutations (see `WorkgroupMemoryDirs`).
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
      // Outside the quiesced scope: inventory only, still reported.
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
 * Fail-closed: a per-workgroup failure throws so the caller exits rather than
 * spawn containers against a half-migrated tree. Runs only inside the boot
 * quiescence door, so containers whose mounts this invalidates are stopped.
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
 * The consolidation set for one workgroup, computed without mutation. Shared
 * by the migrator and its would-change predicate so the two cannot drift.
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

  const members = db.prepare(`SELECT folder FROM agent_groups WHERE workgroup_id = ?`).all(workgroupId) as Array<{
    folder: string;
  }>;
  const siblingFolders = members.map((m) => m.folder).filter((f) => f !== workgroupId);

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

  // Crash recovery: a real dir already in wgDir was moved by an interrupted run
  // whose source is gone; re-include it so the cutover finishes. Staging dirs are
  // dot-named (`.<name>.partial`) and shared dirs never are, so the dotfile skip
  // excludes incomplete copies only.
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
 * Would `reconcileWorkgroupSharedDirs` change anything for this workgroup? Pure
 * mirror of the migrator's `changed` decision, used by the boot quiescence door.
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
  // RE-RUNS EVERY STARTUP, deliberately: a one-shot latch would miss seed dirs
  // added after the first run. Every step skips when already correct, so a settled
  // re-run writes nothing; the marker is a record (keeps `migratedAt`), not a latch.
  const priorReport = readMigrationReport(markerPath);

  if (shared.size === 0) {
    log.info('reconcileWorkgroupSharedDirs: nothing to consolidate', { workgroupId });
    return;
  }

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

  // `changed` gates the marker rewrite: a settled re-run must not refresh `migratedAt`.
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

  for (const { sibling, name, linkPath, lst, state } of siblingSharedLinks(groupsDir, siblingFolders, moved)) {
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
 * Guarantee every workgroup has ONE shared `artifacts/` for work products,
 * linked from every member's folder. The migrator only moves dirs it discovers
 * in existing state, so a seed that never had one would leave every sibling
 * writing into private storage.
 *
 * Gated on the SAME predicate as the `/workspace/workgroup` mount: without the
 * mount the link target is container-local storage that `--rm` destroys.
 * Links only where nothing is there, unlike `ensureCompatSymlink`, which
 * repoints any non-matching symlink and would strand a member's linked content.
 */
export function ensureWorkgroupWorkDirs(db: RawStatements, dirs: { groupsDir?: string; dataDir?: string } = {}): void {
  const groupsDir = dirs.groupsDir ?? GROUPS_DIR;
  const dataDir = dirs.dataDir ?? DATA_DIR;
  const target = `${WORKGROUP_CONTAINER_PATH}/${SHARED_WORK_DIR_NAME}`;
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  for (const wg of workgroups) {
    // Per workgroup: this runs before boot quiescence proves container absence,
    // so any check-then-act can lose a race with a live container (EEXIST), and
    // an uncaught throw would stop the whole host from booting. The next boot
    // retries, so warn and carry on.
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
      // A member's own real directory is the divergence this exists to end:
      // consolidate it, then fall through and link.
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
 * Drain a member's own real `artifacts/` into the shared tree so the caller can
 * replace it with the compat link. Every path here is writable by a live
 * container (this runs before boot quiescence), so:
 *
 * - A file is published with `link(2)`, never renamed onto a name: `rename`
 *   silently replaces a sibling's file, `link` fails `EEXIST` in the kernel.
 * - A directory is claimed with a non-recursive `mkdir`, then renamed over the
 *   claim, which fails `ENOTEMPTY` if a sibling wrote into it.
 * - A taken name is not merged: the entry goes to `<name>.from-<member>`, and
 *   if that is taken too it stays put. Derived names are single safe segments:
 *   `.`/`..` are rejected at the call site and `ctx.member` is a trusted segment.
 * - The source directory is removed with `rmdirSync`, which refuses when entries
 *   could not all move.
 *
 * The cross-device copy branch loses bytes written into the source during the
 * copy, so it runs only when the paths are PROVEN to be on different
 * filesystems; an unreadable `stat` skips the member for this boot (the
 * opposite of `sameFilesystem`'s unknown→copy). Interrupted publishes resume
 * next boot from their `.<name>.publishing` hold.
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
 * `rename` when both paths are proven on one filesystem, `copy` when proven on
 * two, `null` when neither. Not `sameFilesystem`, whose unknown→copy default is
 * wrong here: copy is the branch with the unguarded window.
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
  // Both names are taken (by an earlier consolidation or a sibling). The entry
  // stays put, and the caller's `rmdirSync` then refuses the member.
  log.warn('ensureWorkgroupWorkDirs: could not claim a name in the shared tree, left in place', {
    ...ctx,
    name,
    attempted: candidateNames(name, ctx)[1],
    err,
  });
}

/**
 * This function's own hold on an entry whose real name it has taken. Recognised
 * by PATTERN: the random segment makes the hold path unforgeable, so `rename`
 * can take it without a check a live member's write could race.
 */
const HELD_NAME = /^\.(.+)\.[0-9a-f]{12}\.publishing$/;

function newHoldPath(dir: string, name: string): string {
  return path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.publishing`);
}

/**
 * Publish a non-directory entry into the shared tree; returns the name it
 * landed under, or `null` when it stays in the member (logged). Order matters:
 *
 * 1. `rename` the entry off its real name to an unguessable
 *    `.<name>.<random>.publishing` hold. Unlinking the source after the link
 *    instead would delete a new version the live member saved in between.
 * 2. `link` the held bytes into the shared tree (`EEXIST` keeps a sibling's name
 *    theirs; ours goes to `<name>.from-<member>`). Cross-device, copy to a
 *    staging name and link that.
 * 3. Remove the hold, by path. A member writing to the hold's name in the
 *    microseconds before this loses those bytes; POSIX has no unlink-by-inode.
 *
 * A death between 1 and 3 leaves the hold; `HELD_NAME` matches it next boot and
 * resumes at step 2.
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
      // The hold name carries 48 random bits a live member cannot guess, so this
      // rename needs no check in front of it.
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
 * Give an unpublished hold its real name back. `link` then remove, NOT `rename`:
 * the live member may have written a new `<name>`, which `rename` would silently
 * replace. On `EEXIST` the hold keeps its hidden name and resumes next boot.
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
 * Publish a directory: claim the name with a non-recursive `mkdir`, then rename
 * (or copy then rename) over the claim; `null` when it stays in the member.
 * Safe because renaming onto, or `rmdir`-ing, a claim a sibling wrote into
 * fails `ENOTEMPTY`.
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

/** Create (or replace) a container-absolute compat symlink at `<dir>/<name>`; true if it wrote one. */
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
 * Remove a member's workgroup compat symlinks whose shared target is gone (the
 * migrator only ever adds them). A wrong predicate would hit every compat link
 * in the fleet, so an entry is removed only when ALL of:
 *
 * - the workgroup carries the `.migrated` marker;
 * - it is a symlink whose text is EXACTLY `/workspace/workgroup/<its own name>`
 *   (anything else is somebody else's link);
 * - its name is not reserved;
 * - the name is absent from a SUCCESSFUL `readdir` of the shared tree, and still
 *   absent on an `lstat` immediately before the unlink;
 * - the SEED holds no real dir of that name: the migrator's sibling union
 *   re-derives the shared set from these links later in the same boot, so
 *   deleting one silently un-shares a directory.
 *
 * A failed listing returns rather than continuing: per-link `existsSync` would
 * read an unreadable shared tree as "all gone" and delete every link.
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
  // The marker, NOT the mount predicate: with the flag alone, a lost `wgDir` is
  // recreated (holding only `artifacts`) by an earlier boot step, the listing
  // succeeds, and every real name would read as gone.
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
      // Re-confirm: a live agent can have created the target since the listing.
      // `lstat`, not `existsSync`, so a shared entry that is itself a dangling
      // symlink still counts as present, as the listing did.
      if (lstatOrNull(path.join(wgDir, entry.name))) continue;
      // The seed still holds a real dir of this name: the migrator later this
      // boot unions it back in via this link, so deleting it would un-share it.
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
