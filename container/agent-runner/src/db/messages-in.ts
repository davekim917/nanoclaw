/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

// Parse the two timestamp shapes that live in the session DBs into epoch ms.
// SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' — UTC but with no
// zone marker, which Date.parse would read as LOCAL time. scheduleTask writes
// ISO 'YYYY-MM-DDTHH:MM:SS.SSSZ'. Normalize to explicit-UTC before parsing.
function parseDbUtc(value: string): number {
  let s = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  return Date.parse(s);
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows in
 * chronological order, regardless of their `trigger` flag: accumulated
 * context (trigger=0) rides along with the wake-eligible rows so the agent
 * sees the prior context it missed. Host's countDueMessages gates waking on
 * trigger=1 separately (see src/db/session-db.ts).
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const pending = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           ${onWakeFilter}
         ORDER BY seq DESC
         LIMIT ?2`,
      )
      .all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt()) as MessageInRow[];

    if (pending.length === 0) return [];

    // Filter out messages already acknowledged in outbound.db
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );

    // Idempotency guard: a message that already has a response in messages_out
    // has been handled — even if processing_ack was wiped by clearStaleProcessingAcks
    // or messages_in.status never got synced to 'completed' because the previous
    // container died between writing messages_out and calling markCompleted.
    // Without this, a mid-turn container death after the reply was written but
    // before mark-completed re-processes the same input on next wake and the user
    // gets duplicate replies. messages_out.in_reply_to is set to the originating
    // input id for every response the agent writes; presence of that row is the
    // authoritative "this input has been answered" signal.
    //
    // Due-aware refinement (2026-06-10): a reply can never precede its
    // question. resolveDestinationThread used to stamp destination sends with
    // in_reply_to = the NEWEST inbound row of the channel, so a task turn's
    // output could claim to "answer" a sibling task's future, not-yet-due
    // fire row — permanently suppressing that series (the row stays pending,
    // recurrence never advances). Only honor a reply as the answer to a row
    // if it was written at/after the row became due (process_after). Rows
    // without process_after (chat) keep the original any-reply semantics.
    const respondedAt = new Map<string, number>();
    for (const r of outbound
      .prepare(
        'SELECT in_reply_to AS id, MAX(timestamp) AS ts FROM messages_out WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to',
      )
      .all() as Array<{ id: string; ts: string }>) {
      respondedAt.set(r.id, parseDbUtc(r.ts));
    }
    const pendingById = new Map(pending.map((m) => [m.id, m]));
    const isResponded = (id: string): boolean => {
      const ts = respondedAt.get(id);
      if (ts === undefined) return false;
      const row = pendingById.get(id);
      if (!row || row.process_after == null) return true;
      return ts >= parseDbUtc(row.process_after);
    };

    // Orphan recall_context drain: a `recall-<X>` row is paired to inbound
    // row `<X>` by the host's recall-injection (it strips the prefix to
    // pair). When `<X>` finishes (status='completed' in processing_ack, or
    // a messages_out row exists) but `recall-<X>` was never claimed —
    // happens when X is a /clear command (handled+completed inline at
    // poll-loop.ts:148) or a task gated by pre-task script — the orphan
    // recall sits pending. Without this filter, the cold-start path's
    // accept-any-recall_context filter would later turn the orphan into a
    // standalone "[Recalled context]" prompt with no user message; the
    // in-turn helper drops it but it stays pending forever and gets
    // re-evaluated every poll. Drop it here so both paths see a clean view.
    const isOrphanRecall = (m: MessageInRow): boolean => {
      if (!m.id.startsWith('recall-')) return false;
      const pairedId = m.id.slice('recall-'.length);
      return ackedIds.has(pairedId) || isResponded(pairedId);
    };

    // Reverse: we fetched DESC to take the most recent N, but the agent
    // should see them in chronological order (oldest first).
    return pending
      .filter((m) => !ackedIds.has(m.id) && !isResponded(m.id) && !isOrphanRecall(m))
      .reverse();
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}

