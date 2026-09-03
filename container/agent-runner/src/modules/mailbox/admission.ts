/**
 * The fork's admission gate — the repository ingress fence, observed at the
 * poll loop's provider-idle boundary through `registerAdmissionGate`.
 *
 * This is the fork's half of the seam described in
 * docs/specs/upstream-mailbox-seam/plan.md §4.5: `poll-loop.ts` no longer knows
 * that a repository fence exists, it only asks whether admission is held.
 */
import { clearTickRepositoryBarrier, getActiveRepositoryMountBarrier, setTickRepositoryBarrier } from './selection.js';
import { acknowledgeRepositoryMountBarrier, getRepositoryMountBarrierAck } from './session-state.js';

let reportedReadFailure: string | null = null;

/**
 * Hold admission while the host holds a repository ingress fence, and record
 * that the loop reached the boundary — the acknowledgement the host waits for
 * before it stops the container. Only this idle boundary publishes it; the
 * mid-turn observers in `poll-loop.ts` drain, they never acknowledge.
 *
 * The barrier is read once here and memoized for the `getPendingMessages` call
 * that follows in the same tick, so a fenced poll costs one `inbound.db` open
 * instead of two. The write is idempotent: a re-evaluation of a token the
 * session already acknowledged does not touch `session_state`.
 */
export function repositoryFenceAdmissionGate(): boolean {
  let token: string | null;
  try {
    token = getActiveRepositoryMountBarrier();
  } catch (error) {
    // Fail CLOSED, in this gate, not in the seam. `evaluateAdmission` treats a
    // throwing gate as not holding, which is right for an optional observer and
    // wrong for this one: the loop's late re-checks run AFTER selection has
    // already returned a batch, so a swallowed read error there would start a
    // turn under a fence with nothing left to stop it. An unreadable inbound.db
    // means the poll is dead anyway, and a held tick touches no heartbeat — the
    // host sweep reaps the container instead of leaving it silently deaf.
    const message = String(error);
    if (reportedReadFailure !== message) {
      reportedReadFailure = message;
      console.error(`[admission] repository fence read failed — holding admission: ${message}`);
    }
    clearTickRepositoryBarrier();
    return true;
  }
  reportedReadFailure = null;
  setTickRepositoryBarrier(token);
  if (token === null) return false;
  if (getRepositoryMountBarrierAck() !== token) acknowledgeRepositoryMountBarrier(token);
  return true;
}
