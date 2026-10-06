/**
 * What is certain about a session whose container was just stopped, and so whether the kill follow-up queues a wake
 * and what the task list's kill label may say. Nothing here forecasts what the sweep or a runner will do with a
 * pending row: a wake withheld on a wrong forecast strands the work, a redundant wake costs one capped turn, so a
 * wake is withheld only on a fact read directly. Free of top-level side effects, and of any import that reaches
 * container-runner.ts or host-sweep.ts: task-list-host.ts loads this, and both of those load task-list-host.ts.
 */
import { SELF_HEAL_ENABLED } from '../../config.js';
import { withRawDb } from '../../db/central-lease.js';
import { isTaskThread, SESSION_BY_ID_SQL } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession, TaskListInFlight, WorktreeInFlight } from '../mailbox/index.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';

export const REAP_RESPAWN_ID_PREFIX = 'reap-respawn-';

export const CHAT_IDLE_REAP_KILL = 'chat-idle-reap';
export const ABSOLUTE_CEILING_KILL = 'absolute-ceiling';
export const PROVIDER_UNAVAILABLE_KILL = 'provider unavailable — respawning on fallback';

/**
 * The only kills that may queue the follow-up wake, keyed by the reason `killContainer` is given, with how the note
 * names each. Every other stop is one somebody asked for (a restart, a self-mod respawn, a repository-mount change)
 * or a task session's normal exit.
 */
export const STRANDING_KILLS: ReadonlyMap<string, (minutes: number | undefined) => string> = new Map([
  [CHAT_IDLE_REAP_KILL, (minutes) => `was stopped by the ${minutes}-minute chat idle reap after your turn ended`],
  [ABSOLUTE_CEILING_KILL, (minutes) => `was killed by the ${minutes}-minute idle ceiling`],
  [PROVIDER_UNAVAILABLE_KILL, () => `was stopped mid-turn because its model provider became unavailable`],
]);

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

/**
 * The only things that withhold the wake besides an open card, each a fact and none a reading of what is pending:
 * the ceiling branch said it queued its own wake for this kill, a continuation is saved (the sweep resumes it, or
 * has told the operator it could not), or the agent armed a `wait` that has not come due.
 */
type WithheldBy = 'ceiling-wake' | 'continuation-saved' | 'wake-pending';

type OpenCard = 'approval' | 'question';

/**
 * Call inside `withCentralSync`. A resolved approval or answered question is deleted, so a row that exists is
 * unanswered — but one nobody ever answers is never pruned, so only a card posted during the killed container's
 * life counts: an abandoned card from months ago would otherwise speak for this session for good. `julianday`
 * keeps the milliseconds `datetime` drops: a replacement can start in the second its predecessor's card was posted.
 */
function openCardSince(sessionId: string, sinceIso: string, nowIso: string): OpenCard | null {
  const row = withRawDb(
    (db) =>
      db
        .prepare(
          `SELECT 'approval' AS card FROM pending_approvals
            WHERE session_id = @id
              AND status IN ('pending', 'awaiting_reason')
              AND (expires_at IS NULL OR julianday(expires_at) > julianday(@now))
              AND julianday(created_at) >= julianday(@since)
           UNION ALL
           SELECT 'question' AS card FROM pending_questions
            WHERE session_id = @id
              AND julianday(created_at) >= julianday(@since)
           LIMIT 1`,
        )
        .get({ id: sessionId, since: sinceIso, now: nowIso }) as { card: OpenCard } | undefined,
  );
  return row?.card ?? null;
}

export interface KillEvidence {
  checkouts: WorktreeInFlight['checkouts'];
  unfinished: TaskListInFlight['unfinished'];
  waiting: number;
  /** Something was recorded, all of it by an earlier container. */
  stale: boolean;
}

const NO_EVIDENCE: KillEvidence = { checkouts: [], unfinished: [], waiting: 0, stale: false };

/** A record stamped before the killed container started was left by an earlier one and must never wake the session. */
function readKillEvidence(mailbox: NanoclawMailboxSession, startedAtMs: number): KillEvidence {
  const worktree = mailbox.readWorktreeInFlight();
  const list = mailbox.readTaskListInFlight();
  const during = (at: string): boolean => Date.parse(at) >= startedAtMs;
  const checkouts = worktree && during(worktree.at) ? worktree.checkouts : [];
  const fresh = list && during(list.at) ? list : null;
  const unfinished = fresh?.unfinished ?? [];
  const recorded = (worktree?.checkouts.length ?? 0) + (list?.unfinished.length ?? 0);
  return {
    checkouts,
    unfinished,
    waiting: fresh?.waiting ?? 0,
    stale: recorded > 0 && checkouts.length + unfinished.length === 0,
  };
}

/**
 * The sweep never wakes a closed or archived session, so a row there would sit due forever. The same three
 * conditions as the wake path's own gate in container-runner.ts, which this file cannot import.
 */
function takesAWake(sessionId: string): boolean {
  const row = withRawDb((db) => db.prepare(SESSION_BY_ID_SQL).get(sessionId) as Session | undefined);
  return row?.status === 'active' && row.archived_at == null;
}

export type ReapFollowUp =
  | {
      action: 'none';
      reason:
        | 'reason-not-covered'
        | 'task-session'
        | 'nothing-in-flight'
        | 'stale-evidence'
        | 'armed'
        | 'not-wakeable'
        | 'human-pending'
        | 'capped'
        | 'shadow';
    }
  | { action: 'wake-accountable' };

/**
 * The evidence half: recency is already applied by whoever counted it, and `staleEvidence` says only that some was
 * recorded by an earlier container.
 */
export function decideReapFollowUp(args: {
  inFlightCheckouts: number;
  unfinishedItems?: number;
  staleEvidence?: boolean;
  armed?: boolean;
  wakeable?: boolean;
  humanPending?: boolean;
  priorAttempts: number;
}): ReapFollowUp {
  if (args.inFlightCheckouts + (args.unfinishedItems ?? 0) === 0) {
    return { action: 'none', reason: args.staleEvidence ? 'stale-evidence' : 'nothing-in-flight' };
  }
  if (args.armed) return { action: 'none', reason: 'armed' };
  if (args.wakeable === false) return { action: 'none', reason: 'not-wakeable' };
  if (args.humanPending) return { action: 'none', reason: 'human-pending' };
  if (args.priorAttempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS) return { action: 'none', reason: 'capped' };
  return { action: 'wake-accountable' };
}

function decideKillFollowUp(args: {
  reasonCovered: boolean;
  taskSession: boolean;
  inFlightCheckouts: number;
  unfinishedItems: number;
  staleEvidence: boolean;
  armed: boolean;
  wakeable: boolean;
  humanPending: boolean;
  priorAttempts: number;
  selfHeal: boolean;
}): ReapFollowUp {
  if (!args.reasonCovered) return { action: 'none', reason: 'reason-not-covered' };
  // A scheduled series fires again by itself, and a wake row in its session is behaviour nobody has verified.
  if (args.taskSession) return { action: 'none', reason: 'task-session' };
  const followUp = decideReapFollowUp(args);
  if (followUp.action === 'wake-accountable' && !args.selfHeal) return { action: 'none', reason: 'shadow' };
  return followUp;
}

export interface KillFacts {
  /** The earliest `wait` the agent armed that has not come due. */
  nextCheckAt: string | null;
  openCard: OpenCard | null;
  /** False for a closed or archived session, which takes no wake whatever is queued for it. */
  takesAWake: boolean;
}

/**
 * Call inside `withCentralSync`. `startedAtMs` is the killed container's `containerStartedAtMs`, resolved by the
 * caller from a name read before the kill (the registry entry is gone after exit): container-runner.ts owns that
 * parse and this file may not import it.
 */
export function readKillFacts(
  mailbox: Pick<NanoclawMailboxSession, 'getNextScheduledWakeAt'>,
  session: Session,
  startedAtMs: number | null,
): KillFacts {
  return {
    nextCheckAt: mailbox.getNextScheduledWakeAt(),
    openCard:
      startedAtMs === null
        ? null
        : openCardSince(session.id, new Date(startedAtMs).toISOString(), new Date().toISOString()),
    takesAWake: takesAWake(session.id),
  };
}

export interface KillDecision {
  followUp: ReapFollowUp;
  evidence: KillEvidence;
  withheldBy: WithheldBy | null;
  priorAttempts: number;
}

/** No writes. Call inside `withCentralSync`. `ceilingWakeQueued` is the ceiling branch's own return for this kill. */
export function decideKill(
  mailbox: NanoclawMailboxSession,
  session: Session,
  startedAtMs: number | null,
  kill: { reason: string; ceilingWakeQueued?: boolean },
): KillDecision {
  const facts = readKillFacts(mailbox, session, startedAtMs);
  const dated = startedAtMs !== null;
  const evidence = dated ? readKillEvidence(mailbox, startedAtMs) : NO_EVIDENCE;
  const withheldBy: WithheldBy | null = kill.ceilingWakeQueued
    ? 'ceiling-wake'
    : mailbox.readWorkContinuation() !== null
      ? 'continuation-saved'
      : facts.nextCheckAt !== null
        ? 'wake-pending'
        : null;
  const priorAttempts = dated ? mailbox.countRecoveryAttemptsSinceRealInbound(REAP_RESPAWN_ID_PREFIX) : 0;
  const followUp = decideKillFollowUp({
    reasonCovered: STRANDING_KILLS.has(kill.reason),
    taskSession: isTaskThread(session.thread_id),
    inFlightCheckouts: evidence.checkouts.length,
    unfinishedItems: evidence.unfinished.length,
    staleEvidence: evidence.stale,
    armed: withheldBy !== null,
    wakeable: facts.takesAWake,
    humanPending: facts.openCard !== null,
    priorAttempts,
    selfHeal: SELF_HEAL_ENABLED,
  });
  return { followUp, evidence, withheldBy, priorAttempts };
}
