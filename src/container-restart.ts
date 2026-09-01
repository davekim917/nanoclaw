/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, isContainerSpawning, killContainer, wakeContainer } from './container-runner.js';
import { randomUUID } from 'crypto';
import {
  activateRepoIngressFence,
  countDueMessages,
  getContainerState,
  getProcessingClaims,
  repoIngressFenceAckToken,
  readRepoIngressFence,
  readRepositoryMountBarrierAck,
  releaseRepoIngressFence,
} from './db/session-db.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { inboundDbPath, openInboundDb, openOutboundDb, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';
import fs from 'fs';

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface RepositoryMountQuiescence {
  epoch: string;
  /** Containers stopped by this quiescence and eligible for a later wake. */
  sessions: Session[];
  /** Every session DB fenced against concurrent ingress until release. */
  barrierSessions: Session[];
  /** Exact fresh/adopted activation token expected from each running session. */
  barrierAcks: Record<string, string>;
  barrierGenerations: Record<string, string>;
}

export class RepositoryMountQuiescenceError extends Error {
  readonly quiescence: RepositoryMountQuiescence;
  readonly releaseWakeSessions: Session[];
  readonly barriersReleased: boolean;

  constructor(
    cause: unknown,
    quiescence: RepositoryMountQuiescence,
    releaseWakeSessions: Session[],
    barriersReleased: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RepositoryMountQuiescenceError';
    this.quiescence = quiescence;
    this.releaseWakeSessions = releaseWakeSessions;
    this.barriersReleased = barriersReleased;
  }
}

/**
 * Activation failed AND the rollback could not un-fence every session it had
 * already fenced.
 *
 * Incident 2026-09-01: this case threw a bare `AggregateError`, so the caller's
 * `error instanceof RepositoryMountQuiescenceError` branch never matched, its
 * `quiescence` stayed null, and no barrier release was ever attempted for the
 * sessions the rollback had missed. Carrying the stranded set on a typed error
 * lets `quiesceSessionsForRepositoryMounts` hand it back through the recovery
 * shape that already exists for exactly this (`barriersReleased: false`).
 */
export class RepositoryMountBarrierRollbackError extends Error {
  readonly epoch: string;
  readonly strandedSessions: Session[];
  readonly barrierGenerations: Record<string, string>;

  constructor(cause: unknown, epoch: string, strandedSessions: Session[], barrierGenerations: Record<string, string>) {
    super(`repository mount barrier ${epoch} activation failed and could not be fully rolled back`, { cause });
    this.name = 'RepositoryMountBarrierRollbackError';
    this.epoch = epoch;
    this.strandedSessions = strandedSessions;
    this.barrierGenerations = barrierGenerations;
  }
}

function uniqueSessions(sessions: Session[]): Session[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()];
}

/**
 * A session row whose inbound DB was never created (or was reclaimed) has no
 * ingress path to fence: messages_in only exists inside that file, and the only
 * writer that could create it is a spawn, which is already rejected at the
 * workgroup mount claim (container-runner `isWorkgroupRepositoryMountClaimed`)
 * for the whole quiescence window. Opening it instead throws inside
 * better-sqlite3 ("directory does not exist") and fails the entire publication.
 */
function hasFenceableIngress(session: Session): boolean {
  return fs.existsSync(inboundDbPath(session.agent_group_id, session.id));
}

/**
 * Fencing writes one commit per session DB under `journal_mode=DELETE`, which
 * costs ~9ms of synchronous fsync each. A workgroup with thousands of sessions
 * therefore blocks the host event loop for a minute or more, starving every
 * unrelated channel adapter and workgroup. Yielding keeps the stall scoped to
 * the workgroup being reconciled; the mount claim (not this loop) is what holds
 * admission closed, so a yield here cannot let a spawn through.
 */
async function yieldEventLoop(index: number): Promise<void> {
  if (index > 0 && index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
}

async function activateRepositoryMountBarriers(
  sessions: Session[],
  epoch: string,
): Promise<{ barrierAcks: Record<string, string>; barrierGenerations: Record<string, string> }> {
  const activated: Session[] = [];
  const barrierAcks: Record<string, string> = {};
  const barrierGenerations: Record<string, string> = {};
  try {
    for (const [index, session] of sessions.entries()) {
      await yieldEventLoop(index);
      const inDb = openInboundDb(session.agent_group_id, session.id);
      try {
        const prior = readRepoIngressFence(inDb);
        const active = activateRepoIngressFence(inDb, epoch);
        barrierAcks[session.id] = repoIngressFenceAckToken(active);
        barrierGenerations[session.id] = active.generation;
        // A replay may be adopting a crash-left active barrier with this exact
        // deterministic epoch. It did not create that barrier and therefore
        // must never roll it back if a later session activation fails.
        if (prior?.state !== 'active' || prior.epoch !== epoch) activated.push(session);
      } finally {
        inDb.close();
      }
    }
  } catch (error) {
    // No topology mutation has happened yet. Restore every DB fenced by this
    // attempt so an activation failure cannot strand unrelated inbound work.
    const releaseErrors: unknown[] = [];
    const stranded: Session[] = [];
    for (const session of activated.reverse()) {
      try {
        const inDb = openInboundDb(session.agent_group_id, session.id);
        try {
          const generation = barrierGenerations[session.id];
          if (!generation) {
            throw new Error(`repository mount barrier generation missing for session ${session.id}`, { cause: error });
          }
          releaseRepoIngressFence(inDb, epoch, generation);
        } finally {
          inDb.close();
        }
      } catch (releaseError) {
        releaseErrors.push(releaseError);
        stranded.push(session);
      }
    }
    if (releaseErrors.length > 0) {
      throw new RepositoryMountBarrierRollbackError(
        new AggregateError(
          [error, ...releaseErrors],
          `repository mount barrier ${epoch} activation failed and could not be fully rolled back`,
          { cause: error },
        ),
        epoch,
        stranded,
        barrierGenerations,
      );
    }
    throw error;
  }
  return { barrierAcks, barrierGenerations };
}

function sessionReachedRepositoryBarrier(session: Session, expectedAck: string): boolean {
  if (!isContainerRunning(session.id) && !isContainerSpawning(session.id)) return true;
  try {
    const outDb = openOutboundDb(session.agent_group_id, session.id);
    try {
      return (
        readRepositoryMountBarrierAck(outDb) === expectedAck &&
        getProcessingClaims(outDb).length === 0 &&
        !getContainerState(outDb)?.current_tool
      );
    } finally {
      outDb.close();
    }
  } catch {
    // Unknown acknowledgement or work state is never safe to stop.
    return false;
  }
}

/**
 * Release the exact durable ingress epoch after the mount transition and its
 * on-wake confirmation are committed. Idempotent for an already-released
 * matching epoch; any different/missing state fails closed.
 */
export async function releaseRepositoryMountQuiescence(quiescence: RepositoryMountQuiescence): Promise<Session[]> {
  const wakeRequired: Session[] = [];
  for (const [index, session] of quiescence.barrierSessions.entries()) {
    await yieldEventLoop(index);
    const inDb = openInboundDb(session.agent_group_id, session.id);
    try {
      const generation = quiescence.barrierGenerations[session.id];
      if (!generation) throw new Error(`repository mount barrier generation missing for session ${session.id}`);
      const result = releaseRepoIngressFence(inDb, quiescence.epoch, generation);
      if (!result.released) {
        const current = readRepoIngressFence(inDb);
        if (
          !current ||
          current.epoch !== quiescence.epoch ||
          current.generation !== generation ||
          current.state !== 'released'
        ) {
          throw new Error(`repository mount barrier state changed for session ${session.id}`);
        }
      }
      // Recompute from durable state even on an idempotent replay. This closes
      // the crash-after-release-before-wake boundary for both rows tagged by
      // this epoch and ordinary due rows that predated the fence.
      if (countDueMessages(inDb) > 0) wakeRequired.push(session);
    } finally {
      inDb.close();
    }
  }
  return wakeRequired;
}

/**
 * Called while a workgroup-wide repository mount claim blocks new spawns.
 * It catches spawns already past the claim check, then stops every affected
 * running container and returns the exact sessions to wake after claim release.
 */
export async function quiesceAgentGroupsForRepositoryMounts(
  agentGroupIds: string[],
  epoch: string = `repository-mount-${randomUUID()}`,
): Promise<RepositoryMountQuiescence> {
  const sessions = agentGroupIds.flatMap((id) => getSessionsByAgentGroup(id));
  return quiesceSessionsForRepositoryMounts(sessions, epoch);
}

/** Stop the running subset of an exact topic/session set while its lifecycle claim is held. */
export async function quiesceSessionsForRepositoryMounts(
  sessions: Session[],
  epoch: string = `repository-mount-${randomUUID()}`,
  timeoutMs = 120_000,
): Promise<RepositoryMountQuiescence> {
  if (!epoch) throw new Error('repository mount barrier epoch must not be empty');
  const known = uniqueSessions(sessions);
  // Runtime process maps are authoritative. A stale inactive DB row can still
  // own a live RW mount and must not escape quiescence — so the stop set is
  // derived before the fenceable filter, never from it.
  const affected = known.filter((session) => isContainerRunning(session.id) || isContainerSpawning(session.id));
  const barrierSessions = known.filter(hasFenceableIngress);
  // A live container always owns an inbound DB to poll. If one is running
  // without a fenceable DB the host's view is inconsistent, and proceeding
  // would wait the full barrier timeout for an ack that can never be written.
  const unfenceable = affected.filter((session) => !hasFenceableIngress(session));
  if (unfenceable.length > 0) {
    throw new Error(
      `running session(s) have no inbound database to fence: ${unfenceable.map((session) => session.id).join(', ')}`,
    );
  }
  let barrierAcks: Record<string, string>;
  let barrierGenerations: Record<string, string>;
  try {
    ({ barrierAcks, barrierGenerations } = await activateRepositoryMountBarriers(barrierSessions, epoch));
  } catch (error) {
    // A partial rollback leaves real fences behind, and the caller's only
    // recovery affordance is RepositoryMountQuiescenceError. Re-shape into it
    // with the stranded set as the barrier sessions and `barriersReleased:
    // false`, so `applyRepositoryPublishAction` / `applyRepositoryTransferAction`
    // retry the release instead of dropping them (incident 2026-09-01).
    if (error instanceof RepositoryMountBarrierRollbackError) {
      throw new RepositoryMountQuiescenceError(
        error,
        {
          epoch,
          sessions: [],
          barrierSessions: error.strandedSessions,
          barrierAcks: {},
          barrierGenerations: error.barrierGenerations,
        },
        [],
        false,
      );
    }
    throw error;
  }
  const quiescence = { epoch, sessions: affected, barrierSessions, barrierAcks, barrierGenerations };
  try {
    await waitUntil(
      () => affected.every((session) => !isContainerSpawning(session.id)),
      'timed out waiting for in-progress container spawns before repository mount reconciliation',
      timeoutMs,
    );
    await waitUntil(
      () => affected.every((session) => sessionReachedRepositoryBarrier(session, barrierAcks[session.id]!)),
      'timed out waiting for container poll admission and active repository work to drain',
      timeoutMs,
    );
    for (const session of affected) {
      if (isContainerRunning(session.id)) killContainer(session.id, 'repository mount set changed');
    }
    await waitUntil(
      () => affected.every((session) => !isContainerRunning(session.id)),
      'timed out stopping containers for repository mount reconciliation',
      timeoutMs,
    );
    return quiescence;
  } catch (error) {
    // Every container that observed the barrier has permanently ended its SDK
    // query input stream, so it can never do useful work again. Leaving one
    // alive surfaces as cancelled tool calls the agent misreads as revoked
    // permissions. Kill failures are logged, never allowed to mask `error` or
    // skip the barrier release below.
    for (const session of affected) {
      try {
        if (isContainerRunning(session.id)) killContainer(session.id, 'repository mount quiescence failed');
      } catch (killError) {
        log.warn('Failed to stop container after repository mount quiescence failure', {
          sessionId: session.id,
          error: killError instanceof Error ? killError.message : String(killError),
        });
      }
    }
    try {
      const releaseWakeSessions = await releaseRepositoryMountQuiescence(quiescence);
      throw new RepositoryMountQuiescenceError(error, quiescence, releaseWakeSessions, true);
    } catch (releaseError) {
      if (releaseError instanceof RepositoryMountQuiescenceError) throw releaseError;
      throw new RepositoryMountQuiescenceError(
        new AggregateError(
          [error, releaseError],
          'repository quiescence failed and its ingress barrier could not be released',
        ),
        quiescence,
        [],
        false,
      );
    }
  }
}

export function wakeRepositoryMountSessions(sessions: Session[]): void {
  for (const session of sessions) wakeContainer(session);
}

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export async function restartAgentGroupContainers(
  agentGroupId: string,
  reason: string,
  wakeMessage?: string,
  options: { respawnAll?: boolean } = {},
): Promise<number> {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  let restarted = 0;
  let failed = 0;
  for (const session of sessions) {
    if (wakeMessage) {
      // Awaited so the write is durable before killContainer — but a failure
      // must cost this session only. Before the await existed, the write was
      // fire-and-forget and its rejection escaped as an unhandledRejection, so
      // the loop always finished; letting it throw here instead would kill the
      // sessions ahead of it and strand every one behind it, half-restarting
      // the group. Skip this session's kill (never kill a container whose wake
      // message did not land), count it, and carry on.
      try {
        await writeSessionMessage(agentGroupId, session.id, {
          id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: agentGroupId,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({
            text: wakeMessage,
            sender: 'system',
            senderId: 'system',
          }),
          onWake: 1,
        });
      } catch (err) {
        failed += 1;
        log.warn('Restart: wake message failed; leaving this container running', {
          agentGroupId,
          sessionId: session.id,
          err,
        });
        continue;
      }
    }
    // The container can exit during the awaited write above, and killContainer
    // no-ops on a session it no longer tracks — counting that as a restart
    // reports work that did not happen.
    if (!isContainerRunning(session.id)) continue;

    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    //
    // This open can throw too, now that the inbound funnel refuses under a
    // reclaim claim — same rule as the write: cost this session, not the loop.
    let hasPending: boolean;
    try {
      const inDb = openInboundDb(session.agent_group_id, session.id);
      try {
        hasPending = countDueMessages(inDb) > 0;
      } finally {
        // Callers own the connection lifecycle (session-db.ts) — close per op
        // or each restart leaks one better-sqlite3 FD + mmap segment.
        inDb.close();
      }
    } catch (err) {
      failed += 1;
      log.warn('Restart: could not read pending work; leaving this container running', {
        agentGroupId,
        sessionId: session.id,
        err,
      });
      continue;
    }
    killContainer(
      session.id,
      reason,
      wakeMessage || hasPending || options.respawnAll
        ? () => {
            const s = getSession(session.id);
            if (s) wakeContainer(s);
          }
        : undefined,
    );
    restarted += 1;
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: restarted, failed });
  }
  return restarted;
}
