/**
 * Rolling thread anchors for recurring task-session posts to a destination
 * (fleet-hardening Phase 1.4). See migration 048 for the "why" — this module
 * is just get/set/delete plus the rotation predicate delivery.ts consults.
 *
 * Seam 3 PR 5d: the three statements run on the async driver. Each is a single
 * statement — the setter is one `INSERT ... ON CONFLICT DO UPDATE` — so none
 * needs `centralTransaction` (plan §4.1, §4.4).
 */
import { getDb } from './connection.js';

export interface TaskThreadAnchor {
  threadPlatformId: string;
  createdAt: string;
}

export async function getTaskThreadAnchor(
  sessionId: string,
  channelType: string,
  platformId: string,
): Promise<TaskThreadAnchor | null> {
  const row = await getDb().get<{ thread_platform_id: string; created_at: string }>(
    'SELECT thread_platform_id, created_at FROM task_thread_anchors WHERE session_id = ? AND channel_type = ? AND platform_id = ?',
    sessionId,
    channelType,
    platformId,
  );
  return row ? { threadPlatformId: row.thread_platform_id, createdAt: row.created_at } : null;
}

export async function setTaskThreadAnchor(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadPlatformId: string,
  createdAt: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO task_thread_anchors (session_id, channel_type, platform_id, thread_platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, channel_type, platform_id) DO UPDATE SET
         thread_platform_id = excluded.thread_platform_id,
         created_at = excluded.created_at`,
    sessionId,
    channelType,
    platformId,
    threadPlatformId,
    createdAt,
  );
}

export async function deleteTaskThreadAnchor(
  sessionId: string,
  channelType: string,
  platformId: string,
): Promise<void> {
  await getDb().run(
    'DELETE FROM task_thread_anchors WHERE session_id = ? AND channel_type = ? AND platform_id = ?',
    sessionId,
    channelType,
    platformId,
  );
}

/**
 * Rotation granularity: an anchor is reused only while its bucket key
 * matches "now"'s. Default bucket is the UTC calendar day (`YYYY-MM-DD`
 * prefix of an ISO-8601 timestamp) — change the slice length to retune
 * (e.g. `.slice(0, 13)` for hourly buckets). Cheap and obvious on purpose:
 * this is the one constant fleet-hardening 1.4 asked to keep easy to change.
 */
export function anchorRotationKey(iso: string): string {
  return iso.slice(0, 10);
}
