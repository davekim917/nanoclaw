/**
 * Adopt an existing workgroup-shared repository checkout as the host canonical.
 *
 * The corrected topology (one canonical clone per workgroup/repository, one
 * linked worktree per topic) is already implemented in repository-workspaces.ts
 * and mounted by container-runner.ts. What is missing on an install that grew
 * up on the shared filesystem is the canonical itself: the real clones still
 * live under `data/workgroups/<wg>/<repo>`, agent-writable, one duplicate full
 * clone per work item.
 *
 * This module moves such a clone into `data/repositories/<wg>/<repo>` and pins
 * its origin. It deliberately MOVES rather than re-clones: local-only commits,
 * unpushed branches, and tags exist nowhere else, and a fresh clone from the
 * remote would silently drop them.
 *
 * A canonical must be clean, so any dirty or untracked working state is copied
 * aside first — never discarded — and reported by path.
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
  /** A linked worktree is owned by another checkout and is never a canonical. */
  linked: boolean;
  origin: string | null;
  head: string;
  detached: boolean;
  /** Commits reachable from a local ref but from no remote-tracking ref. */
  localOnlyCommits: number;
  /** Local branch tips contained in no remote-tracking branch. */
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
  /** Paths still dirty after detaching. Non-empty blocks Graphify refresh. */
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

/**
 * Collect paths from a NUL-separated plumbing command.
 *
 * Porcelain status is deliberately avoided here: its two-column prefix makes a
 * leading space significant, so any trimming corrupts the first path, and
 * unusual filenames get quoted. `-z` plumbing emits raw paths verbatim.
 */
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

/**
 * Name any half-finished Git operation holding state in `.git` rather than in
 * the working tree.
 *
 * `git reset --hard` silently discards all of it — conflict resolutions, the
 * remaining pick list of a rebase, a cherry-pick in flight — and none of it is
 * covered by the working-tree preservation pass. Adoption refuses instead.
 */
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
 * Resolve `origin/HEAD` locally, without network and without assuming `main`.
 *
 * A checkout made by `git init` + `git remote add` never gets an origin/HEAD,
 * and both create_worktree and refreshCanonicalFromLocalRefs hard-require it —
 * so a canonical adopted without one mounts fine but can never seed a fresh
 * topic worktree or report Graphify freshness. Only unambiguous evidence
 * already in the repository is used: the configured upstream of the current
 * branch, or a sole remote-tracking branch. Anything ambiguous is left unset
 * for an operator to resolve deliberately.
 */
function resolveOriginHead(cwd: string): string | null {
  const resolves = (ref: string): boolean =>
    tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 30_000) !== null;

  // An existing origin/HEAD can dangle — `git update-ref -d refs/remotes/origin/HEAD`
  // deletes the branch it points at, not the symref — so verify before trusting it.
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

/** Every worktree path carrying state that a fresh clone would not reproduce. */
function dirtyWorktreePaths(cwd: string): string[] {
  return [
    ...new Set([
      ...gitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
      ...gitPaths(cwd, ['diff', '--name-only', '-z']),
      ...gitPaths(cwd, ['diff', '--cached', '--name-only', '-z']),
    ]),
  ].sort();
}

export function workgroupLegacyRoot(workgroupId: string, dataDir: string = DATA_DIR): string {
  assertWorkgroupId(workgroupId);
  return path.join(path.resolve(dataDir), 'workgroups', workgroupId);
}

/**
 * Normalize a remote URL to the exact shape `writeOriginPin` accepts: HTTPS
 * github.com, no credentials, no `.git` suffix, no trailing slash.
 */
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

/**
 * Choose one canonical per repository identity. Duplicate clones of the same
 * origin are the exact disease this replaces, so only the checkout whose
 * directory name matches the remote repository name is adopted; the rest are
 * disposable and recreated as topic worktrees on demand.
 */
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
    // Prefer the checkout named exactly after the remote; otherwise the one
    // carrying the most irreplaceable state, then the longest history.
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

/**
 * Copy dirty and untracked files out of a checkout before it becomes a clean
 * canonical. Paths are reproduced verbatim so the snapshot can be replayed with
 * a plain copy back into whichever topic worktree wants them.
 */
function preserveDirtyState(checkout: LegacyCheckout, destination: string): number {
  let copied = 0;
  // A tracked-but-deleted path has no bytes to copy, yet `reset --hard` will
  // resurrect the file and the deletion is a real change. Record it so the
  // manifest, not the operator's memory, is the account of what was reverted.
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
        // Restored by `reset --hard`; listed here because the deletion itself
        // was a change and nothing else records it.
        revertedDeletions: reverted,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return copied;
}

/**
 * Adopt one legacy checkout as the workgroup canonical.
 *
 * The caller owns quiescence: every container in the workgroup must already be
 * stopped and fenced, because this moves a directory out from under the
 * `/workspace/workgroup` bind mount.
 */
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
        // A crash between the rename and this function returning leaves the
        // move already done. Replaying must recognize its own completed work
        // instead of reporting a conflict during an incident — but only when
        // the canonical really is this repository and the source is gone.
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

      // 1. Preserve irreplaceable working state before anything is reset.
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

      // 2. Drop worktree records that point at container-absolute gitdirs. They
      //    are unreadable from the host and would keep branches reserved
      //    against the topic worktrees that replace them.
      const before = (tryGit(checkout.path, ['worktree', 'list', '--porcelain'], 60_000) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;
      tryGit(checkout.path, ['worktree', 'prune', '--expire', 'now'], 120_000);
      const after = (tryGit(checkout.path, ['worktree', 'list', '--porcelain'], 60_000) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;

      // 3. Detach at the fetched remote default. origin/HEAD is authoritative;
      //    `main` is never assumed. Local branches are left untouched so a
      //    topic worktree can still check them out.
      const remoteHead = resolveOriginHead(checkout.path);
      if (!remoteHead) {
        log.warn('Canonical has no resolvable origin/HEAD; fresh topic worktrees and Graphify refresh will refuse', {
          workgroupId,
          repo: checkout.repo,
        });
      }
      // Always detach onto a resolved object id. A full ref path is ambiguous
      // with a pathspec and `checkout --detach refs/remotes/origin/x` is
      // rejected outright when the ref does not also resolve as a rev.
      const target = git(checkout.path, ['rev-parse', '--verify', `${remoteHead ?? 'HEAD'}^{commit}`], 30_000);
      if (checkout.dirtyPaths.length > 0) {
        // Preserved above; the canonical must present a clean tree.
        //
        // Deliberately no `-x`. Ignored files are not migration inputs, but
        // they are also not all regenerable — a gitignored `.env` or
        // profiles.yml exists nowhere else and is not covered by the
        // preservation pass, which only walks non-ignored dirty paths. Leaving
        // them in place moves them with the repository and still leaves a
        // clean `git status`. Single `-f` likewise protects nested Git
        // directories from being removed wholesale.
        git(checkout.path, ['reset', '--hard', '--quiet'], 300_000);
        git(checkout.path, ['clean', '-qfd'], 300_000);
      }
      git(checkout.path, ['checkout', '-q', '--detach', target], 300_000);
      const detachedAt = git(checkout.path, ['rev-parse', 'HEAD'], 30_000);

      // The detach target can carry different ignore rules than the branch that
      // was checked out, which can leave previously-ignored files visible. That
      // does not endanger any data, but it does block
      // refreshCanonicalFromLocalRefs (and therefore Graphify freshness), so it
      // is reported rather than silently accepted. Throwing here would be worse
      // than reporting: the state is already preserved and the move is next.
      const residue = dirtyWorktreePaths(checkout.path);
      if (residue.length > 0) {
        log.warn('Canonical is not clean after detaching; Graphify refresh will refuse until resolved', {
          workgroupId,
          repo: checkout.repo,
          residue: residue.slice(0, 20),
          residueCount: residue.length,
        });
      }

      // 4. Automatic GC must never run while linked worktrees hold refs.
      git(checkout.path, ['config', 'gc.auto', '0'], 30_000);
      git(checkout.path, ['config', 'gc.worktreePruneExpire', 'never'], 30_000);

      // 5. Publish. Pin first: a crash between pin and rename leaves a pin with
      //    no canonical, which the next run reconciles, whereas a canonical
      //    with no pin refuses every spawn in the workgroup.
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

/** Reverse one adoption: move the canonical back and drop its pin. */
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
