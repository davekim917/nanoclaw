/** Lossless legacy-checkout to canonical-plus-linked-worktree migration. */
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  canonicalRepoDir,
  defaultTopicBranch,
  originPinPath,
  readOriginPin,
  topicWorktreesDir,
  withHostRepositoryLock,
  writeOriginPin,
  type RepositoryWorkUnit,
} from './repository-workspaces.js';
import { safeGitArgs, safeGitEnv, safeGitFilterNames } from './safe-git.js';
import {
  observedOriginsSha256,
  recoverySeedGitDirSha256,
  type ReviewedCheckoutRecoveryDecision,
} from './repository-migration-recovery.js';
import {
  normalizedCredentialFreeGithubOrigin,
  normalizedGithubRepositoryIdentity,
} from './repository-migration-identity.js';
import type { RepositoryMigrationPrestageCache } from './repository-migration-prestage.js';

export interface LegacyCheckoutCandidate {
  workgroupId: string;
  repo: string;
  checkoutPath: string;
  workUnit: RepositoryWorkUnit;
  /** A legacy canonical is preserved in a host-only rescue worktree when its state is unique. */
  sourceRole?: 'legacy-canonical' | 'repository-staging';
  /** Presence only; the credential-bearing origin value is never serialized or logged. */
  credentialBearingOrigin?: true;
  /** Common Git directories that may own a collided/broken linked pointer. */
  candidateCommonGitDirs?: string[];
  repositoryIdentityRecovery?: {
    method: 'unique-object-overlap';
    matchedObjects: number;
    sampledObjects: number;
  };
}

export function mergeLegacyCheckoutProvenance(
  existing: LegacyCheckoutCandidate,
  rediscovered: LegacyCheckoutCandidate,
): LegacyCheckoutCandidate {
  const sourceRole =
    existing.sourceRole === 'legacy-canonical' || rediscovered.sourceRole === 'legacy-canonical'
      ? 'legacy-canonical'
      : (existing.sourceRole ?? rediscovered.sourceRole);
  return {
    ...existing,
    ...(sourceRole ? { sourceRole } : {}),
    ...(existing.credentialBearingOrigin || rediscovered.credentialBearingOrigin
      ? { credentialBearingOrigin: true as const }
      : {}),
  };
}

export interface FileInventoryEntry {
  path: string;
  type: 'file' | 'symlink';
  mode: number;
  size: number;
  sha256: string;
  symlinkTarget?: string;
  symlinkTargetBase64?: string;
}

export interface CheckoutCapture {
  id: string;
  workgroupId: string;
  repo: string;
  checkoutPath: string;
  workUnit: RepositoryWorkUnit;
  sourceRole?: LegacyCheckoutCandidate['sourceRole'];
  credentialBearingOrigin?: true;
  gitDir: string;
  commonGitDir: string;
  /** Null means the original checkout was on an unborn branch. */
  head: string | null;
  branch: string | null;
  indexPath: string;
  indexSha256: string | null;
  indexBytesBase64: string | null;
  indexMode: number | null;
  indexAuxiliaryFiles: Array<{
    name: string;
    mode: number;
    size: number;
    sha256: string;
    bytesBase64: string;
  }>;
  indexEntriesZBase64: string;
  statusZBase64: string;
  files: FileInventoryEntry[];
  gitPointer?: {
    mode: number;
    size: number;
    sha256: string;
    bytesBase64: string;
  };
  allocatedWorktreeBytes: number;
  allocatedGitBytes: number;
  rescue?: { headRef: string | null; indexRef: string; worktreeRef: string };
  assignedBranch?: string;
  destinationPath?: string;
  renamedOldPath?: string;
  archivedLegacy?: { reason: 'preexisting-rescue' | 'clean-remote-contained' | 'operator-reviewed-checkout' };
  preservedLegacy?: { reason: 'legacy-canonical-unique-state' };
  recoveredMissingAdmin?: {
    method:
      | 'unique-clean-local-branch'
      | 'reflog-creation-time'
      | 'unique-pointer-token-branch'
      | 'operator-selected-visible-state';
    originalPointer: string;
    /** True when the missing admin directory made the original index bytes unknowable. */
    indexClassificationSynthesized?: true;
  };
  /** Hash-bound operator selection used for missing, ambiguous, or intentionally archived state. */
  reviewedRecovery?: {
    selection: ReviewedCheckoutRecoveryDecision['selection'];
    action: ReviewedCheckoutRecoveryDecision['action'];
    visibleStateSha256: string;
    gitPointerSha256?: string;
    selectedGitDir?: string;
    selectedIndexSha256?: string | null;
  };
  repositoryIdentityRecovery?: LegacyCheckoutCandidate['repositoryIdentityRecovery'];
}

export interface RepositoryMigrationManifest {
  version: 1;
  runId: string;
  createdAt: string;
  dataDir: string;
  workgroupId: string;
  repo: string;
  /** Null preserves a repository that never had a remote. */
  origin: string | null;
  /**
   * Historical-only repositories are imported and bundled under the
   * migration evidence root, but are never published into the active
   * canonical namespace or exposed as topic worktrees.
   */
  archiveOnly: boolean;
  repositoryId: string;
  objectStores: string[];
  canonicalBase: {
    head: string;
    branch: string;
    sourceRef: string;
    objectFormat: 'sha1' | 'sha256';
  };
  captures: CheckoutCapture[];
  renamedObjectStores?: Record<string, string>;
  capacity: {
    availableBytes: number;
    requiredBytes: number;
    uniqueGitBytes: number;
    worktreeBytes: number;
    canonicalWorktreeBytes: number;
    worktreeAdminBytes: number;
    rescueObjectBytes: number;
    safetyBytes: number;
  };
  manifestSha256: string;
}

export type MigrationPhase =
  | 'manifested'
  | 'rescued'
  | 'canonical-target-clear'
  | 'canonical-published'
  | 'bundle-written'
  | 'old-renamed'
  | 'worktrees-restored'
  | 'audited';

export interface MigrationJournal {
  version: 1;
  runId: string;
  workgroupId: string;
  repo: string;
  manifestSha256: string;
  phases: MigrationPhase[];
  bundleSha256?: string;
  updatedAt: string;
}

const gitIdentity = {
  GIT_AUTHOR_NAME: 'NanoClaw Repository Migration',
  GIT_AUTHOR_EMAIL: 'repository-migration@localhost',
  GIT_COMMITTER_NAME: 'NanoClaw Repository Migration',
  GIT_COMMITTER_EMAIL: 'repository-migration@localhost',
};
const allocatedGitBytesCache = new Map<string, number>();

function pathContained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function contextForGitInvocation(
  args: readonly string[],
  cwd?: string,
): { config?: string; gitDir?: string; workTree?: string } {
  const gitDirIndex = args.indexOf('--git-dir');
  let gitDir: string | undefined;
  if (gitDirIndex >= 0 && args[gitDirIndex + 1]) gitDir = path.resolve(cwd ?? process.cwd(), args[gitDirIndex + 1]);
  const workTreeIndex = args.indexOf('--work-tree');
  const workTree =
    workTreeIndex >= 0 && args[workTreeIndex + 1]
      ? path.resolve(cwd ?? process.cwd(), args[workTreeIndex + 1])
      : undefined;
  const cIndex = args.indexOf('-C');
  let resolvedWorkTree = workTree;
  if (!gitDir && cIndex >= 0 && args[cIndex + 1]) {
    const repo = path.resolve(cwd ?? process.cwd(), args[cIndex + 1]);
    const marker = path.join(repo, '.git');
    try {
      const stat = fs.lstatSync(marker);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(marker, 'utf8'));
        if (match) gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(repo, match[1]);
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        gitDir = marker;
      }
    } catch {
      gitDir = marker;
    }
    resolvedWorkTree ??= repo;
  }
  if (!gitDir && cwd) gitDir = path.join(path.resolve(cwd), '.git');
  if (!gitDir) return { workTree: resolvedWorkTree };
  let candidate = path.join(gitDir, 'config');
  if (fs.existsSync(candidate)) return { config: candidate, gitDir, workTree: resolvedWorkTree };
  try {
    const commondir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    const common = path.isAbsolute(commondir) ? commondir : path.resolve(gitDir, commondir);
    candidate = path.join(common, 'config');
    return { ...(fs.existsSync(candidate) ? { config: candidate } : {}), gitDir, workTree: resolvedWorkTree };
  } catch {
    return { gitDir, workTree: resolvedWorkTree };
  }
}

function git(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeout?: number } = {},
): string {
  const context = contextForGitInvocation(args, options.cwd);
  const filters =
    context.gitDir && fs.existsSync(path.join(context.gitDir, 'HEAD'))
      ? safeGitFilterNames(context.gitDir, context.workTree)
      : [];
  return execFileSync('git', safeGitArgs(['-c', 'core.fsync=all', ...args], context.config, filters), {
    cwd: options.cwd,
    env: safeGitEnv({ ...gitIdentity, ...options.env }),
    input: options.input,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function gitRaw(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const context = contextForGitInvocation(args, options.cwd);
  const filters =
    context.gitDir && fs.existsSync(path.join(context.gitDir, 'HEAD'))
      ? safeGitFilterNames(context.gitDir, context.workTree)
      : [];
  return execFileSync('git', safeGitArgs(['-c', 'core.fsync=all', ...args], context.config, filters), {
    cwd: options.cwd,
    env: safeGitEnv(options.env),
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
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

function fsyncDirectories(...directories: string[]): void {
  for (const directory of new Set(directories.map((entry) => path.resolve(entry)))) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function atomicBytes(file: string, bytes: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
    const parentFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Atomically published or never created.
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function allocatedBytes(root: string, excluded?: (candidate: string) => boolean): number {
  const seen = new Set<string>();
  let total = 0;
  const visit = (candidate: string): void => {
    if (excluded?.(candidate)) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return;
    }
    const inode = `${stat.dev}:${stat.ino}`;
    if (seen.has(inode)) return;
    seen.add(inode);
    total += stat.blocks * 512;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
  };
  visit(root);
  return total;
}

function allocatedInventoryBytes(checkoutPath: string, files: FileInventoryEntry[]): number {
  let allocated = 0;
  for (const entry of files) {
    try {
      allocated += fs.lstatSync(path.join(checkoutPath, entry.path)).blocks * 512;
    } catch {
      // captureCheckout's file hash is authoritative; a concurrent removal is
      // caught by the final status/hash comparison under quiescence.
    }
  }
  const blockSize = Number(fs.statfsSync(checkoutPath).bsize);
  const directories = new Set<string>();
  let dense = 0;
  for (const entry of files) {
    dense += Math.ceil(entry.size / blockSize) * blockSize;
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  dense += directories.size * blockSize;
  // Rescue blobs and checkout restoration can densify sparse files. Capacity
  // therefore uses the larger of current allocated blocks and logical bytes.
  return Math.max(allocated, dense);
}

function porcelainV2ChangedPaths(statusZBase64: string, checkoutPath: string): Set<string> {
  const status = Buffer.from(statusZBase64, 'base64');
  const records =
    status.length === 0
      ? []
      : status
          .subarray(0, status[status.length - 1] === 0 ? status.length - 1 : status.length)
          .toString('utf8')
          .split('\0');
  const paths = new Set<string>();
  const afterSpaces = (record: string, count: number): string => {
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      offset = record.indexOf(' ', offset);
      if (offset < 0) throw new Error(`malformed porcelain-v2 status for ${checkoutPath}`);
      offset += 1;
    }
    return record.slice(offset);
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('1 ')) paths.add(afterSpaces(record, 8));
    else if (record.startsWith('2 ')) {
      paths.add(afterSpaces(record, 9));
      index += 1; // The following NUL record is the rename/copy source path.
      if (index >= records.length) throw new Error(`malformed porcelain-v2 rename status for ${checkoutPath}`);
    } else if (record.startsWith('u ')) paths.add(afterSpaces(record, 10));
    else if (record.startsWith('? ')) paths.add(record.slice(2));
    else if (record.startsWith('! ') || record.startsWith('# ')) continue;
    else throw new Error(`unknown porcelain-v2 status record for ${checkoutPath}: ${record.slice(0, 32)}`);
  }
  return paths;
}

function allocatedChangedWorktreeBytes(capture: CheckoutCapture): number {
  const changedPaths = porcelainV2ChangedPaths(capture.statusZBase64, capture.checkoutPath);
  return allocatedInventoryBytes(
    capture.checkoutPath,
    capture.files.filter((entry) => changedPaths.has(entry.path)),
  );
}

function allocatedGitBytes(commonGitDir: string): number {
  const real = fs.realpathSync(commonGitDir);
  const cached = allocatedGitBytesCache.get(real);
  if (cached !== undefined) return cached;
  const measured = allocatedBytes(real);
  allocatedGitBytesCache.set(real, measured);
  return measured;
}

function parseGitPointer(checkoutPath: string): string | null {
  const pointer = path.join(checkoutPath, '.git');
  const stat = fs.lstatSync(pointer);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return pointer;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsupported .git entry: ${pointer}`);
  const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(pointer, 'utf8'));
  if (!match) throw new Error(`invalid linked worktree pointer: ${pointer}`);
  return path.isAbsolute(match[1]) ? match[1] : path.resolve(checkoutPath, match[1]);
}

function gitDirWorks(gitDir: string, checkoutPath: string): boolean {
  try {
    git(['--git-dir', gitDir, '--work-tree', checkoutPath, 'rev-parse', '--git-dir']);
    try {
      git(['--git-dir', gitDir, '--work-tree', checkoutPath, 'rev-parse', '--verify', 'HEAD^{commit}']);
    } catch {
      // Unborn branches have a valid repository and symbolic HEAD but no commit.
      git(['--git-dir', gitDir, 'symbolic-ref', '--quiet', 'HEAD']);
    }
    return true;
  } catch {
    return false;
  }
}

export interface LegacyGitResolutionContext {
  ownedAdminsByCheckoutMarker: Map<string, string[]>;
  commonOriginCache: Map<string, string | null>;
  branchStatesByCommonSet: Map<string, Array<{ common: string; branch: string; head: string }>>;
  /** Hash/fsck evidence reused only within one fresh inventory invocation. */
  validatedRecoverySeeds: Set<string>;
}

export function createLegacyGitResolutionContext(commonGitDirs: readonly string[]): LegacyGitResolutionContext {
  const owned = new Map<string, Set<string>>();
  for (const unresolved of [...new Set(commonGitDirs)]) {
    let common: string;
    try {
      common = fs.realpathSync(unresolved);
    } catch {
      continue;
    }
    const worktrees = path.join(common, 'worktrees');
    let entries: string[];
    try {
      entries = fs.readdirSync(worktrees);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const admin = path.join(worktrees, entry);
      const backPointer = path.join(admin, 'gitdir');
      try {
        const stat = fs.lstatSync(backPointer);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const recorded = fs.readFileSync(backPointer, 'utf8').trim();
        const absolute = path.isAbsolute(recorded) ? recorded : path.resolve(admin, recorded);
        const marker = path.resolve(absolute);
        const admins = owned.get(marker) ?? new Set<string>();
        admins.add(admin);
        owned.set(marker, admins);
      } catch {
        // Exact resolver validation remains authoritative for matching admins.
      }
    }
  }
  return {
    ownedAdminsByCheckoutMarker: new Map([...owned].map(([marker, admins]) => [marker, [...admins].sort()])),
    commonOriginCache: new Map(),
    branchStatesByCommonSet: new Map(),
    validatedRecoverySeeds: new Set(),
  };
}

export function readLegacyGitDirOrigin(gitDir: string, context?: LegacyGitResolutionContext): string | null {
  const real = fs.realpathSync(gitDir);
  if (context?.commonOriginCache.has(real)) return context.commonOriginCache.get(real)!;
  let origin: string | null;
  try {
    origin = git(['--git-dir', real, 'config', '--get', 'remote.origin.url']) || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { status?: number }).status === 1) origin = null;
    else throw error;
  }
  context?.commonOriginCache.set(real, origin);
  return origin;
}

export function resolveLegacyGitAdmin(
  candidate: LegacyCheckoutCandidate,
  context?: LegacyGitResolutionContext,
): { gitDir: string; commonGitDir: string } {
  const pointer = parseGitPointer(candidate.checkoutPath);
  const attempts = new Set<string>();
  const owned = new Set<string>();
  if (pointer) attempts.add(pointer);
  const pointerName = pointer ? path.basename(pointer) : '';
  for (const common of candidate.candidateCommonGitDirs ?? []) {
    if (pointerName) attempts.add(path.join(common, 'worktrees', pointerName));
    if (!context) {
      const worktrees = path.join(common, 'worktrees');
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(worktrees);
      } catch {
        // This object store may not own any linked worktrees.
      }
      for (const entry of entries) {
        const admin = path.join(worktrees, entry);
        const backPointer = path.join(admin, 'gitdir');
        try {
          const stat = fs.lstatSync(backPointer);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          const recorded = fs.readFileSync(backPointer, 'utf8').trim();
          const absolute = path.isAbsolute(recorded) ? recorded : path.resolve(admin, recorded);
          if (path.resolve(absolute) === path.resolve(candidate.checkoutPath, '.git')) {
            attempts.add(admin);
            owned.add(admin);
          }
        } catch {
          // Ignore malformed unrelated admin entries; gitDirWorks validates a
          // matching candidate below.
        }
      }
    }
  }
  if (context) {
    for (const admin of context.ownedAdminsByCheckoutMarker.get(path.resolve(candidate.checkoutPath, '.git')) ?? []) {
      attempts.add(admin);
      owned.add(admin);
    }
  }
  const valid = [...attempts].filter((entry) => fs.existsSync(entry) && gitDirWorks(entry, candidate.checkoutPath));
  if (valid.length === 0) throw new Error(`no usable Git admin directory for ${candidate.checkoutPath}`);
  // Exact existing pointers win. If collision recovery produces multiple
  // candidates, refuse rather than attach the wrong index to ongoing work.
  const workgroupMarker = `/data/workgroups/${candidate.workgroupId}/`;
  const preferred = pointer?.replaceAll('\\', '/').startsWith('/workspace/workgroup/')
    ? valid.filter((entry) => entry.replaceAll('\\', '/').includes(workgroupMarker))
    : [];
  const ownedValid = valid.filter((entry) => owned.has(entry));
  const chosen =
    ownedValid.length === 1
      ? ownedValid[0]
      : ownedValid.length > 1
        ? null
        : pointer && valid.includes(pointer)
          ? pointer
          : preferred.length === 1
            ? preferred[0]
            : valid.length === 1
              ? valid[0]
              : null;
  if (!chosen) throw new Error(`ambiguous Git admin directories for ${candidate.checkoutPath}: ${valid.join(', ')}`);
  const commonRaw = git(['--git-dir', chosen, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { gitDir: fs.realpathSync(chosen), commonGitDir: fs.realpathSync(commonRaw) };
}

export function readLegacyCheckoutOrigin(
  candidate: LegacyCheckoutCandidate,
  context?: LegacyGitResolutionContext,
): string {
  try {
    const { gitDir } = resolveLegacyGitAdmin(candidate, context);
    return git(['--git-dir', gitDir, 'config', '--get', 'remote.origin.url']);
  } catch (error) {
    const origins = new Set<string>();
    for (const common of candidate.candidateCommonGitDirs ?? []) {
      try {
        const origin = readLegacyGitDirOrigin(common, context);
        if (origin !== null) origins.add(origin);
      } catch {
        // A candidate object store need not carry an origin.
      }
    }
    const networkOrigins = [
      ...new Set(
        [...origins]
          .filter((origin) => !path.isAbsolute(origin))
          .map((origin) => origin.replace(/\.git\/?$/, '').replace(/\/$/, '')),
      ),
    ];
    if (networkOrigins.length === 1) return networkOrigins[0];
    if (networkOrigins.length > 1) {
      throw new Error(
        `origin conflict while recovering ${candidate.checkoutPath}: ${networkOrigins.length} distinct values; ` +
          `observedOriginsSha256=${observedOriginsSha256(networkOrigins)}`,
        { cause: error },
      );
    }
    if (origins.size === 1) return [...origins][0];
    throw error;
  }
}

function inventoryFiles(
  checkoutPath: string,
  gitDir: string,
  env?: NodeJS.ProcessEnv,
  fileHashCache?: RepositoryMigrationPrestageCache,
): FileInventoryEntry[] {
  const raw = gitRaw(
    ['--git-dir', gitDir, '--work-tree', checkoutPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { env },
  );
  const entries: FileInventoryEntry[] = [];
  const names: string[] = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0) continue;
    if (index > start) {
      const bytes = raw.subarray(start, index);
      const decoded = bytes.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
        throw new Error(
          `repository path contains non-UTF-8 bytes and cannot be represented losslessly in the migration manifest: ` +
            `${checkoutPath} (path base64 ${bytes.toString('base64')})`,
        );
      }
      names.push(decoded);
    }
    start = index + 1;
  }
  names.sort();
  for (const relative of names) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..'))
      throw new Error(`unsafe Git path: ${relative}`);
    const absolute = path.join(checkoutPath, relative);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const cached = fileHashCache?.hash(absolute, 'symlink');
      const target = cached
        ? Buffer.from(cached.symlinkTargetBase64!, 'base64')
        : fs.readlinkSync(absolute, { encoding: 'buffer' });
      const targetText = target.toString('utf8');
      entries.push({
        path: relative,
        type: 'symlink',
        mode: cached?.mode ?? stat.mode & 0o7777,
        size: cached?.size ?? target.length,
        sha256: cached?.sha256 ?? sha256(target),
        symlinkTargetBase64: target.toString('base64'),
        ...(Buffer.from(targetText, 'utf8').equals(target) ? { symlinkTarget: targetText } : {}),
      });
    } else if (stat.isFile()) {
      const cached = fileHashCache?.hash(absolute, 'file');
      entries.push({
        path: relative,
        type: 'file',
        mode: cached?.mode ?? stat.mode & 0o7777,
        size: cached?.size ?? stat.size,
        sha256: cached?.sha256 ?? sha256(fs.readFileSync(absolute)),
      });
    }
  }
  return entries;
}

/**
 * Populate only the advisory content-hash cache while the legacy runtime is
 * still live. This deliberately does not capture or persist HEAD/index/status,
 * create refs, write a manifest, or publish any repository state. The offline
 * manifest capture still takes all of those snapshots afresh under quiescence.
 */
export function prestageLegacyCheckoutFileHashes(
  candidate: LegacyCheckoutCandidate,
  fileHashCache: RepositoryMigrationPrestageCache,
  context?: LegacyGitResolutionContext,
): { files: number; reusedFiles: number; rehashedFiles: number } {
  const checkoutPath = fs.realpathSync(candidate.checkoutPath);
  const { gitDir } = resolveLegacyGitAdmin({ ...candidate, checkoutPath }, context);
  const before = fileHashCache.stats();
  const files = inventoryFiles(checkoutPath, gitDir, undefined, fileHashCache);
  const after = fileHashCache.stats();
  return {
    files: files.length,
    reusedFiles: after.reusedEntries - before.reusedEntries,
    rehashedFiles: after.rehashedEntries - before.rehashedEntries,
  };
}

interface OrphanRecovery {
  gitDir: string;
  commonGitDir: string;
  head: string;
  branch: string;
  indexEntries: Buffer;
  indexBytes: Buffer;
  indexMode: number;
  status: Buffer;
  files: FileInventoryEntry[];
  originalPointer: string;
  indexClassificationSynthesized?: true;
  method: CheckoutCapture['recoveredMissingAdmin'] extends infer _T
    ?
        | 'unique-clean-local-branch'
        | 'reflog-creation-time'
        | 'unique-pointer-token-branch'
        | 'operator-selected-visible-state'
    : never;
}

function synthesizeMissingAdminRecovery(input: {
  common: string;
  branch: string;
  head: string;
  checkoutPath: string;
  originalPointer: string;
  method: OrphanRecovery['method'];
}): OrphanRecovery {
  const common = fs.realpathSync(input.common);
  const tempAdmin = path.join('/tmp', `nanoclaw-orphan-admin-${process.pid}-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(tempAdmin, { recursive: true, mode: 0o700 });
  const tempIndex = path.join(tempAdmin, 'index');
  try {
    fs.writeFileSync(path.join(tempAdmin, 'commondir'), `${common}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(tempAdmin, 'HEAD'), `${input.head}\n`, { mode: 0o600 });
    const env = { GIT_INDEX_FILE: tempIndex };
    git(['--git-dir', tempAdmin, '--work-tree', input.checkoutPath, 'read-tree', input.head], { env });
    try {
      git(['--git-dir', tempAdmin, '--work-tree', input.checkoutPath, 'update-index', '--refresh'], { env });
    } catch {
      // Dirty paths are expected; status and the reviewed hash bind them.
    }
    return {
      gitDir: common,
      commonGitDir: common,
      head: input.head,
      branch: input.branch,
      indexEntries: gitRaw(['--git-dir', tempAdmin, '--work-tree', input.checkoutPath, 'ls-files', '--stage', '-z'], {
        env,
      }),
      indexBytes: fs.readFileSync(tempIndex),
      indexMode: fs.lstatSync(tempIndex).mode & 0o7777,
      status: gitRaw(
        [
          '--git-dir',
          tempAdmin,
          '--work-tree',
          input.checkoutPath,
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
        ],
        { env },
      ),
      files: inventoryFiles(input.checkoutPath, tempAdmin, env),
      originalPointer: input.originalPointer,
      method: input.method,
      indexClassificationSynthesized: true,
    };
  } finally {
    fs.rmSync(tempAdmin, { recursive: true, force: true });
  }
}

function validateReviewedRecoverySeed(
  seedDirectory: string,
  expectedSha256: string,
  checkoutPath: string,
  context?: LegacyGitResolutionContext,
): string {
  const seed = fs.realpathSync(seedDirectory);
  const seedRoot = path.resolve(
    process.env.NANOCLAW_REPOSITORY_RECOVERY_SEED_ROOT ??
      '/home/ubuntu/backups/nanoclaw-worktree-recovery/repository-seeds',
  );
  if (!pathContained(seed, seedRoot)) throw new Error(`reviewed recovery seed escapes its host-only root: ${seed}`);
  const cacheKey = `${seed}\0${expectedSha256}`;
  if (context?.validatedRecoverySeeds.has(cacheKey)) return seed;
  if (recoverySeedGitDirSha256(seed) !== expectedSha256) {
    throw new Error(`reviewed recovery seed checksum is stale for ${checkoutPath}`);
  }
  git(['--git-dir', seed, 'fsck', '--full']);
  context?.validatedRecoverySeeds.add(cacheKey);
  return seed;
}

/** Revalidate every unique host-only recovery seed once at a durable gate. */
export function validateReviewedRecoverySeeds(decisions: readonly ReviewedCheckoutRecoveryDecision[]): void {
  const context = createLegacyGitResolutionContext([]);
  for (const decision of decisions) {
    if (decision.externalSeedGitDirSha256) {
      validateReviewedRecoverySeed(
        decision.selectedCommonGitDir,
        decision.externalSeedGitDirSha256,
        decision.checkoutPath,
        context,
      );
    }
    if (decision.supplementalSeedGitDir && decision.supplementalSeedGitDirSha256) {
      validateReviewedRecoverySeed(
        decision.supplementalSeedGitDir,
        decision.supplementalSeedGitDirSha256,
        decision.checkoutPath,
        context,
      );
    }
  }
}

function recoverMissingAdmin(
  candidate: LegacyCheckoutCandidate,
  checkoutPath: string,
  selection?: ReviewedCheckoutRecoveryDecision,
  preferMetadataSelection = false,
  context?: LegacyGitResolutionContext,
): OrphanRecovery {
  const originalPointer = parseGitPointer(checkoutPath);
  if (!originalPointer) throw new Error(`cannot recover standalone checkout without Git metadata: ${checkoutPath}`);
  if (selection) {
    if (selection.selection !== 'synthesized-visible-state') {
      throw new Error(`missing Git admin recovery requires synthesized-visible-state selection: ${checkoutPath}`);
    }
    if (selection.selectedHead === null || selection.selectedBranch === null) {
      throw new Error(`synthetic recovery requires a selected commit and branch: ${checkoutPath}`);
    }
    const common = fs.realpathSync(selection.selectedCommonGitDir);
    const allowed = new Set(
      (candidate.candidateCommonGitDirs ?? [])
        .filter((entry) => fs.existsSync(entry))
        .map((entry) => fs.realpathSync(entry)),
    );
    if (!allowed.has(common)) {
      if (!selection.externalSeedGitDirSha256) {
        throw new Error(`reviewed recovery selected an uninventoried Git object store: ${common}`);
      }
      validateReviewedRecoverySeed(common, selection.externalSeedGitDirSha256, checkoutPath, context);
    }
    const branchHead = git([
      '--git-dir',
      common,
      'rev-parse',
      '--verify',
      `refs/heads/${selection.selectedBranch}^{commit}`,
    ]);
    if (branchHead !== selection.selectedHead) {
      throw new Error(`reviewed recovery branch/head selection is stale for ${checkoutPath}`);
    }
    return synthesizeMissingAdminRecovery({
      common,
      branch: selection.selectedBranch,
      head: selection.selectedHead,
      checkoutPath,
      originalPointer,
      method: 'operator-selected-visible-state',
    });
  }
  const commonGitDirs = [
    ...new Set(
      (candidate.candidateCommonGitDirs ?? [])
        .filter((common) => fs.existsSync(common))
        .map((common) => fs.realpathSync(common)),
    ),
  ].sort();
  const branchStateCacheKey = commonGitDirs.join('\0');
  let cachedBranchStates = context?.branchStatesByCommonSet.get(branchStateCacheKey);
  if (!cachedBranchStates) {
    const discovered: Array<{ common: string; branch: string; head: string }> = [];
    for (const common of commonGitDirs) {
      let refs: string;
      try {
        refs = git(['--git-dir', common, 'for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/heads']);
      } catch {
        continue;
      }
      for (const line of refs.split('\n').filter(Boolean)) {
        const separator = line.indexOf('\t');
        if (separator < 1) continue;
        discovered.push({ common, branch: line.slice(0, separator), head: line.slice(separator + 1) });
      }
    }
    cachedBranchStates = discovered;
    context?.branchStatesByCommonSet.set(branchStateCacheKey, discovered);
  }
  const branchStates = new Map(cachedBranchStates.map((entry) => [`${entry.head}\0${entry.branch}`, entry]));
  const repoTokens = new Set(
    candidate.repo
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const pointerTokens = path
    .basename(originalPointer)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !repoTokens.has(token));
  const inferred = [...branchStates.values()].filter(({ branch }) => {
    const normalized = branch.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    return pointerTokens.length > 0 && pointerTokens.every((token) => normalized.includes(token));
  });
  const uniqueInferred = new Map(inferred.map((entry) => [`${entry.head}\0${entry.branch}`, entry]));
  if (preferMetadataSelection && uniqueInferred.size === 1) {
    const [{ common, branch, head }] = [...uniqueInferred.values()];
    return synthesizeMissingAdminRecovery({
      common,
      branch,
      head,
      checkoutPath,
      originalPointer,
      method: 'unique-pointer-token-branch',
    });
  }
  if (preferMetadataSelection) {
    throw new Error(
      `missing Git admin directory for ${checkoutPath}; pointer tokens matched ${uniqueInferred.size} exact branch states; ` +
        `a reviewed visible-state archive is required instead of exhaustive branch guessing`,
    );
  }
  const pointerCreatedAt = fs.lstatSync(path.join(checkoutPath, '.git')).mtimeMs / 1000;
  const matchesReflogCreation = (branch: string): boolean => {
    return (candidate.candidateCommonGitDirs ?? []).some((common) => {
      try {
        const entries = git(['--git-dir', common, 'reflog', 'show', '--date=raw', '--format=%gd', branch])
          .split('\n')
          .filter(Boolean);
        const first = entries.at(-1);
        const epoch = first ? /@\{(\d+)\s/.exec(first)?.[1] : undefined;
        return epoch !== undefined && Math.abs(Number(epoch) - pointerCreatedAt) <= 2;
      } catch {
        return false;
      }
    });
  };
  const reflogInferred = [...branchStates.values()].filter(({ branch }) => matchesReflogCreation(branch));
  const uniqueReflog = new Map(reflogInferred.map((entry) => [`${entry.head}\0${entry.branch}`, entry]));
  if (preferMetadataSelection && uniqueReflog.size === 1) {
    const [{ common, branch, head }] = [...uniqueReflog.values()];
    return synthesizeMissingAdminRecovery({
      common,
      branch,
      head,
      checkoutPath,
      originalPointer,
      method: 'reflog-creation-time',
    });
  }

  const matches = new Map<string, OrphanRecovery>();
  for (const { common, branch, head } of branchStates.values()) {
    const tempIndex = path.join('/tmp', `nanoclaw-orphan-${process.pid}-${randomBytes(8).toString('hex')}.index`);
    try {
      const env = { GIT_INDEX_FILE: tempIndex };
      git(['--git-dir', common, '--work-tree', checkoutPath, 'read-tree', head], { env });
      try {
        git(['--git-dir', common, '--work-tree', checkoutPath, 'update-index', '--refresh'], { env });
      } catch {
        // A non-zero refresh means at least one path differs. diff-files below
        // is the authoritative exact comparison after the stat cache update.
      }
      try {
        git(['--git-dir', common, '--work-tree', checkoutPath, 'diff-files', '--quiet'], { env });
      } catch {
        continue;
      }
      const untracked = gitRaw(
        ['--git-dir', common, '--work-tree', checkoutPath, 'ls-files', '-z', '--others', '--exclude-standard'],
        { env },
      );
      if (untracked.length > 0) continue;
      const indexEntries = gitRaw(['--git-dir', common, '--work-tree', checkoutPath, 'ls-files', '--stage', '-z'], {
        env,
      });
      const key = `${head}\0${branch}`;
      if (!matches.has(key)) {
        matches.set(key, {
          gitDir: fs.realpathSync(common),
          commonGitDir: fs.realpathSync(common),
          head,
          branch,
          indexEntries,
          indexBytes: fs.readFileSync(tempIndex),
          indexMode: fs.lstatSync(tempIndex).mode & 0o7777,
          status: Buffer.alloc(0),
          files: inventoryFiles(checkoutPath, common, env),
          originalPointer,
          method: 'unique-clean-local-branch',
        });
      }
    } finally {
      fs.rmSync(tempIndex, { force: true });
    }
  }
  const recovered = [...matches.values()];
  if (recovered.length === 1) return recovered[0];
  if (recovered.length > 1) {
    const named = recovered.filter(({ branch }) => {
      const normalized = branch.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      return pointerTokens.length > 0 && pointerTokens.every((token) => normalized.includes(token));
    });
    if (named.length === 1) return named[0];
    const reflogMatched = recovered.filter(({ branch }) => matchesReflogCreation(branch));
    if (reflogMatched.length === 1) return { ...reflogMatched[0], method: 'reflog-creation-time' };
    throw new Error(
      `missing Git admin directory for ${checkoutPath}; clean recovery is ambiguous (${recovered.length} states, ${named.length} pointer matches, ${reflogMatched.length} reflog-time matches): ${recovered.map((entry) => `${entry.branch}@${entry.head}`).join(', ')}`,
    );
  }

  if (uniqueReflog.size !== 1 && uniqueInferred.size !== 1) {
    throw new Error(
      `missing Git admin directory for ${checkoutPath}; clean recovery matched 0 states, reflog time matched ${uniqueReflog.size}, and pointer tokens matched ${uniqueInferred.size} local branches`,
    );
  }
  const method = uniqueReflog.size === 1 ? ('reflog-creation-time' as const) : ('unique-pointer-token-branch' as const);
  const [{ common, branch, head }] = [...(uniqueReflog.size === 1 ? uniqueReflog : uniqueInferred).values()];
  return synthesizeMissingAdminRecovery({ common, branch, head, checkoutPath, originalPointer, method });
}

function resolveReviewedExactGitAdmin(
  candidate: LegacyCheckoutCandidate,
  checkoutPath: string,
  decision: ReviewedCheckoutRecoveryDecision,
): { gitDir: string; commonGitDir: string } {
  if (decision.selection !== 'exact-git-admin' || !decision.selectedGitDir) {
    throw new Error(`reviewed exact Git-admin selection is incomplete for ${checkoutPath}`);
  }
  const unresolved = path.resolve(decision.selectedGitDir);
  const stat = fs.lstatSync(unresolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`reviewed exact Git admin is not a safe directory: ${unresolved}`);
  }
  const selected = fs.realpathSync(unresolved);
  const marker = path.join(checkoutPath, '.git');
  const allowed = new Set<string>();
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) allowed.add(fs.realpathSync(marker));
  for (const commonCandidate of candidate.candidateCommonGitDirs ?? []) {
    if (!fs.existsSync(commonCandidate)) continue;
    const common = fs.realpathSync(commonCandidate);
    if (selected === common || pathContained(selected, path.join(common, 'worktrees'))) allowed.add(selected);
  }
  if (!allowed.has(selected)) {
    throw new Error(`reviewed exact Git admin is outside the inventoried repository stores: ${selected}`);
  }
  if (!gitDirWorks(selected, checkoutPath)) {
    throw new Error(`reviewed exact Git admin is no longer usable for ${checkoutPath}: ${selected}`);
  }
  const commonRaw = git(['--git-dir', selected, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = fs.realpathSync(commonRaw);
  if (common !== fs.realpathSync(decision.selectedCommonGitDir)) {
    throw new Error(`reviewed exact Git common directory is stale for ${checkoutPath}`);
  }
  return { gitDir: selected, commonGitDir: common };
}

function captureId(candidate: LegacyCheckoutCandidate): string {
  return sha256(`${candidate.workgroupId}\0${candidate.repo}\0${path.resolve(candidate.checkoutPath)}`).slice(0, 20);
}

function captureIndexAuxiliaryFiles(gitDir: string): CheckoutCapture['indexAuxiliaryFiles'] {
  const files: CheckoutCapture['indexAuxiliaryFiles'] = [];
  for (const name of fs
    .readdirSync(gitDir)
    .filter((entry) => /^sharedindex\.[a-f0-9]+$/i.test(entry))
    .sort()) {
    const source = path.join(gitDir, name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe shared index file: ${source}`);
    const bytes = fs.readFileSync(source);
    files.push({
      name,
      mode: stat.mode & 0o7777,
      size: bytes.length,
      sha256: sha256(bytes),
      bytesBase64: bytes.toString('base64'),
    });
  }
  return files;
}

function assertIndexPathsRoundTrip(indexEntries: Buffer, checkoutPath: string): void {
  let start = 0;
  for (let index = 0; index <= indexEntries.length; index += 1) {
    if (index !== indexEntries.length && indexEntries[index] !== 0) continue;
    if (index > start) {
      const record = indexEntries.subarray(start, index);
      const tab = record.indexOf(0x09);
      if (tab < 0) throw new Error(`malformed NUL-safe index record for ${checkoutPath}`);
      const pathBytes = record.subarray(tab + 1);
      const decoded = pathBytes.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(pathBytes)) {
        throw new Error(
          `Git index path contains non-UTF-8 bytes and cannot be represented losslessly in the migration manifest: ` +
            `${checkoutPath} (path base64 ${pathBytes.toString('base64')})`,
        );
      }
    }
    start = index + 1;
  }
}

function captureGitPointer(checkoutPath: string): CheckoutCapture['gitPointer'] | undefined {
  const marker = path.join(checkoutPath, '.git');
  const stat = fs.lstatSync(marker);
  if (stat.isSymbolicLink()) throw new Error(`unsafe Git marker symlink: ${marker}`);
  if (!stat.isFile()) return undefined;
  const bytes = fs.readFileSync(marker);
  return {
    mode: stat.mode & 0o7777,
    size: bytes.length,
    sha256: sha256(bytes),
    bytesBase64: bytes.toString('base64'),
  };
}

export function reviewedCheckoutStateSha256(capture: CheckoutCapture): string {
  return sha256(
    canonicalJson({
      checkoutPath: capture.checkoutPath,
      head: capture.head,
      branch: capture.branch,
      gitDir: capture.gitDir,
      commonGitDir: capture.commonGitDir,
      indexSha256: capture.indexSha256,
      indexBytesBase64: capture.indexBytesBase64,
      indexMode: capture.indexMode,
      indexAuxiliaryFiles: capture.indexAuxiliaryFiles,
      indexEntriesZBase64: capture.indexEntriesZBase64,
      statusZBase64: capture.statusZBase64,
      files: capture.files,
      gitPointer: capture.gitPointer,
    }),
  );
}

export function missingAdminVisibleStateSha256(capture: CheckoutCapture): string {
  if (!capture.recoveredMissingAdmin) throw new Error('capture is not a missing-admin recovery');
  return reviewedCheckoutStateSha256(capture);
}

export function captureCheckout(
  candidate: LegacyCheckoutCandidate,
  context?: LegacyGitResolutionContext,
  options: {
    requireOriginalAdmin?: boolean;
    operatorRecovery?: ReviewedCheckoutRecoveryDecision;
    preferMetadataSelection?: boolean;
    skipOperatorEvidenceValidation?: boolean;
    fileHashCache?: RepositoryMigrationPrestageCache;
  } = {},
): CheckoutCapture {
  const checkoutPath = fs.realpathSync(candidate.checkoutPath);
  const gitPointer = captureGitPointer(checkoutPath);
  if (options.operatorRecovery?.supplementalSeedGitDir && options.operatorRecovery.supplementalSeedGitDirSha256) {
    validateReviewedRecoverySeed(
      options.operatorRecovery.supplementalSeedGitDir,
      options.operatorRecovery.supplementalSeedGitDirSha256,
      checkoutPath,
      context,
    );
  }
  if (options.operatorRecovery && !options.skipOperatorEvidenceValidation) {
    const decision = options.operatorRecovery;
    if (
      path.resolve(decision.checkoutPath) !== checkoutPath ||
      decision.workgroupId !== candidate.workgroupId ||
      decision.repo !== candidate.repo
    ) {
      throw new Error(`reviewed missing-admin recovery identity mismatch for ${checkoutPath}`);
    }
    if (
      (gitPointer && gitPointer.sha256 !== decision.gitPointerSha256) ||
      (!gitPointer && decision.gitPointerSha256 !== undefined)
    ) {
      throw new Error(`reviewed checkout recovery Git pointer is stale for ${checkoutPath}`);
    }
  }
  let resolved: ReturnType<typeof resolveLegacyGitAdmin>;
  let recovered: OrphanRecovery | undefined;
  if (options.operatorRecovery?.selection === 'exact-git-admin') {
    resolved = resolveReviewedExactGitAdmin(candidate, checkoutPath, options.operatorRecovery);
  } else {
    try {
      resolved = resolveLegacyGitAdmin({ ...candidate, checkoutPath }, context);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('no usable Git admin directory')) throw error;
      if (options.requireOriginalAdmin && !options.operatorRecovery) {
        throw new Error(
          `cannot prove the original raw index for checkout with missing Git admin state; ` +
            `migration is blocked without an explicit operator recovery decision: ${error.message}`,
          { cause: error },
        );
      }
      recovered = recoverMissingAdmin(
        candidate,
        checkoutPath,
        options.operatorRecovery,
        options.preferMetadataSelection,
        context,
      );
      resolved = recovered;
    }
  }
  const { gitDir, commonGitDir } = resolved;
  let head: string | null = recovered?.head ?? null;
  if (!recovered) {
    try {
      head = git(['--git-dir', gitDir, '--work-tree', checkoutPath, 'rev-parse', '--verify', 'HEAD^{commit}']);
    } catch {
      head = null;
    }
  }
  let branch: string | null;
  if (recovered) {
    branch = recovered.branch;
  } else {
    try {
      branch = git(['--git-dir', gitDir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    } catch {
      branch = null;
    }
  }
  const indexPath = recovered ? path.join(recovered.originalPointer, 'index') : path.join(gitDir, 'index');
  let indexBytes: Buffer | null = recovered?.indexBytes ?? null;
  let indexMode: number | null = recovered?.indexMode ?? null;
  if (!recovered && fs.existsSync(indexPath)) {
    const stat = fs.lstatSync(indexPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe Git index path: ${indexPath}`);
    indexBytes = fs.readFileSync(indexPath);
    indexMode = stat.mode & 0o7777;
  }
  const indexSha256 = indexBytes ? sha256(indexBytes) : null;
  const indexAuxiliaryFiles = recovered ? [] : captureIndexAuxiliaryFiles(gitDir);
  const indexEntries =
    recovered?.indexEntries ?? gitRaw(['--git-dir', gitDir, '--work-tree', checkoutPath, 'ls-files', '--stage', '-z']);
  assertIndexPathsRoundTrip(indexEntries, checkoutPath);
  for (const record of indexEntries.toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(160000) [a-f0-9]+ \d+\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const submodulePath = path.join(checkoutPath, match[2]);
    try {
      const stat = fs.lstatSync(submodulePath);
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(submodulePath).length > 0) {
        throw new Error(`initialized submodule requires an explicit nested-state migration decision: ${submodulePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const status =
    recovered?.status ??
    gitRaw([
      '--git-dir',
      gitDir,
      '--work-tree',
      checkoutPath,
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);
  const files = recovered?.files ?? inventoryFiles(checkoutPath, gitDir, undefined, options.fileHashCache);
  const capture: CheckoutCapture = {
    id: captureId(candidate),
    workgroupId: candidate.workgroupId,
    repo: candidate.repo,
    checkoutPath,
    workUnit: candidate.workUnit,
    ...(candidate.sourceRole ? { sourceRole: candidate.sourceRole } : {}),
    ...(candidate.credentialBearingOrigin ? { credentialBearingOrigin: true as const } : {}),
    gitDir,
    commonGitDir,
    head,
    branch,
    indexPath,
    indexSha256,
    indexBytesBase64: indexBytes?.toString('base64') ?? null,
    indexMode,
    indexAuxiliaryFiles,
    indexEntriesZBase64: indexEntries.toString('base64'),
    statusZBase64: status.toString('base64'),
    files,
    ...(gitPointer ? { gitPointer } : {}),
    allocatedWorktreeBytes: allocatedInventoryBytes(checkoutPath, files),
    allocatedGitBytes: allocatedGitBytes(commonGitDir),
    ...(recovered
      ? {
          recoveredMissingAdmin: {
            method: recovered.method,
            originalPointer: recovered.originalPointer,
            ...(recovered.indexClassificationSynthesized ? { indexClassificationSynthesized: true as const } : {}),
          },
        }
      : {}),
    ...(options.operatorRecovery
      ? {
          reviewedRecovery: {
            selection: options.operatorRecovery.selection,
            action: options.operatorRecovery.action,
            visibleStateSha256: options.operatorRecovery.visibleStateSha256,
            ...(options.operatorRecovery.gitPointerSha256
              ? { gitPointerSha256: options.operatorRecovery.gitPointerSha256 }
              : {}),
            ...(options.operatorRecovery.selectedGitDir
              ? { selectedGitDir: fs.realpathSync(options.operatorRecovery.selectedGitDir) }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(options.operatorRecovery, 'selectedIndexSha256')
              ? { selectedIndexSha256: options.operatorRecovery.selectedIndexSha256 }
              : {}),
          },
        }
      : {}),
    ...(candidate.repositoryIdentityRecovery
      ? { repositoryIdentityRecovery: candidate.repositoryIdentityRecovery }
      : {}),
  };
  if (options.operatorRecovery?.selection === 'exact-git-admin') {
    const decision = options.operatorRecovery;
    if (
      capture.gitDir !== fs.realpathSync(decision.selectedGitDir!) ||
      capture.commonGitDir !== fs.realpathSync(decision.selectedCommonGitDir) ||
      capture.head !== decision.selectedHead ||
      capture.branch !== decision.selectedBranch ||
      capture.indexSha256 !== decision.selectedIndexSha256
    ) {
      throw new Error(`reviewed exact Git-admin state is stale for ${checkoutPath}`);
    }
  }
  if (options.operatorRecovery && !options.skipOperatorEvidenceValidation) {
    const evidence = reviewedCheckoutStateSha256(capture);
    if (evidence !== options.operatorRecovery.visibleStateSha256) {
      throw new Error(`reviewed checkout recovery visible state is stale for ${checkoutPath}`);
    }
  }
  return capture;
}

export function createReviewedMissingAdminRecoveryProposal(input: {
  candidate: LegacyCheckoutCandidate;
  selectedCommonGitDir: string;
  selectedHead: string;
  selectedBranch: string;
  action: ReviewedCheckoutRecoveryDecision['action'];
  externalSeedGitDirSha256?: string;
  context?: LegacyGitResolutionContext;
}): ReviewedCheckoutRecoveryDecision {
  const pointer = captureGitPointer(fs.realpathSync(input.candidate.checkoutPath));
  if (!pointer)
    throw new Error(`reviewed recovery proposal requires a linked Git pointer: ${input.candidate.checkoutPath}`);
  const provisional: ReviewedCheckoutRecoveryDecision = {
    checkoutPath: fs.realpathSync(input.candidate.checkoutPath),
    workgroupId: input.candidate.workgroupId,
    repo: input.candidate.repo,
    action: input.action,
    selection: 'synthesized-visible-state',
    selectedCommonGitDir: fs.realpathSync(input.selectedCommonGitDir),
    selectedHead: input.selectedHead,
    selectedBranch: input.selectedBranch,
    gitPointerSha256: pointer.sha256,
    visibleStateSha256: '0'.repeat(64),
    ...(input.externalSeedGitDirSha256 ? { externalSeedGitDirSha256: input.externalSeedGitDirSha256 } : {}),
  };
  const capture = captureCheckout(input.candidate, input.context, {
    operatorRecovery: provisional,
    skipOperatorEvidenceValidation: true,
  });
  return { ...provisional, visibleStateSha256: reviewedCheckoutStateSha256(capture) };
}

export function createReviewedExactGitAdminRecoveryProposal(input: {
  candidate: LegacyCheckoutCandidate;
  selectedGitDir: string;
  action: ReviewedCheckoutRecoveryDecision['action'];
  context?: LegacyGitResolutionContext;
}): ReviewedCheckoutRecoveryDecision {
  const checkoutPath = fs.realpathSync(input.candidate.checkoutPath);
  const gitPointer = captureGitPointer(checkoutPath);
  const selectedGitDir = fs.realpathSync(input.selectedGitDir);
  const commonRaw = git(['--git-dir', selectedGitDir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const selectedCommonGitDir = fs.realpathSync(commonRaw);
  let selectedHead: string | null;
  try {
    selectedHead = git(['--git-dir', selectedGitDir, 'rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    selectedHead = null;
  }
  let selectedBranch: string | null;
  try {
    selectedBranch = git(['--git-dir', selectedGitDir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    selectedBranch = null;
  }
  const selectedIndexPath = path.join(selectedGitDir, 'index');
  const selectedIndexSha256 = fs.existsSync(selectedIndexPath) ? sha256(fs.readFileSync(selectedIndexPath)) : null;
  const provisional: ReviewedCheckoutRecoveryDecision = {
    checkoutPath,
    workgroupId: input.candidate.workgroupId,
    repo: input.candidate.repo,
    action: input.action,
    selection: 'exact-git-admin',
    selectedGitDir,
    selectedCommonGitDir,
    selectedHead,
    selectedBranch,
    selectedIndexSha256,
    ...(gitPointer ? { gitPointerSha256: gitPointer.sha256 } : {}),
    visibleStateSha256: '0'.repeat(64),
  };
  const capture = captureCheckout(input.candidate, input.context, {
    operatorRecovery: provisional,
    skipOperatorEvidenceValidation: true,
  });
  return { ...provisional, visibleStateSha256: reviewedCheckoutStateSha256(capture) };
}

function manifestHash(input: Omit<RepositoryMigrationManifest, 'manifestSha256'>): string {
  // Rollback paths are as security- and loss-sensitive as captured source
  // evidence. The manifest hash therefore binds the complete cutover plan;
  // execution never appends operational paths after this hash is calculated.
  return sha256(canonicalJson(input));
}

const SAFE_MIGRATION_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

function migrationRootForIdentity(input: {
  dataDir: string;
  runId: string;
  workgroupId: string;
  repo: string;
}): string {
  if (input.dataDir !== path.resolve(input.dataDir))
    throw new Error('repository migration data directory must be absolute');
  if (!SAFE_MIGRATION_RUN_ID.test(input.runId) || input.runId === '.' || input.runId === '..') {
    throw new Error(`invalid repository migration run id: ${input.runId}`);
  }
  // canonicalRepoDir performs the shared strict workgroup/repository segment
  // validation even for archive-only migrations.
  canonicalRepoDir(input.workgroupId, input.repo, input.dataDir);
  return path.join(input.dataDir, 'repository-migrations', input.runId, input.workgroupId, input.repo);
}

function expectedRescueRefs(capture: CheckoutCapture, runId: string): NonNullable<CheckoutCapture['rescue']> {
  const namespace = `refs/nanoclaw-rescue/${runId}/${capture.id}`;
  return {
    headRef: capture.head ? `${namespace}/head` : null,
    indexRef: `${namespace}/index`,
    worktreeRef: `${namespace}/worktree`,
  };
}

function expectedRenamedObjectStores(objectStores: readonly string[], root: string): Record<string, string> {
  const renamed: Record<string, string> = {};
  for (const store of objectStores) {
    // Legacy repository stores were rooted under a literal `.repos` segment.
    // Their destination is derived only from the hash-bound source path, not
    // from mutable filesystem state encountered midway through cutover.
    if (!path.resolve(store).split(path.sep).includes('.repos')) continue;
    renamed[store] = path.join(root, 'renamed-object-stores', sha256(store).slice(0, 20));
  }
  return renamed;
}

function expectedOperationalFields(input: {
  dataDir: string;
  runId: string;
  workgroupId: string;
  repo: string;
  objectStores: readonly string[];
  captures: CheckoutCapture[];
}): {
  captures: Map<string, Pick<CheckoutCapture, 'rescue' | 'assignedBranch' | 'destinationPath' | 'renamedOldPath'>>;
  renamedObjectStores: Record<string, string>;
} {
  const root = migrationRootForIdentity(input);
  const selected = deduplicateCaptures(input.captures);
  const selectedIds = new Set(selected.map((capture) => capture.id));
  const assignments = migrationBranchAssignments(selected, input.repo);
  const captures = new Map<
    string,
    Pick<CheckoutCapture, 'rescue' | 'assignedBranch' | 'destinationPath' | 'renamedOldPath'>
  >();
  for (const capture of input.captures) {
    if (captures.has(capture.id)) throw new Error(`duplicate repository migration capture id: ${capture.id}`);
    const assignedBranch = assignments.get(capture.id);
    const destinationPath = selectedIds.has(capture.id)
      ? capture.preservedLegacy
        ? path.join(input.dataDir, 'repository-rescues', input.workgroupId, input.repo, capture.id)
        : path.join(topicWorktreesDir(capture.workUnit, input.dataDir), input.repo)
      : undefined;
    captures.set(capture.id, {
      rescue: expectedRescueRefs(capture, input.runId),
      ...(assignedBranch ? { assignedBranch } : {}),
      ...(destinationPath ? { destinationPath } : {}),
      renamedOldPath: path.join(root, 'renamed-old', capture.id),
    });
  }
  return {
    captures,
    renamedObjectStores: expectedRenamedObjectStores(input.objectStores, root),
  };
}

function applyOperationalFields(input: {
  dataDir: string;
  runId: string;
  workgroupId: string;
  repo: string;
  objectStores: readonly string[];
  captures: CheckoutCapture[];
}): Record<string, string> {
  const expected = expectedOperationalFields(input);
  for (const capture of input.captures) {
    const fields = expected.captures.get(capture.id)!;
    capture.rescue = fields.rescue;
    capture.assignedBranch = fields.assignedBranch;
    capture.destinationPath = fields.destinationPath;
    capture.renamedOldPath = fields.renamedOldPath;
  }
  return expected.renamedObjectStores;
}

function resolveCanonicalBase(objectStores: string[]): RepositoryMigrationManifest['canonicalBase'] {
  const candidates: Array<
    RepositoryMigrationManifest['canonicalBase'] & { committedAt: number; remoteDefault: boolean }
  > = [];
  for (const store of objectStores) {
    const sourceRefs: Array<{ sourceRef: string; remoteDefault: boolean }> = [];
    try {
      sourceRefs.push({
        sourceRef: git(['--git-dir', store, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
        remoteDefault: true,
      });
    } catch {
      // This store contributes no valid remote-default candidate.
    }
    try {
      sourceRefs.push({
        sourceRef: git(['--git-dir', store, 'symbolic-ref', '--quiet', 'HEAD']),
        remoteDefault: false,
      });
    } catch {
      // A detached store contributes no local-HEAD fallback candidate.
    }
    for (const { sourceRef, remoteDefault } of sourceRefs) {
      try {
        const head = git(['--git-dir', store, 'rev-parse', '--verify', `${sourceRef}^{commit}`]);
        const objectFormat = git(['--git-dir', store, 'rev-parse', '--show-object-format']);
        if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
          throw new Error(`unsupported object format: ${objectFormat}`);
        }
        const branch = sourceRef.startsWith('refs/remotes/origin/')
          ? sourceRef.slice('refs/remotes/origin/'.length)
          : sourceRef.replace(/^refs\/heads\//, '');
        const committedAt = Number(git(['--git-dir', store, 'show', '-s', '--format=%ct', head]));
        if (!branch || !Number.isFinite(committedAt)) continue;
        candidates.push({ head, branch, sourceRef, objectFormat, committedAt, remoteDefault });
      } catch {
        // Try the next candidate/store.
      }
    }
  }
  if (candidates.length === 0)
    throw new Error('no local origin/HEAD or bare HEAD is available for the clean canonical');
  const eligible = candidates.some((candidate) => candidate.remoteDefault)
    ? candidates.filter((candidate) => candidate.remoteDefault)
    : candidates;
  eligible.sort((a, b) => b.committedAt - a.committedAt || a.head.localeCompare(b.head));
  const { committedAt: _committedAt, remoteDefault: _remoteDefault, ...selected } = eligible[0];
  return selected;
}

function estimateCanonicalWorktreeBytes(objectStores: string[], head: string, blockSize: number): number {
  for (const store of objectStores) {
    try {
      const raw = gitRaw(['--git-dir', store, 'ls-tree', '-r', '-l', '-z', head]);
      const directories = new Set<string>();
      let bytes = 0;
      for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
        const tab = record.indexOf('\t');
        if (tab < 0) throw new Error('malformed ls-tree record');
        const metadata = record.slice(0, tab).trim().split(/\s+/);
        const size = Number(metadata[3]);
        if (Number.isFinite(size) && size > 0) bytes += Math.ceil(size / blockSize) * blockSize;
        const parts = record.slice(tab + 1).split('/');
        for (let index = 1; index < parts.length; index += 1) {
          directories.add(parts.slice(0, index).join('/'));
        }
      }
      return bytes + directories.size * blockSize;
    } catch {
      // The commit can exist in a later imported object store.
    }
  }
  throw new Error(`cannot estimate canonical checkout allocation for ${head}`);
}

function normalizedMigrationRepository(input: { origin: string | null; repositoryId: string }): {
  origin: string | null;
  repositoryId: string;
} {
  if (input.origin === null) {
    if (!input.repositoryId.startsWith('local-only:')) {
      throw new Error('originless migration requires a local-only repository identity');
    }
    return input;
  }
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(input.origin)) return input;
  const origin = normalizedCredentialFreeGithubOrigin(input.origin);
  const repositoryId = normalizedGithubRepositoryIdentity(input.origin);
  if (!origin || !repositoryId) {
    throw new Error('migration origin must resolve to credential-free HTTPS github.com');
  }
  return { origin, repositoryId };
}

export function createRepositoryMigrationManifest(input: {
  dataDir: string;
  workgroupId: string;
  repo: string;
  origin: string | null;
  /** Explicit reviewed disposition; never inferred from checkout actions. */
  archiveOnly?: boolean;
  repositoryId: string;
  candidates: LegacyCheckoutCandidate[];
  objectStores?: string[];
  runId?: string;
  availableBytes?: number;
  resolutionContext?: LegacyGitResolutionContext;
  recoveryDecisions?: ReviewedCheckoutRecoveryDecision[];
  /** Optional advisory cache populated before the fleet is stopped. */
  fileHashCache?: RepositoryMigrationPrestageCache;
  onCaptureProgress?: (progress: {
    phase: 'starting' | 'completed';
    current: number;
    total: number;
    checkoutPath: string;
  }) => void;
}): RepositoryMigrationManifest {
  if (input.candidates.length === 0 && (input.objectStores?.length ?? 0) === 0) {
    throw new Error('migration requires at least one physical checkout or object store');
  }
  const normalizedRepository = normalizedMigrationRepository(input);
  const captures: CheckoutCapture[] = [];
  const captureErrors: string[] = [];
  const recoveryByPath = new Map(
    (input.recoveryDecisions ?? []).map((decision) => [path.resolve(decision.checkoutPath), decision]),
  );
  if (recoveryByPath.size !== (input.recoveryDecisions ?? []).length) {
    throw new Error(`duplicate reviewed checkout recovery decision for ${input.workgroupId}/${input.repo}`);
  }
  const candidatePaths = new Set(input.candidates.map((candidate) => path.resolve(candidate.checkoutPath)));
  for (const decision of input.recoveryDecisions ?? []) {
    if (
      decision.workgroupId !== input.workgroupId ||
      decision.repo !== input.repo ||
      !candidatePaths.has(path.resolve(decision.checkoutPath))
    ) {
      throw new Error(`reviewed checkout recovery does not match current inventory: ${decision.checkoutPath}`);
    }
  }
  for (const [index, candidate] of input.candidates.entries()) {
    input.onCaptureProgress?.({
      phase: 'starting',
      current: index + 1,
      total: input.candidates.length,
      checkoutPath: candidate.checkoutPath,
    });
    try {
      const decision = recoveryByPath.get(path.resolve(candidate.checkoutPath));
      if (
        candidate.sourceRole === 'repository-staging' &&
        candidate.credentialBearingOrigin &&
        decision?.action !== 'archive-visible-state'
      ) {
        throw new Error(
          'credential-bearing repository-staging checkout requires hash-bound reviewed preservation; ' +
            'the credential value was intentionally omitted',
        );
      }
      const capture = captureCheckout(candidate, input.resolutionContext, {
        requireOriginalAdmin: true,
        ...(decision ? { operatorRecovery: decision } : {}),
        ...(input.fileHashCache ? { fileHashCache: input.fileHashCache } : {}),
      });
      if (decision?.action === 'archive-visible-state') {
        capture.archivedLegacy = { reason: 'operator-reviewed-checkout' };
      }
      captures.push(capture);
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      if (/explicit operator recovery decision/.test(detail)) {
        try {
          const diagnostic = captureCheckout(candidate, input.resolutionContext, {
            preferMetadataSelection: true,
            ...(input.fileHashCache ? { fileHashCache: input.fileHashCache } : {}),
          });
          if (diagnostic.recoveredMissingAdmin && diagnostic.head && diagnostic.branch && diagnostic.gitPointer) {
            detail +=
              `\nreviewed recovery proposal (action requires operator review): ` +
              JSON.stringify({
                checkoutPath: diagnostic.checkoutPath,
                workgroupId: diagnostic.workgroupId,
                repo: diagnostic.repo,
                action: 'restore-visible-state',
                selection: 'synthesized-visible-state',
                selectedCommonGitDir: diagnostic.commonGitDir,
                selectedHead: diagnostic.head,
                selectedBranch: diagnostic.branch,
                gitPointerSha256: diagnostic.gitPointer.sha256,
                visibleStateSha256: missingAdminVisibleStateSha256(diagnostic),
              } satisfies ReviewedCheckoutRecoveryDecision);
          }
        } catch (diagnosticError) {
          detail += `\nrecovery proposal could not be derived automatically: ${
            diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
          }`;
        }
      }
      captureErrors.push(`${candidate.checkoutPath}: ${detail}`);
    } finally {
      input.onCaptureProgress?.({
        phase: 'completed',
        current: index + 1,
        total: input.candidates.length,
        checkoutPath: candidate.checkoutPath,
      });
    }
  }
  if (captureErrors.length > 0) {
    throw new Error(
      `repository inventory could not prove lossless capture:\n${captureErrors.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  const credentialBearingStagingOnly =
    captures.some((capture) => capture.sourceRole === 'repository-staging' && capture.credentialBearingOrigin) &&
    captures.every((capture) => capture.sourceRole === 'repository-staging');
  if (credentialBearingStagingOnly && input.archiveOnly !== true) {
    throw new Error(
      'credential-bearing repository-staging-only inventory requires a reviewed archive-only origin disposition; ' +
        'it cannot publish an active canonical',
    );
  }
  // A standalone clone can live below another physical checkout of the same
  // repository. Its source must be moved out before its ancestor is renamed;
  // rollback then walks this hash-bound order in reverse and restores the
  // ancestor before the nested checkout.
  captures.splice(0, captures.length, ...orderCapturesDeepestFirst(captures));
  const missingAdminCaptures = captures.filter(
    (capture) => capture.recoveredMissingAdmin !== undefined && !capture.reviewedRecovery,
  );
  if (missingAdminCaptures.length > 0) {
    throw new Error(
      'repository inventory cannot prove the original raw index for checkout(s) with missing Git admin state; ' +
        `migration is blocked without an explicit operator recovery decision:\n${missingAdminCaptures
          .map((capture) => `- ${capture.checkoutPath}`)
          .join('\n')}`,
    );
  }
  const unmappedWithUniqueState: CheckoutCapture[] = [];
  for (const capture of captures) {
    if (!capture.workUnit.key.startsWith('session:legacy:')) continue;
    if (capture.archivedLegacy) continue;
    const archived = captureArchiveReason(capture);
    if (archived) capture.archivedLegacy = archived;
    else if (capture.sourceRole === 'legacy-canonical') {
      capture.preservedLegacy = { reason: 'legacy-canonical-unique-state' };
    } else unmappedWithUniqueState.push(capture);
  }
  if (unmappedWithUniqueState.length > 0) {
    const hasRepositoryStaging = unmappedWithUniqueState.some((capture) => capture.sourceRole === 'repository-staging');
    throw new Error(
      (hasRepositoryStaging
        ? 'retained repository-staging checkout(s) contain dirty, detached, unborn, local-only, or unpushed state; ' +
          'they use a synthetic non-live work unit and can only proceed when explicitly archived by a reviewed preservation decision:\n'
        : 'legacy checkout(s) contain dirty, unborn, local-only, or unpushed state but have no real topic/session; ' +
          'supply exact reviewed mappings or explicitly archive their preserved state before migration:\n') +
        unmappedWithUniqueState
          .map((capture) => {
            const existingDecision = recoveryByPath.get(path.resolve(capture.checkoutPath));
            const proposal: ReviewedCheckoutRecoveryDecision = existingDecision
              ? { ...existingDecision, action: 'archive-visible-state' }
              : {
                  checkoutPath: capture.checkoutPath,
                  workgroupId: capture.workgroupId,
                  repo: capture.repo,
                  action: 'archive-visible-state',
                  selection: 'exact-git-admin',
                  selectedGitDir: capture.gitDir,
                  selectedCommonGitDir: capture.commonGitDir,
                  selectedHead: capture.head,
                  selectedBranch: capture.branch,
                  selectedIndexSha256: capture.indexSha256,
                  ...(capture.gitPointer ? { gitPointerSha256: capture.gitPointer.sha256 } : {}),
                  visibleStateSha256: reviewedCheckoutStateSha256(capture),
                };
            return `- ${capture.checkoutPath}\nreviewed recovery proposal (action requires operator review): ${JSON.stringify(proposal)}`;
          })
          .join('\n'),
    );
  }
  const objectStores = [
    ...new Set(
      [
        ...(input.objectStores ?? []),
        ...captures.map((capture) => capture.commonGitDir),
        ...(input.recoveryDecisions ?? []).flatMap((decision) =>
          decision.supplementalSeedGitDir ? [decision.supplementalSeedGitDir] : [],
        ),
      ].map((entry) => fs.realpathSync(entry)),
    ),
  ].sort();
  for (const store of objectStores) {
    git(['--git-dir', store, 'rev-parse', '--git-dir']);
  }
  const canonicalBase = resolveCanonicalBase(objectStores);
  for (const store of objectStores) {
    const objectFormat = git(['--git-dir', store, 'rev-parse', '--show-object-format']);
    if (objectFormat !== canonicalBase.objectFormat) {
      throw new Error(
        `repository object-format conflict: ${canonicalBase.objectFormat} versus ${objectFormat} at ${store}`,
      );
    }
  }
  const capturesByUnit = new Map<string, CheckoutCapture[]>();
  for (const capture of captures) {
    if (capture.archivedLegacy) continue;
    const grouped = capturesByUnit.get(capture.workUnit.key) ?? [];
    grouped.push(capture);
    capturesByUnit.set(capture.workUnit.key, grouped);
  }
  const divergentUnitErrors: string[] = [];
  for (const unitCaptures of capturesByUnit.values()) {
    if (new Set(unitCaptures.map(stateFingerprint)).size <= 1) continue;
    const basenamePrimary = unitCaptures.filter(
      (capture) => path.basename(capture.checkoutPath).toLowerCase() === input.repo.toLowerCase(),
    );
    if (basenamePrimary.length === 1) {
      const alternates = unitCaptures.filter((capture) => capture !== basenamePrimary[0]);
      divergentUnitErrors.push(
        `same work unit has divergent physical checkout state and cannot share one linked worktree; ` +
          `the repository-named checkout is the only unambiguous active candidate, but every alternate requires ` +
          `an explicit reviewed archive decision:\n${alternates
            .map((capture) => {
              const existingDecision = recoveryByPath.get(path.resolve(capture.checkoutPath));
              const proposal: ReviewedCheckoutRecoveryDecision = existingDecision
                ? { ...existingDecision, action: 'archive-visible-state' }
                : {
                    checkoutPath: capture.checkoutPath,
                    workgroupId: capture.workgroupId,
                    repo: capture.repo,
                    action: 'archive-visible-state',
                    selection: 'exact-git-admin',
                    selectedGitDir: capture.gitDir,
                    selectedCommonGitDir: capture.commonGitDir,
                    selectedHead: capture.head,
                    selectedBranch: capture.branch,
                    selectedIndexSha256: capture.indexSha256,
                    ...(capture.gitPointer ? { gitPointerSha256: capture.gitPointer.sha256 } : {}),
                    visibleStateSha256: reviewedCheckoutStateSha256(capture),
                  };
              return `- ${capture.checkoutPath}\nreviewed recovery proposal (action requires operator review): ${JSON.stringify(proposal)}`;
            })
            .join('\n')}`,
      );
      continue;
    }
    divergentUnitErrors.push(
      `same work unit has divergent physical checkout state and cannot share one linked worktree; ` +
        `there is no unambiguous active primary, so every divergent state requires an explicit reviewed archive ` +
        `decision and the real topic will start from a fresh canonical checkout:\n${unitCaptures
          .map((capture) => {
            const existingDecision = recoveryByPath.get(path.resolve(capture.checkoutPath));
            const proposal: ReviewedCheckoutRecoveryDecision = existingDecision
              ? { ...existingDecision, action: 'archive-visible-state' }
              : {
                  checkoutPath: capture.checkoutPath,
                  workgroupId: capture.workgroupId,
                  repo: capture.repo,
                  action: 'archive-visible-state',
                  selection: 'exact-git-admin',
                  selectedGitDir: capture.gitDir,
                  selectedCommonGitDir: capture.commonGitDir,
                  selectedHead: capture.head,
                  selectedBranch: capture.branch,
                  selectedIndexSha256: capture.indexSha256,
                  ...(capture.gitPointer ? { gitPointerSha256: capture.gitPointer.sha256 } : {}),
                  visibleStateSha256: reviewedCheckoutStateSha256(capture),
                };
            return `- ${capture.checkoutPath}\nreviewed recovery proposal (action requires operator review): ${JSON.stringify(proposal)}`;
          })
          .join('\n')}`,
    );
  }
  if (divergentUnitErrors.length > 0) throw new Error(divergentUnitErrors.join('\n'));
  const uniqueGitBytes = objectStores.reduce((sum, store) => sum + allocatedGitBytes(store), 0);
  const selectedCaptures = deduplicateCaptures(captures);
  const worktreeBytes = selectedCaptures.reduce((sum, capture) => sum + capture.allocatedWorktreeBytes, 0);
  const blockSize = Number(fs.statfsSync(input.dataDir).bsize);
  const canonicalWorktreeBytes = estimateCanonicalWorktreeBytes(objectStores, canonicalBase.head, blockSize);
  const worktreeAdminBytes = selectedCaptures.reduce((sum, capture) => {
    const rawIndexBytes = capture.indexBytesBase64 ? Buffer.from(capture.indexBytesBase64, 'base64').length : 0;
    const auxiliaryBytes = capture.indexAuxiliaryFiles.reduce((fileSum, entry) => fileSum + entry.size, 0);
    // Include room for the linked-worktree admin files, logs, and pointer in
    // addition to the exact captured index allocation.
    return sum + rawIndexBytes + auxiliaryBytes + 64 * 1024;
  }, 0);
  // Only status-visible content can introduce rescue blobs not already present
  // in a captured object store. Staged blobs already live in that store, while
  // unstaged/untracked bytes may exist in the source store, replacement
  // canonical, and external bundle during overlap. Missing-admin visible-state
  // seeds are included in objectStores above. Counting every clean tracked byte
  // once per historical checkout produced a many-times-duplicated false upper
  // bound for monorepos with hundreds of linked worktrees.
  const novelVisibleBytes = captures.reduce((sum, capture) => sum + allocatedChangedWorktreeBytes(capture), 0);
  const rescueObjectBytes = novelVisibleBytes * 3;
  const core = uniqueGitBytes * 2 + worktreeBytes + canonicalWorktreeBytes + worktreeAdminBytes + rescueObjectBytes;
  const safetyBytes = Math.max(64 * 1024 * 1024, Math.ceil(core * 0.1));
  const requiredBytes = core + safetyBytes;
  const statfs = fs.statfsSync(input.dataDir);
  const availableBytes = input.availableBytes ?? Number(statfs.bavail) * Number(statfs.bsize);
  const archiveOnly = input.archiveOnly === true;
  if (archiveOnly && normalizedRepository.origin !== null) {
    throw new Error('archive-only repository migration must not retain an active network origin');
  }
  if (archiveOnly && captures.some((capture) => !capture.archivedLegacy)) {
    throw new Error('archive-only repository migration requires every checkout to have a reviewed archive decision');
  }
  const runId = input.runId ?? new Date().toISOString().replace(/[:.]/g, '-') + `-${randomBytes(4).toString('hex')}`;
  const dataDir = path.resolve(input.dataDir);
  const renamedObjectStores = applyOperationalFields({
    dataDir,
    runId,
    workgroupId: input.workgroupId,
    repo: input.repo,
    objectStores,
    captures,
  });
  const base = {
    version: 1 as const,
    runId,
    createdAt: new Date().toISOString(),
    dataDir,
    workgroupId: input.workgroupId,
    repo: input.repo,
    origin: normalizedRepository.origin,
    archiveOnly,
    repositoryId: normalizedRepository.repositoryId,
    objectStores,
    canonicalBase,
    captures,
    renamedObjectStores,
    capacity: {
      availableBytes,
      requiredBytes,
      uniqueGitBytes,
      worktreeBytes,
      canonicalWorktreeBytes,
      worktreeAdminBytes,
      rescueObjectBytes,
      safetyBytes,
    },
  };
  const manifest = { ...base, manifestSha256: manifestHash(base) };
  if (availableBytes < requiredBytes) {
    throw new Error(
      `capacity gate rejected before mutation: ${availableBytes} bytes available, ${requiredBytes} bytes required`,
    );
  }
  return manifest;
}

export function verifyRepositoryMigrationManifest(manifest: RepositoryMigrationManifest): void {
  const { manifestSha256, ...base } = manifest;
  if (manifestHash(base) !== manifestSha256) throw new Error('repository migration manifest hash mismatch');
  const normalizedRepository = normalizedMigrationRepository(manifest);
  if (normalizedRepository.origin !== manifest.origin || normalizedRepository.repositoryId !== manifest.repositoryId) {
    throw new Error('repository migration manifest origin or repository identity is not canonical');
  }
  const expectedCaptureOrder = orderCapturesDeepestFirst(manifest.captures).map((capture) => capture.id);
  if (manifest.captures.some((capture, index) => capture.id !== expectedCaptureOrder[index])) {
    throw new Error('repository migration captures are not ordered deepest-first');
  }
  const expected = expectedOperationalFields({
    dataDir: manifest.dataDir,
    runId: manifest.runId,
    workgroupId: manifest.workgroupId,
    repo: manifest.repo,
    objectStores: manifest.objectStores,
    captures: manifest.captures,
  });
  for (const capture of manifest.captures) {
    const fields = expected.captures.get(capture.id)!;
    if (
      canonicalJson({
        rescue: capture.rescue,
        assignedBranch: capture.assignedBranch,
        destinationPath: capture.destinationPath,
        renamedOldPath: capture.renamedOldPath,
      }) !==
      canonicalJson({
        rescue: fields.rescue,
        assignedBranch: fields.assignedBranch,
        destinationPath: fields.destinationPath,
        renamedOldPath: fields.renamedOldPath,
      })
    ) {
      throw new Error(`repository migration operational fields are not deterministic for capture ${capture.id}`);
    }
  }
  if (canonicalJson(manifest.renamedObjectStores) !== canonicalJson(expected.renamedObjectStores)) {
    throw new Error('repository migration renamed object-store paths are not deterministic');
  }
}

function migrationRoot(manifest: RepositoryMigrationManifest): string {
  return migrationRootForIdentity(manifest);
}

/** Return the hash-plan's actual repository path without following filesystem links. */
export function repositoryMigrationPath(manifest: RepositoryMigrationManifest): string {
  return manifest.archiveOnly
    ? path.join(migrationRoot(manifest), 'preserved-repository')
    : canonicalRepoDir(manifest.workgroupId, manifest.repo, manifest.dataDir);
}

export function manifestPath(manifest: RepositoryMigrationManifest): string {
  return path.join(migrationRoot(manifest), 'manifest.json');
}

function journalPath(manifest: RepositoryMigrationManifest): string {
  return path.join(migrationRoot(manifest), 'journal.json');
}

function readJournal(manifest: RepositoryMigrationManifest): MigrationJournal {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(manifest), 'utf8')) as MigrationJournal;
    if (parsed.manifestSha256 !== manifest.manifestSha256 || parsed.runId !== manifest.runId) {
      throw new Error('migration journal identity mismatch');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      version: 1,
      runId: manifest.runId,
      workgroupId: manifest.workgroupId,
      repo: manifest.repo,
      manifestSha256: manifest.manifestSha256,
      phases: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

function recordPhase(manifest: RepositoryMigrationManifest, journal: MigrationJournal, phase: MigrationPhase): void {
  if (!journal.phases.includes(phase)) journal.phases.push(phase);
  journal.updatedAt = new Date().toISOString();
  atomicJson(journalPath(manifest), journal);
  if (process.env.NANOCLAW_MIGRATION_CRASH_AFTER === phase) process.exit(86);
  if (process.env.NANOCLAW_MIGRATION_FAIL_AFTER === phase) throw new Error(`injected failure after ${phase}`);
}

function createSyntheticCommit(capture: CheckoutCapture, runId: string): void {
  const expected = expectedRescueRefs(capture, runId);
  if (canonicalJson(capture.rescue) !== canonicalJson(expected)) {
    throw new Error(`capture ${capture.id} has an invalid rescue-ref plan`);
  }
  const { headRef, indexRef, worktreeRef } = expected;
  if (capture.head && headRef) git(['--git-dir', capture.commonGitDir, 'update-ref', headRef, capture.head]);

  const rescueIndex = path.join(migrationRootForCapture(capture, runId), `index-${capture.id}.index`);
  fs.mkdirSync(path.dirname(rescueIndex), { recursive: true, mode: 0o700 });
  fs.rmSync(rescueIndex, { force: true });
  let indexTree: string;
  try {
    const env = { GIT_INDEX_FILE: rescueIndex };
    git(['--git-dir', capture.commonGitDir, 'read-tree', '--empty'], { env });
    const indexRecords: Buffer[] = [];
    let hasConflictStages = false;
    for (const record of Buffer.from(capture.indexEntriesZBase64, 'base64').toString('utf8').split('\0')) {
      if (!record) continue;
      const match = /^(\d{6}) ([a-f0-9]+) (\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error(`malformed captured index entry for ${capture.id}`);
      const [, mode, oid, stage, filePath] = match;
      if (/^0+$/.test(oid)) continue;
      if (stage === '0') {
        indexRecords.push(Buffer.from(`${mode} ${oid}\t${filePath}\0`));
      } else {
        hasConflictStages = true;
        const namespace = sha256(Buffer.from(filePath)).slice(0, 32);
        indexRecords.push(Buffer.from(`${mode} ${oid}\t.nanoclaw-conflict-objects/${namespace}/stage-${stage}\0`));
      }
    }
    if (hasConflictStages) {
      const metadata = Buffer.from(
        `${JSON.stringify({ version: 1, indexEntriesZBase64: capture.indexEntriesZBase64 }, null, 2)}\n`,
      );
      const metadataOid = git(['--git-dir', capture.commonGitDir, 'hash-object', '--no-filters', '-w', '--stdin'], {
        input: metadata,
      });
      indexRecords.push(Buffer.from(`100644 ${metadataOid}\t.nanoclaw-conflict-objects/index.json\0`));
    }
    git(['--git-dir', capture.commonGitDir, 'update-index', '-z', '--index-info'], {
      env,
      input: Buffer.concat(indexRecords),
    });
    indexTree = git(['--git-dir', capture.commonGitDir, 'write-tree'], { env });
    if (indexRecords.length === 0) {
      const materializedEmptyTree = git(
        ['--git-dir', capture.commonGitDir, 'hash-object', '-t', 'tree', '-w', '--stdin'],
        { input: Buffer.alloc(0) },
      );
      if (materializedEmptyTree !== indexTree) {
        throw new Error(`empty rescue index tree object mismatch for ${capture.id}`);
      }
    }
  } finally {
    fs.rmSync(rescueIndex, { force: true });
  }
  const indexCommit = git(
    ['--git-dir', capture.commonGitDir, 'commit-tree', indexTree, ...(capture.head ? ['-p', capture.head] : [])],
    { input: `NanoClaw rescue index ${capture.id}\n` },
  );
  git(['--git-dir', capture.commonGitDir, 'update-ref', indexRef, indexCommit]);

  const tempIndex = path.join(migrationRootForCapture(capture, runId), `worktree-${capture.id}.index`);
  fs.mkdirSync(path.dirname(tempIndex), { recursive: true, mode: 0o700 });
  fs.rmSync(tempIndex, { force: true });
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    git(['--git-dir', capture.commonGitDir, 'read-tree', '--empty'], { env });

    // Construct the worktree tree directly from the verified byte inventory.
    // `git add` is forbidden here: repository-defined filters, autocrlf, or
    // fsmonitor commands could both execute host code and change the bytes
    // represented by the rescue commit. Preserve gitlinks from the raw index;
    // regular files and symlinks are hashed with --no-filters.
    const entries: Buffer[] = [];
    const inventoryPaths = new Set(capture.files.map((entry) => entry.path));
    for (const record of Buffer.from(capture.indexEntriesZBase64, 'base64').toString('utf8').split('\0')) {
      if (!record) continue;
      const match = /^(160000) ([a-f0-9]+) \d+\t([\s\S]+)$/.exec(record);
      if (!match || inventoryPaths.has(match[3])) continue;
      entries.push(Buffer.from(`${match[1]} ${match[2]}\t${match[3]}\0`));
    }
    for (const entry of capture.files) {
      const source = path.join(capture.checkoutPath, entry.path);
      const relative = path.relative(capture.checkoutPath, source);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe rescue path: ${entry.path}`);
      const bytes =
        entry.type === 'symlink' ? fs.readlinkSync(source, { encoding: 'buffer' }) : fs.readFileSync(source);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Error(`worktree changed after capture: ${capture.checkoutPath}/${entry.path}`);
      }
      const oid = git(['--git-dir', capture.commonGitDir, 'hash-object', '--no-filters', '-w', '--stdin'], {
        input: bytes,
      });
      const mode = entry.type === 'symlink' ? '120000' : entry.mode & 0o111 ? '100755' : '100644';
      entries.push(Buffer.from(`${mode} ${oid}\t${entry.path}\0`));
    }
    git(['--git-dir', capture.commonGitDir, 'update-index', '-z', '--index-info'], {
      env,
      input: Buffer.concat(entries),
    });
    const worktreeTree = git(['--git-dir', capture.commonGitDir, 'write-tree'], { env });
    const worktreeCommit = git(
      ['--git-dir', capture.commonGitDir, 'commit-tree', worktreeTree, ...(capture.head ? ['-p', capture.head] : [])],
      { input: `NanoClaw rescue worktree ${capture.id}\n` },
    );
    git(['--git-dir', capture.commonGitDir, 'update-ref', worktreeRef, worktreeCommit]);
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
}

function migrationRootForCapture(capture: CheckoutCapture, runId: string): string {
  return path.join(path.dirname(path.dirname(capture.checkoutPath)), '.nanoclaw-migration-temp', runId);
}

function stateFingerprint(capture: CheckoutCapture): string {
  return sha256(
    canonicalJson({
      head: capture.head,
      branch: capture.branch,
      indexSha256: capture.indexSha256,
      indexBytesBase64: capture.indexBytesBase64,
      indexMode: capture.indexMode,
      indexAuxiliaryFiles: capture.indexAuxiliaryFiles,
      indexEntriesZBase64: capture.indexEntriesZBase64,
      statusZBase64: capture.statusZBase64,
      files: capture.files,
      gitPointer: capture.gitPointer,
      recoveredMissingAdmin: capture.recoveredMissingAdmin,
      reviewedRecovery: capture.reviewedRecovery,
    }),
  );
}

function captureArchiveReason(capture: CheckoutCapture): CheckoutCapture['archivedLegacy'] | null {
  if (path.resolve(capture.checkoutPath).split(path.sep).includes('.rescues')) {
    return { reason: 'preexisting-rescue' };
  }
  if (capture.sourceRole === 'repository-staging' && capture.branch === null) return null;
  if (Buffer.from(capture.statusZBase64, 'base64').length !== 0 || !capture.head) return null;
  try {
    const containing = git([
      '--git-dir',
      capture.commonGitDir,
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      capture.head,
      'refs/remotes',
    ]);
    return containing ? { reason: 'clean-remote-contained' } : null;
  } catch {
    return null;
  }
}

function orderCapturesDeepestFirst(captures: readonly CheckoutCapture[]): CheckoutCapture[] {
  const depth = (checkoutPath: string): number => path.resolve(checkoutPath).split(path.sep).filter(Boolean).length;
  return [...captures].sort((left, right) => {
    const depthDifference = depth(right.checkoutPath) - depth(left.checkoutPath);
    if (depthDifference !== 0) return depthDifference;
    const pathDifference = path.resolve(left.checkoutPath).localeCompare(path.resolve(right.checkoutPath));
    return pathDifference || left.id.localeCompare(right.id);
  });
}

function deduplicateCaptures(captures: CheckoutCapture[]): CheckoutCapture[] {
  const selected = new Map<string, CheckoutCapture>();
  for (const capture of captures) {
    if (capture.archivedLegacy) continue;
    const key = `${capture.workUnit.key}\0${stateFingerprint(capture)}`;
    if (!selected.has(key)) selected.set(key, capture);
  }
  return [...selected.values()];
}

function importRescues(canonical: string, capture: CheckoutCapture): void {
  if (!capture.rescue) throw new Error(`capture ${capture.id} has no rescue refs`);
  for (const [kind, sourceRef] of Object.entries(capture.rescue)) {
    if (!sourceRef) continue;
    const oid = git(['--git-dir', capture.commonGitDir, 'rev-parse', '--verify', `${sourceRef}^{commit}`]);
    git(['-C', canonical, 'update-ref', `refs/nanoclaw-import/${capture.id}/${kind.replace(/Ref$/, '')}`, oid]);
  }
}

function importObjectStore(canonical: string, store: string): void {
  const id = sha256(fs.realpathSync(store)).slice(0, 20);
  const objectFormat = git(['--git-dir', store, 'rev-parse', '--show-object-format']);
  const looseRemainderLength = objectFormat === 'sha256' ? 62 : objectFormat === 'sha1' ? 38 : 0;
  if (looseRemainderLength === 0) throw new Error(`unsupported object format: ${objectFormat}`);
  const sourceObjects = path.join(store, 'objects');
  const destinationObjects = path.join(canonical, '.git', 'objects');
  const copyImmutableObjectFile = (source: string, relative: string): void => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`object store contains an unsafe object file: ${source}`);
    const destination = path.join(destinationObjects, relative);
    if (fs.existsSync(destination)) {
      const sourceBytes = fs.readFileSync(source);
      const destinationBytes = fs.readFileSync(destination);
      if (!sourceBytes.equals(destinationBytes)) throw new Error(`conflicting Git object-store file: ${relative}`);
      return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode & 0o7777);
  };
  for (const alternateName of ['alternates', 'http-alternates']) {
    const alternate = path.join(sourceObjects, 'info', alternateName);
    if (!fs.existsSync(alternate)) continue;
    const stat = fs.lstatSync(alternate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0) {
      throw new Error(`object store alternates are forbidden during migration: ${alternate}`);
    }
  }
  for (const name of fs.readdirSync(sourceObjects)) {
    const source = path.join(sourceObjects, name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`object store contains a symlink: ${source}`);
    if (/^[a-f0-9]{2}$/.test(name)) {
      if (!stat.isDirectory()) throw new Error(`loose object fanout is not a directory: ${source}`);
      for (const objectName of fs.readdirSync(source)) {
        if (!new RegExp(`^[a-f0-9]{${looseRemainderLength}}$`).test(objectName)) {
          throw new Error(`invalid loose object name: ${source}/${objectName}`);
        }
        copyImmutableObjectFile(path.join(source, objectName), path.join(name, objectName));
      }
      continue;
    }
    if (name === 'pack') {
      if (!stat.isDirectory()) throw new Error(`object pack path is not a directory: ${source}`);
      for (const packName of fs.readdirSync(source)) {
        if (packName.startsWith('multi-pack-index')) continue;
        if (!/^pack-[a-f0-9]+\.(?:pack|idx|rev|bitmap|promisor|mtimes)$/.test(packName)) {
          throw new Error(`unsupported object pack entry: ${source}/${packName}`);
        }
        copyImmutableObjectFile(path.join(source, packName), path.join('pack', packName));
      }
      continue;
    }
    if (name === 'info') continue; // commit-graph/packs metadata is regenerated from immutable objects.
    throw new Error(`unsupported object-store entry: ${source}`);
  }

  const refs = git(['--git-dir', store, 'for-each-ref', '--format=%(refname) %(objectname)']);
  for (const line of refs.split('\n').filter(Boolean)) {
    const separator = line.lastIndexOf(' ');
    if (separator < 1) throw new Error(`invalid imported Git ref record: ${line}`);
    const sourceRef = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (!sourceRef.startsWith('refs/')) throw new Error(`invalid imported Git ref: ${sourceRef}`);
    git(['-C', canonical, 'update-ref', `refs/nanoclaw-legacy/${id}/${sourceRef.slice('refs/'.length)}`, oid]);
  }
}

function restoreCheckout(canonical: string, capture: CheckoutCapture, migrationDirectory: string): void {
  if (!capture.rescue || !capture.destinationPath || !capture.assignedBranch) throw new Error('capture is unassigned');
  fs.mkdirSync(path.dirname(capture.destinationPath), { recursive: true, mode: 0o700 });
  const imported = (kind: string) => `refs/nanoclaw-import/${capture.id}/${kind}`;
  if (!capture.head) {
    git(['-C', canonical, 'worktree', 'add', '--orphan', '-b', capture.assignedBranch, capture.destinationPath]);
  } else if (!capture.branch) {
    git(['-C', canonical, 'worktree', 'add', '--detach', '--no-checkout', capture.destinationPath, imported('head')]);
  } else if (capture.assignedBranch === capture.branch) {
    if (gitBranchCheckedOut(canonical, capture.assignedBranch)) {
      throw new Error(`original branch is already checked out during restore: ${capture.assignedBranch}`);
    }
    // Imported legacy refs are intentionally namespaced. Materialize the
    // original user branch only when branch assignment proved it is uniquely
    // claimed, preserving existing PR continuity without letting the host
    // canonical itself own that branch.
    git(['-C', canonical, 'update-ref', `refs/heads/${capture.assignedBranch}`, capture.head]);
    git(['-C', canonical, 'worktree', 'add', '--no-checkout', capture.destinationPath, capture.assignedBranch]);
  } else {
    git([
      '-C',
      canonical,
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      capture.assignedBranch,
      capture.destinationPath,
      imported('head'),
    ]);
  }
  const destinationGitDir = fs.realpathSync(
    git(['-C', capture.destinationPath, 'rev-parse', '--path-format=absolute', '--git-dir']),
  );
  git(['--git-dir', destinationGitDir, 'read-tree', `${imported('index')}^{tree}`]);
  const tempIndex = path.join(migrationDirectory, `restore-${capture.id}.index`);
  fs.mkdirSync(path.dirname(tempIndex), { recursive: true, mode: 0o700 });
  fs.rmSync(tempIndex, { force: true });
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    git(['--git-dir', path.join(canonical, '.git'), 'read-tree', `${imported('worktree')}^{tree}`], { env });
    git(
      ['--git-dir', path.join(canonical, '.git'), '--work-tree', capture.destinationPath, 'checkout-index', '-a', '-f'],
      { env },
    );
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
  for (const entry of capture.files) {
    if (entry.type !== 'file') continue;
    const target = path.join(capture.destinationPath, entry.path);
    const relative = path.relative(capture.destinationPath, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe restored path: ${entry.path}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`restored file type mismatch: ${entry.path}`);
    fs.chmodSync(target, entry.mode);
  }
  for (const auxiliary of capture.indexAuxiliaryFiles) {
    if (!/^sharedindex\.[a-f0-9]+$/i.test(auxiliary.name)) throw new Error('unsafe captured shared index name');
    const bytes = Buffer.from(auxiliary.bytesBase64, 'base64');
    if (bytes.length !== auxiliary.size || sha256(bytes) !== auxiliary.sha256) {
      throw new Error(`captured shared index checksum mismatch: ${auxiliary.name}`);
    }
    atomicBytes(path.join(destinationGitDir, auxiliary.name), bytes, auxiliary.mode);
  }
  if (capture.indexBytesBase64 !== null) {
    if (capture.indexMode === null || capture.indexSha256 === null)
      throw new Error('captured raw index metadata is incomplete');
    const bytes = Buffer.from(capture.indexBytesBase64, 'base64');
    if (sha256(bytes) !== capture.indexSha256) throw new Error('captured raw index checksum mismatch');
    atomicBytes(path.join(destinationGitDir, 'index'), bytes, capture.indexMode);
  } else {
    fs.rmSync(path.join(destinationGitDir, 'index'), { force: true });
  }
  // Ensure HEAD stays at the original commit even when an existing branch ref
  // had moved after the manifest was captured.
  if (capture.head) git(['--git-dir', destinationGitDir, 'update-ref', 'HEAD', capture.head]);
}

function gitBranchCheckedOut(canonical: string, branch: string): boolean {
  const porcelain = git(['-C', canonical, 'worktree', 'list', '--porcelain']);
  return porcelain.split('\n').some((line) => line === `branch refs/heads/${branch}`);
}

function migrationBranchAssignments(captures: CheckoutCapture[], repo: string): Map<string, string> {
  const branchCounts = new Map<string, number>();
  for (const capture of captures) {
    if (capture.branch) branchCounts.set(capture.branch, (branchCounts.get(capture.branch) ?? 0) + 1);
  }
  const reservedOriginals = new Set([...branchCounts].filter(([, count]) => count === 1).map(([branch]) => branch));
  const used = new Set<string>();
  const assignments = new Map<string, string>();
  for (const capture of [...captures].sort(
    (a, b) => a.workUnit.key.localeCompare(b.workUnit.key) || a.id.localeCompare(b.id),
  )) {
    let assigned = capture.preservedLegacy
      ? `rescue/migrated-${repo.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}-${capture.id.slice(0, 12)}`
      : capture.branch && branchCounts.get(capture.branch) === 1
        ? capture.branch
        : defaultTopicBranch(capture.workUnit, repo);
    if (capture.preservedLegacy || capture.branch === null || branchCounts.get(capture.branch) !== 1) {
      const base = assigned;
      let suffix = 0;
      while (reservedOriginals.has(assigned) || used.has(assigned)) {
        suffix += 1;
        assigned = `${base}-migration-${capture.id.slice(0, 8)}${suffix === 1 ? '' : `-${suffix}`}`;
      }
    }
    if (used.has(assigned)) throw new Error(`migration branch assignment collision: ${assigned}`);
    used.add(assigned);
    assignments.set(capture.id, assigned);
  }
  return assignments;
}

function verifyCaptureAtDestination(capture: CheckoutCapture): void {
  if (!capture.destinationPath) throw new Error('capture has no destination');
  const recaptured = captureCheckout({
    workgroupId: capture.workgroupId,
    repo: capture.repo,
    checkoutPath: capture.destinationPath,
    workUnit: capture.workUnit,
  });
  if (recaptured.head !== capture.head) throw new Error(`HEAD mismatch for ${capture.id}`);
  const expectedBranch = capture.branch === null ? null : capture.assignedBranch;
  if (recaptured.branch !== expectedBranch) throw new Error(`branch/detached state mismatch for ${capture.id}`);
  if (recaptured.indexEntriesZBase64 !== capture.indexEntriesZBase64) {
    throw new Error(`index entries mismatch for ${capture.id}`);
  }
  if (
    recaptured.indexSha256 !== capture.indexSha256 ||
    recaptured.indexBytesBase64 !== capture.indexBytesBase64 ||
    recaptured.indexMode !== capture.indexMode
  ) {
    throw new Error(`raw index mismatch for ${capture.id}`);
  }
  if (canonicalJson(recaptured.indexAuxiliaryFiles) !== canonicalJson(capture.indexAuxiliaryFiles)) {
    throw new Error(`shared index files mismatch for ${capture.id}`);
  }
  if (recaptured.statusZBase64 !== capture.statusZBase64) throw new Error(`status mismatch for ${capture.id}`);
  if (canonicalJson(recaptured.files) !== canonicalJson(capture.files))
    throw new Error(`file manifest mismatch for ${capture.id}`);
}

function verifyRetainedCheckoutFiles(capture: CheckoutCapture): void {
  if (!capture.renamedOldPath || !fs.existsSync(capture.renamedOldPath)) {
    throw new Error(`retained legacy checkout is missing for ${capture.id}`);
  }
  if (capture.gitPointer) {
    const marker = path.join(capture.renamedOldPath, '.git');
    const stat = fs.lstatSync(marker);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== capture.gitPointer.mode) {
      throw new Error(`retained Git pointer type or mode changed for ${capture.id}`);
    }
    const bytes = fs.readFileSync(marker);
    if (bytes.length !== capture.gitPointer.size || sha256(bytes) !== capture.gitPointer.sha256) {
      throw new Error(`retained Git pointer bytes changed for ${capture.id}`);
    }
  }
  for (const entry of capture.files) {
    const absolute = path.join(capture.renamedOldPath, entry.path);
    const relative = path.relative(capture.renamedOldPath, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe retained path: ${entry.path}`);
    const stat = fs.lstatSync(absolute);
    if ((stat.mode & 0o7777) !== entry.mode) throw new Error(`retained mode changed for ${capture.id}:${entry.path}`);
    if (entry.type === 'file') {
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`retained file type changed for ${capture.id}:${entry.path}`);
      const bytes = fs.readFileSync(absolute);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Error(`retained file bytes changed for ${capture.id}:${entry.path}`);
      }
    } else {
      if (!stat.isSymbolicLink()) throw new Error(`retained symlink type changed for ${capture.id}:${entry.path}`);
      const target = fs.readlinkSync(absolute, { encoding: 'buffer' });
      if (target.length !== entry.size || sha256(target) !== entry.sha256) {
        throw new Error(`retained symlink target changed for ${capture.id}:${entry.path}`);
      }
    }
  }
}

function fsckRepositoryAllowingUnbornWorktrees(canonical: string): void {
  try {
    git(['-C', canonical, 'fsck', '--full'], { timeout: 300_000 });
  } catch (error) {
    const commandError = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    let output = `${commandError.stdout?.toString() ?? ''}\n${commandError.stderr?.toString() ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (output.length === 0) {
      output = commandError.message
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    if (
      output.length > 0 &&
      output.every(
        (line) => line.startsWith('notice: worktrees/') && line.includes('/HEAD points to an unborn branch ('),
      )
    ) {
      return;
    }
    if (
      /notice: worktrees\/[^/]+\/HEAD points to an unborn branch \(/.test(commandError.message) &&
      !/(?:^|\n)(?:fatal|error):/i.test(commandError.message)
    ) {
      return;
    }
    throw new Error(`git fsck --full failed for ${canonical}:\n${output.join('\n')}`, { cause: error });
  }
}

function canonicalWorktreePaths(canonical: string): Set<string> {
  const raw = gitRaw(['-C', canonical, 'worktree', 'list', '--porcelain', '-z']);
  const worktrees = new Set<string>();
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0) continue;
    const field = raw.subarray(start, index);
    start = index + 1;
    if (!field.subarray(0, 'worktree '.length).equals(Buffer.from('worktree '))) continue;
    const pathBytes = field.subarray('worktree '.length);
    const decoded = pathBytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(pathBytes) || !path.isAbsolute(decoded)) {
      throw new Error('canonical registered an invalid linked worktree path');
    }
    const resolved = path.resolve(decoded);
    if (worktrees.has(resolved)) throw new Error(`canonical registered a duplicate linked worktree: ${resolved}`);
    worktrees.add(resolved);
  }
  if (worktrees.size === 0) throw new Error('canonical did not enumerate its own working tree');
  return worktrees;
}

export function auditRepositoryMigration(manifest: RepositoryMigrationManifest): void {
  verifyRepositoryMigrationManifest(manifest);
  if (manifest.archiveOnly) {
    if (manifest.origin !== null || manifest.captures.some((capture) => !capture.archivedLegacy)) {
      throw new Error('archive-only manifest contains active repository state');
    }
    const activeCanonical = canonicalRepoDir(manifest.workgroupId, manifest.repo, manifest.dataDir);
    if (fs.existsSync(activeCanonical)) throw new Error('archive-only repository was published as an active canonical');
    if (readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir)) {
      throw new Error('archive-only repository unexpectedly has an active origin pin');
    }
  }
  const canonical = repositoryMigrationPath(manifest);
  if (!fs.lstatSync(path.join(canonical, '.git')).isDirectory()) throw new Error('canonical is not a normal clone');
  if (git(['-C', canonical, 'status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('canonical working tree is not clean');
  }
  if (git(['-C', canonical, 'rev-parse', '--verify', 'HEAD^{commit}']) !== manifest.canonicalBase.head) {
    throw new Error('canonical HEAD does not match the hash-bound manifest base');
  }
  let configuredOrigin: string | null = null;
  try {
    configuredOrigin = git(['-C', canonical, 'config', '--get', 'remote.origin.url']);
  } catch {
    // A local-only preservation canonical deliberately has no remote.
  }
  if (configuredOrigin !== manifest.origin) throw new Error('canonical origin does not match the migration manifest');
  if (git(['-C', canonical, 'config', '--get', 'gc.worktreePruneExpire']) !== 'never') {
    throw new Error('canonical does not disable automatic linked-worktree pruning');
  }
  if (!manifest.archiveOnly) {
    const pin = readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir);
    if (!pin || pin.origin !== manifest.origin || pin.repositoryId !== manifest.repositoryId) {
      throw new Error('canonical origin pin does not match the migration manifest');
    }
  }
  const expectedWorktrees = new Set<string>([
    path.resolve(canonical),
    ...deduplicateCaptures(manifest.captures).map((capture) => {
      if (!capture.destinationPath) throw new Error(`capture ${capture.id} has no planned destination`);
      return path.resolve(capture.destinationPath);
    }),
  ]);
  const registeredWorktrees = canonicalWorktreePaths(canonical);
  for (const registered of registeredWorktrees) {
    if (!expectedWorktrees.has(registered)) {
      throw new Error(`canonical registered an unexpected linked worktree: ${registered}`);
    }
  }
  for (const expected of expectedWorktrees) {
    if (!registeredWorktrees.has(expected)) {
      throw new Error(`canonical is missing an expected linked worktree: ${expected}`);
    }
  }
  const destinations = new Set<string>();
  const gitDirs = new Set<string>();
  for (const capture of manifest.captures) {
    verifyRetainedCheckoutFiles(capture);
    if (capture.archivedLegacy && capture.destinationPath) {
      throw new Error(`archived legacy checkout unexpectedly has an active destination: ${capture.id}`);
    }
    if (capture.preservedLegacy && capture.destinationPath) {
      const expectedRoot = path.join(manifest.dataDir, 'repository-rescues', manifest.workgroupId, manifest.repo);
      if (!pathContained(fs.realpathSync(capture.destinationPath), expectedRoot)) {
        throw new Error(`legacy canonical rescue escapes its host-only namespace: ${capture.destinationPath}`);
      }
      if (!capture.assignedBranch?.startsWith('rescue/migrated-')) {
        throw new Error(`legacy canonical rescue did not receive a dedicated rescue branch: ${capture.id}`);
      }
    }
  }
  for (const capture of deduplicateCaptures(manifest.captures)) {
    if (!capture.destinationPath) throw new Error(`capture ${capture.id} was not restored`);
    const destination = fs.realpathSync(capture.destinationPath);
    if (destinations.has(destination)) throw new Error('different captures share one destination path');
    destinations.add(destination);
    const pointer = fs.lstatSync(path.join(destination, '.git'));
    if (!pointer.isFile() || pointer.isSymbolicLink()) throw new Error('active topic checkout is not linked');
    const admin = fs.realpathSync(git(['-C', destination, 'rev-parse', '--path-format=absolute', '--git-dir']));
    if (gitDirs.has(admin)) throw new Error('different topic checkouts share one Git admin directory');
    gitDirs.add(admin);
    verifyCaptureAtDestination(capture);
  }
  fsckRepositoryAllowingUnbornWorktrees(canonical);
}

function migrationOwnerPath(repositoryPath: string): string {
  return path.join(repositoryPath, '.git', 'nanoclaw-migration-owner');
}

function writeMigrationOwner(repositoryPath: string, manifest: RepositoryMigrationManifest): void {
  atomicBytes(migrationOwnerPath(repositoryPath), Buffer.from(`${manifest.runId}\n`), 0o600);
}

function hasMigrationOwner(repositoryPath: string, manifest: RepositoryMigrationManifest): boolean {
  const marker = migrationOwnerPath(repositoryPath);
  try {
    const stat = fs.lstatSync(marker);
    return !stat.isSymbolicLink() && stat.isFile() && fs.readFileSync(marker, 'utf8') === `${manifest.runId}\n`;
  } catch {
    return false;
  }
}

function canonicalMatchesManifest(canonical: string, manifest: RepositoryMigrationManifest): boolean {
  try {
    if (git(['-C', canonical, 'status', '--porcelain=v1', '--untracked-files=all']) !== '') return false;
    if (git(['-C', canonical, 'rev-parse', '--verify', 'HEAD^{commit}']) !== manifest.canonicalBase.head) return false;
    let origin: string | null = null;
    try {
      origin = git(['-C', canonical, 'config', '--get', 'remote.origin.url']);
    } catch {
      // Local-only preservation canonicals deliberately have no remote.
    }
    return origin === manifest.origin;
  } catch {
    return false;
  }
}

async function executeRepositoryMigrationLocked(
  manifest: RepositoryMigrationManifest,
  options: {
    assertQuiescent: () => Promise<void> | void;
    refreshQuiescent?: () => Promise<void> | void;
  },
): Promise<RepositoryMigrationManifest> {
  // The outer preflight avoids taking the lock for an already-busy repo. This
  // second proof is load-bearing: it closes the writer race under the exact
  // lock immediately before the first durable migration mutation.
  await options.assertQuiescent();
  verifyRepositoryMigrationManifest(manifest);
  const root = migrationRoot(manifest);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicJson(manifestPath(manifest), manifest);
  const journal = readJournal(manifest);
  if (!journal.phases.includes('manifested')) recordPhase(manifest, journal, 'manifested');

  try {
    if (!journal.phases.includes('rescued')) {
      for (const capture of manifest.captures) createSyntheticCommit(capture, manifest.runId);
      recordPhase(manifest, journal, 'rescued');
    }

    const canonical = repositoryMigrationPath(manifest);
    const activeCanonical = canonicalRepoDir(manifest.workgroupId, manifest.repo, manifest.dataDir);
    const temp = `${canonical}.migration-${manifest.runId}`;
    if (!journal.phases.includes('canonical-target-clear')) {
      if (fs.existsSync(canonical)) throw new Error(`canonical destination already exists: ${canonical}`);
      if (manifest.archiveOnly && fs.existsSync(activeCanonical)) {
        throw new Error(`archive-only repository already has an active canonical: ${activeCanonical}`);
      }
      if (readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir)) {
        throw new Error(`canonical origin pin already exists for ${manifest.workgroupId}/${manifest.repo}`);
      }
      if (fs.existsSync(temp)) throw new Error(`canonical migration staging path already exists: ${temp}`);
      recordPhase(manifest, journal, 'canonical-target-clear');
    }
    if (!journal.phases.includes('canonical-published')) {
      if (fs.existsSync(canonical)) {
        if (!hasMigrationOwner(canonical, manifest) || !canonicalMatchesManifest(canonical, manifest)) {
          throw new Error(`canonical destination is not owned by this migration: ${canonical}`);
        }
      } else {
        // A crash while cloning can leave only this run-specific staging path.
        // It has never been agent-visible, so rebuilding it from the retained
        // source topology is safer than trying to resume a partial clone.
        if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(canonical), { recursive: true, mode: 0o700 });
        if (manifest.objectStores.length === 0) throw new Error('manifest has no canonical object source');
        fs.mkdirSync(temp, { recursive: false, mode: 0o700 });
        git(['-C', temp, 'init', '-q', `--object-format=${manifest.canonicalBase.objectFormat}`]);
        writeMigrationOwner(temp, manifest);
        if (manifest.origin !== null) git(['-C', temp, 'remote', 'add', 'origin', manifest.origin]);
        git(['-C', temp, 'config', 'core.hooksPath', '/dev/null']);
        git(['-C', temp, 'config', 'core.fsmonitor', 'false']);
        git(['-C', temp, 'config', 'gc.auto', '0']);
        git(['-C', temp, 'config', 'gc.worktreePruneExpire', 'never']);
        for (const store of manifest.objectStores) importObjectStore(temp, store);
        for (const capture of manifest.captures) importRescues(temp, capture);
        git([
          '-C',
          temp,
          'update-ref',
          `refs/remotes/origin/${manifest.canonicalBase.branch}`,
          manifest.canonicalBase.head,
        ]);
        git([
          '-C',
          temp,
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
          `refs/remotes/origin/${manifest.canonicalBase.branch}`,
        ]);
        git(['-C', temp, 'checkout', '-q', '--detach', manifest.canonicalBase.head]);
        if (git(['-C', temp, 'status', '--porcelain=v1', '--untracked-files=all']) !== '') {
          throw new Error('replacement canonical is not clean after local object import');
        }
        fs.renameSync(temp, canonical);
        fsyncDirectories(path.dirname(temp), path.dirname(canonical));
      }
      if (!manifest.archiveOnly) {
        writeOriginPin(
          manifest.workgroupId,
          manifest.repo,
          manifest.origin === null
            ? { kind: 'local-only', origin: null, repositoryId: manifest.repositoryId }
            : { origin: manifest.origin, repositoryId: manifest.repositoryId },
          manifest.dataDir,
        );
      }
      recordPhase(manifest, journal, 'canonical-published');
      fs.unlinkSync(migrationOwnerPath(canonical));
    } else if (hasMigrationOwner(canonical, manifest)) {
      fs.unlinkSync(migrationOwnerPath(canonical));
    }

    const bundle = path.join(root, `${manifest.repo}.rescue.bundle`);
    if (!journal.phases.includes('bundle-written')) {
      const bundleTemp = `${bundle}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        git(['-C', canonical, 'bundle', 'create', bundleTemp, '--all'], { timeout: 300_000 });
        if (!fs.statSync(bundleTemp).isFile() || fs.statSync(bundleTemp).size === 0)
          throw new Error('rescue bundle is empty');
        git(['bundle', 'verify', bundleTemp], { timeout: 300_000 });
        const bundleFd = fs.openSync(bundleTemp, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(bundleFd);
        } finally {
          fs.closeSync(bundleFd);
        }
        fs.renameSync(bundleTemp, bundle);
        fsyncDirectories(path.dirname(bundle));
      } finally {
        fs.rmSync(bundleTemp, { force: true });
      }
      journal.bundleSha256 = sha256File(bundle);
      recordPhase(manifest, journal, 'bundle-written');
    } else {
      if (!journal.bundleSha256 || !fs.existsSync(bundle) || fs.statSync(bundle).size === 0) {
        throw new Error('durable rescue bundle evidence is missing');
      }
      if (sha256File(bundle) !== journal.bundleSha256) throw new Error('durable rescue bundle checksum mismatch');
      git(['bundle', 'verify', bundle], { timeout: 300_000 });
    }

    const selected = deduplicateCaptures(manifest.captures);
    if (!journal.phases.includes('old-renamed')) {
      for (const capture of manifest.captures) {
        if (!capture.renamedOldPath) throw new Error(`capture ${capture.id} has no retained-source path`);
        fs.mkdirSync(path.dirname(capture.renamedOldPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(capture.checkoutPath) && !fs.existsSync(capture.renamedOldPath)) {
          fs.renameSync(capture.checkoutPath, capture.renamedOldPath);
          fsyncDirectories(path.dirname(capture.checkoutPath), path.dirname(capture.renamedOldPath));
        }
      }
      for (const [store, renamed] of Object.entries(manifest.renamedObjectStores ?? {})) {
        fs.mkdirSync(path.dirname(renamed), { recursive: true, mode: 0o700 });
        if (fs.existsSync(store) && !fs.existsSync(renamed)) {
          fs.renameSync(store, renamed);
          fsyncDirectories(path.dirname(store), path.dirname(renamed));
        }
      }
      atomicJson(manifestPath(manifest), manifest);
      recordPhase(manifest, journal, 'old-renamed');
    }

    if (!journal.phases.includes('worktrees-restored')) {
      for (const capture of selected) {
        if (!capture.destinationPath || !capture.assignedBranch) {
          throw new Error(`capture ${capture.id} has no hash-bound restoration plan`);
        }
        if (!fs.existsSync(capture.destinationPath)) restoreCheckout(canonical, capture, root);
        fsyncDirectories(path.dirname(capture.destinationPath), path.join(canonical, '.git', 'worktrees'));
      }
      atomicJson(manifestPath(manifest), manifest);
      recordPhase(manifest, journal, 'worktrees-restored');
    }

    auditRepositoryMigration(manifest);
    if (!journal.phases.includes('audited')) recordPhase(manifest, journal, 'audited');
    atomicJson(manifestPath(manifest), manifest);
    return manifest;
  } catch (error) {
    const proveCurrentTopologyQuiescent = options.refreshQuiescent ?? options.assertQuiescent;
    // A failure can leave newly created migration inodes that were absent from
    // the pre-mutation proof. Refresh and prove them quiet before rollback;
    // otherwise preserve the journaled topology for controlled recovery.
    await proveCurrentTopologyQuiescent();
    await rollbackRepositoryMigration(manifest);
    await proveCurrentTopologyQuiescent();
    throw error;
  }
}

export async function executeRepositoryMigration(
  manifest: RepositoryMigrationManifest,
  options: {
    assertQuiescent: () => Promise<void> | void;
    refreshQuiescent?: () => Promise<void> | void;
  },
): Promise<RepositoryMigrationManifest> {
  verifyRepositoryMigrationManifest(manifest);
  if (manifest.capacity.availableBytes < manifest.capacity.requiredBytes)
    throw new Error('capacity gate no longer passes');
  const statfs = fs.statfsSync(manifest.dataDir);
  const liveAvailableBytes = Number(statfs.bavail) * Number(statfs.bsize);
  if (liveAvailableBytes < manifest.capacity.requiredBytes) {
    throw new Error(
      `live capacity gate rejected before mutation: ${liveAvailableBytes} bytes available, ` +
        `${manifest.capacity.requiredBytes} bytes required`,
    );
  }
  await options.assertQuiescent();
  return withHostRepositoryLock(
    manifest.workgroupId,
    manifest.repo,
    () => executeRepositoryMigrationLocked(manifest, options),
    manifest.dataDir,
  );
}

export async function rollbackRepositoryMigration(manifest: RepositoryMigrationManifest): Promise<void> {
  verifyRepositoryMigrationManifest(manifest);
  let journal: MigrationJournal | null = null;
  try {
    journal = readJournal(manifest);
  } catch {
    // Without the ownership journal, rollback preserves every ambiguous path.
  }
  const canonical = repositoryMigrationPath(manifest);
  const canonicalOwned =
    fs.existsSync(canonical) &&
    (hasMigrationOwner(canonical, manifest) ||
      (journal?.phases.includes('canonical-published') === true && canonicalMatchesManifest(canonical, manifest)));
  if (canonicalOwned) {
    // Remove migration-owned replacements before restoring in-place legacy
    // paths. Otherwise an occupied checkoutPath causes restore to skip, then
    // removal strands the original under renamed-old.
    for (const capture of deduplicateCaptures(manifest.captures)) {
      if (!capture.destinationPath || !fs.existsSync(capture.destinationPath)) continue;
      try {
        git(['-C', canonical, 'worktree', 'remove', '--force', capture.destinationPath]);
      } catch {
        // Keep going so source topology is restored. Audit reports leftovers.
      }
    }
  }
  // Restore source paths only after replacement worktrees are gone. Existing
  // ambiguous paths are never overwritten.
  for (const capture of [...manifest.captures].reverse()) {
    if (capture.renamedOldPath && fs.existsSync(capture.renamedOldPath) && !fs.existsSync(capture.checkoutPath)) {
      fs.renameSync(capture.renamedOldPath, capture.checkoutPath);
      fsyncDirectories(path.dirname(capture.renamedOldPath), path.dirname(capture.checkoutPath));
    }
  }
  for (const [store, renamed] of Object.entries(manifest.renamedObjectStores ?? {}).reverse()) {
    if (fs.existsSync(renamed) && !fs.existsSync(store)) {
      fs.renameSync(renamed, store);
      fsyncDirectories(path.dirname(renamed), path.dirname(store));
    }
  }
  if (canonicalOwned) fs.rmSync(canonical, { recursive: true, force: true });
  const temp = `${canonical}.migration-${manifest.runId}`;
  if (journal?.phases.includes('canonical-target-clear') && fs.existsSync(temp)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (!manifest.archiveOnly && journal?.phases.includes('canonical-target-clear')) {
    const pinPath = originPinPath(manifest.workgroupId, manifest.repo, manifest.dataDir);
    const pin = readOriginPin(manifest.workgroupId, manifest.repo, manifest.dataDir);
    if (pin?.origin === manifest.origin && pin.repositoryId === manifest.repositoryId) {
      const stat = fs.lstatSync(pinPath);
      if (!stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(pinPath);
    }
  }
  if (journal) {
    journal.phases = journal.phases.filter((phase) => phase === 'manifested' || phase === 'rescued');
    journal.updatedAt = new Date().toISOString();
    atomicJson(journalPath(manifest), journal);
  }
}
