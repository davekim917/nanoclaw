/**
 * What is true of a session whose container was just stopped: when that container started, what already stands to
 * bring the session back, whether a human owes it an answer, and so what the kill follow-up will do. Shared by the
 * promise watch, the kill follow-up and the task list's kill label so they cannot disagree. Free of top-level side
 * effects, and of any import that reaches container-runner.ts or host-sweep.ts: task-list-host.ts loads this, and
 * both of those load task-list-host.ts.
 */
import { CONTAINER_NAME_PREFIX, SELF_HEAL_ENABLED } from '../../config.js';
import { withRawDb } from '../../db/central-lease.js';
import { isTaskThread, SESSION_BY_ID_SQL } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession, TaskListInFlight, WorktreeInFlight } from '../mailbox/index.js';
import {
  canAttemptContinuationRecovery,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from '../mailbox/ops/continuation.js';
import { isRecoveryWakeId } from '../mailbox/ops/recovery.js';
import type { RunnableWake } from '../mailbox/ops/runnable-wakes.js';
import { parseSqliteUtc, sqliteUtcToIso } from '../mailbox/sqlite-utc.js';

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

/** What makes a further wake redundant. Says nothing about whether the session comes back: see `Resumes`. */
type SuppressedBy = ArmedBy | 'wake-deferred';

/** What will bring a stopped session back, and when if that is a known future time. */
interface Resumes {
  by: 'wake-due' | 'wake-queued' | 'continuation' | 'follow-up' | 'wake-pending';
  at: string | null;
}

/**
 * Raw pending rows are not read here: a row its container already acknowledged, a claim the cleanup will discard and
 * a context row nothing admits all look pending and never run. `listRunnableWakes` is what the sweep leaves to run.
 */
interface KillReads {
  continuation: HostWorkContinuation | null;
  wakes: RunnableWake[];
}

function readKill(mailbox: NanoclawMailboxSession): KillReads {
  return { continuation: mailbox.readWorkContinuation(), wakes: mailbox.listRunnableWakes() };
}

/**
 * The kill follow-up's own unadmitted rows are left out: one row per kill is its id's job and the count is its
 * cap's, so an earlier one still pending must not read as "already coming back".
 */
function suppressedBy({ continuation, wakes }: KillReads): SuppressedBy | null {
  const others = wakes.filter((wake) => wake.admitted || !wake.id.startsWith(REAP_RESPAWN_ID_PREFIX));
  if (others.some((wake) => wake.admitted && wake.at === null)) return 'wake-due';
  if (others.some((wake) => wake.at !== null)) return 'wake-pending';
  if (continuation !== null) return 'continuation-saved';
  return others.length > 0 ? 'wake-deferred' : null;
}

/**
 * "Will this session come back", which is not "should another wake be withheld": a spent continuation withholds a
 * wake and resumes nothing, and the follow-up's own queued row resumes the session without withholding anything.
 * While a continuation's recovery budget is spent the sweep completes recovery wakes unread, so those bring nothing
 * back either.
 */
function resumesBy({ continuation, wakes }: KillReads, takesAWake: boolean, followUp: ReapFollowUp): Resumes | null {
  if (!takesAWake) return null;
  const recoverable = continuation !== null && canAttemptContinuationRecovery(continuation);
  const delivered = continuation !== null && !recoverable ? wakes.filter((wake) => !isRecoveryWakeId(wake.id)) : wakes;
  const now = delivered.find((wake) => wake.at === null);
  if (now) return { by: now.admitted ? 'wake-due' : 'wake-queued', at: null };
  if (recoverable) return { by: 'continuation', at: null };
  if (followUp.action === 'wake-accountable') return { by: 'follow-up', at: null };
  const later = delivered.flatMap((wake) => wake.at ?? []).sort((a, b) => parseSqliteUtc(a) - parseSqliteUtc(b));
  return later.length > 0 ? { by: 'wake-pending', at: sqliteUtcToIso(later[0]) } : null;
}

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

/**
 * What the kill follow-up will do, from everything readable at the kill. Pure, so the task list's kill label can ask
 * the same question before the follow-up runs and the two cannot disagree.
 */
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

export interface KillPrediction {
  followUp: ReapFollowUp;
  /** Null when the registry never named the container: nothing can be dated, so nothing is attributable. */
  startedAtMs: number | null;
  evidence: KillEvidence;
  /** Why no further wake is queued; not whether the session comes back. */
  armed: SuppressedBy | null;
  /** The label's one question. Null for a session that takes no wake, whatever is queued for it. */
  resumes: Resumes | null;
  openCard: OpenCard | null;
  priorAttempts: number;
}

/**
 * What the kill follow-up will decide for this kill, and what it read to decide it. No writes. Call inside
 * `withCentralSync`. `containerName` is read before the kill (the registry entry is gone after exit).
 */
export function predictKillFollowUp(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerName: string | null,
  reason: string,
): KillPrediction {
  const startedAtMs = containerStartedAtMs(containerName);
  const reads = readKill(mailbox);
  const armed = suppressedBy(reads);
  const dated = startedAtMs !== null;
  const evidence = dated ? readKillEvidence(mailbox, startedAtMs) : NO_EVIDENCE;
  const openCard = dated
    ? openCardSince(session.id, new Date(startedAtMs).toISOString(), new Date().toISOString())
    : null;
  const priorAttempts = dated ? mailbox.countRecoveryAttemptsSinceRealInbound(REAP_RESPAWN_ID_PREFIX) : 0;
  const wakeable = takesAWake(session.id);
  const followUp = decideKillFollowUp({
    reasonCovered: STRANDING_KILLS.has(reason),
    taskSession: isTaskThread(session.thread_id),
    inFlightCheckouts: evidence.checkouts.length,
    unfinishedItems: evidence.unfinished.length,
    staleEvidence: evidence.stale,
    armed: armed !== null,
    wakeable: dated && wakeable,
    humanPending: openCard !== null,
    priorAttempts,
    selfHeal: SELF_HEAL_ENABLED,
  });
  return {
    followUp,
    startedAtMs,
    evidence,
    armed,
    resumes: resumesBy(reads, wakeable, followUp),
    openCard,
    priorAttempts,
  };
}
