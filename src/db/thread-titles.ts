/**
 * Durable idempotency + retry state for Discord thread topic-titling.
 * See migration 062 for why this table exists and why `channel_type` is
 * stored despite not being in the original spec (sibling-bot token
 * resolution on retry).
 */
import { withCentralSync, withRawDb } from './central-lease.js';

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
  return withCentralSync(
    () =>
      withRawDb((db) => {
        return db.prepare('SELECT * FROM thread_titles WHERE thread_id = ?').get(threadId) as
          | ThreadTitleRow
          | undefined;
      }),
    'thread-titles.getThreadTitleRow',
  );
}

/**
 * Claim a thread for titling. Idempotent — `ON CONFLICT DO NOTHING` so
 * concurrent siblings racing through `maybeRenameNewThread` for the same
 * thread can't double-insert (or clobber an existing row's `first_message`
 * with a later follow-up).
 */
export function insertThreadTitleClaim(
  threadId: string,
  channelType: string,
  firstMessage: string,
  createdAt: string = new Date().toISOString(),
): Promise<void> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare(
          `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at)
       VALUES (@thread_id, @channel_type, @first_message, 0, @created_at)
       ON CONFLICT(thread_id) DO NOTHING`,
        ).run({ thread_id: threadId, channel_type: channelType, first_message: firstMessage, created_at: createdAt });
      }),
    'thread-titles.insertThreadTitleClaim',
  );
}

/** Mark a thread as successfully titled — permanent, never re-attempted again. */
export function markThreadTitled(
  threadId: string,
  title: string,
  titledAt: string = new Date().toISOString(),
): Promise<void> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare(`UPDATE thread_titles SET title = ?, titled_at = ? WHERE thread_id = ?`).run(
          title,
          titledAt,
          threadId,
        );
      }),
    'thread-titles.markThreadTitled',
  );
}

/** Record a failed attempt so the retry sweep's `attempts < N` filter eventually gives up. */
export function recordThreadTitleAttemptFailure(threadId: string): Promise<void> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare(`UPDATE thread_titles SET attempts = attempts + 1 WHERE thread_id = ?`).run(threadId);
      }),
    'thread-titles.recordThreadTitleAttemptFailure',
  );
}

/**
 * Rows still untitled, under the attempt cap, and created within the retry
 * window — the host-sweep retry step's candidate set. Ordered oldest-first so
 * a backlog drains in creation order rather than starving old threads behind
 * a stream of new failures.
 */
export function getPendingThreadTitleRetries(
  sinceIso: string,
  maxAttempts: number,
  limit: number,
): Promise<ThreadTitleRow[]> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        return db
          .prepare(
            `SELECT * FROM thread_titles
       WHERE title IS NULL AND attempts < ? AND created_at >= ?
       ORDER BY created_at ASC
       LIMIT ?`,
          )
          .all(maxAttempts, sinceIso, limit) as ThreadTitleRow[];
      }),
    'thread-titles.getPendingThreadTitleRetries',
  );
}
