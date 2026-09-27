/**
 * scheduleTask: inserts recurring tasks into a session's inbound.db.
 * Security model: `destination` is REQUIRED (without it a task would fall back to the agent group's newest session,
 * which can be any wired chat), and its messaging group MUST be wired to the agent group via `messaging_group_agents`
 * (the credential boundary). The task session is isolated by (agent_group_id, series_id); routing is stamped on the
 * task row.
 * Idempotent via series_id: re-running updates the existing row rather than inserting a duplicate.
 */

import { log } from '../log.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { resolveTaskSession, withExistingMailboxSession, withMailboxSession } from '../session-manager.js';
import type { NanoclawMailboxSession } from '../modules/mailbox/index.js';
import type { Session } from '../types.js';
import { insertOrAdopt } from './insert-or-adopt.js';
import {
  createSession,
  findSessionByAgentGroupAndMessagingGroup,
  getSession,
  setTaskRoutingPlatformId,
  withQuietInvalidationSync,
} from './sessions.js';
import { withCentralSync, withRawDb } from './central-lease.js';

type StampOutcome = 'written' | 'session-closed' | 'series-collision';

/**
 * A move must never turn a target task into an upsert; it opts out of the scheduler's series-id upsert and treats a
 * collision as a recoverable target-insert failure.
 */
export class TaskSeriesCollisionError extends Error {
  constructor(seriesId: string) {
    super(`scheduleTask: target already has a live task series ${seriesId}`);
    this.name = 'TaskSeriesCollisionError';
  }
}

export interface TaskDef {
  id: string;
  agentGroupId: string;
  cron: string;
  processAfter: string;
  /**
   * The slot this occurrence is FOR, when it differs from `processAfter`. Only the board's move flow sets it: a row
   * in retry backoff carries the backoff deadline in `process_after`, and stamping `scheduled_for` from that would
   * change the occurrence's identity.
   */
  scheduledFor?: string;
  seriesId: string;
  prompt: string;
  /**
   * Optional pre-task shell script, written into content exactly as the firing path reads it; the move flow needs it
   * or the script would be dropped. Absent from content when undefined.
   */
  script?: string;
  /**
   * The source task envelope exactly as persisted (move path only): rebuilding from selected fields loses controls
   * such as muteChat and chatLimit.
   */
  rawContent?: string;
  rejectExistingLiveSeries?: boolean;
  status?: 'pending' | 'paused';
  tz?: string;
  /**
   * REQUIRED. The (agent_group_id, messaging_group_id) pair must already be wired via `messaging_group_agents`, or
   * scheduleTask refuses. `threadId=null` posts in the parent channel.
   */
  destination: {
    platformId: string;
    channelType: string;
    threadId: string | null;
  };
  /** Suppresses streaming status updates for the task's turn; final chat messages still deliver. */
  quietStatus?: boolean;
  /**
   * Per-task model/effort for this fire only (turn* variants), applied by the container's applyFlagBatch without
   * changing the agent group's sticky config. Mirrors the chat-side FlagIntent contract.
   */
  flagIntent?: {
    turnModel?: string;
    turnEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    stickyModel?: string;
    stickyEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    clearStickyModel?: boolean;
    clearStickyEffort?: boolean;
  };
}

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Provisions the mailbox for a fresh channel-root session. `prepare()` is the whole path, including the mkdir, so
 * there is no second root to disagree with `DATA_DIR`. NOT `initSessionFolder`: a stub session that never ran a
 * container has no outbox.
 */
function initStubSessionFolder(agentGroupId: string, sessionId: string): void {
  getAgentMailbox().prepare({ agentGroupId, sessionId });
}

/**
 * Resolves or creates the channel-root session (`thread_id IS NULL`), the canonical home for scheduled-task rows.
 * Concurrent callers can both miss the lookup; the `sessions_channel_root_unique` partial index makes the second
 * INSERT throw and `insertOrAdopt` resolves it by re-lookup.
 */
export async function resolveActiveSession(agentGroupId: string, messagingGroupId: string): Promise<{ id: string }> {
  const existing = await findSessionByAgentGroupAndMessagingGroup(agentGroupId, messagingGroupId);
  if (existing) return { id: existing.id };

  const sessionId = generateSessionId();
  const candidate: Session = {
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  const { row, created } = await insertOrAdopt(candidate, createSession, () =>
    findSessionByAgentGroupAndMessagingGroup(agentGroupId, messagingGroupId),
  );
  // Adopted the concurrent winner, whose own call initializes the folder.
  if (!created) return { id: row.id };
  initStubSessionFolder(agentGroupId, sessionId);
  return { id: sessionId };
}

/**
 * Resolves the destination's messaging group and throws unless it exists, the agent group is wired to it, and every
 * peer wired to it is in the same workgroup.
 * SYNCHRONOUS and lease-only (reads via `withRawDb`, so callers must hold `withCentralSync`): nothing can interleave,
 * so `stamp` can run this validation in the SAME block as the task upsert and a revocation cannot commit between the
 * proof and the row.
 */
function validateDestinationUnderLease(def: TaskDef): { messagingGroupId: string } {
  const { platformId, channelType } = def.destination;
  return withRawDb((db) => {
    const mg = db
      .prepare('SELECT id FROM messaging_groups WHERE platform_id = ? AND channel_type = ?')
      .get(platformId, channelType) as { id: string } | undefined;
    if (!mg) {
      throw new Error(
        `scheduleTask: no messaging group found for ${channelType}:${platformId} (task ${def.id}). The destination must reference an existing messaging group.`,
      );
    }
    const wired = db
      .prepare('SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?')
      .get(def.agentGroupId, mg.id);
    if (!wired) {
      throw new Error(
        `scheduleTask: agent group ${def.agentGroupId} is not wired to messaging group ${mg.id} (${channelType}:${platformId}). Refusing to schedule task ${def.id} — this would route output to a chat the agent isn't authorized for. Wire the messaging group via messaging_group_agents first, or correct the agentGroupId.`,
      );
    }

    // Every other agent wired to this messaging group must share the scheduling agent's workgroup, or task output
    // leaks across workgroups. NULL workgroup_id on either side is a violation.
    const hasWorkgroupsCol = (db.prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>).some(
      (c) => c.name === 'workgroup_id',
    );
    if (hasWorkgroupsCol) {
      const schedulingAg = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get(def.agentGroupId) as
        | { workgroup_id: string | null }
        | undefined;
      const schedulingWg = schedulingAg?.workgroup_id ?? null;
      const peerWorkgroups = db
        .prepare(
          `SELECT ag.id, ag.workgroup_id
             FROM messaging_group_agents mga
             JOIN agent_groups ag ON ag.id = mga.agent_group_id
            WHERE mga.messaging_group_id = ? AND mga.agent_group_id != ?`,
        )
        .all(mg.id, def.agentGroupId) as Array<{ id: string; workgroup_id: string | null }>;
      for (const peer of peerWorkgroups) {
        if (peer.workgroup_id == null || schedulingWg == null || peer.workgroup_id !== schedulingWg) {
          throw new Error(
            `scheduleTask: agent ${def.agentGroupId} (workgroup ${schedulingWg ?? 'null'}) ` +
              `cannot schedule into messaging group ${mg.id} — peer agent ${peer.id} is in workgroup ${peer.workgroup_id ?? 'null'}. ` +
              `Refusing to schedule task ${def.id}: tasks belong to a workgroup's data pool and cannot cross workgroup boundaries. ` +
              `Unwire the peer or migrate it to the same workgroup first.`,
          );
        }
      }
    }

    return { messagingGroupId: mg.id };
  });
}

async function resolveAndValidateDestination(def: TaskDef): Promise<{ messagingGroupId: string }> {
  return withCentralSync(() => validateDestinationUnderLease(def), 'resolveAndValidateDestination');
}

export async function scheduleTask(def: TaskDef): Promise<void> {
  await resolveAndValidateDestination(def);
  // The routing stamp is deferred to `stamp`, which applies it only after re-validating the destination.
  const { session } = await resolveTaskSession(def.agentGroupId, def.seriesId);

  const content =
    def.rawContent ??
    JSON.stringify({
      prompt: def.prompt,
      ...(def.script !== undefined ? { script: def.script } : {}),
      ...(def.quietStatus ? { quietStatus: true } : {}),
      ...(def.flagIntent ? { flagIntent: def.flagIntent } : {}),
    });

  // Existing-only first, provisioning only when there is genuinely no mailbox: the session may be live with a running
  // container, and provisioning runs `ensureSchema` (DDL) on the CONTAINER-owned outbound.db from the host. Both
  // funnels carry the pragmas, the storage-activity marker that blocks a concurrent reclaim, and the inbound legacy
  // migrations.
  const stamp =
    (sessionId: string) =>
    async (mailbox: NanoclawMailboxSession): Promise<StampOutcome> => {
      // Re-read the session's status INSIDE the session, immediately before the write, with no await between. During
      // the funnel's await the sweep can close a spent task session, and the row would land in a closed session that
      // never fires while this reports success.
      if ((await getSession(sessionId))?.status !== 'active') return 'session-closed';
      // AUTHORIZATION is re-validated INSIDE the upsert's lease block: the wiring proved before the funnel's await
      // can be revoked in that window, and a persisted route becomes real at fire time (`delivery.ts` permits a
      // non-origin send when `agent_destinations` has no entry). A separate transaction ahead of the block is not
      // enough, since a queued revocation commits between them. It throws before anything is written.
      // The routing stamp (`sessions.task_routing_platform_id`, which the Observatory reads) lands only after that
      // re-proof. The task row and the stamp are in two databases with no shared transaction, so they are
      // compensated: write the row, then stamp, and if the stamp throws, restore the ONE row the upsert touched (by
      // row id, never series id: a series can hold a second live row) and rethrow.
      // The quiet-mark invalidation shares the upsert's synchronous block, so no sweep tick can flush a mark over
      // work it cannot see, and it fails closed on a vanished or inactive session row.
      // Known gap: a concurrent re-schedule of the same series can land between this write and the stamp; if this
      // stamp then fails, the restore overwrites the other writer's row. A compare-and-restore would need a
      // mailbox-side primitive.
      const upserted = await withCentralSync(() => {
        validateDestinationUnderLease(def);
        return withQuietInvalidationSync(sessionId, () =>
          mailbox.upsertTaskSeries({
            id: def.id,
            seriesId: def.seriesId,
            processAfter: def.processAfter,
            scheduledFor: def.scheduledFor,
            recurrence: def.cron,
            content,
            status: def.status,
            rejectExistingLiveSeries: def.rejectExistingLiveSeries,
            platformId: def.destination.platformId,
            channelType: def.destination.channelType,
            threadId: def.destination.threadId,
          }),
        );
      }, 'scheduleTask upsert');
      if ('collision' in upserted) return 'series-collision';
      try {
        await setTaskRoutingPlatformId(sessionId, def.destination.platformId);
      } catch (err) {
        try {
          mailbox.restoreTaskSeries(upserted.touchedId, upserted.prior, upserted.priorRecall);
        } catch (restoreErr) {
          // Both databases are now inconsistent: say so loudly, and still surface the original failure.
          log.error('scheduleTask: the routing stamp failed AND the task row could not be restored', {
            seriesId: def.seriesId,
            sessionId,
            err,
            restoreErr,
          });
        }
        throw err;
      }
      return 'written';
    };

  // `undefined` means no mailbox and falls through to provisioning.
  const write = async (sessionId: string): Promise<StampOutcome> => {
    const action = stamp(sessionId);
    const existing = await withExistingMailboxSession(def.agentGroupId, sessionId, action);
    if (existing !== undefined) return existing;
    // Asked BEFORE provisioning too: `prepare()` would otherwise hand a closed session a host-authored outbound.db.
    // This only narrows the window; the action's own check is authoritative.
    if ((await getSession(sessionId))?.status !== 'active') return 'session-closed';
    return await withMailboxSession(def.agentGroupId, sessionId, action);
  };

  // Due-ness lives in the session DB, invisible to the sweep's persisted quiet cache, so each write invalidates the
  // quiet mark (inside `stamp`, adjacent to the upsert) for only the session it writes to.
  const first = await write(session.id);
  if (first === 'written') {
    return;
  }
  if (first === 'series-collision') throw new TaskSeriesCollisionError(def.seriesId);

  // Lost the race: retry once. This terminates because `resolveTaskSession` only returns active sessions, so a fresh
  // one is minted.
  const retry = await resolveTaskSession(def.agentGroupId, def.seriesId);
  const second = await write(retry.session.id);
  if (second === 'written') {
    return;
  }
  if (second === 'series-collision') throw new TaskSeriesCollisionError(def.seriesId);
  throw new Error(
    `scheduleTask: task session for series ${def.seriesId} was closed twice while scheduling; not retrying again`,
  );
}
