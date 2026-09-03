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
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { SELF_HEAL_ENABLED } from './config.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { readContainerConfig } from './container-config.js';
import { markProviderUnavailable } from './db/provider-health.js';
import { resolveSpawnProvider } from './provider-fallback.js';
import { resolveContainerResources } from './container-resources.js';
import { getActiveSessions, getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  SessionDbMissingError,
  SessionDbUnopenableError,
  sessionMailboxPath,
  type ForkContainerStateRow as ContainerState,
  type NanoclawMailboxSession,
} from './modules/mailbox/index.js';
import { withExistingNanoclawSession } from './modules/mailbox/session.js';
// The scheduled-move recovery below walks an INJECTED sessions root, not
// DATA_DIR, so its session DBs are not addressable by a mailbox key and it
// cannot go through the seam. It stays on the module's own open funnel — the
// one place in this file that still opens a session DB by path.
import { openInboundDb as openInboundDbByPath, openOutboundDb } from './modules/mailbox/openers.js';
import { restoreTaskRow, type TaskRowSnapshot } from './modules/scheduling/db.js';
import { countLiveRowsInSessions } from './modules/scheduling/live-count.js';
import { runHostGatedTaskScripts } from './modules/scheduling/host-script.js';
import { purgeIntentBody } from './dashboard/api/scheduled-shared.js';
import { advanceThreadClosures, syncDoneProposalMirror } from './dashboard/thread-close.js';
import { log } from './log.js';
import {
  heartbeatPath,
  sessionDir,
  sessionsBaseDir,
  writeSessionMessage,
  admitDueTaskContexts,
  deferMessageForFreshContextRetry,
} from './session-manager.js';
import { rollupSessionUsage, pruneOldTurnUsage } from './db/usage.js';
import {
  getContainerSpawnedAt,
  hasContainerEverRun,
  getActiveContainerSessionIds,
  isContainerRunning,
  isContainerSpawning,
  killContainer,
  wakeContainer,
} from './container-runner.js';
import {
  SESSION_ARTIFACT_IDLE_MS as STORAGE_SESSION_ARTIFACT_IDLE_MS,
  collectThreadWorktreeActivity,
  pruneIdleSessionArtifacts as pruneIdleSessionArtifactsImpl,
  pruneIdleThreadArtifacts as pruneIdleThreadArtifactsImpl,
  type ThreadWorktreeActivity,
} from './storage-manager.js';
import { startStorageMaintenanceOnce } from './modules/sweep-storage/index.js';
import type { Session } from './types.js';
import { getDb } from './db/connection.js';
import {
  autoArchiveCompletedBefore,
  getActiveTasks,
  transitionToTerminal,
} from './modules/orchestrator-dispatch/db/tasks.js';
import { getCapabilityConfig } from './modules/orchestrator-dispatch/db/agent-group-capabilities.js';
import { runReconcilerSweep } from './modules/orchestrator-dispatch/reconciler.js';
import { decideTaskAction, pendingTerminalSpawnOutboundSeenAt } from './modules/orchestrator-dispatch/watchdog.js';
import { OomKillObserver } from './resource-oom-observer.js';
import { reconcileMergedClaims } from './modules/claims/reconcile.js';
import { sweepClaimsSelfHeal } from './modules/claims/self-heal.js';

const oomKillObserver = new OomKillObserver();

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

// Back-compat export for callers that still reference the old host-sweep
// cleanup threshold. Storage-manager owns the actual cache cleanup policy.
export const SESSION_ARTIFACT_IDLE_MS = STORAGE_SESSION_ARTIFACT_IDLE_MS;

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
function asSessionContext(ctx: SweepTickContext | SweepSessionContext): SweepSessionContext {
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

async function runSlaObservationHooks(
  ctx: SweepSessionContext,
  state: ContainerState | null,
  mailbox: NanoclawMailboxSession,
): Promise<void> {
  for (const hook of slaObservationHooks) {
    await runDutyBody(hook.name, 'session:health:sla-observe', () => hook.run(ctx, state, mailbox));
  }
}

async function runSweepKillFollowUps(
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

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  // Wall-clock when the host spawned the current container. Optional;
  // omit (or pass 0) to disable the grace check. Used to gate the
  // kill-claim path so a fresh container has SPAWN_GRACE_MS to clean its
  // own pre-existing claims before being killed for them.
  spawnedAtMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const spawnedAtMs = args.spawnedAtMs ?? 0;
  const declaredOperationMs = activeOperationTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredOperationMs ?? 0);
    if (heartbeatAge > ceiling) {
      // Skip kill when the stale heartbeat is from a PRIOR container
      // instance AND we're still inside the spawn-grace window. The
      // heartbeat file persists across container restarts at a host-side
      // path mounted into /workspace/.heartbeat — the new container
      // inherits the previous instance's stale mtime until its first
      // poll-loop iteration touches it. Without this, a host restart
      // (or any post-crash respawn for a session whose previous heartbeat
      // had already aged past the ceiling) SIGKILLs the fresh container
      // before the agent-runner can mark itself alive, creating an
      // infinite spawn → kill → respawn loop.
      const inSpawnGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
      const heartbeatFromPriorContainer = spawnedAtMs > 0 && heartbeatMtimeMs < spawnedAtMs;
      if (!(inSpawnGrace && heartbeatFromPriorContainer)) {
        return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
      }
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredOperationMs ?? 0);
  // True only for claims this container could have produced itself; older
  // claims are leftovers from a prior crashed container and the fresh one
  // gets SPAWN_GRACE_MS to clean them on startup before we kill for them.
  const inGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    if (inGrace && claimedAt < spawnedAtMs) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

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
 * Could a container be writing this session's `outbound.db` right now?
 *
 * `outbound.db` has exactly ONE writer. The host may write it only while no
 * container owns it, and "owns it" includes a container that is still
 * SPAWNING — a wake issued a moment ago has not reached `isContainerRunning`
 * yet but is about to hold the file.
 */
function containerOwnsOutbound(sessionId: string): boolean {
  return isContainerRunning(sessionId) || isContainerSpawning(sessionId);
}

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
function writeOutboundWhenStopped<T>(
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
function writeSystemWake(
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

// ─────────────────────────────────────────────────────────────────────────────
// Failed-provider self-heal.
//
// A container whose provider has given up writes provider_status='failed' and
// then sits alive-but-useless until a human notices. Nothing reaps it: it holds
// a claim so the idle reapers pass, and the absolute ceiling only fires after
// 30 more silent minutes and then leaves the session dead until the next ping.
//
// Detection keys on provider_status because it is the only column carrying the
// provider's own "I am done" verdict. Today only the Codex provider ever writes
// it (container/agent-runner/src/providers/codex.ts) — Claude and OpenCode
// never do — so this heals Codex sessions only until they follow. It is
// deliberately NOT built on provider_executing, which has no writer anywhere.
//
// Two consecutive sweep ticks are required so a transition the container
// recovers from on its own never costs it a kill.
// ─────────────────────────────────────────────────────────────────────────────

/** Consecutive `failed` observations required before acting. */
export const PROVIDER_HEAL_CONSECUTIVE_TICKS = 2;
export const PROVIDER_HEAL_MAX_ATTEMPTS = 2;
export const PROVIDER_HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const PROVIDER_HEAL_ID_PREFIX = 'provider-heal-';

// sessionId → consecutive ticks observed with provider_status === 'failed'.
// Mirrors the quietSessions cache above: module-level, host-lifetime, cleared
// by any observation that is not 'failed' (including the container going away,
// so a fresh container never inherits a half-finished debounce).
const providerFailedTicks = new Map<string, number>();

export type ProviderHealDecision = 'none' | 'wait' | 'heal' | 'park';

export function decideProviderHeal(args: {
  alive: boolean;
  providerStatus: string | null | undefined;
  consecutiveFailedTicks: number;
  priorAttempts: number;
  /** Age of the newest provider-heal marker row, or null when there is none. */
  msSinceLastAttempt: number | null;
}): ProviderHealDecision {
  if (!args.alive || args.providerStatus !== 'failed') return 'none';
  if (args.consecutiveFailedTicks < PROVIDER_HEAL_CONSECUTIVE_TICKS) return 'wait';
  if (args.priorAttempts >= PROVIDER_HEAL_MAX_ATTEMPTS) return 'park';
  if (args.msSinceLastAttempt !== null && args.msSinceLastAttempt < PROVIDER_HEAL_COOLDOWN_MS) return 'wait';
  return 'heal';
}

/** Advance (or reset) the two-tick debounce. Returns the new consecutive count. */
export function observeProviderStatus(sessionId: string, providerStatus: string | null | undefined): number {
  if (providerStatus !== 'failed') {
    providerFailedTicks.delete(sessionId);
    return 0;
  }
  const ticks = (providerFailedTicks.get(sessionId) ?? 0) + 1;
  providerFailedTicks.set(sessionId, ticks);
  return ticks;
}

export function countProviderHealAttemptsSinceRealInbound(mailbox: NanoclawMailboxSession): number {
  return mailbox.countRecoveryAttemptsSinceRealInbound(PROVIDER_HEAL_ID_PREFIX);
}

/** Age of the newest provider-heal marker row, or null when there is none. */
export function providerHealLastAttemptAgeMs(mailbox: NanoclawMailboxSession, now: number): number | null {
  const ts = mailbox.latestRecoveryMarkerTimestamp(PROVIDER_HEAL_ID_PREFIX);
  if (!ts) return null;
  const at = parseSqliteUtc(ts);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** Newest provider-heal marker id — the per-episode idempotency key for the parked notice. */
function providerHealLastAttemptId(mailbox: NanoclawMailboxSession): string | null {
  return mailbox.latestRecoveryMarkerId(PROVIDER_HEAL_ID_PREFIX);
}

/**
 * Kill the failed container and queue the accountability wake that respawns it.
 * The wake row is written BEFORE the kill so the attempt is durably counted
 * even if the kill fizzles; on_wake rows are only consumed by a fresh
 * container's first poll, so the dying one cannot steal it.
 */
function applyProviderHeal(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
): void {
  const failureReason = containerState?.provider_failure_reason ?? null;
  let primaryProvider: string | null = null;
  let routedTo: string | null = null;
  try {
    const containerConfig = readContainerConfig(agentGroupFolder);
    const resolveArgs = {
      agentGroupId: session.agent_group_id,
      sessionProvider: session.agent_provider,
      containerConfig,
    };
    primaryProvider = resolveSpawnProvider(resolveArgs).primaryProvider;
    // A group with no declared fallback has nowhere to route, so recording a
    // health window would only delay the honest error an operator needs to see.
    // Owner-approved: respawn on the primary anyway, under the same cap.
    if (containerConfig.providerFallback?.provider && failureReason) {
      markProviderUnavailable(session.agent_group_id, primaryProvider, 'unavailable', { message: failureReason });
    }
    routedTo = resolveSpawnProvider(resolveArgs).provider;
  } catch (err) {
    log.warn('self-heal: provider routing lookup failed — respawning as configured', { sessionId: session.id, err });
  }

  const routedNote =
    routedTo && primaryProvider && routedTo !== primaryProvider ? `; this session is now running on ${routedTo}` : '';
  writeSystemWake(
    mailbox,
    session,
    `${PROVIDER_HEAL_ID_PREFIX}${Date.now()}`,
    `[system] Your previous container was restarted because its provider reported a hard failure` +
      `${failureReason ? ` (${failureReason})` : ''}${routedNote}. Anything in flight was lost. ` +
      `Check your durable checkpoints, resume what is safely resumable, and post ONE message accounting for ` +
      `state — done / lost / next. Re-check any work claims in claims/ before resuming a seam. ` +
      `If nothing was in flight, say so in one line.`,
    { kind: 'agent_provider_heal', provider: primaryProvider, routed_to: routedTo, failure_reason: failureReason },
  );

  log.warn('self-heal: restarting container on failed provider', {
    class: 'failed-provider',
    sessionId: session.id,
    provider: primaryProvider,
    routedTo,
    failureReason,
  });
}

/**
 * The kill half of a provider heal.
 *
 * Split out of `applyProviderHeal` so it can run with NO mailbox session open.
 * `killContainer`'s `onExit` respawns the session, and its status-cleanup hop
 * through `delivery.ts` opens a session of its own — both on THIS key. Running
 * either from inside a session would trip the same-key nesting guard
 * (invariant I-3); the wake row is already durable by the time we get here,
 * which is the ordering the heal has always relied on.
 */
function killForProviderHeal(session: Session): void {
  killContainer(session.id, 'provider-failed-selfheal', () => {
    const fresh = getSession(session.id);
    if (fresh) void wakeContainer(fresh);
  });
}

/**
 * One visible notice when the attempt budget is spent, shaped like
 * notifyContinuationParked. Idempotent per heal episode: the key is the newest
 * marker row's id, which only changes when a fresh heal runs, and real inbound
 * resets the whole budget.
 */
export function notifyProviderHealParked(
  mailbox: NanoclawMailboxSession,
  session: Session,
  failureReason: string | null,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => mailbox.writeOutboundDirect(message),
): boolean {
  const episode = providerHealLastAttemptId(mailbox) ?? 'unknown';
  const marker = `provider_heal_parked:${episode}`;
  if (mailbox.outboundHasContentLike(marker)) return false;
  const routing = mailbox.readSessionRouting();
  if (!routing) return false;
  writeMessage({
    id: `provider-heal-parked-${episode}`,
    kind: 'chat',
    platformId: routing.platform_id,
    channelType: routing.channel_type,
    threadId: routing.thread_id,
    content: JSON.stringify({
      text:
        `⚠️ My agent provider keeps failing${failureReason ? ` (${failureReason})` : ''} and ${PROVIDER_HEAL_MAX_ATTEMPTS} ` +
        `automatic restarts did not fix it. I have stopped retrying. Reply in this thread and I will try again.`,
      _system: { kind: marker, failure_reason: failureReason },
    }),
  });
  return true;
}

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

/**
 * Detection + action for one alive session. Always advances the debounce;
 * acts only when NANOCLAW_SELF_HEAL is armed. Returns true when the container
 * was killed, so the caller skips the reap/SLA checks for this tick.
 *
 * `containerState` is read by the caller (it needs it for the reap decisions
 * too); everything else this needs is read inside its own short session, and
 * every kill happens between two of them.
 */
async function sweepProviderHeal(
  run: SessionRunner,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[3],
): Promise<boolean> {
  const providerStatus = containerState?.provider_status ?? null;
  const consecutiveFailedTicks = observeProviderStatus(session.id, providerStatus);
  const budget = await run((mailbox) => ({
    priorAttempts: countProviderHealAttemptsSinceRealInbound(mailbox),
    msSinceLastAttempt: providerHealLastAttemptAgeMs(mailbox, Date.now()),
  }));
  if (!budget) return false;
  const { priorAttempts, msSinceLastAttempt } = budget;
  const decision = decideProviderHeal({
    alive: true,
    providerStatus,
    consecutiveFailedTicks,
    priorAttempts,
    msSinceLastAttempt,
  });
  if (decision === 'none' || decision === 'wait') return false;

  const bounds = {
    class: 'failed-provider',
    sessionId: session.id,
    providerStatus,
    consecutiveFailedTicks,
    priorAttempts,
    maxAttempts: PROVIDER_HEAL_MAX_ATTEMPTS,
    msSinceLastAttempt,
    cooldownMs: PROVIDER_HEAL_COOLDOWN_MS,
    failureReason: containerState?.provider_failure_reason ?? null,
  };
  if (!SELF_HEAL_ENABLED) {
    log.info(`self-heal: would ${decision} failed provider`, bounds);
    return false;
  }

  if (decision === 'park') {
    // Kill first, then post: outbound.db has exactly one writer, and the
    // container must be confirmed stopped before the host writes to it (same
    // ordering as the kill-ceiling notice). No onExit — parked means no
    // respawn until real inbound resets the budget.
    log.warn('self-heal: provider heal budget exhausted — parking', bounds);
    killContainer(session.id, 'provider-failed-selfheal-parked');
    try {
      await run((mailbox) => {
        // Same yield boundary as the kill-ceiling notice: the park kill is
        // above, this session opened after it, and a respawn in that gap owns
        // outbound.db. The notice is one-per-episode and idempotent, so
        // skipping it costs nothing a later tick cannot redo.
        return writeOutboundWhenStopped(session, mailbox, () =>
          notifyProviderHealParked(
            mailbox,
            session,
            containerState?.provider_failure_reason ?? null,
            writeParkedMessage,
          ),
        );
      });
    } catch (err) {
      log.warn('self-heal: parked notice failed', { sessionId: session.id, err });
    }
    return true;
  }

  // Wake row first (durably counted even if the kill fizzles), session closed,
  // then the kill and its respawn.
  const wrote = await run((mailbox) => {
    applyProviderHeal(mailbox, session, agentGroupFolder, containerState);
    return true;
  });
  if (!wrote) return false;
  killForProviderHeal(session);
  return true;
}

/** Test-only entry point over an injected session. */
export function _sweepProviderHealForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[3],
): Promise<boolean> {
  return sweepProviderHeal(
    async (action) => action(mailbox),
    session,
    agentGroupFolder,
    containerState,
    writeParkedMessage,
  );
}

/** Test-only: clear the module-level two-tick debounce between cases. */
export function _resetProviderHealTicksForTesting(): void {
  providerFailedTicks.clear();
}

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
  // Both helpers still take a raw handle and live in files this PR must not
  // touch — both belong to PR 4, the ingress family (plan §5):
  // `modules/scheduling/host-script.ts` and `session-manager.ts`. Handing them
  // this session's own handle
  // keeps the admission seam on ONE open — reopening inbound.db beside a live
  // session would be worse, not cleaner. Both move behind the seam with their
  // own PRs; `legacyInboundHandle` is what keeps host-sweep.ts on the
  // raw-access allowlist until they do.
  await runHostGatedTaskScripts(mailbox.legacyInboundHandle(), sessionId);
  const admittedTasks = admitDueTaskContexts(mailbox.legacyInboundHandle(), agentGroupId, sessionId);
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

// ─── Scheduled-move recovery + audit-body prune (D3 / D4) ─────────────────────

interface MoveRecoveryOptions {
  /** Sessions root parent; defaults to the real DATA_DIR's parent of v2-sessions. */
  dataDir?: string;
  nowMs?: number;
}

// TaskRowSnapshot fields, parsed from the intent's detail_json (A-1: a type
// alias, not an empty-extends interface — clears the lone no-empty-interface lint).
type MoveIntentSnapshot = TaskRowSnapshot;

/**
 * Resolve the target channel-root session id (thread_id IS NULL, active) for a
 * (targetAgentGroupId, targetMessagingGroupId) pair from the central DB.
 * Defensive: returns null on any error (e.g. the `sessions` table is absent in a
 * minimal test DB, or no session exists yet because the move crashed before the
 * target insert). A null target session contributes 0 to the scoped count.
 */
function resolveTargetSessionId(
  centralDb: Database.Database,
  targetAgentGroupId: string,
  targetMessagingGroupId: string,
): string | null {
  try {
    const row = centralDb
      .prepare(
        "SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active' LIMIT 1",
      )
      .get(targetAgentGroupId, targetMessagingGroupId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

interface ParsedIntentDetail {
  snapshot: MoveIntentSnapshot | null;
  targetAgentGroupId: string | null;
  targetMessagingGroupId: string | null;
}

function parseIntentDetail(detailJson: string | null): ParsedIntentDetail {
  if (!detailJson) return { snapshot: null, targetAgentGroupId: null, targetMessagingGroupId: null };
  try {
    const d = JSON.parse(detailJson) as {
      snapshot?: MoveIntentSnapshot;
      targetAgentGroupId?: string;
      targetMessagingGroupId?: string;
    };
    return {
      snapshot: d.snapshot ?? null,
      targetAgentGroupId: typeof d.targetAgentGroupId === 'string' ? d.targetAgentGroupId : null,
      targetMessagingGroupId: typeof d.targetMessagingGroupId === 'string' ? d.targetMessagingGroupId : null,
    };
  } catch {
    return { snapshot: null, targetAgentGroupId: null, targetMessagingGroupId: null };
  }
}

/**
 * Consume unresolved `move_intent` rows older than one sweep interval (D3).
 *
 * SCOPED predicate (M1): the live-row count is taken over EXACTLY {source
 * session, target session} — never a bare-series_id fleet scan that an unrelated
 * group reusing the same series_id could falsely satisfy. A crash BEFORE the
 * move's cancel leaves the SOURCE live; a crash after a successful target insert
 * leaves the TARGET live. If either holds a live row → stamp + purge (the move
 * resolved itself), never restore (would double the live rows). If the scoped
 * count is a readable ZERO → restore the source from the snapshot, re-checking
 * zero-live immediately before the insert (idempotent compensation, M10).
 *
 * FAIL-SAFE (F6 / M2): if the scoped count is UNREADABLE, the live state is
 * UNKNOWN — skip this intent this pass (leave it unresolved for a clean later
 * pass), NEVER restore on unknown.
 *
 * ADV-S2: an intent that can NEVER be restored (no snapshot body, or the source
 * inbound.db is gone) is RESOLVED (resolved_at stamped) rather than surfacing
 * forever as an unclearable 'stalled' repair row.
 *
 * Autonomous, not just observable. Additive — no firing-path change (C1).
 */
export function recoverMoveIntents(centralDb: Database.Database, options: MoveRecoveryOptions): void {
  const nowMs = options.nowMs ?? Date.now();
  const dataDir = options.dataDir ?? path.dirname(sessionsBaseDir());
  const sessionsRoot = options.dataDir ? path.join(options.dataDir, 'v2-sessions') : sessionsBaseDir();

  let intents: Array<{
    session_id: string;
    agent_group_id: string;
    series_id: string;
    detail_json: string | null;
    correlation_id: string | null;
    ts: string;
  }>;
  try {
    intents = centralDb
      .prepare(
        `SELECT session_id, agent_group_id, series_id, detail_json, correlation_id, ts
           FROM scheduled_audit
          WHERE action = 'move_intent' AND resolved_at IS NULL`,
      )
      .all() as typeof intents;
  } catch {
    // Table absent (feature not installed) — nothing to recover.
    return;
  }

  for (const intent of intents) {
    const tsMs = parseSqliteUtc(intent.ts);
    // Only act on intents older than one sweep interval — the normal in-flight
    // window is seconds; younger ones are likely still executing.
    if (Number.isNaN(tsMs) || nowMs - tsMs <= SWEEP_INTERVAL_MS) continue;
    if (!intent.correlation_id) continue;

    const detail = parseIntentDetail(intent.detail_json);
    const source = { agentGroupId: intent.agent_group_id, sessionId: intent.session_id };
    const targetSessionId =
      detail.targetAgentGroupId && detail.targetMessagingGroupId
        ? resolveTargetSessionId(centralDb, detail.targetAgentGroupId, detail.targetMessagingGroupId)
        : null;
    const target =
      detail.targetAgentGroupId && targetSessionId
        ? { agentGroupId: detail.targetAgentGroupId, sessionId: targetSessionId }
        : null;

    // Scoped {source, target} live count — M1 (never a fleet-wide series scan).
    const live = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
    if (live.unreadable) {
      // Live state UNKNOWN → skip this pass (leave unresolved). Never restore on
      // unknown (F6 / M2).
      log.warn('scheduled-move-recovery: scoped live count unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    if (live.count > 0) {
      // A live row exists at source or target → the move's row landed; the intent
      // breadcrumb has done its job. Stamp + purge; never restore (would double the
      // live rows).
      if (live.count > 1) {
        // >1 = a PRE-EXISTING duplicate the move inherited (it didn't create it — the
        // move's E-2 invariant already returned 500 and refused to claim success).
        // We resolve the intent WITHOUT auto-deduping: deleting a row the move didn't
        // own is its own data-loss risk, and leaving it unresolved would reintroduce
        // the ADV-S2 zombie repair row. The board's duplicate-successor health detector
        // surfaces the duplicate independently. Log it so it isn't silently swallowed.
        log.warn(
          'scheduled-move-recovery: >1 live row for series — pre-existing duplicate, resolving intent without dedup (surfaced via duplicate-successor health)',
          { seriesId: intent.series_id, correlationId: intent.correlation_id, liveCount: live.count },
        );
      }
      purgeIntentBody(centralDb, intent.correlation_id);
      continue;
    }

    // Zero live rows in scope → restore the source from the snapshot.
    if (!detail.snapshot) {
      // ADV-S2: body lost (purged but still unresolved) — unrecoverable. RESOLVE
      // it (stamp) so it does not surface forever as an unclearable repair row.
      log.warn('scheduled-move-recovery: unresolved intent with no snapshot — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      purgeIntentBody(centralDb, intent.correlation_id);
      continue;
    }

    const inboundPath = path.join(sessionsRoot, intent.agent_group_id, intent.session_id, 'inbound.db');
    if (!fs.existsSync(inboundPath)) {
      // ADV-S2: the source session is gone — cannot restore. RESOLVE so it does
      // not zombie as a permanent stalled repair row.
      log.warn('scheduled-move-recovery: source inbound.db missing — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      purgeIntentBody(centralDb, intent.correlation_id);
      continue;
    }
    const snapshot = detail.snapshot;
    let db: Database.Database | null = null;
    try {
      db = openInboundDbByPath(inboundPath);
      // Idempotency re-check: the restore + the resolved_at stamp span two DB
      // files (not atomic), so re-confirm a readable zero-live IMMEDIATELY before
      // insert. An unreadable re-check defers (never restore on unknown).
      const recheck = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
      if (recheck.unreadable) {
        log.warn('scheduled-move-recovery: re-check unreadable — deferring restore', {
          seriesId: intent.series_id,
        });
        continue;
      }
      if (recheck.count === 0) {
        restoreTaskRow(db, {
          // Fresh id — the cancelled source row may still hold the snapshot id.
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          series_id: snapshot.series_id,
          status: snapshot.status,
          process_after: snapshot.process_after,
          recurrence: snapshot.recurrence,
          content: snapshot.content,
          platform_id: snapshot.platform_id,
          channel_type: snapshot.channel_type,
          thread_id: snapshot.thread_id,
          kind: snapshot.kind,
        });
      }
    } catch (err) {
      log.error('scheduled-move-recovery: restore failed', {
        seriesId: intent.series_id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    } finally {
      db?.close();
    }
    // Stamp + purge AFTER the restore (so a crash before this makes the next
    // pass re-evaluate; now a live row exists → it stamps without re-restoring).
    purgeIntentBody(centralDb, intent.correlation_id);
  }
}

const AUDIT_BODY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Prune `scheduled_audit` bodies older than 90 days (D4): NULL the
 * `before_preview`/`after_preview`/`detail_json` columns ONLY, keeping the
 * action-metadata row (actor/action/ts/hashes/correlation_id/resolved_at) for
 * the series' lifetime. This bounds the plaintext footprint while preserving
 * cancel-vs-completed distinguishability (the `action='cancel'` join, §4.3)
 * indefinitely. Design §4.4 retention.
 */
export function pruneAuditBodies(centralDb: Database.Database, options: { nowMs?: number }): void {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - AUDIT_BODY_RETENTION_MS).toISOString();
  try {
    centralDb
      .prepare(
        `UPDATE scheduled_audit
            SET before_preview = NULL, after_preview = NULL, detail_json = NULL
          WHERE ts < ?
            AND (before_preview IS NOT NULL OR after_preview IS NOT NULL OR detail_json IS NOT NULL)`,
      )
      .run(cutoff);
  } catch {
    // Table absent — nothing to prune.
  }
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
    // being killed on its first 'failed' observation.
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
 * Test-only entry point for the running-container SLA, including both post-kill
 * write paths. Builds the minimum session context the duty reads: the SLA and
 * its follow-ups touch `session`, `agentGroupId`, `agentGroupFolder` and the
 * two window openers, nothing else.
 */
export function _enforceRunningContainerSlaForTesting(
  run: SessionRunner,
  session: Session,
  agentGroupId: string,
  agentGroupFolder: string,
): Promise<void> {
  const ctx: SweepSessionContext = {
    now: Date.now(),
    sessions: [session],
    activeContainerSessionIds: new Set<string>(),
    session,
    agentGroupId,
    agentGroupFolder,
    mailbox: null,
    hasOutbound: true,
    alive: true,
    justWoke: false,
    plan: {
      dueCount: 0,
      wakePriority: 'interactive',
      admittedTasks: 0,
      workContinuation: null,
      continuationWakeEligible: false,
      hasOutbound: true,
    },
    observed: null,
    killSnapshot: null,
    run,
    runIn: (_window, action) => run(action),
    reportWoke: () => {},
  };
  return enforceRunningContainerSla(ctx);
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

// ── Usage rollup (fleet-hardening Phase 0.1) ──
//
// Per-session cache of the outbound.db mtime last successfully rolled up, so
// a session whose outbound.db hasn't changed since the last tick costs one
// fs.statSync and nothing else — no DB open, no query. Same shape as the
// `quietSessions` cache above (module-level Map, bounded to sessions still
// active). Lost on host restart, which just means the next tick re-checks
// every session once; rollupSessionUsage's own watermark still guarantees no
// double-counting either way.
const usageRollupMtimeCache = new Map<string, number>(); // session.id -> outbound.db mtimeMs

/** Pure so the cache decision has one thing to unit-test. */
export function shouldSkipUsageRollup(cachedMtimeMs: number | undefined, currentMtimeMs: number): boolean {
  return cachedMtimeMs === currentMtimeMs;
}

async function sweepUsageRollup(sessions: readonly Session[]): Promise<void> {
  for (const session of sessions) {
    try {
      const outPath = sessionMailboxPath({ agentGroupId: session.agent_group_id, sessionId: session.id }, 'outbound');
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(outPath).mtimeMs;
      } catch {
        continue; // container never spawned yet — no outbound.db to roll up
      }
      if (shouldSkipUsageRollup(usageRollupMtimeCache.get(session.id), mtimeMs)) continue;

      // Read through the module's own outbound funnel, NOT the mailbox
      // session. This projection touches outbound.db only, and the seam's
      // existence check is keyed on inbound.db — routing it through a session
      // added a gate the pre-seam code never had, so a session whose
      // inbound.db is gone while outbound.db remains stopped being rolled up
      // at all, and its turn_usage rows would never reach the central totals.
      // `outPath` above is already the gate that belongs here: no outbound
      // file, no rollup. Same funnel `worktree-cleanup.ts` and the GC use, so
      // there is still one implementation of every statement.
      const outDb = openOutboundDb(outPath);
      try {
        rollupSessionUsage(outDb, session.agent_group_id, `${session.agent_group_id}/${session.id}`);
      } finally {
        outDb.close();
      }
      usageRollupMtimeCache.set(session.id, mtimeMs);
    } catch (err) {
      log.warn('Usage rollup failed for session', { err, sessionId: session.id });
    }
  }
  // Bound the cache to sessions that still exist, mirroring the quietSessions
  // cleanup above — closed sessions would otherwise accumulate forever.
  if (usageRollupMtimeCache.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of usageRollupMtimeCache.keys()) if (!live.has(id)) usageRollupMtimeCache.delete(id);
  }
}

const DEFAULT_NO_PROGRESS_TIMEOUT_SEC = 1800;
const DEFAULT_SPAWN_DEADLINE_SEC = 300;
const DEFAULT_DRAIN_GRACE_SEC = 120;

const ACTION_TO_FAIL_REASON: Record<string, string> = {
  'fail-deadline': 'deadline_exceeded',
  'fail-no-progress': 'no_progress_timeout',
  'fail-container-exit': 'container_exit',
  'fail-spawn-deadline': 'spawn_deadline',
};

async function sweepTaskWatchdog(): Promise<void> {
  let tasks;
  try {
    tasks = getActiveTasks();
  } catch (err) {
    log.error('Task watchdog: failed to load active tasks', { err });
    return;
  }

  const now = Date.now();

  for (const task of tasks) {
    try {
      // Get child container status from in-memory container set.
      //
      // Three-state, not two. `'stopped'` means "ran and has since exited" —
      // ONLY then is `fail-container-exit` a correct reap. `null` covers two
      // legitimately-not-failed cases: (a) container hasn't been spawned yet
      // because the orchestrator's concurrency cap is queueing it, (b) wake
      // is in flight. Both look identical to `isContainerRunning` (returns
      // false) but neither should reap. `hasContainerEverRun` is the sticky
      // signal that disambiguates — set when activeContainers.add fires,
      // never cleared, so true iff this host has observed the container
      // running at some point in this process lifetime.
      let childContainerStatus: 'running' | 'stopped' | null = null;
      if (task.child_session_id !== null) {
        if (isContainerRunning(task.child_session_id)) {
          childContainerStatus = 'running';
        } else if (hasContainerEverRun(task.child_session_id)) {
          childContainerStatus = 'stopped';
        } else {
          childContainerStatus = null;
        }
      }

      // Check child's outbound.db for pending terminal spawn actions (drain-first guard).
      // Self-orchestration: child session lives in the SAME agent group as the parent,
      // so the lookup uses parent_agent_group_id.
      const terminalOutboundSeenAt =
        task.child_session_id !== null
          ? pendingTerminalSpawnOutboundSeenAt(task.parent_agent_group_id, task.child_session_id)
          : null;

      // Pull per-orchestrator timeout config; fall back to defaults when absent.
      const cap = getCapabilityConfig(task.parent_agent_group_id, 'orchestrator');
      const noProgressTimeoutSec = cap?.noProgressTimeoutSec ?? DEFAULT_NO_PROGRESS_TIMEOUT_SEC;
      const spawnDeadlineSec = cap?.spawnDeadlineSec ?? DEFAULT_SPAWN_DEADLINE_SEC;
      const drainGraceSec = cap?.drainGraceSec ?? DEFAULT_DRAIN_GRACE_SEC;

      const decision = decideTaskAction({
        now,
        task,
        childContainerStatus,
        terminalOutboundSeenAt,
        noProgressTimeoutSec,
        spawnDeadlineSec,
        drainGraceSec,
      });

      if (decision.action === 'ok') continue;

      const nowIso = new Date(now).toISOString();
      const failReason = ACTION_TO_FAIL_REASON[decision.action] ?? decision.action;
      if (!(decision.action in ACTION_TO_FAIL_REASON)) {
        log.warn('Task watchdog: unknown action, using raw value as fail_reason', { action: decision.action });
      }
      const transitioned = transitionToTerminal(task.task_id, 'failed', {
        fail_reason: failReason,
        failed_at: nowIso,
      });

      if (!transitioned) {
        // Already in terminal state (race with reconciler or another path) — skip notify.
        log.debug('Task watchdog: task already terminal, skipping notify', { taskId: task.task_id });
        continue;
      }

      // Dashboard SSE emit (post-build drift fix B5 — watchdog-fail emit callsite)
      void import('./dashboard/api/events.js')
        .then((mod) =>
          mod.emitDashboardEvent('task_event', {
            task_id: task.task_id,
            kind: 'failed',
            agent_group_id: task.parent_agent_group_id,
          }),
        )
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });

      log.warn('Task watchdog: reaped task', {
        taskId: task.task_id,
        reason: decision.action,
        parentAgentGroupId: task.parent_agent_group_id,
        parentSessionId: task.parent_session_id,
      });

      const parentSession = getSession(task.parent_session_id);
      if (!parentSession) continue;

      try {
        // Mirror applySpawnFailed's notify shape — kind='chat' with visible
        // `text` so the orchestrator sees a normal turn input and reports
        // the failure to the user. The prior `kind='system'` envelope
        // (action `spawn_task_watchdog_fail`) had no consumer anywhere in
        // the codebase — it sat silently in the parent's inbound and no
        // human was ever told the task failed. The `_task_update` envelope
        // keeps the machine-readable surface for any future consumer that
        // wants to react to status transitions without parsing the text.
        await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
          id: randomUUID(),
          kind: 'chat',
          timestamp: nowIso,
          content: JSON.stringify({
            text:
              `Task failed (watchdog): ${task.task_id}. Reason: ${failReason}. ` +
              `The orchestrator should notify the user and decide whether to re-spawn.`,
            _task_update: {
              task_id: task.task_id,
              status: 'failed',
              fail_reason: failReason,
              source: 'watchdog',
            },
          }),
        });
        void wakeContainer(parentSession).catch((err) =>
          log.warn('Task watchdog: wakeContainer(parent) failed', { taskId: task.task_id, err }),
        );
      } catch (err) {
        log.warn('Task watchdog: failed to notify parent', { taskId: task.task_id, err });
      }
    } catch (err) {
      log.error('Task watchdog: error processing task', { taskId: task.task_id, err });
    }
  }
}

/**
 * Auto-archive completed tasks older than 24h. Failed tasks are excluded
 * deliberately — operator must dismiss them explicitly so they stay
 * visible until acknowledged. No per-row SSE emit: the volume is "every
 * `done` card from yesterday at once," which would flood the bus; the
 * next dashboard list refresh picks the change up naturally.
 */
const COMPLETED_AUTO_ARCHIVE_AGE_HOURS = 24;

export function autoArchiveOldCompleted(): void {
  try {
    const cutoff = new Date(Date.now() - COMPLETED_AUTO_ARCHIVE_AGE_HOURS * 60 * 60 * 1000).toISOString();
    const count = autoArchiveCompletedBefore(cutoff);
    if (count > 0) log.info('Auto-archived completed tasks', { count });
  } catch (err) {
    log.warn('autoArchiveOldCompleted: failed', { err });
  }
}

export function pruneIdleSessionArtifacts(now: number = Date.now(), root: string = sessionsBaseDir()): void {
  pruneIdleSessionArtifactsImpl(now, root, isContainerRunning);
}

export function pruneIdleThreadArtifacts(
  now: number = Date.now(),
  root: string = path.join(path.dirname(sessionsBaseDir()), 'v2-threads'),
  activityByWorktreeDir: Map<string, ThreadWorktreeActivity> = collectThreadWorktreeActivity(isContainerRunning),
): void {
  pruneIdleThreadArtifactsImpl(now, root, activityByWorktreeDir);
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function activeOperationTimeoutMs(state: ContainerState | null): number | null {
  if (!state || (state.current_tool !== 'Bash' && state.current_tool !== 'CodexItem')) return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

async function enforceRunningContainerSla(ctx: SweepSessionContext): Promise<void> {
  const session = ctx.session;
  // Read + the observation hooks in one session, so the decision and the
  // telemetry row see the same snapshot. The kill below then runs with nothing
  // open (invariant I-3).
  const observed = await ctx.runIn('session:health:sla-observe', async (mailbox) => {
    const containerState = mailbox.getContainerState();
    await runSlaObservationHooks(ctx, containerState, mailbox);
    const decision = decideStuckAction({
      now: Date.now(),
      heartbeatMtimeMs: heartbeatMtimeMs(ctx.agentGroupId, session.id),
      containerState,
      claims: mailbox.getProcessingClaimRows(),
      spawnedAtMs: getContainerSpawnedAt(session.id),
    });
    // Snapshot BEFORE the kill so the follow-ups have the pre-kill state —
    // resetStuckProcessingRows clears the claims, so a read afterward would
    // always be empty.
    return {
      containerState,
      decision,
      pendingClaims: decision.action === 'kill-ceiling' ? mailbox.getProcessingClaimRows().length : 0,
      workContinuation: decision.action === 'kill-ceiling' ? mailbox.readWorkContinuation() : null,
    };
  });
  if (!observed) return;
  const { containerState, decision, pendingClaims, workContinuation } = observed;

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    // The follow-ups run AFTER the kill, in a session opened only then, to
    // honor the outbound.db single-writer invariant; the module opens the
    // writable outbound handle lazily, only for the notice write.
    //
    // The kill above is a yield boundary: this session opened after it, and a
    // replacement wake landing in that gap owns outbound.db. Upstream guards
    // that with ONE `writeOutboundWhenStopped` around all three follow-ups,
    // which is sound there because they are one synchronous block. Here the
    // registry runs them as separate awaited duties, so a single check would
    // authorize writes two yields later — each follow-up guards its OWN write
    // instead (`registerBuiltInSweepDuties`, the three post-kill registrations).
    await ctx.runIn('session:health:post-kill', (mailbox) =>
      runSweepKillFollowUps(ctx, decision, mailbox, {
        reason: 'absolute-ceiling',
        containerState,
        pendingClaims,
        workContinuation,
      }),
    );
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  // Same yield boundary as the ceiling branch above; same per-follow-up guard.
  await ctx.runIn('session:health:post-kill', (mailbox) =>
    runSweepKillFollowUps(ctx, decision, mailbox, {
      reason: 'claim-stuck',
      containerState,
      pendingClaims,
      workContinuation,
    }),
  );
}

/**
 * Turn cgroup memory telemetry into something the AGENT can act on.
 *
 * The kernel kills children inside the cgroup, never PID 1, so the container
 * survives and nothing surfaces: agents read an OOM-killed chromium as "the
 * browser crashed", an OOM-killed `npm ci` as "probably buffering", and
 * vanished MCP servers as "infrastructure instability". Reconstructed
 * transcripts show they diagnose it correctly the moment they are TOLD — so
 * the notice below is the whole fix; the detection already worked and just
 * ended in a log file nobody in the container can read.
 *
 * The row is onWake=0 (the container is alive — this path only runs for
 * running containers) and trigger=0 via insertDeferredMessageWithContextIfNew,
 * so it can never wake a dead container; it rides along with the next real
 * message or the next turn.
 */
function reportContainerOomTelemetry(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  state: ContainerState | null,
): void {
  if (typeof state?.memory_oom_kill_events !== 'number' && typeof state?.memory_max_events !== 'number') return;
  const spawnedAtMs = getContainerSpawnedAt(session.id);
  const decision = oomKillObserver.observe(session.id, spawnedAtMs, {
    oomKillCount: state.memory_oom_kill_events,
    pressureCount: state.memory_max_events,
    now: Date.now(),
  });

  let configuredLimitMb: number | null = null;
  try {
    configuredLimitMb = resolveContainerResources(readContainerConfig(agentGroupFolder).resources).memory.limitMb;
  } catch {
    // Resource validation already fails closed in the spawn path. Keep OOM
    // diagnostics available even if an operator edits the file mid-run.
  }
  const cgroupMaxMb =
    typeof state.memory_max_bytes === 'number' ? Math.round(state.memory_max_bytes / 1024 / 1024) : null;
  const limitMb = configuredLimitMb ?? cgroupMaxMb;
  const limitText = limitMb === null ? 'its memory limit' : `its ${limitMb} MB memory limit`;

  if (decision.killDelta > 0) {
    log.warn('Container cgroup OOM kill observed', {
      sessionId: session.id,
      agentGroup: agentGroupFolder,
      newOomKills: decision.killDelta,
      oomKillCount: decision.killCount,
      oomEventCount: state.memory_oom_events ?? null,
      memoryPressureEvents: decision.pressureCount,
      notifiedAgent: decision.notifyKills,
      configuredLimitMb,
      cgroupMaxMb,
      peakMb: typeof state.memory_peak_bytes === 'number' ? Math.round(state.memory_peak_bytes / 1024 / 1024) : null,
      currentMb:
        typeof state.memory_current_bytes === 'number' ? Math.round(state.memory_current_bytes / 1024 / 1024) : null,
      telemetryAt: state.memory_telemetry_at ?? null,
    });
  }

  if (decision.notifyKills) {
    const plural = decision.killCount === 1 ? 'process' : 'processes';
    writeSystemWake(
      mailbox,
      session,
      `oom-kill-${spawnedAtMs}-${decision.killCount}`,
      `[system] The Linux kernel has killed ${decision.killCount} ${plural} inside this container for exceeding ` +
        `${limitText}, which is shared by EVERY process here — your agent, MCP servers, browsers, test runners, ` +
        `builds. Your container itself survived, so nothing reported an error to you. The cgroup exposes only a ` +
        `counter, so the names of the killed processes are not available. Symptoms this explains: a command exiting ` +
        `with no output or a bare non-zero status, npm/pnpm installs dying silently, a browser or MCP server ` +
        `disappearing mid-run, test failures that do not reproduce. Remedy: cut in-container parallelism ` +
        `(jest --maxWorkers=2, vitest poolOptions.maxThreads, make -j2), do not run installs or suites concurrently, ` +
        `close browser sessions when done, and write large output to a file instead of buffering it. Do NOT retry ` +
        `the same command unchanged — it will be killed again.`,
      { kind: 'agent_container_oom', oom_kill_count: decision.killCount, memory_limit_mb: limitMb },
      0,
    );
    return;
  }

  if (decision.notifyPressure) {
    log.warn('Container memory pressure without kills', {
      sessionId: session.id,
      agentGroup: agentGroupFolder,
      memoryPressureEvents: decision.pressureCount,
      configuredLimitMb,
      cgroupMaxMb,
    });
    writeSystemWake(
      mailbox,
      session,
      `oom-pressure-${spawnedAtMs}`,
      `[system] This container has hit ${limitText} ${decision.pressureCount} times and had to reclaim memory to ` +
        `stay under it. Nothing has been killed yet — this is the warning before that. The limit is shared by every ` +
        `process here. If you are about to run something memory-heavy (a full test suite, a build, a browser, a ` +
        `large install), reduce its parallelism now rather than after the kernel starts killing processes.`,
      { kind: 'agent_container_memory_pressure', memory_pressure_events: decision.pressureCount },
      0,
    );
  }
}

export { reportContainerOomTelemetry as _reportContainerOomTelemetryForTesting };

export function _resetStuckProcessingRowsForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(mailbox, session, reason);
}

export { sweepTaskWatchdog as _sweepTaskWatchdogForTesting };

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
      deferMessageForFreshContextRetry(mailbox.legacyInboundHandle(), msg.id, backoffSec);
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

  // ── tick:pre-session ───────────────────────────────────────────────────────

  registerSweepDuty({
    name: id.T2,
    phase: 'tick:pre-session',
    order: 10,
    run: () => {
      // Re-heal the egress network so already-running agents keep their gateway
      // hop if it was detached out-of-band. Best-effort here: a heal failure
      // isn't a leak (agents stay on the internal net), so log and continue.
      // No-op when lockdown is disabled.
      try {
        ensureEgressNetwork();
      } catch (err) {
        log.error('Egress lockdown re-heal failed', { err });
      }
    },
  });

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
    // Still a raw-handle callee: `dashboard/thread-close.ts` moves behind the
    // seam in PR 4, and this line becomes `syncDoneProposalMirror(session.id)`
    // then. It only reads. Guarded on `hasOutbound` because a raw handle is the
    // one thing the module cannot degrade for a never-woken session.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (mailbox!.hasOutbound()) {
        try {
          syncDoneProposalMirror(session.id, mailbox!.legacyOutboundHandle());
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
        const woke = await wakeContainer(session, plan.wakePriority);
        c.reportWoke(woke);
        if (!woke && resumedContinuation) {
          await restoreStoppedContinuationAttempt(wakeRun, session, resumedContinuation, plan.workContinuation!);
        }
      }
    },
  });

  // ── session:health (W4) — EXCLUSIVE, nothing open ──────────────────────────

  registerSweepDuty({
    name: id.S11,
    phase: 'session:health',
    order: 10,
    // 6a. Failed-provider self-heal. Runs first: a container whose provider has
    // given up is not idle and not merely stuck, and healing it beats both
    // reaping it as idle and waiting out the 30-minute ceiling. Returns true
    // only when it killed the container, in which case the reap/SLA checks
    // below have nothing left to decide this tick — which is exactly the
    // `claims()` contract of an exclusive phase.
    claims: (ctx) =>
      sweepProviderHeal(ctx.run, ctx.session, ctx.agentGroupFolder, ctx.observed?.containerState ?? null),
    run: (ctx) => {
      log.debug('Provider self-heal handled this tick — skipping reap/SLA checks', {
        sessionId: asSessionContext(ctx).session.id,
      });
    },
  });

  // S12 (idle-task-reap) and S13 (idle-chat-reap) register from
  // src/modules/sweep-idle-reap/index.ts (seam 2, S2-PR3) at order 20/30 —
  // between this heal duty and the SLA fallthrough below. Do not re-add them
  // here; see plan.md §8 "S2-PR3 — idle reaps".

  registerSweepDuty({
    name: id.S14,
    phase: 'session:health',
    order: 40,
    // 6. Running-container SLA: absolute ceiling + per-claim stuck rules. The
    // fallthrough — no claims(), so it runs when nothing above it claimed.
    run: (ctx) => enforceRunningContainerSla(asSessionContext(ctx)),
  });

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
    // Still a raw-handle callee: `modules/scheduling/recurrence.ts` moves behind
    // the seam in PR 4.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
      await handleRecurrence(mailbox!.legacyInboundHandle(), session);
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

  registerSweepDuty({
    name: id.T6,
    phase: 'tick:post-session',
    order: 10,
    // MODULE-HOOK:orchestrator-dispatch:reconciler — complete
    // admitted-but-incomplete tasks. Runs after per-session sweeps so container
    // state is current. Carries no guard of its own: it was the earliest
    // unguarded call in the old tick body, and the phase runner is now the
    // guard that keeps its throw from costing every duty behind it.
    run: () => {
      runReconcilerSweep();
    },
  });

  registerSweepDuty({
    name: id.T8,
    phase: 'tick:post-session',
    order: 20,
    // Advance operator-confirmed thread closes: wait for the agent's wrap-up
    // confirmation, then clear its saved work, stop the container and archive —
    // in that order (src/dashboard/thread-close.ts). Central-DB scan of the few
    // in-flight rows, once per tick, after the per-session loop so container
    // state is current. Nothing here can START a close; only an operator can.
    run: () => {
      try {
        advanceThreadClosures();
      } catch (err) {
        log.warn('thread-close sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T18,
    phase: 'tick:post-session',
    order: 25,
    // MODULE-HOOK:orchestrator-dispatch:watchdog — reap tasks that have exceeded
    // their deadline, spawn window, no-progress timeout, or whose child
    // container exited.
    run: () => sweepTaskWatchdog(),
  });

  registerSweepDuty({
    name: id.T13,
    phase: 'tick:post-session',
    order: 30,
    // Reclaim disk from idle caches and Docker artifacts after per-session sweep
    // work has had a chance to notice and wake due messages. Fire-and-forget
    // into a persistent worker. The worker owns the expensive synchronous
    // filesystem/Docker implementation and its cadence state; the host event
    // loop stays available for channel heartbeats and inbound events.
    run: (ctx) => {
      startStorageMaintenanceOnce([...ctx.activeContainerSessionIds]);
    },
  });

  registerSweepDuty({
    name: id.T19,
    phase: 'tick:post-session',
    order: 40,
    // Fleet-hardening Phase 0.1 (per-turn usage accounting): roll per-session
    // turn_usage rows into the central usage_daily table for `ncl usage`. Reuses
    // the same `sessions` list the per-session loop above already fetched — no
    // extra DB query. Isolated so a rollup failure never blocks the rest of the
    // tick. `pruneOldTurnUsage` is its companion, not a separate duty: fleet
    // volume is ~300-600 turns/day, so trimming the ledger the rollup just fed
    // is trivial per-tick cost.
    run: async (ctx) => {
      try {
        await sweepUsageRollup(ctx.sessions);
      } catch (err) {
        log.warn('Usage rollup sweep step failed', { err });
      }
      pruneOldTurnUsage();
    },
  });

  // T22 (orphaned-repo-fence-release) moved to src/modules/sweep-repo-fence/
  // (seam 2, PR 8 — G08). The wrapper moved; `repo-fence-recovery.ts` itself
  // did not (src/main.ts and src/delivery.ts / job-runner.ts import it
  // directly, both outside that family PR's ownership boundary).

  // ── tick:housekeeping — order-free central work ────────────────────────────

  // T5 (approvals-reason-sweep) moved to src/modules/sweep-repo-fence/
  // (seam 2, PR 8 — G08). The wrapper moved; modules/approvals/index.ts did
  // not.

  registerSweepDuty({
    name: id.T11,
    phase: 'tick:housekeeping',
    order: 50,
    // MODULE-HOOK:scheduled-move-recovery — autonomous recovery of unresolved
    // move intents. Additive (same pattern as the recurrence hook); touches only
    // scheduled_audit (central) + the move's own session inbound rows — no
    // firing-path change (C1).
    run: () => {
      try {
        recoverMoveIntents(getDb(), {});
      } catch (err) {
        log.warn('scheduled-move-recovery: sweep hook failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T12,
    phase: 'tick:housekeeping',
    order: 60,
    // 90d audit-body prune, the companion of the move recovery above.
    run: () => {
      try {
        pruneAuditBodies(getDb(), {});
      } catch (err) {
        log.warn('scheduled-move-recovery: sweep hook failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T14,
    phase: 'tick:housekeeping',
    order: 70,
    // Auto-archive completed tasks older than 24h so the "Done" lane stays
    // representative of recent work; failed tasks are intentionally skipped.
    run: () => {
      autoArchiveOldCompleted();
    },
  });

  registerSweepDuty({
    name: id.T20,
    phase: 'tick:housekeeping',
    order: 100,
    // Claim reconciliation, then self-heal. Order is load-bearing: a claim whose
    // pull request has merged must be CLOSED, not escalated at somebody — the
    // reconcile pass deletes those files first, so the ladder below never sees
    // them. Both are throttled internally to once per 10 minutes and each is
    // isolated, so a GitHub outage cannot take the nudge ladder down with it.
    run: async () => {
      try {
        await reconcileMergedClaims();
      } catch (err) {
        log.warn('Claims reconcile sweep step failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T21,
    phase: 'tick:housekeeping',
    order: 110,
    // Strictly after T20 — see the comment there.
    run: async () => {
      try {
        await sweepClaimsSelfHeal();
      } catch (err) {
        log.warn('Claims self-heal sweep step failed', { err });
      }
    },
  });

  // ── SLA observation hooks — inside the SLA duty's own observe session ───────

  registerSlaObservationHook({
    name: id.S16,
    order: 10,
    // OOM / memory-pressure notice. SLA-only by construction: it is reached only
    // when the exclusive chain falls through to the SLA branch, and it must see
    // the same containerState snapshot the decision does.
    run: (ctx, state, mailbox) => {
      reportContainerOomTelemetry(mailbox, ctx.session, ctx.agentGroupFolder, state);
    },
  });

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
