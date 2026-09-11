/**
 * Detached execution for the repository delivery actions.
 *
 * `pollActive`/`pollSweep` drain sessions serially (delivery.ts:443-463), and a
 * `repository_publish` handled inline held that loop for the whole of
 * `quiesceSessionsForRepositoryMounts` — every sibling container in the
 * workgroup finishing its current tool call. Observed 2026-09-01:
 * `Active delivery poll timing cycleMs=172606 polled=2`, i.e. no session on the
 * host got an outbound message for nearly three minutes. Nothing about the
 * action needs the loop: the container fire-and-forgets the row
 * (git-worktrees.ts:428-442) and reads the outcome later from an `onWake` chat
 * row, so the only thing the inline call bought was the ack.
 *
 * So: return `deferAck` and run the apply on a detached chain.
 *
 *   - The undelivered `messages_out` row IS the durable job record. Nothing new
 *     is persisted, and deliberately NOT a `markPending` row — `getDeliveredIds`
 *     (modules/mailbox/ops/delivery.ts) cannot tell 'pending' from 'delivered', so one
 *     would silently lose the action across a host restart. A host that dies
 *     mid-publish leaves the row untouched: the startup orphan-fence pass
 *     releases the dead process's fences (repo-fence-recovery.ts:218) and the
 *     first poll re-dispatches the action, which both applies absorb
 *     idempotently (canonical-exists branch / transfer tombstone recovery).
 *   - `inFlight` is the dedup: the row stays undelivered while the job runs, so
 *     every 1s poll re-enters here and must find the job already started. It is
 *     keyed by request id alone, across every lane.
 *   - Jobs run on LANES: one FIFO chain per lane key, jobs on different lanes in
 *     parallel.
 *       - `repository_publish`, `repository_refresh` and `repository_transfer`
 *         share the one `'global'` lane. Two publishes in a workgroup collide on
 *         `withWorkgroupRepositoryMountClaim`, which THROWS rather than queues
 *         (repository-workspaces.ts:251), and a publish and a transfer share no
 *         claim namespace at all. The serial drain is what kept those apart, and
 *         the global lane reproduces exactly that property.
 *       - `repository_checkout` runs on a lane per (workgroup, work unit)
 *         (docs/specs/repository-branch-clones/plan.md §5.2, M6). Same-thread
 *         requests stay serialized, which is what makes a sibling's request for
 *         the same branch wait for, then reuse, the checkout being built. A
 *         checkout never quiesces or takes the mount claim, so it has no reason
 *         to queue behind an unrelated publish or transfer (which may itself be
 *         waiting on the requester's in-flight tool). It coordinates with them
 *         through the lifecycle claim (held -> retryable refusal) and the
 *         per-repository flock (queues).
 *     A lane is forgotten once its last job settles, so per-work-unit lanes do
 *     not accumulate.
 */
import type { DeliveryActionResult } from '../../delivery.js';
import { log } from '../../log.js';
import { releaseOrphanedRepoIngressFencesForDroppedMessage } from '../../repo-fence-recovery.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** Container-generated request id, which is also the `messages_out` row id. */
export const REPOSITORY_REQUEST_ID_PATTERN = /^repo-[0-9]{10,17}-[a-f0-9]{16}$/;

/** The lane publish, refresh and transfer share. */
export const GLOBAL_REPOSITORY_LANE = 'global';

export type RepositoryActionApply = (content: Record<string, unknown>, session: Session) => Promise<void>;

const inFlight = new Set<string>();
/** Tail of each lane's chain. Never rejects: every link ends in the terminal catch. */
const chains = new Map<string, Promise<void>>();

/** Test seam: await the tail of one lane's chain (the global lane by default). */
export function _repositoryActionChainForTesting(lane: string = GLOBAL_REPOSITORY_LANE): Promise<void> {
  return chains.get(lane) ?? Promise.resolve();
}

/** Test seam: how many lanes still hold a chain. */
export function _repositoryActionLaneCountForTesting(): number {
  return chains.size;
}

/** Test seam: forget every in-flight job so tests start from a clean runner. */
export function _resetRepositoryActionsForTesting(): void {
  inFlight.clear();
  chains.clear();
}

/**
 * Write this action's own `delivered` row. Returns false if the ack never landed.
 *
 * Its own short mailbox session: this runs on the detached job chain, long
 * after the drain that dispatched the action returned, and delivery holds no
 * session while a handler runs (plan §4.5b). A vanished mailbox counts as a
 * failed ack, same as an unwritable handle did.
 */
async function ackRow(session: Session, requestId: string, failure: unknown): Promise<boolean> {
  try {
    const acked = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      if (failure === null) mailbox.markDelivered(requestId, null);
      else mailbox.markDeliveryFailed(requestId, failure instanceof Error ? failure.message : String(failure));
      return true;
    });
    if (!acked) throw new Error(`session mailbox for ${session.id} is gone`);
    return true;
  } catch (ackError) {
    // The work is done but unacknowledged, so the row stays undelivered and the
    // next host start replays it — idempotently, by the applies' own design.
    // Keeping the in-flight guard is the point: re-running a ten-minute
    // fleet-wide quiescence because a SQLite handle failed is far worse than
    // deferring recovery to that restart.
    log.error('Repository action finished but its delivery ack could not be written', {
      sessionId: session.id,
      requestId,
      err: ackError,
    });
    return false;
  }
}

async function runRepositoryActionJob(
  action: string,
  apply: RepositoryActionApply,
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
): Promise<void> {
  let failure: unknown = null;
  try {
    await apply(content, session);
  } catch (error) {
    failure = error;
    log.error('Repository action failed', { action, requestId, sessionId: session.id, err: error });
  }
  const acked = await ackRow(session, requestId, failure);
  if (failure !== null) {
    // Incident 2026-09-01's last line of defence, preserved from the delivery
    // loop's give-up path: a failed publication can leave sessions fenced that
    // no live publication owns. Runs even when the ack write above failed — a
    // strand is the more expensive of the two failures.
    try {
      await releaseOrphanedRepoIngressFencesForDroppedMessage({ kind: 'system' }, session);
    } catch (recoveryErr) {
      log.error('Orphaned repository fence recovery after a failed repository action failed', {
        action,
        requestId,
        sessionId: session.id,
        err: recoveryErr,
      });
    }
  }
  if (acked) inFlight.delete(requestId);
}

/**
 * Delivery-action entry point: hand the apply to its lane's chain, ack
 * immediately.
 *
 * A payload with no usable request id is run inline instead — it throws before
 * any quiescence, so it costs nothing, and there is no key to write a
 * `delivered` row under, so the delivery loop's own retry/give-up path must
 * stay in charge of that row.
 */
export async function runRepositoryActionDetached(
  action: string,
  apply: RepositoryActionApply,
  content: Record<string, unknown>,
  session: Session,
  lane: string = GLOBAL_REPOSITORY_LANE,
): Promise<DeliveryActionResult> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  if (!REPOSITORY_REQUEST_ID_PATTERN.test(requestId)) {
    await apply(content, session);
    return undefined;
  }
  if (inFlight.has(requestId)) return { deferAck: true };
  inFlight.add(requestId);
  log.info('Repository action queued off the delivery loop', { action, requestId, sessionId: session.id, lane });
  // Terminal catch. `runRepositoryActionJob` handles its own failures, but an
  // escape (a future edit, a throwing logger) would both poison the lane for
  // every later repository action on it and surface as an unhandled rejection,
  // which kills the host — the failure class this whole change exists to
  // remove. The escaped job keeps its in-flight entry, exactly like the
  // ack-failure branch: its ack is unproven, so only the next host start may
  // replay it.
  const tail = (chains.get(lane) ?? Promise.resolve()).then(() =>
    runRepositoryActionJob(action, apply, content, session, requestId).catch((err) =>
      log.error('Repository action job escaped its own error handling', {
        action,
        requestId,
        sessionId: session.id,
        err,
      }),
    ),
  );
  chains.set(lane, tail);
  void tail.then(() => {
    if (chains.get(lane) === tail) chains.delete(lane);
  });
  return { deferAck: true };
}
