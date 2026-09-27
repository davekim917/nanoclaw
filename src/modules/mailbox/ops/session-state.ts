/**
 * Container-owned `session_state` keys other than the continuation record
 * (which lives in ops/continuation.ts): raw continuation presence and
 * force-clear, and the done proposal.
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
