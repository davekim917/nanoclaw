/**
 * Where a scheduled-task series' output lands. Its claim thread is `system:tasks:<seriesId>`, a session with no
 * messaging group, so the thread names no room a reader could follow.
 */
import { getDb } from '../../db/connection.js';
import { readSessionInbound } from '../mailbox/index.js';

interface TaskSeriesOwner {
  sessionId: string;
  agentGroupId: string;
  name: string;
  folder: string;
}

/** `threadId` is the full `<platform_id>:<thread>` id; `null` means the channel with no thread. */
interface TaskSeriesDestination {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * The task session row is the owner. Destination, ranked: the newest `task_thread_anchors` row (where output
 * actually landed), then the series' routing stamp (where an unaddressed reply falls back to), else none.
 */
export async function resolveTaskSeries(
  workgroupId: string,
  threadId: string,
): Promise<{ owner: TaskSeriesOwner; destination: TaskSeriesDestination | null } | null> {
  const owner = await getDb().get<TaskSeriesOwner>(
    `SELECT s.id AS sessionId, ag.id AS agentGroupId, ag.name AS name, ag.folder AS folder
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.thread_id = ? AND ag.workgroup_id = ?
        ORDER BY s.created_at DESC
        LIMIT 1`,
    threadId,
    workgroupId,
  );
  if (!owner) return null;

  const anchor = await getDb().get<{ channelType: string; platformId: string; threadPlatformId: string }>(
    `SELECT channel_type AS channelType, platform_id AS platformId, thread_platform_id AS threadPlatformId
         FROM task_thread_anchors
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    owner.sessionId,
  );
  if (anchor) {
    return {
      owner,
      destination: {
        channelType: anchor.channelType,
        platformId: anchor.platformId,
        threadId: `${anchor.platformId}:${anchor.threadPlatformId}`,
      },
    };
  }

  // Read-only: a probe must never provision or migrate the session. No mailbox
  // reads as "no routing stamp", and `--isolated` stamped none on purpose.
  // `system:tasks:<seriesId>` — the series id is everything after the prefix.
  const stamp = readSessionInbound(
    { agentGroupId: owner.agentGroupId, sessionId: owner.sessionId },
    (mailbox) => mailbox.getLatestTaskRoutingStamp(threadId.split(':').slice(2).join(':')),
    { busyTimeoutMs: 5000, recoverJournal: true },
  );
  return { owner, destination: stamp ?? null };
}
