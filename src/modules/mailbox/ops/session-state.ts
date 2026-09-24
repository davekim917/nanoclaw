/**
 * Reads and writes against the container-owned `session_state` table in
 * outbound.db, for the keys the continuation record does not own.
 *
 * Internal to `src/modules/mailbox/`. Two records live here, both written by
 * the container and read by the host: the raw presence of a work continuation
 * (and its force-clear, from `src/dashboard/thread-close.ts`) and the done
 * proposal (`propose_done`, same file). The statements moved here so that the
 * host files that need them stop taking an outbound handle.
 *
 * The continuation record itself — `HostWorkContinuation`, its size cap and
 * its validating parser — lives in `ops/continuation.ts` and is NOT duplicated
 * here (invariant I-2: one implementation of any SQL statement). Presence and
 * force-clear stay in this file because they deliberately do not validate:
 * "the row is there but we could not parse it" is not a state the thread-close
 * path may treat as cleared.
 */
import type Database from 'better-sqlite3';

/**
 * Raw presence of either continuation key, with whatever is readable for the
 * caller's log line.
 *
 * Deliberately NOT `readWorkContinuation`: that parser returns null for a
 * malformed record, and "the row is there but we could not parse it" is not a
 * state the thread-close path may treat as cleared. Presence is the question.
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
 * Drop both continuation keys in one transaction.
 *
 * `cancelWorkContinuation` in the container clears both, and
 * `readWorkContinuation` (`ops/continuation.ts`) falls back to the legacy
 * `pending_next`, so leaving that key behind would leave a promise the next
 * wake still finds.
 * Returns what was held, so the caller can say what it dropped.
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

/** Longest reason string a done proposal may carry before it is treated as absent. */
export const CLOSE_REASON_MAX_CHARS = 500;

export interface DoneProposal {
  reason: string;
  proposed_at: string;
}

/**
 * Parse a proposal off an open outbound.db handle.
 *
 * Validated the same way the container validates it on write: anything that
 * does not parse is treated as absent, never as a proposal. This function is
 * the ONLY way a proposal enters the host, and its only source is the row
 * `propose_done` writes — there is no host-side path that can mint one, which
 * is what keeps the one-confirmation close unreachable without an actual agent
 * saying it is finished.
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

/**
 * The live task list's record (`session_state.task_list`, written only by the
 * runner's update_task_list). The host reads it for one job: when a container
 * dies mid-list, edit the visible list to its pre-rendered "interrupted" form
 * so a dead agent never leaves a live-looking ✱. Anything malformed reads as
 * no list — the host never guesses at what to edit.
 */
export interface HostTaskList {
  revision: number;
  finished: boolean;
  stale: boolean;
  channelType: string;
  platformId: string;
  threadId: string | null;
  platformMessageId: string;
  interruptedText: string;
  interruptedSubtext: string;
}

export function readTaskList(outbound: Database.Database): HostTaskList | null {
  try {
    const row = outbound.prepare("SELECT value FROM session_state WHERE key = 'task_list'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const p = JSON.parse(row.value) as Record<string, unknown>;
    if (p.version !== 1 || typeof p.revision !== 'number') return null;
    if (typeof p.channelType !== 'string' || typeof p.platformId !== 'string') return null;
    if (typeof p.platformMessageId !== 'string' || !p.platformMessageId) return null;
    if (typeof p.interruptedText !== 'string' || typeof p.interruptedSubtext !== 'string') return null;
    return {
      revision: p.revision,
      finished: p.finished === true,
      stale: p.stale === true,
      channelType: p.channelType,
      platformId: p.platformId,
      threadId: typeof p.threadId === 'string' ? p.threadId : null,
      platformMessageId: p.platformMessageId,
      interruptedText: p.interruptedText,
      interruptedSubtext: p.interruptedSubtext,
    };
  } catch {
    return null;
  }
}
