/**
 * Container-owned `session_state` keys other than the continuation record
 * (which lives in ops/continuation.ts): raw continuation presence and
 * force-clear, the done proposal, the worktree in-flight record and the task list.
 */
import type Database from 'better-sqlite3';

/**
 * Deliberately NOT `readWorkContinuation`: a row that is present but
 * unparseable must not read as cleared to the thread-close path.
 */
export interface ContinuationPresence {
  key: string;
  id: string | null;
  task: string | null;
}

export function readContinuationPresence(outbound: Database.Database): ContinuationPresence | null {
  const row = outbound
    .prepare("SELECT key, value FROM session_state WHERE key IN ('work_continuation', 'pending_next') LIMIT 1")
    .get() as { key: string; value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { id?: unknown; task?: unknown };
    return {
      key: row.key,
      id: typeof parsed.id === 'string' ? parsed.id : null,
      task: typeof parsed.task === 'string' ? parsed.task : null,
    };
  } catch {
    return { key: row.key, id: null, task: null };
  }
}

/**
 * Drops both keys in one transaction: `readWorkContinuation` falls back to the
 * legacy `pending_next`, so leaving it would leave a promise. Returns what was held.
 */
export function clearWorkContinuation(outboundRw: Database.Database): ContinuationPresence | null {
  const held = readContinuationPresence(outboundRw);
  if (!held) return null;
  outboundRw.transaction(() => {
    outboundRw.prepare("DELETE FROM session_state WHERE key = 'work_continuation'").run();
    outboundRw.prepare("DELETE FROM session_state WHERE key = 'pending_next'").run();
  })();
  return held;
}

export const CLOSE_REASON_MAX_CHARS = 500;

export interface DoneProposal {
  reason: string;
  proposed_at: string;
}

/**
 * Validated as the container validates on write; anything unparseable is
 * absent. The ONLY way a proposal enters the host, so a one-confirmation close
 * always needs an agent that actually said it is finished.
 */
export function readDoneProposal(outbound: Database.Database): DoneProposal | null {
  try {
    const row = outbound.prepare("SELECT value FROM session_state WHERE key = 'done_proposal'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<DoneProposal>;
    if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') return null;
    if (parsed.reason.length > CLOSE_REASON_MAX_CHARS) return null;
    if (typeof parsed.proposed_at !== 'string' || Number.isNaN(Date.parse(parsed.proposed_at))) return null;
    return { reason: parsed.reason.trim(), proposed_at: parsed.proposed_at };
  } catch {
    return null;
  }
}

/** Written by the runner at each turn end (container/agent-runner/src/worktree-in-flight.ts). */
interface WorktreeInFlightCheckout {
  name: string;
  branch: string | null;
  upstream: string | null;
  upstream_head: string | null;
  files: string[];
  file_count: number;
  unpushed: number;
}

export interface WorktreeInFlight {
  at: string;
  checkouts: WorktreeInFlightCheckout[];
}

const MAX_RECORDED_CHECKOUTS = 32;
const MAX_RECORDED_FILES = 20;
const MAX_RECORDED_CHARS = 300;
/** A maximal valid record is about 25 KiB; anything larger is malformed and is never read into memory. */
const MAX_RECORD_BYTES = 64 * 1024;

/** A single printable line of at most MAX_RECORDED_CHARS: these strings are spliced into a note, one per line. */
function recordedText(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > MAX_RECORDED_CHARS ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function recordedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function parseInFlightCheckout(value: unknown): WorktreeInFlightCheckout | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const name = recordedText(raw.name);
  const fileCount = recordedCount(raw.file_count);
  const unpushed = recordedCount(raw.unpushed);
  if (name === null || fileCount === null || unpushed === null || !Array.isArray(raw.files)) return null;
  // One bad path costs only itself; the count still says how many there were.
  const files = raw.files
    .slice(0, MAX_RECORDED_FILES)
    .map(recordedText)
    .filter((file): file is string => file !== null);
  const optional = (field: unknown): string | null | undefined =>
    field === null ? null : (recordedText(field) ?? undefined);
  const branch = optional(raw.branch);
  const upstream = optional(raw.upstream);
  const upstreamHead = optional(raw.upstream_head);
  if (branch === undefined || upstream === undefined || upstreamHead === undefined) return null;
  return {
    name,
    branch,
    upstream,
    upstream_head: upstreamHead,
    files,
    file_count: Math.max(fileCount, files.length),
    unpushed,
  };
}

/**
 * Anything malformed is absent: the record can only ever trigger a wake, so an unreadable one triggers none. A bad
 * checkout entry drops only that entry. The value is agent-written, so its size is bounded in SQL, before it is read.
 */
export function readWorktreeInFlight(outbound: Database.Database): WorktreeInFlight | null {
  const row = outbound
    .prepare(
      `SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value
         FROM session_state WHERE key = 'worktree_in_flight'`,
    )
    .get(MAX_RECORD_BYTES) as { value: string | null } | undefined;
  if (!row || row.value === null) return null;
  let parsed: { at?: unknown; checkouts?: unknown } | null;
  try {
    parsed = JSON.parse(row.value, (_key, value: unknown) => {
      if (Array.isArray(value) && value.length > MAX_RECORDED_CHECKOUTS) throw new Error('oversized array');
      return value;
    }) as { at?: unknown; checkouts?: unknown } | null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a syntax error or an oversized array: malformed is absent
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
  if (!Array.isArray(parsed.checkouts)) return null;
  const checkouts = parsed.checkouts
    .map(parseInFlightCheckout)
    .filter((checkout): checkout is WorktreeInFlightCheckout => checkout !== null);
  return { at: parsed.at, checkouts };
}

/** A maximal valid list is about 60 KiB when every character is four bytes wide. */
const MAX_TASK_LIST_BYTES = 128 * 1024;
/** The runner caps a list at 30 items (container/agent-runner/src/task-list.ts). */
const MAX_TASK_LIST_ITEMS = 64;

/**
 * The persisted list while it is still open (version 1, neither finished nor stale) with its last-touched stamp,
 * which callers compare as a date, so an unparseable one matches no window. Same malformed-is-absent rule and SQL
 * size bound as the worktree record: the value is agent-written.
 */
export function readOpenTaskListRecord(
  outbound: Database.Database,
): { record: Record<string, unknown>; touchedAt: string } | null {
  let record: Record<string, unknown> | null;
  try {
    const row = outbound
      .prepare(
        `SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value
           FROM session_state WHERE key = 'task_list'`,
      )
      .get(MAX_TASK_LIST_BYTES) as { value: string | null } | undefined;
    if (!row || row.value === null) return null;
    record = JSON.parse(row.value, (_key, value: unknown) => {
      if (Array.isArray(value) && value.length > MAX_TASK_LIST_ITEMS) throw new Error('oversized array');
      return value;
    }) as Record<string, unknown> | null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an outbound.db predating the table, a syntax error or an oversized array: all absent
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  if (record.version !== 1 || record.finished === true || record.stale === true) return null;
  // Older runner snapshots lack `touchedAt`; fall back to `updatedAt`.
  const touchedAt = typeof record.touchedAt === 'string' ? record.touchedAt : record.updatedAt;
  if (typeof touchedAt !== 'string') return null;
  return { record, touchedAt };
}

interface UnfinishedTaskItem {
  text: string;
  /** `open` is a status this host does not know: a newer runner's, so still owed. */
  status: 'pending' | 'in_progress' | 'open';
}

/** `at` is when the runner last saved the list. */
export interface TaskListInFlight {
  at: string;
  /** Items the agent can still move itself: neither done nor declared waiting on someone else. */
  unfinished: UnfinishedTaskItem[];
  waiting: number;
}

/** A bad item drops only that item: an entry the runner could not have written is not evidence of owed work. */
export function readTaskListInFlight(outbound: Database.Database): TaskListInFlight | null {
  const open = readOpenTaskListRecord(outbound);
  if (!open || !Array.isArray(open.record.items)) return null;
  const unfinished: UnfinishedTaskItem[] = [];
  let waiting = 0;
  for (const value of open.record.items as unknown[]) {
    if (typeof value !== 'object' || value === null) continue;
    const { text, status } = value as { text?: unknown; status?: unknown };
    const line = recordedText(text);
    if (line === null || typeof status !== 'string' || status === 'done') continue;
    if (status === 'waiting') waiting += 1;
    else unfinished.push({ text: line, status: status === 'pending' || status === 'in_progress' ? status : 'open' });
  }
  return { at: open.touchedAt, unfinished, waiting };
}
