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

let reportedFailure: string | null = null;

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
 *
 * The WHOLE path fails CLOSED, in this gate rather than in the seam.
 * `evaluateAdmission` treats a throwing gate as not holding, which is right for
 * an optional observer and wrong for this one: the loop's late re-checks run
 * AFTER selection has already produced a batch, so a swallowed failure there
 * would start a turn under an active fence — and without publishing the ack the
 * host is waiting for. That covers the `outbound.db` read and write as much as
 * the `inbound.db` read: a lock or I/O fault on either must hold, not admit.
 * Before this series a throw here propagated out of the poll loop, so holding
 * restores the fail-closed direction rather than inventing one.
 *
 * Holding is recoverable, not silent deafness: a session DB this broken means
 * the poll is dead anyway, and a held tick touches no heartbeat, so the host
 * staleness sweep reaps the container.
 */
export function repositoryFenceAdmissionGate(): boolean {
  try {
    const token = getActiveRepositoryMountBarrier();
    setTickRepositoryBarrier(token);
    if (token !== null && getRepositoryMountBarrierAck() !== token) acknowledgeRepositoryMountBarrier(token);
    reportedFailure = null;
    return token !== null;
  } catch (error) {
    const message = String(error);
    if (reportedFailure !== message) {
      reportedFailure = message;
      console.error(`[admission] repository fence check failed — holding admission: ${message}`);
    }
    clearTickRepositoryBarrier();
    return true;
  }
}
