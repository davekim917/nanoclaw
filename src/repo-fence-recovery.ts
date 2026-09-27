/**
 * Releases repository ingress fences whose publication is gone. A fence is durable per-session state and the
 * publication that owns it is not; a stranded fence holds every inbound row and blocks spawns, so the session
 * goes silently deaf.
 */
import { wakeRepositoryMountSessions } from './container-restart.js';
import { getAgentGroup, getAllAgentGroups } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getActiveSessions, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { SessionDbMissingError } from './modules/mailbox/index.js';
import { withExistingMailboxSession } from './session-manager.js';
import {
  isRepositoryLifecycleClaimed,
  isWorkgroupRepositoryMountClaimed,
  resolveRepositoryWorkUnit,
} from './repository-workspaces.js';
import type { AgentGroup, MessagingGroup, Session } from './types.js';

export interface OrphanedRepoFenceRecovery {
  scanned: number;
  active: number;
  released: number;
  inFlight: number;
  failed: number;
  woken: number;
}

function emptyRecovery(): OrphanedRepoFenceRecovery {
  return { scanned: 0, active: 0, released: 0, inFlight: 0, failed: 0, woken: 0 };
}

/** Thousands of synchronous DB opens in one block would starve every channel adapter. */
async function yieldEventLoop(index: number): Promise<void> {
  if (index > 0 && index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Both fencing paths hold an in-memory claim from before quiesce until after release, and spawn admission gates
 * on the same two predicates. The claims are process-local, so at startup every active fence is orphaned.
 * Throws rather than guessing when identity can't be resolved (the caller never releases: fail closed).
 */
function repositoryTransitionInFlight(
  session: Session,
  group: AgentGroup | undefined,
  messagingGroup: MessagingGroup | null,
): boolean {
  // No agent group row means no workgroup for a publication to be claiming.
  if (!group) return false;
  const workgroupId = group.workgroup_id ?? group.folder;
  if (isWorkgroupRepositoryMountClaimed(workgroupId)) return true;
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

/** A mailbox that can't be read answers true, so doubt keeps the quiescing path. */
export async function sessionsHoldRepoIngressFence(sessions: Session[], epochs: readonly string[]): Promise<boolean> {
  const wanted = new Set(epochs);
  for (const [index, session] of sessions.entries()) {
    await yieldEventLoop(index);
    try {
      const held = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
        const fence = mailbox.readRepoIngressFence();
        return fence?.state === 'active' && wanted.has(fence.epoch);
      });
      if (held) return true;
    } catch (err) {
      if (err instanceof SessionDbMissingError) continue;
      return true;
    }
  }
  return false;
}

/** Per-session isolated: an unreadable session is logged and skipped, never allowed to abort the pass. */
export async function releaseOrphanedRepoIngressFences(
  reason: string,
  candidates?: Session[],
  options: { wake?: boolean } = {},
): Promise<OrphanedRepoFenceRecovery> {
  const report = emptyRecovery();
  let sessions: Session[];
  try {
    sessions = candidates ?? (await getActiveSessions());
  } catch (err) {
    log.error('Orphaned repository fence pass could not load sessions', { reason, err });
    return report;
  }

  const wake: Session[] = [];
  for (const [index, session] of sessions.entries()) {
    await yieldEventLoop(index);
    try {
      // Central reads happen BEFORE the session opens so the action below stays synchronous from fence read
      // to release. The wake happens after the loop, so no mailbox session is held across it.
      const group = await getAgentGroup(session.agent_group_id);
      const messagingGroup = session.messaging_group_id
        ? ((await getMessagingGroup(session.messaging_group_id)) ?? null)
        : null;
      const needsWake = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
        report.scanned += 1;
        const fence = mailbox.readRepoIngressFence();
        if (fence?.state !== 'active') return false;
        report.active += 1;
        // No `await` here: a synchronous check-then-release can't tear a live publication's fence away.
        if (repositoryTransitionInFlight(session, group, messagingGroup)) {
          report.inFlight += 1;
          return false;
        }
        const result = mailbox.releaseRepoIngressFence(fence.epoch, fence.generation);
        if (!result.released) return false;
        report.released += 1;
        log.warn('Released an orphaned repository ingress fence', {
          reason,
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          epoch: fence.epoch,
          admittedRows: result.admittedRows,
        });
        // Due rows that predated the fence carry no epoch tag but also need a wake.
        return result.wakeRequired || mailbox.countDueMessages() > 0;
      });
      if (needsWake) wake.push(session);
    } catch (err) {
      // Anything else that throws is a session we couldn't read: visible, not quietly counted fence-free.
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

  // Startup opts out: a spawn here would race the boot sequence; the sweep's due-message wake picks them up.
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

export async function releaseOrphanedRepoIngressFencesAtStartup(): Promise<OrphanedRepoFenceRecovery> {
  return releaseOrphanedRepoIngressFences('host startup', undefined, { wake: false });
}

/**
 * The interval is the cost bound: every cheap per-session pre-filter (inbound mtime, repo-owning workgroups,
 * `fs.existsSync`) misses a real orphaned fence.
 */
export const ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

let lastFullScanAtMs: number | null = null;

export function _resetOrphanedRepoFenceScanForTesting(): void {
  lastFullScanAtMs = null;
}

/** Null on the ticks the throttle skips. */
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
 * A dropped system action is the last moment the host knows a repository transition ended. Scoped to the
 * failing session's workgroup, the widest set either fencing path can touch.
 */
export async function releaseOrphanedRepoIngressFencesForDroppedMessage(
  msg: { kind: string },
  session: Session,
): Promise<OrphanedRepoFenceRecovery | null> {
  if (msg.kind !== 'system') return null;
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) return null;
  const workgroupId = group.workgroup_id ?? group.folder;
  const workgroupGroups = (await getAllAgentGroups()).filter(
    (candidate) => (candidate.workgroup_id ?? candidate.folder) === workgroupId,
  );
  const workgroupSessions = (
    await Promise.all(workgroupGroups.map((candidate) => getSessionsByAgentGroup(candidate.id)))
  ).flat();
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
