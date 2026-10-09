/**
 * Rolling thread anchors for recurring task-session posts to a destination (migration 048): get/set/delete plus the
 * rotation predicate delivery.ts consults. Single statements only, so none needs `centralTransaction`.
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

/** The thread a task series' session most recently posted into, the series' own thread id having no channel. */
export async function latestTaskSeriesAnchorThread(seriesThreadId: string): Promise<string | null> {
  const row = await getDb().get<{ platform_id: string; thread_platform_id: string }>(
    `SELECT a.platform_id, a.thread_platform_id
       FROM task_thread_anchors a
       JOIN sessions s ON s.id = a.session_id
      WHERE s.thread_id = ?
      ORDER BY a.created_at DESC
      LIMIT 1`,
    seriesThreadId,
  );
  return row ? `${row.platform_id}:${row.thread_platform_id}` : null;
}

/**
 * Rotation granularity: an anchor is reused only while its bucket key matches now's. The UTC calendar day; change the
 * slice length to retune (13 for hourly).
 */
export function anchorRotationKey(iso: string): string {
  return iso.slice(0, 10);
}
