/**
 * Conservative cleanup for host-owned per-topic linked worktrees.
 *
 * Cleanup never talks to a remote. It removes the exact generated topic branch
 * only after proving the linked checkout clean and remote-contained; explicit
 * user branch names and all reachable objects remain preserved. A
 * checkout is eligible only when every DB participant is inactive, Git can
 * prove the tree is clean and has no commits absent from local remote refs,
 * the branch is merged into origin/HEAD or gone from the already-fetched
 * origin namespace, and the topic has been idle for at least seven days.
 *
 * A branch clone (`.git` a directory; plan §5.8) takes its own branch: there
 * is no registration to remove, so it is quarantined and trashed, and only on
 * the topic's side-(a) evidence, seven idle days, and a proof covering every
 * local ref, HEAD and the stash, less the tags the host recorded when it built
 * the clone. See cleanupCloneCheckout and provenDisposable.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { runningContainerMounts } from './container-mounts.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { withCentralSync, withRawDb } from './db/central-lease.js';
// The GC's reclaim gate is synchronous all the way up through
// `runStorageGcOnce`, and the mailbox session is async, so the busy probe below
// uses `readSessionOutbound` — the module's SYNCHRONOUS read funnel — rather
// than a mailbox session. Same module, same single implementation of each
// statement (invariant I-2), and it asks an outbound-keyed existence question,
// which is the right one for a probe that reads only outbound state.
//
// This file is NOT on the raw-access allowlist. The two
// inbound touches that remain are `fs.existsSync` on a path, not opens.
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
import { dirSizeBytes, sessionWasReclaimed } from './storage-manager.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const MINIMUM_IDLE_DAYS = 7;
const STALE_WARNING_DAYS = 30;
const DEFAULT_TOPIC_IDLE_RECLAIM_DAYS = 14;
/**
 * Owner-approved: a scratch clone is only a candidate after two weeks
 * untouched — twice the topic floor, because nothing upstream ever closes a
 * clone the way a session close retires a topic, so idleness is the only
 * signal that the agent which made it has moved on.
 *
 * Directory mtime, not a deep walk: the git proof below is what establishes
 * that the contents are recoverable, and it sees deep edits (dirty, unpushed,
 * stashed) that a mtime sweep would only be able to date, not classify.
 */
const CLONE_IDLE_RECLAIM_DAYS = 14;

let warnedBadIdleReclaimDays = false;

/**
 * Owner-approved widening (2026-08-29): a topic whose open participants have
 * been idle this long is treated as side-(a) evidence too, on top of "every
 * participant closed". 0 disables it (pre-existing behavior).
 *
 * UNSET (the var isn't in the environment at all) -> the deliberate default
 * (14). Set to anything that isn't a plain non-negative integer — "" included
 * (negative, decimal, exponent notation, "abc", "NaN", empty, …) -> DISABLED
 * (0), not the default — a typo meant to turn this off (or a nonsense value)
 * must never silently turn it on at 14. Warns once per process on the bad path.
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

/** Days since an ISO timestamp. An unparseable timestamp fails closed (treated as just-now). */
function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (Date.now() - ms) / 86_400_000 : 0;
}

interface TopicParticipant {
  sessionId: string;
  agentGroupId: string;
  status: string;
  /** COALESCE(last_active, created_at) — ISO-8601 UTC. */
  idleSince: string;
  /** mtime of inbound.db, or null if unstatable. The durable admission write
   *  itself — last_active is a separate, later write off the same event. */
  inboundMtimeMs: number | null;
}

export interface TopicWorktreeTarget {
  workUnit: RepositoryWorkUnit;
  participants: TopicParticipant[];
  repo: string;
  worktreePath: string;
  /** As the lister decided it: a clone takes the clone branch, anything else the linked path. */
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
 * Git's environment for a question about exactly one checkout.
 *
 * With a `.git` that is missing or not a repository, Git's discovery walks up
 * the parent directories, and on this host `data/` sits inside the install's
 * own checkout: the answer would describe that repository, not this directory
 * (measured: a corrupt `.git` directory under a nested repo resolves
 * `--show-toplevel` to the outer repo). The ceiling stops discovery at `dir`,
 * so such a checkout fails, and reads as unprovable.
 */
function checkoutGitEnv(dir: string): NodeJS.ProcessEnv {
  return { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)) };
}

/**
 * Every filter the repository at `dir` defines in its effective config (local,
 * includes, worktree), so safeGitArgs can neutralize each one by name; `null`
 * when that config cannot be read. A clone's `.git` is container-writable
 * (worktrees/ is mounted read-write), and `status`
 * runs a clean filter whenever it rehashes a file.
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
 * Directory names under a topic's worktrees root, or `null` when the directory
 * could not be read.
 *
 * ENOENT is the ordinary "this topic has no worktrees" answer and returns an
 * empty list. Anything else — EACCES, EIO, ENOTDIR — is a real fault, and
 * collapsing it into an empty list is what makes an unreadable fleet
 * indistinguishable from a collected one. The caller counts and reports it.
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

/**
 * A topic's checkouts through the one lister, or `null` when its
 * worktrees root could not be read. `listTopicCheckouts` returns [] only for
 * ENOENT and throws on every other read failure, so an unreadable root is counted and
 * preserved here, never mistaken for an empty one.
 */
function readTopicCheckouts(worktreeRoot: string): TopicCheckout[] | null {
  try {
    return listTopicCheckouts(worktreeRoot);
  } catch (err) {
    log.warn('Worktree cleanup: worktrees root unreadable; preserving its topic', { directory: worktreeRoot, err });
    return null;
  }
}

function statMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The session inventory, read through `withRawDb`: synchronous and lease-only
 * (seam 3 §4.5). This module runs ON THE HOST — `main.ts` side-effect-imports
 * it and its `onHostStart` hook schedules `runWorktreeCleanupOnce` on a timer
 * — so a bare raw SELECT here could execute while a `centralTransaction` is
 * suspended and silently join it. Every reader either takes
 * the lease for the read alone (`readSessionInventory`, the async entry
 * points) or holds it across a recheck-then-trash span that must stay one
 * synchronous turn (`finalizeIdleCollection`'s fence, the GC recheck).
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

/** One lease block around the inventory read, for the async entry points. */
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
        inboundMtimeMs: statMtimeMs(
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
  /**
   * Entries whose names are not valid repository segments, as
   * `workgroup/work-unit/name`. Located, not just named: a bare name deduped
   * across every topic reports one `.github` when there are forty, and gives
   * an operator nowhere to look.
   */
  filteredNames: string[];
  /** Worktrees roots that could not be read at all. */
  unreadableRoots: number;
}

function discover(dataDir: string, rows: SessionRow[] | null): DiscoveryResult {
  const mapping = participantsByTopic(dataDir, rows);
  const targets: TopicWorktreeTarget[] = [];
  const filteredNames = new Set<string>();
  let unreadableRoots = 0;

  // Only DB-resolvable topics are deletion candidates. Unknown directories are
  // deliberately left intact: missing metadata is never deletion authority.
  for (const [statePath, { unit, participants }] of mapping) {
    if (!fs.existsSync(statePath)) continue;
    const worktreeRoot = topicWorktreesDir(unit, dataDir);
    const checkouts = readTopicCheckouts(worktreeRoot);
    if (checkouts === null) {
      unreadableRoots += 1;
      continue;
    }
    // The worktrees root is not a pure checkout namespace: the storage
    // activity lease (`.nanoclaw-storage-active`) and a shared pnpm cache
    // (`.pnpm-store`) live here too. The lister returns only names that parse
    // as `<repo>` or `<repo>@<slug>`, so none of them becomes a target;
    // without that filter, one such directory would make canonicalRepoDir()
    // throw and abort the entire cleanup pass at discovery, fleet-wide.
    //
    // The parse is deliberately NOT widened to admit them. `SAFE_SEGMENT` is a
    // path-traversal boundary, and a checkout it rejects is preserved, never
    // deleted. But some rejected names are legitimate repositories — `.github`
    // and `.github-private` are real GitHub repos — so every directory the
    // lister skips is reported rather than dropped silently. A repository name
    // in that report is an operator signal, not noise.
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
  // Session status is not proof that persisted work has completed. A
  // continuation, processing claim, or current tool can survive a transition
  // to inactive and must independently retain the shared topic worktree.
  //
  // Two-signal reclaim check, mirroring writeSessionMessageLocked exactly
  // (sessionWasReclaimed && the session's inbound.db is absent).
  // Neither signal alone is proof. The journal line is written BEFORE the
  // archiving->closed CAS in storage-manager; on CAS loss
  // the directory is deliberately kept, so journaled-but-CAS-lost is still
  // live. And the session ROOT can be recreated by a late inbound write that
  // loses the reclaim race — it acquires the storage lease (which mkdirs the
  // root) and then writeSessionMessageLocked itself rejects it, leaving a
  // real, non-empty root with no inbound.db inside. inbound.db absence is the
  // answer that survives both: the reclaim removes the whole directory, and
  // nothing recreates that specific file.
  if (
    sessionWasReclaimed(participant.sessionId, path.join(dataDir, 'v2-sessions')) &&
    !fs.existsSync(
      sessionMailboxPath({ agentGroupId: participant.agentGroupId, sessionId: participant.sessionId }, 'inbound'),
    )
  ) {
    return false;
  }
  try {
    // The options restate what the raw outbound opener gave this read before
    // the seam: the write path's 5s busy_timeout, and the hot-journal rollback
    // without which a SIGKILLed container leaves every read of its outbound.db
    // failing permanently — which here would pin the worktree forever.
    //
    // `undefined` (no outbound.db) counts as busy, deliberately and unchanged:
    // before the seam the open threw and landed in the same fail-closed catch.
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
 * Side (a): is topic ownership clear enough to consider collecting?
 *
 * Every owning row CLOSED, or no row at all, is the original predicate —
 * byte-identical behavior. Otherwise (owner-approved 2026-08-29 widening):
 * EVERY row, closed ones included, must be idle at least idleReclaimDays by
 * coalesce(last_active, created_at). Closure alone no longer exempts a row
 * once any sibling is open — a session closed only yesterday is evidence of
 * recent topic activity, not proof the topic is quiet.
 */
function sideAClear(
  participants: TopicParticipant[] | undefined,
  idleReclaimDays: number,
): { pass: boolean; viaIdle: boolean } {
  if (!participants || participants.length === 0) return { pass: true, viaIdle: false };
  if (participants.every((p) => p.status === 'closed')) return { pass: true, viaIdle: false };
  // The idle path only ever reasons about steady states. `archiving` (mid
  // reclaim CAS) or any other/NULL status is a transitional or unrecognized
  // state the idle floor was never evaluated against — refuse outright
  // rather than let it ride through on a sibling's idle time.
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
 * Does Git resolve `gitDir`'s common dir to `canonical`'s own `.git`?
 *
 * Asked before a host Git call that runs against a canonical (as cwd or `-C`)
 * or one of its linked admin dirs (`--git-dir`): Git follows a `commondir`
 * file in either to whatever repository it names. The canonical's own file is
 * the sentinel spawn mounts read-only, but the
 * canonical `.git` is mounted read-write, so the
 * admin dirs under `.git/worktrees/` stay container-writable. This is
 * therefore check-then-use: it narrows the window, it does not close it. A
 * mismatch, or a common dir Git cannot report, refuses the item and logs it.
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

/** What the clone branch decided for one clone checkout. The linked path reports nothing. */
export interface CloneCleanupDecision {
  collected: boolean;
  reason: string;
}

async function cleanupOne(
  target: TopicWorktreeTarget,
  dataDir: string = DATA_DIR,
): Promise<CloneCleanupDecision | undefined> {
  if (target.shape === 'clone') return cleanupCloneCheckout(target, dataDir);
  await cleanupLinkedCheckout(target, dataDir);
  return undefined;
}

/**
 * The clone branch of worktree cleanup (plan §5.8).
 *
 * A clone is a whole repository, not a registration in the canonical, so
 * there is nothing for `git worktree remove` to do and nothing to deregister:
 * it goes to the trash, as a scratch clone does. That is a heavier act than
 * removing a linked checkout, so it asks for more:
 *  - the topic's side-(a) evidence (sideAClear), on top of the busy and
 *    transfer checks the linked path makes;
 *  - the checkout itself idle for at least MINIMUM_IDLE_DAYS;
 *  - proveCheckoutDisposable, which holds a clone to scope `all`: a clean
 *    tree, no stash, and no commit on any local branch or HEAD that
 *    `--remotes` lacks.
 * Then quarantine, re-prove the moved copy, and trash (finalizeCloneCollection).
 * Every check re-runs under the lifecycle claim and the repository lock, the
 * pair repository_checkout holds (plan §5.2), so a checkout request cannot
 * reuse this directory halfway through its collection.
 */
async function cleanupCloneCheckout(target: TopicWorktreeTarget, dataDir: string): Promise<CloneCleanupDecision> {
  const context = {
    workgroupId: target.workUnit.workgroupId,
    workUnit: target.workUnit.key,
    repo: target.repo,
    path: target.worktreePath,
  };
  const refusal = (): string | null => {
    if (!sideAClear(target.participants, topicIdleReclaimDays()).pass) return 'topic-open';
    if (topicIsBusy(target.participants, dataDir)) return 'topic-busy';
    if (transferReferencesPath(target, dataDir)) return 'transfer-referenced';
    if (idleDays(target.worktreePath) < MINIMUM_IDLE_DAYS) return 'recent';
    return null;
  };
  const early = refusal();
  if (early) return { collected: false, reason: early };

  return withRepositoryLifecycleClaims([target.workUnit], () =>
    withHostRepositoryLock(
      target.workUnit.workgroupId,
      target.repo,
      (): CloneCleanupDecision => {
        const late = refusal();
        if (late) return { collected: false, reason: late };
        const proof = disposability.proveCheckoutDisposable({
          path: target.worktreePath,
          shape: target.shape,
          inheritedTagsRecord: checkoutInheritedTagsPath(target.worktreePath),
        });
        if (!proof.ok) {
          if (idleDays(target.worktreePath) >= STALE_WARNING_DAYS) {
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
        // isLinkedToCanonical proved the worktree's own common dir. The two
        // calls below run with the canonical as cwd, where Git reads the
        // canonical's own `.git/commondir` instead, so prove that one too.
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
          // Expected-old-value makes deletion fail closed if the ref changed
          // between eligibility proof and removal, even though the repository
          // lock should already exclude cooperating writers.
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
  // One pathological topic must not cost the fleet its collection pass: a
  // failing target is skipped and counted, never allowed to abort the rest.
  let skipped = 0;
  for (const target of targets) {
    try {
      await cleanupOne(target, dataDir);
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
  // A pass that collected nothing — because every target failed, because every
  // name was filtered, or because every root was unreadable — must not read
  // like a pass that had nothing to do. That indistinguishability is exactly
  // what let the discovery throw survive unnoticed for months.
  log.info('Worktree cleanup: pass complete', {
    examined: targets.length,
    skipped,
    filtered: filteredNames.length,
    filteredNames,
    unreadableRoots,
  });
}

// ---------------------------------------------------------------------------
// Storage GC: orphaned topic directories and source clones.
//
// The linked-checkout path above only ever considers topics that a CURRENT
// session row resolves to, so a topic whose rows are gone is never a candidate,
// and source clones were never candidates at all. Both leak.
//
// Removal demands BOTH-SIDES-POSITIVE evidence: the owning topic is absent from
// a SUCCESSFUL database inventory, AND git proves the tree clean with nothing
// unpushed. Anything unprovable — a pruned worktree admin directory, a
// container-absolute gitdir, a failed query — is skipped and logged. Absence of
// a signal is never authority to delete.
//
// Dry-run is the default. Acting requires NANOCLAW_STORAGE_GC=apply.
// ---------------------------------------------------------------------------

const GC_APPLY_ENV = 'NANOCLAW_STORAGE_GC';
const TRASH_BIN = '/usr/bin/trash';
/** Written into a quarantined topic so an interrupted pass can find its way home. */
const QUARANTINE_META_FILE = '.gc-quarantine-meta.json';
/** Scan depth below groups/<folder> for agent-created scratch clones. */
const CLONE_SCAN_DEPTH = 4;
/** Workgroup-root entries that are the repo store itself, never a clone. */
const RESERVED_WORKGROUP_DIRS = new Set(['.repos', '.worktrees', '.rescues']);

export type GcCategory = 'orphan-topic' | 'clone';

export interface GcCandidate {
  category: GcCategory;
  path: string;
  collect: boolean;
  reason: string;
  bytes: number;
  /**
   * Set only for an orphan-topic collected via the idle-threshold path
   * (reason 'idle-and-clean'). Scan-time (sessionId, status, idleSince) for
   * every owning participant — re-verified after the move, before the
   * topic is handed to the real trash. See finalizeIdleCollection.
   */
  idleSnapshot?: Array<{ sessionId: string; status: string; idleSince: string; inboundMtimeMs: number | null }>;
}

export interface GcReport {
  /** false means the inventory failed and NOTHING was evaluated. */
  ran: boolean;
  mode: 'dry-run' | 'apply';
  examined: number;
  collected: number;
  reclaimableBytes: Record<GcCategory, number>;
  skips: Record<string, number>;
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
    candidates: [],
  };
}

function gcMode(): 'dry-run' | 'apply' {
  return process.env[GC_APPLY_ENV] === 'apply' ? 'apply' : 'dry-run';
}

/**
 * A `git worktree lock` marker on this checkout's admin dir. Verified against
 * Git 2.43: `worktree prune` exits 0 but
 * leaves a locked entry's registration in place even once its path is gone —
 * recreating it afterward fails with "missing but locked worktree". A lock is
 * an agent explicitly saying "don't touch this", so it makes the checkout
 * non-disposable regardless of git cleanliness — refuse at evaluation time,
 * not buried in the later prune step. No-op for a plain clone (scope 'all'):
 * only a linked worktree's git-dir has a `locked` file to find.
 */
function isWorktreeLocked(dir: string): boolean {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], checkoutGitEnv(dir));
  return gitDir !== null && fs.existsSync(path.join(gitDir, 'locked'));
}

/**
 * Positive proof that a checkout holds nothing worth keeping.
 *
 * `scope` is 'head' for a linked worktree (its branch is the only one it owns)
 * and 'all' for a clone, which owns every local branch in it and its HEAD.
 * Reach it through proveCheckoutDisposable, which picks the scope. A git invocation
 * that fails — the usual cause is a pruned worktree admin directory or a gitdir
 * only resolvable inside a container — returns unprovable, never clean.
 */
function provenDisposable(
  dir: string,
  scope: 'head' | 'all',
  inheritedTags: ReadonlyMap<string, string> | null = null,
): { ok: boolean; reason: string } {
  if (isWorktreeLocked(dir)) return { ok: false, reason: 'worktree-locked' };
  const env = checkoutGitEnv(dir);

  // Host git runs inside a repository a container may have configured. Every
  // host call has signature programs off (safe-git.ts BASE_CONFIG), and each
  // filter this repository defines is neutralized by name. An embedded
  // repository is refused before `status` could recurse into it: its own config
  // is out of the overrides' reach, and its history out of this proof's.
  // `--ignore-submodules=all` covers one added between the two commands.
  // A repository whose config or index cannot be read has a status no host
  // command can safely prove.
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

  const stashVerdict = (): { ok: boolean; reason: string } | null => {
    const stash = git(dir, ['stash', 'list'], env);
    if (stash === null) return { ok: false, reason: 'stash-unprovable' };
    return stash === '' ? null : { ok: false, reason: 'stashed' };
  };
  // For a clone the stash is read BEFORE the log below, which counts
  // refs/stash too and would otherwise report a stash as 'unpushed'. The log
  // still backs it: a refs/stash with no reflog is invisible to `stash list`
  // but not to `--all` (measured on this host, git 2.43).
  if (scope === 'all') {
    const stashed = stashVerdict();
    if (stashed) return stashed;
  }

  // Scope 'all': every local ref's commits must be on origin. `--all` names
  // HEAD, every branch, tag, note and replace ref, the stash and every other
  // remote's refs. A commit reachable only from a tag, a detached HEAD or a
  // note is on no branch, and `--branches HEAD` would read a tag-only
  // commit as pushed. HEAD stays named explicitly:
  // `--all` alone exits 0 with no output on an unborn HEAD (measured, git
  // 2.43), while `log HEAD` fails there, so such a repository reads as
  // unprovable, never as clean. Only origin's remote-tracking refs are
  // evidence for a clone: another remote (a sibling clone, a local backup)
  // can hold commits no real remote has. Scope 'head' is a linked worktree's
  // proof, unchanged: its HEAD against every remote-tracking ref.
  //
  // One exception for a clone: a tag the host recorded when it built
  // the clone, still held at the same object, is the canonical's, not the
  // clone's own work. A clone copies every canonical tag (repository_checkout
  // removes only heads and remote-tracking refs), and a release tag off
  // every origin branch would otherwise keep every clone of that repository
  // forever. The record is host-only (checkoutInheritedTagsPath). The
  // canonical's refs are container-writable and are never read here, so no
  // other topic can exempt this clone's work. Matching name and object only
  // drops roots, so a commit any other ref holds still counts. The roots go in
  // on stdin, before `--not`.
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

  // A repository that backs linked worktrees owns an object store those
  // checkouts share; trashing it destroys their history, and nothing above
  // would notice because every check so far looks only at THIS tree.
  //
  // collectClones already asks cloneHasBoundWorktrees, but only once, during
  // the scan. A clone in a busy group is an ordinary candidate, and an agent running
  // `git worktree add` against it between the scan and the trash would not be
  // caught. Ask git's own registry instead of the filesystem sweep: every
  // linked worktree of a repo has an entry under <gitdir>/worktrees, so this
  // is one readdir, it is authoritative, and putting it HERE means it is
  // re-answered by the post-move re-proof rather than only at scan time.
  //
  // Only for scope 'all' (a clone). A linked worktree is itself an entry in
  // some other repo's registry and legitimately has none of its own.
  if (scope === 'all') {
    const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
    if (gitDir === null) return { ok: false, reason: 'gitdir-unprovable' };
    const registered = safeDirectories(path.join(gitDir, 'worktrees'));
    // null is "the directory exists but could not be read" — unprovable, not
    // empty. A repo with no linked worktrees simply has no such directory.
    if (registered === null && fs.existsSync(path.join(gitDir, 'worktrees'))) {
      return { ok: false, reason: 'worktree-registry-unprovable' };
    }
    if (registered !== null && registered.length > 0) return { ok: false, reason: 'backs-worktrees' };
  }

  return { ok: true, reason: 'clean-and-pushed' };
}

/**
 * The one disposability primitive (plan §5.8). A clone owns every local branch
 * in it, so it is proved with scope `all`; a linked worktree owns only its
 * HEAD, as it always has; a checkout whose shape the lister could not decide
 * is refused outright. `inheritedTagsRecord` names the host-only record of the
 * tags a topic clone inherited when the host built it; only a topic
 * checkout has one, and a clone without a record counts every tag.
 */
export function proveCheckoutDisposable(
  checkout: Pick<TopicCheckout, 'path' | 'shape'> & { inheritedTagsRecord?: string | null },
): {
  ok: boolean;
  reason: string;
} {
  if (checkout.shape === 'clone') {
    // The record is bound to the clone it was written for, which a quarantine
    // rename keeps: the re-proof of the moved copy still matches it.
    const inherited = checkout.inheritedTagsRecord
      ? readCheckoutInheritedTags(checkout.inheritedTagsRecord, checkout.path)
      : null;
    return disposability.provenDisposable(checkout.path, 'all', inherited);
  }
  if (checkout.shape === 'linked') return disposability.provenDisposable(checkout.path, 'head');
  return { ok: false, reason: 'unknown-shape' };
}

/**
 * Every proof in this file is called through this object, never by bare name,
 * so a spy sees each one (plan §9 P2-13). Only proveCheckoutDisposable calls
 * provenDisposable.
 */
export const disposability = { provenDisposable, proveCheckoutDisposable };

/** Directories with a real .git DIRECTORY. Symlinks are never candidates: a
 *  bedroom link such as agent/<name> -> workgroup/<name> is not a clone, and a
 *  container-absolute link dangles on the host. */
function isPrivateClone(dir: string): boolean {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    return fs.lstatSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A checkout whose `.git` is a FILE pointing somewhere this host cannot follow
 * — in practice `gitdir: /workspace/...`, a path that only resolves inside the
 * container that made it.
 *
 * These are permanently unprovable from the host, so they must never be removed. They already are
 * never removed, because isPrivateClone demands a real `.git` DIRECTORY — but
 * they were also silently invisible, which in the middle of a storage squeeze
 * reads as "nothing here" rather than "mass no host-side pass can ever
 * reclaim". Report them so the gap is legible, and stop walking their working
 * trees looking for nested repositories.
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
  /** Checkouts bound to a git-dir this host cannot resolve. Never removable. */
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
 * Every host path a linked worktree is currently bound to, as an index of
 * gitdir prefixes. Removing a clone that still backs one of these orphans the
 * worktree, so a clone appearing here is not collectable. `unreadable` records
 * that at least one pointer could not be read at all, which makes every clone
 * unprovable rather than silently collectable.
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
    // A checkout's own contents hold no further bindings worth indexing, and
    // descending into one means walking its whole working tree on every pass.
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
      // A pointer that does not resolve on the host cannot be matched by
      // realpath; fall back to a textual prefix test on the raw value.
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

/**
 * Everything under a topic's `worktrees/` that must be proved disposable
 * before the topic can be (plan §5.8), or `null` when the root cannot be read.
 *
 * - Each checkout the lister returns, with the shape it decided.
 * - Each other directory, as shape `unknown`: probed like a checkout, and so
 *   refused. A leftover lease dir, a stray `.pnpm-store` or a legacy `.github`
 *   checkout lands here; a name the lister cannot parse is not evidence that
 *   anything under it is disposable. repository_checkout's staging is not in
 *   `worktrees/` at all (`checkoutStagingRoot`); it goes with its topic.
 *
 * The second read exists only to find what the lister deliberately skips. An
 * entry created between the two reads shows up only in the second, as
 * `unknown`, so that race refuses the topic rather than passing it.
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

function collectOrphanTopics(report: GcReport, dataDir: string, owners: Map<string, TopicParticipant[]>): void {
  const topicsRoot = path.join(dataDir, 'v2-topics');
  const idleReclaimDays = topicIdleReclaimDays();
  for (const workgroupId of safeDirectories(topicsRoot) ?? []) {
    const workgroupDir = path.join(topicsRoot, workgroupId);
    for (const topic of safeDirectories(workgroupDir) ?? []) {
      const topicDir = path.join(workgroupDir, topic);
      const skip = (reason: string): void =>
        record(report, { category: 'orphan-topic', path: topicDir, collect: false, reason, bytes: 0 });

      const participants = owners.get(topicDir);
      // Side (a) — see sideAClear. Status alone is not enough even once it
      // passes: a closed session can still hold a processing claim or a
      // continuation, and `topicIsBusy` fails closed on anything unreadable.
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
      // topicDir's own mtime is not a signal of activity — any bulk
      // metadata touch on the parent (data/v2-topics/<workgroup>) bumps every
      // topic dir at once regardless of what's inside, which would silently
      // disable this gate fleet-wide.
      // `worktrees/` is the deeper, real-activity signal — branchMayBeRemoved
      // above already keys off this same depth rather than the topic dir.
      // Read idleDays from worktrees/ exclusively rather than
      // max(topicDir, worktrees): taking the max would still let a poisoned
      // (freshest) topicDir value win on the next bulk touch, reproducing
      // this exact bug. A missing/unstat-able worktrees/ hits idleDays'
      // stat-failure fallback (returns 0 = "brand new"), which still fails
      // closed here — it refuses collection, it does not grant a free pass.
      if (idleDays(worktreeRoot) < MINIMUM_IDLE_DAYS) {
        skip('recent');
        continue;
      }

      // The ONE enumeration here that must not fall back to []. The loop
      // below is what proves every checkout under this topic disposable;
      // reading an unreadable root as empty leaves `refused` null and records
      // the whole topic as collectable on the strength of a directory nobody
      // could read. The discovery-side calls in this file may use `?? []`
      // because a missed candidate is a missed deletion; this one authorizes
      // one. Every entry is proved through proveCheckoutDisposable, so a
      // clone answers for all of its branches, not only its HEAD.
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

    // Agent-group and workgroup liveness are not gates here: they would make
    // clone reclaim unreachable. `groups/<folder>` is bind-mounted into every
    // container of that group, so a group with any running container would refuse
    // EVERY clone under it — and a QA group with a continuous cadence never
    // has a quiet moment. Neither gate says anything about THIS directory.
    // Apply mode decides that per path instead: mount relation plus a process
    // scan, re-verified after the quarantine rename. See stillDisposable.
    if (idleDays(candidate.dir) < CLONE_IDLE_RECLAIM_DAYS) {
      skip('recent');
      continue;
    }
    if (cloneHasBoundWorktrees(candidate.dir, bound)) {
      skip('bound-worktrees');
      continue;
    }
    // isPrivateClone found a real `.git` directory, which is the lister's own
    // definition of a clone.
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

/** Recoverable removal. `trash` is capped at 30 days by tmpfiles.d; `rm` is
 *  blocked by the deployed destructive guard and is never used here. */
function trashPath(target: string): void {
  execFileSync(TRASH_BIN, [target], { stdio: 'pipe', timeout: 120_000 });
}

/**
 * Translate a path as a process sees it into the host path it maps to.
 *
 * A containerized process's cwd resolves inside that container's mount
 * namespace: measured on this host, an agent container's runner reads
 * `/workspace/agent`, never the host directory it is bound from. A raw
 * readlink scan compared against host paths is therefore blind to exactly the
 * processes it exists to catch — 51 live container processes read as zero.
 * /proc/<pid>/mountinfo carries the mapping, one line per mount, whose fourth
 * field is the path WITHIN the source filesystem and whose fifth is the
 * mountpoint as that namespace sees it. Resolve through the longest matching
 * mountpoint.
 *
 * A mount whose root is unrelated to the host tree (a container's own
 * overlayfs, rooted at `/`) can translate into a host-looking path that is not
 * really one. That direction is safe: a spurious match refuses a candidate, it
 * never authorizes removing one. `null` means the mapping could not be read at
 * all, which is a visible process we failed to place — the caller refuses the
 * whole pass on it.
 */
/** Pure half of hostPathForProcessCwd, factored out so tests can drive it with
 *  a synthetic mountinfo body instead of real /proc access. */
/**
 * PRECONDITION, stated because it is an assumption and not a guarantee: the
 * fourth mountinfo field is a path within the SOURCE filesystem, so treating
 * it as host-absolute is only correct while the bind-mount sources live on the
 * filesystem mounted at `/`. That holds on this install (every mount resolves
 * to the same device), and is what makes `groups/<folder> -> /workspace/agent`
 * translate exactly.
 *
 * Where it does not hold — DATA_DIR or GROUPS_DIR on their own volume, a
 * common enough cloud layout — a translated path comes out relative to that
 * volume's root and simply fails to match any candidate. The consequence is a
 * MISS, not a spurious match, so the /proc
 * check quietly degrades to nothing rather than misfiring. It is defence in
 * depth either way — the git re-proof on the moved copy is what actually
 * stands between this and deleting live work — but a reader should not
 * mistake this function for a guarantee on an arbitrary host.
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
 * `undefined` means the process is simply gone — it exited between the cwd
 * readlink and this read, so it holds nothing and the scan continues. `null`
 * is a real read failure on a process that still exists: a live process we
 * cannot place, which makes the caller refuse the whole pass.
 *
 * The distinction is load-bearing, not pedantry. Processes come and go
 * constantly on this host, so collapsing an exit into "unreadable" would let
 * any short-lived command abort an entire GC pass — intermittently, and
 * looking exactly like "the GC mysteriously reclaims nothing".
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
 * Host paths that some currently running process is rooted in.
 *
 * A git lock is not a liveness signal for these directories
 * (measured: 3 live sessions, 0 locks), so ask the process table directly.
 *
 * Boundary, stated because absence of a signal must never be read as absence
 * of a process: 282 of 390 pids on this host have an unreadable cwd — they are
 * root- and system-owned processes, which never hold an agent scratch clone as
 * their working directory. Every process that CAN hold one (container agents,
 * host shells running as the install user) is readable. An unreadable pid
 * contributes nothing rather than
 * failing the pass; a pid we can see but cannot place fails it.
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
    // Both, not just the translation. A host process's cwd IS already a host
    // path, and for a mount on a separate device the fourth mountinfo field is
    // that filesystem's own root rather than a host-absolute path, which would
    // translate `/tmp/x` to `/x`. Keeping the raw value too means such a mount
    // can only ever add a spurious entry, never drop a real one — and a
    // spurious entry refuses a candidate rather than authorizing one.
    roots.push(cwd);
    if (host !== cwd) roots.push(host);
  }
  return roots;
}

/** True when a live process sits inside `target` (or on it). */
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
 * How a target relates to the bind mounts of running containers.
 *
 * - 'is-mount-source' — the target IS a mount source, or CONTAINS one.
 *   Removing it pulls the floor out from under a live container's mount.
 *   Never removable, on any evidence.
 * - 'inside-mount-source' — the target merely lives underneath a mount
 *   source. `groups/<folder>` is itself mounted into every container of that
 *   group, so EVERY scratch clone in an active group is permanently in this
 *   state; treating it as equivalent to the case above is what made clone
 *   reclaim unreachable in practice. A container could touch such a
 *   path, but the idle + git proof is the evidence that it has not, and the
 *   quarantine rename plus post-move recheck is what closes the race.
 * - 'clear' — no overlap at all.
 */
type MountRelation = 'is-mount-source' | 'inside-mount-source' | 'clear';

function mountRelation(resolvedTarget: string, mounts: string[]): MountRelation {
  let relation: MountRelation = 'clear';
  for (const mount of mounts) {
    let source = mount;
    try {
      source = fs.realpathSync(mount);
    } catch {
      // Keep the raw value: a mount source that is gone from the host still
      // names the tree the container was given.
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
 * A message can land, or a container spawn
 * can land its bind mount, in the window between stillDisposable's pre-move
 * recheck and the topic being fully trashed. Closed-path topics can't be
 * re-routed to (the router only ever opens a NEW session for a new thread
 * key), so this only matters for the idle-threshold path — an idle but
 * ACTIVE session still receives inbound.
 *
 * inbound admission bumps last_active BEFORE any spawn ever mounts anything
 * (session-manager), so admission-before-the-move is always caught by
 * the recheck below, and admission-after-the-move finds the directory gone
 * and re-materializes a fresh checkout for the new message — nothing lost
 * either way. The move (renaming the directory out of its live path) is the
 * serialization point this relies on.
 *
 * `trash-cli`'s own restore (`trash-restore`) is interactive-only — it
 * prompts on stdin and picks by a list index, not scriptable for "restore
 * this exact item" (confirmed via `man trash-restore`). So the actual delete
 * is staged: rename into a same-filesystem quarantine dir first (an ordinary,
 * instantly-reversible rename), recheck, and only THEN hand the quarantined
 * copy to the real `trash` for its 30-day retention.
 */
/**
 * Every entry name in `directory` — files and links included, not only
 * directories — sorted; `[]` when it is absent and `null` when it cannot be
 * read. A rollback must see everything the quarantine holds, because an entry
 * it does not see is one it cannot put back.
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
 * Put one quarantined entry back at `to`, or trash it when a live copy
 * already holds that slot. Returns true once the entry has left quarantine
 * (restored or trashed), false while it is still there. `deregistration` is
 * set only for a linked worktree: trashing its copy leaves a canonical
 * registration to remove afterward, which the caller does.
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
    // A locked copy restores, never trashes — leave it in quarantine
    // rather than destroy something explicitly marked "don't touch".
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
 * Roll a quarantined topic back to its original path.
 *
 * Precondition: every topic reaching finalizeIdleCollection already passed
 * provenDisposable (clean, pushed, no stash) at scan time. So no interleaving
 * here can ever lose unrecoverable work — the only harms left are STUCK
 * STATES (a dangling canonical-repo registration, or a wedged create_worktree
 * on an empty root). Every branch below is designed to end in a state the
 * next spawn can build from.
 *
 * One rule serves the first attempt and every retry, whatever an earlier
 * attempt left behind: what occupies the original path decides, never what
 * the quarantine still holds. While nothing does, the whole topic goes back in
 * one rename. Once something does — the spawn path does
 * `mkdirSync(<topic>/worktrees, {recursive:true})` on its own, so a live
 * container can recreate the destination at any moment,
 * and a bare rename onto it fails — each entry goes back on its own: every
 * entry of the quarantined `worktrees/` (a `<repo>` or `<repo>@<slug>`
 * checkout, or a name the lister does not parse) and every other entry of the
 * topic. If an entry's slot is absent, rename it back in place (a linked
 * worktree's registration is still valid there, so it works immediately). If
 * the slot is already occupied (the agent beat us to it), keep the live copy
 * and trash the quarantined one — safe per the precondition above — unless it
 * is locked. If a linked copy cannot be restored and is successfully trashed,
 * remove only that exact missing checkout's canonical registration afterward,
 * from the canonical of the repo its name parses to; a clone is registered
 * nowhere. A repository-wide prune is forbidden here: another missing
 * registration can still hold the only copy of an agent's staged index.
 *
 * Nothing whole is ever trashed, and a failed whole-topic restore stays in
 * quarantine. A directory that cannot be listed restores nothing: an entry
 * that was never seen is one whose lock was never checked. The recovery marker
 * goes only once every entry has been restored or deliberately trashed;
 * anything left behind keeps it, so recoverOrphanedQuarantine retries next
 * pass: an entry without a marker is one it can never identify.
 */
function reconcileQuarantine(candidate: GcCandidate, quarantinePath: string, dataDir: string): void {
  if (!fs.existsSync(quarantinePath)) return;
  const marker = path.join(quarantinePath, QUARANTINE_META_FILE);

  if (!fs.existsSync(candidate.path)) {
    // Never let the recovery marker itself land back inside a restored topic.
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      // Best-effort — a leftover marker is a leak, not a correctness issue.
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
    // Shapes come from the one lister (plan §5.1): only a linked entry (its
    // `.git` is a file) is registered with a canonical, under the repo its
    // name parses to. A read failure here only loses deregistrations, which
    // leave a stale registration, never lost work; every entry still goes back.
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

/** True if b is later than a — null on either side is never "later" than a real time. */
function laterThan(a: number | null, b: number | null): boolean {
  if (b === null) return false;
  if (a === null) return true;
  return b > a;
}

/** Durable record of exact linked-worktree removals a trash is (or was) about to require.
 *  A crash between a successful trash and the deregistration loop that
 *  follows it would otherwise leave a dangling `.git/worktrees/<name>`
 *  registration with nothing to find it. */
const PENDING_PRUNE_FILE = '.gc-pending-prunes.json';

interface PendingWorktreeRemoval {
  workgroupId: string;
  repo: string;
  /** Added in v2. Older journals omitted this and are recovered conservatively. */
  worktreePath?: string;
}

function pendingPrunePath(dataDir: string): string {
  return path.join(dataDir, PENDING_PRUNE_FILE);
}

/** Best-effort — a journal read failure only costs the crash-recovery safety
 *  net for this pass; the exact deregistration loop still runs regardless. */
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

/** Returns whether the write actually landed — callers that are about to
 *  trash something the journal is meant to protect must abort on `false`
 *  rather than proceed without a durable record (Codex P2). */
function writePendingPrunes(dataDir: string, entries: PendingWorktreeRemoval[]): boolean {
  const target = pendingPrunePath(dataDir);
  try {
    if (entries.length === 0) {
      fs.rmSync(target, { force: true });
    } else {
      // Codex P2: write-then-rename, not in-place — a failure partway
      // through (ENOSPC/EIO/kill) never touches `target`, so the existing
      // journal survives untouched instead of being left empty/truncated.
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

/** Read Git's private linked-worktree records without allowing `prune` to
 * make a repository-wide deletion decision for us. */
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

/** Remove one exact missing registration only after re-proving that its
 * private index has no staged state and no explicit lock. The branch ref and
 * every commit remain intact. */
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
    // `<repo>` or `<repo>@<slug>`: the checkout's name must parse to the repo
    // whose canonical holds the registration.
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
      // A spawn can recreate an empty topic slot before rollback completes.
      // rmdir is the atomic proof that it still contains no agent data. Put
      // the placeholder back after Git releases the stale registration.
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
  // Every Git call below runs against the admin dir (`--git-dir`) or the
  // canonical (cwd, `-C`), and Git follows a `commondir` in either.
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

    // `flock` owns the same inode used by container create_worktree. Once held,
    // re-prove that both path ownership and the recoverable private index are
    // still exactly what this pass observed. File descriptors 3 and 4 pin the
    // lock/admin identities across path replacement; cooperating writers cannot
    // swap in a newly recreated worktree between this proof and the removal.
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

/** Pre-exact-path journals can only name a canonical repository. Recover them
 * without global prune by removing every missing registration that independently
 * proves unlocked and index-clean. Locked or staged records are intentionally
 * preserved; they cannot be the clean checkout the GC journaled before trash. */
function completeLegacyPendingRemoval(entry: PendingWorktreeRemoval, dataDir: string): boolean {
  if (typeof entry.workgroupId !== 'string' || typeof entry.repo !== 'string') return false;
  let canonical: string;
  try {
    canonical = canonicalRepoDir(entry.workgroupId, entry.repo, dataDir);
  } catch {
    return false;
  }
  const proveContext = { workgroupId: entry.workgroupId, repo: entry.repo };
  // The symbolic-ref read runs with the canonical as cwd, so Git reads the
  // canonical's own `.git/commondir` first.
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
    // A repo-only legacy journal cannot identify the checkout GC actually
    // moved. Preserve any missing sibling whose private HEAD is not already
    // contained in the integration branch; it may be the last reference to
    // user commits even when its private index is clean.
    if (!contained) continue;
    if (!removeMissingWorktreeRegistration({ ...entry, worktreePath: record.owner }, dataDir, integrationRef)) {
      return false;
    }
  }
  return true;
}

/**
 * Finish any exact deregistration left pending by a crash between a successful
 * trash and the deregistration loop that follows it. Run once at the
 * start of every apply pass, same shape as recoverOrphanedQuarantine. A repeat
 * failure stays journaled for the next pass; no operator command is required.
 */
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
 * Put a quarantined clone back where it came from.
 *
 * Deliberately not reconcileQuarantine: that one reasons about a topic's
 * `worktrees/<repo>` split and prunes canonical registrations, none of which a
 * clone has. A clone is one directory, so its rollback is one rename. If the
 * destination reappeared while we held the copy, keep BOTH — leave the copy in
 * quarantine for a human. Trashing it would destroy the one thing we could not
 * prove disposable.
 */
/**
 * A clone's recovery marker lives BESIDE its quarantine entry, not inside it.
 *
 * Topics put the marker in the directory so it travels in the same atomic
 * rename. A clone cannot: the post-move check is a git re-proof, and an
 * untracked marker file inside the tree would read as a dirty worktree and
 * abort every single collection. Deleting the marker after the rename instead
 * would strand any entry whose process died in the gap — a markerless entry is
 * exactly what recoverOrphanedQuarantine cannot identify.
 *
 * A sidecar keeps the ordering invariant by writing FIRST: a crash can leave a
 * marker with no entry, which is a stray file the next pass overwrites, but
 * never an entry with no marker. `safeDirectories` lists only directories, so
 * the sidecar is skipped by the recovery scan that walks the quarantine root.
 */
function cloneSidecarPath(quarantinePath: string): string {
  return `${quarantinePath}.meta.json`;
}

function restoreQuarantinedClone(originalPath: string, quarantinePath: string): void {
  // The sidecar is dropped LAST, and only once the entry it describes is gone
  // from quarantine. Deleting it up front looks harmless — the restore is
  // about to happen anyway — but both exits below can leave the entry on
  // disk, and an entry whose marker was already removed is precisely the
  // (entry, no marker) state cloneSidecarPath promises cannot occur:
  // recoverOrphanedQuarantine finds neither marker, logs "no readable
  // recovery metadata", and skips it on every future pass, forever.
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
 * Quarantine-then-verify removal for a scratch clone.
 *
 * Clones get the same quarantine treatment as topics: without the coarse
 * agent-group-live gate a clone can be
 * collected while its group has a live container, so the window between
 * deciding and deleting has to be closed by evidence rather than by refusing
 * the whole class.
 *
 * The rename is atomic and instant. Anything an agent writes afterwards lands
 * in the quarantined copy, where re-running the SAME git proof sees it: a new
 * file makes the tree dirty, a commit makes it unpushed. That is a stronger
 * post-move check than a timestamp, because it re-answers the actual question
 * ("is everything in here recoverable?") rather than a proxy for it.
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

  // Sidecar BEFORE the rename — see cloneSidecarPath. Ordering is the whole
  // point: a crash here leaves a marker with no entry (harmless), never an
  // entry with no marker (unrecoverable).
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
    // No entry was created, so drop the now-meaningless sidecar rather than
    // leaving the next recovery pass a marker pointing at a live directory.
    fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
    throw err;
  }

  const restore = (reason: string): { ok: boolean; reason: string } => {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    return { ok: false, reason };
  };

  // A scratch clone under an active group is always inside a mount source,
  // so only the strong relation refuses one. A topic checkout lives
  // under `<topic>/worktrees`, which is mounted only into its own work unit's
  // containers: inside any mount source means
  // a running container can reach it, so it refuses on anything but 'clear',
  // as finalizeIdleCollection does for a whole topic.
  const freshMounts = runningContainerMounts();
  const relation = freshMounts === null ? null : mountRelation(resolvedOriginal, freshMounts);
  if (relation === null || relation === 'is-mount-source' || (kind === 'topic-checkout' && relation !== 'clear')) {
    return restore('aborted-late-mount');
  }
  const freshCwds = liveProcessCwds();
  if (freshCwds === null || processRootedIn(quarantinePath, freshCwds)) {
    return restore('aborted-late-activity');
  }
  // Re-prove the moved copy, not the original path: this is the check that
  // catches a write landing in the gap between the scan and now.
  // Both callers only ever finalize a clone, so the moved copy is proved as one,
  // against the same tag record as the first proof.
  const decision = disposability.proveCheckoutDisposable({ path: quarantinePath, shape: 'clone', inheritedTagsRecord });
  if (!decision.ok) return restore(`aborted-${decision.reason}`);

  try {
    trashPath(quarantinePath);
  } catch (err) {
    restoreQuarantinedClone(candidate.path, quarantinePath);
    throw err;
  }
  // Only once the entry is genuinely gone. A sidecar outliving its entry is
  // tidied by the next recovery pass, so dropping it here is housekeeping, not
  // a correctness step — and doing it BEFORE the trash would be the stranding
  // bug this sidecar exists to avoid.
  fs.rmSync(cloneSidecarPath(quarantinePath), { force: true });
  // The clone's tag record goes with it. One left behind is harmless: the next
  // build of this name replaces it before publishing.
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

  // Write the recovery marker INTO the topic dir BEFORE the rename that
  // creates the quarantine entry, so the marker travels with the directory in
  // the SAME renameSync — one atomic move, not two separate writes with a
  // crash window between them. A markerless quarantine entry is now
  // impossible: either the marker-bearing directory got renamed, or nothing
  // moved at all.
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

  // Capture the checkouts before trashing (quarantinePath won't exist to list
  // afterward), through the one lister. Only a linked worktree (its `.git` is
  // a file) is registered with a canonical, under the repo its name parses
  // to, `<repo>` or `<repo>@<slug>`; a clone has nothing to deregister.
  const listed = readTopicCheckouts(path.join(quarantinePath, 'worktrees'));
  if (listed === null) {
    // A real read failure (EACCES/EIO), not "no worktrees" — treating it as
    // empty would prune nothing yet still trash the topic. Leave the entry in
    // quarantine untouched: recoverOrphanedQuarantine retries it next pass,
    // which is the safe default the quarantine design already gives for free.
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

  // The durable-write fence runs LAST, immediately before the
  // irreversible trash — not before freshMounts/repoListing above, which
  // themselves cost real wall-clock time (a docker inspect, a readdir). A
  // fence checked earlier leaves that whole span unguarded; checked here it
  // shrinks the residual admission-race window down to roughly the width of
  // the trashPath call itself. Codex P1 (round 5): sessionInventory failing
  // here is not evidence the topic is quiet — participantsByTopic collapses a
  // DB failure into an empty map, indistinguishable from "genuinely no
  // participants" unless checked directly first.
  //
  // The fence, the journal and the trash are ONE `withCentralSync` block
  // (seam 3 §4.5): the inventory read is lease-only, and holding the lease to
  // the rename keeps the span awaitless — the docker inspect and the readdir
  // above stay outside it.
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
      // status/idleSince lag the real admission event —
      // writeSessionMessageLocked inserts into inbound.db and closes it BEFORE
      // it updates last_active, two separate
      // writes. Fence on the durable write itself instead of its lagging
      // index: inbound.db's mtime moves at the insert, not after. A file that
      // appeared, or whose mtime moved forward, or that stopped being statable
      // where it previously was — all count as new activity.
      const inboundMoved = laterThan(prior?.inboundMtimeMs ?? null, p.inboundMtimeMs);
      return (
        !prior || prior.status !== p.status || Date.parse(p.idleSince) > Date.parse(prior.idleSince) || inboundMoved
      );
    });
    if (activityAdvanced) {
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      return { ok: false, reason: 'aborted-late-activity' };
    }

    // Journal the exact deregistrations this trash is about to require BEFORE trashing,
    // so a crash between the trash succeeding and the loop below finishing
    // leaves a durable record instead of a silently dangling registration.
    // runPendingPrunes sweeps this at the start of the next apply pass.
    const priorPending = readPendingPrunes(dataDir);
    const journaled = writePendingPrunes(dataDir, [...priorPending, ...deregistrations]);
    if (!journaled) {
      // Codex P2: a read-only dataDir or ENOSPC here must not fall through to
      // trashing anyway — that's exactly the crash-without-a-record window
      // this journal exists to close. Abort and leave the topic recoverable.
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      return { ok: false, reason: 'aborted-prune-journal-unwritable' };
    }

    // Genuinely clear — commit the delete FIRST. Deregistration runs only once that
    // succeeds (Codex P2): a trash failure below leaves every canonical
    // registration untouched, so the restored checkout stays usable.
    try {
      trashPath(quarantinePath);
    } catch (err) {
      // Restore the EXACT pre-attempt contents rather than filtering by
      // workgroupId/repo (Codex P2): a filter would also strip an unrelated
      // OLDER entry for the same workgroupId/repo left by a previous
      // interrupted pass, losing its retry record permanently. Nothing else
      // touches this file mid-pass, so priorPending is still accurate.
      writePendingPrunes(dataDir, priorPending);
      reconcileQuarantine(candidate, quarantinePath, dataDir);
      throw err;
    }
    return { ok: true };
  }, 'storage gc idle fence and trash');
  if (!trashed.ok) return trashed;

  // Deregister each exact linked worktree from its CANONICAL repo, so a
  // resumed thread's later create_worktree doesn't hit git's "already
  // checked out at <missing-path>" error against a stale registration. Safe
  // because the checkout was proven disposable before trash and the helper
  // re-proves that the private linked index is clean and unlocked. Never use
  // repository-wide prune: unrelated missing owners may retain staged work.
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
 * Re-prove side (a) against live state immediately before removal.
 *
 * The scan snapshotted the inventory; a session can be created, or a container
 * started, while the pass is still walking. Anything unreadable at this point
 * refuses, exactly as it does during the scan.
 *
 * Lease-only: the inventory read is `withRawDb`, so this runs inside the
 * caller's `withCentralSync` block — the same block that trashes a bare topic,
 * so the recheck and the removal stay one synchronous turn.
 */
function stillDisposable(
  candidate: GcCandidate,
  dataDir: string,
  mounts: string[],
  cwds: string[],
): { ok: boolean; reason: string } {
  if (candidate.category === 'clone') {
    // A clone under an active group is ALWAYS inside a mount source, so only
    // the strong relation can refuse here. What stands in for the
    // coarse gate: no process is actually rooted in this directory, and the
    // git proof from the scan is re-run below after the quarantine rename.
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
 * Codex P2 (round 5): if the process dies between the quarantine rename and
 * either restore or trash, the topic is stuck under .gc-quarantine forever —
 * collectOrphanTopics only ever walks v2-topics. Run once at the start of
 * every apply pass. prune only ever runs post-trash now, so any entry found
 * here is still in the pre-trash state: either restorable outright, or (if a
 * spawn recreated the destination while we were down) reconcilable exactly
 * like a live rollback.
 */
function recoverOrphanedQuarantine(dataDir: string, report: GcReport): void {
  const quarantineRoot = path.join(dataDir, '.gc-quarantine');
  for (const entry of safeDirectories(quarantineRoot) ?? []) {
    const quarantinePath = path.join(quarantineRoot, entry);
    let originalPath: string;
    let category: GcCategory;
    try {
      // A clone's marker sits beside the entry (see cloneSidecarPath); a
      // topic's travels inside it. Prefer the sidecar so a clone is never
      // misread as a topic and put through the per-repo prune path.
      const sidecar = cloneSidecarPath(quarantinePath);
      const metaFile = fs.existsSync(sidecar) ? sidecar : path.join(quarantinePath, QUARANTINE_META_FILE);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
        originalPath: string;
        category?: GcCategory;
      };
      originalPath = meta.originalPath;
      // Entries written before clones used quarantine carry no category, and
      // every one of those is a topic.
      category = meta.category ?? 'orphan-topic';
    } catch (err) {
      log.error('Storage GC: orphaned quarantine entry has no readable recovery metadata; leaving it as-is', {
        quarantinePath,
        err,
      });
      continue;
    }
    if (category === 'clone') {
      // A clone's rollback is a plain rename; reconcileQuarantine's per-entry
      // split and canonical deregistration would be meaningless here, and it
      // would take a coincidental `worktrees` directory inside the clone's
      // own tree for a topic's.
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
      // A spawn recreated the destination while the process was down —
      // reconcile exactly like a live rollback (per entry, exact deregistration).
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
      // The marker was removed so it would not land in the restored topic;
      // the entry stayed, so put it back or no later pass can find it.
      rewriteQuarantineMarker(quarantinePath, originalPath);
    }
  }
  try {
    fs.rmdirSync(quarantineRoot); // only succeeds once genuinely empty
  } catch {
    // Non-empty (something is still stranded, already logged above) or
    // never existed — either way, nothing further to do here.
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
  collectOrphanTopics(report, dataDir, owners);
  collectClones(report, dataDir, groupsDir, boundGitDirs(dataDir));

  if (mode === 'apply') {
    const demote = (candidate: GcCandidate, reason: string): void => {
      candidate.collect = false;
      candidate.reason = reason;
      report.collected -= 1;
      report.reclaimableBytes[candidate.category] -= candidate.bytes;
      report.skips[reason] = (report.skips[reason] ?? 0) + 1;
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
          // The recheck reads the inventory under the lease. A bare topic (no
          // idle snapshot, not a clone) is trashed in the SAME block, so its
          // recheck and its removal are one synchronous turn; a clone re-proves
          // itself after the quarantine rename, and an idle topic re-fences
          // inside `finalizeIdleCollection`'s own block.
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

  log.info('Storage GC: ran', {
    mode,
    examined: report.examined,
    collected: report.collected,
    reclaimableBytes: report.reclaimableBytes,
    skips: report.skips,
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

/** Scan a fake /proc tree, so the exit-vs-unreadable split can be exercised. */
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
  // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
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
