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
 * warned — a resumable work continuation, a fresh tool start, or a fresh
 * processing claim. Narration/status output is deliberately not evidence.
 * Quiet sessions get no note, so a restart does not wake every idle
 * container into a public "nothing happened".
 */
import { createHash } from 'crypto';

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
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const RESTART_NOTE_MARKER = 'agent_host_restart';
const RESTART_NOTE_DEDUPE_MS = 10 * 60 * 1000;

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
  const midWork =
    resumableContinuation ||
    processingClaimKey !== null ||
    decideCeilingFollowUp({
      hasContinuation: false,
      currentTool: state?.current_tool ?? null,
      toolStartedAt: state?.tool_started_at ?? null,
      priorToolAttempts: 0,
      now,
    }).action === 'wake-accountable';
  if (!midWork) return false;

  const recoveryKey = continuation
    ? `${continuation.id}-${continuation.recovery_episode}-${continuation.resume_attempts}`
    : (state?.tool_started_at ?? processingClaimKey!);
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
