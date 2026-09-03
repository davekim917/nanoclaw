/**
 * Recovery for repository ingress fences whose publication is gone.
 *
 * Incident 2026-09-01 19:10 UTC. A repository publication
 * (`applyRepositoryPublishAction`) fenced ~1400 session inbound DBs across one
 * workgroup with the epoch `repository-publish:repo-1788289675241-b13bcab3ec972233`
 * (`repo_ingress_fence.state = 'active'` in each file), then failed on a
 * session whose DB had just been reclaimed. The strict release
 * (`releaseRepositoryMountQuiescence`) fails fast on the first bad session, so
 * it threw on that same session and left every session behind it fenced. The
 * delivery layer retried the row three times, hit the same failure each time,
 * logged "Message delivery failed permanently, giving up", and dropped it.
 *
 * 1401 of 1638 session DBs were still fenced 2.5 hours later. Every inbound row
 * written since had been auto-tagged by the `messages_in_repo_fence_*` triggers
 * and held with `trigger = 0`, and `container-runner.ts` refuses to spawn while
 * a session's fence is active — so the whole workgroup went deaf on every
 * pre-existing thread, silently, with no code path anywhere in the host able to
 * release a fence whose publication no longer exists.
 *
 * A fence is durable per-session state; the publication that owns it is not.
 * This module is the missing other side: find active fences that no live
 * publication owns, and release them.
 */
import { wakeRepositoryMountSessions } from './container-restart.js';
import { getAgentGroup, getAllAgentGroups } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getActiveSessions, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { SessionDbMissingError } from './modules/mailbox/index.js';
import { withExistingNanoclawSession } from './modules/mailbox/session.js';
import {
  isRepositoryLifecycleClaimed,
  isWorkgroupRepositoryMountClaimed,
  resolveRepositoryWorkUnit,
} from './repository-workspaces.js';
import type { Session } from './types.js';

export interface OrphanedRepoFenceRecovery {
  /** Sessions whose inbound DB was actually opened and inspected. */
  scanned: number;
  /** Sessions found holding an active fence. */
  active: number;
  /** Active fences released because their publication was gone. */
  released: number;
  /** Active fences left alone because their publication is still running. */
  inFlight: number;
  /** Sessions skipped because their inbound DB could not be read. */
  failed: number;
  /** Released sessions that had due work waiting behind the fence. */
  woken: number;
}

function emptyRecovery(): OrphanedRepoFenceRecovery {
  return { scanned: 0, active: 0, released: 0, inFlight: 0, failed: 0, woken: 0 };
}

/**
 * Same bound `activateRepositoryMountBarriers` uses. Each session costs one
 * better-sqlite3 open plus an indexed read under `journal_mode=DELETE`; a
 * workgroup with thousands of sessions would otherwise stall the host event
 * loop in one contiguous block and starve every unrelated channel adapter.
 */
async function yieldEventLoop(index: number): Promise<void> {
  if (index > 0 && index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The authoritative "this fence's publication is still in flight" signal.
 *
 * Both fencing paths take an in-memory claim BEFORE they quiesce and hold it
 * until after the barrier release:
 *
 * - publish  → `withWorkgroupRepositoryMountClaim(workgroupId, …)` wraps the
 *   whole of `applyRepositoryPublishAction`'s quiesce → publish → release.
 * - transfer → `withRepositoryLifecycleClaims([source, destination], …)` inside
 *   `transferRepositoryWorktree` wraps `beforeMoveWhileClaimed` (which
 *   quiesces the destination work unit) through the release.
 *
 * `container-runner.ts` gates spawn admission on exactly these two predicates,
 * so they are the host's own definition of "a repository transition owns this
 * session right now" — not a second opinion invented here. No new persistence
 * store is needed, and none is added.
 *
 * Both claim sets are process-local `Set`s in `src/repository-workspaces.ts`.
 * That is precisely why the startup pass is unconditional: a fresh process
 * holds no claims, so EVERY active fence it finds is orphaned by definition —
 * its publication died with the previous process.
 *
 * Throws rather than guessing when identity cannot be resolved; the caller
 * counts that session as unreadable and never releases it (fail closed).
 */
function repositoryTransitionInFlight(session: Session): boolean {
  const group = getAgentGroup(session.agent_group_id);
  // No agent group row means no workgroup for a publication to be claiming.
  if (!group) return false;
  const workgroupId = group.workgroup_id ?? group.folder;
  if (isWorkgroupRepositoryMountClaimed(workgroupId)) return true;
  const messagingGroup = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
  return isRepositoryLifecycleClaimed(
    resolveRepositoryWorkUnit({
      workgroupId,
      sessionId: session.id,
      platformId: messagingGroup?.platform_id ?? null,
      messagingGroupId: session.messaging_group_id ?? null,
      threadId: session.thread_id ?? null,
    }),
  );
}

/**
 * Release every active repository ingress fence whose publication is gone.
 *
 * Per-session isolated by construction: a session whose inbound DB cannot be
 * opened (reclaimed directory, corrupt file — exactly the failure that started
 * the incident) is logged and skipped, never allowed to abort the pass. That is
 * the whole point; the original rollback loop aborting on one bad session is
 * what stranded the other 1400.
 */
export async function releaseOrphanedRepoIngressFences(
  reason: string,
  candidates?: Session[],
  options: { wake?: boolean } = {},
): Promise<OrphanedRepoFenceRecovery> {
  const report = emptyRecovery();
  let sessions: Session[];
  try {
    sessions = candidates ?? getActiveSessions();
  } catch (err) {
    log.error('Orphaned repository fence pass could not load sessions', { reason, err });
    return report;
  }

  const wake: Session[] = [];
  for (const [index, session] of sessions.entries()) {
    await yieldEventLoop(index);
    try {
      // `withExistingMailboxSession`: reads never provision (invariant I-4),
      // and a session with no mailbox has no fence — the ordinary steady state.
      // The wake happens after the loop, so no mailbox session is ever held
      // across `wakeRepositoryMountSessions` (invariant I-3).
      const needsWake = await withExistingNanoclawSession(session.agent_group_id, session.id, (mailbox) => {
        report.scanned += 1;
        const fence = mailbox.readRepoIngressFence();
        if (fence?.state !== 'active') return false;
        report.active += 1;
        // No `await` inside this action: the claim is dropped only after the
        // owning publication has released its own barriers, so a synchronous
        // check-then-release cannot tear a live publication's fence out from
        // under it.
        if (repositoryTransitionInFlight(session)) {
          report.inFlight += 1;
          return false;
        }
        const result = mailbox.releaseRepoIngressFence(fence.epoch, fence.generation);
        // A concurrent release won the race — durable state is already correct.
        if (!result.released) return false;
        report.released += 1;
        log.warn('Released an orphaned repository ingress fence', {
          reason,
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          epoch: fence.epoch,
          admittedRows: result.admittedRows,
        });
        // Recompute from durable state rather than trusting the admission
        // result alone: ordinary due rows that predated the fence also need a
        // wake, and they carry no epoch tag.
        return result.wakeRequired || mailbox.countDueMessages() > 0;
      });
      if (needsWake) wake.push(session);
    } catch (err) {
      // The module's own answer is the classifier, not `fs.existsSync`: a
      // session is reported gone only for a real ENOENT/ENOTDIR, never for a
      // path the filesystem merely declined to answer about (EACCES, EMFILE).
      // A session with no mailbox has no fence and resolves `undefined` above
      // rather than throwing; anything that DOES throw is a session we could
      // not read and must be visible rather than quietly counted as fence-free.
      if (err instanceof SessionDbMissingError) continue;
      report.failed += 1;
      log.warn('Orphaned repository fence pass skipped an unreadable session', {
        reason,
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Startup passes opt out: channel adapters, the delivery polls and
  // `resetPhantomContainerStatus` all run later in main(), so a spawn issued
  // here would race the boot sequence. The fence release already made those
  // rows due, and the host sweep's own due-message wake is what picks them up.
  if (options.wake === false) return report;
  for (const session of wake) {
    try {
      wakeRepositoryMountSessions([session]);
      report.woken += 1;
    } catch (err) {
      log.warn('Failed to wake a session after releasing its orphaned repository fence', {
        reason,
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

/**
 * Startup pass. A fresh process holds no repository mount or lifecycle claims,
 * so every active fence on disk belongs to a publication that died with the
 * previous process and is orphaned by definition.
 */
export async function releaseOrphanedRepoIngressFencesAtStartup(): Promise<OrphanedRepoFenceRecovery> {
  return releaseOrphanedRepoIngressFences('host startup', undefined, { wake: false });
}

/**
 * Full-pass cadence for the 60s host sweep.
 *
 * Opening 1600+ inbound DBs every minute is real cost for a condition that is
 * rare and, once present, static — an orphaned fence does not heal or worsen
 * between passes. The interval IS the cost bound, deliberately, because every
 * cheap per-session pre-filter considered was unsound: an inbound-mtime filter
 * misses a fence that has been quiet for hours (the incident's own shape), a
 * "workgroups that have canonical repositories" filter misses a first
 * publication that failed before creating one, and an `fs.existsSync` filter
 * reports an unreadable-but-present session as absent (see
 * `sessionDbPathIsGone` in src/modules/mailbox/openers.ts). Five minutes bounds the worst
 * case a running host can stay deaf while keeping amortised cost near zero,
 * and startup already covers the far more common "host restarted after a
 * failed publication" case immediately.
 */
export const ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** null until the first pass, so a fresh process never skips its first tick. */
let lastFullScanAtMs: number | null = null;

/** Test seam: forget the throttle so a test can force consecutive passes. */
export function _resetOrphanedRepoFenceScanForTesting(): void {
  lastFullScanAtMs = null;
}

/** Host-sweep step. Returns null on the ticks the throttle skips. */
export async function sweepOrphanedRepoIngressFences(
  sessions: Session[],
  nowMs: number = Date.now(),
): Promise<OrphanedRepoFenceRecovery | null> {
  if (lastFullScanAtMs !== null && nowMs - lastFullScanAtMs < ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS) return null;
  lastFullScanAtMs = nowMs;
  const report = await releaseOrphanedRepoIngressFences('host sweep', sessions);
  if (report.released > 0 || report.failed > 0) {
    log.warn('Host sweep released orphaned repository ingress fences', { ...report });
  }
  return report;
}

/**
 * Last-chance recovery when the delivery layer permanently drops a message.
 *
 * A dropped system action is the last moment the host knows a repository
 * transition ended: the publication's mount claim is already released, its
 * error was surfaced, and nothing will retry it. In the incident this was the
 * exact point at which 1401 fences became permanent. Scoped to the failing
 * session's workgroup, which is the widest set either fencing path can touch.
 */
export async function releaseOrphanedRepoIngressFencesForDroppedMessage(
  msg: { kind: string },
  session: Session,
): Promise<OrphanedRepoFenceRecovery | null> {
  // Only system actions reach `handleSystemAction`, and only repository
  // publish/transfer actions there can fence anything. A dropped chat row
  // never justifies opening every inbound DB in a workgroup.
  if (msg.kind !== 'system') return null;
  const group = getAgentGroup(session.agent_group_id);
  if (!group) return null;
  const workgroupId = group.workgroup_id ?? group.folder;
  const workgroupSessions = getAllAgentGroups()
    .filter((candidate) => (candidate.workgroup_id ?? candidate.folder) === workgroupId)
    .flatMap((candidate) => getSessionsByAgentGroup(candidate.id));
  const report = await releaseOrphanedRepoIngressFences('dropped delivery', workgroupSessions);
  if (report.released > 0 || report.failed > 0) {
    log.warn('Released orphaned repository ingress fences after a dropped delivery', {
      ...report,
      workgroupId,
      sessionId: session.id,
    });
  }
  return report;
}
