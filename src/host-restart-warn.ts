/**
 * Host-restart accountability: warn mid-work sessions BEFORE their containers
 * are stopped by a host shutdown/restart, so the interruption is announced
 * and self-accounted instead of silent.
 *
 * A note is for a session whose container THIS restart actually interrupts —
 * one the host is stopping on the way down, or one whose container this boot
 * will stop on the way up — and never for one that survives. Both call sites
 * are handed the set they apply to, because "every container this host tracks"
 * and "every container this restart interrupts" stopped being the same set
 * once containers began surviving a restart. Without the note, an interrupted
 * session loses its turn and its background workers with no explanation, and
 * only comes back when a human pings — the exact "said it was working, then
 * silence" failure family.
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
 *
 * Known residual: this closes the GRACEFUL path. After an unclean host crash
 * the startup backstop cannot trust `provider_executing` (it is whatever the
 * dead container last wrote), so a session interrupted mid-turn with more than
 * RESTART_WARN_HEARTBEAT_FRESH_MS of provider silence — a long quiet Codex tool
 * call, say — still gets no note on that path. A session whose container
 * survives the restart also gets no note, which is correct: nothing
 * interrupted it, and there is no lost turn to account for.
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
 * How far ahead of a clock sampled AFTER the read an mtime may sit and still be
 * believed.
 *
 * A stamp slightly in the future is the normal case here, not an anomaly: the
 * graceful-shutdown warn runs BEFORE `stopAllContainers`, so the container is
 * still alive and still touching this file while we stat it. Comparing against
 * the caller's entry clock and rejecting anything newer would therefore discard
 * the single freshest, most conclusive heartbeat there is — the busiest
 * container, mid-turn, would be the one session left with no note. That is the
 * exact stranding this module was changed to prevent.
 *
 * The bound still has to exist, because a genuinely bad stamp (a clock step, a
 * file restored from elsewhere) would otherwise read as permanently fresh and
 * warn this session on every restart forever. Container and host share one
 * kernel clock and one filesystem, so a few seconds past a post-read sample is
 * already far more than a concurrent touch can explain.
 */
const HEARTBEAT_MAX_SKEW_MS = 5_000;

/**
 * Heartbeat mtime, or null when there is no usable one. A missing file (never
 * woken, or cleared at spawn) reads as "no signal" rather than as evidence, and
 * so does a stamp beyond {@link HEARTBEAT_MAX_SKEW_MS} in the future.
 */
function heartbeatMtimeMs(session: Session): number | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs;
  } catch {
    return null;
  }
  if (!Number.isFinite(mtimeMs)) return null;
  // Re-sample AFTER the stat: everything between the caller's `now` and this
  // point is time a live container had to write the file.
  return mtimeMs <= Date.now() + HEARTBEAT_MAX_SKEW_MS ? mtimeMs : null;
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
export function warnSessionIfWorkInFlight(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: string,
  /**
   * True only when the caller KNOWS this session's container is still running
   * — the graceful-shutdown path, which iterates the live container registry
   * before stopping anything. It decides whether `provider_executing` may be
   * trusted on its own; see `liveExecutingTurn` below. Defaults to false so a
   * caller that does not know takes the stricter reading.
   */
  containerLive = false,
): boolean {
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
  // is exactly the state the stranded session was in: status edits until
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
  const heartbeatMs = heartbeatMtimeMs(session);
  // Clamped: a live container writing the file while we read it legitimately
  // produces a stamp newer than `now`, and that is maximally fresh, not
  // negative age. See HEARTBEAT_MAX_SKEW_MS.
  const heartbeatAgeMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
  const providerIdle = state?.provider_executing === 0;
  const freshHeartbeat = !providerIdle && heartbeatAgeMs !== null && heartbeatAgeMs <= RESTART_WARN_HEARTBEAT_FRESH_MS;
  // A turn that is executing RIGHT NOW needs no heartbeat corroboration, but
  // only when we know the container is alive — which is exactly the
  // graceful-shutdown path, where this runs against the live registry before
  // stopAllContainers.
  //
  // The window is real and it is not an edge case. The Codex provider has no
  // total-turn and no idle timeout by design (its watchdog is health-probe
  // based: `codex.factory.test.ts` asserts the absence of both, and probing
  // only begins after CODEX_HEALTH_PROBE_QUIET_MS = 60s, every 30s). So a
  // healthy turn can stream nothing for well past the freshness window. A
  // pushed follow-up turn in that state holds no processing claim (its rows
  // were completed when it was pushed), may sit between tools with no
  // current_tool, and may have no continuation — the ae2rvy shape exactly,
  // with a stale heartbeat on top. Requiring both would strand it.
  //
  // Not extended to the startup backstop: there the previous host is gone, so
  // this flag is whatever a dead container last wrote and nothing has reset it
  // yet (`resetProviderExecuting` runs at the NEXT container's startup). Stale
  // 1s would warn that session on every boot. There, freshness still rules.
  //
  // The heartbeat FILE must exist even here, and that is not belt-and-braces —
  // it is what makes `containerLive` mean what it says. A container killed by
  // SIGKILL or the OOM reaper never runs the `finally` that lowers the flag
  // (poll-loop.ts), so `provider_executing` stays 1 in outbound.db until the
  // NEXT container clears it in `clearStaleProcessingAcks` at startup. The host
  // registers a respawn in `activeContainers` immediately after `spawn()`
  // (container-runner.ts), which is BEFORE the runner has booted far enough to
  // run that reset — so in that window `containerLive` is true and the flag is
  // pure residue from the dead container. A shutdown landing there would write
  // a mid-work note for a container that has not begun a turn.
  //
  // Heartbeat existence closes exactly that window and nothing else. The spawn
  // path deletes the file before starting the container (container-runner.ts),
  // and only `touchHeartbeat` recreates it — first reached on a streamed
  // provider event, well after the reset. So a heartbeat that EXISTS proves the
  // flag was written by THIS container. Existence, deliberately not freshness:
  // a stale-but-present heartbeat is the long-quiet Codex turn this clause was
  // added for.
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
      containerLive,
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
      // Non-null by construction: every remaining signal that can reach here —
      // freshHeartbeat and liveExecutingTurn alike — requires a heartbeat mtime.
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
    // Existing-only. The note is for a session whose container is about to be
    // stopped, so its mailbox is there; provisioning one here would author an
    // outbound.db the host must never create (invariant I-10) for a session
    // that has already been reclaimed.
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      warnSessionIfWorkInFlight(mailbox, session, reason, containerLive),
    );
  } catch (err) {
    log.warn('host-restart warn failed for session', { sessionId: session.id, err });
  }
}

/**
 * Graceful-shutdown path: warn exactly the sessions this shutdown is stopping.
 * Runs before those containers are stopped so the note is in place before the
 * container dies.
 *
 * `stoppingSessionIds` is REQUIRED and computed by the caller. An optional
 * parameter would silently restore the fleet-wide behaviour whenever a caller
 * forgot it, and the whole point of the set is that "every tracked container"
 * and "every container being stopped" are no longer the same thing. Passing a
 * set rather than a registry accessor is also what keeps this module free of
 * any dependency on the container registry.
 */
export async function warnActiveContainersOfShutdown(
  reason: string,
  stoppingSessionIds: ReadonlySet<string>,
): Promise<void> {
  for (const sessionId of stoppingSessionIds) {
    const session = await getSession(sessionId);
    // These ids come from the live container registry and nothing has been
    // stopped yet, so `provider_executing` is current state, not residue.
    if (session) await warnSessions(session, reason, true);
  }
}

/**
 * Startup backstop (crash and first-rollout paths): inspect only sessions the
 * central DB still marks running/idle, minus the ones whose containers will
 * survive this boot. Within that genuinely-interrupted set, durable
 * continuation is authoritative while tool and processing signals are
 * freshness-bound.
 *
 * `skipSessionIds` is REQUIRED and computed by the caller: the sessions whose
 * container this boot will NOT stop. `running`/`idle` in the central DB is a
 * mark left by the previous host, not proof that a container is gone, so the
 * partition has to come from the boot scope rather than from this module. A
 * session that keeps its container was not interrupted and must get no note.
 *
 * This runs BEFORE the boot stop pass, not after it. The stop pass is
 * sequential and can exceed RESTART_WARN_HEARTBEAT_FRESH_MS end to end, which
 * would age heartbeat-only evidence out of the window and leave the sessions
 * stopped first with no note at all. Predicting the partition and warning
 * early is what keeps that evidence readable.
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
