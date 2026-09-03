/**
 * Named read ops for the host's operator surfaces (dashboard, Observatory,
 * the orchestrator-dispatch watchdog, the usage rollup).
 *
 * These used to be inline SQL in the caller, executed on a handle the caller
 * opened itself. They live here for the same reason every other op does: the
 * mailbox module is the only code on the host that knows the session-DB shape
 * (docs/specs/upstream-mailbox-seam/plan.md §4.1, invariant I-2). Each op is
 * named after the QUESTION the surface asks, not after the table it reads —
 * there is deliberately no "run this SQL" escape hatch, because that is the
 * hole every ratchet pattern exists to close.
 *
 * All of these are reads. The read-only session (../read-only.ts) is what
 * binds them to handles that can never provision, migrate or write.
 */
import type Database from 'better-sqlite3';

/* ─── Scheduled-task board (inbound) ───────────────────────────────────────── */

/**
 * One scheduled-task row as every board surface reads it.
 *
 * A superset of the column sets the list, the detail drawer, the mutation gate
 * and the move flow each used to select for themselves — one shape, so a
 * caller that needs one more field does not mint a fifth near-identical query.
 */
export interface ScheduledTaskRow {
  id: string;
  series_id: string | null;
  recurrence: string | null;
  process_after: string | null;
  status: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

const SCHEDULED_COLUMNS = `id, series_id, recurrence, process_after, status, kind, timestamp,
         platform_id, channel_type, thread_id, content`;

/**
 * Series ids with MORE THAN ONE live task row — the duplicate-fire signature
 * the board flags. Every live row of such a series is surfaced (see
 * {@link listLiveTaskRowsForSeries}), because the second fireable row is the
 * one a MAX(seq) view hides.
 */
export function listDuplicateLiveTaskSeriesIds(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT series_id FROM messages_in
        WHERE status IN ('pending', 'paused') AND kind = 'task'
        GROUP BY series_id HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ series_id: string | null }>;
  return rows.map((r) => r.series_id).filter((s): s is string => s !== null);
}

/**
 * The newest row of every RECURRING series, cancelled series excluded.
 *
 * Terminal-but-still-recurring rows are deliberately included: the board's
 * strand detector needs to see a fired series that minted no successor, which
 * is exactly what a terminal latest row means.
 */
export function listLatestRecurringSeriesRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM messages_in
        WHERE recurrence IS NOT NULL
          AND status != 'cancelled'
          AND seq = (SELECT MAX(m2.seq) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id)`,
    )
    .all() as ScheduledTaskRow[];
}

/** Live (pending|paused) one-off task rows — no recurrence. */
export function listLiveOneOffTaskRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM messages_in
        WHERE recurrence IS NULL AND kind = 'task' AND status IN ('pending', 'paused')
          AND seq = (SELECT MAX(m2.seq) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id)`,
    )
    .all() as ScheduledTaskRow[];
}

/**
 * Every live (pending|paused) task row in the session, newest first.
 *
 * Session-wide rather than per-series: the consolidation migration walks a
 * legacy session's whole scheduled backlog, and asking per series would first
 * require knowing the series, which is what this answers.
 */
export function listLiveTaskRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM messages_in
        WHERE kind = 'task' AND status IN ('pending', 'paused')
        ORDER BY seq DESC`,
    )
    .all() as ScheduledTaskRow[];
}

/** Every live row of one series, not just the newest. */
export function listLiveTaskRowsForSeries(db: Database.Database, seriesId: string): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${SCHEDULED_COLUMNS}
         FROM messages_in
        WHERE series_id = ? AND status IN ('pending', 'paused') AND kind = 'task'`,
    )
    .all(seriesId) as ScheduledTaskRow[];
}

/**
 * The newest LIVE row of a series, whatever its kind.
 *
 * Kind-agnostic on purpose — the detail drawer resolves a board row the list
 * built from `recurrence IS NOT NULL`, which is not restricted to `task`.
 */
export function getLiveSeriesRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${SCHEDULED_COLUMNS} FROM messages_in
          WHERE series_id = ? AND status IN ('pending', 'paused')
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

/** The newest row of a series regardless of status — an ended series still renders. */
export function getLatestSeriesRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(`SELECT ${SCHEDULED_COLUMNS} FROM messages_in WHERE series_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

/**
 * The newest LIVE `task` row of a series.
 *
 * The kind-filtered twin of {@link getLiveSeriesRow}: the mutation gate, the
 * move flow and the detail bodies all mean "the scheduled task", and a
 * non-task row sharing the series id must never be edited, paused or moved.
 */
export function getLiveTaskRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${SCHEDULED_COLUMNS} FROM messages_in
          WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

/** The newest `task` row of a series regardless of status. */
export function getLatestTaskRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${SCHEDULED_COLUMNS} FROM messages_in WHERE series_id = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

/** One past fire of a series, as the detail drawer's history list reads it. */
export interface TaskFireRow {
  id: string;
  status: string;
  process_after: string | null;
  timestamp: string;
}

/** The last `limit` TERMINAL fires of a series, newest first. */
export function listRecentTaskFires(db: Database.Database, seriesId: string, limit: number): TaskFireRow[] {
  return db
    .prepare(
      `SELECT id, status, process_after, timestamp
         FROM messages_in
        WHERE series_id = ? AND kind = 'task'
          AND status IN ('completed', 'failed', 'expired', 'cancelled')
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(seriesId, limit) as TaskFireRow[];
}

/* ─── Container / claim state (outbound) ───────────────────────────────────── */

/** Ids of the inbound messages a container currently holds a processing claim on. */
export function listProcessingClaimedMessageIds(db: Database.Database): string[] {
  return (
    db.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>
  ).map((r) => r.message_id);
}

/**
 * Is a work-continuation chain queued or running for this session?
 *
 * The continuation family owns the statement (invariant I-2); this is the
 * read-side name for it, re-exported rather than re-implemented.
 */
export { hasWorkContinuationRow as hasWorkContinuation } from './continuation.js';

/* ─── Outbound message history ─────────────────────────────────────────────── */

/**
 * The newest reply timestamp per inbound message this session has answered.
 *
 * The board's fire history uses it to tell "ran and said something" from
 * "completed with no chat output"; nothing else about the reply matters, so
 * only the timestamp comes back.
 */
export function latestReplyTimestampByTrigger(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      'SELECT in_reply_to, MAX(timestamp) AS ts FROM messages_out WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to',
    )
    .all() as Array<{ in_reply_to: string; ts: string }>;
  return new Map(rows.map((r) => [r.in_reply_to, r.ts]));
}

/** One outbound `system` row — the envelope only; the caller parses `content`. */
export interface OutboundSystemRow {
  timestamp: string;
  content: string;
}

/**
 * Every outbound `system` row. The dispatch watchdog scans these for terminal
 * spawn actions; it parses `content` as JSON itself rather than matching a
 * substring here, so this op stays a plain read and the classification stays
 * with the module that owns the vocabulary.
 */
export function listOutboundSystemMessages(db: Database.Database): OutboundSystemRow[] {
  return db.prepare("SELECT timestamp, content FROM messages_out WHERE kind = 'system'").all() as OutboundSystemRow[];
}

/* ─── Per-turn usage (outbound) ────────────────────────────────────────────── */

/**
 * One container-written per-turn usage row.
 *
 * The optional fields postdate the original table: a row written by a
 * container older than them comes back WITHOUT those keys at all (`SELECT *`
 * returns the columns that exist), so every reader goes through `??`.
 */
export interface SessionTurnUsageRow {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  steps?: number | null;
  duration_ms?: number | null;
  trigger?: string | null;
  rate_limit_type?: string | null;
  rate_limit_utilization?: number | null;
  rate_limit_resets_at?: string | null;
  turn_id?: string | null;
}

/**
 * Turn-usage rows newer than the central watermark, oldest first.
 *
 * Returns `[]` when the table is absent — a session whose container never
 * wrote usage is the normal case, not an error, and the caller must not have
 * to probe `sqlite_master` itself to find that out.
 */
export function listTurnUsageSince(db: Database.Database, afterId: number): SessionTurnUsageRow[] {
  const present =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'turn_usage' LIMIT 1").get() !== undefined;
  if (!present) return [];
  return db.prepare('SELECT * FROM turn_usage WHERE id > ? ORDER BY id ASC').all(afterId) as SessionTurnUsageRow[];
}

/* ─── Fleet-fan-out probes (inbound) ───────────────────────────────────────── */

/**
 * The id of the newest inbound row, or `null` on an empty mailbox.
 *
 * The SSE feed stamps its `inbound_message` frame with it so a console client
 * can dedupe against the row it already rendered; a mailbox with no rows falls
 * back to the caller's synthetic id.
 */
export function latestInboundMessageId(db: Database.Database): string | null {
  const row = db.prepare('SELECT id FROM messages_in ORDER BY seq DESC LIMIT 1').get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Does this session hold at least one live recurring row?
 *
 * Kind-agnostic and status-scoped exactly as the sessions list asks it: a
 * session parked on the stale boundary is not idle if something is still
 * scheduled to wake it.
 */
export function hasPendingRecurrence(db: Database.Database): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM messages_in
          WHERE status IN ('pending', 'paused')
            AND recurrence IS NOT NULL
          LIMIT 1`,
      )
      .get() !== undefined
  );
}

/**
 * Has this session ever been woken?
 *
 * `trigger` postdates the initial schema, so a DB old enough to lack the
 * column makes this THROW rather than answer false — the caller decides what
 * an unanswerable probe means (both of today's callers fail it closed to
 * "has woken", which never suppresses a real title).
 */
export function hasTriggeredInboundRow(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM messages_in WHERE trigger = 1 LIMIT 1').get() !== undefined;
}

/** One message as the transcript and title surfaces read it, either direction. */
export interface MessageTailRow {
  seq: number;
  kind: string;
  timestamp: string;
  content: string;
}

const TAIL_COLUMNS = 'seq, kind, timestamp, content';
const TAIL_FILTER = "WHERE content IS NOT NULL AND content <> ''\n        ORDER BY seq DESC\n        LIMIT ?";

/**
 * The last `limit` non-empty inbound rows, newest first.
 *
 * One shape for both readers of a session's tail — the session-detail
 * transcript and the title sweep's slice — because they ask the same question
 * and a second near-identical select is how the two would drift.
 */
export function listInboundTail(db: Database.Database, limit: number): MessageTailRow[] {
  return db.prepare(`SELECT ${TAIL_COLUMNS} FROM messages_in ${TAIL_FILTER}`).all(limit) as MessageTailRow[];
}

/** The outbound twin of {@link listInboundTail}. */
export function listOutboundTail(db: Database.Database, limit: number): MessageTailRow[] {
  return db.prepare(`SELECT ${TAIL_COLUMNS} FROM messages_out ${TAIL_FILTER}`).all(limit) as MessageTailRow[];
}

/**
 * How many live (pending|paused) task rows this session holds for a series.
 *
 * The move flow's scoped invariant counter: asked of exactly the named
 * sessions, never fleet-wide, so an unrelated group reusing the same series id
 * cannot satisfy it.
 */
export function countLiveSeriesRows(db: Database.Database, seriesId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages_in
          WHERE series_id = ? AND kind = 'task' AND status IN ('pending','paused')`,
      )
      .get(seriesId) as { c: number }
  ).c;
}

/** The delivery routing one task series last stamped on a fire. */
export interface TaskRoutingStamp {
  platformId: string;
  channelType: string;
  threadId: string | null;
}

/**
 * The newest routed row of ONE series, thread included.
 *
 * The claim self-heal's second rung: a `system:tasks:<series>` claim has no
 * messaging group of its own, so where the series posts is the only honest
 * subject. `null` means the series was created `--isolated` and stamped no
 * routing on purpose — a real answer, not a miss.
 */
export function getLatestTaskRoutingStamp(db: Database.Database, seriesId: string): TaskRoutingStamp | null {
  return (
    (db
      .prepare(
        `SELECT platform_id AS platformId, channel_type AS channelType, thread_id AS threadId
           FROM messages_in
          WHERE kind = 'task' AND series_id = ? AND platform_id IS NOT NULL
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(seriesId) as TaskRoutingStamp | undefined) ?? null
  );
}

/** Channel a task session last delivered into, for the Slack owner-safety gate. */
export interface TaskDeliveryRoute {
  channel_type: string | null;
  platform_id: string;
}

/**
 * The newest routed task row in the SESSION, any series.
 *
 * Insertion order (`rowid`), not `seq`: the gate wants the most recently
 * written route, and an empty `platform_id` is treated as no route at all so a
 * blank stamp cannot resolve to a messaging group.
 */
export function getLatestTaskDeliveryRoute(db: Database.Database): TaskDeliveryRoute | null {
  return (
    (db
      .prepare(
        `SELECT channel_type, platform_id FROM messages_in
          WHERE kind = 'task' AND platform_id IS NOT NULL AND platform_id <> ''
       ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as TaskDeliveryRoute | undefined) ?? null
  );
}
