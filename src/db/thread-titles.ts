/**
 * Idempotency and retry state for Discord thread titling (migration 062). `channel_type` is stored so a retry can
 * resolve the sibling bot's token. Single statements only, so none needs `centralTransaction`.
 */
import { getDb } from './connection.js';

export interface ThreadTitleRow {
  thread_id: string;
  channel_type: string;
  title: string | null;
  first_message: string;
  attempts: number;
  created_at: string;
  titled_at: string | null;
}

export function getThreadTitleRow(threadId: string): Promise<ThreadTitleRow | undefined> {
  return getDb().get<ThreadTitleRow>('SELECT * FROM thread_titles WHERE thread_id = ?', threadId);
}

/**
 * `ON CONFLICT DO NOTHING`: siblings racing through `maybeRenameNewThread` must not double-insert or clobber
 * `first_message` with a later follow-up.
 */
export async function insertThreadTitleClaim(
  threadId: string,
  channelType: string,
  firstMessage: string,
  createdAt: string = new Date().toISOString(),
): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at)
       VALUES (@thread_id, @channel_type, @first_message, 0, @created_at)
       ON CONFLICT(thread_id) DO NOTHING`,
    { thread_id: threadId, channel_type: channelType, first_message: firstMessage, created_at: createdAt },
  );
}

/** Permanent: never re-attempted. */
export async function markThreadTitled(
  threadId: string,
  title: string,
  titledAt: string = new Date().toISOString(),
): Promise<void> {
  await getDb().run(`UPDATE thread_titles SET title = ?, titled_at = ? WHERE thread_id = ?`, title, titledAt, threadId);
}

export async function recordThreadTitleAttemptFailure(threadId: string): Promise<void> {
  await getDb().run(`UPDATE thread_titles SET attempts = attempts + 1 WHERE thread_id = ?`, threadId);
}

/** Oldest-first, so a backlog drains in creation order instead of starving old threads behind new failures. */
export function getPendingThreadTitleRetries(
  sinceIso: string,
  maxAttempts: number,
  limit: number,
): Promise<ThreadTitleRow[]> {
  return getDb().all<ThreadTitleRow>(
    `SELECT * FROM thread_titles
       WHERE title IS NULL AND attempts < ? AND created_at >= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    maxAttempts,
    sinceIso,
    limit,
  );
}
