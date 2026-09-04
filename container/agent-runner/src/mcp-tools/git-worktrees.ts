/**
 * Git repository MCP tools.
 *
 * One host-owned normal canonical clone exists per (workgroup, repository).
 * Each topic receives one standard linked worktree. The host mounts the topic
 * root and canonical metadata at their exact host paths, so Git records paths
 * that work unchanged from both the host and every sibling container.
 */
import { dlopen } from 'bun:ffi';
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { evaluateReviewChurnGate } from '../review-churn-gate.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;
const LOCK_WAIT_MS = 120_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const libc = dlopen('libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
});

type OriginPin =
  | { kind?: 'network'; origin: string; repositoryId: string }
  | { kind: 'local-only'; origin: null; repositoryId: string };

interface RepositoryContext {
  workgroupId: string;
  workUnitKey: string;
  dataDir: string;
  topicRoot: string;
  repo: string;
  canonical: string;
  gitDir: string;
  lockPath: string;
  pinPath: string;
  worktree: string;
  pin: OriginPin;
}

type ToolResult = ReturnType<typeof ok> | ReturnType<typeof err>;

function log(message: string): void {
  console.error(`[git-worktrees] ${message}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function validateSegment(value: string, label: string): string | null {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value === '.git') {
    return `Invalid ${label}: ${value}`;
  }
  return null;
}

function runGitAt(cwd: string, args: string[], timeoutMs = 120_000): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

/**
 * The branch and the commit it points at, read in ONE git invocation.
 *
 * Two commands can straddle a sibling checking out another branch — they share
 * this worktree — leaving a branch name from before the switch beside a commit
 * from after it. Everything downstream is then pinned to an identity that never
 * existed: the gate judges one PR's history while the refspec pushes the other
 * branch's commit. `status --porcelain=v2 --branch` reports both from a single
 * snapshot, so there is no window to lose rather than a smaller one.
 */
function capturedIdentity(worktree: string): { branch: string; head: string; lease: string } | null {
  const out = runGitAt(worktree, ['status', '--porcelain=v2', '--branch', '--untracked-files=no']);
  const oid = /^# branch\.oid (\S+)$/m.exec(out)?.[1];
  const head = /^# branch\.head (.+)$/m.exec(out)?.[1];
  if (!oid || !head || head === '(detached)' || oid === '(initial)') return null;
  // The remote value this caller actually integrated, read now rather than left
  // to `--force-with-lease` to infer at push time. A bare lease expects
  // whatever `refs/remotes/origin/<branch>` says when the push runs, and any
  // sibling topic's `create_worktree` refreshes that ref with a shared
  // `fetch --prune` — so a commit that landed while the gate was on the network
  // would be adopted as the expectation and then overwritten. An empty lease
  // means the branch must not exist on the remote yet.
  const lease = tryGitAt(worktree, ['rev-parse', `refs/remotes/origin/${head}`]) ?? '';
  return { branch: head, head: oid, lease };
}

function tryGitAt(cwd: string, args: string[], timeoutMs = 120_000): string | null {
  try {
    return runGitAt(cwd, args, timeoutMs);
  } catch {
    return null;
  }
}

function runGitDir(gitDir: string, args: string[], timeoutMs = 120_000): string {
  return runGitAt(path.dirname(gitDir), [`--git-dir=${gitDir}`, ...args], timeoutMs);
}

function tryGitDir(gitDir: string, args: string[], timeoutMs = 120_000): string | null {
  try {
    return runGitDir(gitDir, args, timeoutMs);
  } catch {
    return null;
  }
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function contained(candidate: string, root: string): boolean {
  const absoluteCandidate = path.resolve(candidate);
  const absoluteRoot = path.resolve(root);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

function normalizeOrigin(value: string): string {
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(value)) {
    return canonicalPath(value).replace(/\/+$/, '');
  }
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('origin contains credentials');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('origin must use HTTPS github.com');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('origin must not include query parameters or fragments');
  }
  return parsed
    .toString()
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
}

function readPin(pinPath: string): OriginPin {
  let fd: number;
  try {
    fd = fs.openSync(pinPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('origin pin must not be a symlink');
    throw new Error(`origin pin is unavailable: ${pinPath}`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('origin pin must be a regular file');
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<OriginPin>;
    if (typeof parsed.repositoryId !== 'string' || !parsed.repositoryId) {
      throw new Error('origin pin is malformed');
    }
    if (parsed.kind === 'local-only') {
      if (parsed.origin !== null || !parsed.repositoryId.startsWith('local-only:')) {
        throw new Error('local-only origin pin is malformed');
      }
      return { kind: 'local-only', origin: null, repositoryId: parsed.repositoryId };
    }
    if (typeof parsed.origin !== 'string') throw new Error('network origin pin is malformed');
    return { origin: normalizeOrigin(parsed.origin), repositoryId: parsed.repositoryId };
  } finally {
    fs.closeSync(fd);
  }
}

function contextFor(repo: string): RepositoryContext {
  const nameError = validateSegment(repo, 'repository name');
  if (nameError) throw new Error(nameError);

  const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
  const workUnitKey = process.env.NANOCLAW_WORK_UNIT_KEY ?? '';
  const dataDir = process.env.NANOCLAW_HOST_DATA_DIR ?? '';
  const topicRoot = process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR ?? '';
  if (validateSegment(workgroupId, 'workgroup id')) throw new Error('repository workgroup context is unavailable');
  if (!workUnitKey) throw new Error('repository work-unit context is unavailable');
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(topicRoot)) {
    throw new Error('host-native repository paths are unavailable');
  }

  const repositoriesRoot = path.join(dataDir, 'repositories', workgroupId);
  const stateRoot = path.join(dataDir, 'repository-state', workgroupId, repo);
  const canonical = path.join(repositoriesRoot, repo);
  const gitDir = path.join(canonical, '.git');
  const lockPath = path.join(stateRoot, 'repository.lock');
  const pinPath = path.join(stateRoot, 'origin.json');
  const worktree = path.join(topicRoot, repo);

  if (!contained(canonical, repositoriesRoot) || !contained(worktree, topicRoot)) {
    throw new Error('repository path escapes its trusted host root');
  }
  if (!fs.existsSync(gitDir) || !fs.lstatSync(gitDir).isDirectory() || fs.lstatSync(gitDir).isSymbolicLink()) {
    throw new Error(`canonical repository metadata is unavailable for ${repo}`);
  }
  if (runGitDir(gitDir, ['rev-parse', '--is-bare-repository'], 10_000) !== 'false') {
    throw new Error(`canonical repository is not a normal clone: ${repo}`);
  }
  const pin = readPin(pinPath);
  const configuredOrigin = tryGitDir(gitDir, ['config', '--get', 'remote.origin.url'], 10_000);
  if (pin.kind === 'local-only') {
    if (configuredOrigin !== null) throw new Error(`local-only canonical unexpectedly has an origin for ${repo}`);
  } else if (configuredOrigin === null || normalizeOrigin(configuredOrigin) !== normalizeOrigin(pin.origin)) {
    throw new Error(`canonical origin does not match the host origin pin for ${repo}`);
  }
  const workUnitId = createHash('sha256').update(`${workgroupId}\0${workUnitKey}`).digest('hex').slice(0, 32);
  const tombstonePath = path.join(stateRoot, 'transfers', `${workUnitId}.json`);
  if (fs.existsSync(tombstonePath)) {
    const stat = fs.lstatSync(tombstonePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repository transfer tombstone is invalid');
    const tombstone = JSON.parse(fs.readFileSync(tombstonePath, 'utf8')) as {
      sourceWorkUnitKey?: string;
      destinationWorkUnitKey?: string;
    };
    if (tombstone.sourceWorkUnitKey !== workUnitKey || !tombstone.destinationWorkUnitKey) {
      throw new Error('repository transfer tombstone identity mismatch');
    }
    throw new Error(
      `This topic's ${repo} worktree was transferred to ${tombstone.destinationWorkUnitKey}; ` +
        'the source topic may not silently recreate it',
    );
  }
  return { workgroupId, workUnitKey, dataDir, topicRoot, repo, canonical, gitDir, lockPath, pinPath, worktree, pin };
}

function defaultBranch(context: RepositoryContext): string {
  const digest = createHash('sha256')
    .update(`${context.workgroupId}\0${context.workUnitKey}\0${context.repo}`)
    .digest('hex')
    .slice(0, 24);
  return `nc/topic-${digest}`;
}

function identity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

async function withRepositoryLock<T>(context: RepositoryContext, fn: () => Promise<T> | T): Promise<T> {
  let fd: number;
  try {
    fd = fs.openSync(context.lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('repository lock must not be a symlink');
    throw new Error(`repository lock is unavailable for ${context.repo}`);
  }
  const openedIdentity = identity(fs.fstatSync(fd));
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    while (libc.symbols.flock(fd, LOCK_EX_NB) !== 0) {
      if (Date.now() >= deadline) throw new Error(`timed out acquiring repository lock for ${context.repo}`);
      await Bun.sleep(25);
    }
    const current = fs.lstatSync(context.lockPath);
    if (!current.isFile() || current.isSymbolicLink() || identity(current) !== openedIdentity) {
      throw new Error('repository lock identity changed');
    }
    return await fn();
  } finally {
    libc.symbols.flock(fd, LOCK_UN);
    fs.closeSync(fd);
  }
}

function worktreeCommonDir(worktree: string): string | null {
  return tryGitAt(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
}

function validateExistingWorktree(context: RepositoryContext, branchArg: string | undefined): ToolResult | null {
  if (!fs.existsSync(context.worktree)) return null;
  const pointer = path.join(context.worktree, '.git');
  if (!fs.existsSync(pointer)) {
    return err(`Existing topic path is not a Git worktree and was left untouched: ${context.worktree}`);
  }
  const pointerStat = fs.lstatSync(pointer);
  if (!pointerStat.isFile()) {
    return err(`Existing topic checkout is not a linked worktree and was left untouched: ${context.worktree}`);
  }
  const common = worktreeCommonDir(context.worktree);
  if (!common || canonicalPath(common) !== canonicalPath(context.gitDir)) {
    return err(`Existing topic worktree is attached to different canonical metadata: ${context.worktree}`);
  }
  if (branchArg) {
    const current = tryGitAt(context.worktree, ['branch', '--show-current'], 10_000) ?? '';
    if (current !== branchArg) {
      return err(
        `Worktree at ${context.worktree} is on '${current || 'detached HEAD'}', not requested branch '${branchArg}'. ` +
          'Existing worktrees are never branch-switched automatically.',
      );
    }
  }
  const current = tryGitAt(context.worktree, ['branch', '--show-current'], 10_000) || 'detached HEAD';
  return ok(`Worktree ready at ${context.worktree} (existing ${current}; left untouched)`);
}

function branchOwner(gitDir: string, branch: string): string | null {
  const porcelain = tryGitDir(gitDir, ['worktree', 'list', '--porcelain'], 10_000) ?? '';
  let currentPath: string | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && currentPath) return currentPath;
    if (line === '') currentPath = null;
  }
  return null;
}

async function queueHostAction(action: string, payload: Record<string, unknown>): Promise<string> {
  const requestId = `repo-${Date.now()}-${randomBytes(8).toString('hex')}`;
  if (process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT === 'disabled') return requestId;
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action, requestId, ...payload }),
  });
  return requestId;
}

async function emitRefresh(context: RepositoryContext): Promise<void> {
  await queueHostAction('repository_refresh', { repo: context.repo, workUnitKey: context.workUnitKey });
}

async function createLinkedWorktree(context: RepositoryContext, branchArg: string | undefined): Promise<ToolResult> {
  const branch = branchArg ?? defaultBranch(context);
  if (tryGitDir(context.gitDir, ['check-ref-format', '--branch', branch], 10_000) === null) {
    return err(`Invalid branch name: ${branch}`);
  }

  // Every network-backed invocation refreshes shared refs through this
  // container's scoped identity. Local-only repositories are a migration
  // preservation state and start new worktrees from the canonical HEAD.
  let baseRef: string;
  if (context.pin.kind === 'local-only') {
    baseRef = runGitDir(context.gitDir, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
  } else {
    runGitDir(context.gitDir, ['fetch', 'origin', '--prune'], 300_000);
    runGitDir(context.gitDir, ['remote', 'set-head', 'origin', '--auto'], 120_000);
    baseRef = runGitDir(context.gitDir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10_000);
    runGitDir(context.gitDir, ['rev-parse', '--verify', `${baseRef}^{commit}`], 10_000);
  }
  const existing = validateExistingWorktree(context, branchArg);
  if (existing) {
    if (context.pin.kind !== 'local-only') await emitRefresh(context);
    return existing;
  }

  const owner = branchOwner(context.gitDir, branch);
  if (owner && canonicalPath(owner) !== canonicalPath(context.worktree)) {
    return err(`Branch '${branch}' is already checked out by another worktree at ${owner}`);
  }

  fs.mkdirSync(context.topicRoot, { recursive: true });
  const localExists = tryGitDir(context.gitDir, ['show-ref', '--verify', `refs/heads/${branch}`], 10_000) !== null;
  const remoteExists =
    tryGitDir(context.gitDir, ['show-ref', '--verify', `refs/remotes/origin/${branch}`], 10_000) !== null;
  if (localExists && branchArg) {
    runGitDir(context.gitDir, ['worktree', 'add', context.worktree, branch]);
  } else if (localExists) {
    // A surviving generated ref without a checkout can contain unpushed work
    // after an unexpected directory/admin loss. Never reset it. Normal host
    // cleanup deletes this exact ref only after proving it remote-contained;
    // any unexplained survivor is reattached losslessly.
    runGitDir(context.gitDir, ['worktree', 'add', context.worktree, branch]);
  } else if (remoteExists) {
    runGitDir(context.gitDir, ['worktree', 'add', '-b', branch, context.worktree, `refs/remotes/origin/${branch}`]);
  } else {
    runGitDir(context.gitDir, ['worktree', 'add', '-b', branch, context.worktree, baseRef]);
  }

  if (context.pin.kind !== 'local-only') {
    await emitRefresh(context);
    return ok(`Worktree created at ${context.worktree} on branch ${branch}; host canonical refresh queued`);
  }
  return ok(
    `Worktree created at ${context.worktree} on branch ${branch} from the preserved local-only canonical; ` +
      'fetch, push, and PR operations remain unavailable until an operator publishes an origin',
  );
}

export const cloneRepoTool: McpToolDefinition = {
  tool: {
    name: 'clone_repo',
    description:
      "Clone a GitHub repository through this container's scoped identity, then durably publish one host-owned canonical clone for the workgroup. Idempotent when name, origin, and repository identity match.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'HTTPS github.com repository URL.' },
        name: { type: 'string', description: 'Optional repository name. Defaults to the URL leaf.' },
      },
      required: ['url'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const requestedUrl = typeof args.url === 'string' ? args.url : '';
    let normalizedUrl: string;
    let parsed: URL;
    try {
      normalizedUrl = normalizeOrigin(requestedUrl);
      parsed = new URL(normalizedUrl);
    } catch (error) {
      const safeMessages = new Set([
        'origin contains credentials',
        'origin must use HTTPS github.com',
        'origin must not include query parameters or fragments',
      ]);
      const message =
        error instanceof Error && safeMessages.has(error.message) ? error.message : 'Invalid repository URL';
      return err(message);
    }
    const parts = parsed.pathname
      .replace(/^\//, '')
      .replace(/\.git\/?$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length !== 2) return err('GitHub URL must identify exactly one owner/repository');
    const repo = typeof args.name === 'string' && args.name ? args.name : parts[1]!;
    const nameError = validateSegment(repo, 'repository name');
    if (nameError) return err(nameError);
    const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
    if (validateSegment(workgroupId, 'workgroup id')) return err('repository workgroup context is unavailable');

    const requestId = `repo-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const stageRoot = path.join('/workspace', 'repository-staging', requestId);
    const stageRepo = path.join(stageRoot, repo);
    fs.mkdirSync(stageRoot, { recursive: true });
    try {
      execFileSync('git', ['clone', normalizedUrl, stageRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
      runGitAt(stageRepo, ['config', 'gc.auto', '0'], 10_000);
      runGitAt(stageRepo, ['config', 'gc.worktreePruneExpire', 'never'], 10_000);
    } catch (error) {
      return err(`git clone failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT === 'disabled') {
      return ok(`Repository staged at ${stageRepo} (test transport)`);
    }
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'repository_publish',
        requestId,
        repo,
        origin: normalizedUrl,
        repositoryId: `github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`,
      }),
    });
    return ok(
      `Repository publication queued durably for ${repo}. The workgroup will respawn with consistent mounts, ` +
        'and this topic will receive an explicit success or failure message after the host action finishes.',
    );
  },
};

export const createWorktreeTool: McpToolDefinition = {
  tool: {
    name: 'create_worktree',
    description:
      "Create or reuse this topic's standard linked worktree at /workspace/worktrees/<repo>. Existing worktrees are " +
      'never rebased or branch-switched, and dirty/staged/untracked state persists exactly as left. Optionally transfer ' +
      'exact work from an inactive source thread. Typical flow from here: git_commit → git_push → open_pr.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name already published for this workgroup.' },
        branch: { type: 'string', description: 'Optional explicit branch. Defaults to the stable topic branch.' },
        continueFromThreadId: {
          type: 'string',
          description:
            'Optional source external thread id whose exact inactive worktree should move to this topic. ' +
            'If migrated work looks missing afterward, ask the operator rather than recreating a branch — the source ' +
            'topology stays outside agent mounts for rollback.',
        },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const branch = typeof args.branch === 'string' && args.branch ? args.branch : undefined;
    const continueFromThreadId =
      typeof args.continueFromThreadId === 'string' && args.continueFromThreadId
        ? args.continueFromThreadId
        : undefined;
    if (continueFromThreadId) {
      const nameError = validateSegment(repo, 'repository name');
      if (nameError) return err(nameError);
      const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
      const workUnitKey = process.env.NANOCLAW_WORK_UNIT_KEY ?? '';
      if (validateSegment(workgroupId, 'workgroup id') || !workUnitKey) {
        return err('repository work-unit context is unavailable');
      }
      await queueHostAction('repository_transfer', {
        repo,
        sourceThreadId: continueFromThreadId,
        destinationWorkUnitKey: workUnitKey,
      });
      return ok(
        `Repository transfer queued durably for ${repo}. This topic will restart after the exact linked ` +
          'worktree has moved, then receive an explicit success or failure message.',
      );
    }
    let context: RepositoryContext;
    try {
      context = contextFor(repo);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }

    try {
      return await withRepositoryLock(context, () => createLinkedWorktree(context, branch));
    } catch (error) {
      return err(`create_worktree failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

function worktreeForTool(repo: string): { context: RepositoryContext } | { error: ToolResult } {
  try {
    const context = contextFor(repo);
    const existing = validateExistingWorktree(context, undefined);
    if (!existing || ('isError' in existing && existing.isError)) {
      return { error: existing ?? err(`Worktree not found: ${repo}`) };
    }
    return { context };
  } catch (error) {
    return { error: err(error instanceof Error ? error.message : String(error)) };
  }
}

export const gitCommitTool: McpToolDefinition = {
  tool: {
    name: 'git_commit',
    description:
      'Stage and commit all changes in this topic worktree. Returns the short commit SHA. Stages every dirty file in ' +
      'the checkout, including any left by same-topic siblings sharing it — coordinate before committing. Never add ' +
      '"Co-Authored-By" trailers or "Generated with Claude Code" footers to the message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        message: { type: 'string', description: 'Commit message.' },
      },
      required: ['repo', 'message'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const message = typeof args.message === 'string' ? args.message : '';
    if (!message.trim()) return err('message is required');
    const resolved = worktreeForTool(repo);
    if ('error' in resolved) return resolved.error;
    try {
      return await withRepositoryLock(resolved.context, () => {
        runGitAt(resolved.context.worktree, ['add', '-A']);
        runGitAt(resolved.context.worktree, [
          '-c',
          'user.email=agent@nanoclaw.local',
          '-c',
          'user.name=agent',
          'commit',
          '--no-verify',
          '-m',
          message,
        ]);
        return ok(`Committed ${runGitAt(resolved.context.worktree, ['rev-parse', '--short', 'HEAD'])}`);
      });
    } catch (error) {
      return err(`git commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const gitPushTool: McpToolDefinition = {
  tool: {
    name: 'git_push',
    description:
      'Push this topic worktree branch through the container-scoped origin identity. Sends the branch and commit ' +
      'as they stood when the call started, so work a sibling adds meanwhile is not carried along — push again to ' +
      'send it. Refused while the pr-review-loop churn gate is holding: three review rounds on one finding class ' +
      'means the fix belongs in the primitive every flagged site calls, not at one more site.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        force: { type: 'boolean', description: 'Use --force-with-lease.' },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const resolved = worktreeForTool(repo);
    if ('error' in resolved) return resolved.error;
    const worktree = resolved.context.worktree;
    try {
      // A container agent's push path is this tool, not the skill's
      // `codex-review.sh push`, so the gate has to sit here or it does not
      // exist for container review loops. It fails open — only an explicit
      // refusal stops the push.
      //
      // The gate runs outside the repository lock deliberately: it makes its
      // own `gh` calls, and holding the lock across them would stall every
      // sibling topic on this repo. Same-topic siblings share this worktree,
      // so the checkout can change underneath the verdict — a commit, a
      // rewrite, a checkout of another branch at the same commit. Rather than
      // detect each of those, the branch and commit are captured once, up
      // front, and everything downstream NAMES them: the gate is asked about
      // that branch and that commit, and the push sends them as an explicit
      // refspec. Nothing downstream reads the checkout again, so what reaches
      // the remote is what the gate looked at, or nothing. Work a sibling adds
      // in the window is simply not pushed here; it gets its own verdict on
      // its own push.
      const identity = capturedIdentity(worktree);
      if (!identity) return err('Cannot push a detached HEAD; create or switch to a branch explicitly');
      const { branch, head } = identity;

      const gate = evaluateReviewChurnGate({ worktree, branch, head });
      if (gate.status === 'refused') return err(gate.message);

      return await withRepositoryLock(resolved.context, async () => {
        const push = [
          'push',
          ...(args.force === true ? [`--force-with-lease=refs/heads/${branch}:${identity.lease}`] : []),
          'origin',
          `${head}:refs/heads/${branch}`,
        ];
        runGitAt(worktree, push, 300_000);
        // `-u` does not apply to a refspec whose source is a commit, so the
        // tracking config the old form set is restored explicitly. Best effort:
        // it is a convenience, and the push has already landed.
        tryGitAt(worktree, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
        await emitRefresh(resolved.context);
        return ok(
          `Pushed ${branch} at ${head.slice(0, 8)} to origin${args.force === true ? ' (force-with-lease)' : ''}`,
        );
      });
    } catch (error) {
      return err(`git push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const openPrTool: McpToolDefinition = {
  tool: {
    name: 'open_pr',
    description:
      'Open a GitHub pull request from the current topic worktree branch. After it opens: add_ship_log to record it, ' +
      'update_backlog_item to resolve any backlog item it addresses, and add_backlog_item for any new bugs found along the way.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Optional pull request body.' },
      },
      required: ['repo', 'title'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    if (!title.trim()) return err('title is required');
    const resolved = worktreeForTool(repo);
    if ('error' in resolved) return resolved.error;
    try {
      // Bound to the branch this call captured, not to whatever is checked out
      // when `gh` runs: same-topic siblings share the worktree, and `gh pr
      // create` defaults `--head` to the current branch, so a switch mid-call
      // would open the PR for the sibling's branch — or push theirs to open it.
      const identity = capturedIdentity(resolved.context.worktree);
      if (!identity) return err('Cannot open a PR from a detached HEAD; create or switch to a branch explicitly');
      const url = execFileSync('gh', ['pr', 'create', '--head', identity.branch, '--title', title, '--body', body], {
        cwd: resolved.context.worktree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      }).trim();
      return ok(`PR opened: ${url}`);
    } catch (error) {
      return err(`gh pr create failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const gitWorktreeTools: McpToolDefinition[] = [
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  openPrTool,
];

registerTools(gitWorktreeTools);
