/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import {
  containerOwnsOutbound,
  getContainerIdentity,
  hasPendingAdoption,
  isContainerRunning,
  isContainerSpawning,
  killContainer,
  resolvePendingSurvivor,
  sessionStillActive,
} from './container-runner.js';
import { requestWake } from './request-wake.js';
import { randomUUID } from 'crypto';
import { listInstallContainersWithScope, stopContainer, type InstallContainerScope } from './container-runtime.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { SessionDbMissingError, sessionMailboxPath, type NanoclawMailboxSession } from './modules/mailbox/index.js';
import { repoIngressFenceAckToken } from './modules/mailbox/ops/fence.js';
import { withExistingNanoclawOutbound } from './modules/mailbox/index.js';
import { withExistingMailboxSession, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';
import fs from 'fs';

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** True only when EVERY session satisfies the predicate. Sequential: the drain probe opens a session per call. */
async function everySession(sessions: Session[], predicate: (session: Session) => Promise<boolean>): Promise<boolean> {
  for (const session of sessions) if (!(await predicate(session))) return false;
  return true;
}

export interface RepositoryMountQuiescence {
  epoch: string;
  /** Containers stopped by this quiescence and eligible for a later wake. */
  sessions: Session[];
  /** Every session DB fenced against concurrent ingress until release. */
  barrierSessions: Session[];
  /** Exact activation token expected from each running session. */
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
 * Activation failed AND the rollback could not un-fence every session it had fenced. Typed so the caller's
 * recovery path (`barriersReleased: false`) receives the stranded set instead of an untyped AggregateError.
 */
class RepositoryMountBarrierRollbackError extends Error {
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
 * A session whose inbound DB was never created (or was reclaimed) has no ingress to fence: only a spawn could
 * create it, and spawns are rejected by the mount or lifecycle claim for the whole window. Opening it would
 * throw and fail the entire publication.
 */
function sessionInboundPath(session: Session): string {
  return sessionMailboxPath({ agentGroupId: session.agent_group_id, sessionId: session.id }, 'inbound');
}

function hasFenceableIngress(session: Session): boolean {
  return fs.existsSync(sessionInboundPath(session));
}

/**
 * An inbound DB that vanished between the eligibility filter and the open (e.g. a storage reclaim) is skipped,
 * not fatal. A session with a LIVE container must own a DB to poll, so its absence still fails closed.
 */
function vanishedSessionIsSkippable(err: unknown, session: Session): boolean {
  if (!(err instanceof SessionDbMissingError)) return false;
  return sessionVanishIsSkippable(session);
}

/** The mailbox-seam equivalent of `vanishedSessionIsSkippable`; a live container still fails closed. */
function sessionVanishIsSkippable(session: Session): boolean {
  return !sessionHasLiveContainer(session);
}

/**
 * Running as far as the host can tell: tracked, still spawning, or a pending survivor adoption has not claimed.
 * A pending survivor holds the mounts and must acknowledge the fence and drain before it is stopped.
 */
function sessionHasLiveContainer(session: Session): boolean {
  return isContainerRunning(session.id) || isContainerSpawning(session.id) || hasPendingAdoption(session.id);
}

const MAILBOX_GONE = Symbol('mailbox-gone');

/**
 * One fence operation, with the vanished case surfaced as a value. Existing-only on purpose: fencing a session the
 * reclaim already removed would recreate its directory (invariant I-4).
 */
async function inSessionMailbox<T>(
  session: Session,
  phase: string,
  action: (mailbox: NanoclawMailboxSession) => T,
): Promise<T | typeof MAILBOX_GONE> {
  let result: T | undefined;
  try {
    result = await withExistingMailboxSession(session.agent_group_id, session.id, action);
  } catch (err) {
    if (vanishedSessionIsSkippable(err, session)) return MAILBOX_GONE;
    throw barrierSessionError(err, session, phase);
  }
  if (result === undefined) {
    if (sessionVanishIsSkippable(session)) return MAILBOX_GONE;
    throw barrierSessionError(new SessionDbMissingError(sessionInboundPath(session)), session, phase);
  }
  return result;
}

/** Every barrier failure names its session and DB path, so one log line diagnoses it. */
function barrierSessionError(err: unknown, session: Session, phase: string): Error {
  return new Error(
    `repository mount barrier ${phase} failed for session ${session.id} ` +
      `(${sessionInboundPath(session)}): ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

/**
 * Each fence commit costs ~9ms of synchronous fsync, so thousands of sessions would stall the host event loop for
 * a minute. Yielding is safe: the mount claim, not this loop, holds admission closed.
 */
async function yieldEventLoop(index: number): Promise<void> {
  if (index > 0 && index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
}

async function activateRepositoryMountBarriers(
  sessions: Session[],
  epoch: string,
): Promise<{ fenced: Session[]; barrierAcks: Record<string, string>; barrierGenerations: Record<string, string> }> {
  const activated: Session[] = [];
  // Only the sessions actually fenced, so barrierSessions/Acks/Generations stay one set: a skipped session reaching
  // release would fail on its missing generation.
  const fenced: Session[] = [];
  const barrierAcks: Record<string, string> = {};
  const barrierGenerations: Record<string, string> = {};
  try {
    for (const [index, session] of sessions.entries()) {
      await yieldEventLoop(index);
      const outcome = await inSessionMailbox(session, 'activation', (mailbox) => {
        const prior = mailbox.readRepoIngressFence();
        const active = mailbox.activateRepoIngressFence(epoch);
        return {
          active,
          // A replay may adopt a crash-left active barrier with this exact epoch; it did not create it and must
          // never roll it back.
          created: prior?.state !== 'active' || prior.epoch !== epoch,
        };
      });
      if (outcome === MAILBOX_GONE) {
        log.warn('Repository mount barrier skipped: session inbound DB vanished after eligibility check', {
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
        });
        continue;
      }
      fenced.push(session);
      barrierAcks[session.id] = repoIngressFenceAckToken(outcome.active);
      barrierGenerations[session.id] = outcome.active.generation;
      if (outcome.created) activated.push(session);
    }
  } catch (error) {
    // No topology mutation yet: restore every DB this attempt fenced so a failure strands no inbound work.
    const releaseErrors: unknown[] = [];
    const stranded: Session[] = [];
    for (const session of activated.reverse()) {
      try {
        const generation = barrierGenerations[session.id];
        if (!generation) {
          throw new Error(`repository mount barrier generation missing for session ${session.id}`, { cause: error });
        }
        // A reclaimed session has no fence row left to restore; skipping reaches the released end state.
        const rolledBack = await inSessionMailbox(session, 'activation rollback', (mailbox) =>
          mailbox.releaseRepoIngressFence(epoch, generation),
        );
        if (rolledBack === MAILBOX_GONE) {
          log.warn('Repository mount barrier rollback skipped: session inbound DB vanished', {
            sessionId: session.id,
            agentGroupId: session.agent_group_id,
          });
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
  return { fenced, barrierAcks, barrierGenerations };
}

async function sessionReachedRepositoryBarrier(session: Session, expectedAck: string): Promise<boolean> {
  if (!sessionHasLiveContainer(session)) return true;
  try {
    // Outbound-keyed: all three reads are outbound-owned. An inbound-keyed funnel would never report drained for a
    // session whose inbound.db was reclaimed mid-transition, burn the barrier timeout, and kill every container.
    const drained = await withExistingNanoclawOutbound(
      session.agent_group_id,
      session.id,
      (outbound) =>
        // The exact activation token: a stale generation from an earlier barrier must not read as drained.
        outbound.readRepositoryMountBarrierAck() === expectedAck &&
        outbound.getProcessingClaimRows().length === 0 &&
        !outbound.getContainerState()?.current_tool,
    );
    // No outbound.db for a session the host believes is running: unknown ack or work state is never safe to stop.
    return drained ?? false;
  } catch {
    return false;
  }
}

/**
 * Release the exact durable ingress epoch after the mount transition and its on-wake confirmation are committed.
 * Idempotent for an already-released matching epoch; any different or missing state fails closed.
 */
export async function releaseRepositoryMountQuiescence(quiescence: RepositoryMountQuiescence): Promise<Session[]> {
  const wakeRequired: Session[] = [];
  for (const [index, session] of quiescence.barrierSessions.entries()) {
    await yieldEventLoop(index);
    const generation = quiescence.barrierGenerations[session.id];
    if (!generation) throw new Error(`repository mount barrier generation missing for session ${session.id}`);
    // A reclaimed session has no fence row to release and no due rows to wake for; dropping it strands nothing.
    const outcome = await inSessionMailbox(session, 'release', (mailbox) => {
      const result = mailbox.releaseRepoIngressFence(quiescence.epoch, generation);
      if (!result.released) {
        const current = mailbox.readRepoIngressFence();
        if (
          !current ||
          current.epoch !== quiescence.epoch ||
          current.generation !== generation ||
          current.state !== 'released'
        ) {
          throw new Error(`repository mount barrier state changed for session ${session.id}`);
        }
      }
      // Recomputed from durable state even on replay, closing the crash-after-release-before-wake boundary.
      return { wake: mailbox.countDueMessages() > 0 };
    });
    if (outcome === MAILBOX_GONE) {
      log.warn('Repository mount barrier release skipped: session inbound DB vanished', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
      });
      continue;
    }
    if (outcome.wake) wakeRequired.push(session);
  }
  return wakeRequired;
}

/**
 * Called while a workgroup-wide repository mount claim blocks new spawns: catches spawns already past the claim
 * check, stops every affected running container, and returns the sessions to wake after release.
 */
export async function quiesceAgentGroupsForRepositoryMounts(
  agentGroupIds: string[],
  epoch: string = `repository-mount-${randomUUID()}`,
): Promise<RepositoryMountQuiescence> {
  const sessions = (await Promise.all(agentGroupIds.map((id) => getSessionsByAgentGroup(id)))).flat();
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
  // Runtime process maps are authoritative: a stale inactive row can still own a live RW mount, so the stop set is
  // derived before the fenceable filter. A pending adoption is stopped like any running container.
  const affected = known.filter(
    (session) => isContainerRunning(session.id) || isContainerSpawning(session.id) || hasPendingAdoption(session.id),
  );
  const barrierSessions = known.filter(hasFenceableIngress);
  // A live container without a fenceable DB is an inconsistent host view; waiting would burn the full barrier
  // timeout for an ack that can never be written.
  const unfenceable = affected.filter((session) => !hasFenceableIngress(session));
  if (unfenceable.length > 0) {
    throw new Error(
      `running session(s) have no inbound database to fence: ${unfenceable.map((session) => session.id).join(', ')}`,
    );
  }
  let fenced: Session[];
  let barrierAcks: Record<string, string>;
  let barrierGenerations: Record<string, string>;
  try {
    ({ fenced, barrierAcks, barrierGenerations } = await activateRepositoryMountBarriers(barrierSessions, epoch));
  } catch (error) {
    // Re-shape a partial rollback into RepositoryMountQuiescenceError with the stranded set and
    // `barriersReleased: false`, so the publish/transfer callers retry the release. Vanished sessions hold no fence.
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
  const quiescence = { epoch, sessions: affected, barrierSessions: fenced, barrierAcks, barrierGenerations };
  try {
    await waitUntil(
      () => affected.every((session) => !isContainerSpawning(session.id)),
      'timed out waiting for in-progress container spawns before repository mount reconciliation',
      timeoutMs,
    );
    await waitUntil(
      () => everySession(affected, (session) => sessionReachedRepositoryBarrier(session, barrierAcks[session.id]!)),
      'timed out waiting for container poll admission and active repository work to drain',
      timeoutMs,
    );
    for (const session of affected) {
      if (isContainerRunning(session.id) || hasPendingAdoption(session.id)) {
        killContainer(session.id, 'repository mount set changed');
      }
    }
    await waitUntil(
      () => affected.every((session) => !isContainerRunning(session.id) && !hasPendingAdoption(session.id)),
      'timed out stopping containers for repository mount reconciliation',
      timeoutMs,
    );
    return quiescence;
  } catch (error) {
    // Every container that observed the barrier has ended its SDK input stream for good; leaving one alive shows
    // up as cancelled tool calls misread as revoked permissions. Kill failures never mask `error` or skip release.
    for (const session of affected) {
      try {
        if (isContainerRunning(session.id) || hasPendingAdoption(session.id)) {
          killContainer(session.id, 'repository mount quiescence failed');
        }
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

/**
 * One boot quiescence pass: the counts plus the partition later series consume. Adoption takes the survivors by
 * session id, and the host-restart warn skips exactly those sessions.
 */
export interface BootQuiescenceScope {
  workgroups: number;
  /**
   * The changed set the partition was computed against (the post-stop re-evaluation when supplied). The caller
   * reconciles exactly these, so scope and cutover cannot disagree.
   */
  changedWorkgroupIds: string[];
  containers: number;
  stopped: number;
  /** Containers with workgroup and session labels outside the changed set, left running for adoption. */
  survivable: number;
  /** Containers carrying no workgroup label: unknown scope, always stopped. */
  unlabeled: number;
  /** Length equals `survivable`. */
  survivableSessionIds: string[];
  /** Sessions that must be stopped; an unlabeled container is stopped by name and contributes no id. */
  mustStopSessionIds: string[];
}

/** `list`/`stop` default to real docker; tests inject fakes. */
export interface BootQuiescenceOptions {
  /**
   * Every workgroup id in the central DB: the `workgroups` count, and whether a container's label still names
   * something (a deleted group's survivor has nothing to reconcile or adopt). Omitted, every label looks unknown
   * (fail closed).
   */
  knownWorkgroupIds?: string[];
  /**
   * Every active session id in the central DB. Omitted, NOTHING is survivable: a caller that cannot say which
   * sessions exist cannot license any container to outlive the boot.
   */
  knownSessionIds?: string[];
  /**
   * Re-evaluate the change predicates once the install is quiescent: the passed-in set was snapshotted while
   * containers could still write the group dirs. Its answer builds the partition and the returned scope.
   */
  reevaluateChanged?: () => string[] | Promise<string[]>;
  /**
   * Runs before each stop pass with its partition. Pass 1 (pre-stop) writes the host-restart note for every
   * session the previous host marked running except survivors. Pass 2 runs only when the post-stop re-evaluation
   * moved sessions into must-stop, and then carries exactly those.
   */
  beforeStop?: (partition: {
    pass: 1 | 2;
    survivableSessionIds: string[];
    mustStopSessionIds: string[];
  }) => Promise<void> | void;
  list?: () => InstallContainerScope[];
  stop?: (name: string) => void;
}

/**
 * Split an inventory into must-stop and survivable. Survivable requires a workgroup label, a session label, a
 * workgroup still in the central DB, an active session, and a workgroup outside the changed set; everything else
 * fails closed into must-stop. Called twice by the door: pre-stop to choose the stop set, post-stop for the
 * partition handed to adoption.
 */
function partitionInstallContainers(
  containers: InstallContainerScope[],
  changedWorkgroupIds: string[],
  knownWorkgroupIds: Set<string>,
  knownSessionIds: Set<string>,
): { survivable: InstallContainerScope[]; mustStop: InstallContainerScope[] } {
  const changed = new Set(changedWorkgroupIds);
  const survivable = containers.filter(
    (entry) =>
      entry.workgroupId !== null &&
      entry.sessionId !== null &&
      knownWorkgroupIds.has(entry.workgroupId) &&
      knownSessionIds.has(entry.sessionId) &&
      !changed.has(entry.workgroupId),
  );
  const survivableNames = new Set(survivable.map((entry) => entry.name));
  return { survivable, mustStop: containers.filter((entry) => !survivableNames.has(entry.name)) };
}

/**
 * The BOOT quiescence door: stops the containers a startup reconcile is about to invalidate and proves them gone
 * before the caller mutates anything. The stop set comes from runtime labels, since the in-process registry is
 * empty at boot (src/workgroup-reconcile-doors-ratchet.test.ts pins both doors). Only must-stop containers are stopped.
 * Two partitions, because live agents can flip a workgroup while stops are in flight: pre-stop against the
 * snapshot (stop set, note skip set), then post-stop over a fresh inventory against the re-evaluated set, with a
 * second stop pass. A final inventory must show nothing in must-stop or boot fails; its survivors are the adoption
 * contract. A listing failure or a stop that does not take throws.
 */
export async function quiesceWorkgroupsForBootMountChange(
  changedWorkgroupIds: string[],
  options: BootQuiescenceOptions = {},
): Promise<BootQuiescenceScope> {
  const list = options.list ?? listInstallContainersWithScope;
  const stop = options.stop ?? stopContainer;
  const known = new Set(options.knownWorkgroupIds ?? changedWorkgroupIds);
  const knownSessions = new Set(options.knownSessionIds ?? []);

  const containers = list();
  const unlabeled = containers.filter((entry) => entry.workgroupId === null);

  // Partition 1: chooses the stop set and the accountability note's skip set.
  const preStop = partitionInstallContainers(containers, changedWorkgroupIds, known, knownSessions);
  await options.beforeStop?.({
    pass: 1,
    survivableSessionIds: preStop.survivable.map((entry) => entry.sessionId as string),
    mustStopSessionIds: sessionIdsOf(preStop.mustStop),
  });

  const stoppedNames = new Set<string>();
  const mustStopNames = new Set<string>();
  const stopAll = (entries: InstallContainerScope[]): void => {
    for (const entry of entries) {
      mustStopNames.add(entry.name);
      try {
        stop(entry.name);
      } catch (err) {
        throw new Error(`Cannot prove install-scoped container absence: failed to stop ${entry.name}`, { cause: err });
      }
      stoppedNames.add(entry.name);
    }
  };
  stopAll(preStop.mustStop);

  // Re-evaluated once nothing in a changed workgroup can write its group dir (the stale snapshot would call a flipped
  // workgroup survivable). Survivors keep running, so a flip after this is reconciled at the next boot, not this one.
  const finalChanged = (await options.reevaluateChanged?.()) ?? changedWorkgroupIds;

  // A SECOND inventory, taken after the re-evaluation is awaited, classified by each container's own labels: a
  // newcomer arriving during the await would otherwise go unrecorded and be reconciled under a live container.
  const afterFirstPass = partitionInstallContainers(list(), finalChanged, known, knownSessions);
  if (afterFirstPass.mustStop.length > 0) {
    log.info('Boot quiescence second pass', {
      flipped: finalChanged.filter((id) => !changedWorkgroupIds.includes(id)),
      containers: afterFirstPass.mustStop.map((entry) => entry.name),
    });
  }
  // Sessions the first note skipped and this pass will interrupt get their note now, before the stop.
  const alreadyMustStop = new Set(sessionIdsOf(preStop.mustStop));
  const reclassified = sessionIdsOf(afterFirstPass.mustStop).filter((id) => !alreadyMustStop.has(id));
  if (reclassified.length > 0) {
    await options.beforeStop?.({
      pass: 2,
      survivableSessionIds: afterFirstPass.survivable.map((entry) => entry.sessionId as string),
      mustStopSessionIds: reclassified,
    });
  }
  stopAll(afterFirstPass.mustStop);
  // The door's last word is always a listing: a must-stop container still present cannot be proven absent.
  const afterSecondPass = partitionInstallContainers(list(), finalChanged, known, knownSessions);
  if (afterSecondPass.mustStop.length > 0) {
    throw new Error(
      `Install-scoped containers still running after boot quiescence: ${afterSecondPass.mustStop.map((e) => e.name).join(', ')}`,
    );
  }
  const survivors = afterSecondPass.survivable;

  const scope: BootQuiescenceScope = {
    workgroups: known.size,
    changedWorkgroupIds: finalChanged,
    containers: containers.length,
    stopped: stoppedNames.size,
    survivable: survivors.length,
    unlabeled: unlabeled.length,
    survivableSessionIds: survivors.map((entry) => entry.sessionId as string),
    mustStopSessionIds: [...new Set(sessionIdsOf([...preStop.mustStop, ...afterFirstPass.mustStop]))],
  };
  // Session-id arrays stay out of the line: a large fleet would bury the counts.
  log.info('Boot quiescence scope', {
    workgroups: scope.workgroups,
    changed: finalChanged.length,
    containers: scope.containers,
    stopped: scope.stopped,
    survivable: scope.survivable,
    unlabeled: scope.unlabeled,
    mustStop: mustStopNames.size,
  });
  return scope;
}

function sessionIdsOf(entries: InstallContainerScope[]): string[] {
  return entries.map((entry) => entry.sessionId).filter((sessionId): sessionId is string => sessionId !== null);
}

export function wakeRepositoryMountSessions(sessions: Session[]): void {
  for (const session of sessions) {
    void requestWake(session, 'container-restart').catch((err) =>
      log.warn('Failed to wake session after repository mount quiescence', { sessionId: session.id, err }),
    );
  }
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
  // A pending survivor runs the old image too; it is stopped through `killContainer`, which routes it.
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) => s.status === 'active' && (isContainerRunning(s.id) || hasPendingAdoption(s.id)),
  );

  let restarted = 0;
  let failed = 0;
  for (const session of sessions) {
    // A pending survivor has no container name yet: resolve it from the runtime before writing the wake row. Gone
    // means nothing to restart; unknown means this restart cannot be performed.
    if (hasPendingAdoption(session.id)) {
      const resolved = await resolvePendingSurvivor(session.id);
      if (resolved === 'gone') continue;
      if (resolved === 'unknown') {
        failed += 1;
        log.warn('Restart: could not resolve a pending survivor; leaving it running', {
          agentGroupId,
          sessionId: session.id,
        });
        continue;
      }
    }
    // WRITE FIRST: `on_wake` rows are visible only on a container's first poll, so the row must exist before any
    // fresh container looks. Paths that decline to restart compensate via `withdrawWake` rather than reorder.
    // Awaited, and a failure costs this session only, so the loop never half-restarts the group.
    const wakeId = wakeMessage ? `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;
    if (wakeMessage && wakeId) {
      try {
        await writeSessionMessage(agentGroupId, session.id, {
          id: wakeId,
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

    // Withdraw the wake when the announced restart does not happen. Best-effort. The ownership probe is a thunk
    // the op invokes right before its delete, so a container that came up meanwhile is still seen.
    const withdrawWake = async (): Promise<void> => {
      if (!wakeId) return;
      try {
        const withdrawn = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          mailbox.withdrawUnconsumedWake(wakeId, () => containerOwnsOutbound(session.id)),
        );
        if (withdrawn)
          log.info('Restart: withdrew the wake message for a container it did not restart', {
            agentGroupId,
            sessionId: session.id,
          });
      } catch (err) {
        log.warn('Restart: could not withdraw the wake message', { agentGroupId, sessionId: session.id, err });
      }
    };

    // The container can exit during the awaited write, and killContainer no-ops on it: do not count a restart.
    if (!isContainerRunning(session.id) && !hasPendingAdoption(session.id)) {
      await withdrawWake();
      continue;
    }
    // Identity of the container about to be killed: during the async read below a replacement can start, and
    // killing it would silently strand its claimed input. The name identifies the process (a spawn mints a new one;
    // an adopted survivor keeps its own), unlike `getContainerSpawnedAt`.
    const identity = getContainerIdentity(session.id);

    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    // This open can throw under a reclaim claim: cost this session, not the loop.
    let hasPending: boolean;
    try {
      // Existing-only (the provisioning variant would resurrect a reclaimed session). No mailbox for a running
      // container is an inconsistent view: leave it alone rather than read it as "nothing pending".
      const due = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.countDueMessages(),
      );
      if (due === undefined) throw new Error(`session ${session.id} has no mailbox to read pending work from`);
      hasPending = due > 0;
    } catch (err) {
      failed += 1;
      log.warn('Restart: could not read pending work; leaving this container running', {
        agentGroupId,
        sessionId: session.id,
        err,
      });
      await withdrawWake();
      continue;
    }
    // Re-check identity, not liveness: a replacement is doing the work this restart wanted; the withdrawal stops
    // the wake row outliving this restart if the replacement polled before it landed.
    if (getContainerIdentity(session.id) !== identity) {
      log.info('Restart: container was replaced while reading pending work; leaving the replacement alone', {
        agentGroupId,
        sessionId: session.id,
      });
      await withdrawWake();
      continue;
    }
    killContainer(
      session.id,
      reason,
      wakeMessage || hasPending || options.respawnAll
        ? () => {
            // The liveness proof rides with the wake: `wakeContainer` awaits admission and spawn preparation.
            void requestWake(session, 'container-restart', {
              priority: 'interactive',
              guard: sessionStillActive(session.id),
            });
          }
        : undefined,
      // Only the branch that brings the session back may promise a post-crash respawn.
      wakeMessage || hasPending || options.respawnAll ? 'respawn_after_stop' : 'stop',
    );
    restarted += 1;
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: restarted, failed });
  }
  return restarted;
}
