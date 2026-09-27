/**
 * Repository delivery actions run on a detached chain with `deferAck`, so a
 * long quiesce never holds the serial delivery loop. The undelivered
 * `messages_out` row IS the durable job record (deliberately no `markPending`:
 * 'pending' reads as delivered and would be lost across a restart); a
 * restart re-dispatches it and both applies are idempotent. `inFlight`
 * (keyed by request id) is the dedup against the 1s poll re-entering.
 *
 * Lanes: publish, refresh and transfer share the `'global'` lane, because
 * their lifecycle claims THROW rather than queue. Checkout runs on a lane per
 * (workgroup, work unit): same-thread requests stay serialized, and it
 * coordinates with the others through the lifecycle claim and the
 * per-repository flock. Lanes are forgotten once idle.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { DeliveryActionResult } from '../../delivery.js';
import { log } from '../../log.js';
import { releaseOrphanedRepoIngressFencesForDroppedMessage } from '../../repo-fence-recovery.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** Container-generated request id, which is also the `messages_out` row id. */
export const REPOSITORY_REQUEST_ID_PATTERN = /^repo-[0-9]{10,17}-[a-f0-9]{16}$/;

const GLOBAL_REPOSITORY_LANE = 'global';

export type RepositoryActionApply = (content: Record<string, unknown>, session: Session) => Promise<void>;

const inFlight = new Set<string>();
/** Never rejects: every link ends in the terminal catch. */
const chains = new Map<string, Promise<void>>();

/**
 * A restart mid-drain replays the whole drain, so while one runs a marker file
 * tells scripts/deploy.sh to hold the restart.
 */
const DRAINING_ACTIONS = new Set(['repository_publish', 'repository_transfer']);

/** Its `pid` lets a deploy ignore a marker left by a host that died mid-drain. */
let drainMarkerPath = path.join(DATA_DIR, 'repository-drain-in-flight.json');

export function _setRepositoryDrainMarkerPathForTesting(markerPath: string): void {
  drainMarkerPath = markerPath;
}

function writeDrainMarker(action: string, requestId: string, session: Session): boolean {
  const marker = { action, requestId, sessionId: session.id, pid: process.pid, startedAt: new Date().toISOString() };
  const tmp = `${drainMarkerPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(drainMarkerPath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
    fs.renameSync(tmp, drainMarkerPath);
    return true;
  } catch (err) {
    log.warn('Repository drain marker not written; a deploy will not wait for this action', { action, requestId, err });
    return false;
  }
}

function clearDrainMarker(requestId: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(drainMarkerPath, 'utf8')) as { requestId?: unknown };
    if (current.requestId === requestId) fs.rmSync(drainMarkerPath, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Repository drain marker not cleared', { requestId, err });
    }
  }
}

export function _repositoryActionChainForTesting(lane: string = GLOBAL_REPOSITORY_LANE): Promise<void> {
  return chains.get(lane) ?? Promise.resolve();
}

export function _repositoryActionLaneCountForTesting(): number {
  return chains.size;
}

export function _resetRepositoryActionsForTesting(): void {
  inFlight.clear();
  chains.clear();
}

/** Returns false if the ack never landed; a vanished mailbox counts as failed. */
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
    // Keep the in-flight guard: the unacked row replays idempotently at the
    // next host start, far cheaper than re-running a fleet-wide quiesce now.
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
  const marked = DRAINING_ACTIONS.has(action) && writeDrainMarker(action, requestId, session);
  try {
    await apply(content, session);
  } catch (error) {
    failure = error;
    log.error('Repository action failed', { action, requestId, sessionId: session.id, err: error });
  } finally {
    if (marked) clearDrainMarker(requestId);
  }
  const acked = await ackRow(session, requestId, failure);
  if (failure !== null) {
    // A failed publication can leave sessions fenced that no publication owns.
    // Runs even when the ack failed: a strand is the costlier failure.
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
 * A payload with no usable request id runs inline: it throws before any
 * quiesce, and with no key the delivery loop must own the row's retry.
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
  // Terminal catch: an escape would poison the lane and, as an unhandled
  // rejection, kill the host. The job keeps its in-flight entry, since its
  // ack is unproven.
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
