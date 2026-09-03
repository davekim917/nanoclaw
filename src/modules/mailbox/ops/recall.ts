/**
 * Reads behind the pre-turn recall pairing in `session-manager.ts`.
 *
 * Internal to `src/modules/mailbox/`. Every inbound write pairs its trigger
 * row with an inert `recall-<id>` context row, and deciding what that row
 * should contain takes four reads: two of the container's provider state in
 * outbound.db, two of the recall rows already in the inbound queue. They moved
 * here with the rest of the ingress family so the writer no longer needs a raw
 * handle of its own (plan §4.4, Ingress row).
 *
 * Deliberately four named ops rather than one "run this SQL" helper: the point
 * of the seam is that every statement is nameable and lives in one place.
 */
import type Database from 'better-sqlite3';

export interface ProviderRecallState {
  contextEpoch: number;
  hasContinuation: boolean;
}

/**
 * The container-owned memory epoch and continuation flag for one provider.
 *
 * A non-integer or negative epoch reads as 0 — the same "treat it as fresh"
 * answer the host gives when outbound.db cannot be read at all.
 */
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
 * Content of every chat row still open in the queue, newest first.
 *
 * The caller looks for a queued `/clear`: the runner owns the epoch write, so
 * a reset already queued ahead of this message is invisible in outbound.db and
 * has to be read off the inbound queue instead.
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

/** The most recent recall rows, newest first, bounded by `limit`. */
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
