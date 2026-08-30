import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { isAdmissiblePreTurnTrigger } from '../src/session-manager.js';
import {
  memoryTreeSha256,
  workgroupMemoryDir,
  workgroupMemoryManifestPath,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from '../src/modules/workgroup/shared-dirs.js';
import {
  parseMigrationReport,
  type EntryType,
  type InventoryEntry,
  type MigrationOutcome,
  type MigrationReport,
  type MigrationSource,
  type SnapshotEntry,
} from './migrate-workgroup-memory.js';

type VerificationStatus = 'clean' | 'degraded' | 'failed';
type Severity = 'warning' | 'failure';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ROWS = 100_000;
const MAX_NATIVE_PROJECT_DIRS = 512;
const REQUIRED_RECALL_KEYS = ['memoryEvidence', 'conversationEvidence', 'notices'] as const;

export interface VerificationIssue {
  code: string;
  severity: Severity;
  subject?: string;
  detail?: string;
}

export interface RuntimeMemberVerification {
  id: string;
  folder: string;
  provider: string | null;
  compatibility: {
    path: string;
    status: 'verified' | 'missing' | 'invalid';
    linkTarget: string | null;
  };
  nativeViews: Array<{
    provider: 'claude';
    project: string;
    path: string;
    status: 'verified' | 'shadowed-empty' | 'invalid';
    linkTarget: string | null;
  }>;
}

export interface RuntimeSessionVerification {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  status: VerificationStatus;
  pairs: {
    applicableTriggers: number;
    complete: number;
    orphanRecalls: number;
  };
  issues: VerificationIssue[];
}

export interface RuntimeWorkgroupVerification {
  id: string;
  status: VerificationStatus;
  canonical: {
    path: string;
    status: 'verified' | 'missing' | 'invalid';
    sha256: string | null;
  };
  migration: {
    status: 'verified-applied' | 'not-recorded' | 'invalid';
    markerPath: string;
    reportPath: string | null;
    snapshotDir: string | null;
  };
  members: RuntimeMemberVerification[];
  sessions: RuntimeSessionVerification[];
  issues: VerificationIssue[];
}

export interface RuntimeVerificationReport {
  version: 1;
  generatedAt: string;
  status: VerificationStatus;
  activationBlocking: boolean;
  selection: { mode: 'all' | 'workgroup'; workgroupId: string | null };
  summary: {
    workgroups: number;
    members: number;
    sessions: number;
    failures: number;
    warnings: number;
  };
  workgroups: RuntimeWorkgroupVerification[];
  issues: VerificationIssue[];
}

export interface RuntimeVerifierOptions {
  workgroupId?: string;
  requireAppliedMigration?: boolean;
}

interface CentralMember {
  id: string;
  folder: string;
  agent_provider: string | null;
}

interface CentralSession {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
}

interface MigrationMarker {
  version?: number;
  workgroupId?: string;
  status?: string;
  reportPath?: string;
  snapshotDir?: string;
  canonicalSha256?: string | null;
  updatedAt?: string;
}

interface InboundRow {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return null;
  }
}

function entryType(st: fs.Stats | null): EntryType {
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'unsupported';
}

function assertSafeSegment(value: string, label: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`unsafe ${label}`);
  }
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWithin(base: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) return null;
  const resolved = path.resolve(base, relative);
  return isWithin(base, resolved) ? resolved : null;
}

function trustedExistingPath(
  base: string,
  candidate: string,
  options: { allowFinalSymlink?: boolean } = {},
): string | null {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  if (!isWithin(resolvedBase, resolvedCandidate)) return null;
  const baseStat = lstatOrNull(resolvedBase);
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) return null;
  let current = resolvedBase;
  const relative = path.relative(resolvedBase, resolvedCandidate);
  const segments = relative ? relative.split(path.sep) : [];
  let finalIsSymlink = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      if (!options.allowFinalSymlink || index !== segments.length - 1) return null;
      finalIsSymlink = true;
    }
  }
  try {
    const realBase = fs.realpathSync(resolvedBase);
    if (finalIsSymlink) {
      const realParent = fs.realpathSync(path.dirname(resolvedCandidate));
      return isWithin(realBase, realParent) ? resolvedCandidate : null;
    }
    const realCandidate = fs.realpathSync(resolvedCandidate);
    return isWithin(realBase, realCandidate) ? resolvedCandidate : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

function readFileNoFollow(target: string): Buffer {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonBounded<T>(target: string): T {
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) throw new Error('symlinked JSON file');
  if (!st.isFile() || st.size > MAX_JSON_BYTES) throw new Error('invalid bounded JSON file');
  return JSON.parse(readFileNoFollow(target).toString('utf8')) as T;
}

function statusFor(issues: VerificationIssue[]): VerificationStatus {
  if (issues.some((issue) => issue.severity === 'failure')) return 'failed';
  if (issues.some((issue) => issue.severity === 'warning')) return 'degraded';
  return 'clean';
}

function failure(issues: VerificationIssue[], code: string, subject?: string, detail?: string): void {
  issues.push({ code, severity: 'failure', ...(subject ? { subject } : {}), ...(detail ? { detail } : {}) });
}

function warning(issues: VerificationIssue[], code: string, subject?: string, detail?: string): void {
  issues.push({ code, severity: 'warning', ...(subject ? { subject } : {}), ...(detail ? { detail } : {}) });
}

function inventoryEntry(root: string, absolute: string, relativePath: string): InventoryEntry {
  const st = fs.lstatSync(absolute);
  if (st.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(absolute);
    return {
      relativePath,
      type: 'symlink',
      size: Buffer.byteLength(linkTarget),
      sha256: hash(linkTarget),
      linkTarget,
    };
  }
  if (st.isFile()) {
    return {
      relativePath,
      type: 'file',
      size: st.size,
      sha256: hash(readFileNoFollow(absolute)),
    };
  }
  if (st.isDirectory()) {
    return {
      relativePath,
      type: 'directory',
      size: st.size,
      sha256: hash(`directory\0${path.relative(root, absolute)}`),
    };
  }
  return {
    relativePath,
    type: 'unsupported',
    size: st.size,
    sha256: hash(`unsupported\0${st.mode}\0${st.size}`),
  };
}

function walkInventory(root: string): InventoryEntry[] {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return [inventoryEntry(root, root, '')];
  }
  const entries: InventoryEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const entry = inventoryEntry(root, absolute, relative);
      entries.push(entry);
      if (entry.type === 'directory') visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function sameInventory(expected: InventoryEntry[], actual: InventoryEntry[]): boolean {
  if (expected.length !== actual.length) return false;
  const byRelativePath = (left: InventoryEntry, right: InventoryEntry): number =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
  const expectedByPath = [...expected].sort(byRelativePath);
  const actualByPath = [...actual].sort(byRelativePath);
  return expectedByPath.every((entry, index) => {
    const candidate = actualByPath[index];
    return (
      candidate !== undefined &&
      candidate.relativePath === entry.relativePath &&
      candidate.type === entry.type &&
      candidate.size === entry.size &&
      candidate.sha256 === entry.sha256 &&
      candidate.linkTarget === entry.linkTarget
    );
  });
}

function inspectLeaf(target: string): InventoryEntry | null {
  const st = lstatOrNull(target);
  if (!st || (!st.isFile() && !st.isSymbolicLink())) return null;
  return inventoryEntry(path.dirname(target), target, path.basename(target));
}

function verifySnapshotCoverage(
  workgroupId: string,
  snapshotDir: string,
  sources: MigrationSource[],
  snapshotEntries: SnapshotEntry[],
  issues: VerificationIssue[],
): void {
  if (sources.length !== snapshotEntries.length) {
    failure(issues, 'rollback-entry-coverage-mismatch', workgroupId);
    return;
  }
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    const snapshot = snapshotEntries[index]!;
    if (snapshot.sourcePath !== source.rootPath || snapshot.sourceType !== source.rootType) {
      failure(issues, 'rollback-entry-coverage-mismatch', workgroupId);
      continue;
    }
    if (source.rootType === 'missing') {
      if (snapshot.snapshotPath !== undefined) failure(issues, 'rollback-entry-mismatch', workgroupId);
      continue;
    }
    if (
      typeof snapshot.snapshotPath !== 'string' ||
      !trustedExistingPath(snapshotDir, snapshot.snapshotPath, {
        allowFinalSymlink: source.rootType === 'symlink',
      }) ||
      entryType(lstatOrNull(snapshot.snapshotPath)) !== source.rootType
    ) {
      failure(issues, 'rollback-entry-mismatch', workgroupId);
      continue;
    }
    try {
      if (!sameInventory(source.entries, walkInventory(snapshot.snapshotPath))) {
        failure(issues, 'rollback-entry-mismatch', workgroupId);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure(issues, 'rollback-entry-mismatch', workgroupId, error.message);
    }
  }
}

function sourceIsActive(source: MigrationSource, canonicalPath: string): boolean {
  if (source.rootType === 'missing' || source.ignoredScaffold) return false;
  if (source.rootType === 'symlink' && source.entries[0]?.linkTarget === WORKGROUP_MEMORY_CONTAINER_PATH) {
    return false;
  }
  if (
    source.kind === 'provider-native' &&
    source.nativeRole === 'memory' &&
    source.rootType === 'symlink' &&
    source.entries[0]?.linkTarget === canonicalPath
  ) {
    return false;
  }
  return true;
}

function markdownRelativeTargets(content: string): string[] {
  const targets: string[] = [];
  const patterns = [/!?\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g, /^\s*\[[^\]]+]:\s*<?([^\s>]+)>?/gm];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const raw = match[1];
      if (!raw || raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('//')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const withoutSuffix = raw.split(/[?#]/, 1)[0];
      if (!withoutSuffix) continue;
      try {
        targets.push(decodeURIComponent(withoutSuffix));
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        targets.push(withoutSuffix);
      }
    }
  }
  return targets;
}

function verifyRelativeMarkdownLinks(
  workgroupId: string,
  sources: MigrationSource[],
  snapshots: SnapshotEntry[],
  outcomes: MigrationOutcome[],
  issues: VerificationIssue[],
): void {
  for (const [sourceIndex, source] of sources.entries()) {
    const snapshot = snapshots[sourceIndex];
    if (!snapshot?.snapshotPath || source.rootType !== 'directory') continue;
    const sourceLeaves = new Map(
      source.entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => [path.normalize(entry.relativePath), entry]),
    );
    const sourceOutcomes = new Map(
      outcomes
        .filter((outcome) => outcome.sourcePath === source.rootPath)
        .map((outcome) => [path.normalize(outcome.relativePath), outcome]),
    );
    for (const entry of sourceLeaves.values()) {
      if (!entry.relativePath.toLocaleLowerCase('en-US').endsWith('.md')) continue;
      const originOutcome = sourceOutcomes.get(path.normalize(entry.relativePath));
      if (!originOutcome) continue;
      const snapshotFile = resolveWithin(snapshot.snapshotPath, entry.relativePath);
      if (!snapshotFile) continue;
      const content = fs.readFileSync(snapshotFile, 'utf8');
      for (const target of markdownRelativeTargets(content)) {
        const sourceTarget = path.normalize(path.join(path.dirname(entry.relativePath), target));
        if (sourceTarget === '..' || sourceTarget.startsWith(`..${path.sep}`)) continue;
        if (!sourceLeaves.has(sourceTarget)) continue;
        const targetOutcome = sourceOutcomes.get(sourceTarget);
        if (!targetOutcome) continue;
        const resolvedCanonicalTarget = path.normalize(
          path.join(path.dirname(originOutcome.canonicalRelativePath), target),
        );
        if (resolvedCanonicalTarget !== path.normalize(targetOutcome.canonicalRelativePath)) {
          failure(
            issues,
            'migration-relative-link-identity-mismatch',
            workgroupId,
            `${sourceLabelForIssue(source)}:${entry.relativePath} -> ${target}`,
          );
        }
      }
    }
  }
}

function sourceLabelForIssue(source: MigrationSource): string {
  return source.folder ?? source.groupId ?? source.kind;
}

function verifyMigrationOutcomes(
  workgroupId: string,
  canonicalPath: string,
  sources: MigrationSource[],
  snapshots: SnapshotEntry[],
  outcomes: MigrationOutcome[],
  verifyLiveCanonical: boolean,
  issues: VerificationIssue[],
): void {
  const expectedLeaves = sources
    .filter((source) => sourceIsActive(source, canonicalPath))
    .flatMap((source) =>
      source.entries
        .filter((entry) => entry.type === 'file' || entry.type === 'symlink')
        .map((entry) => ({ source, entry })),
    );
  if (expectedLeaves.length !== outcomes.length) {
    failure(issues, 'migration-outcome-coverage-mismatch', workgroupId);
    return;
  }
  for (const { source, entry } of expectedLeaves) {
    const matching = outcomes.filter(
      (outcome) => outcome.sourcePath === source.rootPath && outcome.relativePath === entry.relativePath,
    );
    if (matching.length !== 1) {
      failure(issues, 'migration-outcome-coverage-mismatch', workgroupId);
      continue;
    }
    const outcome = matching[0]!;
    const destination = resolveWithin(canonicalPath, outcome.canonicalRelativePath);
    if (!destination || outcome.sha256 !== entry.sha256) {
      failure(issues, 'canonical-outcome-mismatch', workgroupId);
      continue;
    }
    if (verifyLiveCanonical) {
      const actual = inspectLeaf(destination);
      if (
        !actual ||
        actual.type !== entry.type ||
        actual.size !== entry.size ||
        actual.sha256 !== entry.sha256 ||
        actual.linkTarget !== entry.linkTarget
      ) {
        failure(issues, 'canonical-outcome-mismatch', workgroupId);
      }
    }
  }

  const outcomesByDestination = new Map<string, MigrationOutcome[]>();
  for (const outcome of outcomes) {
    const existing = outcomesByDestination.get(outcome.canonicalRelativePath) ?? [];
    existing.push(outcome);
    outcomesByDestination.set(outcome.canonicalRelativePath, existing);
  }
  for (const [destination, shared] of outcomesByDestination) {
    const relativePaths = new Set(shared.map((outcome) => outcome.relativePath));
    if (relativePaths.size <= 1) continue;
    const identityAnchors = shared.filter(
      (outcome) =>
        outcome.relativePath === destination ||
        path.join('imports', outcome.sourceGroup, outcome.relativePath) === destination,
    );
    const preservesIdentity = shared.every(
      (outcome) =>
        identityAnchors.includes(outcome) ||
        identityAnchors.some((anchor) => anchor.relativePath === outcome.relativePath),
    );
    if (!preservesIdentity) {
      failure(issues, 'migration-outcome-path-identity-mismatch', workgroupId, destination);
    }
  }
  verifyRelativeMarkdownLinks(workgroupId, sources, snapshots, outcomes, issues);
}

function verifyMigration(
  workgroupId: string,
  canonicalPath: string,
  canonicalSha256: string | null,
  roots: { dbPath: string; dataDir: string; groupsDir: string },
  verifyLiveCanonical: boolean,
  issues: VerificationIssue[],
): RuntimeWorkgroupVerification['migration'] & { activationAt: number | null } {
  const markerPath = workgroupMemoryManifestPath(workgroupId, roots.dataDir);
  const missing = {
    status: 'not-recorded' as const,
    markerPath,
    reportPath: null,
    snapshotDir: null,
    activationAt: null,
  };
  if (!lstatOrNull(markerPath)) {
    warning(issues, 'migration-marker-missing', workgroupId);
    return missing;
  }
  if (!trustedExistingPath(roots.dataDir, markerPath)) {
    failure(issues, 'migration-marker-invalid', workgroupId);
    return { ...missing, status: 'invalid' };
  }

  let marker: MigrationMarker;
  try {
    marker = readJsonBounded<MigrationMarker>(markerPath);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'migration-marker-invalid', workgroupId, error.message);
    return { ...missing, status: 'invalid' };
  }

  const reportPath = typeof marker.reportPath === 'string' ? path.resolve(marker.reportPath) : null;
  const snapshotDir = typeof marker.snapshotDir === 'string' ? path.resolve(marker.snapshotDir) : null;
  const reportRoot = path.join(roots.dataDir, 'workgroup-memory-migration-reports');
  const snapshotRoot = path.join(roots.dataDir, 'workgroup-memory-snapshots', workgroupId);
  const trustedReportPath = reportPath ? trustedExistingPath(roots.dataDir, reportPath) : null;
  const trustedSnapshotDir = snapshotDir ? trustedExistingPath(roots.dataDir, snapshotDir) : null;
  const activationAt =
    typeof marker.updatedAt === 'string' && Number.isFinite(Date.parse(marker.updatedAt))
      ? Date.parse(marker.updatedAt)
      : null;

  if (
    marker.version !== 1 ||
    marker.workgroupId !== workgroupId ||
    marker.status !== 'applied' ||
    !reportPath ||
    !isWithin(reportRoot, reportPath) ||
    !trustedReportPath ||
    !snapshotDir ||
    !isWithin(snapshotRoot, snapshotDir) ||
    !trustedSnapshotDir ||
    !lstatOrNull(trustedSnapshotDir)?.isDirectory()
  ) {
    failure(issues, 'migration-marker-invalid', workgroupId);
    return {
      status: 'invalid',
      markerPath,
      reportPath,
      snapshotDir,
      activationAt,
    };
  }
  if (
    typeof marker.canonicalSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.canonicalSha256) ||
    (verifyLiveCanonical && (!canonicalSha256 || marker.canonicalSha256 !== canonicalSha256))
  ) {
    failure(issues, 'canonical-checksum-mismatch', workgroupId);
  }

  let report: MigrationReport;
  try {
    report = parseMigrationReport(readJsonBounded<unknown>(reportPath), reportPath);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'migration-report-invalid', workgroupId, error.message);
    return {
      status: 'invalid',
      markerPath,
      reportPath,
      snapshotDir,
      activationAt,
    };
  }
  const migrations = Array.isArray(report.workgroups)
    ? report.workgroups.filter((item) => item.workgroupId === workgroupId)
    : [];
  const migration = migrations[0];
  if (
    report.version !== 1 ||
    typeof report.dbPath !== 'string' ||
    path.resolve(report.dbPath) !== roots.dbPath ||
    typeof report.dataDir !== 'string' ||
    path.resolve(report.dataDir) !== roots.dataDir ||
    typeof report.groupsDir !== 'string' ||
    path.resolve(report.groupsDir) !== roots.groupsDir ||
    migrations.length !== 1 ||
    !migration ||
    migration.status !== 'applied' ||
    typeof migration.canonicalPath !== 'string' ||
    path.resolve(migration.canonicalPath) !== canonicalPath ||
    typeof migration.snapshotDir !== 'string' ||
    path.resolve(migration.snapshotDir ?? '') !== snapshotDir ||
    !Array.isArray(migration.sources) ||
    !Array.isArray(migration.snapshotEntries) ||
    !Array.isArray(migration.outcomes)
  ) {
    failure(issues, 'migration-report-invalid', workgroupId);
    return {
      status: 'invalid',
      markerPath,
      reportPath,
      snapshotDir,
      activationAt,
    };
  }

  try {
    verifySnapshotCoverage(workgroupId, snapshotDir, migration.sources, migration.snapshotEntries, issues);
    verifyMigrationOutcomes(
      workgroupId,
      canonicalPath,
      migration.sources,
      migration.snapshotEntries,
      migration.outcomes,
      verifyLiveCanonical,
      issues,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'migration-report-invalid', workgroupId, error.message);
  }
  return {
    status: issues.some((issue) => issue.severity === 'failure') ? 'invalid' : 'verified-applied',
    markerPath,
    reportPath,
    snapshotDir,
    activationAt,
  };
}

function verifyNativeViews(
  member: CentralMember,
  canonicalPath: string,
  dataDir: string,
  issues: VerificationIssue[],
): RuntimeMemberVerification['nativeViews'] {
  const projectsRoot = path.join(dataDir, 'v2-sessions', member.id, '.claude-shared', 'projects');
  const projectsStat = lstatOrNull(projectsRoot);
  if (!projectsStat) return [];
  if (projectsStat.isSymbolicLink() || !projectsStat.isDirectory() || !trustedExistingPath(dataDir, projectsRoot)) {
    failure(issues, 'native-projects-root-invalid', member.id);
    return [];
  }
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsRoot).sort();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'native-projects-root-unreadable', member.id, error.message);
    return [];
  }
  if (projects.length > MAX_NATIVE_PROJECT_DIRS) {
    failure(issues, 'native-project-bound-exceeded', member.id);
    return [];
  }

  const views: RuntimeMemberVerification['nativeViews'] = [];
  for (const project of projects) {
    const projectRoot = path.join(projectsRoot, project);
    const projectStat = lstatOrNull(projectRoot);
    if (!projectStat || projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
      failure(issues, 'native-project-root-invalid', member.id);
      continue;
    }
    const memoryPath = path.join(projectRoot, 'memory');
    const memoryStat = lstatOrNull(memoryPath);
    if (!memoryStat) continue;
    if (memoryStat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(memoryPath);
      const resolved = path.resolve(path.dirname(memoryPath), linkTarget);
      const verified = resolved === canonicalPath;
      if (!verified) failure(issues, 'native-memory-link-target-mismatch', member.id);
      views.push({
        provider: 'claude',
        project,
        path: memoryPath,
        status: verified ? 'verified' : 'invalid',
        linkTarget,
      });
      continue;
    }
    if (memoryStat.isDirectory()) {
      let empty: boolean;
      try {
        empty = fs.readdirSync(memoryPath).length === 0;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        empty = false;
      }
      if (!empty) failure(issues, 'native-memory-real-tree', member.id);
      views.push({
        provider: 'claude',
        project,
        path: memoryPath,
        status: empty ? 'shadowed-empty' : 'invalid',
        linkTarget: null,
      });
      continue;
    }
    failure(issues, 'native-memory-path-invalid', member.id);
    views.push({
      provider: 'claude',
      project,
      path: memoryPath,
      status: 'invalid',
      linkTarget: null,
    });
  }
  return views;
}

function verifyMember(
  member: CentralMember,
  canonicalPath: string,
  roots: { dataDir: string; groupsDir: string },
  issues: VerificationIssue[],
): RuntimeMemberVerification {
  try {
    assertSafeSegment(member.id, 'agent group id');
    assertSafeSegment(member.folder, 'agent group folder');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'member-path-segment-invalid', member.id, error.message);
    return {
      id: member.id,
      folder: member.folder,
      provider: member.agent_provider,
      compatibility: { path: '', status: 'invalid', linkTarget: null },
      nativeViews: [],
    };
  }
  const compatibilityPath = path.join(roots.groupsDir, member.folder, 'memory');
  const compatibilityStat = lstatOrNull(compatibilityPath);
  let linkTarget: string | null = null;
  let compatibilityStatus: RuntimeMemberVerification['compatibility']['status'] = 'invalid';
  if (!compatibilityStat) {
    failure(issues, 'member-link-missing', member.id);
    compatibilityStatus = 'missing';
  } else if (compatibilityStat.isSymbolicLink()) {
    linkTarget = fs.readlinkSync(compatibilityPath);
    if (linkTarget === WORKGROUP_MEMORY_CONTAINER_PATH) compatibilityStatus = 'verified';
    else failure(issues, 'member-link-target-mismatch', member.id);
  } else {
    failure(issues, 'member-memory-not-link', member.id);
  }
  return {
    id: member.id,
    folder: member.folder,
    provider: member.agent_provider,
    compatibility: {
      path: compatibilityPath,
      status: compatibilityStatus,
      linkTarget,
    },
    nativeViews: verifyNativeViews(member, canonicalPath, roots.dataDir, issues),
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(name) !== undefined;
}

function parseRecall(row: InboundRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.content) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

function isStructuredRecallRow(row: InboundRow): boolean {
  const payload = parseRecall(row);
  return (
    payload?.subtype === 'recall_context' &&
    REQUIRED_RECALL_KEYS.every((key) => Object.prototype.hasOwnProperty.call(payload, key))
  );
}

function sameNullable(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function verifyRecallPair(
  session: CentralSession,
  recall: InboundRow,
  trigger: InboundRow,
  issues: VerificationIssue[],
): boolean {
  let complete = true;
  const reject = (code: string): void => {
    failure(issues, code, session.id);
    complete = false;
  };
  if (
    recall.id !== `recall-${trigger.id}` ||
    recall.seq + 2 !== trigger.seq ||
    recall.seq % 2 !== 0 ||
    trigger.seq % 2 !== 0 ||
    recall.kind !== 'system' ||
    recall.trigger !== 0 ||
    trigger.trigger !== 1
  ) {
    reject('recall-pair-sequence-mismatch');
  }
  if (
    recall.timestamp !== trigger.timestamp ||
    !sameNullable(recall.platform_id, trigger.platform_id) ||
    !sameNullable(recall.channel_type, trigger.channel_type) ||
    !sameNullable(recall.thread_id, trigger.thread_id) ||
    !sameNullable(recall.process_after, trigger.process_after) ||
    !sameNullable(recall.source_session_id, trigger.source_session_id) ||
    recall.on_wake !== trigger.on_wake ||
    recall.recurrence !== null
  ) {
    reject('recall-pair-state-mismatch');
  }
  const payload = parseRecall(recall);
  const trusted =
    payload?.trustedCapabilities !== null &&
    typeof payload?.trustedCapabilities === 'object' &&
    !Array.isArray(payload?.trustedCapabilities)
      ? (payload.trustedCapabilities as Record<string, unknown>)
      : null;
  if (
    !payload ||
    payload.subtype !== 'recall_context' ||
    REQUIRED_RECALL_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(payload, key)) ||
    (Object.prototype.hasOwnProperty.call(payload, 'trustedCapabilities') &&
      trusted?.agentGroupId !== session.agent_group_id)
  ) {
    reject('recall-payload-incomplete');
  }
  return complete;
}

function verifySession(
  session: CentralSession,
  dataDir: string,
  activationAt: number | null,
): RuntimeSessionVerification {
  const issues: VerificationIssue[] = [];
  const empty = {
    id: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id,
    status: 'clean' as VerificationStatus,
    pairs: { applicableTriggers: 0, complete: 0, orphanRecalls: 0 },
    issues,
  };
  try {
    assertSafeSegment(session.agent_group_id, 'agent group id');
    assertSafeSegment(session.id, 'session id');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'session-path-segment-invalid', session.id, error.message);
    return { ...empty, status: statusFor(issues) };
  }
  const inboundPath = path.join(dataDir, 'v2-sessions', session.agent_group_id, session.id, 'inbound.db');
  if (!lstatOrNull(inboundPath)) {
    warning(issues, 'session-inbound-missing', session.id);
    return { ...empty, status: statusFor(issues) };
  }

  let db: Database.Database;
  try {
    db = new Database(inboundPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'session-inbound-unreadable', session.id, error.message);
    return { ...empty, status: statusFor(issues) };
  }
  try {
    if (!tableExists(db, 'messages_in')) {
      failure(issues, 'session-messages-table-missing', session.id);
      return { ...empty, status: statusFor(issues) };
    }
    const count = (db.prepare('SELECT COUNT(*) AS count FROM messages_in').get() as { count: number }).count;
    if (count > MAX_SESSION_ROWS) {
      failure(issues, 'session-row-bound-exceeded', session.id);
      return { ...empty, status: statusFor(issues) };
    }
    const rows = db
      .prepare(
        `SELECT id,seq,kind,timestamp,status,process_after,recurrence,trigger,
                platform_id,channel_type,thread_id,content,source_session_id,on_wake
           FROM messages_in
          ORDER BY seq`,
      )
      .all() as InboundRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const recallRows = rows.filter((row) => row.id.startsWith('recall-'));
    const firstStructuredRecallSeq = recallRows
      .filter(isStructuredRecallRow)
      .reduce<number | null>((lowest, row) => (lowest === null || row.seq < lowest ? row.seq : lowest), null);
    let orphanRecalls = 0;
    for (const recall of recallRows) {
      const pairedId = recall.id.slice('recall-'.length);
      const trigger = byId.get(pairedId);
      if (!trigger) {
        orphanRecalls++;
        failure(issues, 'orphan-recall-row', session.id);
      }
    }

    const applicable = rows.filter((row) => {
      if (
        !isAdmissiblePreTurnTrigger({
          id: row.id,
          kind: row.kind,
          timestamp: row.timestamp,
          content: row.content,
          trigger: row.trigger === 1 ? 1 : 0,
        })
      ) {
        return false;
      }
      const timestamp = Date.parse(row.timestamp);
      if (
        row.kind === 'task' &&
        (row.status === 'pending' || row.status === 'processing') &&
        activationAt !== null &&
        Number.isFinite(timestamp) &&
        timestamp < activationAt
      ) {
        // Legacy scheduled rows are deliberately persisted until their due
        // time. The host demotes and admits them through
        // admitDueTaskContexts immediately before wake, so their recall must
        // be fresh at execution rather than frozen at migration cutover.
        return false;
      }
      if (row.status === 'pending' || row.status === 'processing') return true;
      return (
        (activationAt !== null && Number.isFinite(timestamp) && timestamp >= activationAt) ||
        (firstStructuredRecallSeq !== null && row.seq > firstStructuredRecallSeq)
      );
    });
    let complete = 0;
    for (const trigger of applicable) {
      const recall = byId.get(`recall-${trigger.id}`);
      if (!recall) {
        failure(issues, 'recall-pair-missing', session.id);
        continue;
      }
      if (verifyRecallPair(session, recall, trigger, issues)) complete++;
    }

    if (tableExists(db, 'session_routing')) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info('session_routing')`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      const select = ['thread_id', columns.has('session_id') ? 'session_id' : 'NULL AS session_id'].join(',');
      const routing = db.prepare(`SELECT ${select} FROM session_routing WHERE id = 1`).get() as
        | { thread_id: string | null; session_id: string | null }
        | undefined;
      if (
        routing &&
        ((routing.session_id !== null && routing.session_id !== session.id) ||
          (session.thread_id !== null && routing.thread_id !== session.thread_id))
      ) {
        failure(issues, 'session-routing-state-mismatch', session.id);
      }
    }
    return {
      ...empty,
      status: statusFor(issues),
      pairs: { applicableTriggers: applicable.length, complete, orphanRecalls },
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'session-verification-failed', session.id, error.message);
    return { ...empty, status: statusFor(issues) };
  } finally {
    db.close();
  }
}

function verifyWorkgroup(
  db: Database.Database,
  workgroupId: string,
  roots: { dbPath: string; dataDir: string; groupsDir: string },
  requireAppliedMigration: boolean,
): RuntimeWorkgroupVerification {
  const issues: VerificationIssue[] = [];
  let canonicalPath = '';
  let canonicalStatus: RuntimeWorkgroupVerification['canonical']['status'] = 'invalid';
  let canonicalSha256: string | null = null;
  try {
    assertSafeSegment(workgroupId, 'workgroup id');
    canonicalPath = workgroupMemoryDir(workgroupId, roots.dataDir);
    const canonicalStat = lstatOrNull(canonicalPath);
    if (!canonicalStat) {
      canonicalStatus = 'missing';
      failure(issues, 'canonical-memory-missing', workgroupId);
    } else if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
      failure(issues, 'canonical-memory-not-directory', workgroupId);
    } else if (!trustedExistingPath(roots.dataDir, canonicalPath)) {
      failure(issues, 'canonical-memory-invalid', workgroupId);
    } else {
      canonicalSha256 = memoryTreeSha256(canonicalPath);
      canonicalStatus = 'verified';
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'canonical-memory-invalid', workgroupId, error.message);
  }

  const migrationWithActivation = canonicalPath
    ? verifyMigration(workgroupId, canonicalPath, canonicalSha256, roots, requireAppliedMigration, issues)
    : {
        status: 'invalid' as const,
        markerPath: '',
        reportPath: null,
        snapshotDir: null,
        activationAt: null,
      };
  if (requireAppliedMigration && migrationWithActivation.status !== 'verified-applied') {
    failure(issues, 'applied-migration-required', workgroupId);
  }
  const members = db
    .prepare(
      `SELECT id,folder,agent_provider
         FROM agent_groups
        WHERE workgroup_id = ?
        ORDER BY folder,id`,
    )
    .all(workgroupId) as CentralMember[];
  const memberReports = members.map((member) => verifyMember(member, canonicalPath, roots, issues));
  if (members.length === 0) warning(issues, 'workgroup-has-no-members', workgroupId);

  const sessions =
    members.length === 0
      ? []
      : (db
          .prepare(
            `SELECT s.id,s.agent_group_id,s.messaging_group_id,s.thread_id
               FROM sessions s
               JOIN agent_groups a ON a.id = s.agent_group_id
              WHERE a.workgroup_id = ?
              ORDER BY s.agent_group_id,s.id`,
          )
          .all(workgroupId) as CentralSession[]);
  const sessionReports = sessions.map((session) =>
    verifySession(session, roots.dataDir, migrationWithActivation.activationAt),
  );
  for (const session of sessionReports) issues.push(...session.issues);

  return {
    id: workgroupId,
    status: statusFor(issues),
    canonical: {
      path: canonicalPath,
      status: canonicalStatus,
      sha256: canonicalSha256,
    },
    migration: {
      status: migrationWithActivation.status,
      markerPath: migrationWithActivation.markerPath,
      reportPath: migrationWithActivation.reportPath,
      snapshotDir: migrationWithActivation.snapshotDir,
    },
    members: memberReports,
    sessions: sessionReports,
    issues,
  };
}

function emptyReport(
  selection: RuntimeVerificationReport['selection'],
  issues: VerificationIssue[],
): RuntimeVerificationReport {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: statusFor(issues),
    activationBlocking: issues.some((issue) => issue.severity === 'failure'),
    selection,
    summary: {
      workgroups: 0,
      members: 0,
      sessions: 0,
      failures: issues.filter((issue) => issue.severity === 'failure').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    },
    workgroups: [],
    issues,
  };
}

export function verifyWorkgroupMemoryRuntime(options: RuntimeVerifierOptions = {}): RuntimeVerificationReport {
  const dataDir = DATA_DIR;
  const groupsDir = GROUPS_DIR;
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const selection: RuntimeVerificationReport['selection'] = options.workgroupId
    ? { mode: 'workgroup', workgroupId: options.workgroupId }
    : { mode: 'all', workgroupId: null };
  const issues: VerificationIssue[] = [];
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'central-db-unreadable', undefined, error.message);
    return emptyReport(selection, issues);
  }
  try {
    const allIds = (db.prepare('SELECT id FROM workgroups ORDER BY id').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    if (options.workgroupId && !allIds.includes(options.workgroupId)) {
      failure(issues, 'unknown-workgroup', options.workgroupId);
      return emptyReport(selection, issues);
    }
    const selectedIds = options.workgroupId ? [options.workgroupId] : allIds;
    const workgroups = selectedIds.map((id) =>
      verifyWorkgroup(db, id, { dbPath, dataDir, groupsDir }, options.requireAppliedMigration === true),
    );
    const allIssues = [...issues, ...workgroups.flatMap((workgroup) => workgroup.issues)];
    const failures = allIssues.filter((issue) => issue.severity === 'failure').length;
    const warnings = allIssues.filter((issue) => issue.severity === 'warning').length;
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      status: statusFor(allIssues),
      activationBlocking: failures > 0,
      selection,
      summary: {
        workgroups: workgroups.length,
        members: workgroups.reduce((count, workgroup) => count + workgroup.members.length, 0),
        sessions: workgroups.reduce((count, workgroup) => count + workgroup.sessions.length, 0),
        failures,
        warnings,
      },
      workgroups,
      issues,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure(issues, 'central-db-schema-invalid', undefined, error.message);
    return emptyReport(selection, issues);
  } finally {
    db.close();
  }
}

function parseCli(argv: string[]): RuntimeVerifierOptions {
  let all = false;
  let workgroupId: string | undefined;
  let json = false;
  let requireAppliedMigration = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--workgroup') {
      workgroupId = argv[++index];
      if (!workgroupId) throw new Error('missing workgroup selector');
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--require-applied-migration') {
      requireAppliedMigration = true;
    } else {
      throw new Error('unknown argument');
    }
  }
  if (!json || Number(all) + Number(workgroupId !== undefined) !== 1) {
    throw new Error('invalid verifier arguments');
  }
  return {
    ...(workgroupId ? { workgroupId } : {}),
    ...(requireAppliedMigration ? { requireAppliedMigration: true } : {}),
  };
}

function runCli(argv: string[]): number {
  let options: RuntimeVerifierOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const issues: VerificationIssue[] = [{ code: 'invalid-arguments', severity: 'failure', detail: error.message }];
    process.stdout.write(`${JSON.stringify(emptyReport({ mode: 'all', workgroupId: null }, issues), null, 2)}\n`);
    return 1;
  }
  const report = verifyWorkgroupMemoryRuntime(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.activationBlocking ? 1 : 0;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (isMain) process.exitCode = runCli(process.argv.slice(2));
