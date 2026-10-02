/**
 * Conservative cleanup for host-owned per-topic checkouts. Never talks to a remote. A linked checkout is eligible
 * only when every DB participant is inactive, Git proves the tree clean with no commits absent from local remote
 * refs, the branch is merged into origin/HEAD or gone from the fetched origin namespace, and the topic has been
 * idle seven days; only the exact generated topic branch is removed. A branch clone (`.git` a directory), even in an
 * open topic, is quarantined and trashed once the topic is not busy, nothing mounts it, it is seven days idle, and a
 * proof covers every local ref, HEAD and the stash, less the tags the host recorded when it built the clone.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { runningContainerMounts } from './container-mounts.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { withCentralSync, withRawDb } from './db/central-lease.js';
// The GC's reclaim gate is synchronous up through `runStorageGcOnce`, so the busy probe uses the mailbox's
// synchronous read funnel rather than an async mailbox session. Not on the raw-access allowlist: the remaining
// inbound touches are `fs.existsSync` on paths, not opens.
import { readSessionOutbound, sessionMailboxPath } from './modules/mailbox/index.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import {
  canonicalRepoDir,
  checkoutInheritedTagsPath,
  defaultTopicBranch,
  ensureRepositoryLock,
  listTopicCheckouts,
  parseCheckoutDirName,
  readCheckoutInheritedTags,
  resolveRepositoryWorkUnit,
  topicStateDir,
  topicWorktreesDir,
  transferTombstonesDir,
  withHostRepositoryLock,
  withRepositoryLifecycleClaims,
  type CheckoutShape,
  type RepositoryWorkUnit,
  type TopicCheckout,
} from './repository-workspaces.js';

import { gitCommonDirIs } from './canonical-git-commondir.js';
import { safeGitArgs, safeGitEnv, safeGitFilterNames } from './safe-git.js';
import { dirSizeBytes, REGENERABLE_SWEEP_DIR_NAMES, sessionWasReclaimed } from './storage-manager.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const MINIMUM_IDLE_DAYS = 7;
const STALE_WARNING_DAYS = 30;
const DEFAULT_TOPIC_IDLE_RECLAIM_DAYS = 14;
/**
 * Twice the topic floor: nothing closes a clone the way a session close retires a topic, so idleness is the only
 * signal. Directory mtime, not a deep walk: the git proof classifies deep edits.
 */
const CLONE_IDLE_RECLAIM_DAYS = 14;

let warnedBadIdleReclaimDays = false;

/**
 * Topics whose open participants have been idle this long also count as side-(a) evidence; 0 disables. Unset means
 * the default (14); any value that is not a plain non-negative integer ("" included) DISABLES it, so a typo meant
 * to turn it off never turns it on. Warns once per process.
 */
function topicIdleReclaimDays(): number {
  const raw = process.env.NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS;
  if (raw === undefined) return DEFAULT_TOPIC_IDLE_RECLAIM_DAYS;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!warnedBadIdleReclaimDays) {
    warnedBadIdleReclaimDays = true;
    log.warn('Worktree cleanup: invalid NANOCLAW_TOPIC_IDLE_RECLAIM_DAYS, disabling idle reclaim', { value: raw });
  }
  return 0;
}

/** An unparseable timestamp fails closed (treated as just-now). */
function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (Date.now() - ms) / 86_400_000 : 0;
}

interface TopicParticipant {
  sessionId: string;
  agentGroupId: string;
  status: string;
  /** COALESCE(last_active, created_at), ISO-8601 UTC. */
  idleSince: string;
  /** mtime of inbound.db (the durable admission write, which precedes last_active). */
  inboundMtimeMs: InboundMtime;
}

export interface TopicWorktreeTarget {
  workUnit: RepositoryWorkUnit;
  participants: TopicParticipant[];
  repo: string;
  worktreePath: string;
  shape: CheckoutShape;
  canonicalRepoPath: string;
}

interface SessionRow {
  session_id: string;
  agent_group_id: string;
  status: string;
  thread_id: string | null;
  messaging_group_id: string | null;
  platform_id: string | null;
  folder: string;
  workgroup_id: string;
  idle_since: string;
}

function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  filterNames: readonly string[] = [],
  input?: string,
): string | null {
  try {
    return execFileSync('git', safeGitArgs(args, undefined, filterNames), {
      cwd,
      env: safeGitEnv(env),
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Git's environment for a question about exactly one checkout. With a missing or corrupt `.git`, discovery would
 * walk up into the install's own checkout (`data/` sits inside it); the ceiling makes such a checkout unprovable.
 */
function checkoutGitEnv(dir: string): NodeJS.ProcessEnv {
  return { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)) };
}

/**
 * Every filter the repository's effective config defines, so safeGitArgs can neutralize each by name; `null` when
 * the config cannot be read. A clone's `.git` is container-writable, and `status` runs clean filters.
 */
function repositoryFilterNames(dir: string, env: NodeJS.ProcessEnv): string[] | null {
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir'], env);
  if (gitDir === null) return null;
  try {
    return safeGitFilterNames(gitDir, dir);
  } catch {
    return null;
  }
}

/**
 * Directory names under a topic's worktrees root, `[]` on ENOENT, or `null` on any other read failure: an
 * unreadable fleet must not look like a collected one. The caller counts it.
 */
function safeDirectories(directory: string): string[] | null {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('Worktree cleanup: worktrees root unreadable; preserving its topic', { directory, err });
    return null;
  }
}

/** A topic's checkouts, or `null` when its worktrees root could not be read (counted and preserved, never empty). */
function readTopicCheckouts(worktreeRoot: string): TopicCheckout[] | null {
  try {
    return listTopicCheckouts(worktreeRoot);
  } catch (err) {
    log.warn('Worktree cleanup: worktrees root unreadable; preserving its topic', { directory: worktreeRoot, err });
    return null;
  }
}

type InboundMtime = number | 'absent' | 'unknown';

function inboundMtime(filePath: string): InboundMtime {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/**
 * The session inventory through `withRawDb`: synchronous and lease-only. This runs on the host timer, so a bare
 * raw SELECT could silently join a suspended `centralTransaction`. Readers take the lease for the read alone or
 * hold it across a recheck-then-trash span that must stay one synchronous turn.
 */
function sessionInventory(): SessionRow[] | null {
  try {
    return withRawDb(
      (db) =>
        db
          .prepare(
            `SELECT s.id AS session_id, s.agent_group_id, s.status, s.thread_id,
                s.messaging_group_id, mg.platform_id, ag.folder,
                COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id,
                COALESCE(s.last_active, s.created_at) AS idle_since
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
           LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
          )
          .all() as SessionRow[],
    );
  } catch (error) {
    log.error('Worktree cleanup: session inventory failed; preserving every topic', { error });
    return null;
  }
}

function readSessionInventory(): Promise<SessionRow[] | null> {
  return withCentralSync(() => sessionInventory(), 'worktree cleanup inventory');
}

function participantsByTopic(
  dataDir: string,
  rows: SessionRow[] | null,
): Map<string, { unit: RepositoryWorkUnit; participants: TopicParticipant[] }> {
  // A failed inventory is not evidence that nothing is live: preserve everything.
  if (rows === null) return new Map();

  const result = new Map<string, { unit: RepositoryWorkUnit; participants: TopicParticipant[] }>();
  for (const row of rows) {
    try {
      const unit = resolveRepositoryWorkUnit({
        workgroupId: row.workgroup_id,
        sessionId: row.session_id,
        platformId: row.platform_id,
        messagingGroupId: row.messaging_group_id,
        threadId: row.thread_id,
      });
      const key = topicStateDir(unit, dataDir);
      const current = result.get(key) ?? { unit, participants: [] };
      current.participants.push({
        sessionId: row.session_id,
        agentGroupId: row.agent_group_id,
        status: row.status,
        idleSince: row.idle_since,
        inboundMtimeMs: inboundMtime(
          sessionMailboxPath({ agentGroupId: row.agent_group_id, sessionId: row.session_id }, 'inbound'),
        ),
      });
      result.set(key, current);
    } catch (err) {
      log.warn('Worktree cleanup: invalid session repository identity; preserving it', {
        sessionId: row.session_id,
        err,
      });
    }
  }
  return result;
}

export interface DiscoveryResult {
  targets: TopicWorktreeTarget[];
  /** Entries whose names are not valid repository segments, located as `workgroup/work-unit/name`. */
  filteredNames: string[];
  unreadableRoots: number;
}

function discover(dataDir: string, rows: SessionRow[] | null): DiscoveryResult {
  const mapping = participantsByTopic(dataDir, rows);
  const targets: TopicWorktreeTarget[] = [];
  const filteredNames = new Set<string>();
  let unreadableRoots = 0;

  // Only DB-resolvable topics are candidates: missing metadata is never deletion authority.
  for (const [statePath, { unit, participants }] of mapping) {
    if (!fs.existsSync(statePath)) continue;
    const worktreeRoot = topicWorktreesDir(unit, dataDir);
    const checkouts = readTopicCheckouts(worktreeRoot);
    if (checkouts === null) {
      unreadableRoots += 1;
      continue;
    }
    // The worktrees root also holds the storage lease and a pnpm cache; the lister returns only names that parse
    // as `<repo>` or `<repo>@<slug>`. `SAFE_SEGMENT` is a path-traversal boundary and is not widened, but some
    // rejected names are real repos (`.github`), so every skipped directory is reported, not dropped.
    const listed = new Set(checkouts.map((checkout) => checkout.name));
    for (const name of safeDirectories(worktreeRoot) ?? []) {
      if (listed.has(name)) continue;
      filteredNames.add(`${unit.workgroupId}/${unit.kind}-${unit.id}/${name}`);
    }
    for (const checkout of checkouts) {
      targets.push({
        workUnit: unit,
        participants,
        repo: checkout.repo,
        worktreePath: checkout.path,
        shape: checkout.shape,
        canonicalRepoPath: canonicalRepoDir(unit.workgroupId, checkout.repo, dataDir),
      });
    }
  }
  return { targets, filteredNames: [...filteredNames].sort(), unreadableRoots };
}

function participantHasPersistedWork(participant: TopicParticipant, dataDir: string): boolean {
  // Session status is not proof persisted work completed: a continuation, processing claim or current tool
  // retains the worktree independently. Reclaimed means journaled AND inbound.db absent (as in
  // writeSessionMessageLocked): a CAS-lost journal line is still live, and a late inbound write can recreate the
  // root, but nothing recreates inbound.db.
  if (
    sessionWasReclaimed(participant.sessionId, path.join(dataDir, 'v2-sessions')) &&
    !fs.existsSync(
      sessionMailboxPath({ agentGroupId: participant.agentGroupId, sessionId: participant.sessionId }, 'inbound'),
    )
  ) {
    return false;
  }
  try {
    // 5s busy_timeout and hot-journal rollback: without rollback a SIGKILLed container's outbound.db fails every
    // read and would pin the worktree forever. No outbound.db counts as busy (fail closed).
    return (
      readSessionOutbound(
        { agentGroupId: participant.agentGroupId, sessionId: participant.sessionId },
        (mailbox) =>
          mailbox.getProcessingClaimRows().length > 0 ||
          Boolean(mailbox.getContainerState()?.current_tool) ||
          mailbox.hasWorkContinuation(),
        { busyTimeoutMs: 5000, recoverJournal: true },
      ) ?? true
    );
  } catch {
    // Unknown state fails closed.
    return true;
  }
}

function topicIsBusy(participants: TopicParticipant[], dataDir: string): boolean {
  if (participants.length === 0) return true;
  return participants.some(
    (participant) =>
      isContainerRunning(participant.sessionId) ||
      isContainerSpawning(participant.sessionId) ||
      participantHasPersistedWork(participant, dataDir),
  );
}

/**
 * Side (a): is topic ownership clear enough to consider collecting? Every owning row closed (or none), or else
 * EVERY row, closed ones included, idle at least idleReclaimDays: a session closed yesterday is recent activity.
 */
function sideAClear(
  participants: TopicParticipant[] | undefined,
  idleReclaimDays: number,
): { pass: boolean; viaIdle: boolean } {
  if (!participants || participants.length === 0) return { pass: true, viaIdle: false };
  if (participants.every((p) => p.status === 'closed')) return { pass: true, viaIdle: false };
  // `archiving` or any unrecognized/NULL status is transitional: refuse rather than ride a sibling's idle time.
  if (
    idleReclaimDays > 0 &&
    participants.every((p) => p.status === 'closed' || p.status === 'active') &&
    participants.every((p) => daysSince(p.idleSince) >= idleReclaimDays)
  ) {
    return { pass: true, viaIdle: true };
  }
  return { pass: false, viaIdle: false };
}

function transferReferencesPath(
  target: Pick<TopicWorktreeTarget, 'workUnit' | 'repo' | 'worktreePath'>,
  dataDir: string,
): boolean {
  const directory = transferTombstonesDir(target.workUnit.workgroupId, target.repo, dataDir);
  let files: fs.Dirent[];
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    files = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const resolvedTarget = path.resolve(target.worktreePath);
  for (const entry of files) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')) as {
        sourcePath?: unknown;
        destinationPath?: unknown;
      };
      if (
        (typeof parsed.sourcePath === 'string' && path.resolve(parsed.sourcePath) === resolvedTarget) ||
        (typeof parsed.destinationPath === 'string' && path.resolve(parsed.destinationPath) === resolvedTarget)
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function idleDays(directory: string): number {
  try {
    return (Date.now() - fs.statSync(directory).mtimeMs) / 86_400_000;
  } catch {
    return 0;
  }
}

function isLinkedToCanonical(target: TopicWorktreeTarget): boolean {
  try {
    const pointer = fs.lstatSync(path.join(target.worktreePath, '.git'));
    if (!pointer.isFile() || pointer.isSymbolicLink()) return false;
    const common = git(target.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return Boolean(common) && fs.realpathSync(common!) === fs.realpathSync(path.join(target.canonicalRepoPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * Does Git resolve `gitDir`'s common dir to `canonical`'s own `.git`? Asked before host Git runs against a
 * canonical or its admin dirs, since Git follows a `commondir` file. Those admin dirs are container-writable, so
 * this narrows the window rather than closing it. A mismatch or unreadable common dir refuses and logs.
 */
function commonDirIsCanonical(gitDir: string, canonical: string, context: Record<string, unknown>): boolean {
  if (gitCommonDirIs(gitDir, path.join(canonical, '.git'))) return true;
  log.error('Worktree cleanup: refusing a Git dir whose common dir is not its canonical .git (#669: re-raise)', {
    ...context,
    gitDir,
  });
  return false;
}

function branchMayBeRemoved(target: TopicWorktreeTarget): { eligible: boolean; reason: string } {
  const status = git(target.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null || status !== '') return { eligible: false, reason: status === null ? 'status-failed' : 'dirty' };
  const unpushed = git(target.worktreePath, ['log', 'HEAD', '--not', '--remotes', '--oneline']);
  if (unpushed === null || unpushed !== '') {
    return { eligible: false, reason: unpushed === null ? 'log-failed' : 'unpushed' };
  }
  const age = idleDays(target.worktreePath);
  if (age < MINIMUM_IDLE_DAYS) return { eligible: false, reason: 'recent' };

  const branch = git(target.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return { eligible: age >= STALE_WARNING_DAYS, reason: 'detached-remote-contained' };
  const remoteHead = git(target.worktreePath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const merged =
    Boolean(remoteHead) && git(target.worktreePath, ['merge-base', '--is-ancestor', 'HEAD', remoteHead!]) === '';
  const remoteBranch = git(target.worktreePath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const gone = remoteBranch === null;
  return { eligible: merged || gone, reason: merged ? 'merged' : gone ? 'remote-branch-gone' : 'unmerged' };
}

export interface CloneCleanupDecision {
  collected: boolean;
  reason: string;
}

interface Liveness {
  mounts: string[] | null;
  cwds: string[] | null;
}

/** One mount and process-table read per pass; finalizeCloneCollection re-reads both after its rename. */
function passLiveness(): () => Liveness {
  let snapshot: Liveness | undefined;
  return () => (snapshot ??= { mounts: runningContainerMounts(), cwds: liveProcessCwds() });
}

async function cleanupOne(
  target: TopicWorktreeTarget,
  dataDir: string = DATA_DIR,
  liveness: () => Liveness = passLiveness(),
): Promise<CloneCleanupDecision | undefined> {
  if (target.shape === 'clone') return cleanupCloneCheckout(target, dataDir, liveness);
  await cleanupLinkedCheckout(target, dataDir);
  return undefined;
}

/** The dir's own mtime misses a commit, a checkout or an index refresh, so the Git activity files count too. */
const CHECKOUT_ACTIVITY_FILES = ['', '.git/HEAD', '.git/index', '.git/logs/HEAD'];
/** A failed clone proof is reused while its activity files are unchanged, at most this long (a push moves none). */
const FAILED_PROOF_REUSE_MS = 24 * 60 * 60 * 1000;
const failedCloneProofs = new Map<string, { signature: string; at: number; reason: string }>();

function checkoutActivityMtimes(checkoutPath: string): number[] | null {
  const mtimes: number[] = [];
  for (const file of CHECKOUT_ACTIVITY_FILES) {
    try {
      mtimes.push(fs.lstatSync(path.join(checkoutPath, file)).mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      mtimes.push(0);
    }
  }
  return mtimes;
}

function checkoutIdleDays(checkoutPath: string): number {
  const newest = Math.max(0, ...(checkoutActivityMtimes(checkoutPath) ?? [Date.now()]));
  return newest === 0 ? 0 : (Date.now() - newest) / 86_400_000;
}

/**
 * The topic-clone proof, with `liveTopic`: plain `status` calls an ignored export, a `.env` or an edit behind an
 * index flag clean, and an open topic may still want them, so each of those refuses.
 */
function cloneCheckoutProof(target: TopicWorktreeTarget): { ok: boolean; reason: string } {
  const signature = JSON.stringify(checkoutActivityMtimes(target.worktreePath));
  const prior = failedCloneProofs.get(target.worktreePath);
  if (prior && prior.signature === signature && Date.now() - prior.at < FAILED_PROOF_REUSE_MS) {
    return { ok: false, reason: prior.reason };
  }
  const proof = disposability.proveCheckoutDisposable({
    path: target.worktreePath,
    shape: target.shape,
    inheritedTagsRecord: checkoutInheritedTagsPath(target.worktreePath),
    liveTopic: true,
  });
  if (proof.ok) failedCloneProofs.delete(target.worktreePath);
  else failedCloneProofs.set(target.worktreePath, { signature, at: Date.now(), reason: proof.reason });
  return proof;
}

function cloneCheckoutRefusal(target: TopicWorktreeTarget, dataDir: string, liveness: () => Liveness): string | null {
  if (checkoutIdleDays(target.worktreePath) < MINIMUM_IDLE_DAYS) return 'recent';
  if (transferReferencesPath(target, dataDir)) return 'transfer-referenced';
  if (topicIsBusy(target.participants, dataDir)) return 'topic-busy';
  const { mounts, cwds } = liveness();
  if (mounts === null) return 'runtime-unreadable';
  if (relationToMounts(target.worktreePath, mounts) !== 'clear') return 'container-mounted';
  if (cwds === null) return 'process-table-unreadable';
  if (processRootedIn(target.worktreePath, cwds)) return 'process-rooted';
  return null;
}

export interface CloneCheckoutPreview {
  examined: number;
  collectable: Array<{ path: string; bytes: number }>;
  refusals: Record<string, number>;
}

/** The clone branch's decisions without the quarantine or the trash; `null` when the session inventory failed. */
export async function previewCloneCheckoutCleanup(dataDir: string = DATA_DIR): Promise<CloneCheckoutPreview | null> {
  const rows = await readSessionInventory();
  if (rows === null) return null;
  const liveness = passLiveness();
  const preview: CloneCheckoutPreview = { examined: 0, collectable: [], refusals: {} };
  for (const target of discover(dataDir, rows).targets.filter((entry) => entry.shape === 'clone')) {
    preview.examined += 1;
    const refused = cloneCheckoutRefusal(target, dataDir, liveness);
    const proof = refused === null ? cloneCheckoutProof(target) : null;
    if (proof?.ok) {
      preview.collectable.push({ path: target.worktreePath, bytes: dirSizeBytes(target.worktreePath) });
    } else {
      const reason = refused ?? proof!.reason;
      preview.refusals[reason] = (preview.refusals[reason] ?? 0) + 1;
    }
  }
  return preview;
}

/**
 * The clone branch of worktree cleanup, per checkout even in an open topic: a clone with every ref on origin and no
 * kept ignored file is rebuilt by repository_checkout. It needs the topic not busy, nothing mounting or standing in
 * the checkout, MINIMUM_IDLE_DAYS idle, and cloneCheckoutProof; then quarantine, re-prove the
 * moved copy, and trash. Every check re-runs under the lifecycle claim and repository lock repository_checkout
 * holds, so a checkout request cannot reuse the directory mid-collection.
 */
async function cleanupCloneCheckout(
  target: TopicWorktreeTarget,
  dataDir: string,
  liveness: () => Liveness,
): Promise<CloneCleanupDecision> {
  const context = {
    workgroupId: target.workUnit.workgroupId,
    workUnit: target.workUnit.key,
    repo: target.repo,
    path: target.worktreePath,
  };
  const refusal = (): string | null => cloneCheckoutRefusal(target, dataDir, liveness);
  const early = refusal();
  if (early) return { collected: false, reason: early };

  return withRepositoryLifecycleClaims([target.workUnit], () =>
    withHostRepositoryLock(
      target.workUnit.workgroupId,
      target.repo,
      (): CloneCleanupDecision => {
        const late = refusal();
        if (late) return { collected: false, reason: late };
        const proof = cloneCheckoutProof(target);
        if (!proof.ok) {
          if (checkoutIdleDays(target.worktreePath) >= STALE_WARNING_DAYS) {
            log.warn('Worktree cleanup: preserving stale clone checkout', { ...context, reason: proof.reason });
          }
          return { collected: false, reason: proof.reason };
        }
        const finalized = finalizeCloneCollection(
          { path: target.worktreePath },
          dataDir,
          'topic-checkout',
          checkoutInheritedTagsPath(target.worktreePath),
        );
        if (!finalized.ok) return { collected: false, reason: finalized.reason ?? 'finalize-refused' };
        log.info('Worktree cleanup: trashed an idle clean pushed clone checkout', context);
        return { collected: true, reason: proof.reason };
      },
      dataDir,
    ),
  );
}

async function cleanupLinkedCheckout(target: TopicWorktreeTarget, dataDir: string): Promise<void> {
  const context = { workgroupId: target.workUnit.workgroupId, workUnit: target.workUnit.key, repo: target.repo };
  if (topicIsBusy(target.participants, dataDir)) return;
  if (transferReferencesPath(target, dataDir)) return;

  await withRepositoryLifecycleClaims([target.workUnit], () =>
    withHostRepositoryLock(
      target.workUnit.workgroupId,
      target.repo,
      () => {
        if (topicIsBusy(target.participants, dataDir) || transferReferencesPath(target, dataDir)) return;
        if (!isLinkedToCanonical(target)) {
          log.warn('Worktree cleanup: refusing non-linked or mismatched checkout', context);
          return;
        }
        const decision = branchMayBeRemoved(target);
        if (!decision.eligible) {
          if (idleDays(target.worktreePath) >= STALE_WARNING_DAYS) {
            log.warn('Worktree cleanup: preserving stale topic worktree', { ...context, reason: decision.reason });
          }
          return;
        }
        const branch = git(target.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const head = branch ? git(target.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']) : null;
        // The calls below run with the canonical as cwd, where Git reads its own `.git/commondir`: prove that too.
        if (!commonDirIsCanonical(path.join(target.canonicalRepoPath, '.git'), target.canonicalRepoPath, context))
          return;
        execFileSync('git', safeGitArgs(['worktree', 'remove', target.worktreePath]), {
          cwd: target.canonicalRepoPath,
          env: safeGitEnv(),
          stdio: 'pipe',
          timeout: 120_000,
        });
        if (branch === defaultTopicBranch(target.workUnit, target.repo)) {
          if (!head) throw new Error('generated topic branch had no verifiable HEAD during cleanup');
          // Expected-old-value makes deletion fail closed if the ref moved since the eligibility proof.
          execFileSync('git', safeGitArgs(['update-ref', '-d', `refs/heads/${branch}`, head]), {
            cwd: target.canonicalRepoPath,
            env: safeGitEnv(),
            stdio: 'pipe',
            timeout: 30_000,
          });
        }
        log.info('Worktree cleanup: removed inactive clean linked checkout', { ...context, reason: decision.reason });
      },
      dataDir,
    ),
  );
}

export async function runWorktreeCleanupOnce(dataDir: string = DATA_DIR): Promise<void> {
  const { targets, filteredNames, unreadableRoots } = discover(dataDir, await readSessionInventory());
  // A failing target is skipped and counted, never allowed to abort the rest of the fleet's pass.
  let skipped = 0;
  const liveness = passLiveness();
  for (const target of targets) {
    // Each target's git work is synchronous; a macrotask between targets lets message routing run.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      await cleanupOne(target, dataDir, liveness);
    } catch (err) {
      skipped += 1;
      log.warn('Worktree cleanup: target failed; continuing pass', {
        workgroupId: target.workUnit.workgroupId,
        workUnit: target.workUnit.key,
        repo: target.repo,
        err,
      });
    }
  }
  // A pass that collected nothing because of failures, filtering or unreadable roots must not read like one
  // that had nothing to do.
  log.info('Worktree cleanup: pass complete', {
    examined: targets.length,
    skipped,
    filtered: filteredNames.length,
    filteredNames,
    unreadableRoots,
  });
}

// Storage GC: orphaned topic directories and source clones, which the linked-checkout path never considers.
// Removal demands both-sides-positive evidence: the topic is absent from a SUCCESSFUL inventory AND git proves
// the tree clean with nothing unpushed. Anything unprovable is skipped and logged. Dry-run unless
// NANOCLAW_STORAGE_GC=apply.

const GC_APPLY_ENV = 'NANOCLAW_STORAGE_GC';
const TRASH_BIN = '/usr/bin/trash';
/** Written into a quarantined topic so an interrupted pass can find its way home. */
const QUARANTINE_META_FILE = '.gc-quarantine-meta.json';
const CLONE_SCAN_DEPTH = 4;
/** Sizing every skipped topic is a full walk; past this, skips are counted unmeasured so the daily unit stays bounded. */
const SKIP_SIZE_BUDGET_MS = 30 * 60 * 1000;
const RESERVED_WORKGROUP_DIRS = new Set(['.repos', '.worktrees', '.rescues']);

export type GcCategory = 'orphan-topic' | 'clone';

export interface GcCandidate {
  category: GcCategory;
  path: string;
  collect: boolean;
  reason: string;
  bytes: number;
  /**
   * Only for an orphan topic collected via the idle path: scan-time state of every owning participant, re-verified
   * after the move and before the real trash (finalizeIdleCollection).
   */
  idleSnapshot?: Array<{ sessionId: string; status: string; idleSince: string; inboundMtimeMs: InboundMtime }>;
}

export interface GcReport {
  /** false means the inventory failed and NOTHING was evaluated. */
  ran: boolean;
  mode: 'dry-run' | 'apply';
  examined: number;
  collected: number;
  reclaimableBytes: Record<GcCategory, number>;
  skips: Record<string, number>;
  /** Bytes the skipped orphan topics hold, by reason; clone skips are not sized. */
  topicSkipBytes: Record<string, number>;
  unmeasuredSkips: number;
  candidates: GcCandidate[];
}

function emptyReport(mode: 'dry-run' | 'apply', ran: boolean): GcReport {
  return {
    ran,
    mode,
    examined: 0,
    collected: 0,
    reclaimableBytes: { 'orphan-topic': 0, clone: 0 },
    skips: {},
    topicSkipBytes: {},
    unmeasuredSkips: 0,
    candidates: [],
  };
}

function gcMode(): 'dry-run' | 'apply' {
  return process.env[GC_APPLY_ENV] === 'apply' ? 'apply' : 'dry-run';
}

/**
 * Ignored output a clean, fully pushed checkout may take to the trash. Wider than REGENERABLE_SWEEP_DIR_NAMES on
 * purpose: that set lets the regenerable sweep delete from live checkouts with no git proof, so it stays narrow.
 */
const RECLAIM_IGNORABLE_DIR_NAMES: ReadonlySet<string> = new Set([
  ...REGENERABLE_SWEEP_DIR_NAMES,
  'allure-results',
  'dist',
  '.pytest_cache',
  '.ruff_cache',
]);
const RECLAIM_IGNORABLE_FILE_SUFFIX = '.tsbuildinfo';

/** `entry` is a porcelain path; a wholly ignored directory arrives collapsed, with a trailing `/`. */
function reclaimIgnorable(entry: string): boolean {
  const isDirectory = entry.endsWith('/');
  const segments = entry.split('/').filter(Boolean);
  if (!isDirectory && segments.at(-1)?.endsWith(RECLAIM_IGNORABLE_FILE_SUFFIX)) return true;
  return (isDirectory ? segments : segments.slice(0, -1)).some((segment) => RECLAIM_IGNORABLE_DIR_NAMES.has(segment));
}

/**
 * A `git worktree lock` marker makes a checkout non-disposable: the agent said "don't touch", and `worktree prune`
 * (git 2.43) keeps a locked registration even once its path is gone. No-op for a plain clone.
 */
function isWorktreeLocked(dir: string): boolean {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], checkoutGitEnv(dir));
  return gitDir !== null && fs.existsSync(path.join(gitDir, 'locked'));
}

/**
 * Positive proof that a checkout holds nothing worth keeping; reach it through proveCheckoutDisposable. A git
 * invocation that fails (pruned admin dir, container-only gitdir) returns unprovable, never clean.
 */
function provenDisposable(
  dir: string,
  scope: 'head' | 'all',
  inheritedTags: ReadonlyMap<string, string> | null = null,
  liveTopic = false,
): { ok: boolean; reason: string } {
  if (isWorktreeLocked(dir)) return { ok: false, reason: 'worktree-locked' };
  const env = checkoutGitEnv(dir);

  // Host git runs in a repository a container may have configured: signature programs are off and every filter
  // is neutralized by name. An embedded repository is refused before `status` could recurse into it; one whose
  // config or index cannot be read is unprovable.
  const filters = repositoryFilterNames(dir, env);
  if (filters === null) return { ok: false, reason: 'status-unprovable' };
  const modes = git(dir, ['ls-files', '-z', '--format=%(objectmode)'], env, filters);
  if (modes === null) return { ok: false, reason: 'status-unprovable' };
  if (modes.split('\0').includes('160000')) return { ok: false, reason: 'submodule' };

  const status = git(
    dir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    env,
    filters,
  );
  if (status === null) return { ok: false, reason: 'status-unprovable' };
  if (status !== '') return { ok: false, reason: 'dirty' };
  if (liveTopic) {
    // `status` reads a skip-worktree or assume-unchanged entry as clean whatever its file holds.
    const tags = git(dir, ['ls-files', '-v', '-z'], env, filters);
    if (tags === null) return { ok: false, reason: 'status-unprovable' };
    if (tags.split('\0').some((entry) => entry !== '' && !entry.startsWith('H '))) {
      return { ok: false, reason: 'index-flagged' };
    }
    const ignored = git(
      dir,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=traditional',
        '--untracked-files=normal',
        '--ignore-submodules=all',
      ],
      env,
      filters,
    );
    if (ignored === null) return { ok: false, reason: 'status-unprovable' };
    const kept = ignored
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .some((entry) => !reclaimIgnorable(entry.slice(3)));
    if (kept) return { ok: false, reason: 'ignored-files' };
  }

  const stashVerdict = (): { ok: boolean; reason: string } | null => {
    const stash = git(dir, ['stash', 'list'], env);
    if (stash === null) return { ok: false, reason: 'stash-unprovable' };
    return stash === '' ? null : { ok: false, reason: 'stashed' };
  };
  // For a clone the stash is read before the log below, which counts refs/stash too and would call it 'unpushed'.
  if (scope === 'all') {
    const stashed = stashVerdict();
    if (stashed) return stashed;
  }

  // Scope 'all': every local ref's commits must be on origin. `--all` covers tags, notes and a detached HEAD,
  // which `--branches` would miss; HEAD stays explicit because `--all` alone exits 0 silently on an unborn HEAD.
  // Only origin counts as evidence: another remote can hold commits no real remote has. Scope 'head' checks HEAD
  // against every remote-tracking ref. Exception: tags the host recorded when it built the clone, still at the
  // same object, are the canonical's (a release tag off every branch would otherwise keep every clone forever).
  // The record is host-only; matching name and object only drops roots, so a commit another ref holds still counts.
  let unpushed: string | null;
  if (scope === 'all' && inheritedTags !== null && inheritedTags.size > 0) {
    const refs = git(dir, ['for-each-ref', '--format=%(objectname) %(refname)'], env);
    if (refs === null) return { ok: false, reason: 'log-unprovable' };
    const roots = refs
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf(' ');
        const object = line.slice(0, separator);
        return inheritedTags.get(line.slice(separator + 1)) === object ? [] : [`${object}\n`];
      });
    unpushed = git(dir, ['log', '--oneline', 'HEAD', '--stdin', '--not', '--remotes=origin'], env, [], roots.join(''));
  } else {
    const unpushedArgs =
      scope === 'all'
        ? ['log', '--all', 'HEAD', '--not', '--remotes=origin', '--oneline']
        : ['log', 'HEAD', '--not', '--remotes', '--oneline'];
    unpushed = git(dir, unpushedArgs, env);
  }
  if (unpushed === null) return { ok: false, reason: 'log-unprovable' };
  if (unpushed !== '') return { ok: false, reason: 'unpushed' };

  if (scope === 'head') {
    const stashed = stashVerdict();
    if (stashed) return stashed;
  }

  // A clone backing linked worktrees owns their shared object store. Asked here (git's own registry) rather than
  // only at scan time, so the post-move re-proof catches a `git worktree add` made in between. Clones only.
  if (scope === 'all') {
    const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
    if (gitDir === null) return { ok: false, reason: 'gitdir-unprovable' };
    const registered = safeDirectories(path.join(gitDir, 'worktrees'));
    // null is "exists but unreadable": unprovable, not empty.
    if (registered === null && fs.existsSync(path.join(gitDir, 'worktrees'))) {
      return { ok: false, reason: 'worktree-registry-unprovable' };
    }
    if (registered !== null && registered.length > 0) return { ok: false, reason: 'backs-worktrees' };
  }

  return { ok: true, reason: 'clean-and-pushed' };
}

/**
 * The one disposability primitive: a clone is proved at scope `all`, a linked worktree at its HEAD, and an
 * undecided shape is refused. Only a topic clone has an inherited-tags record; without one every tag counts.
 */
export function proveCheckoutDisposable(
  checkout: Pick<TopicCheckout, 'path' | 'shape'> & { inheritedTagsRecord?: string | null; liveTopic?: boolean },
): {
  ok: boolean;
  reason: string;
} {
  if (checkout.shape === 'clone') {
    // The record survives a quarantine rename, so the moved copy's re-proof still matches it.
    const inherited = checkout.inheritedTagsRecord
      ? readCheckoutInheritedTags(checkout.inheritedTagsRecord, checkout.path)
      : null;
    return disposability.provenDisposable(checkout.path, 'all', inherited, checkout.liveTopic);
  }
  if (checkout.shape === 'linked') return disposability.provenDisposable(checkout.path, 'head');
  return { ok: false, reason: 'unknown-shape' };
}

/** Every proof is called through this object so a spy sees each one. */
export const disposability = { provenDisposable, proveCheckoutDisposable };

/** Directories with a real .git DIRECTORY. Symlinks are never candidates (a container-absolute link dangles). */
function isPrivateClone(dir: string): boolean {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    return fs.lstatSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A checkout whose `.git` file points somewhere the host cannot follow (a container-only `gitdir:`). Never
 * removable; reported so the unreclaimable mass is visible, and never walked for nested repositories.
 */
function isUnprovableCheckout(dir: string): boolean {
  let pointer: string;
  try {
    const marker = fs.lstatSync(path.join(dir, '.git'));
    if (!marker.isFile() || marker.isSymbolicLink()) return false;
    pointer = fs.readFileSync(path.join(dir, '.git'), 'utf8').trim();
  } catch {
    return false;
  }
  if (!pointer.startsWith('gitdir:')) return false;
  const target = pointer.slice('gitdir:'.length).trim();
  const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
  return !fs.existsSync(resolved);
}

interface CloneScan {
  clones: string[];
  unprovable: string[];
}

function findClonesUnder(root: string, depth: number, found: CloneScan = { clones: [], unprovable: [] }): CloneScan {
  if (depth < 0) return found;
  for (const name of safeDirectories(root) ?? []) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = path.join(root, name);
    if (isPrivateClone(dir)) {
      found.clones.push(dir);
      continue; // Never descend into a repository looking for more repositories.
    }
    if (isUnprovableCheckout(dir)) {
      found.unprovable.push(dir);
      continue;
    }
    findClonesUnder(dir, depth - 1, found);
  }
  return found;
}

/**
 * Every host path a linked worktree is bound to, as gitdir prefixes: a clone backing one is not collectable.
 * `unreadable` makes every clone unprovable rather than silently collectable.
 */
function boundGitDirs(dataDir: string): { pointers: string[]; unreadable: boolean } {
  const bases = ['v2-topics', 'v2-threads', 'v2-sessions', 'workgroups'].map((name) => path.join(dataDir, name));
  const pointers: string[] = [];
  let unreadable = false;
  const walk = (dir: string, depth: number): void => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((entry) => entry.name === '.git' && !entry.isSymbolicLink());
    if (dotGit?.isFile()) {
      try {
        const line = fs.readFileSync(path.join(dir, '.git'), 'utf8').trim();
        if (line.startsWith('gitdir:')) pointers.push(line.slice('gitdir:'.length).trim());
      } catch {
        unreadable = true;
      }
    }
    // Descending into a checkout would walk its whole working tree on every pass.
    if (dotGit) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const base of bases) walk(base, 5);
  return { pointers, unreadable };
}

function cloneHasBoundWorktrees(cloneDir: string, index: { pointers: string[]; unreadable: boolean }): boolean {
  if (index.unreadable) return true;
  let canonical: string;
  try {
    canonical = fs.realpathSync(path.join(cloneDir, '.git'));
  } catch {
    return true; // Cannot prove nothing is bound.
  }
  return index.pointers.some((pointer) => {
    if (!path.isAbsolute(pointer)) return true;
    let resolved = pointer;
    try {
      resolved = fs.realpathSync(pointer);
    } catch {
      // Unresolvable on the host: fall back to a textual prefix test on the raw value.
    }
    return resolved === canonical || resolved.startsWith(`${canonical}${path.sep}`);
  });
}

function record(report: GcReport, candidate: GcCandidate): void {
  report.examined += 1;
  report.candidates.push(candidate);
  if (candidate.collect) {
    report.collected += 1;
    report.reclaimableBytes[candidate.category] += candidate.bytes;
  } else {
    report.skips[candidate.reason] = (report.skips[candidate.reason] ?? 0) + 1;
  }
}

/** Report-only, so it runs after the apply loop: a full walk here would sit between a topic's proof and its trash. */
function sizeSkippedTopics(report: GcReport, skipped: GcCandidate[]): void {
  const deadline = Date.now() + SKIP_SIZE_BUDGET_MS;
  for (const candidate of skipped) {
    if (Date.now() >= deadline) {
      report.unmeasuredSkips += 1;
      continue;
    }
    candidate.bytes = dirSizeBytes(candidate.path);
    report.topicSkipBytes[candidate.reason] = (report.topicSkipBytes[candidate.reason] ?? 0) + candidate.bytes;
  }
}

/**
 * Everything under a topic's `worktrees/` that must be proved disposable, or `null` when unreadable. Directories
 * the lister skips come back as shape `unknown` and are refused; an entry created between the two reads shows up
 * only in the second, as `unknown`, so that race refuses the topic.
 */
function topicDisposabilityProbes(worktreeRoot: string): Array<Pick<TopicCheckout, 'path' | 'shape'>> | null {
  const checkouts = readTopicCheckouts(worktreeRoot);
  if (checkouts === null) return null;
  const names = safeDirectories(worktreeRoot);
  if (names === null) return null;
  const listed = new Set(checkouts.map((checkout) => checkout.name));
  const others = names
    .filter((name) => !listed.has(name))
    .map((name) => ({ path: path.join(worktreeRoot, name), shape: 'unknown' as const }));
  return [...checkouts, ...others];
}

function collectOrphanTopics(
  report: GcReport,
  dataDir: string,
  owners: Map<string, TopicParticipant[]>,
): GcCandidate[] {
  const topicsRoot = path.join(dataDir, 'v2-topics');
  const idleReclaimDays = topicIdleReclaimDays();
  const skipped: GcCandidate[] = [];
  for (const workgroupId of safeDirectories(topicsRoot) ?? []) {
    const workgroupDir = path.join(topicsRoot, workgroupId);
    for (const topic of safeDirectories(workgroupDir) ?? []) {
      const topicDir = path.join(workgroupDir, topic);
      const skip = (reason: string): void => {
        const candidate: GcCandidate = { category: 'orphan-topic', path: topicDir, collect: false, reason, bytes: 0 };
        record(report, candidate);
        skipped.push(candidate);
      };

      const participants = owners.get(topicDir);
      // Status alone is not enough: a closed session can hold a claim or continuation; `topicIsBusy` fails closed.
      const { pass, viaIdle: collectedViaIdle } = sideAClear(participants, idleReclaimDays);
      if (!pass) {
        skip('topic-open');
        continue;
      }
      if (participants && topicIsBusy(participants, dataDir)) {
        skip('topic-busy');
        continue;
      }
      const worktreeRoot = path.join(topicDir, 'worktrees');
      // Idle days come from worktrees/ only: a bulk touch on the parent bumps every topic dir's mtime, which would
      // disable this gate fleet-wide. An unstatable worktrees/ reads as brand new and refuses.
      if (idleDays(worktreeRoot) < MINIMUM_IDLE_DAYS) {
        skip('recent');
        continue;
      }

      // The one enumeration that must not fall back to []: it authorizes a deletion, so an unreadable root must
      // not read as empty.
      const probes = topicDisposabilityProbes(worktreeRoot);
      if (probes === null) {
        skip('worktrees-unreadable');
        continue;
      }
      let refused: string | null = null;
      for (const probe of probes) {
        const decision = disposability.proveCheckoutDisposable({
          ...probe,
          inheritedTagsRecord: probe.shape === 'clone' ? checkoutInheritedTagsPath(probe.path) : null,
        });
        if (!decision.ok) {
          refused = decision.reason;
          break;
        }
      }
      if (refused) {
        skip(refused);
        continue;
      }
      record(report, {
        category: 'orphan-topic',
        path: topicDir,
        collect: true,
        reason: collectedViaIdle ? 'idle-and-clean' : participants ? 'closed-and-clean' : 'orphaned-and-clean',
        bytes: dirSizeBytes(topicDir),
        idleSnapshot: collectedViaIdle
          ? participants!.map((p) => ({
              sessionId: p.sessionId,
              status: p.status,
              idleSince: p.idleSince,
              inboundMtimeMs: p.inboundMtimeMs,
            }))
          : undefined,
      });
    }
  }
  return skipped;
}

function collectClones(
  report: GcReport,
  dataDir: string,
  groupsDir: string,
  bound: { pointers: string[]; unreadable: boolean },
): void {
  const candidates: Array<{ dir: string; folder: string | null; workgroupId: string | null }> = [];

  for (const folder of safeDirectories(groupsDir) ?? []) {
    const folderDir = path.join(groupsDir, folder);
    const scan = findClonesUnder(folderDir, CLONE_SCAN_DEPTH);
    for (const dir of scan.clones) candidates.push({ dir, folder, workgroupId: null });
    for (const dir of scan.unprovable) {
      record(report, { category: 'clone', path: dir, collect: false, reason: 'keep-unprovable', bytes: 0 });
    }
  }

  const workgroupsRoot = path.join(dataDir, 'workgroups');
  for (const workgroupId of safeDirectories(workgroupsRoot) ?? []) {
    const workgroupDir = path.join(workgroupsRoot, workgroupId);
    for (const name of safeDirectories(workgroupDir) ?? []) {
      if (RESERVED_WORKGROUP_DIRS.has(name) || name.startsWith('.')) continue;
      const dir = path.join(workgroupDir, name);
      if (isPrivateClone(dir)) candidates.push({ dir, folder: null, workgroupId });
    }
  }

  for (const candidate of candidates) {
    const skip = (reason: string): void =>
      record(report, { category: 'clone', path: candidate.dir, collect: false, reason, bytes: 0 });

    // Group or workgroup liveness is not a gate: `groups/<folder>` is mounted into every container of the group,
    // so it would refuse every clone forever. Apply mode decides per path (mount relation plus a process scan),
    // re-verified after the quarantine rename.
    if (idleDays(candidate.dir) < CLONE_IDLE_RECLAIM_DAYS) {
      skip('recent');
      continue;
    }
    if (cloneHasBoundWorktrees(candidate.dir, bound)) {
      skip('bound-worktrees');
      continue;
    }
    const decision = disposability.proveCheckoutDisposable({ path: candidate.dir, shape: 'clone' });
    if (!decision.ok) {
      skip(decision.reason);
      continue;
    }
    record(report, {
      category: 'clone',
      path: candidate.dir,
      collect: true,
      reason: 'clean-and-pushed',
      bytes: dirSizeBytes(candidate.dir),
    });
  }
}

/** Recoverable removal (`trash`, 30-day tmpfiles.d cap); `rm` is blocked by the deployed guard. */
function trashPath(target: string): void {
  execFileSync(TRASH_BIN, [target], { stdio: 'pipe', timeout: 120_000 });
}

/**
 * Only correct while bind-mount sources live on the filesystem mounted at `/`: the fourth mountinfo field is a
 * path within the SOURCE filesystem. Elsewhere a translated path misses rather than misfires; the git re-proof on
 * the moved copy is the real safeguard.
 */
function resolveHostPathFromMountinfo(raw: string, cwd: string): string | null {
  let best: { mountpoint: string; root: string } | null = null;
  for (const line of raw.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 5) continue;
    const root = fields[3];
    const mountpoint = fields[4];
    if (cwd !== mountpoint && !cwd.startsWith(`${mountpoint === '/' ? '' : mountpoint}${path.sep}`)) continue;
    if (!best || mountpoint.length > best.mountpoint.length) best = { mountpoint, root };
  }
  if (!best) return null;
  const suffix = cwd.slice(best.mountpoint === '/' ? 0 : best.mountpoint.length);
  return path.posix.join(best.root, suffix);
}

/**
 * Maps a process cwd from its mount namespace to the host path. `undefined` means the process exited (it holds
 * nothing); `null` is a read failure on a live process, which refuses the whole pass. Collapsing the two would
 * let any short-lived command abort a GC pass.
 */
function hostPathForProcessCwd(pid: string, cwd: string, procRoot: string): string | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(procRoot, pid, 'mountinfo'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    return null;
  }
  return resolveHostPathFromMountinfo(raw, cwd);
}

/**
 * Host paths that some running process is rooted in (a git lock is not a liveness signal here). An unreadable
 * cwd contributes nothing (root/system processes never hold a scratch clone); a visible pid we cannot place fails
 * the pass.
 */
function liveProcessCwds(procRoot = '/proc'): string[] | null {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return null; // Cannot enumerate the process table at all.
  }
  const roots: string[] = [];
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd'));
    } catch {
      continue; // Unreadable or exited between readdir and readlink.
    }
    if (!path.isAbsolute(cwd)) continue;
    const host = hostPathForProcessCwd(pid, cwd, procRoot);
    if (host === undefined) continue; // Exited mid-scan; it holds nothing.
    if (host === null) return null;
    // Keep the raw cwd too: a host process's cwd is already a host path, and a separate-device mount can
    // mistranslate. A spurious entry only ever refuses a candidate.
    roots.push(cwd);
    if (host !== cwd) roots.push(host);
  }
  return roots;
}

function processRootedIn(target: string, cwds: string[]): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return true; // A path we cannot resolve is a path we cannot clear.
  }
  return cwds.some((cwd) => cwd === resolved || cwd.startsWith(`${resolved}${path.sep}`));
}

/**
 * 'is-mount-source': the target is or contains a running container's mount source; never removable.
 * 'inside-mount-source': it lives under one (every scratch clone in an active group does); the idle + git proof
 * and the quarantine recheck decide. 'clear': no overlap.
 */
type MountRelation = 'is-mount-source' | 'inside-mount-source' | 'clear';

function mountRelation(resolvedTarget: string, mounts: string[]): MountRelation {
  let relation: MountRelation = 'clear';
  for (const mount of mounts) {
    let source = mount;
    try {
      source = fs.realpathSync(mount);
    } catch {
      // A mount source gone from the host still names the tree the container was given.
    }
    if (source === resolvedTarget || source.startsWith(`${resolvedTarget}${path.sep}`)) {
      return 'is-mount-source';
    }
    if (resolvedTarget.startsWith(`${source}${path.sep}`)) relation = 'inside-mount-source';
  }
  return relation;
}

function relationToMounts(target: string, mounts: string[]): MountRelation {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return 'is-mount-source'; // A path we cannot resolve is a path we cannot clear.
  }
  return mountRelation(resolved, mounts);
}

function overlapsAny(target: string, mounts: string[]): boolean {
  return relationToMounts(target, mounts) !== 'clear';
}

/**
 * Every entry name in `directory` (not only directories), sorted; `[]` when absent, `null` when unreadable. A
 * rollback must see everything the quarantine holds.
 */
function quarantineEntryNames(directory: string): string[] | null {
  try {
    return fs.readdirSync(directory).sort();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

/** Best-effort: puts a topic's recovery marker back, so recoverOrphanedQuarantine can still find the entry. */
function rewriteQuarantineMarker(quarantinePath: string, originalPath: string): void {
  try {
    fs.writeFileSync(path.join(quarantinePath, QUARANTINE_META_FILE), JSON.stringify({ originalPath }));
  } catch (err) {
    log.error('Storage GC: could not put a quarantine recovery marker back', { quarantinePath, err });
  }
}

/**
 * Put one quarantined entry back at `to`, or trash it when a live copy holds that slot. True once it left
 * quarantine. `deregistration` is set only for a linked worktree, whose trashed copy leaves a registration.
 */
function restoreQuarantinedEntry(
  from: string,
  to: string,
  deregistration: PendingWorktreeRemoval | null,
  pendingRemovals: PendingWorktreeRemoval[],
): boolean {
  const entry = path.basename(from);
  if (fs.existsSync(to)) {
    log.warn('Storage GC: idle-topic rollback found the destination already recreated; keeping the live copy', {
      entry,
      to,
    });
    // A locked copy is never trashed: leave it in quarantine.
    if (isWorktreeLocked(from)) {
      log.warn('Storage GC: superseded quarantine copy is locked; leaving it in quarantine, not trashing', {
        entry,
        from,
      });
      return false;
    }
    try {
      trashPath(from);
    } catch (err) {
      log.error('Storage GC: could not trash a superseded quarantine copy', { entry, from, err });
      return false;
    }
    if (deregistration) pendingRemovals.push(deregistration);
    return true;
  }
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    log.error('Storage GC: idle-topic rollback rename failed for one entry; trashing that copy instead', {
      entry,
      from,
      to,
      err,
    });
  }
  try {
    trashPath(from);
  } catch (trashErr) {
    log.error('Storage GC: could not even trash the stranded quarantine copy', { entry, from, err: trashErr });
    return false;
  }
  if (deregistration) pendingRemovals.push(deregistration);
  return true;
}

/**
 * Roll a quarantined topic back. Every topic here passed the disposability proof, so the only harms are stuck
 * states; every branch ends in one the next spawn can build from. What occupies the original path decides: while
 * nothing does, the topic goes back in one rename; once a spawn has recreated it, each entry goes back on its own,
 * and an occupied slot keeps the live copy and trashes the quarantined one unless locked. A trashed linked copy
 * has only its exact registration removed: repository-wide prune is forbidden, since another missing registration
 * can hold an agent's only staged index. The marker goes only once nothing it describes is left in quarantine.
 */
function reconcileQuarantine(candidate: GcCandidate, quarantinePath: string, dataDir: string): void {
  if (!fs.existsSync(quarantinePath)) return;
  const marker = path.join(quarantinePath, QUARANTINE_META_FILE);

  if (!fs.existsSync(candidate.path)) {
    // Never let the recovery marker itself land back inside a restored topic.
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      // Best-effort: a leftover marker is a leak, not a correctness issue.
    }
    try {
      fs.renameSync(quarantinePath, candidate.path);
      return;
    } catch (err) {
      rewriteQuarantineMarker(quarantinePath, candidate.path);
      if (!fs.existsSync(candidate.path)) {
        log.error('Storage GC: idle-topic rollback rename failed; leaving the topic in quarantine for a retry', {
          quarantinePath,
          original: candidate.path,
          err,
        });
        return;
      }
      // Recreated between the check and the rename: go back entry by entry.
    }
  }

  const workgroupId = path.basename(path.dirname(candidate.path));
  const pendingRemovals: PendingWorktreeRemoval[] = [];
  const topLevel = quarantineEntryNames(quarantinePath);
  let leftBehind = topLevel === null;
  for (const name of topLevel ?? []) {
    if (name === QUARANTINE_META_FILE) continue;
    if (name !== 'worktrees') {
      if (!restoreQuarantinedEntry(path.join(quarantinePath, name), path.join(candidate.path, name), null, [])) {
        leftBehind = true;
      }
      continue;
    }
    const quarantineWorktrees = path.join(quarantinePath, name);
    const entries = quarantineEntryNames(quarantineWorktrees);
    if (entries === null) {
      leftBehind = true;
      continue;
    }
    // Only a linked entry is registered with a canonical. A read failure here loses only deregistrations.
    const linkedRepo = new Map(
      (readTopicCheckouts(quarantineWorktrees) ?? [])
        .filter((checkout) => checkout.shape === 'linked')
        .map((checkout) => [checkout.name, checkout.repo] as const),
    );
    const destWorktrees = path.join(candidate.path, 'worktrees');
    if (entries.length > 0) fs.mkdirSync(destWorktrees, { recursive: true });
    let worktreesLeftBehind = false;
    for (const entry of entries) {
      const to = path.join(destWorktrees, entry);
      const repo = linkedRepo.get(entry);
      const deregistration = repo === undefined ? null : { workgroupId, repo, worktreePath: to };
      if (!restoreQuarantinedEntry(path.join(quarantineWorktrees, entry), to, deregistration, pendingRemovals)) {
        worktreesLeftBehind = true;
      }
    }
    if (worktreesLeftBehind) {
      leftBehind = true;
      continue;
    }
    try {
      fs.rmdirSync(quarantineWorktrees);
    } catch {
      leftBehind = true; // Something is still in there: keep the marker.
    }
  }

  if (leftBehind) {
    log.warn('Storage GC: idle-topic rollback left entries in quarantine; keeping its recovery marker for a retry', {
      quarantinePath,
      original: candidate.path,
    });
  } else {
    // Only now is nothing the marker describes left in quarantine.
    try {
      fs.rmSync(marker, { force: true });
      fs.rmdirSync(quarantinePath);
    } catch {
      // Best-effort: a marker-only entry left here is reconciled next pass.
    }
  }

  for (const pending of pendingRemovals) {
    if (!removeMissingWorktreeRegistration(pending, dataDir)) {
      const prior = readPendingPrunes(dataDir);
      if (!writePendingPrunes(dataDir, [...prior, pending])) {
        log.error('Storage GC: could not journal an exact rollback deregistration retry', { ...pending });
      }
    }
  }
}

function inboundAdvanced(prior: InboundMtime, current: InboundMtime): boolean {
  if (prior === 'unknown' || current === 'unknown') return true;
  if (prior === 'absent') return current !== 'absent';
  return current === 'absent' || current > prior;
}

/** Durable record of the exact deregistrations a trash requires, so a crash after the trash is recoverable. */
const PENDING_PRUNE_FILE = '.gc-pending-prunes.json';

interface PendingWorktreeRemoval {
  workgroupId: string;
  repo: string;
  /** Older journals omit this and are recovered conservatively. */
  worktreePath?: string;
}

function pendingPrunePath(dataDir: string): string {
  return path.join(dataDir, PENDING_PRUNE_FILE);
}

/** Best-effort: a read failure costs only this pass's crash-recovery net. */
function readPendingPrunes(dataDir: string): PendingWorktreeRemoval[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pendingPrunePath(dataDir), 'utf8'));
    return Array.isArray(raw)
      ? (raw.filter((entry) => typeof entry === 'object' && entry !== null) as PendingWorktreeRemoval[])
      : [];
  } catch {
    return [];
  }
}

/** Whether the write landed; callers about to trash must abort on `false`. */
function writePendingPrunes(dataDir: string, entries: PendingWorktreeRemoval[]): boolean {
  const target = pendingPrunePath(dataDir);
  try {
    if (entries.length === 0) {
      fs.rmSync(target, { force: true });
    } else {
      // Write-then-rename, so a partial write never truncates the existing journal.
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, target);
    }
    return true;
  } catch (err) {
    log.warn('Storage GC: could not update the pending-prune journal', { err });
    return false;
  }
}

interface MissingWorktreeAdminRecord {
  adminDir: string;
  owner: string;
  gitdir: string;
}

/** Read Git's private linked-worktree records without letting `prune` make a repository-wide decision. */
function linkedWorktreeAdminRecords(canonical: string): MissingWorktreeAdminRecord[] | null {
  try {
    const gitDir = fs.lstatSync(path.join(canonical, '.git'));
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const root = path.join(canonical, '.git', 'worktrees');
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const records: MissingWorktreeAdminRecord[] = [];
  try {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
      const adminDir = path.join(root, entry.name);
      const pointer = path.join(adminDir, 'gitdir');
      const stat = fs.lstatSync(pointer);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const gitdir = fs.readFileSync(pointer, 'utf8').trim();
      if (!path.isAbsolute(gitdir) || path.basename(gitdir) !== '.git') return null;
      records.push({ adminDir, owner: path.dirname(path.resolve(gitdir)), gitdir });
    }
    return records;
  } catch {
    return null;
  }
}

function linkedIndexMatchesHead(canonical: string, adminDir: string): boolean | null {
  try {
    execFileSync('git', safeGitArgs([`--git-dir=${adminDir}`, 'diff-index', '--cached', '--quiet', 'HEAD', '--']), {
      cwd: canonical,
      env: safeGitEnv(),
      stdio: 'pipe',
      timeout: 30_000,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    return null;
  }
}

function linkedHeadIsAncestorOf(canonical: string, adminDir: string, integrationRef: string): boolean | null {
  try {
    execFileSync('git', safeGitArgs([`--git-dir=${adminDir}`, 'merge-base', '--is-ancestor', 'HEAD', integrationRef]), {
      cwd: canonical,
      env: safeGitEnv(),
      stdio: 'pipe',
      timeout: 30_000,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    return null;
  }
}

function pathIsMissing(target: string): boolean | null {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    return null;
  }
}

function linkedAdminIsLocked(adminDir: string): boolean | null {
  try {
    fs.lstatSync(path.join(adminDir, 'locked'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return null;
  }
}

/**
 * Remove one exact missing registration after re-proving its private index has no staged state and no lock. The
 * branch ref and every commit remain intact.
 */
function removeMissingWorktreeRegistration(
  entry: PendingWorktreeRemoval,
  dataDir: string,
  requiredAncestor?: string,
): boolean {
  if (
    typeof entry.workgroupId !== 'string' ||
    typeof entry.repo !== 'string' ||
    typeof entry.worktreePath !== 'string' ||
    !path.isAbsolute(entry.worktreePath) ||
    parseCheckoutDirName(path.basename(entry.worktreePath))?.repo !== entry.repo ||
    path.basename(path.dirname(entry.worktreePath)) !== 'worktrees'
  ) {
    return false;
  }
  let restoreEmptyDirectory = false;
  const missing = pathIsMissing(entry.worktreePath);
  if (missing === null) return false;
  if (!missing) {
    try {
      const stat = fs.lstatSync(entry.worktreePath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(entry.worktreePath).length !== 0) return false;
      // A spawn can recreate an empty slot before rollback completes; rmdir atomically proves it holds no data.
      fs.rmdirSync(entry.worktreePath);
      restoreEmptyDirectory = true;
    } catch {
      return false;
    }
  }
  const restorePlaceholder = (): boolean => {
    if (!restoreEmptyDirectory) return true;
    try {
      fs.mkdirSync(entry.worktreePath!, { recursive: true });
      return true;
    } catch (error) {
      log.warn('Storage GC: could not restore an empty topic placeholder after deregistration', {
        worktreePath: entry.worktreePath,
        error,
      });
      return false;
    }
  };
  let canonical: string;
  try {
    canonical = canonicalRepoDir(entry.workgroupId, entry.repo, dataDir);
  } catch {
    restorePlaceholder();
    return false;
  }
  const records = linkedWorktreeAdminRecords(canonical);
  if (records === null) {
    restorePlaceholder();
    return false;
  }
  const target = records.find((record) => path.resolve(record.owner) === path.resolve(entry.worktreePath!));
  if (!target) {
    return restorePlaceholder();
  }
  // Git follows a `commondir` in the admin dir and in the canonical: prove both below.
  const proveContext = { workgroupId: entry.workgroupId, repo: entry.repo, worktreePath: entry.worktreePath };
  if (
    !commonDirIsCanonical(path.join(canonical, '.git'), canonical, proveContext) ||
    !commonDirIsCanonical(target.adminDir, canonical, proveContext)
  ) {
    restorePlaceholder();
    return false;
  }
  if (linkedAdminIsLocked(target.adminDir) !== false || linkedIndexMatchesHead(canonical, target.adminDir) !== true) {
    restorePlaceholder();
    return false;
  }
  let lockFd: number | null = null;
  let adminFd: number | null = null;
  try {
    const lockPath = ensureRepositoryLock(entry.workgroupId, entry.repo, dataDir);
    lockFd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    adminFd = fs.openSync(target.adminDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const lockStat = fs.fstatSync(lockFd);
    const adminStat = fs.fstatSync(adminFd);
    if (!lockStat.isFile() || !adminStat.isDirectory()) throw new Error('repository cleanup lock state is invalid');

    // `flock` on the same inode container create_worktree uses; fds 3 and 4 pin the lock/admin identities, so a
    // cooperating writer cannot swap in a recreated worktree between this re-proof and the removal (an uncooperative
    // process is not excluded).
    const script = [
      'set -eu',
      'lock_path=$1',
      'admin=$2',
      'owner=$3',
      'expected_gitdir=$4',
      'canonical=$5',
      'required_ancestor=$6',
      'shift 6',
      '[ "$lock_path" -ef /dev/fd/3 ] || exit 73',
      '[ "$admin" -ef /dev/fd/4 ] || exit 74',
      '[ ! -e "$owner" ] && [ ! -L "$owner" ] || exit 75',
      '[ ! -e "$admin/locked" ] && [ ! -L "$admin/locked" ] || exit 76',
      'IFS= read -r actual_gitdir < "$admin/gitdir" || exit 77',
      '[ "$actual_gitdir" = "$expected_gitdir" ] || exit 78',
      'git "$@" --git-dir="$admin" diff-index --cached --quiet HEAD -- || exit 79',
      'if [ -n "$required_ancestor" ]; then git "$@" --git-dir="$admin" merge-base --is-ancestor HEAD "$required_ancestor" || exit 80; fi',
      'exec git "$@" -C "$canonical" worktree remove --force "$owner"',
    ].join('\n');
    execFileSync(
      'flock',
      [
        '-x',
        '-w',
        '120',
        lockPath,
        'sh',
        '-c',
        script,
        'sh',
        lockPath,
        target.adminDir,
        target.owner,
        target.gitdir,
        canonical,
        requiredAncestor ?? '',
        ...safeGitArgs([]),
      ],
      {
        cwd: canonical,
        env: safeGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe', lockFd, adminFd],
        timeout: 125_000,
      },
    );
  } catch {
    restorePlaceholder();
    return false;
  } finally {
    if (adminFd !== null) fs.closeSync(adminFd);
    if (lockFd !== null) fs.closeSync(lockFd);
  }
  const after = linkedWorktreeAdminRecords(canonical);
  const removed = after !== null && !after.some((record) => path.resolve(record.owner) === path.resolve(target.owner));
  return restorePlaceholder() && removed;
}

/**
 * Legacy journals name only a repository: recover without global prune by removing each missing registration
 * that independently proves unlocked and index-clean; locked or staged ones are preserved.
 */
function completeLegacyPendingRemoval(entry: PendingWorktreeRemoval, dataDir: string): boolean {
  if (typeof entry.workgroupId !== 'string' || typeof entry.repo !== 'string') return false;
  let canonical: string;
  try {
    canonical = canonicalRepoDir(entry.workgroupId, entry.repo, dataDir);
  } catch {
    return false;
  }
  const proveContext = { workgroupId: entry.workgroupId, repo: entry.repo };
  // The symbolic-ref read runs with the canonical as cwd, so prove its own `.git/commondir` first.
  if (!commonDirIsCanonical(path.join(canonical, '.git'), canonical, proveContext)) return false;
  const integrationRef = git(canonical, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (!integrationRef) return false;
  const records = linkedWorktreeAdminRecords(canonical);
  if (records === null) return false;
  for (const record of records) {
    const missing = pathIsMissing(record.owner);
    const locked = linkedAdminIsLocked(record.adminDir);
    if (missing === null || locked === null) return false;
    if (!missing || locked) continue;
    // The two proofs below run Git with `--git-dir=<admin dir>`.
    if (!commonDirIsCanonical(record.adminDir, canonical, { ...proveContext, worktreePath: record.owner }))
      return false;
    const clean = linkedIndexMatchesHead(canonical, record.adminDir);
    if (clean === null) return false;
    if (!clean) continue;
    const contained = linkedHeadIsAncestorOf(canonical, record.adminDir, integrationRef);
    if (contained === null) return false;
    // A legacy journal cannot identify the moved checkout: keep any sibling whose HEAD is not in the integration
    // branch, since it may be the last reference to user commits.
    if (!contained) continue;
    if (!removeMissingWorktreeRegistration({ ...entry, worktreePath: record.owner }, dataDir, integrationRef)) {
      return false;
    }
  }
  return true;
}

/** Finish deregistrations a crash left journaled; runs at the start of every apply pass and retries on failure. */
function runPendingPrunes(dataDir: string): void {
  const pending = readPendingPrunes(dataDir);
  if (pending.length === 0) return;
  const remaining = pending.filter((entry) => {
    const completed = entry.worktreePath
      ? removeMissingWorktreeRegistration(entry, dataDir)
      : completeLegacyPendingRemoval(entry, dataDir);
    if (!completed) {
      log.warn('Storage GC: pending targeted deregistration still failing; retrying next pass', { ...entry });
      return true;
    }
    log.warn('Storage GC: completed a targeted deregistration left pending by an interrupted pass', { ...entry });
    return false;
  });
  writePendingPrunes(dataDir, remaining);
}

/**
 * A clone's recovery marker is a sidecar beside its quarantine entry: a marker inside the tree would make the git
 * re-proof see a dirty worktree. Written FIRST, so a crash leaves a marker with no entry (overwritten next pass),
 * never an entry with no marker. The recovery scan lists only directories, so it skips sidecars.
 */
function cloneSidecarPath(quarantinePath: string): string {
  return `${quarantinePath}.meta.json`;
}

function restoreQuarantinedClone(originalPath: string, quarantinePath: string): void {
  // Drop the sidecar LAST, only once its entry left quarantine: an entry without a marker is skipped by every
  // future recovery pass. If the destination reappeared, keep both and leave the copy for a human.
  if (fs.existsSync(originalPath)) {
    log.warn('Storage GC: clone rollback found the destination recreated; leaving the copy in quarantine', {
      originalPath,
      quarantinePath,
    });
    return;
  }
  try {
    fs.renameSync(quarantinePath, originalPath);
  } catch (err) {
    log.error('Storage GC: clone rollback rename failed; the copy stays in quarantine', {
      originalPath,
      quarantinePath,
      err,
    });
    return; // Marker stays, so the next pass can still find its way home.
  }
  fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
}

/**
 * Quarantine-then-verify removal for a scratch clone. The rename is atomic; anything written afterwards lands in
 * the quarantined copy, where re-running the same git proof sees it (dirty or unpushed).
 */
function finalizeCloneCollection(
  candidate: Pick<GcCandidate, 'path'>,
  dataDir: string,
  kind: 'scratch' | 'topic-checkout' = 'scratch',
  inheritedTagsRecord: string | null = null,
): { ok: boolean; reason?: string } {
  const resolvedOriginal = fs.realpathSync(candidate.path);
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  const quarantinePath = path.join(quarantineRoot, `${path.basename(candidate.path)}-${Date.now()}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });

  // Sidecar BEFORE the rename (see cloneSidecarPath).
  try {
    fs.writeFileSync(
      cloneSidecarPath(quarantinePath),
      JSON.stringify({ originalPath: candidate.path, category: 'clone' }),
    );
  } catch (err) {
    log.error('Storage GC: could not write clone quarantine metadata; leaving the clone in place', {
      path: candidate.path,
      err,
    });
    return { ok: false, reason: 'quarantine-meta-write-failed' };
  }
  try {
    fs.renameSync(candidate.path, quarantinePath);
  } catch (err) {
    // No entry was created, so the sidecar would point at a live directory.
    fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
    throw err;
  }

  const restore = (reason: string): { ok: boolean; reason: string } => {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    return { ok: false, reason };
  };

  // A scratch clone in an active group is always inside a mount source, so only the strong relation refuses it. A
  // topic checkout is mounted only into its own work unit's containers, so anything but 'clear' refuses.
  const freshMounts = runningContainerMounts();
  const relation = freshMounts === null ? null : mountRelation(resolvedOriginal, freshMounts);
  if (relation === null || relation === 'is-mount-source' || (kind === 'topic-checkout' && relation !== 'clear')) {
    return restore('aborted-late-mount');
  }
  const freshCwds = liveProcessCwds();
  if (freshCwds === null || processRootedIn(quarantinePath, freshCwds)) {
    return restore('aborted-late-activity');
  }
  // Re-prove the moved copy, not the original path, against the same tag record: this catches writes in the gap.
  const decision = disposability.proveCheckoutDisposable({
    path: quarantinePath,
    shape: 'clone',
    inheritedTagsRecord,
    liveTopic: kind === 'topic-checkout',
  });
  if (!decision.ok) return restore(`aborted-${decision.reason}`);

  try {
    trashPath(quarantinePath);
  } catch (err) {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    throw err;
  }
  // Only once the entry is gone; dropping it before the trash is the stranding bug the sidecar prevents.
  fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
  // A leftover tag record is harmless: the next build of this name replaces it.
  if (inheritedTagsRecord) fs.rmSync(inheritedTagsRecord, { force: true });
  return { ok: true };
}

async function finalizeIdleCollection(
  candidate: GcCandidate,
  dataDir: string,
): Promise<{ ok: boolean; reason?: string }> {
  const snapshot = candidate.idleSnapshot!;
  const resolvedOriginal = fs.realpathSync(candidate.path);
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  const quarantinePath = path.join(quarantineRoot, `${path.basename(candidate.path)}-${Date.now()}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });

  // Marker INTO the topic dir before the rename, so it travels in the same atomic move: no markerless entry.
  try {
    fs.writeFileSync(path.join(candidate.path, QUARANTINE_META_FILE), JSON.stringify({ originalPath: candidate.path }));
  } catch (err) {
    log.error('Storage GC: could not write quarantine recovery metadata; leaving the topic in place', {
      path: candidate.path,
      err,
    });
    return { ok: false, reason: 'quarantine-meta-write-failed' };
  }
  fs.renameSync(candidate.path, quarantinePath);

  const freshMounts = runningContainerMounts();
  if (freshMounts === null || mountRelation(resolvedOriginal, freshMounts) !== 'clear') {
    reconcileQuarantine(candidate, quarantinePath, dataDir);
    return { ok: false, reason: 'aborted-late-activity' };
  }

  // Capture the checkouts before trashing; only linked worktrees have a canonical registration to remove.
  const listed = readTopicCheckouts(path.join(quarantinePath, 'worktrees'));
  if (listed === null) {
    // Not "no worktrees": treating a read failure as empty would prune nothing yet trash the topic. Leave it in
    // quarantine; recoverOrphanedQuarantine retries.
    log.error('Storage GC: could not read the quarantined topic worktrees; leaving it in quarantine to retry', {
      quarantinePath,
    });
    return { ok: false, reason: 'quarantine-unreadable' };
  }
  const workgroupId = path.basename(path.dirname(candidate.path));
  const deregistrations: PendingWorktreeRemoval[] = listed
    .filter((checkout) => checkout.shape === 'linked')
    .map((checkout) => ({
      workgroupId,
      repo: checkout.repo,
      worktreePath: path.join(candidate.path, 'worktrees', checkout.name),
    }));

  // The durable-write fence runs last, right before the irreversible trash, to shrink the admission-race window.
  // An inventory failure is not evidence the topic is quiet. Fence, journal and trash are one `withCentralSync`
  // block (lease-only reads, awaitless span); the docker inspect and readdir above stay outside it.
  const trashed = await withCentralSync((): { ok: boolean; reason?: string } => {
    const rows = sessionInventory();
    if (rows === null) {
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      return { ok: false, reason: 'aborted-recheck-unavailable' };
    }
    const before = new Map(snapshot.map((p) => [p.sessionId, p]));
    const owner = participantsByTopic(dataDir, rows).get(candidate.path);
    const activityAdvanced = (owner?.participants ?? []).some((p) => {
      const prior = before.get(p.sessionId);
      // status/idleSince lag admission (inbound.db is written before last_active), so fence on inbound.db's mtime:
      // a file that appeared, moved forward, vanished or could not be statted is new activity.
      return (
        !prior ||
        prior.status !== p.status ||
        Date.parse(p.idleSince) > Date.parse(prior.idleSince) ||
        inboundAdvanced(prior.inboundMtimeMs, p.inboundMtimeMs)
      );
    });
    if (activityAdvanced) {
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      return { ok: false, reason: 'aborted-late-activity' };
    }

    // Journal the exact deregistrations BEFORE trashing, so a crash after the trash leaves a durable record.
    const priorPending = readPendingPrunes(dataDir);
    const journaled = writePendingPrunes(dataDir, [...priorPending, ...deregistrations]);
    if (!journaled) {
      // No journal, no trash: this is the crash-without-a-record window the journal exists to close.
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      return { ok: false, reason: 'aborted-prune-journal-unwritable' };
    }

    // Commit the delete first; deregistration runs only once it succeeds, so a failed trash leaves the
    // registrations and the restored checkout usable.
    try {
      trashPath(quarantinePath);
    } catch (err) {
      // Restore the exact prior contents, not a filter: filtering could drop an older retry record for the same repo.
      writePendingPrunes(dataDir, priorPending);
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      throw err;
    }
    return { ok: true };
  }, 'storage gc idle fence and trash');
  if (!trashed.ok) return trashed;

  // Deregister each exact linked worktree, so a resumed thread's create_worktree does not hit "already checked
  // out at <missing-path>". Never repository-wide prune: unrelated missing owners may retain staged work.
  for (const pending of deregistrations) {
    if (!removeMissingWorktreeRegistration(pending, dataDir)) {
      log.warn('Storage GC: targeted worktree deregistration failed after idle collection; retry is journaled', {
        ...pending,
      });
    } else {
      writePendingPrunes(
        dataDir,
        readPendingPrunes(dataDir).filter(
          (entry) =>
            !(
              entry.workgroupId === pending.workgroupId &&
              entry.repo === pending.repo &&
              entry.worktreePath === pending.worktreePath
            ),
        ),
      );
    }
  }
  return { ok: true };
}

/**
 * Re-prove side (a) against live state immediately before removal; anything unreadable refuses. Lease-only, run
 * inside the caller's `withCentralSync` block so the recheck and the removal stay one synchronous turn.
 */
function stillDisposable(
  candidate: GcCandidate,
  dataDir: string,
  mounts: string[],
  cwds: string[],
): { ok: boolean; reason: string } {
  if (candidate.category === 'clone') {
    // A clone in an active group is always inside a mount source; the process check and post-move re-proof
    // stand in for the coarse gate.
    if (relationToMounts(candidate.path, mounts) === 'is-mount-source') {
      return { ok: false, reason: 'container-mounted' };
    }
    if (processRootedIn(candidate.path, cwds)) return { ok: false, reason: 'process-rooted' };
    if (sessionInventory() === null) return { ok: false, reason: 'recheck-failed' };
    return { ok: true, reason: 'recheck-clear' };
  }
  if (overlapsAny(candidate.path, mounts)) return { ok: false, reason: 'container-mounted' };
  const rows = sessionInventory();
  if (rows === null) return { ok: false, reason: 'recheck-failed' };
  const owner = participantsByTopic(dataDir, rows).get(candidate.path);
  if (!sideAClear(owner?.participants, topicIdleReclaimDays()).pass) {
    return { ok: false, reason: 'recheck-topic-open' };
  }
  if (owner && topicIsBusy(owner.participants, dataDir)) return { ok: false, reason: 'recheck-topic-busy' };
  return { ok: true, reason: 'recheck-clear' };
}

/**
 * A process dying between the quarantine rename and restore/trash strands the entry (collectOrphanTopics walks
 * only v2-topics). Runs at the start of every apply pass; every entry found is pre-trash, so it is restored or
 * reconciled like a live rollback.
 */
function recoverOrphanedQuarantine(dataDir: string, report: GcReport): void {
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  for (const entry of safeDirectories(quarantineRoot) ?? []) {
    const quarantinePath = path.join(quarantineRoot, entry);
    let originalPath: string;
    let category: GcCategory;
    try {
      // Prefer the sidecar, so a clone is never misread as a topic and sent through the per-repo prune path.
      const sidecar = cloneSidecarPath(quarantinePath);
      const metaFile = fs.existsSync(sidecar) ? sidecar : path.join(quarantinePath, QUARANTINE_META_FILE);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
        originalPath: string;
        category?: GcCategory;
      };
      originalPath = meta.originalPath;
      // Entries written before clones used quarantine carry no category; all are topics.
      category = meta.category ?? 'orphan-topic';
    } catch (err) {
      log.error('Storage GC: orphaned quarantine entry has no readable recovery metadata; leaving it as-is', {
        quarantinePath,
        err,
      });
      continue;
    }
    if (category === 'clone') {
      // A plain rename: reconcileQuarantine would misread a `worktrees` directory inside the clone's own tree.
      restoreQuarantinedClone(originalPath, quarantinePath);
      log.warn('Storage GC: restored an orphaned clone quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'clone',
        path: originalPath,
        collect: false,
        reason: 'quarantine-restored',
        bytes: 0,
      });
      continue;
    }
    const placeholder: GcCandidate = {
      category: 'orphan-topic',
      path: originalPath,
      collect: false,
      reason: '',
      bytes: 0,
    };
    if (fs.existsSync(originalPath)) {
      // A spawn recreated the destination while the process was down: reconcile like a live rollback.
      reconcileQuarantine(placeholder, quarantinePath, dataDir);
      log.warn('Storage GC: reconciled an orphaned quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'orphan-topic',
        path: originalPath,
        collect: false,
        reason: 'quarantine-reconciled',
        bytes: 0,
      });
      continue;
    }
    try {
      fs.rmSync(path.join(quarantinePath, QUARANTINE_META_FILE), { force: true });
      fs.renameSync(quarantinePath, originalPath);
      log.warn('Storage GC: restored an orphaned quarantine entry after an interrupted pass', {
        originalPath,
        quarantinePath,
      });
      record(report, {
        category: 'orphan-topic',
        path: originalPath,
        collect: false,
        reason: 'quarantine-recovered',
        bytes: 0,
      });
    } catch (err) {
      log.error('Storage GC: could not restore an orphaned quarantine entry; leaving it in quarantine', {
        originalPath,
        quarantinePath,
        err,
      });
      // The entry stayed, so put the marker back or no later pass can find it.
      rewriteQuarantineMarker(quarantinePath, originalPath);
    }
  }
  try {
    fs.rmdirSync(quarantineRoot); // only succeeds once genuinely empty
  } catch {
    // Non-empty (something is still stranded, already logged) or never existed: nothing to do.
  }
}

export async function runStorageGcOnce(dataDir: string = DATA_DIR, groupsDir: string = GROUPS_DIR): Promise<GcReport> {
  const mode = gcMode();
  const rows = await readSessionInventory();
  if (rows === null) {
    const report = emptyReport(mode, false);
    log.error('Storage GC: did not run — session inventory unavailable, nothing evaluated', {
      mode,
    });
    return report;
  }

  const report = emptyReport(mode, true);
  if (mode === 'apply') {
    recoverOrphanedQuarantine(dataDir, report);
    runPendingPrunes(dataDir);
  }
  const owners = new Map(
    [...participantsByTopic(dataDir, rows)].map(([key, value]) => [key, value.participants] as const),
  );
  const skippedTopics = collectOrphanTopics(report, dataDir, owners);
  collectClones(report, dataDir, groupsDir, boundGitDirs(dataDir));

  if (mode === 'apply') {
    const demote = (candidate: GcCandidate, reason: string): void => {
      candidate.collect = false;
      candidate.reason = reason;
      report.collected -= 1;
      report.reclaimableBytes[candidate.category] -= candidate.bytes;
      report.skips[reason] = (report.skips[reason] ?? 0) + 1;
      if (candidate.category === 'orphan-topic') {
        report.topicSkipBytes[reason] = (report.topicSkipBytes[reason] ?? 0) + candidate.bytes;
      }
    };
    const mounts = runningContainerMounts();
    const cwds = liveProcessCwds();
    if (mounts === null || cwds === null) {
      log.error('Storage GC: liveness unreadable — removing nothing this pass', {
        mode,
        runtimeUnreadable: mounts === null,
        processTableUnreadable: cwds === null,
      });
      for (const candidate of report.candidates.filter((c) => c.collect)) {
        demote(candidate, mounts === null ? 'runtime-unreadable' : 'process-table-unreadable');
      }
    } else {
      for (const candidate of report.candidates) {
        if (!candidate.collect) continue;
        try {
          // A bare topic is trashed in the same lease block as its recheck; a clone re-proves after the quarantine
          // rename, and an idle topic re-fences inside `finalizeIdleCollection`.
          const recheck = await withCentralSync((): { ok: boolean; reason: string; trashed?: boolean } => {
            const verdict = stillDisposable(candidate, dataDir, mounts, cwds);
            if (!verdict.ok || candidate.category === 'clone' || candidate.idleSnapshot) return verdict;
            trashPath(candidate.path);
            return { ...verdict, trashed: true };
          }, 'storage gc recheck');
          if (!recheck.ok) {
            demote(candidate, recheck.reason);
            continue;
          }
          if (candidate.category === 'clone') {
            const finalized = finalizeCloneCollection(candidate, dataDir);
            if (!finalized.ok) {
              demote(candidate, finalized.reason!);
              continue;
            }
          } else if (candidate.idleSnapshot) {
            const finalized = await finalizeIdleCollection(candidate, dataDir);
            if (!finalized.ok) {
              demote(candidate, finalized.reason!);
              continue;
            }
          }
          log.info('Storage GC: collected', { path: candidate.path, category: candidate.category });
        } catch (error) {
          demote(candidate, 'trash-failed');
          log.error('Storage GC: removal failed', { path: candidate.path, error });
        }
      }
    }
  }
  sizeSkippedTopics(report, skippedTopics);

  log.info('Storage GC: ran', {
    mode,
    examined: report.examined,
    collected: report.collected,
    reclaimableBytes: report.reclaimableBytes,
    skips: report.skips,
    topicSkipBytes: report.topicSkipBytes,
    unmeasuredSkips: report.unmeasuredSkips,
  });
  return report;
}

export async function _discoverWorktreesForTesting(dataDir: string = DATA_DIR): Promise<TopicWorktreeTarget[]> {
  return discover(dataDir, await readSessionInventory()).targets;
}

export async function _discoveryStatsForTesting(dataDir: string = DATA_DIR): Promise<DiscoveryResult> {
  return discover(dataDir, await readSessionInventory());
}

export async function _cleanupOneForTesting(
  target: TopicWorktreeTarget,
  dataDir: string = DATA_DIR,
): Promise<CloneCleanupDecision | undefined> {
  return cleanupOne(target, dataDir);
}

export function _hostPathForProcessCwdForTesting(mountinfoText: string, cwd: string): string | null {
  return resolveHostPathFromMountinfo(mountinfoText, cwd);
}

export function _liveProcessCwdsForTesting(procRoot: string): string[] | null {
  return liveProcessCwds(procRoot);
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startWorktreeCleanup(): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    void runWorktreeCleanupOnce().catch((err) => log.error('Worktree cleanup: startup run failed', { err }));
  }, STARTUP_DELAY_MS);
  startupHandle.unref?.();
  intervalHandle = setInterval(() => {
    void runWorktreeCleanupOnce().catch((err) => log.error('Worktree cleanup: periodic run failed', { err }));
  }, CLEANUP_INTERVAL_MS);
  intervalHandle.unref?.();
}

export function stopWorktreeCleanup(): void {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
}

onHostStart(function worktreeCleanupHostStart() {
  // UNGUARDED: a synchronous startup failure must abort boot.
  startWorktreeCleanup();
  log.info('Worktree cleanup started');
});

onHostShutdown(function worktreeCleanupHostShutdown() {
  try {
    stopWorktreeCleanup();
  } catch (err) {
    log.error('Worktree cleanup failed to stop', { err });
  }
});
