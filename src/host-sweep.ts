/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Writes outbound.db only while the session container is confirmed stopped
 *     (continuation recovery counters / visible parked notice)
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { SELF_HEAL_ENABLED } from './config.js';
import { getActiveSessions, getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  SessionDbMissingError,
  readSessionOutbound,
  SessionDbUnopenableError,
  type ForkContainerStateRow as ContainerState,
  type NanoclawMailboxSession,
} from './modules/mailbox/index.js';
import { withExistingNanoclawSession } from './modules/mailbox/session.js';

import { runHostGatedTaskScripts } from './modules/scheduling/host-script.js';
import { advanceThreadClosures, syncDoneProposalMirror } from './dashboard/thread-close.js';
import { log } from './log.js';
import {
  sessionDir,
  sessionsBaseDir,
  admitDueTaskContexts,
  deferMessageForFreshContextRetry,
  withExistingMailboxSession,
} from './session-manager.js';
import {
  getContainerSpawnedAt,
  getActiveContainerSessionIds,
  isContainerRunning,
  containerOwnsOutbound,
  killContainer,
  sessionStillActive,
  wakeContainer,
} from './container-runner.js';
import type { Session } from './types.js';
import { getDb } from './db/connection.js';

/**
 * Session-DB timestamp parsing now lives with the mailbox module that owns
 * those columns; re-exported here so existing importers are unchanged.
 */
export { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';
import { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';

export const SWEEP_INTERVAL_MS = 60_000;

// Quiet-session cache — see the sweep loop. A fully-quiet session is skipped
// for at most this long (or until its next scheduled row is due, if sooner).
const QUIET_SESSION_BACKOFF_MS = 30 * 60_000;
interface QuietMark {
  skipUntilMs: number;
  lastActive: string | null;
}
const quietSessions = new Map<string, QuietMark>();
let lastSkippedQuiet = 0;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Grace window after a fresh spawn during which the SLA enforcer ignores
// pre-existing claims (claims made before this container started). Lets
// the new container's startup hook in agent-runner clean its own orphan
// processing_ack rows. Without this, a session whose previous container
// crashed mid-task gets stuck in a wake → kill loop forever — the new
// container is killed within ms of spawn for a 4-day-old claim it hadn't
// had a chance to clear.
export const SPAWN_GRACE_MS = 60 * 1000;
// Pending inbound rows older than this get marked 'expired' by the sweep so
// they stop waking sessions forever. Reason: containers that crashed mid-spawn
// or hit a contract bug leave un-acked rows that the sweep treats as "due"
// every tick, which fills the concurrency cap with squatters. Recurring tasks
// whose next fire is in the future are protected via process_after.
// Tunable via PENDING_MESSAGE_MAX_AGE_HOURS (default 24).
const parsedMaxAgeHours = Number(process.env.PENDING_MESSAGE_MAX_AGE_HOURS);
export const PENDING_MESSAGE_MAX_AGE_MS =
  (Number.isFinite(parsedMaxAgeHours) && parsedMaxAgeHours > 0 ? parsedMaxAgeHours : 24) * 60 * 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Sweep duty registry (convergence seam 2, PR 2)
//
// The tick used to be a prose list of statements. It is now a driver over this
// registry: a duty declares WHICH window it runs in (`phase`) and WHERE in that
// window (`order`), and the driver opens each window once and hands the
// already-open mailbox session to every duty in it. That is the perf invariant
// — one `getActiveSessions()` per tick, one mailbox open per duty-group per
// window — expressed as data instead of as the order of statements in one
// function. docs/specs/upstream-host-sweep-seam/plan.md §4.3-§4.5.
//
// PR 2 is behavior-preserving: the same duty bodies run in the same windows
// with the same guards, the same cadences and the same two error strings. What
// is new is structure — both error lines now carry `duty` and `window`, and a
// family PR can move a body into `src/modules/sweep-<family>/` by moving its
// registration, without touching the driver.
// ─────────────────────────────────────────────────────────────────────────────

export type SweepPhase =
  /** Before the fan-out; `ctx.sessions` is not loaded yet. */
  | 'tick:pre-session'
  /** W1 — inside one plan session. */
  | 'session:plan'
  /** W2 — NOTHING open; the wake and its attempt bookkeeping. */
  | 'session:wake'
  /** W4 — EXCLUSIVE chain; nothing open; duties open their own windows. */
  | 'session:health'
  /** W5 — inside one tail session. */
  | 'session:tail'
  /** After the fan-out; container state is current. */
  | 'tick:post-session'
  /** Order-free central work. */
  | 'tick:housekeeping';

export const SWEEP_PHASES: readonly SweepPhase[] = [
  'tick:pre-session',
  'session:plan',
  'session:wake',
  'session:health',
  'session:tail',
  'tick:post-session',
  'tick:housekeeping',
];

/**
 * 'all' runs every duty in the phase in ascending `order`. 'exclusive' is an
 * if/else-if chain: the first duty whose `claims()` predicate holds runs and
 * the rest do NOT — `session:health`'s shape, where registering the SLA before
 * the reaps would reclassify an idle container past the ceiling from
 * `scheduled-task-idle` to `absolute-ceiling`.
 */
export type PhaseKind = 'all' | 'exclusive';

const SWEEP_PHASE_KINDS: Readonly<Record<SweepPhase, PhaseKind>> = {
  'tick:pre-session': 'all',
  'session:plan': 'all',
  'session:wake': 'all',
  'session:health': 'exclusive',
  'session:tail': 'all',
  'tick:post-session': 'all',
  'tick:housekeeping': 'all',
};

export function sweepPhaseKind(phase: SweepPhase): PhaseKind {
  return SWEEP_PHASE_KINDS[phase];
}

/**
 * The opening boundary a duty (or an opener) ran at — the `window` field on
 * both sweep error lines. Every phase is a window; three more exist inside
 * windows a duty owns rather than the driver: the driver's own observe read,
 * and the two sessions the running-container SLA opens around its kill.
 */
export type SweepWindow = SweepPhase | 'session:observe' | 'session:health:sla-observe' | 'session:health:post-kill';

/** The plan `session:plan` builds and every later phase reads. */
export interface WakePlan {
  dueCount: number;
  wakePriority: 'interactive' | 'scheduled';
  admittedTasks: number;
  workContinuation: HostWorkContinuation | null;
  continuationWakeEligible: boolean;
  /** False for a never-woken session that has only ever had an inbound.db. */
  hasOutbound: boolean;
}

/** The driver's W3 read, consulted by the `session:health` predicates. */
export interface ContainerObservation {
  containerState: ContainerState | null;
  processingClaimCount: number;
  lastOutboundAtMs: number | null;
  lastInboundAtMs: number | null;
}

/**
 * What the SLA duty snapshotted INSIDE its observe session, before the kill.
 * `resetStuckProcessingRows` clears the claims, so a post-kill read would
 * always come back empty — constraint 12's "snapshotted before the kill".
 */
export interface SweepKillSnapshot {
  reason: string;
  containerState: ContainerState | null;
  pendingClaims: number;
  workContinuation: HostWorkContinuation | null;
}

export interface SweepTickContext {
  readonly now: number;
  /** The ONE getActiveSessions() call per tick. Not readable in tick:pre-session. */
  readonly sessions: readonly Session[];
  readonly activeContainerSessionIds: ReadonlySet<string>;
}

export interface SweepSessionContext extends SweepTickContext {
  readonly session: Session;
  readonly agentGroupId: string;
  readonly agentGroupFolder: string;
  /** The window's handle; null in the 'nothing open' phases. */
  readonly mailbox: NanoclawMailboxSession | null;
  /** Constraint 20 — the W1 snapshot, the only outbound guard the context exposes. */
  readonly hasOutbound: boolean;
  readonly alive: boolean;
  readonly justWoke: boolean;
  readonly plan: WakePlan;
  readonly observed: ContainerObservation | null;
  readonly killSnapshot: SweepKillSnapshot | null;
  /** A short session in the phase's own window, for a duty that must kill (constraint 18). */
  readonly run: SessionRunner;
  /** Same, for a duty that owns more than one window of its own (the SLA). */
  runIn<T>(window: SweepWindow, action: (mailbox: NanoclawMailboxSession) => T | Promise<T>): Promise<T | undefined>;
  /**
   * The one thing a duty tells the driver rather than the other way round:
   * `session:wake` reports whether it actually woke the container this tick,
   * which gates the observe read and the whole health chain (constraint 10).
   */
  reportWoke(woke: boolean): void;
}

/**
 * Narrow the union `SweepDuty.run` declares. A session-phase duty can only be
 * reached through the per-session driver, so this is a shape assertion with a
 * loud failure rather than a silent cast.
 */
export function asSessionContext(ctx: SweepTickContext | SweepSessionContext): SweepSessionContext {
  if (!('session' in ctx)) throw new Error('a session-phase duty ran with a tick context');
  return ctx;
}

export interface SweepDuty {
  /** Stable id; the drift test's name set and the `duty` field on both error lines. */
  name: string;
  phase: SweepPhase;
  /** Within-phase; a duplicate (phase, order) throws at registration. */
  order: number;
  /** Required in an exclusive phase (except the single fallthrough), forbidden in an 'all' phase. */
  claims?(ctx: SweepSessionContext): boolean | Promise<boolean>;
  run(ctx: SweepTickContext | SweepSessionContext): void | Promise<void>;
}

export interface SlaObservationHook {
  name: string;
  order: number;
  run(ctx: SweepSessionContext, state: ContainerState | null, mailbox: NanoclawMailboxSession): void;
}

export interface SweepKillFollowUp {
  name: string;
  order: number;
  run(ctx: SweepSessionContext, outcome: StuckDecision, mailbox: NanoclawMailboxSession): void | Promise<void>;
}

const sweepDuties: SweepDuty[] = [];
const slaObservationHooks: SlaObservationHook[] = [];
const sweepKillFollowUps: SweepKillFollowUp[] = [];

interface SweepDutySource {
  name: string;
  registrar: () => void;
}

// Registration sources, in registration order. The in-file built-ins are the
// first source (registered below, at module init); a family module
// (`src/modules/sweep-<family>/`) registers itself as a further source at its
// own import time. The test reset replays every recorded source's registrar
// so a family module's duties survive `_resetSweepRegistryForTesting()`
// instead of silently dropping out (found by two family builders: R-7 fell
// 39→33 under the old builtins-only reset).
const sweepDutySources: SweepDutySource[] = [];

export function registerSweepDutySource(name: string, registrar: () => void): void {
  if (sweepDutySources.some((s) => s.name === name)) {
    throw new Error(`Sweep duty source ${name}: already registered`);
  }
  sweepDutySources.push({ name, registrar });
  registrar();
}

export function registerSweepDuty(duty: SweepDuty): void {
  if (!SWEEP_PHASES.includes(duty.phase)) {
    throw new Error(`Sweep duty ${duty.name}: unknown phase ${duty.phase}`);
  }
  const kind = SWEEP_PHASE_KINDS[duty.phase];
  if (kind === 'all' && duty.claims) {
    throw new Error(`Sweep duty ${duty.name}: claims() is forbidden in the '${duty.phase}' phase (kind 'all')`);
  }
  if (kind === 'exclusive' && !duty.claims) {
    const fallthrough = sweepDuties.find((d) => d.phase === duty.phase && !d.claims);
    if (fallthrough) {
      throw new Error(
        `Sweep duty ${duty.name}: '${duty.phase}' is exclusive and already has a fallthrough (${fallthrough.name}) — every other duty needs claims()`,
      );
    }
  }
  const clash = sweepDuties.find((d) => d.phase === duty.phase && d.order === duty.order);
  if (clash) {
    throw new Error(`Sweep duty ${duty.name}: (${duty.phase}, ${duty.order}) is already held by ${clash.name}`);
  }
  const sameName = sweepDuties.find((d) => d.name === duty.name);
  if (sameName) throw new Error(`Sweep duty ${duty.name}: already registered in phase ${sameName.phase}`);
  sweepDuties.push(duty);
  sweepDuties.sort((a, b) => SWEEP_PHASES.indexOf(a.phase) - SWEEP_PHASES.indexOf(b.phase) || a.order - b.order);
  dutiesByPhase = new Map();
}

/**
 * Runs inside the SLA duty's OWN observe session, before `decideStuckAction`,
 * so the decision and the telemetry row see one snapshot. Reached only when the
 * exclusive chain falls through to the SLA branch — never on heal or reap paths.
 */
export function registerSlaObservationHook(hook: SlaObservationHook): void {
  const clash = slaObservationHooks.find((h) => h.order === hook.order);
  if (clash) throw new Error(`SLA observation hook ${hook.name}: order ${hook.order} is already held by ${clash.name}`);
  slaObservationHooks.push(hook);
  slaObservationHooks.sort((a, b) => a.order - b.order);
}

/**
 * Runs inside the post-kill session the SLA duty opens AFTER `killContainer`
 * returns. A kill respawns through `onExit` and clears status through
 * `delivery.ts`, both of which open a session on the same key, so nothing may
 * be held across it (invariant I-3).
 */
export function registerSweepKillFollowUp(followUp: SweepKillFollowUp): void {
  const clash = sweepKillFollowUps.find((f) => f.order === followUp.order);
  if (clash)
    throw new Error(`Sweep kill follow-up ${followUp.name}: order ${followUp.order} is already held by ${clash.name}`);
  sweepKillFollowUps.push(followUp);
  sweepKillFollowUps.sort((a, b) => a.order - b.order);
}

// Memoized: `dutiesForPhase` runs four times per swept session, and the tick
// walks ~3,200 of them. Registration is import-time, so the only invalidation
// is a registration (and the test-only reset).
let dutiesByPhase = new Map<SweepPhase, SweepDuty[]>();

function dutiesForPhase(phase: SweepPhase): SweepDuty[] {
  let duties = dutiesByPhase.get(phase);
  if (!duties) {
    duties = sweepDuties.filter((d) => d.phase === phase);
    dutiesByPhase.set(phase, duties);
  }
  return duties;
}

/** Test-only: the full registration set, in run order. */
export function _listSweepRegistrationsForTesting(): {
  duties: readonly SweepDuty[];
  slaObservationHooks: readonly SlaObservationHook[];
  killFollowUps: readonly SweepKillFollowUp[];
} {
  return {
    duties: [...sweepDuties],
    slaObservationHooks: [...slaObservationHooks],
    killFollowUps: [...sweepKillFollowUps],
  };
}

/**
 * Test-only: clear the registry. `builtins: false` leaves it EMPTY so a test
 * can drive the driver over its own probes; the default replays every
 * recorded duty source's registrar, in registration order — the in-file
 * built-ins plus any family module that registered itself via
 * `registerSweepDutySource` — restoring the full registration set rather
 * than only the 39 the built-ins alone would give.
 */
export function _resetSweepRegistryForTesting(options: { builtins?: boolean } = {}): void {
  sweepDuties.length = 0;
  slaObservationHooks.length = 0;
  sweepKillFollowUps.length = 0;
  dutiesByPhase = new Map();
  if (options.builtins ?? true) {
    for (const source of sweepDutySources) source.registrar();
  }
}

/**
 * Test-only: drop exactly the named duty source, so a test that registered a
 * fake source via `registerSweepDutySource` doesn't leak it into later tests'
 * registry state. Throws on `'host-sweep:builtin'` — that source is not
 * test-owned. A no-op if `name` isn't currently registered. Does not touch
 * the duty/hook/follow-up registries — call this after
 * `_resetSweepRegistryForTesting()` has already restored them, not instead
 * of it. Never clear the whole source list: a real family module's source
 * (registered at its own import time, same as the built-ins) would be wiped
 * along with it for the rest of the test file.
 */
export function _unregisterSweepDutySourceForTesting(name: string): void {
  if (name === 'host-sweep:builtin') {
    throw new Error("_unregisterSweepDutySourceForTesting: 'host-sweep:builtin' is not test-owned");
  }
  const index = sweepDutySources.findIndex((s) => s.name === name);
  if (index !== -1) sweepDutySources.splice(index, 1);
}

// ── Duty failure handling ────────────────────────────────────────────────────
//
// Every duty body runs through `runDutyBody`, which tags the error with the
// duty name and the window and rethrows. What happens next depends on the
// phase, and the difference is the point:
//
//   TICK phases isolate. `runTickPhase` catches, logs 'Host sweep duty failed'
//   with `duty` and `window`, and runs the next duty. Registration IS the
//   guard, so an unguarded duty is impossible — before this seam an unguarded
//   throw from the reconciler or the receipts prune silently skipped every
//   later duty in the tick, which is one of the failures this seam was booked
//   against (constraint 5).
//
//   SESSION phases do not. A duty that threw leaves work still due, so the
//   throw propagates out of `sweepSession` to `sweepOnce`'s per-session catch,
//   which logs the same line and — critically — does NOT quiet-cache the
//   session, so the next 60s tick retries it. Isolation there is per session,
//   not per duty, exactly as before.
//
// Both paths emit one line, from one place, so each gate stays single-cause
// (constraint 17).

/**
 * The driver's own W3 observe read. Not a registration — the `driver:` prefix
 * says so — but it needs a stable `duty` value because it reads the mailbox and
 * can therefore fail like a duty.
 */
const DRIVER_OBSERVE_DUTY = 'driver:observe';

/**
 * The per-session yield, injectable so a test can OBSERVE it.
 *
 * It is behavior, not decoration: deleting it turns a batch of swept sessions
 * back into one contiguous event-loop freeze, and a test that only watches duty
 * order stays green while that happens. R-2b records a marker through this seam.
 */
const defaultSweepYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
let sweepYield: () => Promise<void> = defaultSweepYield;

/** Test-only: wrap or replace the per-session yield. `null` restores it. */
export function _setSweepYieldForTesting(next: (() => Promise<void>) | null): void {
  sweepYield = next ?? defaultSweepYield;
}

const SWEEP_DUTY_TAG = Symbol('sweepDutyTag');
interface SweepDutyTag {
  duty: string;
  window: SweepWindow;
}

/**
 * A later window's opener failed (or its mailbox vanished mid-tick). Already
 * classified and, where it warrants one, already logged — the per-session frame
 * turns it into "no quiet mark, retried next tick" without a second line.
 */
class SweepWindowAbort extends Error {
  constructor(readonly window: SweepWindow) {
    super(`sweep window ${window} aborted`);
    this.name = 'SweepWindowAbort';
  }
}

function tagDutyFailure(err: unknown, duty: string, window: SweepWindow): unknown {
  if (err instanceof SweepWindowAbort) return err;
  if (err !== null && typeof err === 'object' && !(SWEEP_DUTY_TAG in err)) {
    Object.defineProperty(err, SWEEP_DUTY_TAG, { value: { duty, window } satisfies SweepDutyTag, enumerable: false });
  }
  return err;
}

/** The `duty`/`window` fields for whichever body threw, or nothing. */
function dutyFailureFields(err: unknown): { duty?: string; window?: SweepWindow } {
  if (err === null || typeof err !== 'object' || !(SWEEP_DUTY_TAG in err)) return {};
  const tag = (err as Record<symbol, SweepDutyTag>)[SWEEP_DUTY_TAG];
  return { duty: tag.duty, window: tag.window };
}

async function runDutyBody<T>(duty: string, window: SweepWindow, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw tagDutyFailure(err, duty, window);
  }
}

async function runTickPhase(ctx: SweepTickContext, phase: SweepPhase): Promise<void> {
  for (const duty of dutiesForPhase(phase)) {
    try {
      await runDutyBody(duty.name, phase, () => duty.run(ctx));
    } catch (err) {
      // Isolated: one failing central duty must not cost the tick every duty
      // ordered after it. The `duty` and `window` fields say which body, so a
      // family PR's post-deploy check filters on its own duty names rather
      // than counting a shared string.
      log.error('Host sweep duty failed', { err, duty: duty.name, window: phase });
    }
  }
}

async function runSessionPhase(ctx: SweepSessionContext, phase: SweepPhase): Promise<void> {
  for (const duty of dutiesForPhase(phase)) {
    await runDutyBody(duty.name, phase, () => duty.run(ctx));
  }
}

/** The if/else-if chain, as data: first `claims()` wins, else the fallthrough. */
async function runExclusiveSessionPhase(ctx: SweepSessionContext, phase: SweepPhase): Promise<void> {
  const duties = dutiesForPhase(phase);
  for (const duty of duties) {
    if (!duty.claims) continue;
    const claimed = await runDutyBody(duty.name, phase, () => duty.claims!(ctx));
    if (claimed) {
      await runDutyBody(duty.name, phase, () => duty.run(ctx));
      return;
    }
  }
  const fallthrough = duties.find((d) => !d.claims);
  if (fallthrough) await runDutyBody(fallthrough.name, phase, () => fallthrough.run(ctx));
}

export async function runSlaObservationHooks(
  ctx: SweepSessionContext,
  state: ContainerState | null,
  mailbox: NanoclawMailboxSession,
): Promise<void> {
  for (const hook of slaObservationHooks) {
    await runDutyBody(hook.name, 'session:health:sla-observe', () => hook.run(ctx, state, mailbox));
  }
}

export async function runSweepKillFollowUps(
  ctx: SweepSessionContext,
  outcome: StuckDecision,
  mailbox: NanoclawMailboxSession,
  snapshot: SweepKillSnapshot,
): Promise<void> {
  // The snapshot was taken inside the observe session, BEFORE the kill —
  // resetStuckProcessingRows clears the claims, so a read here would always be
  // empty (constraint 12). `Object.create` shadows one field and leaves every
  // other accessor live on the driver's own context.
  const followUpCtx: SweepSessionContext = Object.create(ctx, {
    killSnapshot: { value: snapshot, enumerable: true },
  }) as SweepSessionContext;
  for (const followUp of sweepKillFollowUps) {
    await runDutyBody(followUp.name, 'session:health:post-kill', () => followUp.run(followUpCtx, outcome, mailbox));
  }
}

/**
 * A short session tagged with the window it belongs to.
 *
 * Classification is per OPENING BOUNDARY, not one flag per session. Only a W1
 * opener failure backs the session off, and that is deliberate: W1 already
 * proved the mailbox openable this tick, so a failure at a later window is far
 * more likely a reclaim race than a persistent EACCES — and a genuinely
 * persistent fault fails at W1 on the very next tick and takes the backoff
 * there. Extending the backoff later would hold an already-due scheduled task
 * for 30 minutes on a transient condition. plan.md §4.5.
 */
function windowedRunner(run: SessionRunner, sessionId: string, window: () => SweepWindow): SessionRunner {
  return async <T>(action: (mailbox: NanoclawMailboxSession) => T | Promise<T>): Promise<T | undefined> => {
    const at = window();
    let entered = false;
    try {
      return await run((mailbox) => {
        entered = true;
        return action(mailbox);
      });
    } catch (err) {
      // A session that vanished under us is the ordinary steady state — not a
      // fault, not logged, and retried on the next tick rather than backed off.
      if (err instanceof SessionDbMissingError) throw new SweepWindowAbort(at);
      if (err instanceof SessionDbUnopenableError || !entered) {
        log.error('Host sweep mailbox unopenable', { err, sessionId, window: at });
        throw new SweepWindowAbort(at);
      }
      throw err;
    }
  };
}

/** The 38 duties this module still owns, as 39 registrations. Ids from seam2-inventory.md §3. */
export const SWEEP_DUTY_INVENTORY: Readonly<Record<string, string>> = {
  T2: 'egress-network-reheal',
  T5: 'approvals-reason-sweep',
  T6: 'orchestrator-reconciler',
  T7: 'github-app-token-refresh',
  T8: 'thread-close-advance',
  T9: 'steer-idempotency-prune',
  T10: 'channel-ingress-receipt-prune',
  T11: 'scheduled-move-recovery',
  T12: 'audit-body-prune',
  T13: 'storage-maintenance',
  T14: 'completed-task-auto-archive',
  T15: 'session-title-sweep',
  T16: 'thread-title-retry',
  T17: 'dashboard-token-prune',
  T18: 'task-watchdog',
  T19: 'usage-rollup',
  T20: 'claims-reconcile',
  T21: 'claims-self-heal',
  T22: 'orphaned-repo-fence-release',
  T23: 'cli-request-execution-prune',
  // Fork addition, not part of the upstream seam-2 port: by-reference GitHub
  // credential delivery (src/github-token-file.ts). Kept in this inventory
  // so the registration drift guard in host-sweep-registry.test.ts stays an
  // exact accounting of every registered duty.
  FORK1: 'github-token-file-refresh',
  S2: 'processing-ack-sync',
  S3: 'stale-pending-expiry',
  S4: 'pre-wake-orphan-claim-reset',
  S5: 'due-wake-admission',
  S6: 'done-proposal-mirror',
  S7: 'continuation-read',
  S8: 'continuation-recovery-parking',
  S9a: 'continuation-wake-eligibility',
  S9b: 'container-wake',
  S10: 'ceiling-kill-accountability',
  S11: 'provider-self-heal',
  S12: 'idle-task-reap',
  S13: 'idle-chat-reap',
  S14: 'running-container-sla',
  S15: 'kill-ceiling-notice',
  S16: 'container-oom-notice',
  S17: 'orphan-claim-reset',
  S18: 'recurrence-fanout',
  S19: 'spent-task-session-gc',
};

/**
 * The decision `enforceRunningContainerSla` (S14, moved to
 * `src/modules/sweep-container-health/index.ts`) computes and acts on. Stays
 * here because `SweepKillFollowUp.run` and the S15/S10 kill follow-ups below
 * (owned by other family PRs) reference it by name.
 */
export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

// ─────────────────────────────────────────────────────────────────────────────
// Ceiling-kill accountability wake.
//
// The absolute ceiling fires whenever a container goes 30 min without a
// heartbeat — including right after the agent parked long-running work in an
// in-container background task and ended its turn (the heartbeat only moves
// while a turn is active). Respawn is wake-on-inbound, so without a follow-up
// the session stays dead until a human pings — which reads as "said it was
// working, then went silent for hours," and the background job's state (plus
// /tmp) is gone by the time anyone looks.
//
// When the kill interrupted an explicit continuation or a freshly-started
// tool, queue an on_wake accountability row. Status/narration is deliberately
// not evidence: "starting now" can be the final output of a completed turn.
// The continuation record owns the two-attempt recovery cap; genuine inbound
// resets that counter in the runner without deleting the saved task.
// ─────────────────────────────────────────────────────────────────────────────

export const CONTINUATION_WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The durable work-continuation record and its SQL live in the mailbox module
 * (`src/modules/mailbox/ops/continuation.ts`) — the sweep owns the throttle
 * and the cap, not the storage. Re-exported unchanged so `host-restart-warn`
 * and the existing tests keep their import path and signatures.
 */
export {
  canAttemptContinuationRecovery,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './modules/mailbox/ops/continuation.js';
import {
  canAttemptContinuationRecovery,
  readWorkContinuation,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './modules/mailbox/ops/continuation.js';

/** Test-only predicate over an injected outbound DB handle. */
export function _hasWorkContinuationForTesting(db: Database.Database): boolean {
  return readWorkContinuation(db) !== null;
}

/**
 * The deferred recovery-wake rows the sweep parks when a budget is spent.
 * SQL in the mailbox module; re-exported unchanged for the existing tests.
 */
export { hasDueRecoveryWake, parkDueRecoveryWakes } from './modules/mailbox/ops/recovery.js';

/** Throttle gate: wake only when the last spawn/recovery attempt is old. */
export function decideContinuationWake(args: {
  now: number;
  spawnedAtMs: number;
  lastRecoveryAttemptAtMs?: number;
}): boolean {
  const lastAttemptAtMs = Math.max(args.spawnedAtMs, args.lastRecoveryAttemptAtMs ?? 0);
  if (lastAttemptAtMs === 0) return true;
  return args.now - lastAttemptAtMs >= CONTINUATION_WAKE_MIN_INTERVAL_MS;
}

/**
 * Consume one recovery attempt for a STOPPED session's saved continuation.
 *
 * Its own short mailbox session: the caller must not be holding one for this
 * key (invariant I-3), and the write only ever runs with the container
 * confirmed stopped, which is what makes a host write to the container-owned
 * outbound.db safe.
 */
/**
 * THE guard for every host-side write to the container-owned `outbound.db`.
 *
 * `outbound.db` has one writer. The host may write it only while no container
 * owns it, and after the seam made these paths async that check has to sit
 * immediately before the write with no await in between — an open, a kill, or
 * any other yield is a window a replacement wake can land in.
 *
 * Two entry points, one implementation:
 *  - this one, for a write inside a session the caller already holds;
 *  - `withStoppedContainerSession`, which opens a short session and delegates
 *    here, for a write that needs its own.
 *
 * Both exist because the nesting guard forbids opening a second session for a
 * key while one is open (invariant I-3), so the in-session writes physically
 * cannot route through the session-opening form. Every outbound write in this
 * file is an argument to one of these two, which is what makes the property
 * checkable by grep rather than by reading.
 *
 * Returns `undefined` when a container owns the file — never an error. Every
 * caller's write is idempotent or retried on the next tick.
 */
export function writeOutboundWhenStopped<T>(
  session: Session,
  mailbox: NanoclawMailboxSession,
  action: (mailbox: NanoclawMailboxSession) => T,
): T | undefined {
  if (containerOwnsOutbound(session.id)) {
    log.debug('Skipped a host outbound write — a container owns this session', { sessionId: session.id });
    return undefined;
  }
  return action(mailbox);
}

/**
 * Run a host write against the container-owned `outbound.db`, but only while
 * the container is confirmed stopped.
 *
 * The check is INSIDE the session and immediately before the mutation, with no
 * await between the two — that ordering is the whole point. Opening a mailbox
 * session is a yield, and a concurrent inbound wake can start a container in
 * it. Pre-seam this path was a synchronous check-then-write on a handle that
 * was already open, so no such gap existed; restoring the property, rather
 * than re-checking at each call site, is what keeps the next writer from
 * reintroducing it.
 *
 * Runs through the caller's WINDOWED runner, so an opener failure is still
 * classified and unwound by the window that owns it.
 *
 * Resolves `undefined` when the mailbox is gone OR a container took ownership
 * during the open. Callers treat both as "did not run" — never as failure.
 */
async function withStoppedContainerSession<T>(
  run: SessionRunner,
  session: Session,
  action: (mailbox: NanoclawMailboxSession) => T,
): Promise<T | undefined> {
  return run((mailbox) => writeOutboundWhenStopped(session, mailbox, action));
}

async function incrementStoppedContinuationAttempt(
  run: SessionRunner,
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  try {
    // A container that came up during the open now owns both outbound.db and
    // the continuation's runner claim. Writing here would push the record back
    // to `queued`, drop that runner_id and consume a recovery attempt the
    // fresh runner never got — saved work duplicated, parked early, or lost.
    // Returning without consuming the attempt leaves the next tick to decide.
    const result = await withStoppedContainerSession(run, session, (mailbox) =>
      expectedId !== 'legacy-pending-next'
        ? mailbox.incrementWorkContinuationResumeAttempt(expectedId)
        : mailbox.migrateLegacyWorkContinuationForRecovery(),
    );
    return result ?? null;
  } catch (err) {
    // An OPENER failure was already classified and logged by the window, and it
    // is unwinding the session — swallowing it here would hand S9b a null and
    // let it wake the container on W1's stale plan through an unreadable
    // mailbox. Everything else keeps the pre-seam outcome exactly: warn, return
    // null, and let a due-count wake proceed without the continuation.
    if (err instanceof SweepWindowAbort) throw err;
    log.warn('Failed to increment continuation recovery attempt', { sessionId: session.id, err });
    return null;
  }
}

async function restoreStoppedContinuationAttempt(
  run: SessionRunner,
  session: Session,
  attempted: HostWorkContinuation,
  previous: HostWorkContinuation,
): Promise<void> {
  try {
    await withStoppedContainerSession(run, session, (mailbox) =>
      mailbox.restoreWorkContinuationResumeAttempt(attempted, previous),
    );
  } catch (err) {
    // Same split as the increment above: an opener failure is the window's to
    // report and unwind; anything else keeps the pre-seam warn-and-continue.
    if (err instanceof SweepWindowAbort) throw err;
    log.warn('Failed to restore continuation recovery attempt after rejected wake', { sessionId: session.id, err });
  }
}

export function notifyContinuationParked(
  mailbox: NanoclawMailboxSession,
  session: Session,
  continuation: HostWorkContinuation,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => mailbox.writeOutboundDirect(message),
): boolean {
  const marker = `continuation_recovery_parked:${continuation.id}:${continuation.recovery_episode}`;
  if (mailbox.outboundHasContentLike(marker)) return false;
  const sourceRouting = continuation.source_message_id
    ? mailbox.readMessageRouting(continuation.source_message_id)
    : undefined;
  const routing =
    sourceRouting?.channel_type && sourceRouting.platform_id ? sourceRouting : mailbox.readSessionRouting();
  if (!routing) return false;
  writeMessage({
    id: `continuation-parked-${continuation.id}-${continuation.recovery_episode}`,
    kind: 'chat',
    platformId: routing.platform_id,
    channelType: routing.channel_type,
    threadId: routing.thread_id,
    content: JSON.stringify({
      text:
        `⚠️ I could not resume the interrupted work after ${WORK_CONTINUATION_RESUME_MAX_ATTEMPTS} automatic attempts. ` +
        `The task is still saved: ${continuation.task}. Reply in this thread and I will try again.`,
      _system: {
        kind: marker,
        continuation_id: continuation.id,
        recovery_episode: continuation.recovery_episode,
      },
    }),
  });
  return true;
}

export type CeilingFollowUp = { action: 'none' } | { action: 'wake-accountable'; reason: 'continuation' | 'tool' };

export function decideCeilingFollowUp(args: {
  hasContinuation: boolean;
  currentTool: string | null;
  toolStartedAt: string | null;
  priorToolAttempts: number;
  now: number;
  /**
   * The ceiling that actually fired for this kill (decideStuckAction's
   * `ceilingMs`, itself widened by a declared Bash/CodexItem timeout). Supply
   * it ONLY from the kill path: it buys the tool-freshness bound one extra
   * sweep interval of detection lag. Callers that ask "is a tool in flight
   * right now" rather than "what did this kill interrupt" — host-restart-warn
   * runs against live state with no sweep lag — omit it and keep the plain
   * ABSOLUTE_CEILING_MS freshness window.
   */
  ceilingMs?: number;
}): CeilingFollowUp {
  if (args.hasContinuation) return { action: 'wake-accountable', reason: 'continuation' };
  if (!args.currentTool || !args.toolStartedAt) return { action: 'none' };
  const startedAt = parseSqliteUtc(args.toolStartedAt);
  // Bound against the ceiling that actually fired, plus one sweep interval of
  // detection lag. Bounding against ABSOLUTE_CEILING_MS made this branch
  // unreachable: starting a tool emits a provider event, which touches the
  // heartbeat (poll-loop.ts:1712), so at kill time the tool's age is always at
  // least the heartbeat age that just exceeded the ceiling. Every genuinely
  // wedged tool was killed and then went dark with no accountability wake.
  const maxToolAgeMs =
    args.ceilingMs === undefined
      ? ABSOLUTE_CEILING_MS
      : Math.max(args.ceilingMs, ABSOLUTE_CEILING_MS) + SWEEP_INTERVAL_MS;
  if (!Number.isFinite(startedAt) || startedAt > args.now || args.now - startedAt > maxToolAgeMs) {
    return { action: 'none' };
  }
  if (args.priorToolAttempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS) return { action: 'none' };
  return { action: 'wake-accountable', reason: 'tool' };
}

const CEILING_RESPAWN_ID_PREFIX = 'ceiling-respawn-';

export function countToolRecoveryAttemptsSinceRealInbound(mailbox: NanoclawMailboxSession): number {
  return mailbox.countRecoveryAttemptsSinceRealInbound(`${CEILING_RESPAWN_ID_PREFIX}tool-`);
}

/**
 * Write one deferred, on-wake accountability row (plus its inert recall marker)
 * into the host-owned inbound DB. The row id doubles as the durable marker the
 * per-class attempt caps count, so every self-heal action goes through here.
 */
export function writeSystemWake(
  mailbox: NanoclawMailboxSession,
  session: Session,
  id: string,
  text: string,
  system: Record<string, unknown>,
  /**
   * 1 = only the NEXT fresh container's first poll sees it (the dying-container
   * accountability case). 0 = the container that is running RIGHT NOW picks it
   * up on its next poll — what a live-container notice such as OOM needs.
   */
  onWake: 0 | 1 = 1,
): boolean {
  return mailbox.insertDeferredMessageWithContextIfNew({
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system', _system: system }),
    processAfter: null,
    recurrence: null,
    onWake,
  });
}

function writeCeilingRespawn(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: 'continuation' | 'tool',
  recoveryKey: string,
  heartbeatAgeMs: number,
  workContinuation: HostWorkContinuation | null,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): void {
  const idleMinutes = Math.round(Math.max(ceilingMs, ABSOLUTE_CEILING_MS) / 60_000);
  const silentMinutes = Math.round(heartbeatAgeMs / 60_000);
  // Name the saved task. Without it the agent reads a generic "you were
  // killed" notice, cannot tell the wake IS its own continuation, and burns a
  // turn re-deriving whether the promised work ran (observed 2026-08-16).
  const savedWork =
    reason === 'continuation' && workContinuation
      ? ` Your saved continuation (${workContinuation.id}) is still queued and resumes automatically right after ` +
        `this message — do NOT re-queue it with continue_work, and do not redo it if you find it already done. ` +
        `The saved task is: ${workContinuation.task}`
      : '';
  const text =
    `[system] Your previous container was killed by the ${idleMinutes}-minute idle ceiling ` +
    `(no active turn for ~${silentMinutes} min). If work was in flight: check your durable checkpoints, ` +
    `resume what is safely resumable, and post ONE message accounting for state — done / lost / next. ` +
    `Re-check any work claims in claims/ before resuming a seam — a sibling may have taken it over while you were down. ` +
    `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
    `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay. ` +
    `If nothing was in flight, say so in one line.${savedWork}`;
  writeSystemWake(mailbox, session, `${CEILING_RESPAWN_ID_PREFIX}${recoveryKey}`, text, {
    kind: 'agent_ceiling_respawn',
    reason,
    heartbeat_age_ms: heartbeatAgeMs,
  });
}

/** The follow-up half of the kill-ceiling branch, driven only by durable work state or a fresh tool start. */
function applyCeilingFollowUp(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  const priorToolAttempts = countToolRecoveryAttemptsSinceRealInbound(mailbox);
  const followUp = decideCeilingFollowUp({
    hasContinuation: workContinuation !== null && canAttemptContinuationRecovery(workContinuation),
    currentTool: containerState?.current_tool ?? null,
    toolStartedAt: containerState?.tool_started_at ?? null,
    priorToolAttempts,
    now: Date.now(),
    ceilingMs,
  });
  if (followUp.action !== 'wake-accountable') return followUp;

  // Shadow mode gates the wedged-tool wake only. The continuation wake is
  // long-shipped behaviour on a path this change did not touch, so flipping the
  // flag must never take it away.
  if (followUp.reason === 'tool' && !SELF_HEAL_ENABLED) {
    log.info('self-heal: would queue wedged-tool accountability wake', {
      class: 'wedged-tool',
      sessionId: session.id,
      currentTool: containerState?.current_tool ?? null,
      toolStartedAt: containerState?.tool_started_at ?? null,
      heartbeatAgeMs,
      ceilingMs,
      priorToolAttempts,
      maxAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
    });
    return { action: 'none' };
  }

  const recoveryKey =
    followUp.reason === 'continuation'
      ? `continuation-${workContinuation!.id}-${workContinuation!.recovery_episode}-${workContinuation!.resume_attempts}`
      : `tool-${encodeURIComponent(containerState?.tool_started_at ?? 'unknown')}`;
  writeCeilingRespawn(mailbox, session, followUp.reason, recoveryKey, heartbeatAgeMs, workContinuation, ceilingMs);
  log.info('Queued ceiling-kill accountability wake', { sessionId: session.id, reason: followUp.reason });
  return followUp;
}

/** Test-only re-export with injected session-DB handles. */
export function _applyCeilingFollowUpForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  return applyCeilingFollowUp(mailbox, session, containerState, workContinuation, heartbeatAgeMs, ceilingMs);
}

// Failed-provider self-heal (S11), running-container SLA (S14) and the OOM /
// memory-pressure notice (S16) moved to
// `src/modules/sweep-container-health/index.ts` (convergence seam 2, PR 10).
//
// `providerFailedTicks` itself stays here, exported, rather than moving with
// the rest of S11's body: the driver's own `!alive` cleanup below must stay
// SYNCHRONOUS (a dynamic import there proved to add an await suspension
// point the pre-seam code never had, letting a concurrent wake observe a
// stale `alive=false` across the gap — Codex review, S2-PR10). The map's
// SEMANTICS — the two-tick debounce, read and written only by
// `observeProviderStatus`/`decideProviderHeal` — belong entirely to S11 in
// `sweep-container-health`; that module imports this export directly
// (module → host-sweep.js, the same direction every family already uses for
// `SWEEP_DUTY_INVENTORY` — no cycle, no TDZ).
export const providerFailedTicks = new Map<string, number>();

/**
 * Run one short mailbox session for a session id.
 *
 * Threaded through the sweep duties that must OPEN AND CLOSE a session around
 * a `killContainer` call rather than hold one across it (invariant I-3):
 * a kill respawns through `onExit` and clears the session's status through
 * `delivery.ts`, and both of those open a mailbox session on this same key.
 * Production passes `withExistingNanoclawSession`; a test passes a runner over
 * its own in-memory handles.
 *
 * Resolves `undefined` when the mailbox is gone — the read-path contract.
 */
export type SessionRunner = <T>(action: (mailbox: NanoclawMailboxSession) => T | Promise<T>) => Promise<T | undefined>;

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

/**
 * The timer chain, and the only thing that must never be skipped. An unguarded
 * throw anywhere in the tick used to reject sweep()'s promise, so the
 * reschedule never ran while `running` stayed true — making startHostSweep() a
 * permanent no-op. log.ts swallows the unhandledRejection, so the process did
 * not crash, systemd never restarted it, the sentinel's `service` vital stayed
 * green, and a dead sweep emits no tick-timing lines so the `sweep` vital saw
 * zero slow ticks. Live: 2026-08-06 ~22:20 ET. Rescheduling is unconditional
 * for the same reason it always was: nothing else re-arms this.
 */
async function sweep(): Promise<void> {
  try {
    await sweepOnce();
  } catch (err) {
    log.error('Host sweep tick threw — rescheduling anyway', { err });
  }
  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepOnce(): Promise<void> {
  // Stall attribution: the sweep is the main 60s-periodic bulk worker, so a
  // slow tick is the first suspect whenever the event-loop stall detector
  // fires. One line per slow tick, with the per-session share, convicts or
  // clears it from the log alone.
  const sweepStartedAtMs = Date.now();
  let sweptSessions = 0;
  if (!running) return;

  // ONE context per tick. `sessions` is the single getActiveSessions() scan
  // every duty shares; `activeContainerSessionIds` is read lazily so it is
  // still taken at the point in the tick the duty that wants it runs.
  let sessions: Session[] | undefined;
  let activeContainerSessionIds: ReadonlySet<string> | undefined;
  const tick: SweepTickContext = {
    now: sweepStartedAtMs,
    get sessions(): readonly Session[] {
      if (!sessions) {
        throw new Error('ctx.sessions read before the tick’s active-session scan — tick:pre-session runs before it');
      }
      return sessions;
    },
    get activeContainerSessionIds(): ReadonlySet<string> {
      return (activeContainerSessionIds ??= new Set(getActiveContainerSessionIds()));
    },
  };

  await runTickPhase(tick, 'tick:pre-session');

  try {
    sessions = getActiveSessions();
  } catch (err) {
    log.error('Host sweep: failed to load active sessions', { err });
    sessions = [];
  }

  // Isolate failures per-session — a throw from one stuck session's
  // cleanup must not skip every later session for the rest of the tick.
  //
  // Quiet cache: iterating EVERY active session ever created (3k+ rows of
  // synchronous SQLite) blocked the event loop 4-5s per tick — the residual
  // stall source after the recovery-storm fix. A session the previous sweep
  // found fully quiet (no container, nothing due, no continuation) is skipped
  // until its next scheduled row is due or the backoff cap, whichever is
  // sooner. Any new inbound bumps `last_active`, which invalidates the mark —
  // so fresh activity is swept on the very next tick, and future wakes can
  // never be skipped past their due time.
  const sessionsStartedAtMs = Date.now();
  unreadableSessions = [];
  let skippedQuiet = 0;
  for (const session of sessions) {
    const mark = quietSessions.get(session.id);
    if (mark && Date.now() < mark.skipUntilMs && mark.lastActive === session.last_active) {
      skippedQuiet++;
      continue;
    }
    quietSessions.delete(session.id);
    try {
      const quietUntil = await sweepSession(session, tick);
      if (quietUntil !== null) {
        quietSessions.set(session.id, { skipUntilMs: quietUntil, lastActive: session.last_active });
      }
      sweptSessions++;
    } catch (err) {
      // A duty threw and sweepSession rethrew it: the mailbox is fine and the
      // work is still due, so this session is NOT quiet-cached and the next
      // 60s tick retries it. Distinct from 'Host sweep mailbox unopenable',
      // which is the session the host could not get into at all. `duty` and
      // `window` name which body and which opening boundary produced it, so a
      // family PR's post-deploy check filters on its own duty names rather
      // than counting a shared string.
      log.error('Host sweep duty failed', { err, sessionId: session.id, ...dutyFailureFields(err) });
    }
    // Yield to the macrotask queue so a large sweep batch cannot trip the
    // event-loop stall detector even on a cold tick.
    // Yield after EVERY swept session, not every 25. A swept session costs
    // up to ~1.5s of synchronous SQLite/filesystem work, so a 10-session
    // batch between yields was one contiguous 15s event-loop freeze — the
    // dominant source of the residual 5-8s stall detections (and delivery
    // latency) after the recovery-storm fixes. Per-session setImmediate
    // overhead is microseconds against that cost.
    await sweepYield();
  }
  // Bound the cache to sessions that still exist (closed sessions drop out
  // of getActiveSessions and would otherwise accumulate forever).
  if (quietSessions.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of quietSessions.keys()) if (!live.has(id)) quietSessions.delete(id);
  }
  const sessionsMs = Date.now() - sessionsStartedAtMs;
  lastSkippedQuiet = skippedQuiet;
  // One line per tick, never one per session: this loop runs every 60s over
  // ~1600 sessions. Live: 24 session dirs have no inbound.db and were skipped
  // in total silence, indistinguishable from healthy quiet.
  if (unreadableSessions.length > 0) {
    log.warn('Host sweep: sessions skipped as UNREADABLE (not quiet)', {
      count: unreadableSessions.length,
      samples: unreadableSessions.slice(0, 5),
    });
  }

  await runTickPhase(tick, 'tick:post-session');
  await runTickPhase(tick, 'tick:housekeeping');

  const sweepMs = Date.now() - sweepStartedAtMs;
  if (sweepMs >= 1_000) {
    log.info('Host sweep tick timing', { sweepMs, sessionsMs, sweptSessions, skippedQuiet: lastSkippedQuiet });
  }
}

/**
 * Test-only entry point for one whole tick, without the timer chain. Drives the
 * registry exactly as production does — the acceptance cases in
 * `host-sweep-registry.test.ts` need the driver, not the 60s `setTimeout`.
 */
export async function _sweepOnceForTesting(): Promise<void> {
  const wasRunning = running;
  running = true;
  try {
    await sweepOnce();
  } finally {
    running = wasRunning;
  }
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/** Most recent messages_in timestamp for a session, or null if it has none. */
function getLastInboundAtMs(mailbox: NanoclawMailboxSession): number | null {
  const timestamp = mailbox.latestInboundTimestamp();
  if (timestamp === null) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent messages_out timestamp for a session, or null if it has never produced output. */
function getLastOutboundAtMs(mailbox: NanoclawMailboxSession): number | null {
  const timestamp = mailbox.latestOutboundTimestamp();
  if (timestamp === null) return null;
  const ms = parseSqliteUtc(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

async function prepareDueWake(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  // Fleet-hardening Phase 1.1: run any opted-in (scriptHost) pre-task scripts
  // on the host BEFORE admission, so a gated/errored fire never becomes due
  // and never spawns a container. See host-script.ts's runHostGatedTaskScripts.
  //
  // `runHostGatedTaskScripts` and `admitDueTaskContexts` both take this
  // session: they are sweep callees with no other production caller, and a
  // SESSION parameter is the seam's sanctioned object — invariant I-9 forbids
  // handing out raw handles, not sessions, so neither callee lands on the
  // ratchet's allowlist. The script runner can spend the full pre-task timeout
  // per row, so the session is held across that work exactly as it was when
  // these lines passed a raw handle.
  //
  // `agentGroupId` rides along because the callee resolves the GROUP's
  // timezone for its local-time gate: a session parameter identifies the
  // mailbox, not the group whose zone override applies.
  await runHostGatedTaskScripts(mailbox, agentGroupId, sessionId);
  const admittedTasks = admitDueTaskContexts(mailbox, agentGroupId, sessionId);
  const dueCount = mailbox.countDueMessages();
  return {
    admittedTasks,
    dueCount,
    wakePriority: dueCount > 0 ? mailbox.getDueWakePriority() : 'interactive',
  };
}

export async function _prepareDueWakeForTesting(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  return prepareDueWake(mailbox, agentGroupId, sessionId);
}


/**
 * "I cannot read this session" is not "this session is quiet", but both took
 * the same silent quiet-until return. Same backoff — a session the host cannot
 * open has nothing to sweep — but it is now counted so the tick can say so.
 */
let unreadableSessions: { sessionId: string; reason: string }[] = [];
function skipUnreadable(sessionId: string, reason: string): number {
  unreadableSessions.push({ sessionId, reason });
  return Date.now() + QUIET_SESSION_BACKOFF_MS;
}

/**
 * Sweep one session. Returns a quiet-until timestamp (ms) when the session is
 * fully quiet and safe to skip until then, or null when it must stay hot.
 */
async function sweepSession(session: Session, tick: SweepTickContext): Promise<number | null> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return skipUnreadable(session.id, 'agent group missing');

  // Every duty below runs inside one of these — a short session, opened and
  // closed, never held across a wake or a kill (invariant I-3). Reads never
  // provision (invariant I-4): a session whose mailbox is gone resolves
  // undefined and is counted as unreadable rather than silently recreated.
  const baseRun: SessionRunner = (action) => withExistingNanoclawSession(agentGroup.id, session.id, action);

  // `session:plan` fills this in; every later phase reads it.
  const plan: WakePlan = {
    dueCount: 0,
    wakePriority: 'interactive',
    admittedTasks: 0,
    workContinuation: null,
    continuationWakeEligible: false,
    hasOutbound: false,
  };
  let mailbox: NanoclawMailboxSession | null = null;
  let alive = false;
  let justWoke = false;
  let observed: ContainerObservation | null = null;
  let window: SweepWindow = 'session:plan';
  const runIn = <T>(at: SweepWindow, action: (m: NanoclawMailboxSession) => T | Promise<T>): Promise<T | undefined> =>
    windowedRunner(baseRun, session.id, () => at)(action);

  const ctx: SweepSessionContext = {
    now: tick.now,
    get sessions(): readonly Session[] {
      return tick.sessions;
    },
    get activeContainerSessionIds(): ReadonlySet<string> {
      return tick.activeContainerSessionIds;
    },
    session,
    agentGroupId: agentGroup.id,
    agentGroupFolder: agentGroup.folder,
    get mailbox(): NanoclawMailboxSession | null {
      return mailbox;
    },
    get hasOutbound(): boolean {
      return plan.hasOutbound;
    },
    get alive(): boolean {
      return alive;
    },
    get justWoke(): boolean {
      return justWoke;
    },
    plan,
    get observed(): ContainerObservation | null {
      return observed;
    },
    killSnapshot: null,
    get run(): SessionRunner {
      return windowedRunner(baseRun, session.id, () => window);
    },
    runIn,
    reportWoke(woke: boolean): void {
      justWoke = woke;
    },
  };

  // ── W1: session:plan ───────────────────────────────────────────────────────
  // Distinguishes "a duty threw" from "the mailbox would not open". The INBOUND
  // open happens before the action body, so this flag alone settles that one —
  // but the OUTBOUND handle opens lazily, partway through the action, and by
  // then the flag is already true. Position cannot classify that, so the funnel
  // does: it raises SessionDbUnopenableError, which the catch routes to the
  // backoff whatever this flag says.
  let enteredPlanSession = false;
  let planned: { ok: true } | undefined;
  try {
    planned = await baseRun(async (m): Promise<{ ok: true }> => {
      enteredPlanSession = true;
      mailbox = m;
      try {
        await runSessionPhase(ctx, 'session:plan');
        plan.hasOutbound = m.hasOutbound();
      } finally {
        mailbox = null;
      }
      return { ok: true };
    });
  } catch (err) {
    // A session that vanished under us is the ordinary steady state — counted,
    // backed off, not logged as a fault.
    if (err instanceof SessionDbMissingError) return skipUnreadable(session.id, 'session mailbox vanished');
    // Present but unopenable: EACCES, descriptor exhaustion, a corrupt file, a
    // failed hot-journal recovery. There is nothing to sweep until that
    // changes, and retrying every 60s is what produced ~4k identical errors in
    // the hot-journal incident — so this takes the backoff, with an error line
    // so it is never silently filed as a quiet session. The error CLASS is what
    // decides, not how far we got: a lazily-opened outbound handle fails after
    // the duties have started and must still land here.
    if (err instanceof SessionDbUnopenableError || !enteredPlanSession) {
      log.error('Host sweep mailbox unopenable', { err, sessionId: session.id, window: 'session:plan' });
      return skipUnreadable(session.id, `session mailbox unreadable: ${String(err)}`);
    }
    // A DUTY threw — a transient SQLite lock during task admission, say. The
    // mailbox is fine and the work is still due, so this must retry on the next
    // 60s tick, exactly as it did before the seam. Quiet-caching it would hold
    // an already-due scheduled task or recovery wake for the full 30-minute
    // backoff, and `last_active` does not move on failure, so nothing would
    // clear it early. `sweepOnce`'s per-session catch logs and isolates it.
    throw err;
  }
  // The seam is the ONLY gate on "does this session have a mailbox". There is
  // deliberately no `fs.existsSync` pre-check beside it: two answers to that
  // question drift, and the one that matters is the implementation's own. It
  // answers on inbound.db alone, so a never-woken session with no outbound.db
  // is swept normally (its outbound reads answer empty) — only a session with
  // no inbound.db at all is skipped, and a read never re-creates one (I-4).
  if (!planned) return skipUnreadable(session.id, 'no session mailbox');

  try {
    // ── W2: session:wake — NOTHING open ──────────────────────────────────────
    // Deliberately outside any mailbox session: the spawn path reads this
    // session's repository ingress fence through a session of its own, and the
    // recovery admission writes through one too (invariant I-3).
    window = 'session:wake';
    await runSessionPhase(ctx, 'session:wake');

    alive = isContainerRunning(session.id);

    // ── W3: the driver's observe read ────────────────────────────────────────
    // Machinery, not a duty: it feeds ctx.observed, which is what the
    // session:health predicates consult. Skipped on the same iteration that
    // just woke the container — it hasn't had a chance to clear stale
    // processing_ack rows from a previous crash yet, and without this grace
    // period stale claims cause an immediate spawn-kill loop. `hasOutbound`
    // reproduces the pre-seam `outDb !== null` guard exactly.
    if (alive && !justWoke && plan.hasOutbound) {
      window = 'session:observe';
      observed =
        (await ctx.run((m) =>
          // Machinery, but it reads the mailbox like a duty does, so it carries
          // a duty identifier of its own. Without one, a throw from any of
          // these four reads logged 'Host sweep duty failed' with no `duty` and
          // no `window` at all — the field pair every family PR's post-deploy
          // check filters on. The `driver:` prefix is not a registrable name.
          runDutyBody(DRIVER_OBSERVE_DUTY, 'session:observe', () => ({
            containerState: m.getContainerState(),
            processingClaimCount: m.getProcessingClaimRows().length,
            lastOutboundAtMs: getLastOutboundAtMs(m),
            lastInboundAtMs: getLastInboundAtMs(m),
          })),
        )) ?? null;

      // ── W4: session:health — EXCLUSIVE, nothing open ───────────────────────
      if (observed) {
        window = 'session:health';
        await runExclusiveSessionPhase(ctx, 'session:health');
      }
    }

    // A container that is gone cannot be mid-failure. Clearing here stops a
    // fresh container from inheriting the dead one's half-finished debounce and
    // being killed on its first 'failed' observation. Synchronous, same as
    // pre-seam: a dynamic import here would add an await suspension point on
    // this branch that never existed before, letting a concurrent wake
    // observe a stale `alive=false` across the gap.
    if (!alive) providerFailedTicks.delete(session.id);

    // ── W5: session:tail ─────────────────────────────────────────────────────
    window = 'session:tail';
    let quietUntil: number | null = null;
    const tail = await ctx.run(async (m): Promise<{ ok: true }> => {
      mailbox = m;
      try {
        await runSessionPhase(ctx, 'session:tail');
        // Quiet-cache hint: nothing live here — no container, nothing due or
        // admitted, no continuation. Safe to skip until the next scheduled row
        // is due (never past it) or the backoff cap. New inbound invalidates
        // via last_active in the sweep loop. Driver machinery, computed after
        // the last phase.
        if (plan.dueCount === 0 && plan.admittedTasks === 0 && !justWoke && plan.workContinuation === null && !alive) {
          const nextDue = m.getNextFutureProcessAfter();
          const cap = Date.now() + QUIET_SESSION_BACKOFF_MS;
          const nextDueMs = nextDue ? Date.parse(nextDue) : Number.POSITIVE_INFINITY;
          quietUntil = Math.min(Number.isFinite(nextDueMs) ? nextDueMs : cap, cap);
        }
      } finally {
        mailbox = null;
      }
      return { ok: true };
    });
    return tail ? quietUntil : null;
  } catch (err) {
    // A later window's opener failed, or its mailbox vanished mid-tick. Already
    // classified at the boundary; the session takes no quiet mark and is swept
    // again on the next tick, exactly as it was before the seam.
    if (err instanceof SweepWindowAbort) return null;
    throw err;
  }
}

/**
 * Test-only entry point for the stopped-container recovery admission — the
 * TOCTOU site: the container-state check must happen INSIDE the session, after
 * the open and immediately before the mutation.
 */
export function _incrementStoppedContinuationAttemptForTesting(
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  const run: SessionRunner = (action) => withExistingNanoclawSession(session.agent_group_id, session.id, action);
  return incrementStoppedContinuationAttempt(run, session, expectedId);
}

/** Test-only entry point for one session's sweep tick, over a one-session tick context. */
export function _sweepSessionForTesting(session: Session): Promise<number | null> {
  let sessions: Session[] | undefined;
  let activeContainerSessionIds: ReadonlySet<string> | undefined;
  const tick: SweepTickContext = {
    now: Date.now(),
    get sessions(): readonly Session[] {
      return (sessions ??= getActiveSessions());
    },
    get activeContainerSessionIds(): ReadonlySet<string> {
      return (activeContainerSessionIds ??= new Set(getActiveContainerSessionIds()));
    },
  };
  return sweepSession(session, tick);
}

// G64 (S2-PR6): the pruneIdleSessionArtifacts/pruneIdleThreadArtifacts
// back-compat shims that used to live here are gone — callers use
// storage-manager.ts's own exports (which already default `isContainerRunning`
// and the sessions/threads roots) directly.

// Running-container SLA (S14) and the OOM / memory-pressure notice (S16)
// moved to src/modules/sweep-container-health/index.ts (convergence seam 2,
// PR 10).

export function _resetStuckProcessingRowsForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(mailbox, session, reason);
}

// sweepTaskWatchdog moved with the orchestrator family (S2-PR5) into
// src/modules/sweep-orchestrator/task-watchdog.ts — a sibling of that
// family's index.ts, not index.ts itself, so this re-export doesn't create a
// static cycle back through index.ts's own import of this file (registerSweepDuty
// / registerSweepDutySource / SWEEP_DUTY_INVENTORY).
export { sweepTaskWatchdog as _sweepTaskWatchdogForTesting } from './modules/sweep-orchestrator/task-watchdog.js';

/**
 * Tell the user we just reaped their container for inactivity. The
 * outbound.db write lands on the normal delivery path — no container
 * involvement needed (it's already dead).
 *
 * Three gates, all skip with a debug log:
 *   1. No session_routing yet (fresh session that never woke).
 *   2. `pendingClaims === 0` — no inbound was in-flight when we killed,
 *      meaning no user was actually waiting. The ceiling fires on every
 *      idle 30-min container; without this gate the chat spams every
 *      operator across every quiet session every half hour.
 *   3. Duplicate notice in the last 60s (racing sweep tick).
 *
 * The write goes through the mailbox session's own writable outbound handle,
 * which the module opens lazily — so a tick that never reaches this branch
 * never opens outbound.db for writing at all, and the earlier
 * `writableOutDb` test seam is gone with it.
 */
export function notifyKillCeiling(
  mailbox: NanoclawMailboxSession,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  try {
    if (pendingClaims === 0) {
      log.debug('kill-ceiling notify skipped — no pending claims, user was not waiting', {
        sessionId: session.id,
      });
      return;
    }
    const routing = mailbox.readSessionRouting();
    if (!routing) {
      log.debug('kill-ceiling notify skipped — no session_routing', {
        sessionId: session.id,
      });
      return;
    }
    // Idempotency: if a kill-ceiling notice was already written within the
    // last 60s (e.g. a sweep raced and re-fired), skip the duplicate. The
    // check is by content marker rather than a dedicated column to avoid
    // a schema migration. Cheap query against an already-open handle.
    const recent = mailbox.outboundHasRecentContentLike('agent_restart_inactivity', 60);
    if (recent) {
      log.debug('kill-ceiling notify skipped — duplicate within 60s', {
        sessionId: session.id,
      });
      return;
    }
    const minutes = Math.round(heartbeatAgeMs / 60_000);
    const id = `sys-kill-ceiling-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Don't ask the user to resend: the kill-ceiling branch runs
    // resetStuckProcessingRows immediately after, which defers every claimed
    // pending message behind fresh-context retry admission. Unclaimed pending
    // rows just sit until the next wake. Either way the system recovers
    // the user's existing input — a resend would just create duplicates.
    const providerFailure =
      containerState?.provider_status === 'failed' ||
      containerState?.provider_status === 'recovering' ||
      containerState?.provider_status === 'suspect';
    const failureReason = containerState?.provider_failure_reason?.slice(0, 300) ?? null;
    const text = providerFailure
      ? `⚠️ Codex control-plane recovery did not complete` +
        (failureReason ? ` (${failureReason})` : '') +
        `. The host is restarting the agent runner; your existing messages will be retried automatically — ` +
        `no need to resend.`
      : `⚠️ The agent runner stopped updating for ${minutes} minutes and the host is restarting it. ` +
        `Your last messages will be picked up automatically on the next wake — no need to resend.`;
    const content = JSON.stringify({
      text,
      // Machine-readable marker so the idempotency check above (and any
      // future consumer that wants to react) doesn't need to grep prose.
      _system: {
        kind: 'agent_restart_inactivity',
        heartbeat_age_ms: heartbeatAgeMs,
        provider_status: containerState?.provider_status ?? null,
        provider_failure_reason: failureReason,
      },
    });
    mailbox.writeOutboundDirect({
      id,
      kind: 'chat',
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.thread_id,
      content,
    });
  } catch (err) {
    log.warn('kill-ceiling notify failed', { sessionId: session.id, err });
  }
}

/** Test-only alias kept so the existing suite's call sites read unchanged. */
export function _notifyKillCeilingForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  notifyKillCeiling(mailbox, session, heartbeatAgeMs, pendingClaims, containerState);
}

function resetStuckProcessingRows(mailbox: NanoclawMailboxSession, session: Session, reason: string): void {
  const claims = mailbox.getProcessingClaimRows();
  const now = Date.now();

  for (const { message_id } of claims) {
    const msg = mailbox.getMessageForRetry(message_id, 'pending');
    if (!msg) continue;

    // Idempotency guard: if this input already has a response in
    // messages_out, the previous container death happened after the reply
    // was written but before the mark-completed step. Retrying would
    // re-invoke the agent on an input it has already answered → duplicate
    // replies to the user. Backfill the completed state on the host-owned
    // inbound.db and move on. The matching processing_ack row in outbound.db
    // stays 'processing' — harmless, because getPendingMessages on next wake
    // filters pending inputs against messages_out.in_reply_to too, so it
    // won't re-dispatch an already-answered input. Writing to outbound.db
    // here would violate the one-writer invariant (host reads outbound,
    // container writes) and the readonly handle would throw.
    const responded = mailbox.hasNonStatusReplyTo(msg.id);
    if (responded) {
      mailbox.markInboundCompletedIfPending(msg.id);
      log.info('Reset skipped — response already written; marking completed', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
      continue;
    }

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      mailbox.markMessageFailed(msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      deferMessageForFreshContextRetry(mailbox, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  try {
    const cleared = mailbox.deleteOrphanProcessingClaims();
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The 39 registrations.
//
// Bodies are the pre-registry statements, unchanged, including each duty's own
// try/catch where it had one. The duties that had none are now guarded by
// registration itself: a tick duty that throws is logged and the tick carries
// on. Phase and order encode the 21 load-bearing ordering constraints from
// plan.md §4.3; the family PRs move each body into `src/modules/sweep-<family>/`
// by moving its registration, not by editing the driver.
// ─────────────────────────────────────────────────────────────────────────────

function registerBuiltInSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  // T2 (egress-network-reheal, tick:pre-session) moved to
  // src/modules/sweep-egress/index.ts (S2-PR6).

  // ── session:plan (W1) ──────────────────────────────────────────────────────

  registerSweepDuty({
    name: id.S2,
    phase: 'session:plan',
    order: 10,
    // 1. Sync processing_ack → messages_in status
    run: (ctx) => {
      asSessionContext(ctx).mailbox!.syncProcessingAcks();
    },
  });

  registerSweepDuty({
    name: id.S3,
    phase: 'session:plan',
    order: 20,
    // 1a. Expire long-pending rows so sweep stops re-waking sessions on
    // messages that have been sitting unprocessed past the age cutoff.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      const expired = mailbox!.expireStalePending(PENDING_MESSAGE_MAX_AGE_MS);
      if (expired > 0) {
        log.info('Expired stale pending messages', {
          sessionId: session.id,
          count: expired,
          maxAgeMs: PENDING_MESSAGE_MAX_AGE_MS,
        });
      }
    },
  });

  registerSweepDuty({
    name: id.S4,
    phase: 'session:plan',
    order: 30,
    // 2. A stopped container with processing claims crashed mid-turn. Defer the
    // paired input first, while it is still inert-able, and clear the orphan
    // claim before any due-count or wake decision can expose its stale recall to
    // a replacement/warm poller. When backoff elapses, the admission seam below
    // replaces that recall from current host state.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (mailbox!.getProcessingClaimRows().length > 0) {
        writeOutboundWhenStopped(session, mailbox!, () =>
          resetStuckProcessingRows(mailbox!, session, 'container not running'),
        );
      }
    },
  });

  registerSweepDuty({
    name: id.S5,
    phase: 'session:plan',
    order: 40,
    // 3. Admit due scheduled occurrences and lifecycle wakes with fresh
    // recall/capabilities immediately before they become wakeable. Task rows
    // stay trigger=0 from creation through this point; paired lifecycle wakes
    // stay trigger=0 throughout backoff. A warm poller cannot race ahead of
    // either context pair, and a repeated sweep is idempotent.
    run: async (ctx) => {
      const { session, agentGroupId, mailbox, plan } = asSessionContext(ctx);
      const preparedWake = await prepareDueWake(mailbox!, agentGroupId, session.id);
      plan.admittedTasks = preparedWake.admittedTasks;
      plan.dueCount = preparedWake.dueCount;
      plan.wakePriority = preparedWake.wakePriority;
      if (plan.admittedTasks > 0) {
        log.debug('Admitted due turns with fresh context', {
          sessionId: session.id,
          count: plan.admittedTasks,
        });
      }
    },
  });

  registerSweepDuty({
    name: id.S6,
    phase: 'session:plan',
    order: 50,
    // Mirror the container's own `propose_done` record onto the central
    // `sessions` row so the Observatory list can show "proposes closing"
    // without opening a per-session SQLite file per row. Free here — the handle
    // is already open and it is one SELECT — and deliberately NOT the copy the
    // close path trusts (see thread-close.ts). Isolated: a mirror failure must
    // never cost this session its sweep.
    //
    // `syncDoneProposalMirror` now takes the PARSED proposal (mailbox seam
    // PR 4), so the read is the module's own op and no handle leaves the
    // session. The `hasOutbound` guard is kept for what it costs: a
    // never-woken session has no proposal to mirror and no outbound file to
    // open looking for one.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (mailbox!.hasOutbound()) {
        try {
          syncDoneProposalMirror(session.id, mailbox!.readDoneProposal());
        } catch (err) {
          log.warn('done_proposal mirror failed', { sessionId: session.id, err });
        }
      }
    },
  });

  registerSweepDuty({
    name: id.S7,
    phase: 'session:plan',
    order: 60,
    // 4. Durable continuation state is a wake source, but its automatic crash
    // recovery is both throttled and hard-capped per continuation id.
    run: (ctx) => {
      const { mailbox, plan } = asSessionContext(ctx);
      plan.workContinuation = mailbox!.readWorkContinuation();
    },
  });

  registerSweepDuty({
    name: id.S8,
    phase: 'session:plan',
    order: 70,
    run: (ctx) => {
      const { session, mailbox, plan } = asSessionContext(ctx);
      if (
        !containerOwnsOutbound(session.id) &&
        plan.workContinuation &&
        plan.workContinuation.resume_attempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS
      ) {
        const parked = mailbox!.parkDueRecoveryWakes(new Date().toISOString());
        if (parked > 0) {
          plan.dueCount = mailbox!.countDueMessages();
          plan.wakePriority = plan.dueCount > 0 ? mailbox!.getDueWakePriority() : 'interactive';
        }
        if (plan.dueCount === 0) {
          writeOutboundWhenStopped(session, mailbox!, () =>
            notifyContinuationParked(mailbox!, session, plan.workContinuation!),
          );
        }
      }
    },
  });

  registerSweepDuty({
    name: id.S9a,
    phase: 'session:plan',
    order: 80,
    // Every stopped-session wake must pass through continuation recovery
    // admission, even when an unrelated scheduled row is already due. The runner
    // retains its prior owner claim until this path clears it, so a scheduled
    // wake cannot make saved work bypass the throttle or cap.
    run: (ctx) => {
      const { session, mailbox, plan } = asSessionContext(ctx);
      plan.continuationWakeEligible =
        !containerOwnsOutbound(session.id) &&
        plan.workContinuation !== null &&
        canAttemptContinuationRecovery(plan.workContinuation) &&
        decideContinuationWake({
          now: Date.now(),
          spawnedAtMs: getContainerSpawnedAt(session.id),
          lastRecoveryAttemptAtMs: mailbox!.readContinuationRecoveryAttemptAt(plan.workContinuation),
        });
    },
  });

  // ── session:wake (W2) — NOTHING open ───────────────────────────────────────

  registerSweepDuty({
    name: id.S9b,
    phase: 'session:wake',
    order: 10,
    // 5. Wake a container if work is due and nothing is running.
    run: async (ctx) => {
      const c = asSessionContext(ctx);
      const { session, plan } = c;
      // Both of these open a mailbox of their own, so both go through the
      // window — an unopenable mailbox here is 'Host sweep mailbox unopenable'
      // with window 'session:wake', not the helper's legacy warning, and it
      // takes no quiet mark (W2 never backs off).
      const wakeRun: SessionRunner = (action) => c.runIn('session:wake', action);
      const resumedContinuation = plan.continuationWakeEligible
        ? await incrementStoppedContinuationAttempt(wakeRun, session, plan.workContinuation!.id)
        : null;
      const continuationWake = resumedContinuation !== null;
      if ((plan.dueCount > 0 || continuationWake) && !isContainerRunning(session.id)) {
        log.info('Waking container for due messages', {
          sessionId: session.id,
          count: plan.dueCount,
          priority: plan.wakePriority,
          continuationId: resumedContinuation?.id,
        });
        // wakeContainer never throws — transient spawn failures (OneCLI down,
        // etc.) return false and leave messages pending for the next tick.
        // Classification is passed into the atomic admission decision so a
        // scheduled wake can never reserve memory as interactive first.
        // Re-read immediately before the wake. `session` came from the tick's
        // `getActiveSessions()` snapshot, taken before a serial per-session
        // loop that awaits container spawns, so by this duty it can be many
        // seconds old — and the storage worker this same tick starts closes
        // rows with `UPDATE sessions SET status = 'archiving' … WHERE status =
        // 'active'`. `wakeContainer`'s only liveness gate reads `status` off
        // the object it is handed, so a stale one defeats it and spawns a
        // container `getActiveSessions()` will never return: no stuck
        // detection, no heartbeat ceiling, no claim tolerance. Every other
        // by-id caller already re-reads (`router.ts`, `agent-route.ts`,
        // `container-restart.ts`); this one did not.
        const woke = await wakeContainer(session, plan.wakePriority, { guard: sessionStillActive(session.id) });
        c.reportWoke(woke);
        if (!woke && resumedContinuation) {
          await restoreStoppedContinuationAttempt(wakeRun, session, resumedContinuation, plan.workContinuation!);
        }
      }
    },
  });

  // ── session:health (W4) — EXCLUSIVE, nothing open ──────────────────────────
  //
  // S11 (provider self-heal, order 10) and S14 (running-container SLA, order
  // 40, the fallthrough) register from
  // src/modules/sweep-container-health/index.ts (convergence seam 2, PR 10).
  // S12/S13 stay here (S2-PR3's family) — order in the exclusive chain is
  // heal (10) → idle-task-reap (20) → idle-chat-reap (30) → SLA (40).

  // S12 (idle-task-reap) and S13 (idle-chat-reap) register from
  // src/modules/sweep-idle-reap/index.ts (seam 2, S2-PR3) at order 20/30 —
  // between this heal duty and the SLA fallthrough below. Do not re-add them
  // here; see plan.md §8 "S2-PR3 — idle reaps".

  // ── session:tail (W5) ──────────────────────────────────────────────────────

  registerSweepDuty({
    name: id.S17,
    phase: 'session:tail',
    order: 10,
    // 7. Retry cleanup if the pre-wake orphan-claim clear could not finish.
    // resetStuckProcessingRows is idempotent: future retries are not bumped
    // again, and already-cleared claim sets are a no-op.
    run: (ctx) => {
      const { session, mailbox, hasOutbound } = asSessionContext(ctx);
      // `ctx.alive` was sampled BEFORE this window opened, so it cannot
      // authorize a write to outbound.db on its own — the helper re-checks
      // immediately before the write, with no await in between.
      if (hasOutbound) {
        writeOutboundWhenStopped(session, mailbox!, () =>
          resetStuckProcessingRows(mailbox!, session, 'container not running'),
        );
      }
    },
  });

  registerSweepDuty({
    name: id.S18,
    phase: 'session:tail',
    order: 20,
    // 8. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    // Takes this session (mailbox seam PR 4). Same rule as
    // `runHostGatedTaskScripts` above: a sweep callee with no other production
    // caller receives the sweep's session, never a raw handle and never its
    // own nested open on the same key.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
      await handleRecurrence(mailbox!, session);
    },
    // MODULE-HOOK:scheduling-recurrence:end
  });

  registerSweepDuty({
    name: id.S19,
    phase: 'session:tail',
    order: 30,
    // 9. GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (isTaskThread(session.thread_id)) {
        const liveTasks = mailbox!.countLiveTasks();
        if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
          updateSession(session.id, { status: 'closed' });
          log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
        }
      }
    },
  });

  // ── tick:post-session — container state is now current ─────────────────────
  //
  // T6 orchestrator-reconciler (order 10) and T18 task-watchdog (order 25)
  // moved to src/modules/sweep-orchestrator/index.ts (S2-PR5).

  registerSweepDuty({
    name: id.T8,
    phase: 'tick:post-session',
    order: 20,
    // Advance operator-confirmed thread closes: wait for the agent's wrap-up
    // confirmation, then clear its saved work, stop the container and archive —
    // in that order (src/dashboard/thread-close.ts). Central-DB scan of the few
    // in-flight rows, once per tick, after the per-session loop so container
    // state is current. Nothing here can START a close; only an operator can.
    run: async () => {
      try {
        // Awaited (mailbox seam PR 4): the close path became asynchronous when
        // its proposal reads moved behind the funnel, and an unawaited call
        // would let the tick finish while the close is still mid-flight —
        // rejections escaping this catch, and the duty reporting success it
        // has not had.
        await advanceThreadClosures();
      } catch (err) {
        log.warn('thread-close sweep step failed', { err });
      }
    },
  });

  // T13 (storage-maintenance, tick:post-session, order 30) moved to
  // src/modules/sweep-storage/index.ts (S2-PR6).

  // T22 (orphaned-repo-fence-release) moved to src/modules/sweep-repo-fence/
  // (seam 2, PR 8 — G08). The wrapper moved; `repo-fence-recovery.ts` itself
  // did not (src/main.ts and src/delivery.ts / job-runner.ts import it
  // directly, both outside that family PR's ownership boundary).

  // ── tick:housekeeping — order-free central work ────────────────────────────

  // T5 (approvals-reason-sweep) moved to src/modules/sweep-repo-fence/
  // (seam 2, PR 8 — G08). The wrapper moved; modules/approvals/index.ts did
  // not.

  // T11 (scheduled-move-recovery) and T12 (audit-body-prune) are registered by
  // src/modules/sweep-scheduled-move/index.ts (S2-PR7) — order 50/60 in this
  // same 'tick:housekeeping' phase, between T10 above and T14 below.
  // T14 completed-task-auto-archive (order 70) moved to
  // src/modules/sweep-orchestrator/index.ts (S2-PR5).

  // T20 (claims-reconcile, order 100) and T21 (claims-self-heal, order 110,
  // strictly after T20) moved to src/modules/sweep-claims/index.ts (S2-PR6).

  // ── SLA observation hooks — inside the SLA duty's own observe session ───────
  //
  // S16 (OOM / memory-pressure notice) registers from
  // src/modules/sweep-container-health/index.ts (convergence seam 2, PR 10).

  // ── Kill follow-ups — inside the session opened AFTER killContainer returns ─

  registerSweepKillFollowUp({
    name: id.S15,
    order: 10,
    // Posted AFTER the kill to honor the outbound.db single-writer invariant;
    // the module opens the writable outbound handle lazily, only for this write.
    // notifyKillCeiling itself gates on `pendingClaims === 0` (no user was
    // waiting) to avoid spamming restart notices on quiet sessions that just
    // naturally reached the 30-min idle ceiling. Ceiling kills only — the
    // claim-stuck branch has never notified.
    run: (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      writeOutboundWhenStopped(ctx.session, mailbox, () =>
        notifyKillCeiling(
          mailbox,
          ctx.session,
          outcome.heartbeatAgeMs,
          snapshot.pendingClaims,
          snapshot.containerState,
        ),
      );
    },
  });

  registerSweepKillFollowUp({
    name: id.S17,
    order: 20,
    // The same orphan-claim reset the tail runs, here for the post-kill path.
    // Both kill branches reset; only the reason differs.
    run: (ctx, _outcome, mailbox) => {
      writeOutboundWhenStopped(ctx.session, mailbox, () =>
        resetStuckProcessingRows(mailbox, ctx.session, ctx.killSnapshot!.reason),
      );
    },
  });

  registerSweepKillFollowUp({
    name: id.S10,
    order: 30,
    // Accountability wake: if the kill plausibly interrupted parked work, queue
    // an on_wake row so the session respawns (next sweep tick's due-wake step)
    // and answers for the interruption instead of staying dead until the next
    // human ping. Best-effort — a failure here must not break the sweep's kill
    // path. Ceiling kills only.
    run: (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      // INSIDE the guard, which is where upstream's single guarded block also
      // leaves it. The row itself is inbound (host-owned, no single-writer
      // hazard), but a replacement that took the session has already recovered
      // from this kill: the row is `on_wake = 1`, so the live replacement never
      // consumes it and it instead greets the NEXT fresh container with a stale
      // "your previous container was killed" notice — while counting against
      // that class's recovery-attempt cap. Skipping is correct, not merely safe.
      writeOutboundWhenStopped(ctx.session, mailbox, () => {
        try {
          applyCeilingFollowUp(
            mailbox,
            ctx.session,
            snapshot.containerState,
            snapshot.workContinuation,
            outcome.heartbeatAgeMs,
            outcome.ceilingMs,
          );
        } catch (err) {
          log.warn('ceiling-kill follow-up failed', { sessionId: ctx.session.id, err });
        }
      });
    },
  });
}

registerSweepDutySource('host-sweep:builtin', registerBuiltInSweepDuties);
