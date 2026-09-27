/**
 * Host-restart accountability: write a note (atomically with on_wake=1) for each session whose container THIS
 * restart interrupts, so the fresh container posts done/lost/next and resumes from durable state. Never for a
 * container that survives the restart.
 *
 * Spam guard: only explicit evidence of work in flight counts (resumable continuation, fresh tool start, fresh
 * processing claim, or a fresh heartbeat paired with `provider_executing`); narration never does.
 *
 * Known residual: after an unclean crash `provider_executing` cannot be trusted, so a mid-turn session with a
 * heartbeat older than the freshness window gets no note on that path.
 */
import { createHash } from 'crypto';
import fs from 'node:fs';

import { getRunningSessions, getSession } from './db/sessions.js';
import {
  ABSOLUTE_CEILING_MS,
  decideCeilingFollowUp,
  parseSqliteUtc,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
} from './host-sweep.js';
import { log } from './log.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const RESTART_NOTE_MARKER = 'agent_host_restart';
const RESTART_NOTE_DEDUPE_MS = 10 * 60 * 1000;

/**
 * The runner touches the heartbeat once per streamed provider event (and around backoff sleeps and task scripts),
 * never on an idle poll, so this fresh means a turn was mid-stream. Not the 30-minute ceiling: that would flag
 * every container whose last turn merely ended recently.
 */
export const RESTART_WARN_HEARTBEAT_FRESH_MS = 120_000;

function freshProcessingClaimKey(mailbox: NanoclawMailboxSession, now: number): string | null {
  try {
    for (const claim of mailbox.getProcessingClaimRows()) {
      const claimedAt = parseSqliteUtc(claim.status_changed);
      if (Number.isFinite(claimedAt) && claimedAt <= now && now - claimedAt <= ABSOLUTE_CEILING_MS) {
        return `${claim.message_id}-${claim.status_changed}`;
      }
    }
  } catch {
    // Legacy outbound DB without processing_ack.
  }
  return null;
}

/**
 * Tolerated future skew of a heartbeat mtime. The shutdown warn runs while containers still write the file, so a
 * slightly future stamp is the freshest evidence, not an anomaly; the bound stops a bad stamp from reading as
 * fresh forever.
 */
const HEARTBEAT_MAX_SKEW_MS = 5_000;

/** A missing file (never woken, cleared at spawn) or an over-skewed stamp is "no signal". */
function heartbeatMtimeMs(session: Session): number | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs;
  } catch {
    return null;
  }
  if (!Number.isFinite(mtimeMs)) return null;
  // Re-sampled AFTER the stat: a live container may have written the file since the caller's `now`.
  return mtimeMs <= Date.now() + HEARTBEAT_MAX_SKEW_MS ? mtimeMs : null;
}

function hasRecentRestartNote(mailbox: NanoclawMailboxSession, now: number): boolean {
  return mailbox.hasRestartNoteSince(new Date(now - RESTART_NOTE_DEDUPE_MS).toISOString());
}

/** Writes the note only if work was plausibly in flight; the recovery-derived id dedupes shutdown vs backstop. */
export function warnSessionIfWorkInFlight(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: string,
  /** True only when the caller KNOWS the container runs (graceful shutdown); gates trusting `provider_executing`. */
  containerLive = false,
): boolean {
  const now = Date.now();
  if (hasRecentRestartNote(mailbox, now)) return false;
  const state = mailbox.getContainerState();
  const continuation = mailbox.readWorkContinuation();
  const processingClaimKey = freshProcessingClaimKey(mailbox, now);
  const resumableContinuation =
    continuation !== null && continuation.resume_attempts < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS;
  // A long autonomous turn holds no processing claim after its first result and no `current_tool` between tools,
  // so the heartbeat is the evidence that survives. Paired with `provider_executing` (raised per turn, lowered on
  // `result`), since the heartbeat is also touched by the terminal `result` of a turn that just ended. An explicit
  // 0 vetoes the heartbeat; undefined (legacy DB without the column) does not.
  const heartbeatMs = heartbeatMtimeMs(session);
  // Clamped: a stamp newer than `now` is maximally fresh (see HEARTBEAT_MAX_SKEW_MS).
  const heartbeatAgeMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
  const providerIdle = state?.provider_executing === 0;
  const freshHeartbeat = !providerIdle && heartbeatAgeMs !== null && heartbeatAgeMs <= RESTART_WARN_HEARTBEAT_FRESH_MS;
  // An executing turn needs no fresh heartbeat when the container is known live: a healthy Codex turn can stream
  // nothing well past the window. Not on the startup backstop, where the flag is residue from a dead container.
  // The heartbeat FILE must still exist: a SIGKILLed container leaves the flag at 1 until the next runner resets
  // it, and a respawn is registered live before that reset. Spawn deletes the file and only a streamed event
  // recreates it, so existence proves THIS container wrote the flag.
  const liveExecutingTurn = containerLive && state?.provider_executing === 1 && heartbeatMs !== null;
  const midWork =
    resumableContinuation ||
    processingClaimKey !== null ||
    freshHeartbeat ||
    liveExecutingTurn ||
    decideCeilingFollowUp({
      hasContinuation: false,
      currentTool: state?.current_tool ?? null,
      toolStartedAt: state?.tool_started_at ?? null,
      priorToolAttempts: 0,
      now,
    }).action === 'wake-accountable';
  if (!midWork) {
    // Say why, so a genuinely mid-work session with none of the narrow signals is diagnosable from logs.
    log.info('host-restart: no accountability note, no work-in-flight signal', {
      sessionId: session.id,
      reason,
      hasContinuation: continuation !== null,
      resumableContinuation,
      hasProcessingClaim: processingClaimKey !== null,
      currentTool: state?.current_tool ?? null,
      toolStartedAt: state?.tool_started_at ?? null,
      heartbeatAgeMs,
      providerExecuting: state?.provider_executing ?? null,
      containerLive,
    });
    return false;
  }

  const recoveryKey = continuation
    ? `${continuation.id}-${continuation.recovery_episode}-${continuation.resume_attempts}`
    : // Minute-rounded so the shutdown warn and the startup backstop derive the SAME id. The heartbeat is
      // non-null here: every remaining signal requires one.
      (state?.tool_started_at ?? processingClaimKey ?? `heartbeat-${Math.floor(heartbeatMs! / 60_000)}`);
  const episodeBucket = Math.floor(now / RESTART_NOTE_DEDUPE_MS);
  const recoveryHash = createHash('sha256').update(recoveryKey).digest('hex').slice(0, 16);
  const inserted = mailbox.insertDeferredMessageWithContextIfNew({
    id: `host-restart-${episodeBucket}-${recoveryHash}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text:
        `[system] The NanoClaw host restarted (${reason}) and stopped your container mid-work. ` +
        `Any in-flight turn, background task, or /tmp state was lost. Post ONE public accounting — ` +
        `done / lost / next — then resume from durable checkpoints or the stored continue_work task.`,
      sender: 'system',
      senderId: 'system',
      _system: { kind: RESTART_NOTE_MARKER, reason },
    }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
  if (inserted) log.info('Wrote host-restart accountability note', { sessionId: session.id, reason });
  return inserted;
}

async function warnSessions(session: Session, reason: string, containerLive = false): Promise<void> {
  try {
    // Existing-only: provisioning here would create an outbound.db the host must never author (I-10).
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      warnSessionIfWorkInFlight(mailbox, session, reason, containerLive),
    );
  } catch (err) {
    log.warn('host-restart warn failed for session', { sessionId: session.id, err });
  }
}

/**
 * Graceful-shutdown path: warn exactly the sessions this shutdown stops, before stopping them.
 * `stoppingSessionIds` is REQUIRED so a forgetful caller cannot fall back to every tracked container.
 */
export async function warnActiveContainersOfShutdown(
  reason: string,
  stoppingSessionIds: ReadonlySet<string>,
): Promise<void> {
  for (const sessionId of stoppingSessionIds) {
    const session = await getSession(sessionId);
    // From the live registry before any stop, so `provider_executing` is current state.
    if (session) await warnSessions(session, reason, true);
  }
}

/**
 * Startup backstop: sessions the central DB marks running/idle, minus `skipSessionIds` (the caller's set of
 * containers this boot keeps; a DB mark is not proof the container is gone). Runs BEFORE the boot stop pass,
 * which can outlast the heartbeat window and age out the evidence.
 */
export async function warnMarkedRunningSessionsOfStartup(
  reason: string,
  skipSessionIds: ReadonlySet<string>,
): Promise<void> {
  for (const session of await getRunningSessions()) {
    if (skipSessionIds.has(session.id)) continue;
    await warnSessions(session, reason);
  }
}
