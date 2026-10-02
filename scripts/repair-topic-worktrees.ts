/**
 * One-off repair for topic checkouts whose linked-worktree registration is broken: the admin dir their `.git` names
 * is missing, names a container-only path, or belongs to another checkout (its `gitdir` back-pointer names someone
 * else). Dry-run unless `--apply`.
 *
 * Per broken checkout, on an idle topic only: snapshot the working tree (untracked, non-ignored files included) as a
 * commit under `refs/nanoclaw/rescue/1388/`, then give the checkout its own admin dir whose HEAD is the commit with
 * that exact tree (or the rescue commit when none exists) and whose index is that tree. Working-tree files are never
 * written; only the checkout's `.git` pointer file changes. Nothing is ever deleted.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { gitCommonDirIs } from '../src/canonical-git-commondir.js';
import { DATA_DIR } from '../src/config.js';
import { runningContainerMounts } from '../src/container-mounts.js';
import { getDb, initDb } from '../src/db/connection.js';
import { readSessionOutbound, sessionMailboxPath } from '../src/modules/mailbox/index.js';
import {
  listTopicCheckouts,
  parseCheckoutDirName,
  repositoriesRoot,
  resolveRepositoryWorkUnit,
  topicStateDir,
  topicsRoot,
  withHostRepositoryLock,
  withRepositoryLifecycleClaims,
  type RepositoryWorkUnit,
} from '../src/repository-workspaces.js';
import { safeGitArgs, safeGitEnv, safeGitFilterNames } from '../src/safe-git.js';

export const RESCUE_REF_PREFIX = 'refs/nanoclaw/rescue/1388';
const LOCK_REASON = 'nanoclaw: repaired checkout whose HEAD is its rescue snapshot';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'nanoclaw repair',
  GIT_AUTHOR_EMAIL: 'nanoclaw-repair@localhost',
  GIT_COMMITTER_NAME: 'nanoclaw repair',
  GIT_COMMITTER_EMAIL: 'nanoclaw-repair@localhost',
};

type PointerState =
  | 'healthy'
  | 'foreign-backpointer'
  | 'admin-missing'
  | 'container-path'
  | 'foreign-common'
  | 'unreadable';
type MatchClass = 'origin' | 'local-ref' | 'unreachable' | 'no-match';
type RepairAction = 'none' | 'planned' | 'repaired' | 'skipped' | 'failed';

export interface RepairEntry {
  topic: string;
  checkout: string;
  path: string;
  state: PointerState;
  previousGitdir: string;
  sharedWith: number;
  action: RepairAction;
  reason?: string;
  canonical?: string;
  canonicalSource?: 'pointer' | 'name' | 'content';
  tree?: string;
  match?: MatchClass;
  matchedCommit?: string | null;
  head?: string;
  locked?: boolean;
  rescueRef?: string;
  /** Per canonical, the share of the checkout's blobs it holds; recorded when that evidence named no single canonical. */
  contentShares?: Record<string, number>;
  /** Nested repositories recorded as gitlinks: their own uncommitted content is not in the snapshot. */
  embeddedRepos?: number;
  proof?: {
    rescueCommit: string;
    adminDir: string;
    treeBefore: string;
    treeAfter: string;
    head: string;
    statusClean: boolean;
    steps: string[];
  };
}

export interface RepairReport {
  mode: 'dry-run' | 'apply';
  dataDir: string;
  startedAt: string;
  finishedAt: string;
  linkedCheckouts: number;
  healthy: number;
  entries: RepairEntry[];
  summary: Record<string, Record<string, number>>;
}

interface TopicParticipant {
  sessionId: string;
  agentGroupId: string;
  status: string;
}

/** Every probe the idle gate asks; `null` from any of them means "cannot tell", which refuses. */
export interface LivenessProbes {
  participants(topicDir: string): TopicParticipant[] | null;
  participantBusy(participant: TopicParticipant): boolean;
  mounts(): string[] | null;
  cwds(): string[] | null;
}

export interface RepairOptions {
  dataDir: string;
  apply: boolean;
  probes: LivenessProbes;
  topics?: readonly string[];
  scratchDir?: string;
  onEntry?: (entry: RepairEntry) => void;
}

class GitError extends Error {}

function git(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; filters?: string[] }) {
  try {
    return execFileSync('git', safeGitArgs(args, undefined, options.filters ?? []), {
      cwd: options.cwd ?? '/',
      env: safeGitEnv(options.env ?? {}),
      encoding: 'utf8',
      input: options.input,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 600_000,
      maxBuffer: 512 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new GitError(`git ${args.slice(0, 4).join(' ')} failed: ${stderr || (error as Error).message}`);
  }
}

function gitOrNull(args: string[], options: Parameters<typeof git>[1]): string | null {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

interface PointerInspection {
  state: PointerState;
  previousGitdir: string;
  adminDir: string | null;
}

/** File-only: reads the `.git` pointer, the admin dir's back-pointer, and where the admin dir lives. */
function inspectPointer(checkoutPath: string, workgroupId: string, dataDir: string): PointerInspection {
  const pointer = fs.readFileSync(path.join(checkoutPath, '.git'), 'utf8');
  const match = /^gitdir: (.+?)\s*$/.exec(pointer);
  if (!match) throw new Error(`unparseable .git pointer: ${checkoutPath}`);
  const previousGitdir = match[1];
  const target = path.resolve(checkoutPath, previousGitdir);
  const adminDir = realpathOrNull(target);
  if (adminDir === null) {
    return {
      state: previousGitdir.startsWith('/workspace/') ? 'container-path' : 'admin-missing',
      previousGitdir,
      adminDir: null,
    };
  }
  const workgroupRepos = path.join(fs.realpathSync(repositoriesRoot(dataDir)), workgroupId);
  const canonicalGit = path.dirname(path.dirname(adminDir));
  if (
    path.basename(path.dirname(adminDir)) !== 'worktrees' ||
    path.basename(canonicalGit) !== '.git' ||
    path.dirname(path.dirname(canonicalGit)) !== workgroupRepos ||
    !gitCommonDirIs(adminDir, canonicalGit)
  ) {
    return { state: 'foreign-common', previousGitdir, adminDir };
  }
  let back: string | null = null;
  try {
    back = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim();
  } catch {
    // An admin dir without a back-pointer belongs to no checkout.
  }
  const self = path.join(fs.realpathSync(checkoutPath), '.git');
  const backResolved = back === null ? null : (realpathOrNull(back) ?? path.resolve(back));
  return { state: backResolved === self ? 'healthy' : 'foreign-backpointer', previousGitdir, adminDir };
}

function canonicalGitDir(dataDir: string, workgroupId: string, repo: string): string | null {
  const gitDir = path.join(repositoriesRoot(dataDir), workgroupId, repo, '.git');
  try {
    return fs.lstatSync(gitDir).isDirectory() ? fs.realpathSync(gitDir) : null;
  } catch {
    return null;
  }
}

function workgroupCanonicals(dataDir: string, workgroupId: string): Array<{ repo: string; gitDir: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(repositoriesRoot(dataDir), workgroupId)).sort();
  } catch {
    return [];
  }
  return names.flatMap((repo) => {
    const gitDir = canonicalGitDir(dataDir, workgroupId, repo);
    return gitDir ? [{ repo, gitDir }] : [];
  });
}

interface HashTarget {
  gitDir: string;
  workTree: string;
  /** Scratch object store for a hash that must not write into `gitDir`; `alternates` supply existing objects. */
  scratchObjects?: { dir: string; alternates: string[] };
}

/** The root tree of every non-ignored file in the working tree, built in a throwaway index. */
function hashWorkTree(target: HashTarget, scratchDir: string): { tree: string; gitlinks: number } {
  const indexDir = fs.mkdtempSync(path.join(scratchDir, 'index-'));
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: path.join(indexDir, 'index') };
  if (target.scratchObjects) {
    env.GIT_OBJECT_DIRECTORY = target.scratchObjects.dir;
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = target.scratchObjects.alternates.join(':');
  }
  const filters = safeGitFilterNames(target.gitDir);
  const base = ['--git-dir', target.gitDir, '--work-tree', target.workTree, '-c', 'advice.addEmbeddedRepo=false'];
  try {
    git([...base, 'add', '-A', '--', '.'], { cwd: target.workTree, env, filters });
    const tree = git([...base, 'write-tree'], { cwd: target.workTree, env, filters });
    const stages = git([...base, 'ls-files', '-s'], { cwd: target.workTree, env });
    const gitlinks = stages.split('\n').filter((line) => line.startsWith('160000 ')).length;
    return { tree, gitlinks };
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

interface CommitIndex {
  byTree: Map<string, string[]>;
  origin: Set<string>;
  local: Set<string>;
}

function buildCommitIndex(gitDir: string): CommitIndex {
  const all = git(
    ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)'],
    {},
  )
    .split('\n')
    .filter((line) => line.startsWith('commit '))
    .map((line) => line.slice('commit '.length));
  const byTree = new Map<string, string[]>();
  if (all.length > 0) {
    const pairs = git(['--git-dir', gitDir, 'log', '--no-walk=unsorted', '--stdin', '--format=%H %T'], {
      input: `${all.join('\n')}\n`,
    });
    for (const line of pairs.split('\n').filter(Boolean)) {
      const [commit, tree] = line.split(' ');
      byTree.set(tree, [...(byTree.get(tree) ?? []), commit]);
    }
  }
  const revs = (args: string[]): Set<string> =>
    new Set(
      git(['--git-dir', gitDir, 'rev-list', ...args], {})
        .split('\n')
        .filter(Boolean),
    );
  return {
    byTree,
    origin: revs(['--remotes=origin']),
    local: revs([`--exclude=${RESCUE_REF_PREFIX}/*`, '--all']),
  };
}

function classify(index: CommitIndex, tree: string): { match: MatchClass; commit: string | null } {
  const candidates = [...(index.byTree.get(tree) ?? [])].sort();
  const origin = candidates.find((commit) => index.origin.has(commit));
  if (origin) return { match: 'origin', commit: origin };
  const local = candidates.find((commit) => index.local.has(commit));
  if (local) return { match: 'local-ref', commit: local };
  if (candidates.length > 0) return { match: 'unreachable', commit: candidates[0] };
  return { match: 'no-match', commit: null };
}

/**
 * The canonical a checkout belongs to: the one its pointer already names, else the one its directory name names,
 * else the single workgroup canonical that holds nearly all of its blobs while no other holds most of them.
 */
function resolveCanonical(
  entry: Pick<RepairEntry, 'checkout' | 'previousGitdir' | 'path' | 'contentShares'>,
  workgroupId: string,
  dataDir: string,
  scratchDir: string,
): { repo: string; gitDir: string; source: 'pointer' | 'name' | 'content' } | null {
  const workgroupRoot = path.join(repositoriesRoot(dataDir), workgroupId);
  const pointed = path.resolve(entry.path, entry.previousGitdir);
  const relative = path.relative(workgroupRoot, pointed).split(path.sep);
  if (relative.length === 4 && relative[1] === '.git' && relative[2] === 'worktrees' && !relative[0].startsWith('.')) {
    const gitDir = canonicalGitDir(dataDir, workgroupId, relative[0]);
    if (gitDir) return { repo: relative[0], gitDir, source: 'pointer' };
  }
  const named = parseCheckoutDirName(entry.checkout);
  if (named) {
    const gitDir = canonicalGitDir(dataDir, workgroupId, named.repo);
    if (gitDir) return { repo: named.repo, gitDir, source: 'name' };
  }
  const canonicals = workgroupCanonicals(dataDir, workgroupId);
  if (canonicals.length === 0) return null;
  const probeDir = fs.mkdtempSync(path.join(scratchDir, 'probe-'));
  try {
    const probeGit = path.join(probeDir, 'probe.git');
    git(['init', '--quiet', '--bare', probeGit], {});
    const alternates = canonicals.map((canonical) => path.join(canonical.gitDir, 'objects'));
    const scratchObjects = { dir: path.join(probeGit, 'objects'), alternates };
    const { tree } = hashWorkTree({ gitDir: probeGit, workTree: entry.path, scratchObjects }, scratchDir);
    const objectEnv = {
      GIT_OBJECT_DIRECTORY: scratchObjects.dir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(':'),
    };
    const blobs = git(['--git-dir', probeGit, 'ls-tree', '-r', '--object-only', tree], { env: objectEnv })
      .split('\n')
      .filter(Boolean);
    if (blobs.length === 0) return null;
    const scored = canonicals
      .map((canonical) => {
        const answers = git(['--git-dir', canonical.gitDir, 'cat-file', '--batch-check=%(objectname)'], {
          input: `${blobs.join('\n')}\n`,
        }).split('\n');
        const present = answers.filter((line) => !line.endsWith(' missing')).length;
        return { ...canonical, share: present / blobs.length };
      })
      .sort((a, b) => b.share - a.share);
    const [best, runnerUp] = scored;
    if (best.share < 0.9 || (runnerUp && runnerUp.share >= 0.5)) {
      entry.contentShares = Object.fromEntries(
        scored.map(({ repo, share }) => [repo, Math.round(share * 1000) / 1000]),
      );
      return null;
    }
    return { repo: best.repo, gitDir: best.gitDir, source: 'content' };
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

/** Each canonical admin dir in the workgroup, keyed by the checkout `.git` its back-pointer names. */
function registrationsByBackPointer(dataDir: string, workgroupId: string): Map<string, string[]> {
  const byBackPointer = new Map<string, string[]>();
  for (const { gitDir } of workgroupCanonicals(dataDir, workgroupId)) {
    const worktrees = path.join(gitDir, 'worktrees');
    for (const name of fs.existsSync(worktrees) ? fs.readdirSync(worktrees) : []) {
      let back: string;
      try {
        back = fs.readFileSync(path.join(worktrees, name, 'gitdir'), 'utf8').trim();
      } catch {
        continue;
      }
      const key = realpathOrNull(back) ?? path.resolve(back);
      byBackPointer.set(key, [...(byBackPointer.get(key) ?? []), path.join(worktrees, name)]);
    }
  }
  return byBackPointer;
}

export function adminDirName(topicDirName: string, checkout: string): string {
  return `${checkout}-${topicDirName}`.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
}

export function rescueRefName(topicDirName: string, checkout: string): string {
  const component = (value: string) => value.replace(/[^A-Za-z0-9._@-]/g, '-').replace(/^\.+|\.lock$|\.+$/g, '_');
  return `${RESCUE_REF_PREFIX}/${component(topicDirName)}/${component(checkout)}`;
}

function topicLiveReason(topicDir: string, probes: LivenessProbes): string | null {
  const participants = probes.participants(topicDir);
  if (participants === null) return 'inventory-unavailable';
  if (participants.some((participant) => participant.status !== 'closed')) return 'session-live';
  if (participants.some((participant) => probes.participantBusy(participant))) return 'topic-busy';
  const mounts = probes.mounts();
  if (mounts === null) return 'runtime-unreadable';
  const resolvedTopic = realpathOrNull(topicDir) ?? topicDir;
  const mounted = mounts.some((mount) => {
    const source = realpathOrNull(mount) ?? mount;
    return isWithin(source, resolvedTopic) || isWithin(resolvedTopic, source);
  });
  if (mounted) return 'container-mounted';
  const cwds = probes.cwds();
  if (cwds === null) return 'process-table-unreadable';
  if (cwds.some((cwd) => isWithin(cwd, resolvedTopic))) return 'process-rooted';
  return null;
}

interface WriteContext {
  entry: RepairEntry;
  canonicalGit: string;
  topicDirName: string;
  scratchDir: string;
  commits: CommitIndex;
}

function writeRescue(context: WriteContext, tree: string, matched: string | null): string {
  const { entry, canonicalGit } = context;
  const ref = entry.rescueRef!;
  const existing = gitOrNull(['--git-dir', canonicalGit, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {});
  if (existing && git(['--git-dir', canonicalGit, 'rev-parse', `${existing}^{tree}`], {}) === tree) return existing;
  const parents = [existing, matched].filter((commit): commit is string => Boolean(commit));
  const message = [
    `Rescue snapshot of ${entry.topic}/${entry.checkout} before its worktree registration was repaired`,
    '',
    `pointer-state: ${entry.state}`,
    `match: ${entry.match}${matched ? ` ${matched}` : ''}`,
    `previous-gitdir: ${entry.previousGitdir}`,
  ].join('\n');
  const commit = git(
    ['--git-dir', canonicalGit, 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message],
    { env: IDENTITY },
  );
  git(['--git-dir', canonicalGit, 'update-ref', '-m', 'nanoclaw worktree repair', ref, commit, existing ?? ''], {});
  return commit;
}

function verifyRescue(canonicalGit: string, ref: string, commit: string, tree: string): void {
  const stored = git(['--git-dir', canonicalGit, 'rev-parse', '--verify', `${ref}^{commit}`], {});
  const storedTree = git(['--git-dir', canonicalGit, 'rev-parse', `${stored}^{tree}`], {});
  if (stored !== commit || storedTree !== tree) throw new Error(`rescue ref ${ref} did not verify`);
}

function writeAdminDir(context: WriteContext, head: string, lock: boolean): string {
  const { entry, canonicalGit, topicDirName } = context;
  const adminDir = path.join(canonicalGit, 'worktrees', adminDirName(topicDirName, entry.checkout));
  const backPointer = path.join(fs.realpathSync(entry.path), '.git');
  if (fs.existsSync(adminDir)) {
    const owner = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim();
    if (owner !== backPointer) throw new Error(`admin dir name already taken by another checkout: ${adminDir}`);
  } else {
    fs.mkdirSync(path.dirname(adminDir), { recursive: true });
    fs.mkdirSync(adminDir);
  }
  fs.writeFileSync(path.join(adminDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${backPointer}\n`);
  fs.writeFileSync(path.join(adminDir, 'HEAD'), `${head}\n`);
  if (lock) fs.writeFileSync(path.join(adminDir, 'locked'), LOCK_REASON);
  git(['--git-dir', adminDir, 'read-tree', head], { env: { GIT_INDEX_FILE: path.join(adminDir, 'index') } });
  return adminDir;
}

/** Applies one checkout's repair; the caller holds the lifecycle claim and the repository lock. */
function applyRepair(context: WriteContext, steps: string[]): void {
  const { entry, canonicalGit, scratchDir } = context;
  const before = hashWorkTree({ gitDir: canonicalGit, workTree: entry.path }, scratchDir);
  const { match, commit: matched } = classify(context.commits, before.tree);
  Object.assign(entry, { tree: before.tree, match, matchedCommit: matched });
  if (before.gitlinks > 0) entry.embeddedRepos = before.gitlinks;
  steps.push('tree-hashed');

  const rescueCommit = writeRescue(context, before.tree, matched);
  verifyRescue(canonicalGit, entry.rescueRef!, rescueCommit, before.tree);
  steps.push('rescue-verified');

  const head = matched ?? rescueCommit;
  const lock = matched === null;
  Object.assign(entry, { head, locked: lock });
  const adminDir = writeAdminDir(context, head, lock);
  steps.push('admin-written');

  const pointerPath = path.join(entry.path, '.git');
  fs.writeFileSync(pointerPath, `gitdir: ${adminDir}\n`);
  steps.push('pointer-written');

  const checkoutEnv = { GIT_CEILING_DIRECTORIES: path.dirname(fs.realpathSync(entry.path)) };
  gitOrNull(['update-index', '-q', '--refresh'], { cwd: entry.path, env: checkoutEnv });
  const resolvedGitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: entry.path, env: checkoutEnv });
  const resolvedHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: entry.path, env: checkoutEnv });
  if (fs.realpathSync(resolvedGitDir) !== fs.realpathSync(adminDir))
    throw new Error('pointer did not resolve to the new admin dir');
  if (!gitCommonDirIs(adminDir, canonicalGit)) throw new Error('new admin dir does not resolve to its canonical');
  if (resolvedHead !== head) throw new Error(`HEAD is ${resolvedHead}, expected ${head}`);
  const scratchObjects = {
    dir: fs.mkdtempSync(path.join(scratchDir, 'verify-')),
    alternates: [path.join(canonicalGit, 'objects')],
  };
  let after: string;
  try {
    after = hashWorkTree({ gitDir: canonicalGit, workTree: entry.path, scratchObjects }, scratchDir).tree;
  } finally {
    fs.rmSync(scratchObjects.dir, { recursive: true, force: true });
  }
  if (after !== before.tree) throw new Error(`working tree hash changed: ${before.tree} -> ${after}`);
  const status = gitOrNull(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], {
    cwd: entry.path,
    env: checkoutEnv,
    filters: safeGitFilterNames(adminDir, entry.path),
  });
  steps.push('verified');
  entry.proof = {
    rescueCommit,
    adminDir,
    treeBefore: before.tree,
    treeAfter: after,
    head,
    statusClean: status === '',
    steps,
  };
}

function planRepair(context: WriteContext): void {
  const { entry, canonicalGit, scratchDir } = context;
  const scratchObjects = {
    dir: fs.mkdtempSync(path.join(scratchDir, 'plan-')),
    alternates: [path.join(canonicalGit, 'objects')],
  };
  try {
    const { tree, gitlinks } = hashWorkTree({ gitDir: canonicalGit, workTree: entry.path, scratchObjects }, scratchDir);
    const { match, commit } = classify(context.commits, tree);
    if (gitlinks > 0) entry.embeddedRepos = gitlinks;
    Object.assign(entry, {
      tree,
      match,
      matchedCommit: commit,
      head: commit ?? 'rescue-commit',
      locked: commit === null,
    });
  } finally {
    fs.rmSync(scratchObjects.dir, { recursive: true, force: true });
  }
}

function topicUnit(workgroupId: string, topicDirName: string): RepositoryWorkUnit {
  const parsed = /^(thread|conversation|task|session)-([a-f0-9]{32})$/.exec(topicDirName);
  if (!parsed) throw new Error(`not a topic dir: ${topicDirName}`);
  return { workgroupId, kind: parsed[1] as RepositoryWorkUnit['kind'], key: '', id: parsed[2] };
}

function summarize(entries: RepairEntry[]): RepairReport['summary'] {
  const summary: RepairReport['summary'] = { state: {}, match: {}, action: {}, reason: {} };
  const bump = (bucket: string, key: string | undefined) => {
    if (key !== undefined) summary[bucket][key] = (summary[bucket][key] ?? 0) + 1;
  };
  for (const entry of entries) {
    bump('state', entry.state);
    bump('match', entry.match);
    bump('action', entry.action);
    bump('reason', entry.reason);
  }
  return summary;
}

interface RunState {
  options: RepairOptions;
  root: string;
  scratchDir: string;
  commitIndexes: Map<string, CommitIndex>;
  registrations: Map<string, Map<string, string[]>>;
}

async function repairOne(run: RunState, entry: RepairEntry, workgroupId: string, topicDirName: string): Promise<void> {
  const { options, scratchDir } = run;
  const topicDir = path.join(run.root, workgroupId, topicDirName);
  const skip = (reason: string) => Object.assign(entry, { action: 'skipped', reason });
  const live = topicLiveReason(topicDir, options.probes);
  if (live) return void skip(live);
  if (entry.state === 'foreign-common') return void skip('admin-outside-workgroup-canonicals');
  if (!run.registrations.has(workgroupId)) {
    run.registrations.set(workgroupId, registrationsByBackPointer(options.dataDir, workgroupId));
  }
  const naming = (run.registrations.get(workgroupId)!.get(path.join(fs.realpathSync(entry.path), '.git')) ?? []).filter(
    (adminDir) => path.basename(adminDir) !== adminDirName(topicDirName, entry.checkout),
  );
  if (naming.length > 0) return void skip('another-registration-names-checkout');
  const canonical = resolveCanonical(entry, workgroupId, options.dataDir, scratchDir);
  if (!canonical) return void skip('no-canonical');
  Object.assign(entry, {
    canonical: canonical.repo,
    canonicalSource: canonical.source,
    rescueRef: rescueRefName(topicDirName, entry.checkout),
  });
  if (!run.commitIndexes.has(canonical.gitDir)) {
    run.commitIndexes.set(canonical.gitDir, buildCommitIndex(canonical.gitDir));
  }
  const context: WriteContext = {
    entry,
    canonicalGit: canonical.gitDir,
    topicDirName,
    scratchDir,
    commits: run.commitIndexes.get(canonical.gitDir)!,
  };
  if (!options.apply) {
    planRepair(context);
    entry.action = 'planned';
    return;
  }
  const steps: string[] = [];
  await withRepositoryLifecycleClaims([topicUnit(workgroupId, topicDirName)], () =>
    withHostRepositoryLock(
      workgroupId,
      canonical.repo,
      () => {
        const late = topicLiveReason(topicDir, options.probes);
        if (late) return void skip(`recheck-${late}`);
        if (inspectPointer(entry.path, workgroupId, options.dataDir).state === 'healthy') {
          return void Object.assign(entry, { action: 'none', reason: 'healthy-on-recheck' });
        }
        steps.push('liveness-rechecked');
        applyRepair(context, steps);
        entry.action = 'repaired';
      },
      options.dataDir,
    ),
  );
  if (entry.action === 'repaired' && topicLiveReason(topicDir, options.probes)) entry.reason = 'went-live-after-repair';
}

export async function repairTopicWorktrees(options: RepairOptions): Promise<RepairReport> {
  const startedAt = new Date().toISOString();
  const scratchDir = fs.mkdtempSync(path.join(options.scratchDir ?? os.tmpdir(), 'repair-topic-worktrees-'));
  const root = topicsRoot(options.dataDir);
  const wanted = options.topics ? new Set(options.topics) : null;
  const inspected: Array<{ entry: RepairEntry; workgroupId: string; topicDirName: string; adminDir: string | null }> =
    [];
  let linkedCheckouts = 0;

  for (const workgroupId of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    const workgroupDir = path.join(root, workgroupId);
    if (!fs.statSync(workgroupDir).isDirectory()) continue;
    for (const topicDirName of fs.readdirSync(workgroupDir).sort()) {
      const topic = `${workgroupId}/${topicDirName}`;
      if (wanted && !wanted.has(topic)) continue;
      for (const checkout of listTopicCheckouts(path.join(workgroupDir, topicDirName, 'worktrees'))) {
        if (checkout.shape !== 'linked') continue;
        linkedCheckouts += 1;
        const base = { topic, checkout: checkout.name, path: checkout.path, sharedWith: 1, action: 'none' as const };
        try {
          const { state, previousGitdir, adminDir } = inspectPointer(checkout.path, workgroupId, options.dataDir);
          inspected.push({ entry: { ...base, state, previousGitdir }, workgroupId, topicDirName, adminDir });
        } catch (error) {
          const entry: RepairEntry = { ...base, state: 'unreadable', previousGitdir: '', action: 'skipped' };
          entry.reason = `pointer-unreadable: ${(error as Error).message}`;
          inspected.push({ entry, workgroupId, topicDirName, adminDir: null });
        }
      }
    }
  }

  const sharers = new Map<string, number>();
  for (const { adminDir } of inspected) if (adminDir) sharers.set(adminDir, (sharers.get(adminDir) ?? 0) + 1);
  for (const item of inspected) if (item.adminDir) item.entry.sharedWith = sharers.get(item.adminDir)!;

  const run: RunState = { options, root, scratchDir, commitIndexes: new Map(), registrations: new Map() };
  const entries: RepairEntry[] = [];
  let healthy = 0;
  try {
    for (const { entry, workgroupId, topicDirName } of inspected) {
      if (entry.action === 'skipped') {
        entries.push(entry);
        continue;
      }
      if (entry.state === 'healthy') {
        healthy += 1;
        if (entry.sharedWith > 1) entries.push({ ...entry, reason: 'owns-shared-admin' });
        continue;
      }
      entries.push(entry);
      try {
        await repairOne(run, entry, workgroupId, topicDirName);
      } catch (error) {
        Object.assign(entry, { action: 'failed', reason: (error as Error).message });
      }
      options.onEntry?.(entry);
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    dataDir: options.dataDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    linkedCheckouts,
    healthy,
    entries,
    summary: summarize(entries),
  };
}

async function sessionParticipants(dataDir: string): Promise<Map<string, TopicParticipant[]>> {
  const rows = await getDb().all<{
    id: string;
    agent_group_id: string;
    status: string;
    thread_id: string | null;
    messaging_group_id: string | null;
    platform_id: string | null;
    workgroup_id: string;
  }>(
    `SELECT s.id, s.agent_group_id, s.status, s.thread_id, s.messaging_group_id, mg.platform_id,
            COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id
       FROM sessions s JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
  );
  const byTopic = new Map<string, TopicParticipant[]>();
  for (const row of rows) {
    const unit = resolveRepositoryWorkUnit({
      workgroupId: row.workgroup_id,
      sessionId: row.id,
      platformId: row.platform_id,
      messagingGroupId: row.messaging_group_id,
      threadId: row.thread_id,
    });
    const topicDir = topicStateDir(unit, dataDir);
    byTopic.set(topicDir, [
      ...(byTopic.get(topicDir) ?? []),
      { sessionId: row.id, agentGroupId: row.agent_group_id, status: row.status },
    ]);
  }
  return byTopic;
}

/** A closed session can still hold a processing claim, a current tool or a promised continuation. */
function outboundShowsWork(participant: TopicParticipant): boolean {
  const location = { agentGroupId: participant.agentGroupId, sessionId: participant.sessionId };
  if (!fs.existsSync(sessionMailboxPath(location, 'outbound'))) return false;
  try {
    const busy = readSessionOutbound(
      location,
      (mailbox) =>
        mailbox.getProcessingClaimRows().length > 0 ||
        Boolean(mailbox.getContainerState()?.current_tool) ||
        mailbox.hasWorkContinuation(),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );
    return busy ?? true;
  } catch {
    return true;
  }
}

function hostProcessCwds(): string[] | null {
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  return pids.flatMap((pid) => {
    try {
      return [fs.readlinkSync(`/proc/${pid}/cwd`)];
    } catch {
      return [];
    }
  });
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const valueOf = (flag: string) => argv.flatMap((arg, i) => (arg === flag && argv[i + 1] ? [argv[i + 1]] : []));
  const dataDir = DATA_DIR;
  const topics = valueOf('--topic');
  await initDb(path.join(dataDir, 'v2.db'), { role: 'tool', readonly: true });
  const participants = await sessionParticipants(dataDir);
  const report = await repairTopicWorktrees({
    dataDir,
    apply,
    topics: topics.length > 0 ? topics : undefined,
    scratchDir: valueOf('--scratch')[0],
    probes: {
      participants: (topicDir) => participants.get(topicDir) ?? [],
      participantBusy: outboundShowsWork,
      mounts: runningContainerMounts,
      cwds: hostProcessCwds,
    },
    onEntry: (entry) =>
      console.error(`${entry.action} ${entry.reason ?? entry.match ?? ''} ${entry.topic}/${entry.checkout}`),
  });
  const reportPath =
    valueOf('--report')[0] ??
    path.join(
      dataDir,
      'reports',
      `topic-worktree-repair-${report.mode}-${report.startedAt.replace(/[:.]/g, '-')}.json`,
    );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.mode}: ${report.linkedCheckouts} linked checkouts, ${report.healthy} healthy`);
  for (const [bucket, counts] of Object.entries(report.summary)) {
    console.log(`  ${bucket}: ${JSON.stringify(counts)}`);
  }
  console.log(`report: ${reportPath}`);
  return report.entries.some((entry) => entry.action === 'failed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}
