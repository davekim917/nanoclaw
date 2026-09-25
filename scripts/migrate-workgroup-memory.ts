import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

// Composition slot. These are standalone `tsx` entrypoints: they never load
// `src/modules/index.js`, so nothing else registers an AgentMailbox and any
// path reaching `getAgentMailbox()` throws `No agent mailbox registered`.
// Importing it for side effect is idempotent — ESM evaluates it once.
import '../src/mailbox/compose.js';
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { cleanupOrphansStrict } from '../src/container-runtime.js';
import { closeDb, initDb, getRawDb } from '../src/db/connection.js';
import {
  isExactShippedMemoryScaffold,
  memoryTreeSha256,
  workgroupMemoryDir,
  workgroupMemoryManifestPath,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from '../src/modules/workgroup/shared-dirs.js';
import { reconcilePendingUpgradeContexts } from '../src/session-manager.js';

export type EntryType = 'missing' | 'directory' | 'file' | 'symlink' | 'unsupported';

export interface InventoryEntry {
  relativePath: string;
  type: Exclude<EntryType, 'missing'>;
  size: number;
  sha256: string;
  linkTarget?: string;
}

export interface MigrationSource {
  kind: 'canonical' | 'group' | 'provider-native';
  groupId?: string;
  folder?: string;
  provider?: 'claude';
  nativeProjectHash?: string;
  nativeRole?: 'memory' | 'opaque-projects-root' | 'opaque-project-root';
  rootPath: string;
  rootType: EntryType;
  rootSize: number;
  rootSha256: string;
  entries: InventoryEntry[];
  ignoredScaffold: boolean;
  verifiedCanonical?: boolean;
}

export interface MigrationOutcome {
  sourcePath: string;
  sourceGroup: string;
  relativePath: string;
  sha256: string;
  canonicalRelativePath: string;
  exactDuplicate: boolean;
}

export interface SnapshotEntry {
  sourcePath: string;
  sourceType: EntryType;
  snapshotPath?: string;
}

interface WorkgroupMigration {
  workgroupId: string;
  status: 'inventoried' | 'cutover-started' | 'applied' | 'blocked' | 'rolled-back';
  canonicalPath: string;
  sources: MigrationSource[];
  baseSource?: Pick<MigrationSource, 'kind' | 'groupId' | 'folder' | 'rootPath'>;
  snapshotDir?: string;
  snapshotEntries?: SnapshotEntry[];
  outcomes?: MigrationOutcome[];
  error?: string;
}

export interface MigrationReport {
  version: 1;
  createdAt: string;
  updatedAt: string;
  dbPath: string;
  groupsDir: string;
  dataDir: string;
  workgroups: WorkgroupMigration[];
}

interface InventoryOptions {
  db: Database.Database;
  dbPath: string;
  groupsDir?: string;
  dataDir?: string;
  workgroupIds?: string[];
  reportPath: string;
  now?: () => Date;
}

export interface ApplyHooks {
  proveQuiescence?: () => string[];
  afterSnapshot?: (workgroup: WorkgroupMigration) => void;
  afterStagingBuilt?: (workgroup: WorkgroupMigration, stagingPath: string) => void;
  now?: () => Date;
  trustedPaths?: () => { dbPath: string; groupsDir: string; dataDir: string };
}

interface TrustedPaths {
  dbPath: string;
  groupsDir: string;
  dataDir: string;
}

interface SnapshotManifest {
  version: 1;
  createdAt: string;
  workgroupId: string;
  sources: MigrationSource[];
  entries: SnapshotEntry[];
}

function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashBuffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return null;
  }
}

function typeOf(st: fs.Stats | null): EntryType {
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'unsupported';
}

function assertNoSymlinkedAncestors(root: string, target: string, label: string): void {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root`);
  }

  const parentRelative = path.relative(absoluteRoot, path.dirname(absoluteTarget));
  let current = absoluteRoot;
  for (const segment of parentRelative && parentRelative !== '.' ? parentRelative.split(path.sep) : []) {
    current = path.join(current, segment);
    const st = lstatOrNull(current);
    if (!st) break;
    if (st.isSymbolicLink()) throw new Error(`${label} has symlinked ancestor: ${current}`);
    if (!st.isDirectory()) throw new Error(`${label} has non-directory ancestor: ${current}`);
  }
}

function entryFor(root: string, absolutePath: string, relativePath: string): InventoryEntry {
  const st = fs.lstatSync(absolutePath);
  if (st.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(absolutePath);
    return {
      relativePath,
      type: 'symlink',
      size: Buffer.byteLength(linkTarget),
      sha256: hashBuffer(linkTarget),
      linkTarget,
    };
  }
  if (st.isFile()) {
    return {
      relativePath,
      type: 'file',
      size: st.size,
      sha256: hashBuffer(fs.readFileSync(absolutePath)),
    };
  }
  if (st.isDirectory()) {
    return {
      relativePath,
      type: 'directory',
      size: st.size,
      sha256: hashBuffer(`directory\0${path.relative(root, absolutePath)}`),
    };
  }
  return {
    relativePath,
    type: 'unsupported',
    size: st.size,
    sha256: hashBuffer(`unsupported\0${st.mode}\0${st.size}`),
  };
}

function walkInventory(root: string): InventoryEntry[] {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [entryFor(root, root, '')];

  const entries: InventoryEntry[] = [];
  const visit = (directory: string): void => {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareCodepoint(a.name, b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      const entry = entryFor(root, absolute, relative);
      entries.push(entry);
      if (entry.type === 'directory') visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function inventorySource(
  source: Pick<
    MigrationSource,
    'kind' | 'groupId' | 'folder' | 'provider' | 'nativeProjectHash' | 'nativeRole' | 'rootPath' | 'verifiedCanonical'
  >,
): MigrationSource {
  const st = lstatOrNull(source.rootPath);
  const rootType = typeOf(st);
  const entries = walkInventory(source.rootPath);
  const rootSha256 = hashBuffer(
    entries
      .map((entry) => `${entry.relativePath}\0${entry.type}\0${entry.size}\0${entry.sha256}\0${entry.linkTarget ?? ''}`)
      .join('\n'),
  );
  return {
    ...source,
    rootType,
    rootSize: st?.size ?? 0,
    rootSha256,
    entries,
    ignoredScaffold: rootType === 'directory' && isExactShippedMemoryScaffold(source.rootPath),
  };
}

function inventoryClaudeNativeSources(member: { id: string; folder: string }, dataDir: string): MigrationSource[] {
  const projectsRoot = path.join(dataDir, 'v2-sessions', member.id, '.claude-shared', 'projects');
  assertNoSymlinkedAncestors(dataDir, projectsRoot, `Claude projects source for ${member.id}`);
  const projectsStat = lstatOrNull(projectsRoot);
  if (!projectsStat) return [];
  if (projectsStat.isSymbolicLink() || !projectsStat.isDirectory()) {
    return [
      inventorySource({
        kind: 'provider-native',
        groupId: member.id,
        folder: member.folder,
        provider: 'claude',
        nativeProjectHash: '<projects-root>',
        nativeRole: 'opaque-projects-root',
        rootPath: projectsRoot,
      }),
    ];
  }

  const sources: MigrationSource[] = [];
  for (const projectHash of fs.readdirSync(projectsRoot).sort()) {
    const projectRoot = path.join(projectsRoot, projectHash);
    const projectStat = lstatOrNull(projectRoot);
    if (!projectStat) continue;
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
      sources.push(
        inventorySource({
          kind: 'provider-native',
          groupId: member.id,
          folder: member.folder,
          provider: 'claude',
          nativeProjectHash: projectHash,
          nativeRole: 'opaque-project-root',
          rootPath: projectRoot,
        }),
      );
      continue;
    }
    const memoryRoot = path.join(projectRoot, 'memory');
    if (!lstatOrNull(memoryRoot)) continue;
    assertNoSymlinkedAncestors(dataDir, memoryRoot, `Claude memory source for ${member.id}`);
    sources.push(
      inventorySource({
        kind: 'provider-native',
        groupId: member.id,
        folder: member.folder,
        provider: 'claude',
        nativeProjectHash: projectHash,
        nativeRole: 'memory',
        rootPath: memoryRoot,
      }),
    );
  }
  return sources;
}

function verifiedCanonical(workgroupId: string, dataDir: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(workgroupMemoryManifestPath(workgroupId, dataDir), 'utf8')) as {
      version?: number;
      workgroupId?: string;
      status?: string;
      snapshotDir?: string;
    };
    return (
      marker.version === 1 &&
      marker.workgroupId === workgroupId &&
      marker.status === 'applied' &&
      typeof marker.snapshotDir === 'string' &&
      fs.existsSync(marker.snapshotDir)
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function inventoryWorkgroup(
  db: Database.Database,
  workgroupId: string,
  groupsDir: string,
  dataDir: string,
): WorkgroupMigration {
  const members = db
    .prepare(`SELECT id, folder FROM agent_groups WHERE workgroup_id = ? ORDER BY folder, id`)
    .all(workgroupId) as Array<{ id: string; folder: string }>;
  const canonicalPath = workgroupMemoryDir(workgroupId, dataDir);
  assertNoSymlinkedAncestors(dataDir, canonicalPath, `Canonical memory source for ${workgroupId}`);
  for (const member of members) {
    assertNoSymlinkedAncestors(
      groupsDir,
      path.join(groupsDir, member.folder, 'memory'),
      `Group memory source for ${member.id}`,
    );
  }
  const sources: MigrationSource[] = [
    inventorySource({
      kind: 'canonical',
      rootPath: canonicalPath,
      verifiedCanonical: verifiedCanonical(workgroupId, dataDir),
    }),
    ...members.map((member) =>
      inventorySource({
        kind: 'group' as const,
        groupId: member.id,
        folder: member.folder,
        rootPath: path.join(groupsDir, member.folder, 'memory'),
      }),
    ),
    ...members.flatMap((member) => inventoryClaudeNativeSources(member, dataDir)),
  ];
  return { workgroupId, status: 'inventoried', canonicalPath, sources };
}

function writeJsonAtomic(target: string, value: unknown, exclusive = false): void {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  if (exclusive) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  const partial = `${target}.partial-${process.pid}`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(partial, target);
}

export function inventoryMigration(options: InventoryOptions): MigrationReport {
  const groupsDir = path.resolve(options.groupsDir ?? GROUPS_DIR);
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const requested = options.workgroupIds ? new Set(options.workgroupIds) : null;
  const ids = (options.db.prepare(`SELECT id FROM workgroups ORDER BY id`).all() as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((id) => !requested || requested.has(id));
  if (requested && ids.length !== requested.size) {
    const missing = [...requested].filter((id) => !ids.includes(id));
    throw new Error(`Unknown workgroup(s): ${missing.join(', ')}`);
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const report: MigrationReport = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    dbPath: path.resolve(options.dbPath),
    groupsDir,
    dataDir,
    workgroups: ids.map((id) => inventoryWorkgroup(options.db, id, groupsDir, dataDir)),
  };
  writeJsonAtomic(path.resolve(options.reportPath), report, true);
  return report;
}

const ENTRY_TYPES = new Set<EntryType>(['missing', 'directory', 'file', 'symlink', 'unsupported']);
const SOURCE_KINDS = new Set<MigrationSource['kind']>(['canonical', 'group', 'provider-native']);
const MIGRATION_STATUSES = new Set<WorkgroupMigration['status']>([
  'inventoried',
  'cutover-started',
  'applied',
  'blocked',
  'rolled-back',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function reportRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid workgroup memory migration report ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function reportString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid workgroup memory migration report ${label}: expected string`);
  }
  return value;
}

function reportNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid workgroup memory migration report ${label}: expected nonnegative integer`);
  }
  return value as number;
}

function reportSha(value: unknown, label: string): string {
  const sha = reportString(value, label);
  if (!SHA256_PATTERN.test(sha)) {
    throw new Error(`Invalid workgroup memory migration report ${label}: expected SHA-256`);
  }
  return sha;
}

function reportRelativePath(value: unknown, label: string): string {
  const relative = reportString(value, label, true);
  const normalized = path.normalize(relative);
  if (path.isAbsolute(relative) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid workgroup memory migration report ${label}: path escapes its root`);
  }
  return relative;
}

function reportPathSegment(value: unknown, label: string): string {
  const segment = reportString(value, label);
  if (
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Invalid workgroup memory migration report ${label}: expected one path segment`);
  }
  return segment;
}

function assertInventoryEntry(value: unknown, label: string): asserts value is InventoryEntry {
  const entry = reportRecord(value, label);
  reportRelativePath(entry.relativePath, `${label}.relativePath`);
  if (!ENTRY_TYPES.has(entry.type as EntryType) || entry.type === 'missing') {
    throw new Error(`Invalid workgroup memory migration report ${label}.type`);
  }
  reportNumber(entry.size, `${label}.size`);
  reportSha(entry.sha256, `${label}.sha256`);
  if (entry.linkTarget !== undefined) reportString(entry.linkTarget, `${label}.linkTarget`, true);
}

function assertMigrationSource(value: unknown, label: string): asserts value is MigrationSource {
  const source = reportRecord(value, label);
  if (!SOURCE_KINDS.has(source.kind as MigrationSource['kind'])) {
    throw new Error(`Invalid workgroup memory migration report ${label}.kind`);
  }
  if (source.groupId !== undefined) reportPathSegment(source.groupId, `${label}.groupId`);
  if (source.folder !== undefined) reportPathSegment(source.folder, `${label}.folder`);
  if (source.provider !== undefined && source.provider !== 'claude') {
    throw new Error(`Invalid workgroup memory migration report ${label}.provider`);
  }
  if (source.nativeProjectHash !== undefined && source.nativeProjectHash !== '<projects-root>') {
    reportPathSegment(source.nativeProjectHash, `${label}.nativeProjectHash`);
  }
  if (
    source.nativeRole !== undefined &&
    source.nativeRole !== 'memory' &&
    source.nativeRole !== 'opaque-projects-root' &&
    source.nativeRole !== 'opaque-project-root'
  ) {
    throw new Error(`Invalid workgroup memory migration report ${label}.nativeRole`);
  }
  const rootPath = reportString(source.rootPath, `${label}.rootPath`);
  if (!path.isAbsolute(rootPath)) throw new Error(`Invalid workgroup memory migration report ${label}.rootPath`);
  if (!ENTRY_TYPES.has(source.rootType as EntryType)) {
    throw new Error(`Invalid workgroup memory migration report ${label}.rootType`);
  }
  reportNumber(source.rootSize, `${label}.rootSize`);
  reportSha(source.rootSha256, `${label}.rootSha256`);
  if (!Array.isArray(source.entries)) throw new Error(`Invalid workgroup memory migration report ${label}.entries`);
  source.entries.forEach((entry, index) => assertInventoryEntry(entry, `${label}.entries[${index}]`));
  if (typeof source.ignoredScaffold !== 'boolean') {
    throw new Error(`Invalid workgroup memory migration report ${label}.ignoredScaffold`);
  }
  if (source.verifiedCanonical !== undefined && typeof source.verifiedCanonical !== 'boolean') {
    throw new Error(`Invalid workgroup memory migration report ${label}.verifiedCanonical`);
  }
}

function assertSnapshotEntry(value: unknown, label: string): asserts value is SnapshotEntry {
  const entry = reportRecord(value, label);
  const sourcePath = reportString(entry.sourcePath, `${label}.sourcePath`);
  if (!path.isAbsolute(sourcePath)) throw new Error(`Invalid workgroup memory migration report ${label}.sourcePath`);
  if (!ENTRY_TYPES.has(entry.sourceType as EntryType)) {
    throw new Error(`Invalid workgroup memory migration report ${label}.sourceType`);
  }
  if (entry.snapshotPath !== undefined) {
    const snapshotPath = reportString(entry.snapshotPath, `${label}.snapshotPath`);
    if (!path.isAbsolute(snapshotPath)) {
      throw new Error(`Invalid workgroup memory migration report ${label}.snapshotPath`);
    }
  }
}

function assertMigrationOutcome(value: unknown, label: string): asserts value is MigrationOutcome {
  const outcome = reportRecord(value, label);
  const sourcePath = reportString(outcome.sourcePath, `${label}.sourcePath`);
  if (!path.isAbsolute(sourcePath)) throw new Error(`Invalid workgroup memory migration report ${label}.sourcePath`);
  reportString(outcome.sourceGroup, `${label}.sourceGroup`);
  reportRelativePath(outcome.relativePath, `${label}.relativePath`);
  reportSha(outcome.sha256, `${label}.sha256`);
  reportRelativePath(outcome.canonicalRelativePath, `${label}.canonicalRelativePath`);
  if (typeof outcome.exactDuplicate !== 'boolean') {
    throw new Error(`Invalid workgroup memory migration report ${label}.exactDuplicate`);
  }
}

function assertMigrationReport(value: unknown, label: string): asserts value is MigrationReport {
  const report = reportRecord(value, label);
  if (report.version !== 1) throw new Error(`Unsupported workgroup memory migration report: ${label}`);
  reportString(report.createdAt, `${label}.createdAt`);
  reportString(report.updatedAt, `${label}.updatedAt`);
  for (const key of ['dbPath', 'groupsDir', 'dataDir'] as const) {
    const target = reportString(report[key], `${label}.${key}`);
    if (!path.isAbsolute(target)) throw new Error(`Invalid workgroup memory migration report ${label}.${key}`);
  }
  if (!Array.isArray(report.workgroups)) {
    throw new Error(`Invalid workgroup memory migration report ${label}.workgroups`);
  }
  const seen = new Set<string>();
  report.workgroups.forEach((value, index) => {
    const migration = reportRecord(value, `${label}.workgroups[${index}]`);
    const workgroupId = reportPathSegment(migration.workgroupId, `${label}.workgroups[${index}].workgroupId`);
    if (seen.has(workgroupId)) throw new Error(`Duplicate workgroup in migration report: ${workgroupId}`);
    seen.add(workgroupId);
    if (!MIGRATION_STATUSES.has(migration.status as WorkgroupMigration['status'])) {
      throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].status`);
    }
    const canonicalPath = reportString(migration.canonicalPath, `${label}.workgroups[${index}].canonicalPath`);
    if (!path.isAbsolute(canonicalPath)) {
      throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].canonicalPath`);
    }
    if (!Array.isArray(migration.sources)) {
      throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].sources`);
    }
    migration.sources.forEach((source, sourceIndex) =>
      assertMigrationSource(source, `${label}.workgroups[${index}].sources[${sourceIndex}]`),
    );
    if (migration.baseSource !== undefined) {
      const base = reportRecord(migration.baseSource, `${label}.workgroups[${index}].baseSource`);
      if (!SOURCE_KINDS.has(base.kind as MigrationSource['kind'])) {
        throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].baseSource.kind`);
      }
      if (base.groupId !== undefined) {
        reportPathSegment(base.groupId, `${label}.workgroups[${index}].baseSource.groupId`);
      }
      if (base.folder !== undefined) {
        reportPathSegment(base.folder, `${label}.workgroups[${index}].baseSource.folder`);
      }
      const rootPath = reportString(base.rootPath, `${label}.workgroups[${index}].baseSource.rootPath`);
      if (!path.isAbsolute(rootPath)) {
        throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].baseSource.rootPath`);
      }
    }
    if (migration.snapshotDir !== undefined) {
      const snapshotDir = reportString(migration.snapshotDir, `${label}.workgroups[${index}].snapshotDir`);
      if (!path.isAbsolute(snapshotDir)) {
        throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].snapshotDir`);
      }
    }
    if (migration.snapshotEntries !== undefined) {
      if (!Array.isArray(migration.snapshotEntries)) {
        throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].snapshotEntries`);
      }
      migration.snapshotEntries.forEach((entry, entryIndex) =>
        assertSnapshotEntry(entry, `${label}.workgroups[${index}].snapshotEntries[${entryIndex}]`),
      );
    }
    if (migration.outcomes !== undefined) {
      if (!Array.isArray(migration.outcomes)) {
        throw new Error(`Invalid workgroup memory migration report ${label}.workgroups[${index}].outcomes`);
      }
      migration.outcomes.forEach((outcome, outcomeIndex) =>
        assertMigrationOutcome(outcome, `${label}.workgroups[${index}].outcomes[${outcomeIndex}]`),
      );
    }
    if (migration.error !== undefined) reportString(migration.error, `${label}.workgroups[${index}].error`, true);
  });
}

export function parseMigrationReport(value: unknown, label = 'value'): MigrationReport {
  assertMigrationReport(value, label);
  return value;
}

export function readMigrationReport(reportPath: string): MigrationReport {
  return parseMigrationReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown, reportPath);
}

function resolveTrustedPaths(hooks: ApplyHooks): TrustedPaths {
  const configured = hooks.trustedPaths?.() ?? {
    dbPath: path.join(DATA_DIR, 'v2.db'),
    groupsDir: GROUPS_DIR,
    dataDir: DATA_DIR,
  };
  return {
    dbPath: path.resolve(configured.dbPath),
    groupsDir: path.resolve(configured.groupsDir),
    dataDir: path.resolve(configured.dataDir),
  };
}

function assertExactPath(actual: string, expected: string, label: string): void {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`Migration report ${label} does not match trusted runtime path`);
  }
}

function assertReportRoots(report: MigrationReport, trusted: TrustedPaths): void {
  assertExactPath(report.dbPath, trusted.dbPath, 'dbPath');
  assertExactPath(report.groupsDir, trusted.groupsDir, 'groupsDir');
  assertExactPath(report.dataDir, trusted.dataDir, 'dataDir');
}

function assertMigrationAuthority(report: MigrationReport, trusted: TrustedPaths, db: Database.Database): void {
  assertReportRoots(report, trusted);
  for (const migration of report.workgroups) {
    const workgroup = db.prepare(`SELECT id FROM workgroups WHERE id = ?`).get(migration.workgroupId) as
      | { id: string }
      | undefined;
    if (!workgroup) throw new Error(`Migration report references unknown workgroup: ${migration.workgroupId}`);

    const members = db
      .prepare(`SELECT id, folder FROM agent_groups WHERE workgroup_id = ? ORDER BY folder, id`)
      .all(migration.workgroupId) as Array<{ id: string; folder: string }>;
    const membersById = new Map(members.map((member) => [member.id, member]));
    const expectedCanonical = workgroupMemoryDir(migration.workgroupId, trusted.dataDir);
    assertExactPath(migration.canonicalPath, expectedCanonical, `${migration.workgroupId}.canonicalPath`);

    const canonicalSources = migration.sources.filter((source) => source.kind === 'canonical');
    if (canonicalSources.length !== 1) {
      throw new Error(`Migration report must contain exactly one canonical source for ${migration.workgroupId}`);
    }
    const seenRootPaths = new Set<string>();
    const seenGroupIds = new Set<string>();
    for (const source of migration.sources) {
      const resolvedRoot = path.resolve(source.rootPath);
      if (seenRootPaths.has(resolvedRoot)) {
        throw new Error(`Migration report contains duplicate source path: ${source.rootPath}`);
      }
      seenRootPaths.add(resolvedRoot);

      if (source.kind === 'canonical') {
        if (
          source.groupId !== undefined ||
          source.folder !== undefined ||
          source.provider !== undefined ||
          source.nativeProjectHash !== undefined ||
          source.nativeRole !== undefined
        ) {
          throw new Error(`Canonical source has provider or group identity fields for ${migration.workgroupId}`);
        }
        assertExactPath(source.rootPath, expectedCanonical, `${migration.workgroupId}.canonical source`);
        continue;
      }

      if (!source.groupId || !source.folder) {
        throw new Error(`Migration source is missing its group identity for ${migration.workgroupId}`);
      }
      const member = membersById.get(source.groupId);
      if (!member || member.folder !== source.folder) {
        throw new Error(`Migration source group is not a current member of ${migration.workgroupId}`);
      }

      if (source.kind === 'group') {
        if (
          source.provider !== undefined ||
          source.nativeProjectHash !== undefined ||
          source.nativeRole !== undefined
        ) {
          throw new Error(`Group source has provider-native fields for ${source.groupId}`);
        }
        if (seenGroupIds.has(source.groupId)) {
          throw new Error(`Migration report contains duplicate group source for ${source.groupId}`);
        }
        seenGroupIds.add(source.groupId);
        assertExactPath(
          source.rootPath,
          path.join(trusted.groupsDir, member.folder, 'memory'),
          `${migration.workgroupId}.${source.groupId}.group source`,
        );
        continue;
      }

      if (source.provider !== 'claude' || !source.nativeProjectHash || !source.nativeRole) {
        throw new Error(`Provider-native source has incomplete identity for ${source.groupId}`);
      }
      const projectsRoot = path.join(trusted.dataDir, 'v2-sessions', member.id, '.claude-shared', 'projects');
      if (source.nativeRole === 'opaque-projects-root') {
        if (source.nativeProjectHash !== '<projects-root>') {
          throw new Error(`Opaque projects root has invalid project identity for ${source.groupId}`);
        }
        assertExactPath(source.rootPath, projectsRoot, `${migration.workgroupId}.${source.groupId}.projects root`);
        continue;
      }
      if (source.nativeProjectHash === '<projects-root>') {
        throw new Error(`Provider-native project source has invalid project identity for ${source.groupId}`);
      }
      const projectRoot = path.join(projectsRoot, source.nativeProjectHash);
      assertExactPath(
        source.rootPath,
        source.nativeRole === 'memory' ? path.join(projectRoot, 'memory') : projectRoot,
        `${migration.workgroupId}.${source.groupId}.provider source`,
      );
    }

    if (seenGroupIds.size !== members.length || members.some((member) => !seenGroupIds.has(member.id))) {
      throw new Error(
        `Migration report group-source roster does not match current members of ${migration.workgroupId}`,
      );
    }
    const currentSources = inventoryWorkgroup(db, migration.workgroupId, trusted.groupsDir, trusted.dataDir).sources;
    if (!sourceRosterEqual(migration.sources, currentSources)) {
      throw new Error(
        `Migration report source roster does not match current runtime sources for ${migration.workgroupId}`,
      );
    }

    if (migration.baseSource) {
      const matches = migration.sources.filter(
        (source) =>
          source.kind === migration.baseSource!.kind &&
          source.groupId === migration.baseSource!.groupId &&
          source.folder === migration.baseSource!.folder &&
          path.resolve(source.rootPath) === path.resolve(migration.baseSource!.rootPath),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Migration report base source is not in the trusted source roster for ${migration.workgroupId}`,
        );
      }
    }

    if (migration.snapshotEntries) {
      if (migration.snapshotEntries.length !== migration.sources.length) {
        throw new Error(`Migration report snapshot roster is incomplete for ${migration.workgroupId}`);
      }
      migration.snapshotEntries.forEach((entry, index) => {
        const source = migration.sources[index]!;
        assertExactPath(entry.sourcePath, source.rootPath, `${migration.workgroupId}.snapshot source ${index}`);
        if (entry.sourceType !== source.rootType) {
          throw new Error(`Migration report snapshot type mismatch for ${source.rootPath}`);
        }
      });
    }

    for (const outcome of migration.outcomes ?? []) {
      if (!migration.sources.some((source) => path.resolve(source.rootPath) === path.resolve(outcome.sourcePath))) {
        throw new Error(`Migration outcome source is outside the trusted roster for ${migration.workgroupId}`);
      }
    }
  }
}

function assertSnapshotManifest(value: unknown, label: string): asserts value is SnapshotManifest {
  const manifest = reportRecord(value, label);
  if (manifest.version !== 1) throw new Error(`Unsupported workgroup memory snapshot manifest: ${label}`);
  reportString(manifest.createdAt, `${label}.createdAt`);
  reportPathSegment(manifest.workgroupId, `${label}.workgroupId`);
  if (!Array.isArray(manifest.sources)) {
    throw new Error(`Invalid workgroup memory snapshot manifest ${label}.sources`);
  }
  manifest.sources.forEach((source, index) => assertMigrationSource(source, `${label}.sources[${index}]`));
  if (!Array.isArray(manifest.entries)) {
    throw new Error(`Invalid workgroup memory snapshot manifest ${label}.entries`);
  }
  manifest.entries.forEach((entry, index) => assertSnapshotEntry(entry, `${label}.entries[${index}]`));
}

function normalizedSourceInventory(source: MigrationSource): Omit<MigrationSource, 'rootSha256' | 'entries'> & {
  entries: InventoryEntry[];
} {
  const { rootSha256: _rootSha256, entries, ...rest } = source;
  return {
    ...rest,
    entries: [...entries].sort((left, right) => compareCodepoint(left.relativePath, right.relativePath)),
  };
}

function sourceInventoryEqual(expected: MigrationSource, actual: MigrationSource): boolean {
  return JSON.stringify(normalizedSourceInventory(expected)) === JSON.stringify(normalizedSourceInventory(actual));
}

function inventoryEntriesEqual(expected: InventoryEntry[], actual: InventoryEntry[]): boolean {
  const normalize = (entries: InventoryEntry[]) =>
    [...entries].sort((left, right) => compareCodepoint(left.relativePath, right.relativePath));
  return JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual));
}

function sourcesEqual(expected: MigrationSource[], actual: MigrationSource[]): boolean {
  return (
    expected.length === actual.length && expected.every((source, index) => sourceInventoryEqual(source, actual[index]!))
  );
}

function sourceRosterEqual(expected: MigrationSource[], actual: MigrationSource[]): boolean {
  const identity = (source: MigrationSource): Record<string, string | boolean | undefined> => ({
    kind: source.kind,
    groupId: source.groupId,
    folder: source.folder,
    provider: source.provider,
    nativeProjectHash: source.nativeProjectHash,
    nativeRole: source.nativeRole,
    rootPath: path.resolve(source.rootPath),
  });
  return JSON.stringify(expected.map(identity)) === JSON.stringify(actual.map(identity));
}

function copyRootExact(source: string, destination: string, type: EntryType): void {
  if (type === 'directory') {
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
  } else if (type === 'file') {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else if (type === 'symlink') {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (type === 'unsupported') {
    throw new Error(`Unsupported filesystem entry blocks migration: ${source}`);
  }
}

function snapshotEntryPath(snapshotDir: string, source: MigrationSource, index: number): string {
  const label = source.kind === 'canonical' ? 'canonical' : `group-${source.folder}`;
  return path.join(snapshotDir, 'sources', `${String(index).padStart(3, '0')}-${label}`, 'root');
}

function snapshotWorkgroup(
  migration: WorkgroupMigration,
  report: MigrationReport,
  now: () => Date,
): { snapshotDir: string; entries: SnapshotEntry[] } {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const suffix = hashBuffer(`${report.createdAt}\0${migration.workgroupId}\0${migration.sources.length}`).slice(0, 12);
  const snapshotDir = path.join(
    report.dataDir,
    'workgroup-memory-snapshots',
    migration.workgroupId,
    `${stamp}-${suffix}`,
  );
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: false });
  const entries: SnapshotEntry[] = [];
  migration.sources.forEach((source, index) => {
    const snapshotPath = snapshotEntryPath(snapshotDir, source, index);
    const entry: SnapshotEntry = {
      sourcePath: source.rootPath,
      sourceType: source.rootType,
      snapshotPath: source.rootType === 'missing' ? undefined : snapshotPath,
    };
    if (source.rootType !== 'missing') {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      copyRootExact(source.rootPath, snapshotPath, source.rootType);
      const snapInventory = inventorySource({ kind: source.kind, rootPath: snapshotPath });
      if (snapInventory.rootType !== source.rootType || !inventoryEntriesEqual(source.entries, snapInventory.entries)) {
        throw new Error(`Snapshot verification failed for ${source.rootPath}`);
      }
    }
    entries.push(entry);
  });
  writeJsonAtomic(path.join(snapshotDir, 'snapshot.json'), {
    version: 1,
    createdAt: now().toISOString(),
    workgroupId: migration.workgroupId,
    sources: migration.sources,
    entries,
  });
  return { snapshotDir, entries };
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function assertDirectoryChainNoSymlink(root: string, target: string, label: string): void {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (absoluteTarget !== absoluteRoot && !isStrictlyWithin(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} escapes its trusted root`);
  }
  const relative = path.relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${label} contains a non-directory or symlink ancestor: ${current}`);
    }
  }
}

function verifySnapshotForRollback(migration: WorkgroupMigration, trusted: TrustedPaths): void {
  if (!migration.snapshotDir || !migration.snapshotEntries) {
    throw new Error('Permanent snapshot missing; rollback refused');
  }
  const snapshotRoot = path.join(trusted.dataDir, 'workgroup-memory-snapshots', migration.workgroupId);
  const snapshotDir = path.resolve(migration.snapshotDir);
  if (!isStrictlyWithin(snapshotRoot, snapshotDir)) {
    throw new Error(`Snapshot directory is outside the trusted workgroup root: ${migration.snapshotDir}`);
  }
  const snapshotRootStat = lstatOrNull(snapshotRoot);
  const snapshotStat = lstatOrNull(snapshotDir);
  if (
    !snapshotRootStat?.isDirectory() ||
    snapshotRootStat.isSymbolicLink() ||
    !snapshotStat?.isDirectory() ||
    snapshotStat.isSymbolicLink()
  ) {
    throw new Error(`Permanent snapshot directory is missing or unsafe: ${migration.snapshotDir}`);
  }
  assertDirectoryChainNoSymlink(snapshotRoot, snapshotDir, 'Snapshot directory');
  if (!isStrictlyWithin(fs.realpathSync(snapshotRoot), fs.realpathSync(snapshotDir))) {
    throw new Error(`Snapshot directory resolves outside the trusted workgroup root: ${migration.snapshotDir}`);
  }

  const manifestPath = path.join(snapshotDir, 'snapshot.json');
  const manifestStat = lstatOrNull(manifestPath);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Snapshot manifest is missing or unsafe: ${manifestPath}`);
  }
  const manifestValue = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  assertSnapshotManifest(manifestValue, manifestPath);
  const manifest = manifestValue;
  if (
    manifest.workgroupId !== migration.workgroupId ||
    !sourcesEqual(manifest.sources, migration.sources) ||
    JSON.stringify(manifest.entries) !== JSON.stringify(migration.snapshotEntries)
  ) {
    throw new Error(`Snapshot manifest does not match migration report for ${migration.workgroupId}`);
  }
  if (migration.snapshotEntries.length !== migration.sources.length) {
    throw new Error(`Snapshot roster is incomplete for ${migration.workgroupId}`);
  }

  migration.sources.forEach((source, index) => {
    const entry = migration.snapshotEntries![index]!;
    assertExactPath(entry.sourcePath, source.rootPath, `${migration.workgroupId}.snapshot source ${index}`);
    if (entry.sourceType !== source.rootType) {
      throw new Error(`Snapshot source type mismatch for ${source.rootPath}`);
    }
    if (source.rootType === 'missing') {
      if (entry.snapshotPath !== undefined) {
        throw new Error(`Missing source unexpectedly has snapshot bytes: ${source.rootPath}`);
      }
      return;
    }

    const expectedSnapshotPath = snapshotEntryPath(snapshotDir, source, index);
    if (!entry.snapshotPath) throw new Error(`Snapshot root missing for rollback: ${source.rootPath}`);
    assertExactPath(entry.snapshotPath, expectedSnapshotPath, `${migration.workgroupId}.snapshot path ${index}`);
    assertDirectoryChainNoSymlink(snapshotDir, path.dirname(expectedSnapshotPath), 'Snapshot source path');
    const snapshotInventory = inventorySource({ kind: source.kind, rootPath: expectedSnapshotPath });
    if (
      snapshotInventory.rootType !== source.rootType ||
      !inventoryEntriesEqual(source.entries, snapshotInventory.entries)
    ) {
      throw new Error(`Snapshot checksum mismatch for ${source.rootPath}`);
    }
  });
}

function activeSources(migration: WorkgroupMigration): MigrationSource[] {
  return migration.sources.filter((source) => {
    if (source.rootType === 'missing' || source.ignoredScaffold) return false;
    if (source.rootType === 'symlink' && source.entries[0]?.linkTarget === WORKGROUP_MEMORY_CONTAINER_PATH) {
      return false;
    }
    if (
      source.kind === 'provider-native' &&
      source.nativeRole === 'memory' &&
      source.rootType === 'symlink' &&
      source.entries[0]?.linkTarget === migration.canonicalPath
    ) {
      return false;
    }
    return true;
  });
}

function chooseBase(migration: WorkgroupMigration): MigrationSource | undefined {
  const active = activeSources(migration);
  for (const source of active) {
    if (source.rootType !== 'directory') {
      throw new Error(`Unsupported or opaque memory root blocks migration: ${source.rootPath} (${source.rootType})`);
    }
    const nestedSymlink = source.entries.find((entry) => entry.type === 'symlink');
    if (nestedSymlink) {
      throw new Error(
        `Nested symlink blocks memory activation: ${path.join(source.rootPath, nestedSymlink.relativePath)}`,
      );
    }
    if (source.entries.some((entry) => entry.type === 'unsupported')) {
      throw new Error(`Unsupported filesystem entry blocks migration: ${source.rootPath}`);
    }
  }
  return (
    active.find((source) => source.kind === 'canonical' && source.verifiedCanonical) ??
    active.find((source) => source.kind === 'group' && source.folder === migration.workgroupId) ??
    [...active].sort((a, b) => compareCodepoint(a.rootPath, b.rootPath))[0]
  );
}

function leafEntries(source: MigrationSource): InventoryEntry[] {
  return source.entries.filter((entry) => entry.type === 'file' || entry.type === 'symlink');
}

function inspectLeaf(target: string): Pick<InventoryEntry, 'type' | 'size' | 'sha256' | 'linkTarget'> | null {
  const st = lstatOrNull(target);
  if (!st) return null;
  const entry = entryFor(path.dirname(target), target, path.basename(target));
  return entry.type === 'file' || entry.type === 'symlink' ? entry : null;
}

function sameLeaf(
  actual: Pick<InventoryEntry, 'type' | 'size' | 'sha256' | 'linkTarget'> | null,
  expected: InventoryEntry,
): boolean {
  return (
    actual?.type === expected.type &&
    actual.size === expected.size &&
    actual.sha256 === expected.sha256 &&
    actual.linkTarget === expected.linkTarget
  );
}

function canCreateAt(root: string, relative: string): boolean {
  let current = path.dirname(relative);
  while (current && current !== '.') {
    const target = path.join(root, current);
    const st = lstatOrNull(target);
    if (st && !st.isDirectory()) return false;
    current = path.dirname(current);
  }
  return !lstatOrNull(path.join(root, relative));
}

function copyLeaf(sourceRoot: string, relative: string, destinationRoot: string, destinationRelative: string): void {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(destinationRoot, destinationRelative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const st = fs.lstatSync(source);
  if (st.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else {
    throw new Error(`Non-leaf entry passed to copyLeaf: ${source}`);
  }
}

function sourceLabel(source: MigrationSource): string {
  if (source.kind === 'provider-native') {
    return `${source.folder ?? source.groupId ?? 'unknown'}-claude-${source.nativeProjectHash ?? 'unknown'}`;
  }
  return source.kind === 'canonical' ? 'canonical' : (source.folder ?? source.groupId ?? 'unknown');
}

function sourceTreeKey(source: MigrationSource): string {
  return JSON.stringify(
    source.entries.map((entry) => [entry.relativePath, entry.type, entry.size, entry.sha256, entry.linkTarget ?? null]),
  );
}

function canPlaceSourceAt(staging: string, source: MigrationSource, prefix: string): boolean {
  for (const entry of source.entries) {
    const relative = prefix ? path.join(prefix, entry.relativePath) : entry.relativePath;
    const target = path.join(staging, relative);
    const existing = lstatOrNull(target);
    if (entry.type === 'directory') {
      if (existing && !existing.isDirectory()) return false;
      if (!existing && !canCreateAt(staging, relative)) return false;
      continue;
    }
    if (entry.type !== 'file' && entry.type !== 'symlink') continue;
    if (existing && !sameLeaf(inspectLeaf(target), entry)) return false;
    if (!existing && !canCreateAt(staging, relative)) return false;
  }
  return true;
}

function collisionTreePrefix(staging: string, source: MigrationSource): string {
  const base = path.join('imports', sourceLabel(source), '__collisions', `tree-${source.rootSha256}`);
  if (canPlaceSourceAt(staging, source, base)) return base;
  for (let ordinal = 2; ordinal <= 10_000; ordinal++) {
    const candidate = `${base}-${ordinal}`;
    if (canPlaceSourceAt(staging, source, candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a collision-safe tree for ${source.rootPath}`);
}

function buildCanonical(
  migration: WorkgroupMigration,
  staging: string,
): { base: MigrationSource | undefined; outcomes: MigrationOutcome[] } {
  const base = chooseBase(migration);
  fs.mkdirSync(staging);
  const outcomes: MigrationOutcome[] = [];
  const selectedTrees = new Map<string, string>();

  if (base) {
    for (const entry of base.entries.filter((item) => item.type === 'directory')) {
      fs.mkdirSync(path.join(staging, entry.relativePath), { recursive: true });
    }
    for (const entry of leafEntries(base)) {
      copyLeaf(base.rootPath, entry.relativePath, staging, entry.relativePath);
      outcomes.push({
        sourcePath: base.rootPath,
        sourceGroup: sourceLabel(base),
        relativePath: entry.relativePath,
        sha256: entry.sha256,
        canonicalRelativePath: entry.relativePath,
        exactDuplicate: false,
      });
    }
    selectedTrees.set(sourceTreeKey(base), '');
  }

  for (const source of activeSources(migration)) {
    if (source === base) continue;
    const treeKey = sourceTreeKey(source);
    const selectedTree = selectedTrees.get(treeKey);
    const importPrefix = path.join('imports', sourceLabel(source));
    const prefix =
      selectedTree ??
      (canPlaceSourceAt(staging, source, importPrefix) &&
      source.entries.some((entry) => lstatOrNull(path.join(staging, importPrefix, entry.relativePath)))
        ? importPrefix
        : canPlaceSourceAt(staging, source, '')
          ? ''
          : canPlaceSourceAt(staging, source, importPrefix)
            ? importPrefix
            : collisionTreePrefix(staging, source));

    for (const entry of source.entries.filter((item) => item.type === 'directory')) {
      const relative = prefix ? path.join(prefix, entry.relativePath) : entry.relativePath;
      fs.mkdirSync(path.join(staging, relative), { recursive: true });
    }
    for (const entry of leafEntries(source)) {
      const destinationRelative = prefix ? path.join(prefix, entry.relativePath) : entry.relativePath;
      const exactDuplicate = sameLeaf(inspectLeaf(path.join(staging, destinationRelative)), entry);
      if (!exactDuplicate) {
        copyLeaf(source.rootPath, entry.relativePath, staging, destinationRelative);
      }
      outcomes.push({
        sourcePath: source.rootPath,
        sourceGroup: sourceLabel(source),
        relativePath: entry.relativePath,
        sha256: entry.sha256,
        canonicalRelativePath: destinationRelative,
        exactDuplicate,
      });
    }
    if (!selectedTrees.has(treeKey)) selectedTrees.set(treeKey, prefix);
  }
  return { base, outcomes };
}

function verifyCutoverIntegrity(
  migration: WorkgroupMigration,
  freshSources: MigrationSource[],
  staging: string,
  outcomes: MigrationOutcome[],
): void {
  if (!sourcesEqual(migration.sources, freshSources)) {
    throw new Error('Sources changed during final cutover verification');
  }

  const expectedLeaves = activeSources(migration).flatMap((source) =>
    leafEntries(source).map((entry) => ({ source, entry })),
  );
  if (outcomes.length !== expectedLeaves.length) {
    throw new Error(
      `Migration outcome coverage mismatch: expected ${expectedLeaves.length}, recorded ${outcomes.length}`,
    );
  }

  for (const { source, entry } of expectedLeaves) {
    const matching = outcomes.filter(
      (outcome) => outcome.sourcePath === source.rootPath && outcome.relativePath === entry.relativePath,
    );
    if (matching.length !== 1) {
      throw new Error(
        `Migration outcome coverage mismatch for ${source.rootPath}:${entry.relativePath}: ` +
          `expected exactly one, recorded ${matching.length}`,
      );
    }
    const outcome = matching[0];
    const destination = inspectLeaf(path.join(staging, outcome.canonicalRelativePath));
    if (
      outcome.sha256 !== entry.sha256 ||
      !destination ||
      destination.type !== entry.type ||
      destination.size !== entry.size ||
      destination.sha256 !== entry.sha256 ||
      destination.linkTarget !== entry.linkTarget
    ) {
      throw new Error(
        `Staging outcome mismatch for ${source.rootPath}:${entry.relativePath} at ` +
          `${outcome.canonicalRelativePath}`,
      );
    }
  }
}

function removePath(target: string): void {
  const st = lstatOrNull(target);
  if (!st) return;
  if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(target, { recursive: true });
  else fs.unlinkSync(target);
}

function restoreSnapshotEntries(migration: WorkgroupMigration, preserveCanonicalPath?: string): void {
  if (!migration.snapshotDir || !migration.snapshotEntries) {
    throw new Error(`Permanent snapshot missing for ${migration.workgroupId}`);
  }
  const staged: Array<{ entry: SnapshotEntry; stagingPath?: string }> = [];
  const suffix = hashBuffer(migration.snapshotDir).slice(0, 12);
  try {
    for (const [index, entry] of migration.snapshotEntries.entries()) {
      if (preserveCanonicalPath && entry.sourcePath === preserveCanonicalPath) continue;
      if (entry.sourceType === 'missing') {
        staged.push({ entry });
        continue;
      }
      if (!entry.snapshotPath || !lstatOrNull(entry.snapshotPath)) {
        throw new Error(`Snapshot root missing for rollback: ${entry.sourcePath}`);
      }
      const stagingPath = `${entry.sourcePath}.rollback-staging-${suffix}-${String(index).padStart(3, '0')}`;
      if (lstatOrNull(stagingPath)) throw new Error(`Rollback staging path already exists: ${stagingPath}`);
      fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
      copyRootExact(entry.snapshotPath, stagingPath, entry.sourceType);
      const source = migration.sources[index]!;
      const stagedInventory = inventorySource({ kind: source.kind, rootPath: stagingPath });
      if (
        stagedInventory.rootType !== source.rootType ||
        !inventoryEntriesEqual(source.entries, stagedInventory.entries)
      ) {
        throw new Error(`Rollback staging verification failed for ${entry.sourcePath}`);
      }
      staged.push({ entry, stagingPath });
    }

    for (const prepared of staged) {
      const { entry, stagingPath } = prepared;
      removePath(entry.sourcePath);
      if (!stagingPath) continue;
      fs.renameSync(stagingPath, entry.sourcePath);
      delete prepared.stagingPath;
    }
  } finally {
    for (const prepared of staged) {
      if (prepared.stagingPath) removePath(prepared.stagingPath);
    }
  }
}

function preservePostMigrationCanonical(migration: WorkgroupMigration): string | undefined {
  const originalCanonical = migration.sources.find((source) => source.kind === 'canonical');
  return originalCanonical?.rootType === 'missing' ? migration.canonicalPath : undefined;
}

function writeAppliedMarker(
  reportPath: string,
  dataDir: string,
  migration: WorkgroupMigration,
  status: 'applied' | 'rolled-back',
): void {
  writeJsonAtomic(workgroupMemoryManifestPath(migration.workgroupId, dataDir), {
    version: 1,
    workgroupId: migration.workgroupId,
    status,
    reportPath: path.resolve(reportPath),
    snapshotDir: migration.snapshotDir,
    canonicalSha256: lstatOrNull(migration.canonicalPath) ? memoryTreeSha256(migration.canonicalPath) : null,
    updatedAt: new Date().toISOString(),
  });
}

export function applyMigrationReport(reportPath: string, hooks: ApplyHooks = {}): MigrationReport {
  const absoluteReport = path.resolve(reportPath);
  const report = readMigrationReport(absoluteReport);
  const trusted = resolveTrustedPaths(hooks);
  assertReportRoots(report, trusted);
  const proveQuiescence = hooks.proveQuiescence ?? cleanupOrphansStrict;
  const now = hooks.now ?? (() => new Date());
  const db = new Database(trusted.dbPath, { readonly: true, fileMustExist: true });
  try {
    assertMigrationAuthority(report, trusted, db);
    const interrupted = report.workgroups.filter((migration) => migration.status === 'cutover-started');
    if (interrupted.length > 0) {
      throw new Error(
        `Migration report contains interrupted cutover for workgroup(s): ${interrupted
          .map((migration) => migration.workgroupId)
          .join(', ')}; run rollback before apply`,
      );
    }
    proveQuiescence();
    for (const migration of report.workgroups) {
      if (migration.status !== 'inventoried') continue;
      let staging: string | null = null;
      let cutoverStarted = false;
      try {
        const fresh = inventoryWorkgroup(db, migration.workgroupId, trusted.groupsDir, trusted.dataDir);
        if (
          path.resolve(migration.canonicalPath) !== path.resolve(fresh.canonicalPath) ||
          !sourcesEqual(migration.sources, fresh.sources)
        ) {
          throw new Error('Sources changed since inventory; create a new report');
        }
        const snapshot = snapshotWorkgroup(migration, report, now);
        migration.snapshotDir = snapshot.snapshotDir;
        migration.snapshotEntries = snapshot.entries;
        report.updatedAt = now().toISOString();
        writeJsonAtomic(absoluteReport, report);
        hooks.afterSnapshot?.(migration);

        // Load and hash again while quiescent immediately before any source or
        // canonical path is replaced.
        const postSnapshot = inventoryWorkgroup(db, migration.workgroupId, trusted.groupsDir, trusted.dataDir);
        if (!sourcesEqual(migration.sources, postSnapshot.sources)) {
          throw new Error('Source changed after snapshot; refusing cutover');
        }
        proveQuiescence();

        staging = `${migration.canonicalPath}.staging-${path.basename(snapshot.snapshotDir)}`;
        if (fs.existsSync(staging)) throw new Error(`Canonical staging path already exists: ${staging}`);
        fs.mkdirSync(path.dirname(staging), { recursive: true });
        const built = buildCanonical(migration, staging);

        migration.baseSource = built.base
          ? {
              kind: built.base.kind,
              groupId: built.base.groupId,
              folder: built.base.folder,
              rootPath: built.base.rootPath,
            }
          : undefined;
        migration.outcomes = built.outcomes;
        migration.status = 'cutover-started';
        report.updatedAt = now().toISOString();
        writeJsonAtomic(absoluteReport, report);
        hooks.afterStagingBuilt?.(migration, staging);
        proveQuiescence();
        const finalInventory = inventoryWorkgroup(db, migration.workgroupId, trusted.groupsDir, trusted.dataDir);
        verifyCutoverIntegrity(migration, finalInventory.sources, staging, built.outcomes);
        verifySnapshotForRollback(migration, trusted);

        cutoverStarted = true;
        removePath(migration.canonicalPath);
        fs.mkdirSync(path.dirname(migration.canonicalPath), { recursive: true });
        fs.renameSync(staging, migration.canonicalPath);
        staging = null;

        for (const source of migration.sources.filter((item) => item.kind === 'group')) {
          removePath(source.rootPath);
          fs.mkdirSync(path.dirname(source.rootPath), { recursive: true });
          fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, source.rootPath);
        }
        for (const source of migration.sources.filter(
          (item) => item.kind === 'provider-native' && item.nativeRole === 'memory',
        )) {
          removePath(source.rootPath);
          fs.mkdirSync(path.dirname(source.rootPath), { recursive: true });
          fs.symlinkSync(migration.canonicalPath, source.rootPath);
        }

        migration.status = 'applied';
        delete migration.error;
        writeAppliedMarker(absoluteReport, trusted.dataDir, migration, 'applied');
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        if (staging) removePath(staging);
        let restoreError: string | undefined;
        if (cutoverStarted && migration.snapshotEntries) {
          try {
            verifySnapshotForRollback(migration, trusted);
            restoreSnapshotEntries(migration, preservePostMigrationCanonical(migration));
          } catch (rollbackErr) {
            if (!(rollbackErr instanceof Error)) throw rollbackErr;
            restoreError = rollbackErr.message;
          }
        }
        migration.status = 'blocked';
        const originalError = err.message;
        migration.error = restoreError
          ? `${originalError}; automatic source restoration also failed: ${restoreError}`
          : originalError;
      }
      report.updatedAt = now().toISOString();
      writeJsonAtomic(absoluteReport, report);
    }
  } finally {
    db.close();
  }
  return report;
}

export function rollbackMigrationReport(reportPath: string, hooks: ApplyHooks = {}): MigrationReport {
  const absoluteReport = path.resolve(reportPath);
  const report = readMigrationReport(absoluteReport);
  const trusted = resolveTrustedPaths(hooks);
  assertReportRoots(report, trusted);
  const now = hooks.now ?? (() => new Date());
  const snapshotErrors = new Map<string, string>();
  const db = new Database(trusted.dbPath, { readonly: true, fileMustExist: true });
  try {
    assertMigrationAuthority(report, trusted, db);
    for (const migration of report.workgroups) {
      if (migration.status !== 'applied' && migration.status !== 'cutover-started') continue;
      try {
        verifySnapshotForRollback(migration, trusted);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        snapshotErrors.set(migration.workgroupId, error.message);
      }
    }
  } finally {
    db.close();
  }
  if (
    report.workgroups.some((migration) => {
      return (
        (migration.status === 'applied' || migration.status === 'cutover-started') &&
        !snapshotErrors.has(migration.workgroupId)
      );
    })
  ) {
    (hooks.proveQuiescence ?? cleanupOrphansStrict)();
  }
  for (const migration of report.workgroups) {
    if (migration.status !== 'applied' && migration.status !== 'cutover-started') continue;
    const interruptedCutover = migration.status === 'cutover-started';
    const snapshotError = snapshotErrors.get(migration.workgroupId);
    if (snapshotError) {
      migration.status = 'blocked';
      migration.error = snapshotError;
      report.updatedAt = now().toISOString();
      writeJsonAtomic(absoluteReport, report);
      continue;
    }
    try {
      verifySnapshotForRollback(migration, trusted);
      // Completed applies may retain a newly-created canon for forensic
      // comparison. Interrupted cutovers restore every inventoried source
      // exactly, including removing a canon that was originally missing.
      restoreSnapshotEntries(migration, interruptedCutover ? undefined : preservePostMigrationCanonical(migration));
      migration.status = 'rolled-back';
      delete migration.error;
      writeAppliedMarker(absoluteReport, trusted.dataDir, migration, 'rolled-back');
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      migration.status = 'blocked';
      migration.error = err.message;
    }
    report.updatedAt = now().toISOString();
    writeJsonAtomic(absoluteReport, report);
  }
  return report;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    'Usage: migrate-workgroup-memory.ts inventory (--workgroup <id>|--all) --report <path> | ' +
      'apply --report <path> | rollback --report <path>',
  );
}

function failIfBlocked(report: MigrationReport, action: 'apply' | 'rollback'): void {
  const blocked = report.workgroups.filter((workgroup) => workgroup.status === 'blocked');
  if (blocked.length === 0) return;
  const details = blocked
    .map((workgroup) => `${workgroup.workgroupId}${workgroup.error ? ` (${workgroup.error})` : ''}`)
    .join(', ');
  throw new Error(`${action} blocked for workgroup(s): ${details}`);
}

export async function runCli(args = process.argv.slice(2), migrationHooks: ApplyHooks = {}): Promise<void> {
  const [command] = args;
  const reportPath = optionValue(args, '--report');
  if (!command || !reportPath) usage();
  if (command === 'inventory') {
    const workgroupId = optionValue(args, '--workgroup');
    const all = args.includes('--all');
    if ((!workgroupId && !all) || (workgroupId && all)) usage();
    const dbPath = path.join(DATA_DIR, 'v2.db');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      inventoryMigration({
        db,
        dbPath,
        groupsDir: GROUPS_DIR,
        dataDir: DATA_DIR,
        workgroupIds: workgroupId ? [workgroupId] : undefined,
        reportPath,
      });
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'apply') {
    const report = applyMigrationReport(reportPath, migrationHooks);
    failIfBlocked(report, 'apply');
    await initDb(report.dbPath);
    const db = getRawDb();
    try {
      // Awaited: the reconciliation became async with the mailbox seam, and
      // the `finally` below closes the central DB it is still using. Without
      // the await, `closeDb()` fires mid-pass and a rejection escapes this
      // try/catch as an unhandled rejection.
      await reconcilePendingUpgradeContexts(
        db,
        report.workgroups
          .filter((workgroup) => workgroup.status === 'applied')
          .map((workgroup) => workgroup.workgroupId),
        report.dataDir,
      );
    } finally {
      await closeDb();
    }
    return;
  }
  if (command === 'rollback') {
    failIfBlocked(rollbackMigrationReport(reportPath, migrationHooks), 'rollback');
    return;
  }
  usage();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runCli();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
