/**
 * Rolling thread anchors for recurring task-session posts to a destination
 * (fleet-hardening Phase 1.4). See migration 048 for the "why" — this module
 * is just get/set/delete plus the rotation predicate delivery.ts consults.
 */
import { getDb } from './connection.js';

export interface TaskThreadAnchor {
  threadPlatformId: string;
  createdAt: string;
}

export function getTaskThreadAnchor(
  sessionId: string,
  channelType: string,
  platformId: string,
): TaskThreadAnchor | null {
  const row = getDb()
    .prepare(
      'SELECT thread_platform_id, created_at FROM task_thread_anchors WHERE session_id = ? AND channel_type = ? AND platform_id = ?',
    )
    .get(sessionId, channelType, platformId) as { thread_platform_id: string; created_at: string } | undefined;
  return row ? { threadPlatformId: row.thread_platform_id, createdAt: row.created_at } : null;
}

export function setTaskThreadAnchor(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadPlatformId: string,
  createdAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO task_thread_anchors (session_id, channel_type, platform_id, thread_platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, channel_type, platform_id) DO UPDATE SET
         thread_platform_id = excluded.thread_platform_id,
         created_at = excluded.created_at`,
    )
    .run(sessionId, channelType, platformId, threadPlatformId, createdAt);
}

export function deleteTaskThreadAnchor(sessionId: string, channelType: string, platformId: string): void {
  getDb()
    .prepare('DELETE FROM task_thread_anchors WHERE session_id = ? AND channel_type = ? AND platform_id = ?')
    .run(sessionId, channelType, platformId);
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
