/**
 * What is true of a session whose container was just stopped: when that container started, what already stands to
 * bring the session back, and whether a human owes it an answer. Shared by the promise watch, the kill follow-up
 * and the task list's kill label so they cannot disagree. Free of top-level side effects.
 */
import { CONTAINER_NAME_PREFIX } from '../../config.js';
import { withRawDb } from '../../db/central-lease.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';

export const REAP_RESPAWN_ID_PREFIX = 'reap-respawn-';

/**
 * The instant the spawn minted this container's name, which is before the container started. Unlike the registry's
 * `spawnedAt`, it survives a host restart: adoption reads the name back from the runtime and restamps `spawnedAt`.
 */
export function containerStartedAtMs(containerName: string | null): number | null {
  if (!containerName?.startsWith(CONTAINER_NAME_PREFIX)) return null;
  const match = /-(\d+)$/.exec(containerName);
  const ms = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export interface ArmedState {
  dueCount: number;
  nextFutureProcessAfter: string | null;
  hasContinuation: boolean;
}

export function readArmedState(
  mailbox: Pick<NanoclawMailboxSession, 'countDueMessages' | 'getNextFutureProcessAfter' | 'readWorkContinuation'>,
): ArmedState {
  return {
    dueCount: mailbox.countDueMessages(),
    nextFutureProcessAfter: mailbox.getNextFutureProcessAfter(),
    hasContinuation: mailbox.readWorkContinuation() !== null,
  };
}

export type ArmedBy = 'wake-due' | 'wake-pending' | 'continuation-saved';

export function armedBy(state: ArmedState): ArmedBy | null {
  if (state.dueCount > 0) return 'wake-due';
  if (state.nextFutureProcessAfter) return 'wake-pending';
  if (state.hasContinuation) return 'continuation-saved';
  return null;
}

export interface KillArmed {
  by: ArmedBy | 'wake-deferred' | 'claimed';
  /** Set only when the next thing to happen is a wake at a known future time. */
  nextCheckAt: string | null;
}

/**
 * The kill follow-up's own unadmitted rows are left out: one row per kill is its id's job and the count is its
 * cap's, so an earlier one still pending must not read as "already coming back".
 */
export function readKillArmed(mailbox: NanoclawMailboxSession): KillArmed | null {
  const state = readArmedState(mailbox);
  const by =
    armedBy(state) ??
    (mailbox.hasPendingRecallPairedTrigger(REAP_RESPAWN_ID_PREFIX) ? 'wake-deferred' : null) ??
    (mailbox.getProcessingClaimRows().length > 0 ? 'claimed' : null);
  if (!by) return null;
  return { by, nextCheckAt: by === 'wake-pending' ? state.nextFutureProcessAfter : null };
}

export type OpenCard = 'approval' | 'question';

/**
 * Call inside `withCentralSync`. A resolved approval or answered question is deleted, so a row that exists is
 * unanswered — but one nobody ever answers is never pruned, so only a card posted during the killed container's
 * life counts: an abandoned card from months ago would otherwise speak for this session for good.
 */
export function openCardSince(sessionId: string, sinceIso: string, nowIso: string): OpenCard | null {
  const row = withRawDb(
    (db) =>
      db
        .prepare(
          `SELECT 'approval' AS card FROM pending_approvals
            WHERE session_id = @id
              AND status IN ('pending', 'awaiting_reason')
              AND (expires_at IS NULL OR datetime(expires_at) > datetime(@now))
              AND datetime(created_at) >= datetime(@since)
           UNION ALL
           SELECT 'question' AS card FROM pending_questions
            WHERE session_id = @id
              AND datetime(created_at) >= datetime(@since)
           LIMIT 1`,
        )
        .get({ id: sessionId, since: sinceIso, now: nowIso }) as { card: OpenCard } | undefined,
  );
  return row?.card ?? null;
}
