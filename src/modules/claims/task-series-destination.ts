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
 * `wiredOnly` skips anchors in channels the owner is not wired to, so a post sent through a destination grant
 * does not shadow a reachable room.
 */
export async function resolveTaskSeries(
  workgroupId: string,
  threadId: string,
  options: { wiredOnly?: boolean } = {},
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
    `SELECT a.channel_type AS channelType, a.platform_id AS platformId, a.thread_platform_id AS threadPlatformId
         FROM task_thread_anchors a
        WHERE a.session_id = ?
          AND (? = 0 OR EXISTS (
                SELECT 1
                  FROM messaging_groups mg
                  JOIN messaging_group_agents mga
                       ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
                 WHERE mg.platform_id = a.platform_id AND mg.channel_type = a.channel_type))
        ORDER BY a.created_at DESC
        LIMIT 1`,
    owner.sessionId,
    options.wiredOnly ? 1 : 0,
    owner.agentGroupId,
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
