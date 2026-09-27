/**
 * Reads behind the pre-turn recall pairing. Deliberately named ops rather
 * than a "run this SQL" helper, so every statement lives in one place.
 */
import type Database from 'better-sqlite3';

export interface ProviderRecallState {
  contextEpoch: number;
  hasContinuation: boolean;
}

/** A non-integer or negative epoch reads as 0 ("fresh"), same as an unreadable outbound.db. */
export function readProviderRecallState(outbound: Database.Database, provider: string): ProviderRecallState {
  const epochRow = outbound
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(`memory_context_epoch:${provider}`) as { value: string } | undefined;
  const parsedEpoch = Number.parseInt(epochRow?.value ?? '0', 10);
  return {
    contextEpoch: Number.isSafeInteger(parsedEpoch) && parsedEpoch >= 0 ? parsedEpoch : 0,
    hasContinuation:
      outbound.prepare('SELECT 1 FROM session_state WHERE key = ? LIMIT 1').get(`continuation:${provider}`) !==
      undefined,
  };
}

/**
 * The runner owns the epoch write, so a `/clear` already queued ahead of this
 * message is visible only on the inbound queue.
 */
export function listOpenChatContents(inbound: Database.Database): Array<{ content: string }> {
  return inbound
    .prepare(
      `SELECT content
         FROM messages_in
        WHERE kind IN ('chat', 'chat-sdk')
          AND status NOT IN ('completed', 'failed', 'cancelled')
          AND instr(lower(content), '/clear') > 0
        ORDER BY seq DESC
      `,
    )
    .all() as Array<{ content: string }>;
}

export function listRecentRecallRows(
  inbound: Database.Database,
  limit: number,
): Array<{ id: string; status: string; content: string }> {
  return inbound
    .prepare(
      `SELECT id, status, content
         FROM messages_in
        WHERE kind = 'system'
          AND id LIKE 'recall-%'
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; status: string; content: string }>;
}

/**
 * True when a live recall row for this (provider, epoch) already carries the
 * capability bootstrap — i.e. this message's recall may ship the delta only.
 */
export function hasMatchingBootstrapRecall(
  inbound: Database.Database,
  excludeRecallId: string | null,
  provider: string,
  contextEpoch: number,
): boolean {
  return (
    inbound
      .prepare(
        `SELECT 1
           FROM messages_in
          WHERE kind = 'system'
            AND id LIKE 'recall-%'
            AND (? IS NULL OR id <> ?)
            AND status NOT IN ('failed', 'cancelled')
            AND json_valid(content)
            AND json_extract(content, '$.subtype') = 'recall_context'
            AND json_extract(content, '$.provider') = ?
            AND json_extract(content, '$.contextEpoch') = ?
            AND json_type(content, '$.trustedCapabilities') = 'object'
          LIMIT 1`,
      )
      .get(excludeRecallId, excludeRecallId, provider, contextEpoch) !== undefined
  );
}
