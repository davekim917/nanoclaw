#!/usr/bin/env tsx
/**
 * Server-wide, lossless repository topology migration.
 *
 * Dry-run is read-only. Execute requires an already-stopped fleet and creates
 * per-repository synthetic rescue refs, bundles, retained renamed checkouts,
 * normal host canonicals, and per-topic linked worktrees.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { CONTAINER_INSTALL_LABEL, DATA_DIR, GROUPS_DIR, REPO_ROOT } from '../src/config.js';
import { getSystemdUnit } from '../src/install-slug.js';
import {
  auditRepositoryMigration,
  createLegacyGitResolutionContext,
  createRepositoryMigrationManifest,
  executeRepositoryMigration,
  manifestPath,
  mergeLegacyCheckoutProvenance,
  readLegacyCheckoutOrigin,
  readLegacyGitDirOrigin,
  repositoryMigrationPath,
  rollbackRepositoryMigration,
  validateReviewedRecoverySeeds,
  verifyRepositoryMigrationManifest,
  type LegacyCheckoutCandidate,
  type LegacyGitResolutionContext,
  type RepositoryMigrationManifest,
} from '../src/repository-migration.js';
import {
  canonicalRepoDir,
  readOriginPin,
  repositoriesRoot,
  repositoryStateRoot,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  topicsRoot,
  withHostRepositoryLock,
  type RepositoryWorkUnit,
} from '../src/repository-workspaces.js';
import { readThreadDirOwner, threadWorktreeDir } from '../src/session-manager.js';
import {
  applyReviewedWorkUnitMappings,
  loadReviewedWorkUnitMappings,
  type ReviewedMappingEntry,
} from '../src/repository-migration-mapping.js';
import {
  loadReviewedRecoveryDecisions,
  recoverySeedGitDirSha256,
  selectReviewedOrigin,
  type LoadedReviewedRecoveryDecisions,
  type ReviewedCheckoutRecoveryDecision,
} from '../src/repository-migration-recovery.js';
import {
  normalizedCredentialFreeGithubOrigin,
  normalizedGithubRepositoryIdentity,
  planLegacyRepositoryCoalescing,
  repositoryOriginContainsCredentials,
} from '../src/repository-migration-identity.js';
import {
  discoverPhysicalGitCheckouts,
  isPhysicalGitCheckout,
  isLegacyCanonicalCheckout,
  SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
} from '../src/repository-discovery.js';
import {
  captureProtectedArchive,
  verifyProtectedArchives,
  type ProtectedArchiveEvidence,
} from '../src/repository-protected-archives.js';
import {
  extendProtectedInodeInventory,
  pidsWithOpenFilesBelow,
  type ProtectedInodeInventory,
} from '../src/repository-migration-quiescence.js';
import { completedRepositoryQuiescencePaths } from '../src/repository-migration-quiescence-paths.js';

interface Args {
  execute: boolean;
  quiesced: boolean;
  rollbackRun?: string;
  workgroup?: string;
  repo?: string;
  runId?: string;
  mappingFile?: string;
  recoveryFile?: string;
  proposalFile?: string;
}

interface SessionRow {
  session_id: string;
  agent_group_id: string;
  folder: string;
  workgroup_id: string;
  messaging_group_id: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

interface AgentGroupRow {
  agent_group_id: string;
  folder: string;
  workgroup_id: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, quiesced: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') args.execute = true;
    else if (value === '--quiesced') args.quiesced = true;
    else if (value === '--rollback-run') args.rollbackRun = argv[++index];
    else if (value === '--all') args.workgroup = undefined;
    else if (value === '--workgroup') args.workgroup = argv[++index];
    else if (value === '--repo') args.repo = argv[++index];
    else if (value === '--run-id') args.runId = argv[++index];
    else if (value === '--mapping-file') args.mappingFile = argv[++index];
    else if (value === '--recovery-file') args.recoveryFile = argv[++index];
    else if (value === '--proposal-file') args.proposalFile = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (args.execute && !args.quiesced) throw new Error('--execute requires --quiesced');
  if (args.rollbackRun && !args.quiesced) throw new Error('--rollback-run requires --quiesced');
  if (args.rollbackRun && args.execute) throw new Error('--rollback-run and --execute are mutually exclusive');
  if (
    args.rollbackRun &&
    (args.workgroup || args.repo || args.runId || args.mappingFile || args.recoveryFile || args.proposalFile)
  ) {
    throw new Error('--rollback-run cannot be combined with inventory or recovery-selection arguments');
  }
  return args;
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    const parentFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function captureProtectedArchives(groups: AgentGroupRow[], workgroups: Set<string>): ProtectedArchiveEvidence[] {
  const roots = new Set<string>();
  for (const group of groups) {
    if (!workgroups.has(group.workgroup_id)) continue;
    const groupRoot = path.join(GROUPS_DIR, group.folder);
    for (const child of safeDirectories(groupRoot)) {
      const candidate = path.join(groupRoot, child);
      try {
        const marker = fs.lstatSync(path.join(candidate, '.archive-sha'));
        const candidateStat = fs.lstatSync(candidate);
        if (
          candidateStat.isSymbolicLink() ||
          !candidateStat.isDirectory() ||
          marker.isSymbolicLink() ||
          !marker.isFile()
        ) {
          throw new Error(`unsafe protected archive root: ${candidate}`);
        }
        roots.add(fs.realpathSync(candidate));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return [...roots].sort().map(captureProtectedArchive);
}

function fallbackUnit(workgroupId: string, identity: string): RepositoryWorkUnit {
  const key = `session:legacy:${sha(identity).slice(0, 24)}`;
  return { workgroupId, kind: 'session', key, id: sha(`${workgroupId}\0${key}`).slice(0, 32) };
}

function safeDirectories(directory: string): string[] {
  try {
    fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `cannot inspect configured repository root ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== '.git')
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(
      `cannot enumerate configured repository root ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function originFor(candidate: LegacyCheckoutCandidate, context: LegacyGitResolutionContext): string | null {
  let origin: string | null;
  try {
    origin = readLegacyCheckoutOrigin(candidate, context);
  } catch (error) {
    const gitDir = path.join(candidate.checkoutPath, '.git');
    if (!fs.lstatSync(gitDir).isDirectory() || readLegacyGitDirOrigin(gitDir, context) !== null) throw error;
    origin = null;
  }
  const seen = new Set<string>();
  while (origin !== null && path.isAbsolute(origin)) {
    const currentOrigin = origin;
    if (seen.has(currentOrigin)) {
      throw new Error(`local repository origin cycle while resolving ${candidate.checkoutPath}`);
    }
    seen.add(currentOrigin);
    let localStore: string | undefined;
    if (fs.existsSync(currentOrigin)) {
      localStore = fs.existsSync(path.join(currentOrigin, '.git')) ? path.join(currentOrigin, '.git') : currentOrigin;
    } else {
      const repoName = path.basename(currentOrigin).replace(/\.git$/, '');
      localStore = (candidate.candidateCommonGitDirs ?? []).find((common) => {
        if (currentOrigin.includes('/.repos/')) return path.basename(common).replace(/\.git$/, '') === repoName;
        return path.basename(path.dirname(common)) === repoName;
      });
    }
    if (!localStore) throw new Error(`local repository origin target is missing or ambiguous: ${origin}`);
    origin = readLegacyGitDirOrigin(localStore, context);
  }
  return origin?.replace(/\.git\/?$/, '').replace(/\/$/, '') ?? null;
}

function originForObjectStore(store: string, context: LegacyGitResolutionContext): string | null {
  let origin = readLegacyGitDirOrigin(store, context);
  const seen = new Set<string>();
  while (origin !== null && path.isAbsolute(origin)) {
    if (seen.has(origin)) throw new Error(`local object-store origin cycle while resolving ${store}`);
    seen.add(origin);
    if (!fs.existsSync(origin)) throw new Error(`local object-store origin target is missing: ${origin}`);
    const localStore = fs.existsSync(path.join(origin, '.git')) ? path.join(origin, '.git') : origin;
    origin = readLegacyGitDirOrigin(localStore, context);
  }
  return origin?.replace(/\.git\/?$/, '').replace(/\/$/, '') ?? null;
}

function repoFromPointer(checkoutPath: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(path.join(checkoutPath, '.git'), 'utf8'));
    if (!match) return null;
    const pointer = match[1].replaceAll('\\', '/');
    const patterns = [
      /\/workspace\/workgroup\/\.repos\/([^/]+?)\.git\/worktrees\//,
      /\/workspace\/workgroup\/([^/]+?)\/\.git\/worktrees\//,
      /\/workspace\/worktrees\/([^/]+?)\/\.git\/worktrees\//,
      /\/([^/]+?)\.git\/worktrees\//,
      /\/([^/]+?)\/\.git\/worktrees\//,
    ];
    for (const pattern of patterns) {
      const parsed = pattern.exec(pointer);
      if (parsed) return parsed[1];
    }
  } catch {
    // Standalone checkout or unreadable pointer; caller uses its legacy name.
  }
  return null;
}

function repoForCheckout(checkoutPath: string, fallback: string): string {
  const linked = repoFromPointer(checkoutPath);
  if (linked) return linked;
  const gitDir = path.join(checkoutPath, '.git');
  try {
    if (!fs.lstatSync(gitDir).isDirectory()) return fallback;
    const origin = execFileSync('git', ['--git-dir', gitDir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
    const pathname = (() => {
      try {
        return new URL(origin).pathname;
      } catch {
        return origin;
      }
    })();
    return path.basename(pathname).replace(/\.git$/, '') || fallback;
  } catch {
    return fallback;
  }
}

function loadRows(db: Database.Database): SessionRow[] {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.agent_group_id, ag.folder,
              COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id,
              s.messaging_group_id, mg.platform_id, s.thread_id
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
    )
    .all() as SessionRow[];
}

function loadAgentGroups(db: Database.Database): AgentGroupRow[] {
  return db
    .prepare(
      `SELECT id AS agent_group_id, folder,
              COALESCE(workgroup_id, folder) AS workgroup_id
         FROM agent_groups`,
    )
    .all() as AgentGroupRow[];
}

function addCandidate(
  grouped: Map<string, LegacyCheckoutCandidate[]>,
  seen: Set<string>,
  physicalOwners: Map<string, string>,
  candidate: LegacyCheckoutCandidate,
): void {
  let real: string;
  try {
    real = fs.realpathSync(candidate.checkoutPath);
  } catch {
    return;
  }
  if (!isPhysicalGitCheckout(real)) return;
  const discoveredCandidate: LegacyCheckoutCandidate = {
    ...candidate,
    checkoutPath: real,
    ...configuredOriginProvenance(real),
  };
  const priorOwner = physicalOwners.get(real);
  if (priorOwner && priorOwner !== candidate.workgroupId) {
    throw new Error(`physical checkout is shared across workgroups (${priorOwner}, ${candidate.workgroupId}): ${real}`);
  }
  physicalOwners.set(real, candidate.workgroupId);
  const identity = `${candidate.workgroupId}\0${candidate.repo}\0${real}`;
  const key = `${candidate.workgroupId}\0${candidate.repo}`;
  const entries = grouped.get(key) ?? [];
  if (seen.has(identity)) {
    const index = entries.findIndex((entry) => entry.checkoutPath === real);
    if (index < 0) throw new Error(`repository discovery identity is missing from its group: ${real}`);
    entries[index] = mergeLegacyCheckoutProvenance(entries[index], discoveredCandidate);
    grouped.set(key, entries);
    return;
  }
  seen.add(identity);
  entries.push(discoveredCandidate);
  grouped.set(key, entries);
}

function configuredOrigin(checkoutPath: string): string | null {
  const gitDir = path.join(checkoutPath, '.git');
  try {
    if (!fs.lstatSync(gitDir).isDirectory()) return null;
    return (
      execFileSync('git', ['--git-dir', gitDir, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        timeout: 10_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function configuredOriginProvenance(
  checkoutPath: string,
): Pick<LegacyCheckoutCandidate, 'credentialBearingOrigin'> {
  return repositoryOriginContainsCredentials(configuredOrigin(checkoutPath)) ? { credentialBearingOrigin: true } : {};
}

export function normalizedObservedOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  return normalizedCredentialFreeGithubOrigin(origin) ?? origin;
}

export function classifySessionRepositoryCheckout(input: {
  checkoutPath: string;
  physicalSession: string;
  workgroupId: string;
  liveWorkUnit: RepositoryWorkUnit;
}): Pick<LegacyCheckoutCandidate, 'workUnit' | 'sourceRole' | 'credentialBearingOrigin'> {
  const checkoutPath = fs.realpathSync(input.checkoutPath);
  const stagingRoot = path.join(input.physicalSession, 'repository-staging');
  let stagingRootReal: string;
  try {
    stagingRootReal = fs.realpathSync(stagingRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workUnit: input.liveWorkUnit };
    throw new Error(
      `cannot classify the requesting session repository-staging root: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!contained(checkoutPath, stagingRootReal)) return { workUnit: input.liveWorkUnit };
  return {
    workUnit: fallbackUnit(input.workgroupId, `repository-staging\0${checkoutPath}`),
    sourceRole: 'repository-staging',
    ...configuredOriginProvenance(checkoutPath),
  };
}

function inventoryCandidates(
  rows: SessionRow[],
  groups: AgentGroupRow[],
  selectedWorkgroup?: string,
  reviewedMappings: ReviewedMappingEntry[] = [],
): Map<string, LegacyCheckoutCandidate[]> {
  const grouped = new Map<string, LegacyCheckoutCandidate[]>();
  const seen = new Set<string>();
  const physicalOwners = new Map<string, string>();
  const reviewedByPath = new Map(reviewedMappings.map((entry) => [path.resolve(entry.checkoutPath), entry]));
  const ownershipErrors: string[] = [];

  // Agent-group and workgroup-local checkouts, including legacy .worktrees.
  const rootsByWorkgroup = new Map<string, Set<string>>();
  for (const group of groups) {
    if (selectedWorkgroup && group.workgroup_id !== selectedWorkgroup) continue;
    const roots = rootsByWorkgroup.get(group.workgroup_id) ?? new Set<string>();
    roots.add(path.join(GROUPS_DIR, group.folder));
    roots.add(path.join(DATA_DIR, 'workgroups', group.workgroup_id));
    rootsByWorkgroup.set(group.workgroup_id, roots);
  }
  for (const [workgroupId, roots] of rootsByWorkgroup) {
    const allowedRoots = [...roots];
    for (const root of roots) {
      for (const checkoutPath of discoverPhysicalGitCheckouts(root, allowedRoots)) {
        const fallback = path.basename(checkoutPath);
        const repositoryName = repoForCheckout(checkoutPath, fallback);
        const sourceRole = isLegacyCanonicalCheckout(checkoutPath, root) ? ('legacy-canonical' as const) : undefined;
        addCandidate(grouped, seen, physicalOwners, {
          workgroupId,
          repo: repositoryName,
          checkoutPath,
          workUnit: fallbackUnit(workgroupId, checkoutPath),
          ...(sourceRole ? { sourceRole } : {}),
        });
      }
    }
  }

  // Recursively inventory every live and historical physical session root,
  // not only the conventional worktrees/ child. Agents could previously make
  // standalone or nested clones anywhere under writable /workspace.
  const rowsByPhysicalSession = new Map(rows.map((row) => [`${row.agent_group_id}\0${row.session_id}`, row]));
  const groupsById = new Map(groups.map((group) => [group.agent_group_id, group]));
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  for (const agentGroupId of safeDirectories(sessionsRoot)) {
    const groupRoot = path.join(sessionsRoot, agentGroupId);
    const groupRootStat = fs.lstatSync(groupRoot);
    if (groupRootStat.isSymbolicLink() || !groupRootStat.isDirectory()) {
      throw new Error(`session agent-group root is not a real directory: ${groupRoot}`);
    }
    const group = groupsById.get(agentGroupId);
    if (!group) throw new Error(`historical session root has no workgroup owner: ${groupRoot}`);
    if (selectedWorkgroup && group.workgroup_id !== selectedWorkgroup) continue;
    for (const sessionId of safeDirectories(groupRoot).filter((name) => !name.startsWith('.'))) {
      const physicalSession = path.join(groupRoot, sessionId);
      const sessionStat = fs.lstatSync(physicalSession);
      if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
        throw new Error(`session root is not a real directory: ${physicalSession}`);
      }
      const row = rowsByPhysicalSession.get(`${agentGroupId}\0${sessionId}`);
      const unit = row
        ? resolveRepositoryWorkUnit({
            workgroupId: row.workgroup_id,
            sessionId: row.session_id,
            platformId: row.platform_id,
            messagingGroupId: row.messaging_group_id,
            threadId: row.thread_id,
          })
        : fallbackUnit(group.workgroup_id, physicalSession);
      const sessionAllowedRoots = [
        physicalSession,
        path.join(DATA_DIR, 'workgroups', group.workgroup_id),
        ...groups
          .filter((candidate) => candidate.workgroup_id === group.workgroup_id)
          .map((candidate) => path.join(GROUPS_DIR, candidate.folder)),
      ];
      for (const checkoutPath of discoverPhysicalGitCheckouts(physicalSession, sessionAllowedRoots, {
        skipRootEntries: SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
      })) {
        const fallback = path.basename(checkoutPath);
        const classification = classifySessionRepositoryCheckout({
          checkoutPath,
          physicalSession,
          workgroupId: group.workgroup_id,
          liveWorkUnit: unit,
        });
        addCandidate(grouped, seen, physicalOwners, {
          workgroupId: group.workgroup_id,
          repo: repoForCheckout(checkoutPath, fallback),
          checkoutPath,
          ...classification,
        });
      }
    }
  }

  // Legacy thread checkout paths outside session roots get the same canonical
  // work-unit used by spawn/create/Graphify/cleanup. Inventory the physical
  // tree too so deleted DB rows cannot hide historical work.
  const physicalThreadUnits = new Map<string, RepositoryWorkUnit[]>();
  for (const row of rows) {
    const unit = resolveRepositoryWorkUnit({
      workgroupId: row.workgroup_id,
      sessionId: row.session_id,
      platformId: row.platform_id,
      messagingGroupId: row.messaging_group_id,
      threadId: row.thread_id,
    });
    if (!row.platform_id) continue;
    const root = threadWorktreeDir(row.platform_id, row.thread_id, row.workgroup_id);
    const key = path.resolve(root);
    const units = physicalThreadUnits.get(key) ?? [];
    if (!units.some((candidate) => candidate.workgroupId === unit.workgroupId && candidate.key === unit.key))
      units.push(unit);
    physicalThreadUnits.set(key, units);
  }
  const threadsRoot = path.join(DATA_DIR, 'v2-threads');
  for (const topName of safeDirectories(threadsRoot)) {
    const top = path.join(threadsRoot, topName);
    const topStat = fs.lstatSync(top);
    if (topStat.isSymbolicLink() || !topStat.isDirectory())
      throw new Error(`thread root is not a real directory: ${top}`);
    const roots: Array<{ state: string; worktrees: string; scopedWorkgroup?: string }> = [];
    const flatWorktrees = path.join(top, 'worktrees');
    if (fs.existsSync(flatWorktrees)) {
      roots.push({ state: top, worktrees: flatWorktrees });
    } else {
      if (topName.startsWith('wg-')) {
        const scopedWorkgroup = topName.slice(3);
        if (!groups.some((group) => group.workgroup_id === scopedWorkgroup)) {
          throw new Error(`historical thread namespace has no configured workgroup owner: ${top}`);
        }
        for (const threadName of safeDirectories(top)) {
          const state = path.join(top, threadName);
          const worktrees = path.join(state, 'worktrees');
          if (fs.existsSync(worktrees)) roots.push({ state, worktrees, scopedWorkgroup });
        }
      } else {
        // Old installs can leave empty messaging-group directories or put a
        // checkout directly below one. Empty roots are harmless; any actual
        // checkout is inventoried and requires an exact reviewed owner mapping.
        roots.push({ state: top, worktrees: top });
      }
    }
    for (const physical of roots) {
      const checkoutPaths = discoverPhysicalGitCheckouts(physical.worktrees, [physical.worktrees]);
      if (checkoutPaths.length === 0) continue;
      const mapped = physicalThreadUnits.get(path.resolve(physical.worktrees)) ?? [];
      const mappedWorkgroups = new Set(mapped.map((unit) => unit.workgroupId));
      const markerOwner = readThreadDirOwner(physical.state);
      const reviewedOwners = new Set(
        checkoutPaths
          .map((checkoutPath) => reviewedByPath.get(path.resolve(checkoutPath))?.workgroupId)
          .filter(Boolean),
      );
      if (reviewedOwners.size > 1) {
        throw new Error(`reviewed mappings split one historical thread root across workgroups: ${physical.worktrees}`);
      }
      const reviewedOwner = reviewedOwners.size === 1 ? [...reviewedOwners][0]! : null;
      const owner =
        physical.scopedWorkgroup ??
        markerOwner ??
        (mappedWorkgroups.size === 1 ? [...mappedWorkgroups][0] : null) ??
        reviewedOwner;
      if (!owner || owner === '!! conflict' || (mappedWorkgroups.size > 0 && !mappedWorkgroups.has(owner))) {
        ownershipErrors.push(
          ...checkoutPaths.map(
            (checkoutPath) => `${checkoutPath} (historical thread ownership missing; add an exact reviewed mapping)`,
          ),
        );
        continue;
      }
      if (reviewedOwner && reviewedOwner !== owner) {
        throw new Error(
          `reviewed historical checkout owner conflicts with live ownership evidence: ${physical.worktrees}`,
        );
      }
      if (selectedWorkgroup && owner !== selectedWorkgroup) continue;
      const ownerUnits = mapped.filter((unit) => unit.workgroupId === owner);
      const unit = ownerUnits.length > 0 ? ownerUnits[0] : fallbackUnit(owner, physical.state);
      if (ownerUnits.some((candidate) => candidate.key !== unit.key)) {
        throw new Error(`historical thread path maps to multiple work units: ${physical.worktrees}`);
      }
      for (const checkoutPath of checkoutPaths) {
        const fallback = path.basename(checkoutPath);
        addCandidate(grouped, seen, physicalOwners, {
          workgroupId: owner,
          repo: repoForCheckout(checkoutPath, fallback),
          checkoutPath,
          workUnit: unit,
        });
      }
    }
  }
  if (ownershipErrors.length > 0) {
    throw new Error(
      `historical repository ownership requires reviewed mappings:\n${ownershipErrors.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }

  // Object overlap is diagnostic evidence, not repository identity. Shared
  // templates, forks, and copied files can overlap heavily; an originless
  // checkout therefore remains its own local-only repository unless an
  // operator supplies an explicit mapping in a future reviewed manifest.

  // Add common Git dirs as collision-recovery candidates after the complete
  // repository inventory is known.
  for (const candidates of grouped.values()) {
    const common = candidates
      .map((candidate) => path.join(candidate.checkoutPath, '.git'))
      .filter((entry) => {
        try {
          return fs.lstatSync(entry).isDirectory();
        } catch {
          return false;
        }
      });
    for (const candidate of candidates) candidate.candidateCommonGitDirs = common;
  }
  return grouped;
}

function inventoryBareStores(groups: AgentGroupRow[], selectedWorkgroup?: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const physicalOwners = new Map<string, string>();
  const roots = new Set<string>();
  for (const group of groups) {
    if (selectedWorkgroup && group.workgroup_id !== selectedWorkgroup) continue;
    roots.add(`${group.workgroup_id}\0${path.join(GROUPS_DIR, group.folder, '.repos')}`);
    roots.add(`${group.workgroup_id}\0${path.join(DATA_DIR, 'workgroups', group.workgroup_id, '.repos')}`);
  }
  for (const entry of roots) {
    const separator = entry.indexOf('\0');
    const workgroupId = entry.slice(0, separator);
    const root = entry.slice(separator + 1);
    if (!fs.existsSync(root)) continue;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`bare repository root is not a real directory: ${root}`);
    }
    const rootReal = fs.realpathSync(root);
    for (const name of safeDirectories(root)) {
      if (!name.endsWith('.git')) continue;
      const store = path.join(root, name);
      const storeStat = fs.lstatSync(store);
      if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) {
        throw new Error(`bare repository entry is not a real directory: ${store}`);
      }
      const storeReal = fs.realpathSync(store);
      if (!contained(storeReal, rootReal)) throw new Error(`bare repository escapes workgroup root: ${store}`);
      try {
        if (
          execFileSync('git', ['--git-dir', store, 'rev-parse', '--is-bare-repository'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim() !== 'true'
        ) {
          throw new Error(`.repos entry is not a bare repository: ${store}`);
        }
      } catch (error) {
        throw new Error(
          `cannot validate bare repository ${store}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const priorOwner = physicalOwners.get(storeReal);
      if (priorOwner && priorOwner !== workgroupId) {
        throw new Error(`bare repository is shared across workgroups (${priorOwner}, ${workgroupId}): ${storeReal}`);
      }
      physicalOwners.set(storeReal, workgroupId);
      const repo = name.slice(0, -4);
      const key = `${workgroupId}\0${repo}`;
      const stores = result.get(key) ?? [];
      stores.push(storeReal);
      result.set(key, [...new Set(stores)].sort());
    }
  }
  return result;
}

export function coalesceRepositoryIdentityAliases(
  grouped: Map<string, LegacyCheckoutCandidate[]>,
  bareStores: Map<string, string[]>,
  reviewedAliases: Array<{ workgroupId: string; sourceRepo: string; destinationRepo: string }> = [],
): void {
  const keys = new Set([...grouped.keys(), ...bareStores.keys()]);
  const identityGroups = [...keys].map((key) => {
    const [workgroupId, repo] = key.split('\0');
    const candidates = grouped.get(key) ?? [];
    const stores = bareStores.get(key) ?? [];
    const context = createLegacyGitResolutionContext([
      ...candidates.flatMap((candidate) => candidate.candidateCommonGitDirs ?? []),
      ...stores,
    ]);
    const observedOrigins: Array<string | null> = [];
    for (const candidate of candidates) {
      try {
        observedOrigins.push(originFor(candidate, context));
      } catch {
        // A broken pointer may become recoverable after its repository alias is coalesced.
      }
    }
    for (const store of stores) {
      try {
        observedOrigins.push(originForObjectStore(store, context));
      } catch {
        // The final repository inventory reports the exact store error.
      }
    }
    return {
      key,
      workgroupId,
      repo,
      physicalCount: candidates.length,
      objectStoreCount: stores.length,
      observedOrigins,
    };
  });
  const plan = planLegacyRepositoryCoalescing(identityGroups, reviewedAliases);
  for (const sourceKey of [...keys].sort()) {
    const destinationKey = plan.get(sourceKey) ?? sourceKey;
    if (sourceKey === destinationKey) continue;
    const destinationRepo = destinationKey.split('\0')[1];
    const sourceCandidates = grouped.get(sourceKey) ?? [];
    const destinationCandidates = grouped.get(destinationKey) ?? [];
    for (const candidate of sourceCandidates) candidate.repo = destinationRepo;
    grouped.set(destinationKey, [...destinationCandidates, ...sourceCandidates]);
    grouped.delete(sourceKey);
    const sourceStores = bareStores.get(sourceKey) ?? [];
    bareStores.set(destinationKey, [...new Set([...(bareStores.get(destinationKey) ?? []), ...sourceStores])].sort());
    bareStores.delete(sourceKey);
    console.error(
      `Coalesced legacy repository alias ${sourceKey.replace('\0', '/')} -> ${destinationKey.replace('\0', '/')}`,
    );
  }
  for (const [key, candidates] of grouped) {
    const common = [
      ...(bareStores.get(key) ?? []),
      ...candidates.flatMap((candidate) => candidate.candidateCommonGitDirs ?? []),
      ...candidates
        .map((candidate) => path.join(candidate.checkoutPath, '.git'))
        .filter((entry) => {
          try {
            return fs.lstatSync(entry).isDirectory();
          } catch {
            return false;
          }
        }),
    ];
    for (const candidate of candidates) candidate.candidateCommonGitDirs = [...new Set(common)].sort();
  }
}

export interface PreparedReviewedRepositoryAliases {
  reviewedRecovery: LoadedReviewedRecoveryDecisions | null;
  consumedOriginKeys: Set<string>;
  aliasedCheckoutPaths: Set<string>;
  aliasedObjectStores: Set<string>;
}

export function prepareReviewedRepositoryAliases(
  grouped: Map<string, LegacyCheckoutCandidate[]>,
  bareStores: Map<string, string[]>,
  reviewedRecovery: LoadedReviewedRecoveryDecisions | null,
): PreparedReviewedRepositoryAliases {
  if (!reviewedRecovery || reviewedRecovery.repositoryAliases.length === 0) {
    return {
      reviewedRecovery,
      consumedOriginKeys: new Set(),
      aliasedCheckoutPaths: new Set(),
      aliasedObjectStores: new Set(),
    };
  }
  const checkoutByPath = new Map(
    reviewedRecovery.checkouts.map((decision) => [path.resolve(decision.checkoutPath), decision]),
  );
  const originByKey = new Map(
    reviewedRecovery.origins.map((decision) => [`${decision.workgroupId}\0${decision.repo}`, decision]),
  );
  const normalizedCheckouts = new Map<string, ReviewedCheckoutRecoveryDecision>(checkoutByPath);
  const consumedOriginKeys = new Set<string>();
  const aliasedCheckoutPaths = new Set<string>();
  const aliasedObjectStores = new Set<string>();

  for (const alias of reviewedRecovery.repositoryAliases) {
    const sourceKey = `${alias.workgroupId}\0${alias.sourceRepo}`;
    const destinationKey = `${alias.workgroupId}\0${alias.destinationRepo}`;
    const sourceCandidates = grouped.get(sourceKey);
    if (!sourceCandidates && !bareStores.has(sourceKey)) {
      throw new Error(`reviewed repository alias source is absent: ${alias.workgroupId}/${alias.sourceRepo}`);
    }
    if (!grouped.has(destinationKey) && !bareStores.has(destinationKey)) {
      throw new Error(`reviewed repository alias destination is absent: ${alias.workgroupId}/${alias.destinationRepo}`);
    }
    const originDecision = originByKey.get(sourceKey);
    if (!originDecision || originDecision.archiveOnly !== true || originDecision.selectedOrigin !== null) {
      throw new Error(
        `reviewed repository alias source requires an originless archive-only disposition: ` +
          `${alias.workgroupId}/${alias.sourceRepo}`,
      );
    }
    const context = createLegacyGitResolutionContext([
      ...(sourceCandidates ?? []).flatMap((candidate) => candidate.candidateCommonGitDirs ?? []),
      ...(bareStores.get(sourceKey) ?? []),
    ]);
    const observedOrigins = [
      ...(sourceCandidates ?? []).flatMap((candidate) => {
        try {
          return [normalizedObservedOrigin(originFor(candidate, context))];
        } catch {
          return [];
        }
      }),
      ...(bareStores.get(sourceKey) ?? []).map((store) =>
        normalizedObservedOrigin(originForObjectStore(store, context)),
      ),
    ];
    if (
      selectReviewedOrigin({
        workgroupId: alias.workgroupId,
        repo: alias.sourceRepo,
        observedOrigins,
        decision: originDecision,
      }) !== null
    ) {
      throw new Error(
        `reviewed repository alias source must remain originless: ${alias.workgroupId}/${alias.sourceRepo}`,
      );
    }
    consumedOriginKeys.add(sourceKey);

    for (const candidate of sourceCandidates ?? []) {
      const checkoutPath = path.resolve(candidate.checkoutPath);
      const decision = checkoutByPath.get(checkoutPath);
      if (
        !decision ||
        decision.workgroupId !== alias.workgroupId ||
        decision.repo !== alias.sourceRepo ||
        decision.action !== 'archive-visible-state'
      ) {
        throw new Error(
          `reviewed repository alias source checkout requires an exact archive-visible-state decision: ${checkoutPath}`,
        );
      }
      normalizedCheckouts.set(checkoutPath, { ...decision, repo: alias.destinationRepo });
      aliasedCheckoutPaths.add(checkoutPath);
    }
    for (const store of bareStores.get(sourceKey) ?? []) aliasedObjectStores.add(path.resolve(store));
  }

  return {
    reviewedRecovery: { ...reviewedRecovery, checkouts: [...normalizedCheckouts.values()] },
    consumedOriginKeys,
    aliasedCheckoutPaths,
    aliasedObjectStores,
  };
}

export function assertServiceInactive(
  service: string,
  query: (command: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }),
  scope: 'system' | 'user' = 'system',
): void {
  let output: string;
  try {
    output = query('systemctl', [
      ...(scope === 'user' ? ['--user'] : []),
      'show',
      service,
      '--property=LoadState',
      '--property=ActiveState',
    ]);
  } catch (error) {
    throw new Error(
      `cannot prove service quiescence for ${service}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const state = new Map(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error(`malformed systemd state for ${service}: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
  const loadState = state.get('LoadState');
  const activeState = state.get('ActiveState');
  if (loadState === 'not-found' && activeState === 'inactive') return;
  if (loadState === 'loaded' && activeState === 'inactive') return;
  if (!loadState || !activeState) throw new Error(`systemd did not return complete state for ${service}`);
  throw new Error(`fleet is not quiescent: ${service} is ${loadState}/${activeState}`);
}

let protectedMigrationInodes: ProtectedInodeInventory | undefined;

function assertFleetQuiescent(paths: string[], refreshInodes = false): void {
  const services = [...new Set(['nanoclaw.service', 'nanoclaw-v2.service', `${getSystemdUnit(REPO_ROOT)}.service`])];
  for (const service of services) {
    assertServiceInactive(service);
    // Check both managers unconditionally. A unit may remain loaded after its
    // file is removed, so filesystem registration discovery cannot prove that
    // the user manager is quiet. An unavailable manager therefore fails closed.
    assertServiceInactive(service, undefined, 'user');
  }
  try {
    const containers = execFileSync('docker', ['ps', '-q', '--filter', `label=${CONTAINER_INSTALL_LABEL}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim();
    if (containers) throw new Error(`fleet is not quiescent: containers remain (${containers.split('\n').length})`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('fleet is not quiescent')) throw error;
    throw new Error(`cannot prove container quiescence: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  {
    const startedAt = Date.now();
    const before = protectedMigrationInodes?.inodes.size ?? 0;
    protectedMigrationInodes = extendProtectedInodeInventory(paths, protectedMigrationInodes, {
      refresh: refreshInodes,
    });
    const added = protectedMigrationInodes.inodes.size - before;
    if (added > 0) {
      console.error(
        `Captured ${added} new protected inode(s) for writer quiescence ` +
          `(${protectedMigrationInodes.inodes.size} total) in ${Date.now() - startedAt}ms`,
      );
    }
  }
  let snapshot: Buffer;
  try {
    // `lsof +D <root>` recursively stats the entire root before it examines
    // descriptors. Large workgroups can therefore time out even when no file
    // is open, and repeating that traversal for every migration boundary is
    // quadratic in the retained topology. Capture the kernel's open-file view
    // once and filter its NUL-delimited records against the exact protected
    // roots instead. Service/container admission is already stopped above, so
    // the snapshot closes the remaining same-host process writer surface.
    snapshot = execFileSync('lsof', ['-nP', '-F0pDin'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot prove repository writer quiescence: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const foreign = pidsWithOpenFilesBelow(paths, snapshot, process.pid, protectedMigrationInodes.inodes);
  if (foreign.length > 0) {
    throw new Error(`repository writers remain below protected roots: ${foreign.join(',')}`);
  }
}

function minimalQuiescenceRoots(paths: readonly string[]): string[] {
  const selected: string[] = [];
  for (const candidate of [...new Set(paths.map((entry) => path.resolve(entry)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )) {
    if (selected.some((root) => contained(candidate, root))) continue;
    selected.push(candidate);
  }
  return selected.sort();
}

function preManifestQuiescencePaths(
  groups: AgentGroupRow[],
  grouped: Map<string, LegacyCheckoutCandidate[]>,
  bareStores: Map<string, string[]>,
): string[] {
  const workgroups = new Set([...grouped.keys()].map((key) => key.slice(0, key.indexOf('\0'))));
  const paths = new Set<string>();
  for (const candidates of grouped.values()) {
    for (const candidate of candidates) {
      paths.add(path.resolve(candidate.checkoutPath));
      for (const gitDir of candidate.candidateCommonGitDirs ?? []) paths.add(path.resolve(gitDir));
    }
  }
  for (const stores of bareStores.values()) {
    for (const store of stores) paths.add(path.resolve(store));
  }
  for (const group of groups) {
    if (!workgroups.has(group.workgroup_id)) continue;
    // These are the configured legacy roots searched by inventory. Proving
    // only the checkout directory quiet is insufficient: another process can
    // mutate a linked external common Git dir, create a new nested checkout,
    // or update a group-local bare store while the hash-bound manifest is
    // being captured.
    paths.add(path.resolve(GROUPS_DIR, group.folder));
    paths.add(path.resolve(DATA_DIR, 'workgroups', group.workgroup_id));
    paths.add(path.resolve(DATA_DIR, 'v2-sessions', group.agent_group_id));
    paths.add(path.resolve(DATA_DIR, 'repositories', group.workgroup_id));
  }
  paths.add(path.resolve(DATA_DIR, 'v2-threads'));
  return minimalQuiescenceRoots([...paths]);
}

function controlPlaneBackupSources(): string[] {
  return [
    path.join(DATA_DIR, 'v2.db'),
    path.join(DATA_DIR, 'v2.db-wal'),
    path.join(DATA_DIR, 'v2.db-shm'),
    path.join(REPO_ROOT, '.env'),
    ...safeDirectories(GROUPS_DIR).map((folder) => path.join(GROUPS_DIR, folder, 'container.json')),
  ].filter((file) => fs.existsSync(file));
}

function controlPlaneBackupCapacityBytes(): number {
  const blockSize = Number(fs.statfsSync(DATA_DIR).bsize);
  const sources = controlPlaneBackupSources();
  const fileBytes = sources.reduce(
    (sum, source) => sum + Math.ceil(fs.lstatSync(source).size / blockSize) * blockSize,
    0,
  );
  // Inventory JSON, temporary atomic publication, and directory entries.
  return fileBytes + Math.max(1024 * 1024, (sources.length + 4) * blockSize * 2);
}

export function aggregateCapacityEvidence(manifests: RepositoryMigrationManifest[]): AggregateCapacityEvidence {
  const migrationCoreBytes = manifests.reduce(
    (sum, manifest) => sum + manifest.capacity.requiredBytes - manifest.capacity.safetyBytes,
    0,
  );
  const controlPlaneBackupBytes = controlPlaneBackupCapacityBytes();
  const globalSafetyBytes = Math.max(1024 ** 3, Math.ceil(migrationCoreBytes * 0.1));
  return {
    migrationCoreBytes,
    controlPlaneBackupBytes,
    globalSafetyBytes,
    requiredBytes: migrationCoreBytes + controlPlaneBackupBytes + globalSafetyBytes,
  };
}

function verifyAggregateCapacityEvidence(
  manifests: RepositoryMigrationManifest[],
  aggregate: AggregateCapacityEvidence,
): void {
  const migrationCoreBytes = manifests.reduce(
    (sum, manifest) => sum + manifest.capacity.requiredBytes - manifest.capacity.safetyBytes,
    0,
  );
  const globalSafetyBytes = Math.max(1024 ** 3, Math.ceil(migrationCoreBytes * 0.1));
  if (
    aggregate.migrationCoreBytes !== migrationCoreBytes ||
    aggregate.globalSafetyBytes !== globalSafetyBytes ||
    !Number.isSafeInteger(aggregate.controlPlaneBackupBytes) ||
    aggregate.controlPlaneBackupBytes < 0 ||
    aggregate.requiredBytes !== migrationCoreBytes + aggregate.controlPlaneBackupBytes + globalSafetyBytes
  ) {
    throw new Error('server migration aggregate capacity evidence mismatch');
  }
}

export function assertRemainingAggregateCapacity(
  remaining: RepositoryMigrationManifest[],
  aggregate: AggregateCapacityEvidence,
  availableBytesOverride?: number,
): void {
  const remainingCoreBytes = remaining.reduce(
    (sum, manifest) => sum + manifest.capacity.requiredBytes - manifest.capacity.safetyBytes,
    0,
  );
  const requiredBytes = remainingCoreBytes + aggregate.globalSafetyBytes;
  const statfs = availableBytesOverride === undefined ? fs.statfsSync(DATA_DIR) : null;
  const availableBytes = availableBytesOverride ?? Number(statfs!.bavail) * Number(statfs!.bsize);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `remaining aggregate capacity gate rejected before mutation: ${availableBytes} bytes available, ` +
        `${requiredBytes} bytes required`,
    );
  }
}

function backupControlPlane(runId: string): void {
  const root = path.join(DATA_DIR, 'repository-migrations', runId, 'control-plane-backup');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = controlPlaneBackupSources();
  const inventory: Array<{ source: string; backup: string; size: number; sha256: string }> = [];
  for (const source of files) {
    const relative = path.relative(REPO_ROOT, source);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`control-plane backup path escapes: ${source}`);
    const backup = path.join(root, relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (fs.existsSync(backup)) {
      const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      const backupHash = createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
      if (sourceHash !== backupHash) throw new Error(`control-plane backup drift on resume: ${source}`);
    } else {
      fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(backup, 0o600);
    const backupFd = fs.openSync(backup, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(backupFd);
    } finally {
      fs.closeSync(backupFd);
    }
    const bytes = fs.readFileSync(backup);
    inventory.push({
      source,
      backup,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  atomicJson(path.join(root, 'inventory.json'), inventory);
}

export interface ActiveServerMigration {
  version: 2;
  runId: string;
  manifestPaths: string[];
  manifestHashes: string[];
  createdAt: string;
  reviewedMapping?: { sourcePath: string; sha256: string; applied: number };
  reviewedRecovery?: { sourcePath: string; sha256: string; checkouts: number; origins: number };
  recoverySeeds: Array<{ gitDir: string; sha256: string }>;
  aggregateCapacity: AggregateCapacityEvidence;
  protectedArchives?: ProtectedArchiveEvidence[];
  descriptorSha256: string;
}

export interface AggregateCapacityEvidence {
  migrationCoreBytes: number;
  controlPlaneBackupBytes: number;
  globalSafetyBytes: number;
  requiredBytes: number;
}

function activeMigrationPath(): string {
  return path.join(DATA_DIR, 'repository-migrations', 'active-server-migration.json');
}

function completedMigrationPath(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`invalid migration run id: ${runId}`);
  return path.join(DATA_DIR, 'repository-migrations', runId, 'completed-server-migration.json');
}

function activeRollbackPath(runId: string): string {
  return path.join(DATA_DIR, 'repository-migrations', runId, 'active-server-rollback.json');
}

function completedRollbackPath(runId: string): string {
  return path.join(DATA_DIR, 'repository-migrations', runId, 'completed-server-rollback.json');
}

function recoverySeedEvidence(
  reviewedRecovery: LoadedReviewedRecoveryDecisions | null,
): Array<{ gitDir: string; sha256: string }> {
  const seeds = new Map<string, string>();
  for (const decision of reviewedRecovery?.checkouts ?? []) {
    const candidates = [
      decision.externalSeedGitDirSha256
        ? { gitDir: decision.selectedCommonGitDir, sha256: decision.externalSeedGitDirSha256 }
        : null,
      decision.supplementalSeedGitDir && decision.supplementalSeedGitDirSha256
        ? { gitDir: decision.supplementalSeedGitDir, sha256: decision.supplementalSeedGitDirSha256 }
        : null,
    ].filter((entry): entry is { gitDir: string; sha256: string } => entry !== null);
    for (const candidate of candidates) {
      const gitDir = fs.realpathSync(candidate.gitDir);
      const prior = seeds.get(gitDir);
      if (prior && prior !== candidate.sha256) throw new Error(`conflicting recovery seed evidence: ${gitDir}`);
      seeds.set(gitDir, candidate.sha256);
    }
  }
  return [...seeds]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([gitDir, sha256]) => ({ gitDir, sha256 }));
}

function validateRecoverySeedEvidence(seeds: Array<{ gitDir: string; sha256: string }>): void {
  for (const seed of seeds) {
    if (!/^[a-f0-9]{64}$/.test(seed.sha256)) throw new Error(`invalid recovery seed digest: ${seed.gitDir}`);
    if (recoverySeedGitDirSha256(seed.gitDir) !== seed.sha256) {
      throw new Error(`recovery seed changed after reviewed inventory: ${seed.gitDir}`);
    }
  }
}

function descriptorSha256(descriptor: Omit<ActiveServerMigration, 'descriptorSha256'>): string {
  return sha(canonicalJson(descriptor));
}

export function loadMigrationDescriptor(
  file: string,
  dataDir: string = DATA_DIR,
): { descriptor: ActiveServerMigration; manifests: RepositoryMigrationManifest[] } {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`migration descriptor is not a regular file: ${file}`);
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8')) as ActiveServerMigration;
  if (
    descriptor.version !== 2 ||
    !descriptor.runId ||
    !Array.isArray(descriptor.manifestPaths) ||
    !Array.isArray(descriptor.manifestHashes) ||
    !Array.isArray(descriptor.recoverySeeds) ||
    descriptor.manifestPaths.length !== descriptor.manifestHashes.length
  ) {
    throw new Error('server migration descriptor is malformed');
  }
  const { descriptorSha256: expectedDescriptorSha256, ...descriptorBase } = descriptor;
  if (
    !/^[a-f0-9]{64}$/.test(expectedDescriptorSha256) ||
    descriptorSha256(descriptorBase) !== expectedDescriptorSha256
  ) {
    throw new Error('server migration descriptor hash mismatch');
  }
  const manifests = descriptor.manifestPaths.map((entry, index) => {
    const expectedRoot = path.join(dataDir, 'repository-migrations', descriptor.runId);
    const resolved = path.resolve(entry);
    if (resolved !== expectedRoot && !resolved.startsWith(`${expectedRoot}${path.sep}`)) {
      throw new Error(`active manifest path escapes the run root: ${entry}`);
    }
    const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8')) as RepositoryMigrationManifest;
    if (manifest.runId !== descriptor.runId || manifest.manifestSha256 !== descriptor.manifestHashes[index]) {
      throw new Error(`server migration manifest identity mismatch: ${entry}`);
    }
    verifyRepositoryMigrationManifest(manifest);
    return manifest;
  });
  assertRepositoryMigrationManifestOrder(manifests);
  verifyAggregateCapacityEvidence(manifests, descriptor.aggregateCapacity);
  validateRecoverySeedEvidence(descriptor.recoverySeeds);
  return { descriptor, manifests };
}

function loadActiveMigration(): { descriptor: ActiveServerMigration; manifests: RepositoryMigrationManifest[] } | null {
  const file = activeMigrationPath();
  if (!fs.existsSync(file)) return null;
  return loadMigrationDescriptor(file);
}

function persistActiveMigration(
  runId: string,
  manifests: RepositoryMigrationManifest[],
  reviewedMapping: { sourcePath: string; sha256: string; applied: number } | null,
  reviewedRecovery: LoadedReviewedRecoveryDecisions | null,
  protectedArchives: ProtectedArchiveEvidence[],
  aggregateCapacity: AggregateCapacityEvidence,
): void {
  assertRepositoryMigrationManifestOrder(manifests);
  for (const manifest of manifests) atomicJson(manifestPath(manifest), manifest);
  const descriptorBase: Omit<ActiveServerMigration, 'descriptorSha256'> = {
    version: 2,
    runId,
    manifestPaths: manifests.map(manifestPath),
    manifestHashes: manifests.map((manifest) => manifest.manifestSha256),
    createdAt: new Date().toISOString(),
    ...(reviewedMapping ? { reviewedMapping } : {}),
    ...(reviewedRecovery
      ? {
          reviewedRecovery: {
            sourcePath: reviewedRecovery.sourcePath,
            sha256: reviewedRecovery.sha256,
            checkouts: reviewedRecovery.checkouts.length,
            origins: reviewedRecovery.origins.length,
          },
        }
      : {}),
    recoverySeeds: recoverySeedEvidence(reviewedRecovery),
    aggregateCapacity,
    ...(protectedArchives.length > 0 ? { protectedArchives } : {}),
  };
  atomicJson(activeMigrationPath(), {
    ...descriptorBase,
    descriptorSha256: descriptorSha256(descriptorBase),
  } satisfies ActiveServerMigration);
}

function contained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function manifestExecutionKey(manifest: RepositoryMigrationManifest): string {
  return `${manifest.workgroupId}\0${manifest.repo}\0${manifest.manifestSha256}`;
}

/**
 * Return a deterministic physical-containment topological order. A repository
 * with a checkout nested below another repository's checkout must be cut over
 * first, regardless of workgroup/repository lexical order. The descriptor
 * persists this exact order; rollback deliberately reverses it.
 */
export function orderRepositoryMigrationManifests(
  manifests: readonly RepositoryMigrationManifest[],
): RepositoryMigrationManifest[] {
  const keys = manifests.map(manifestExecutionKey);
  if (new Set(keys.map((key) => key.slice(0, key.lastIndexOf('\0')))).size !== manifests.length) {
    throw new Error('server migration contains duplicate workgroup/repository manifests');
  }
  const outgoing = manifests.map(() => new Set<number>());
  const indegree = manifests.map(() => 0);
  for (let leftIndex = 0; leftIndex < manifests.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifests.length; rightIndex += 1) {
      let leftBeforeRight = false;
      let rightBeforeLeft = false;
      for (const leftCapture of manifests[leftIndex].captures) {
        const leftPath = path.resolve(leftCapture.checkoutPath);
        for (const rightCapture of manifests[rightIndex].captures) {
          const rightPath = path.resolve(rightCapture.checkoutPath);
          if (leftPath === rightPath) {
            throw new Error(`physical checkout is claimed by multiple repositories: ${leftPath}`);
          }
          if (contained(leftPath, rightPath)) leftBeforeRight = true;
          if (contained(rightPath, leftPath)) rightBeforeLeft = true;
        }
      }
      if (leftBeforeRight) outgoing[leftIndex].add(rightIndex);
      if (rightBeforeLeft) outgoing[rightIndex].add(leftIndex);
    }
  }
  for (const destinations of outgoing) {
    for (const destination of destinations) indegree[destination] += 1;
  }
  const ready = manifests
    .map((_manifest, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => keys[left].localeCompare(keys[right]));
  const ordered: RepositoryMigrationManifest[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(manifests[current]);
    for (const destination of [...outgoing[current]].sort((left, right) => keys[left].localeCompare(keys[right]))) {
      indegree[destination] -= 1;
      if (indegree[destination] === 0) {
        ready.push(destination);
        ready.sort((left, right) => keys[left].localeCompare(keys[right]));
      }
    }
  }
  if (ordered.length !== manifests.length) {
    const cycle = manifests
      .filter((_manifest, index) => indegree[index] > 0)
      .map((manifest) => `${manifest.workgroupId}/${manifest.repo}`)
      .sort();
    throw new Error(`repository checkout containment cannot be ordered safely: ${cycle.join(', ')}`);
  }
  return ordered;
}

function assertRepositoryMigrationManifestOrder(manifests: readonly RepositoryMigrationManifest[]): void {
  const expected = orderRepositoryMigrationManifests(manifests);
  if (expected.some((manifest, index) => manifestExecutionKey(manifest) !== manifestExecutionKey(manifests[index]))) {
    throw new Error('server migration manifests are not in deterministic physical-containment order');
  }
}

function strictDirectoryNames(root: string, label: string): string[] {
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a real directory: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`unsafe entry in ${label}: ${path.join(root, entry.name)}`);
      }
      return entry.name;
    });
}

export function assertExactRepositoryNamespaces(
  manifests: RepositoryMigrationManifest[],
  dataDir: string = DATA_DIR,
): void {
  const migratedWorkgroups = new Set(manifests.map((manifest) => manifest.workgroupId));
  const expectedCanonicals = new Set(
    manifests
      .filter((manifest) => !manifest.archiveOnly)
      .map((manifest) => `${manifest.workgroupId}\0${manifest.repo}`),
  );
  const actualCanonicals = new Set<string>();
  for (const workgroupId of strictDirectoryNames(repositoriesRoot(dataDir), 'canonical repository namespace')) {
    if (!migratedWorkgroups.has(workgroupId)) continue;
    for (const repo of strictDirectoryNames(
      path.join(repositoriesRoot(dataDir), workgroupId),
      `canonical repository workgroup namespace ${workgroupId}`,
    )) {
      actualCanonicals.add(`${workgroupId}\0${repo}`);
    }
  }
  const expectedCoordination = new Set(manifests.map((manifest) => `${manifest.workgroupId}\0${manifest.repo}`));
  const actualCoordination = new Set<string>();
  const actualPins = new Set<string>();
  for (const workgroupId of strictDirectoryNames(repositoryStateRoot(dataDir), 'repository coordination namespace')) {
    if (!migratedWorkgroups.has(workgroupId)) continue;
    for (const repo of strictDirectoryNames(
      path.join(repositoryStateRoot(dataDir), workgroupId),
      `repository coordination workgroup namespace ${workgroupId}`,
    )) {
      const key = `${workgroupId}\0${repo}`;
      actualCoordination.add(key);
      const pinPath = path.join(repositoryStateRoot(dataDir), workgroupId, repo, 'origin.json');
      try {
        const stat = fs.lstatSync(pinPath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe origin pin: ${pinPath}`);
        actualPins.add(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const compare = (label: string, expected: Set<string>, actual: Set<string>): void => {
    const missing = [...expected].filter((key) => !actual.has(key));
    const extra = [...actual].filter((key) => !expected.has(key));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${label} does not exactly match the migration manifest; ` +
          `missing=[${missing.map((key) => key.replace('\0', '/')).join(', ')}], ` +
          `extra=[${extra.map((key) => key.replace('\0', '/')).join(', ')}]`,
      );
    }
  };
  compare('canonical repository namespace', expectedCanonicals, actualCanonicals);
  compare('repository coordination namespace', expectedCoordination, actualCoordination);
  compare('origin pin namespace', expectedCanonicals, actualPins);
}

export function assertNoResidualLegacyCheckoutTopology(
  residual: ReadonlyMap<string, readonly LegacyCheckoutCandidate[]>,
  migratedWorkgroups: ReadonlySet<string>,
): void {
  const residualKeys = [...residual.keys()]
    .filter((key) => migratedWorkgroups.has(key.slice(0, key.indexOf('\0'))))
    .sort();
  if (residualKeys.length > 0) {
    throw new Error(`residual legacy checkout topology remains: ${residualKeys.join(', ')}`);
  }
}

function auditServerTopology(
  manifests: RepositoryMigrationManifest[],
  protectedArchives: ProtectedArchiveEvidence[],
): void {
  const canonicalKeys = new Set<string>();
  const topicDestinations = new Map<string, string>();
  for (const manifest of manifests) {
    auditRepositoryMigration(manifest);
    const key = `${manifest.workgroupId}\0${manifest.repo}`;
    if (canonicalKeys.has(key))
      throw new Error(`duplicate canonical manifest: ${manifest.workgroupId}/${manifest.repo}`);
    canonicalKeys.add(key);
    const canonical = canonicalRepoDir(manifest.workgroupId, manifest.repo, manifest.dataDir);
    if (manifest.archiveOnly) {
      if (fs.existsSync(canonical)) {
        throw new Error(`archive-only repository has an active canonical: ${manifest.workgroupId}/${manifest.repo}`);
      }
      if (readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir)) {
        throw new Error(`archive-only repository has an active origin pin: ${manifest.workgroupId}/${manifest.repo}`);
      }
    } else {
      if (!contained(fs.realpathSync(canonical), path.join(repositoriesRoot(manifest.dataDir), manifest.workgroupId))) {
        throw new Error(`canonical escapes workgroup namespace: ${canonical}`);
      }
      const pin = readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir);
      if (!pin || pin.origin !== manifest.origin || pin.repositoryId !== manifest.repositoryId) {
        throw new Error(`canonical origin pin mismatch: ${manifest.workgroupId}/${manifest.repo}`);
      }
    }
    for (const capture of manifest.captures) {
      if (!capture.renamedOldPath || !fs.existsSync(capture.renamedOldPath)) {
        throw new Error(`retained old checkout is missing: ${capture.checkoutPath}`);
      }
      if (fs.existsSync(capture.checkoutPath)) throw new Error(`legacy checkout remains live: ${capture.checkoutPath}`);
      if (!capture.destinationPath) continue;
      if (capture.preservedLegacy) {
        const expectedRoot = path.join(manifest.dataDir, 'repository-rescues', manifest.workgroupId, manifest.repo);
        if (!contained(fs.realpathSync(capture.destinationPath), expectedRoot)) {
          throw new Error(`legacy canonical rescue escapes its host-only namespace: ${capture.destinationPath}`);
        }
        continue;
      }
      const expectedRoot = topicWorktreesDir(capture.workUnit, manifest.dataDir);
      if (!contained(fs.realpathSync(capture.destinationPath), expectedRoot)) {
        throw new Error(`topic worktree escapes its work-unit namespace: ${capture.destinationPath}`);
      }
      if (!contained(capture.destinationPath, path.join(topicsRoot(manifest.dataDir), manifest.workgroupId))) {
        throw new Error(`topic worktree escapes its workgroup namespace: ${capture.destinationPath}`);
      }
      const topicKey = `${capture.workgroupId}\0${capture.workUnit.key}\0${capture.repo}`;
      const prior = topicDestinations.get(topicKey);
      if (prior && prior !== capture.destinationPath)
        throw new Error(`same topic resolves to multiple worktrees: ${topicKey}`);
      topicDestinations.set(topicKey, capture.destinationPath);
    }
    for (const store of manifest.objectStores) {
      if (store.split(path.sep).includes('.repos') && fs.existsSync(store)) {
        throw new Error(`live bare-mirror topology remains: ${store}`);
      }
    }
  }

  // Re-run discovery from the configured DB roots after conversion. A checkout
  // omitted by the manifest, an unreadable root, or a residual bare store is a
  // hard activation blocker even when every listed manifest audits cleanly.
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  let rows: SessionRow[];
  let groups: AgentGroupRow[];
  try {
    rows = loadRows(db);
    groups = loadAgentGroups(db);
  } finally {
    db.close();
  }
  const migratedWorkgroups = new Set(manifests.map((manifest) => manifest.workgroupId));
  const residual = inventoryCandidates(rows, groups);
  assertNoResidualLegacyCheckoutTopology(residual, migratedWorkgroups);
  const residualBare = inventoryBareStores(groups);
  const residualBareKeys = [...residualBare.keys()].filter((key) =>
    migratedWorkgroups.has(key.slice(0, key.indexOf('\0'))),
  );
  if (residualBareKeys.length > 0) {
    throw new Error(`residual bare repository topology remains: ${residualBareKeys.join(', ')}`);
  }
  assertExactRepositoryNamespaces(manifests);
  verifyProtectedArchives(protectedArchives);
}

function migrationQuiescencePaths(
  manifests: RepositoryMigrationManifest[],
  protectedArchives: ProtectedArchiveEvidence[],
): string[] {
  return minimalQuiescenceRoots([
    ...new Set([
      ...manifests.flatMap((manifest) => [
        ...manifest.captures.map((capture) => capture.checkoutPath),
        ...manifest.captures.flatMap((capture) =>
          [capture.destinationPath, capture.renamedOldPath].filter((entry): entry is string => Boolean(entry)),
        ),
        ...manifest.objectStores,
        repositoryMigrationPath(manifest),
        path.dirname(canonicalRepoDir(manifest.workgroupId, manifest.repo, manifest.dataDir)),
        path.join(repositoryStateRoot(manifest.dataDir), manifest.workgroupId, manifest.repo),
        path.join(manifest.dataDir, 'repository-migrations', manifest.runId, manifest.workgroupId, manifest.repo),
      ]),
      ...protectedArchives.map((archive) => archive.root),
    ]),
  ]);
}

async function executeAndAudit(
  manifests: RepositoryMigrationManifest[],
  runId: string,
  protectedArchives: ProtectedArchiveEvidence[],
  aggregateCapacity: AggregateCapacityEvidence,
  recoverySeeds: Array<{ gitDir: string; sha256: string }>,
): Promise<void> {
  assertRepositoryMigrationManifestOrder(manifests);
  const allPaths = migrationQuiescencePaths(manifests, protectedArchives);
  assertFleetQuiescent(allPaths);
  backupControlPlane(runId);
  validateRecoverySeedEvidence(recoverySeeds);
  try {
    for (let index = 0; index < manifests.length; index += 1) {
      const remaining = manifests.slice(index).filter((candidate) => {
        try {
          auditRepositoryMigration(candidate);
          return false;
        } catch {
          return true;
        }
      });
      assertRemainingAggregateCapacity(remaining, aggregateCapacity);
      const manifest = manifests[index];
      const repositoryPaths = migrationQuiescencePaths([manifest], []);
      const completedPaths = completedRepositoryQuiescencePaths(manifest);
      await executeRepositoryMigration(manifest, {
        assertQuiescent: () => assertFleetQuiescent(repositoryPaths),
        refreshQuiescent: () => assertFleetQuiescent(completedPaths, true),
      });
      // Migration creates new canonical, linked-worktree, state, journal, and
      // bundle inodes under roots captured before the manifest existed. Merge
      // those exact post-mutation trees, then take another open-file snapshot
      // before advancing to the next repository.
      assertFleetQuiescent(completedPaths, true);
    }
    auditServerTopology(manifests, protectedArchives);
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const manifest of [...manifests].reverse()) {
      try {
        assertFleetQuiescent(completedRepositoryQuiescencePaths(manifest), true);
        await rollbackRepositoryMigration(manifest);
        assertFleetQuiescent(completedRepositoryQuiescencePaths(manifest), true);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${manifest.workgroupId}/${manifest.repo}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    for (const manifest of manifests) {
      for (const capture of manifest.captures) {
        if (!fs.existsSync(capture.checkoutPath)) {
          rollbackErrors.push(
            `${manifest.workgroupId}/${manifest.repo}: original checkout not restored: ${capture.checkoutPath}`,
          );
        }
      }
      for (const store of manifest.objectStores) {
        if (!fs.existsSync(store))
          rollbackErrors.push(`${manifest.workgroupId}/${manifest.repo}: object store not restored: ${store}`);
      }
      if (fs.existsSync(repositoryMigrationPath(manifest))) {
        rollbackErrors.push(`${manifest.workgroupId}/${manifest.repo}: migration repository remains after rollback`);
      }
    }
    try {
      verifyProtectedArchives(protectedArchives);
    } catch (archiveError) {
      rollbackErrors.push(archiveError instanceof Error ? archiveError.message : String(archiveError));
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `server migration failed and rollback could not prove the original topology:\n${rollbackErrors.join('\n')}\n` +
          `original error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw new Error(
      `server migration failed; every mutated repository was rolled back and original paths were verified: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const active = activeMigrationPath();
  const completed = completedMigrationPath(runId);
  if (fs.existsSync(active)) {
    fs.renameSync(active, completed);
    const parentFd = fs.openSync(path.dirname(completed), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  }
  console.log('OFFLINE AUDIT PASSED. Old topology remains renamed in place; fleet is still stopped.');
}

export function verifyServerRollback(
  manifests: RepositoryMigrationManifest[],
  protectedArchives: ProtectedArchiveEvidence[],
): void {
  const errors: string[] = [];
  for (const manifest of manifests) {
    for (const capture of manifest.captures) {
      if (!fs.existsSync(capture.checkoutPath)) {
        errors.push(
          `${manifest.workgroupId}/${manifest.repo}: original checkout not restored: ${capture.checkoutPath}`,
        );
      }
    }
    for (const store of manifest.objectStores) {
      if (!fs.existsSync(store))
        errors.push(`${manifest.workgroupId}/${manifest.repo}: object store not restored: ${store}`);
    }
    const migrationRepository = repositoryMigrationPath(manifest);
    if (fs.existsSync(migrationRepository)) {
      errors.push(
        `${manifest.workgroupId}/${manifest.repo}: migration repository remains after rollback: ${migrationRepository}`,
      );
    }
    if (readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir)) {
      errors.push(`${manifest.workgroupId}/${manifest.repo}: migration origin pin remains after rollback`);
    }
  }
  try {
    verifyProtectedArchives(protectedArchives);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    throw new Error(`server rollback could not prove the original topology:\n${errors.join('\n')}`);
  }
}

function durableRename(source: string, destination: string): void {
  if (fs.existsSync(destination)) throw new Error(`durable destination already exists: ${destination}`);
  fs.renameSync(source, destination);
  const parentFd = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
}

async function rollbackCompletedServerMigration(runId: string): Promise<void> {
  const completed = completedMigrationPath(runId);
  const activeRollback = activeRollbackPath(runId);
  const completedRollback = completedRollbackPath(runId);
  if (fs.existsSync(completedRollback) && !fs.existsSync(completed) && !fs.existsSync(activeRollback)) {
    const prior = loadMigrationDescriptor(completedRollback);
    const paths = migrationQuiescencePaths(prior.manifests, prior.descriptor.protectedArchives ?? []);
    assertFleetQuiescent(paths);
    verifyServerRollback(prior.manifests, prior.descriptor.protectedArchives ?? []);
    console.log(`ROLLBACK ALREADY COMPLETE for ${runId}. Fleet remains stopped.`);
    return;
  }
  if (fs.existsSync(completed) && fs.existsSync(activeRollback)) {
    throw new Error(
      `rollback state is ambiguous for ${runId}: both completed migration and active rollback descriptors exist`,
    );
  }
  const firstAttempt = fs.existsSync(completed);
  const source = firstAttempt ? completed : activeRollback;
  if (!fs.existsSync(source)) throw new Error(`no completed or resumable rollback descriptor exists for ${runId}`);
  const loaded = loadMigrationDescriptor(source);
  if (loaded.descriptor.runId !== runId) throw new Error(`rollback descriptor run id mismatch: ${runId}`);
  const protectedArchives = loaded.descriptor.protectedArchives ?? [];
  const allPaths = migrationQuiescencePaths(loaded.manifests, protectedArchives);
  assertFleetQuiescent(allPaths);
  validateRecoverySeedEvidence(loaded.descriptor.recoverySeeds);
  if (firstAttempt) {
    // Canary rollback is permitted only while the post-migration repository
    // topology remains byte-for-byte identical to the offline audit. Any edit
    // or newly created linked worktree blocks before the first rollback write.
    auditServerTopology(loaded.manifests, protectedArchives);
    durableRename(completed, activeRollback);
  }
  for (const manifest of [...loaded.manifests].reverse()) {
    const repositoryPaths = migrationQuiescencePaths([manifest], []);
    assertFleetQuiescent(repositoryPaths);
    await withHostRepositoryLock(
      manifest.workgroupId,
      manifest.repo,
      async () => {
        assertFleetQuiescent(repositoryPaths);
        await rollbackRepositoryMigration(manifest);
      },
      manifest.dataDir,
    );
    assertFleetQuiescent(completedRepositoryQuiescencePaths(manifest), true);
  }
  verifyServerRollback(loaded.manifests, protectedArchives);
  durableRename(activeRollback, completedRollback);
  console.log(`CONTROLLED ROLLBACK PASSED for ${runId}. Original topology is restored; fleet remains stopped.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollbackRun) {
    await rollbackCompletedServerMigration(args.rollbackRun);
    return;
  }
  if (args.execute) {
    const active = loadActiveMigration();
    if (active) {
      if (args.runId && args.runId !== active.descriptor.runId) {
        throw new Error(`active migration ${active.descriptor.runId} must be resumed before starting ${args.runId}`);
      }
      console.log(`RESUMING controlled migration ${active.descriptor.runId} from durable manifests.`);
      await executeAndAudit(
        active.manifests,
        active.descriptor.runId,
        active.descriptor.protectedArchives ?? [],
        active.descriptor.aggregateCapacity,
        active.descriptor.recoverySeeds,
      );
      return;
    }
  }
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  let rows: SessionRow[];
  let groups: AgentGroupRow[];
  try {
    rows = loadRows(db);
    groups = loadAgentGroups(db);
  } finally {
    db.close();
  }
  const reviewedMappings = loadReviewedWorkUnitMappings(args.mappingFile);
  const reviewedRecovery = loadReviewedRecoveryDecisions(args.recoveryFile);
  const scopedRepositoryAliases = (reviewedRecovery?.repositoryAliases ?? []).filter(
    (entry) =>
      (!args.workgroup || entry.workgroupId === args.workgroup) && (!args.repo || entry.destinationRepo === args.repo),
  );
  if (
    args.repo &&
    (reviewedRecovery?.repositoryAliases ?? []).some(
      (entry) => (!args.workgroup || entry.workgroupId === args.workgroup) && entry.sourceRepo === args.repo,
    )
  ) {
    throw new Error(`repository ${args.repo} is a reviewed retired alias; select its canonical destination instead`);
  }
  const aliasDestinationBySource = new Map(
    scopedRepositoryAliases.map((entry) => [`${entry.workgroupId}\0${entry.sourceRepo}`, entry.destinationRepo]),
  );
  const recoveryDecisionInScope = (decision: { workgroupId: string; repo: string }): boolean => {
    const canonicalRepo = aliasDestinationBySource.get(`${decision.workgroupId}\0${decision.repo}`) ?? decision.repo;
    return (!args.workgroup || decision.workgroupId === args.workgroup) && (!args.repo || canonicalRepo === args.repo);
  };
  let scopedReviewedRecovery = reviewedRecovery
    ? {
        ...reviewedRecovery,
        checkouts: reviewedRecovery.checkouts.filter(recoveryDecisionInScope),
        origins: reviewedRecovery.origins.filter(recoveryDecisionInScope),
        repositoryAliases: scopedRepositoryAliases,
      }
    : null;
  const scopedReviewedMappings = reviewedMappings
    ? {
        ...reviewedMappings,
        entries: reviewedMappings.entries.filter((entry) => !args.workgroup || entry.workgroupId === args.workgroup),
      }
    : null;
  const grouped = inventoryCandidates(rows, groups, args.workgroup, reviewedMappings?.entries);
  const bareStores = inventoryBareStores(groups, args.workgroup);
  const preparedRepositoryAliases = prepareReviewedRepositoryAliases(grouped, bareStores, scopedReviewedRecovery);
  scopedReviewedRecovery = preparedRepositoryAliases.reviewedRecovery;
  coalesceRepositoryIdentityAliases(grouped, bareStores, scopedReviewedRecovery?.repositoryAliases);
  const knownWorkUnits = rows.map((row) =>
    resolveRepositoryWorkUnit({
      workgroupId: row.workgroup_id,
      sessionId: row.session_id,
      platformId: row.platform_id,
      messagingGroupId: row.messaging_group_id,
      threadId: row.thread_id,
    }),
  );
  const mappingEvidence = applyReviewedWorkUnitMappings(grouped, knownWorkUnits, scopedReviewedMappings);
  if (mappingEvidence) {
    console.error(
      `Applied ${mappingEvidence.applied} reviewed checkout mapping(s) from ${mappingEvidence.sourcePath} ` +
        `(sha256 ${mappingEvidence.sha256})`,
    );
  }
  if (args.repo) {
    for (const key of [...grouped.keys()]) if (key.split('\0')[1] !== args.repo) grouped.delete(key);
    for (const key of [...bareStores.keys()]) if (key.split('\0')[1] !== args.repo) bareStores.delete(key);
  }
  if (scopedReviewedRecovery) {
    console.error(
      `Loaded reviewed recovery decisions from ${scopedReviewedRecovery.sourcePath} ` +
        `(sha256 ${scopedReviewedRecovery.sha256}; ${scopedReviewedRecovery.checkouts.length} checkout, ` +
        `${scopedReviewedRecovery.origins.length} origin, ` +
        `${scopedReviewedRecovery.repositoryAliases.length} repository alias in scope)`,
    );
  }
  const checkoutRecoveryByPath = new Map(
    (scopedReviewedRecovery?.checkouts ?? []).map((decision) => [path.resolve(decision.checkoutPath), decision]),
  );
  const originRecoveryByRepo = new Map(
    (scopedReviewedRecovery?.origins ?? []).map((decision) => [`${decision.workgroupId}\0${decision.repo}`, decision]),
  );
  const usedCheckoutRecovery = new Set<string>();
  const usedOriginRecovery = new Set<string>(preparedRepositoryAliases.consumedOriginKeys);
  for (const candidates of grouped.values()) {
    for (const candidate of candidates) {
      const decision = checkoutRecoveryByPath.get(path.resolve(candidate.checkoutPath));
      const reviewedStores = [
        ...(decision?.externalSeedGitDirSha256 ? [decision.selectedCommonGitDir] : []),
        ...(decision?.supplementalSeedGitDir ? [decision.supplementalSeedGitDir] : []),
      ];
      if (reviewedStores.length === 0) continue;
      candidate.candidateCommonGitDirs = [
        ...new Set([...(candidate.candidateCommonGitDirs ?? []), ...reviewedStores]),
      ].sort();
    }
  }
  for (const key of bareStores.keys()) {
    if (!grouped.has(key)) grouped.set(key, []);
  }
  for (const [key, candidates] of grouped) {
    const common = new Set(candidates.flatMap((candidate) => candidate.candidateCommonGitDirs ?? []));
    for (const store of bareStores.get(key) ?? []) common.add(store);
    for (const candidate of candidates) candidate.candidateCommonGitDirs = [...common].sort();
  }
  if (grouped.size === 0) throw new Error('no legacy physical repository checkouts discovered');

  const preManifestPaths = preManifestQuiescencePaths(groups, grouped, bareStores);
  if (args.execute) assertFleetQuiescent(preManifestPaths);

  let manifests: RepositoryMigrationManifest[] = [];
  const manifestErrors: string[] = [];
  const serverRunId =
    args.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${sha(String(process.pid)).slice(0, 8)}`;
  for (const [key, candidates] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const [workgroupId, repo] = key.split('\0');
    console.error(`Inventorying ${workgroupId}/${repo}: ${candidates.length} physical checkout(s)`);
    try {
      const originResolution = createLegacyGitResolutionContext([
        ...candidates.flatMap((candidate) => candidate.candidateCommonGitDirs ?? []),
        ...(bareStores.get(key) ?? []),
      ]);
      const originDecision = originRecoveryByRepo.get(key);
      const candidateOrigins = candidates.flatMap((candidate, index) => {
        console.error(
          `Resolving origin ${workgroupId}/${repo} ${index + 1}/${candidates.length}: ${candidate.checkoutPath}`,
        );
        if (preparedRepositoryAliases.aliasedCheckoutPaths.has(path.resolve(candidate.checkoutPath))) return [];
        try {
          const observedOrigin = originFor(candidate, originResolution);
          if (repositoryOriginContainsCredentials(observedOrigin)) candidate.credentialBearingOrigin = true;
          return [normalizedObservedOrigin(observedOrigin)];
        } catch (error) {
          if (originDecision) return [];
          throw error;
        }
      });
      const storeOrigins = (bareStores.get(key) ?? [])
        .filter((store) => !preparedRepositoryAliases.aliasedObjectStores.has(path.resolve(store)))
        .map((store) => normalizedObservedOrigin(originForObjectStore(store, originResolution)));
      const origins = [...new Set([...candidateOrigins, ...storeOrigins])];
      const origin = selectReviewedOrigin({ workgroupId, repo, observedOrigins: origins, decision: originDecision });
      if (originDecision) usedOriginRecovery.add(key);
      const repositoryId =
        origin === null
          ? `local-only:${sha(`${workgroupId}\0${repo}`)}`
          : (normalizedGithubRepositoryIdentity(origin) ?? `migration:${sha(origin)}`);
      manifests.push(
        createRepositoryMigrationManifest({
          dataDir: DATA_DIR,
          workgroupId,
          repo,
          origin,
          archiveOnly: originDecision?.archiveOnly === true,
          repositoryId,
          candidates,
          objectStores: bareStores.get(key),
          runId: serverRunId,
          resolutionContext: originResolution,
          recoveryDecisions: candidates
            .map((candidate) => checkoutRecoveryByPath.get(path.resolve(candidate.checkoutPath)))
            .filter((decision): decision is NonNullable<typeof decision> => {
              if (decision) usedCheckoutRecovery.add(path.resolve(decision.checkoutPath));
              return decision !== undefined;
            }),
          onCaptureProgress: ({ phase, current, total, checkoutPath }) => {
            if (phase === 'starting') {
              console.error(`Capturing ${workgroupId}/${repo} ${current}/${total}: ${checkoutPath}`);
            } else if (current === 1 || current === total || current % 10 === 0) {
              console.error(`Captured ${workgroupId}/${repo}: ${current}/${total}`);
            }
          },
        }),
      );
    } catch (error) {
      manifestErrors.push(`${workgroupId}/${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (manifestErrors.length > 0) {
    if (args.proposalFile) {
      const proposalPath = path.resolve(args.proposalFile);
      const temporaryRoot = `${path.resolve('/tmp')}${path.sep}`;
      if (!proposalPath.startsWith(temporaryRoot)) throw new Error('--proposal-file must be a path below /tmp');
      const checkouts = manifestErrors.flatMap((entry) =>
        [...entry.matchAll(/reviewed recovery proposal \(action requires operator review\): (\{[^\n]+\})/g)].map(
          (match) => JSON.parse(match[1]),
        ),
      );
      atomicJson(proposalPath, { version: 2, checkouts, origins: [] });
      fs.chmodSync(proposalPath, 0o600);
      console.error(
        `Wrote ${checkouts.length} hash-bound recovery proposal(s) to ${proposalPath}; operator review is required.`,
      );
    }
    throw new Error(
      `server-wide inventory has ${manifestErrors.length} blocking repository error(s):\n${manifestErrors.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  const unusedCheckouts = [...checkoutRecoveryByPath.keys()].filter((entry) => !usedCheckoutRecovery.has(entry));
  const unusedOrigins = [...originRecoveryByRepo.keys()].filter((entry) => !usedOriginRecovery.has(entry));
  if (unusedCheckouts.length > 0 || unusedOrigins.length > 0) {
    throw new Error(
      `reviewed recovery decision(s) did not match the current inventory:\n` +
        [...unusedCheckouts, ...unusedOrigins.map((entry) => entry.replace('\0', '/'))]
          .map((entry) => `- ${entry}`)
          .join('\n'),
    );
  }
  manifests = orderRepositoryMigrationManifests(manifests);

  const statfs = fs.statfsSync(DATA_DIR);
  const available = Number(statfs.bavail) * Number(statfs.bsize);
  const aggregateCapacity = aggregateCapacityEvidence(manifests);
  console.log(`Repositories: ${manifests.length}`);
  console.log(`Physical checkouts: ${manifests.reduce((sum, manifest) => sum + manifest.captures.length, 0)}`);
  console.log(
    `Capacity: ${(available / 2 ** 30).toFixed(2)} GiB available, ` +
      `${(aggregateCapacity.requiredBytes / 2 ** 30).toFixed(2)} GiB required`,
  );
  console.log(
    `Control-plane backup allowance: ${(aggregateCapacity.controlPlaneBackupBytes / 2 ** 20).toFixed(2)} MiB`,
  );
  for (const manifest of manifests) {
    console.log(`- ${manifest.workgroupId}/${manifest.repo}: ${manifest.captures.length} checkout(s)`);
  }
  if (available < aggregateCapacity.requiredBytes)
    throw new Error('server-wide capacity gate rejected before mutation');
  if (!args.execute) {
    console.log('DRY RUN: no files, refs, services, containers, or repositories were changed.');
    return;
  }

  assertFleetQuiescent(preManifestPaths);
  validateReviewedRecoverySeeds(scopedReviewedRecovery?.checkouts ?? []);
  const protectedArchives = captureProtectedArchives(
    groups,
    new Set(manifests.map((manifest) => manifest.workgroupId)),
  );
  persistActiveMigration(
    serverRunId,
    manifests,
    mappingEvidence,
    scopedReviewedRecovery,
    protectedArchives,
    aggregateCapacity,
  );
  await executeAndAudit(
    manifests,
    serverRunId,
    protectedArchives,
    aggregateCapacity,
    recoverySeedEvidence(scopedReviewedRecovery),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
