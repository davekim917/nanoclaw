/**
 * Container-owned `session_state` keys other than the continuation record
 * (which lives in ops/continuation.ts): raw continuation presence and
 * force-clear, the done proposal, and the worktree in-flight record.
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

/** A single line of at most MAX_RECORDED_CHARS: these strings are spliced into a note, one checkout per line. */
function recordedText(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_RECORDED_CHARS || /[\r\n]/.test(value)) {
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
  const files = raw.files.slice(0, MAX_RECORDED_FILES).map(recordedText);
  if (files.some((file) => file === null)) return null;
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
    files: files as string[],
    file_count: Math.max(fileCount, files.length),
    unpushed,
  };
}

/** Anything malformed is absent: the record can only ever trigger a wake, so an unreadable one triggers none. */
export function readWorktreeInFlight(outbound: Database.Database): WorktreeInFlight | null {
  const row = outbound.prepare("SELECT value FROM session_state WHERE key = 'worktree_in_flight'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  let parsed: { at?: unknown; checkouts?: unknown } | null;
  try {
    parsed = JSON.parse(row.value) as { at?: unknown; checkouts?: unknown } | null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the only throw here is a JSON syntax error: malformed is absent
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
  if (!Array.isArray(parsed.checkouts) || parsed.checkouts.length > MAX_RECORDED_CHECKOUTS) return null;
  const checkouts = parsed.checkouts.map(parseInFlightCheckout);
  if (checkouts.some((checkout) => checkout === null)) return null;
  return { at: parsed.at, checkouts: checkouts as WorktreeInFlightCheckout[] };
}
