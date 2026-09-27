/**
 * Adopt a legacy workgroup-shared checkout as the host canonical (`data/repositories/<wg>/<repo>`). MOVES rather
 * than re-clones: local-only commits, unpushed branches and tags exist nowhere else. Dirty state is copied aside
 * first, never discarded.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { safeGitArgs, safeGitEnv } from './safe-git.js';
import {
  assertRepositoryName,
  assertWorkgroupId,
  canonicalRepoDir,
  readOriginPin,
  repositoriesRoot,
  withHostRepositoryLock,
  writeOriginPin,
} from './repository-workspaces.js';

export interface LegacyCheckout {
  repo: string;
  path: string;
  linked: boolean;
  origin: string | null;
  head: string;
  detached: boolean;
  localOnlyCommits: number;
  unpushedBranches: number;
  dirtyPaths: string[];
  reusable: boolean;
  reason?: string;
}

export interface RepositoryActivationPlan {
  workgroupId: string;
  legacyRoot: string;
  canonicalRoot: string;
  adopt: LegacyCheckout[];
  skip: LegacyCheckout[];
}

export interface RepositoryActivationResult {
  repo: string;
  canonicalPath: string;
  origin: string;
  preservedStatePath: string | null;
  preservedFileCount: number;
  prunedWorktrees: number;
  detachedAt: string;
  /** Paths still dirty after detaching. Non-empty blocks canonical refresh. */
  residue: string[];
}

function git(cwd: string, args: string[], timeout = 120_000): string {
  return execFileSync('git', safeGitArgs(['-C', cwd, ...args]), {
    encoding: 'utf8',
    env: safeGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
}

function tryGit(cwd: string, args: string[], timeout = 120_000): string | null {
  try {
    return git(cwd, args, timeout);
  } catch {
    return null;
  }
}

/** `-z` plumbing, not porcelain: porcelain quotes odd names and trimming corrupts its first path. */
function gitPaths(cwd: string, args: string[], timeout = 300_000): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', safeGitArgs(['-C', cwd, ...args]), {
      encoding: 'utf8',
      env: safeGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  } catch {
    return [];
  }
  return raw.split('\0').filter(Boolean);
}

/** State in `.git` that `reset --hard` would silently discard and preservation doesn't cover; adoption refuses. */
function inProgressOperation(cwd: string): string | null {
  const gitDir = tryGit(cwd, ['rev-parse', '--absolute-git-dir'], 30_000);
  if (!gitDir) return null;
  const markers: Array<[string, string]> = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase or am'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ];
  for (const [marker, label] of markers) {
    if (fs.existsSync(path.join(gitDir, marker))) return label;
  }
  // An unmerged index can outlive the marker files after a partial cleanup.
  if (gitPaths(cwd, ['ls-files', '--unmerged', '-z'], 120_000).length > 0) return 'an unresolved merge conflict';
  return null;
}

/**
 * Resolve `origin/HEAD` locally, never assuming `main`; topic worktrees and freshness require it. Only unambiguous
 * evidence is used (the branch's upstream, or a sole remote-tracking branch); anything else is left unset.
 */
function resolveOriginHead(cwd: string): string | null {
  const resolves = (ref: string): boolean =>
    tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 30_000) !== null;

  // An existing origin/HEAD can dangle, so verify before trusting it.
  const existing = tryGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 30_000);
  if (existing?.startsWith('refs/remotes/origin/') && resolves(existing)) return existing;

  const upstream = tryGit(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}'], 30_000);
  let candidate = upstream?.startsWith('refs/remotes/origin/') && resolves(upstream) ? upstream : null;
  if (!candidate) {
    const remotes = (tryGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], 60_000) ?? '')
      .split('\n')
      .filter((ref) => ref && ref !== 'refs/remotes/origin/HEAD' && resolves(ref));
    if (remotes.length === 1) candidate = remotes[0]!;
  }
  if (!candidate) return null;
  if (tryGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', candidate], 30_000) === null) return null;
  return candidate;
}

/**
 * `--assume-unchanged`/`--skip-worktree` paths: `git diff` hides their edits but `reset --hard` overwrites them,
 * so they are always preserved.
 */
function untrackedByStatPaths(cwd: string): string[] {
  return gitPaths(cwd, ['ls-files', '-v', '-z'], 300_000)
    .filter((entry) => entry.length > 2 && /[a-z]/.test(entry[0]!))
    .map((entry) => entry.slice(2));
}

function dirtyWorktreePaths(cwd: string): string[] {
  return [
    ...new Set([
      ...gitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
      ...gitPaths(cwd, ['diff', '--name-only', '-z']),
      ...gitPaths(cwd, ['diff', '--cached', '--name-only', '-z']),
      ...untrackedByStatPaths(cwd),
    ]),
  ].sort();
}

export function workgroupLegacyRoot(workgroupId: string, dataDir: string = DATA_DIR): string {
  assertWorkgroupId(workgroupId);
  return path.join(path.resolve(dataDir), 'workgroups', workgroupId);
}

/** The exact shape `writeOriginPin` accepts: HTTPS github.com, no credentials, no `.git`, no trailing slash. */
export function normalizeGitHubOrigin(origin: string): string | null {
  let candidate = origin.trim();
  if (!candidate) return null;
  const scp = /^git@github\.com:(.+)$/.exec(candidate);
  if (scp) candidate = `https://github.com/${scp[1]}`;
  if (candidate.startsWith('ssh://git@github.com/')) {
    candidate = `https://github.com/${candidate.slice('ssh://git@github.com/'.length)}`;
  }
  if (!URL.canParse(candidate)) return null;
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  parsed.pathname = parsed.pathname.replace(/\.git\/?$/i, '');
  return parsed.toString().replace(/\/+$/, '');
}

function classify(repo: string, checkoutPath: string): LegacyCheckout {
  const linked = fs.lstatSync(path.join(checkoutPath, '.git')).isFile();
  const base: LegacyCheckout = {
    repo,
    path: checkoutPath,
    linked,
    origin: null,
    head: '',
    detached: false,
    localOnlyCommits: 0,
    unpushedBranches: 0,
    dirtyPaths: [],
    reusable: false,
  };

  if (linked) return { ...base, reason: 'linked worktree of another checkout; recreated per topic on demand' };
  if (tryGit(checkoutPath, ['rev-parse', '--git-dir'], 30_000) === null) {
    return { ...base, reason: 'not readable as a git repository from the host' };
  }

  const rawOrigin = tryGit(checkoutPath, ['config', '--get', 'remote.origin.url'], 30_000);
  const origin = rawOrigin ? normalizeGitHubOrigin(rawOrigin) : null;
  const branch = tryGit(checkoutPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 30_000);
  const detached = branch === null;
  const head = branch ?? tryGit(checkoutPath, ['rev-parse', 'HEAD'], 30_000) ?? '';
  const localOnlyCommits = Number(
    tryGit(checkoutPath, ['rev-list', '--count', '--all', '--not', '--remotes'], 300_000) ?? '0',
  );

  let unpushedBranches = 0;
  for (const tip of (tryGit(checkoutPath, ['for-each-ref', '--format=%(objectname)', 'refs/heads'], 60_000) ?? '')
    .split('\n')
    .filter(Boolean)) {
    if (!tryGit(checkoutPath, ['branch', '-r', '--contains', tip], 60_000)) unpushedBranches += 1;
  }

  const dirtyPaths = dirtyWorktreePaths(checkoutPath);

  const detail = { ...base, origin, head, detached, localOnlyCommits, unpushedBranches, dirtyPaths };
  if (!rawOrigin) return { ...detail, reason: 'no origin remote; publish it deliberately before adopting' };
  if (!origin) return { ...detail, reason: `origin is not an HTTPS github.com URL: ${rawOrigin}` };
  const inProgress = inProgressOperation(checkoutPath);
  if (inProgress) {
    return { ...detail, reason: `${inProgress} is in progress; finish or abort it before adopting this checkout` };
  }
  return { ...detail, reusable: true };
}

/** One canonical per origin; duplicate clones are skipped and recreated as topic worktrees on demand. */
export function planRepositoryActivation(workgroupId: string, dataDir: string = DATA_DIR): RepositoryActivationPlan {
  const legacyRoot = workgroupLegacyRoot(workgroupId, dataDir);
  const plan: RepositoryActivationPlan = {
    workgroupId,
    legacyRoot,
    canonicalRoot: path.join(repositoriesRoot(dataDir), workgroupId),
    adopt: [],
    skip: [],
  };
  if (!fs.existsSync(legacyRoot)) return plan;

  const candidates: LegacyCheckout[] = [];
  for (const entry of fs
    .readdirSync(legacyRoot, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const checkoutPath = path.join(legacyRoot, entry.name);
    if (!fs.existsSync(path.join(checkoutPath, '.git'))) continue;
    try {
      assertRepositoryName(entry.name);
    } catch {
      continue;
    }
    candidates.push(classify(entry.name, checkoutPath));
  }

  const byOrigin = new Map<string, LegacyCheckout[]>();
  for (const candidate of candidates) {
    if (!candidate.reusable || !candidate.origin) {
      plan.skip.push(candidate);
      continue;
    }
    const bucket = byOrigin.get(candidate.origin) ?? [];
    bucket.push(candidate);
    byOrigin.set(candidate.origin, bucket);
  }

  for (const [origin, bucket] of byOrigin) {
    const remoteName = origin.split('/').at(-1) ?? '';
    // Named after the remote, else the most irreplaceable state.
    const chosen =
      bucket.find((candidate) => candidate.repo === remoteName) ??
      [...bucket].sort(
        (a, b) =>
          b.unpushedBranches - a.unpushedBranches ||
          b.localOnlyCommits - a.localOnlyCommits ||
          a.repo.localeCompare(b.repo),
      )[0]!;
    plan.adopt.push(chosen);
    for (const other of bucket) {
      if (other === chosen) continue;
      plan.skip.push({
        ...other,
        reusable: false,
        reason:
          other.unpushedBranches > 0 || other.localOnlyCommits > 0
            ? `duplicate clone of ${origin}; canonical is ${chosen.repo} — local state listed above must be pushed or adopted manually`
            : `duplicate clone of ${origin}; canonical is ${chosen.repo}`,
      });
    }
  }
  plan.adopt.sort((a, b) => a.repo.localeCompare(b.repo));
  plan.skip.sort((a, b) => a.repo.localeCompare(b.repo));
  return plan;
}

function fsyncDir(target: string): void {
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function preserveDirtyState(checkout: LegacyCheckout, destination: string): number {
  let copied = 0;
  // A deletion has no bytes to copy but `reset --hard` resurrects it, so the manifest records it.
  const reverted: string[] = [];
  for (const relative of checkout.dirtyPaths) {
    const source = path.join(checkout.path, relative);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch {
      reverted.push(relative);
      continue;
    }
    const target = path.join(destination, relative);
    if (!path.resolve(target).startsWith(`${path.resolve(destination)}${path.sep}`)) {
      throw new Error(`refusing to preserve a path escaping the snapshot root: ${relative}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (stat.isDirectory()) {
      fs.cpSync(source, target, { recursive: true, dereference: false });
    } else {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode & 0o777);
    }
    copied += 1;
  }

  fs.writeFileSync(
    path.join(destination, 'MANIFEST.json'),
    `${JSON.stringify(
      {
        version: 1,
        repo: checkout.repo,
        sourcePath: checkout.path,
        head: checkout.head,
        detached: checkout.detached,
        copied: checkout.dirtyPaths.filter((entry) => !reverted.includes(entry)),
        revertedDeletions: reverted,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return copied;
}

/** The caller owns quiescence: every workgroup container must be stopped and fenced (this moves a mounted dir). */
export async function activateCanonicalRepository(input: {
  workgroupId: string;
  checkout: LegacyCheckout;
  dataDir?: string;
}): Promise<RepositoryActivationResult> {
  const dataDir = input.dataDir ?? DATA_DIR;
  const { workgroupId, checkout } = input;
  if (!checkout.reusable || !checkout.origin) {
    throw new Error(`checkout is not adoptable: ${checkout.path}${checkout.reason ? ` (${checkout.reason})` : ''}`);
  }
  const canonical = canonicalRepoDir(workgroupId, checkout.repo, dataDir);
  const origin = checkout.origin;

  return withHostRepositoryLock(
    workgroupId,
    checkout.repo,
    async () => {
      const existingPin = readOriginPin(workgroupId, checkout.repo, dataDir);
      if (existingPin && (existingPin.kind === 'local-only' || existingPin.origin !== origin)) {
        throw new Error(`origin pin conflict for ${workgroupId}/${checkout.repo}`);
      }
      if (fs.existsSync(canonical)) {
        // A replay after a crash post-rename recognizes its own completed move, but only when provably so.
        const sameOrigin = normalizeGitHubOrigin(
          tryGit(canonical, ['config', '--get', 'remote.origin.url'], 30_000) ?? '',
        );
        if (existingPin && sameOrigin === origin && !fs.existsSync(checkout.path)) {
          return {
            repo: checkout.repo,
            canonicalPath: canonical,
            origin,
            preservedStatePath: null,
            preservedFileCount: 0,
            prunedWorktrees: 0,
            detachedAt: git(canonical, ['rev-parse', 'HEAD'], 30_000),
            residue: dirtyWorktreePaths(canonical),
          };
        }
        throw new Error(`canonical already exists and was left untouched: ${canonical}`);
      }

      let preservedStatePath: string | null = null;
      let preservedFileCount = 0;
      if (checkout.dirtyPaths.length > 0) {
        preservedStatePath = path.join(
          path.resolve(dataDir),
          'repository-rescues',
          workgroupId,
          checkout.repo,
          `pre-canonical-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        );
        fs.mkdirSync(preservedStatePath, { recursive: true, mode: 0o700 });
        preservedFileCount = preserveDirtyState(checkout, preservedStatePath);
        fsyncDir(preservedStatePath);
      }

      // Container-absolute worktree records would keep branches reserved against the new topic worktrees.
      const before = (tryGit(checkout.path, ['worktree', 'list', '--porcelain'], 60_000) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;
      tryGit(checkout.path, ['worktree', 'prune', '--expire', 'now'], 120_000);
      const after = (tryGit(checkout.path, ['worktree', 'list', '--porcelain'], 60_000) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;

      const remoteHead = resolveOriginHead(checkout.path);
      if (!remoteHead) {
        log.warn('Canonical has no resolvable origin/HEAD; fresh topic worktrees will refuse', {
          workgroupId,
          repo: checkout.repo,
        });
      }
      // Detach onto an object id: a full ref path is ambiguous with a pathspec.
      const target = git(checkout.path, ['rev-parse', '--verify', `${remoteHead ?? 'HEAD'}^{commit}`], 30_000);
      if (checkout.dirtyPaths.length > 0) {
        // No `-x`: an ignored `.env` exists nowhere else and isn't preserved. Single `-f` spares nested repos.
        git(checkout.path, ['reset', '--hard', '--quiet'], 300_000);
        git(checkout.path, ['clean', '-qfd'], 300_000);
      }
      git(checkout.path, ['checkout', '-q', '--detach', target], 300_000);
      const detachedAt = git(checkout.path, ['rev-parse', 'HEAD'], 30_000);

      // Different ignore rules at the target can leave files visible; reported, not thrown, since it blocks refresh.
      const residue = dirtyWorktreePaths(checkout.path);
      if (residue.length > 0) {
        log.warn('Canonical is not clean after detaching; canonical refresh will refuse until resolved', {
          workgroupId,
          repo: checkout.repo,
          residue: residue.slice(0, 20),
          residueCount: residue.length,
        });
      }

      // Automatic GC must never run while linked worktrees hold refs.
      git(checkout.path, ['config', 'gc.auto', '0'], 30_000);
      git(checkout.path, ['config', 'gc.worktreePruneExpire', 'never'], 30_000);

      // Pin first: a pin without a canonical reconciles; a canonical without a pin refuses every spawn.
      writeOriginPin(workgroupId, checkout.repo, { origin, repositoryId: origin }, dataDir);
      fs.mkdirSync(path.dirname(canonical), { recursive: true, mode: 0o700 });
      fs.renameSync(checkout.path, canonical);
      fsyncDir(path.dirname(canonical));
      fsyncDir(path.dirname(checkout.path));

      log.info('Adopted workgroup canonical repository', {
        workgroupId,
        repo: checkout.repo,
        from: checkout.path,
        to: canonical,
        preservedStatePath,
        preservedFileCount,
        prunedWorktrees: Math.max(0, before - after),
      });

      return {
        repo: checkout.repo,
        canonicalPath: canonical,
        origin,
        preservedStatePath,
        preservedFileCount,
        prunedWorktrees: Math.max(0, before - after),
        detachedAt,
        residue,
      };
    },
    dataDir,
  );
}

export async function rollbackCanonicalRepository(input: {
  workgroupId: string;
  repo: string;
  dataDir?: string;
}): Promise<{ repo: string; restoredPath: string }> {
  const dataDir = input.dataDir ?? DATA_DIR;
  const canonical = canonicalRepoDir(input.workgroupId, input.repo, dataDir);
  const legacy = path.join(workgroupLegacyRoot(input.workgroupId, dataDir), input.repo);

  return withHostRepositoryLock(
    input.workgroupId,
    input.repo,
    async () => {
      if (!fs.existsSync(canonical)) throw new Error(`no canonical to roll back: ${canonical}`);
      if (fs.existsSync(legacy)) throw new Error(`legacy path is occupied and was left untouched: ${legacy}`);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.renameSync(canonical, legacy);
      fsyncDir(path.dirname(legacy));
      fsyncDir(path.dirname(canonical));
      try {
        fs.unlinkSync(
          path.join(path.resolve(dataDir), 'repository-state', input.workgroupId, input.repo, 'origin.json'),
        );
      } catch {
        // An absent pin is already the rolled-back state.
      }
      log.info('Rolled back workgroup canonical repository', { workgroupId: input.workgroupId, repo: input.repo });
      return { repo: input.repo, restoredPath: legacy };
    },
    dataDir,
  );
}
