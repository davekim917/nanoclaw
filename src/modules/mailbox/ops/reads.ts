/**
 * Read ops for operator surfaces, named after the QUESTION asked, never a
 * "run this SQL" hatch. The read-only session binds them to handles that can
 * never provision, migrate or write.
 */
import type Database from 'better-sqlite3';

/** One shape for every board surface, so an extra field doesn't mint another near-identical query. */
export interface ScheduledTaskRow {
  id: string;
  /** Distinguishes "the row I approved" from one rewritten in place (admission mutates rows). */
  seq: number;
  series_id: string | null;
  recurrence: string | null;
  process_after: string | null;
  scheduled_for: string | null;
  status: string;
  /** 0 = inert, 1 = admitted. NULL only on a legacy, not-yet-migrated `inbound.db`. */
  trigger: number | null;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/**
 * `scheduled_for` and `trigger` are added LAZILY by the first writable open,
 * and the read-only session never migrates: naming a missing column throws, so
 * they are selected conditionally (absent reads as NULL).
 */
function scheduledColumns(db: Database.Database): string {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((column) => column.name),
  );
  // `trigger`: same lazy migration, same treatment.
  const scheduledFor = columns.has('scheduled_for') ? 'scheduled_for' : 'NULL AS scheduled_for';
  const trigger = columns.has('trigger') ? '"trigger"' : 'NULL AS "trigger"';
  return `id, seq, series_id, recurrence, process_after, ${scheduledFor},
         status, ${trigger}, kind, timestamp, platform_id, channel_type, thread_id, content`;
}

/**
 * Series with more than one live recurring successor (manual runs share the
 * series id but have no recurrence).
 */
export function listDuplicateLiveTaskSeriesIds(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT series_id FROM messages_in
        WHERE status IN ('pending', 'paused') AND kind = 'task' AND recurrence IS NOT NULL
        GROUP BY series_id HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ series_id: string | null }>;
  return rows.map((r) => r.series_id).filter((s): s is string => s !== null);
}

/**
 * A newer manual occurrence must not hide the still-armed chain. Terminal
 * recurring rows are included: the strand detector needs them.
 */
export function listLatestRecurringSeriesRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${scheduledColumns(db)}
         FROM messages_in
        WHERE recurrence IS NOT NULL
          AND status != 'cancelled'
          AND seq = (SELECT MAX(m2.seq) FROM messages_in m2
            WHERE m2.series_id = messages_in.series_id AND m2.recurrence IS NOT NULL)`,
    )
    .all() as ScheduledTaskRow[];
}

/** Manual runs of recurring series stay in their series. */
export function listLiveOneOffTaskRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${scheduledColumns(db)}
         FROM messages_in
        WHERE recurrence IS NULL AND kind = 'task' AND status IN ('pending', 'paused')
          AND NOT EXISTS (SELECT 1 FROM messages_in recurring
            WHERE recurring.series_id = messages_in.series_id AND recurring.recurrence IS NOT NULL
              AND recurring.status != 'cancelled')
          AND seq = (SELECT MAX(m2.seq) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id)`,
    )
    .all() as ScheduledTaskRow[];
}

/** Session-wide: the consolidation migration walks a whole legacy backlog. */
export function listLiveTaskRows(db: Database.Database): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${scheduledColumns(db)}
         FROM messages_in
        WHERE kind = 'task' AND status IN ('pending', 'paused')
        ORDER BY seq DESC`,
    )
    .all() as ScheduledTaskRow[];
}

export function listLiveTaskRowsForSeries(db: Database.Database, seriesId: string): ScheduledTaskRow[] {
  return db
    .prepare(
      `SELECT ${scheduledColumns(db)}
         FROM messages_in
        WHERE series_id = ? AND status IN ('pending', 'paused') AND kind = 'task'`,
    )
    .all(seriesId) as ScheduledTaskRow[];
}

/**
 * The live recurring chain, or newest LIVE one-off; a terminal chain resolves
 * via getLatestSeriesRow, never a manual run. Kind-agnostic on purpose.
 */
export function getLiveSeriesRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in
          WHERE series_id = ? AND status IN ('pending', 'paused')
            AND (recurrence IS NOT NULL OR NOT EXISTS (SELECT 1 FROM messages_in chain
              WHERE chain.series_id = messages_in.series_id AND chain.recurrence IS NOT NULL AND chain.status != 'cancelled'))
          ORDER BY (recurrence IS NOT NULL) DESC, seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

export function getLatestSeriesRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in WHERE series_id = ?
          ORDER BY (recurrence IS NOT NULL AND status != 'cancelled') DESC, seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

/**
 * Kind-filtered twin of `getLiveSeriesRow`: a non-task row sharing the series
 * id must never be edited, paused or moved. A terminal chain has no editable
 * schedule, even with a pending manual run.
 */
export function getLiveTaskRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in
          WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')
            AND (recurrence IS NOT NULL OR NOT EXISTS (SELECT 1 FROM messages_in chain
              WHERE chain.series_id = messages_in.series_id AND chain.recurrence IS NOT NULL AND chain.status != 'cancelled'))
          ORDER BY (recurrence IS NOT NULL) DESC, seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

export function getLiveTaskRowById(db: Database.Database, rowId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in
          WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused') LIMIT 1`,
      )
      .get(rowId) as ScheduledTaskRow | undefined) ?? null
  );
}

/** Must still find the target after it completes: a recurring completion can arm its successor before recovery. */
export function getTaskRowById(db: Database.Database, rowId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in
          WHERE id = ? AND kind = 'task' LIMIT 1`,
      )
      .get(rowId) as ScheduledTaskRow | undefined) ?? null
  );
}

export function getLatestTaskRow(db: Database.Database, seriesId: string): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT ${scheduledColumns(db)} FROM messages_in WHERE series_id = ? AND kind = 'task'
          ORDER BY (recurrence IS NOT NULL AND status != 'cancelled') DESC, seq DESC LIMIT 1`,
      )
      .get(seriesId) as ScheduledTaskRow | undefined) ?? null
  );
}

export interface TaskFireRow {
  id: string;
  status: string;
  process_after: string | null;
  timestamp: string;
}

/** TERMINAL fires only, newest first. */
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

export function listProcessingClaimedMessageIds(db: Database.Database): string[] {
  return (
    db.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
      message_id: string;
    }>
  ).map((r) => r.message_id);
}

/** The continuation family owns the statement; this is its read-side name. */
export { hasWorkContinuationRow as hasWorkContinuation } from './continuation.js';

/** Only whether a fire "said something" matters, so only the timestamp comes back. */
export function latestReplyTimestampByTrigger(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      'SELECT in_reply_to, MAX(timestamp) AS ts FROM messages_out WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to',
    )
    .all() as Array<{ in_reply_to: string; ts: string }>;
  return new Map(rows.map((r) => [r.in_reply_to, r.ts]));
}

/**
 * Optional fields postdate the table: an older container's rows lack the keys
 * entirely (`SELECT *`), so readers use `??`.
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
  /**
   * Effective (post-clamp) effort. Absent or NULL means "not recorded", never
   * "ran at no effort".
   */
  effort?: string | null;
  effort_requested?: string | null;
}

/** `[]` when the table is absent (the normal case for a container that never wrote usage). */
export function listTurnUsageSince(db: Database.Database, afterId: number): SessionTurnUsageRow[] {
  const present =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'turn_usage' LIMIT 1").get() !== undefined;
  if (!present) return [];
  return db.prepare('SELECT * FROM turn_usage WHERE id > ? ORDER BY id ASC').all(afterId) as SessionTurnUsageRow[];
}

/** `null` on an empty mailbox (the caller falls back to a synthetic id). */
export function latestInboundMessageId(db: Database.Database): string | null {
  const row = db.prepare('SELECT id FROM messages_in ORDER BY seq DESC LIMIT 1').get() as { id: string } | undefined;
  return row?.id ?? null;
}

/** A session parked on the stale boundary is not idle if something still recurs. */
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
 * THROWS on a DB too old to have `trigger`; callers decide what an unanswerable
 * probe means (today both fail closed to "has woken").
 */
export function hasTriggeredInboundRow(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM messages_in WHERE trigger = 1 LIMIT 1').get() !== undefined;
}

export interface MessageTailRow {
  seq: number;
  kind: string;
  timestamp: string;
  content: string;
}

const TAIL_COLUMNS = 'seq, kind, timestamp, content';
const TAIL_FILTER = "WHERE content IS NOT NULL AND content <> ''\n        ORDER BY seq DESC\n        LIMIT ?";

/** One shape for both tail readers (transcript and title sweep) so they can't drift. */
export function listInboundTail(db: Database.Database, limit: number): MessageTailRow[] {
  return db.prepare(`SELECT ${TAIL_COLUMNS} FROM messages_in ${TAIL_FILTER}`).all(limit) as MessageTailRow[];
}

export function listOutboundTail(db: Database.Database, limit: number): MessageTailRow[] {
  return db.prepare(`SELECT ${TAIL_COLUMNS} FROM messages_out ${TAIL_FILTER}`).all(limit) as MessageTailRow[];
}

/** Scoped to exactly the named sessions, never fleet-wide, so another group's same series id can't satisfy it. */
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

export interface TaskRoutingStamp {
  platformId: string;
  channelType: string;
  threadId: string | null;
}

/** `null` means the series was created `--isolated` and stamped no routing on purpose. */
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

/** For the Slack owner-safety gate. */
export interface TaskDeliveryRoute {
  channel_type: string | null;
  platform_id: string;
}

/**
 * Insertion order (`rowid`), not `seq`: the most recently written route. An
 * empty `platform_id` counts as no route.
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
