/**
 * Host-restart accountability: warn mid-work sessions BEFORE their containers
 * are stopped by a host shutdown/restart, so the interruption is announced
 * and self-accounted instead of silent.
 *
 * Every host start stops all install-labeled containers — graceful shutdown
 * via `stopAllContainers`, startup via `cleanupOrphansStrict` (quiescence is
 * a hard precondition for workgroup FS reconciliation). Without this, a
 * mid-work session loses its turn and its background workers with no
 * explanation, and only comes back when a human pings — the exact
 * "said it was working, then silence" failure family.
 *
 * The note and an inert recall marker are written atomically with on_wake=1.
 * The sweep replaces the marker with fresh recall, flips the note to
 * trigger=1, and respawns the session shortly after startup. The fresh
 * container must post a public accounting (done / lost / next) and resume
 * from durable state (checkpoints or an explicit work continuation).
 *
 * Spam guard: only sessions with explicit evidence of work in flight are
 * warned — a resumable work continuation, a fresh tool start, a fresh
 * processing claim, or a fresh heartbeat. Narration/status output is
 * deliberately not evidence. The heartbeat is not narration and does count,
 * paired with `provider_executing`: the runner touches it once per streamed
 * provider event and never on an idle poll, so a fresh mtime plus a raised
 * executing flag is direct evidence that a turn was open — the same authority
 * the sweep's ceiling kill and idle reaper already read those as. Quiet
 * sessions get no note, so a restart does not wake every idle container into
 * a public "nothing happened".
 */
import { createHash } from 'crypto';
import fs from 'node:fs';

import { getActiveContainerSessionIds } from './container-runner.js';
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
 * How recently the heartbeat file must have been touched for a turn to count
 * as streaming right now.
 *
 * The heartbeat is NOT a general liveness ping. `touchHeartbeat` is called
 * once per streamed provider event (`container/agent-runner/src/poll-loop.ts`,
 * immediately after `handleEvent` in the event loop of an open query), across
 * a transient-overload backoff sleep, and around a task script — and nowhere
 * else. An idle container waiting on its poll interval never touches it, which
 * is exactly why the 30-minute idle ceiling works. So a heartbeat this fresh
 * means one thing: a turn was mid-stream when the host went down.
 *
 * Two minutes, and deliberately NOT the ceiling's thirty. This window has to
 * bridge the gaps between events during long model thinking or one slow tool
 * call, which are seconds to a minute or so. Reusing ABSOLUTE_CEILING_MS would
 * over-warn instead: it would call every container whose last turn merely
 * ENDED within the last half hour "mid-work", which is the idle-container
 * spam this guard exists to prevent.
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
 * Heartbeat mtime, or null when there is no usable one. A missing file (never
 * woken, or cleared at spawn) and a future mtime both read as "no signal"
 * rather than as evidence.
 */
function heartbeatMtimeMs(session: Session, now: number): number | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs;
  } catch {
    return null;
  }
  return Number.isFinite(mtimeMs) && mtimeMs <= now ? mtimeMs : null;
}


function hasRecentRestartNote(mailbox: NanoclawMailboxSession, now: number): boolean {
  return mailbox.hasRestartNoteSince(new Date(now - RESTART_NOTE_DEDUPE_MS).toISOString());
}

/**
 * Write the restart accountability note for one session if (and only if)
 * work was plausibly in flight. The recovery-signal-derived ID makes the
 * graceful shutdown path and startup backstop idempotent for one interruption.
 * Returns true when a note was written.
 */
export function warnSessionIfWorkInFlight(mailbox: NanoclawMailboxSession, session: Session, reason: string): boolean {
  const now = Date.now();
  if (hasRecentRestartNote(mailbox, now)) return false;
  const state = mailbox.getContainerState();
  const continuation = mailbox.readWorkContinuation();
  const processingClaimKey = freshProcessingClaimKey(mailbox, now);
  const resumableContinuation =
    continuation !== null && continuation.resume_attempts < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS;
  // The clause that was missing, and why the 2026-09-04 restart lost a turn.
  // The runner marks its initial batch `completed` as soon as the first
  // result event lands (`poll-loop.ts`, "so the host sweep doesn't see stale
  // 'processing' claims while the query stays open for follow-up pushes"),
  // and then keeps working for minutes inside the same open query. So a long
  // autonomous turn has NO processing claim after its first few seconds, and
  // between two tool calls it has no `current_tool` either. All three of the
  // signals above are absent while the agent is demonstrably mid-turn, which
  // is exactly the state sess-1788440696563-ae2rvy was in: status edits until
  // 11:02:52Z, heartbeat 11:02:51Z, container SIGTERMed at 11:02:56Z, its
  // newest trigger row four minutes old — and no note, while two sibling
  // sessions got one.
  //
  // The heartbeat is what survives that, because the runner touches it per
  // streamed provider event and never on an idle poll. See
  // RESTART_WARN_HEARTBEAT_FRESH_MS.
  //
  // Paired with `provider_executing`, because the heartbeat alone is one step
  // too generous. The runner touches it after EVERY stream event including the
  // terminal `result`, so a turn that just ended normally leaves an mtime
  // seconds old — and a restart inside the window would warn a session with
  // nothing in flight, which is the idle spam this guard exists to prevent.
  // `provider_executing` is the column that separates those two: the runner
  // raises it on the prompt that starts a turn and lowers it on the `result`
  // that ends one (`container/agent-runner/src/modules/mailbox/container-state.ts`),
  // and it also covers the runner-driven windows the host cannot otherwise see
  // — a pre-task script batch, a pushed follow-up turn, a continuation turn —
  // which is the same blind spot the sweep's idle reaper added it for.
  //
  // An explicit 0 vetoes the heartbeat. undefined does not: a legacy outbound
  // DB without the column drops to the tool-only tier in getContainerState and
  // reads back undefined, and there the heartbeat alone is still better
  // evidence than nothing.
  const heartbeatMs = heartbeatMtimeMs(session, now);
  const heartbeatAgeMs = heartbeatMs === null ? null : now - heartbeatMs;
  const providerIdle = state?.provider_executing === 0;
  const freshHeartbeat =
    !providerIdle && heartbeatAgeMs !== null && heartbeatAgeMs <= RESTART_WARN_HEARTBEAT_FRESH_MS;
  const midWork =
    resumableContinuation ||
    processingClaimKey !== null ||
    freshHeartbeat ||
    decideCeilingFollowUp({
      hasContinuation: false,
      currentTool: state?.current_tool ?? null,
      toolStartedAt: state?.tool_started_at ?? null,
      priorToolAttempts: 0,
      now,
    }).action === 'wake-accountable';
  if (!midWork) {
    // Say WHY, once per interrupted container per restart. The signals are
    // deliberately narrow (see the spam guard in the module header), so a
    // session that is genuinely mid-work but shows none of them goes dark
    // with no note and no trace that a decision was even made. That silence
    // is what made the 2026-09-04 restart unresolvable from logs: two sibling
    // sessions got notes, the one actually killed mid-turn got nothing, and
    // no line recorded which signal it was missing. Bounded — this runs only
    // for sessions whose containers are about to be stopped.
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
    });
    return false;
  }

  const recoveryKey = continuation
    ? `${continuation.id}-${continuation.recovery_episode}-${continuation.resume_attempts}`
    : // midWork is true, so at least one of these is set. The heartbeat is
      // last because it is the coarsest: it identifies the interruption, not
      // the work, which is all the dedupe id needs. Rounded to the minute so
      // the graceful-shutdown warn and the startup backstop — which run
      // seconds apart, on either side of the same interruption — derive the
      // SAME id and the second one is a no-op rather than a duplicate note.
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

async function warnSessions(session: Session, reason: string): Promise<void> {
  try {
    // Existing-only. The note is for a session whose container is about to be
    // stopped, so its mailbox is there; provisioning one here would author an
    // outbound.db the host must never create (invariant I-10) for a session
    // that has already been reclaimed.
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      warnSessionIfWorkInFlight(mailbox, session, reason),
    );
  } catch (err) {
    log.warn('host-restart warn failed for session', { sessionId: session.id, err });
  }
}

/**
 * Graceful-shutdown path: warn sessions the live registry says have running
 * containers. Runs before stopAllContainers so the note is in place before
 * the container dies.
 */
export async function warnActiveContainersOfShutdown(reason: string): Promise<void> {
  for (const sessionId of getActiveContainerSessionIds()) {
    const session = getSession(sessionId);
    if (session) await warnSessions(session, reason);
  }
}

/**
 * Startup backstop (crash and first-rollout paths): inspect only sessions the
 * central DB still marks running/idle. Within that interrupted-container set,
 * durable continuation is authoritative while tool and processing signals
 * are freshness-bound.
 */
export async function warnMarkedRunningSessionsOfStartup(reason: string): Promise<void> {
  for (const session of getRunningSessions()) {
    await warnSessions(session, reason);
  }
}
