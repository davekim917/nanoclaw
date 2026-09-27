/** The repository ingress fence as an admission gate, so poll-loop.ts never knows a fence exists. */
import { clearTickRepositoryBarrier, getActiveRepositoryMountBarrier, setTickRepositoryBarrier } from './selection.js';
import { acknowledgeRepositoryMountBarrier, getRepositoryMountBarrierAck } from './session-state.js';

let reportedFailure: string | null = null;

/**
 * Hold admission while the host holds a repository fence, and publish the ack the host waits for (only this
 * idle boundary acks; mid-turn observers only drain). The WHOLE path fails CLOSED here: `evaluateAdmission`
 * treats a throwing gate as not holding, and a swallowed failure would start a turn under an active fence. A
 * held tick touches no heartbeat, so a broken DB gets the container reaped.
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
