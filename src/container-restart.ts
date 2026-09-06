/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import {
  containerOwnsOutbound,
  getContainerSpawnedAt,
  hasPendingAdoption,
  isContainerRunning,
  isContainerSpawning,
  killContainer,
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

/** True only when EVERY session satisfies an async predicate. Sequential by design: the drain probe opens a session per call. */
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
function sessionInboundPath(session: Session): string {
  return sessionMailboxPath({ agentGroupId: session.agent_group_id, sessionId: session.id }, 'inbound');
}

function hasFenceableIngress(session: Session): boolean {
  return fs.existsSync(sessionInboundPath(session));
}

/**
 * A session whose inbound DB vanished BETWEEN the eligibility filter and the
 * open below carries exactly the invariant `hasFenceableIngress` documents:
 * there is no ingress path left to fence, and no spawn can create one while
 * the workgroup mount claim is held. It is skipped rather than fatal — the
 * 2026-09-01 incident was a storage reclaim landing inside precisely this
 * window, which failed an unrelated publication permanently.
 *
 * A session with a LIVE container is the one exception: it must own a DB to
 * poll, so its absence is an inconsistent host view and still fails closed.
 */
function vanishedSessionIsSkippable(err: unknown, session: Session): boolean {
  if (!(err instanceof SessionDbMissingError)) return false;
  return sessionVanishIsSkippable(session);
}

/**
 * A session whose mailbox `withExistingMailboxSession` reports as absent is the
 * same case `vanishedSessionIsSkippable` decides for a thrown
 * `SessionDbMissingError` — the seam resolves `undefined` where the raw opener
 * threw. A LIVE container is still the exception: it must own a mailbox to
 * poll, so its absence is an inconsistent host view and fails closed.
 */
function sessionVanishIsSkippable(session: Session): boolean {
  return !sessionHasLiveContainer(session);
}

/**
 * Is a container running for this session as far as the host can tell —
 * tracked, still spawning, or a pending survivor adoption could not yet claim
 * (seam 4 E/D2, #462)? The barrier predicates ask this rather than the
 * registry alone: a pending survivor is live, holds the mounts, and must
 * acknowledge the fence and drain its work before it is stopped.
 */
function sessionHasLiveContainer(session: Session): boolean {
  return isContainerRunning(session.id) || isContainerSpawning(session.id) || hasPendingAdoption(session.id);
}

/** Sentinel for "the mailbox is gone", distinct from any value an action returns. */
const MAILBOX_GONE = Symbol('mailbox-gone');

/**
 * One fence operation against a session, with the vanished case surfaced as a
 * value rather than an exception.
 *
 * `withExistingMailboxSession` is deliberate here rather than the provisioning
 * variant: fencing a session the storage reclaim has already removed would
 * recreate its directory (invariant I-4), and the 2026-09-01 incident was
 * exactly a reclaim landing inside this window.
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
): Promise<{ fenced: Session[]; barrierAcks: Record<string, string>; barrierGenerations: Record<string, string> }> {
  const activated: Session[] = [];
  // The sessions this pass actually fenced. Returned so the quiescence's
  // barrierSessions, barrierAcks and barrierGenerations stay one consistent
  // set — a session skipped here must never reach release, which would then
  // fail on its missing generation.
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
          // A replay may be adopting a crash-left active barrier with this
          // exact deterministic epoch. It did not create that barrier and
          // therefore must never roll it back if a later session activation
          // fails.
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
    // No topology mutation has happened yet. Restore every DB fenced by this
    // attempt so an activation failure cannot strand unrelated inbound work.
    const releaseErrors: unknown[] = [];
    const stranded: Session[] = [];
    for (const session of activated.reverse()) {
      try {
        const generation = barrierGenerations[session.id];
        if (!generation) {
          throw new Error(`repository mount barrier generation missing for session ${session.id}`, { cause: error });
        }
        // A session reclaimed since we fenced it has no fence row left to
        // restore — the whole mailbox is gone. Skipping reaches the same end
        // state a successful release would.
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
    // OUTBOUND-keyed: all three reads are outbound-owned and nothing here
    // touches inbound.db, so outbound.db's existence is the question to ask.
    // The inbound-keyed funnel added a gate the pre-seam probe never had — it
    // opened outbound.db alone — and a session whose inbound.db is reclaimed
    // mid-transition could then never report drained, burning the full barrier
    // timeout and turning a survivable transition into a quiescence failure
    // that kills every affected container.
    const drained = await withExistingNanoclawOutbound(
      session.agent_group_id,
      session.id,
      (outbound) =>
        // The EXACT activation token, never merely "some ack": a stale
        // generation from a previous barrier on this session would otherwise
        // read as drained.
        outbound.readRepositoryMountBarrierAck() === expectedAck &&
        outbound.getProcessingClaimRows().length === 0 &&
        !outbound.getContainerState()?.current_tool,
    );
    // undefined = no outbound.db at all for a session the host believes is
    // running. Unknown acknowledgement or work state is never safe to stop,
    // and neither is a present-but-unreadable file, which raises into the
    // catch below.
    return drained ?? false;
  } catch {
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
    const generation = quiescence.barrierGenerations[session.id];
    if (!generation) throw new Error(`repository mount barrier generation missing for session ${session.id}`);
    // Consistent for the maps too: barrierAcks/barrierGenerations are keyed
    // by session id and only ever read for a session this loop reaches, so
    // dropping one strands nothing — and a reclaimed session has no fence row
    // left to release and no due rows left to wake for.
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
      // Recompute from durable state even on an idempotent replay. This closes
      // the crash-after-release-before-wake boundary for both rows tagged by
      // this epoch and ordinary due rows that predated the fence.
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
 * Called while a workgroup-wide repository mount claim blocks new spawns.
 * It catches spawns already past the claim check, then stops every affected
 * running container and returns the exact sessions to wake after claim release.
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
  // Runtime process maps are authoritative. A stale inactive DB row can still
  // own a live RW mount and must not escape quiescence — so the stop set is
  // derived before the fenceable filter, never from it. A pending adoption is
  // a survivor this host has not claimed but which is running and holds the
  // mounts all the same (seam 4 E/D2, #462 item 3): it is stopped here like
  // any running container, through `killContainer`, which routes it.
  const affected = known.filter(
    (session) => isContainerRunning(session.id) || isContainerSpawning(session.id) || hasPendingAdoption(session.id),
  );
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
  // #223 returns `fenced` — the subset this pass actually fenced, after
  // skipping sessions whose inbound DB vanished — so barrierSessions,
  // barrierAcks and barrierGenerations stay one consistent set.
  let fenced: Session[];
  let barrierAcks: Record<string, string>;
  let barrierGenerations: Record<string, string>;
  try {
    ({ fenced, barrierAcks, barrierGenerations } = await activateRepositoryMountBarriers(barrierSessions, epoch));
  } catch (error) {
    // A partial rollback leaves real fences behind, and the caller's only
    // recovery affordance is RepositoryMountQuiescenceError. Re-shape into it
    // with the stranded set as the barrier sessions and `barriersReleased:
    // false`, so `applyRepositoryPublishAction` / `applyRepositoryTransferAction`
    // retry the release instead of dropping them (incident 2026-09-01). A
    // session skipped as vanished is never in `strandedSessions` — it holds no
    // fence to release, so it is neither an error nor recovery work.
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
    // Every container that observed the barrier has permanently ended its SDK
    // query input stream, so it can never do useful work again. Leaving one
    // alive surfaces as cancelled tool calls the agent misreads as revoked
    // permissions. Kill failures are logged, never allowed to mask `error` or
    // skip the barrier release below.
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
 * One boot quiescence pass: the §6 `Boot quiescence scope` counts, plus the
 * partition the later series consume.
 *
 * The arrays are the consumer contract, not decoration. Seam-4 E adopts the
 * survivors by session id, and seam-4 G skips the host-restart warn for
 * exactly those sessions; both need the identity, not the count. D1 still
 * stops everything, so under D1 they are measurement — `survivableSessionIds`
 * is the milestone-1 counterfactual named session by session.
 */
export interface BootQuiescenceScope {
  /** Workgroups the predicates were asked about — the §6 denominator. */
  workgroups: number;
  /**
   * The changed set the partition below was computed against: the caller's
   * post-stop re-evaluation when it supplied one, otherwise the set passed in.
   * The caller reconciles exactly these workgroups, so the scope and the
   * cutover can never disagree about which workgroups changed.
   */
  changedWorkgroupIds: string[];
  /** Install-labeled containers the runtime reported. */
  containers: number;
  /** Containers this pass actually stopped. */
  stopped: number;
  /**
   * Containers that carry a workgroup AND a session label, whose workgroup is
   * outside the changed set — the ones the door LEFT RUNNING for adoption
   * (seam 4 D2). Counted from the post-stop inventory against the post-stop
   * re-evaluation, so it is exactly what adoption can find.
   */
  survivable: number;
  /** Containers carrying no workgroup label: unknown scope, always stopped. */
  unlabeled: number;
  /** Session ids of the survivable containers. Length equals `survivable`. */
  survivableSessionIds: string[];
  /**
   * Session ids of the containers that must be stopped whatever D2 does.
   *
   * A container with no session label is in the must-stop partition but
   * contributes no id here — it is stopped by name, and there is no session to
   * hand to adoption. That is the fail-closed direction: an unidentifiable
   * container is never survivable.
   */
  mustStopSessionIds: string[];
}

/**
 * The boot door's second argument: the measurement context plus the runtime
 * seam. `list`/`stop` default to real docker; tests inject fakes.
 */
export interface BootQuiescenceOptions {
  /**
   * Every workgroup id the central DB currently holds.
   *
   * Two uses, one source of truth. Its length is the `workgroups` field of the
   * §6 `Boot quiescence scope` line — the denominator `changed` is read
   * against. Its membership decides whether a container's workgroup label
   * still names something: an approved `ncl groups delete` leaves the
   * container running, and a survivor whose workgroup is gone has no reconcile
   * to be scoped by and nothing for adoption to resolve. Unknown is stopped.
   *
   * Omitted, the door falls back to the changed set, which makes every
   * container's label look unknown — fail-closed, and only reachable from a
   * caller that forgot to pass it. The boot block always supplies it.
   */
  knownWorkgroupIds?: string[];
  /**
   * Every session id the central DB currently holds as active.
   *
   * Same rule as `knownWorkgroupIds`, one level down: a container whose
   * session label names a row that is gone or archived has nothing for
   * adoption to resolve, so leaving it running under D2 would leak it.
   *
   * Omitted, NOTHING is survivable. That is deliberately harsher than the
   * workgroup fallback: a caller that cannot say which sessions exist cannot
   * license any container to outlive the boot. The boot block always supplies
   * it (src/main.ts).
   */
  knownSessionIds?: string[];
  /**
   * Re-evaluate the change predicates once the install is proved quiescent.
   *
   * The set passed as `changedWorkgroupIds` is a snapshot taken while
   * containers were still running, and the group directories it was computed
   * from are container-writable. This callback runs after the stop proof,
   * when nothing can write to them, and its answer is what the partition and
   * the returned scope are built from. Omitted, the passed-in set is used.
   */
  reevaluateChanged?: () => string[] | Promise<string[]>;
  /**
   * Runs before each stop pass with that pass's partition. Pass 1 is the
   * PRE-stop partition: the boot block writes the host-restart accountability
   * note here for every session marked running by the previous host EXCEPT
   * the survivors, whose containers are not being interrupted — before the
   * stop pass, which can outlast the heartbeat freshness window (#441). Pass 2
   * runs only when the post-stop re-evaluation moved sessions INTO must-stop
   * (a flipped workgroup, a newcomer): `mustStopSessionIds` is then exactly
   * those newly reclassified sessions, which the first note skipped and which
   * are about to be interrupted after all.
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
 * Split an inventory into the containers that must be stopped and the ones a
 * narrowed stop set could leave running.
 *
 * A container is survivable only if it is IDENTIFIED, KNOWN and UNCHANGED:
 *
 *   - a workgroup label — a missing one is unknown scope (plan §3.5,
 *     divergence 7), and on the first restart after C that is every container;
 *   - a session label — a container adoption could never claim, so leaving it
 *     running under D2 would leak it;
 *   - a workgroup that still exists in the central DB — an approved
 *     `ncl groups delete` leaves the container running, and its workgroup is
 *     in no reconcile scope and resolves to no row;
 *   - a session that still exists and is active — the same rule one level down;
 *   - a workgroup outside the changed set.
 *
 * Everything else fails closed into must-stop, and the split is exact: every
 * container is on one side or the other.
 *
 * ONE function, called twice by the door (seam 4 D2): once with the pre-stop
 * set to choose what to stop, and once over the post-stop inventory with the
 * post-stop set for the partition it hands adoption. A workgroup that flips
 * between the two is must-stop in the second pass, so the stop set is the
 * union.
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
 * The BOOT quiescence door (docs/specs/upstream-restart-survival-seam/plan.md
 * §4.2, §7.D). Stops the containers whose mounts a startup reconcile is about
 * to invalidate, and proves they are gone before the caller mutates anything.
 *
 * The stop set comes from the container runtime by label, not from
 * `activeContainers`: the in-process registry is empty at boot, so the runtime
 * door (`quiesceSessionsForRepositoryMounts`, above) cannot see a container
 * left by the previous host (plan §3.5, divergence 2). Two doors, two
 * authorities; both are pinned by src/workgroup-reconcile-doors.test.ts.
 *
 * A container with no workgroup label is unknown scope and is always stopped
 * (divergence 7) — on the first restart after the scope labels ship, that is
 * every container.
 *
 * D2 STOPS ONLY `mustStop` (plan §4.1, §7.D2): the containers of workgroups a
 * reconcile is about to change, plus everything not provably survivable — no
 * workgroup or session label, an unknown workgroup, a session that is gone or
 * cannot take a wake. Survivable containers are left running and reach
 * adoption (`adoptRunningSessions`) by session id, through the returned scope.
 *
 * Two partitions, because `changedWorkgroupIds` is a snapshot taken BEFORE
 * this door runs and the group directories it was computed from are
 * container-writable — a live agent can flip a workgroup from settled to
 * needs-reconcile while the stops are in flight:
 *
 *   1. PRE-stop, against the snapshot: chooses the stop set, and is handed to
 *      `beforeStop` so the accountability note skips exactly the sessions
 *      whose containers are not interrupted.
 *   2. POST-stop, over the second inventory against the re-evaluated set: a
 *      workgroup that flipped is must-stop NOW and is stopped in a second
 *      pass; so is a container that appeared between the listings and is not
 *      provably survivable. The third inventory must show nothing left in
 *      must-stop, or the boot fails — a container that will not stop is never
 *      argued away. The survivors of THAT partition are the adoption contract.
 *
 * Survivors keep running through the re-evaluation, so a workgroup can flip
 * after the second partition too; the reconcile is scoped to the re-evaluated
 * set and such a flip is reconciled at the next boot, exactly as under D1.
 *
 * Fail-closed like the call it replaces: a listing failure, or a stop that does
 * not take, throws — startup stops before any reconcile runs.
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

  // Partition 1: pre-stop, against the caller's snapshot. This chooses the
  // stop set and the accountability note's skip set.
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

  // The proof is over the SECOND inventory, by each container's OWN labels,
  // never over the names from the first: a container that appeared between
  // the two listings — another host, or a spawn racing the boot — is
  // classified like every other, and a must-stop one that is still here (a
  // stop that did not take, a newcomer in a changed workgroup) is stopped in
  // the second pass.
  //
  // Nothing here has to carry which containers it managed to stop: the
  // accountability note was written by `beforeStop` before the first stop,
  // so a failure at any point leaves it already written for every session
  // that was marked running (src/main.ts, `runBootMountQuiescence`).
  //
  // The reconcile set is re-evaluated NOW, after the first pass: nothing in a
  // changed workgroup can write to its group directory any more. The set that
  // came in was a snapshot taken while those containers were still running,
  // and a live agent's last write could have flipped a workgroup since.
  // Partition against the answer from here, not that snapshot — otherwise a
  // flipped workgroup's sessions read as survivable in the very scope that
  // says its mounts are about to move.
  const secondInventory = list();
  const finalChanged = (await options.reevaluateChanged?.()) ?? changedWorkgroupIds;
  const afterFirstPass = partitionInstallContainers(secondInventory, finalChanged, known, knownSessions);
  let survivors = afterFirstPass.survivable;
  if (afterFirstPass.mustStop.length > 0) {
    log.info('Boot quiescence second pass', {
      flipped: finalChanged.filter((id) => !changedWorkgroupIds.includes(id)),
      containers: afterFirstPass.mustStop.map((entry) => entry.name),
    });
    // Sessions the first note skipped as survivable and which this pass is
    // about to interrupt after all get their note now, before the stop.
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
    const afterSecondPass = partitionInstallContainers(list(), finalChanged, known, knownSessions);
    if (afterSecondPass.mustStop.length > 0) {
      throw new Error(
        `Install-scoped containers still running after boot quiescence: ${afterSecondPass.mustStop.map((e) => e.name).join(', ')}`,
      );
    }
    survivors = afterSecondPass.survivable;
  }

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
  // Plan §6's measurement shape, in its order. `changed` is the post-stop
  // count, the same set the caller reconciles. The session-id arrays stay out
  // of the line: they are the consumer contract for E and G, and a boot with a
  // large fleet would bury the counts an operator reads.
  log.info('Boot quiescence scope', {
    workgroups: scope.workgroups,
    changed: finalChanged.length,
    containers: scope.containers,
    stopped: scope.stopped,
    survivable: scope.survivable,
    unlabeled: scope.unlabeled,
    // Every container either pass classified must-stop; under D2 it equals `stopped`.
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
  // A pending survivor (adoption could not yet claim it, seam 4 E/D2) is
  // running the OLD image and configuration too; it is selected like a tracked
  // container and stopped through `killContainer`, which routes it (#462).
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) => s.status === 'active' && (isContainerRunning(s.id) || hasPendingAdoption(s.id)),
  );

  let restarted = 0;
  let failed = 0;
  for (const session of sessions) {
    // WRITE FIRST. `on_wake` rows are visible only on a container's FIRST poll
    // (`selection.ts` adds `AND on_wake = 0` to every later one), so the row
    // has to exist before any fresh container looks — writing it after the
    // checks instead means a replacement that completes its first poll during
    // the write never sees it, and the row then waits for an unrelated future
    // spawn. Deferring the write does not remove that failure, it relocates it.
    //
    // The paths below that decline to restart therefore COMPENSATE rather than
    // reorder: `withdrawWake` removes the row if, and only if, nothing has
    // consumed it. See `withdrawUnconsumedWake`.
    //
    // Awaited so the row is durable before `killContainer`, and a failure costs
    // this session only: before the await existed the write was
    // fire-and-forget and its rejection escaped as an unhandledRejection, so
    // the loop always finished; letting it throw here would kill the sessions
    // ahead of it and strand every one behind it, half-restarting the group.
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

    // Take back the promise when the restart it announced does not happen.
    // Existing-only and best-effort: a session whose mailbox is gone has no row
    // to withdraw, and failing to withdraw must not itself abort the loop — the
    // worst case is the stale notice this exists to prevent, logged.
    //
    // The ownership probe is passed as a thunk, not as a value: the op invokes
    // it immediately before its delete, so a container that came up while this
    // decline path was being taken is still seen. Reading it here instead would
    // reintroduce the stale precondition every other fix in this PR removes.
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

    // The container can exit during the awaited write above, and killContainer
    // no-ops on a session it no longer tracks — counting that as a restart
    // reports work that did not happen. A pending survivor is still a
    // container to restart; its exit clears the pending mark the same way.
    if (!isContainerRunning(session.id) && !hasPendingAdoption(session.id)) {
      await withdrawWake();
      continue;
    }
    // Generation token for the process we are about to kill. The pending read
    // below is async, so the snapshotted container can exit and an inbound wake
    // can install a REPLACEMENT before control returns — and killing that one
    // is both wrong and silent: if the read saw no due rows, no onExit is
    // installed, so the replacement's freshly claimed input goes dark until a
    // later recovery pass. `spawnedAt` changes on every spawn, so comparing it
    // across the await identifies the process rather than merely the session.
    const spawnGeneration = getContainerSpawnedAt(session.id);

    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    //
    // This open can throw, now that the inbound funnel refuses under a reclaim
    // claim — same rule as the write: cost this session, not the loop.
    let hasPending: boolean;
    try {
      // Read-only, so `withExistingMailboxSession` — never the provisioning
      // variant, which would resurrect a reclaimed session (invariant I-4).
      // `undefined` (no mailbox) is treated exactly like a read failure rather
      // than as "nothing pending": this session's container is RUNNING, so a
      // missing mailbox is an inconsistent host view, and the conservative
      // answer is to leave it alone.
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
    // Re-check the generation, not just liveness: a replacement is "running"
    // too. Leave it alone — it is doing the work this restart wanted done. If
    // that replacement's first poll already took the wake row, the withdrawal
    // is a no-op and it keeps it; if it polled before the row landed, the
    // withdrawal is what stops the row outliving this restart.
    if (getContainerSpawnedAt(session.id) !== spawnGeneration) {
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
            // The liveness proof rides WITH the wake instead of preceding it:
            // `wakeContainer` awaits admission, the memory queue and the whole
            // spawn preparation, and a `getSession` here proves nothing about
            // any of that.
            void requestWake(session, 'container-restart', {
              priority: 'interactive',
              guard: sessionStillActive(session.id),
            });
          }
        : undefined,
      // The durable half of the same decision. The branch above is the only
      // one that brings the session back, so it is the only one that may
      // promise a boot after this host dies that it still owes a respawn.
      wakeMessage || hasPending || options.respawnAll ? 'respawn_after_stop' : 'stop',
    );
    restarted += 1;
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: restarted, failed });
  }
  return restarted;
}
