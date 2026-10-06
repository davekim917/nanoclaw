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

/**
 * The only things that withhold the wake, each a fact and none a reading of what is pending: the ceiling branch said
 * it queued its own wake for this kill, a continuation is saved (the sweep resumes it, or has told the operator it
 * could not), or the agent armed a `wait` that has not come due.
 */
type WithheldBy = 'ceiling-wake' | 'continuation-saved' | 'wake-pending';

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
  priorAttempts: number;
}): ReapFollowUp {
  if (args.inFlightCheckouts + (args.unfinishedItems ?? 0) === 0) {
    return { action: 'none', reason: args.staleEvidence ? 'stale-evidence' : 'nothing-in-flight' };
  }
  if (args.armed) return { action: 'none', reason: 'armed' };
  if (args.wakeable === false) return { action: 'none', reason: 'not-wakeable' };
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
  /** False for a closed or archived session, which takes no wake whatever is queued for it. */
  takesAWake: boolean;
}

/** Call inside `withCentralSync`. */
export function readKillFacts(
  mailbox: Pick<NanoclawMailboxSession, 'getNextScheduledWakeAt'>,
  session: Session,
): KillFacts {
  return { nextCheckAt: mailbox.getNextScheduledWakeAt(), takesAWake: takesAWake(session.id) };
}

export interface KillDecision {
  followUp: ReapFollowUp;
  evidence: KillEvidence;
  withheldBy: WithheldBy | null;
  priorAttempts: number;
}

/**
 * No writes. Call inside `withCentralSync`. `startedAtMs` is the killed container's `containerStartedAtMs`, resolved
 * by the caller from a name read before the kill (the registry entry is gone after exit). `ceilingWakeQueued` is the
 * ceiling branch's own return for this kill.
 *
 * Work left only on disk has no resume path but this wake, so nothing stored withholds it: a saved continuation or
 * an armed `wait` may never run, and neither accounts for the checkouts. Those facts, and a session that takes no
 * wake, withhold only when the list is the sole evidence.
 */
export function decideKill(
  mailbox: NanoclawMailboxSession,
  session: Session,
  startedAtMs: number | null,
  kill: { reason: string; ceilingWakeQueued?: boolean },
): KillDecision {
  const dated = startedAtMs !== null;
  const evidence = dated ? readKillEvidence(mailbox, startedAtMs) : NO_EVIDENCE;
  const facts = readKillFacts(mailbox, session);
  const listOnly = evidence.checkouts.length === 0;
  const withheldBy: WithheldBy | null = kill.ceilingWakeQueued
    ? 'ceiling-wake'
    : !listOnly
      ? null
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
    wakeable: !listOnly || facts.takesAWake,
    priorAttempts,
    selfHeal: SELF_HEAL_ENABLED,
  });
  return { followUp, evidence, withheldBy, priorAttempts };
}
