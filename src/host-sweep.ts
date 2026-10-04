/**
 * Host sweep: periodic maintenance of all session DBs. Reads processing_ack and container_state from outbound.db,
 * writes inbound.db (host-owned), and writes outbound.db only while the container is confirmed stopped. Liveness
 * comes from the heartbeat file mtime, never the DB. A stopped container's leftover 'processing' rows reset to
 * pending with backoff. A running container is killed when its heartbeat is older than max(30 min, the declared
 * Bash timeout), or when a claim outlives max(60s, Bash timeout) with no heartbeat since the claim.
 */
import {
  getActiveSessions,
  getWarmQuietSessionMarks,
  persistQuietSessionMarks,
  type QuietSessionMark,
} from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  SessionDbMissingError,
  SessionDbUnopenableError,
  type ForkContainerStateRow as ContainerState,
  type NanoclawMailboxSession,
} from './modules/mailbox/index.js';
import type { HostWorkContinuation } from './modules/mailbox/ops/continuation.js';
import { log } from './log.js';
import { withExistingMailboxSession } from './session-manager.js';
import {
  containerIdentityFor,
  getActiveContainerSessionIds,
  isContainerRunning,
  containerOwnsOutbound,
  type ContainerIdentity,
} from './container-runner.js';
import type { Session } from './types.js';

export { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';
import { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';

export const SWEEP_INTERVAL_MS = 60_000;

// A fully quiet session is skipped for at most this long, or until its next scheduled row is due if sooner.
export const QUIET_SESSION_BACKOFF_MS = 30 * 60_000;
/**
 * Floor of the per-session jitter band as a fraction of the cap: a mark expires in [floor, 1) x the backoff.
 * Without it every session marked in one tick expires together, one fleet-wide sweep per window. It only ever
 * shortens a skip, so the 30-minute ceiling still holds.
 */
const QUIET_SESSION_JITTER_FLOOR = 0.5;
interface QuietMark {
  skipUntilMs: number;
  lastActive: string | null;
}
const quietSessions = new Map<string, QuietMark>();
let lastSkippedQuiet = 0;

/**
 * Per-session jitter in [0, 1), deterministic (not `Math.random()`): two ticks must agree on a session. The
 * murmur3 finalizer is load-bearing: raw FNV-1a over `sess-<epoch-ms>-<suffix>` ids lands in a handful of buckets.
 */
function quietSessionJitter(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  // `^` yields a SIGNED 32-bit int; without `>>> 0` half the ids get a negative fraction and a LONGER backoff.
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Never exceeds the constant. */
function quietSessionBackoffMs(sessionId: string): number {
  const factor = QUIET_SESSION_JITTER_FLOOR + (1 - QUIET_SESSION_JITTER_FLOOR) * quietSessionJitter(sessionId);
  return Math.round(QUIET_SESSION_BACKOFF_MS * factor);
}

/** Test-only: empty the quiet cache, the way a host restart does. */
export function _resetQuietSessionCacheForTesting(): void {
  quietSessions.clear();
  lastSkippedQuiet = 0;
}

/**
 * Rebuild the quiet cache from `sessions.sweep_quiet_until` at boot (one query, no session-DB opens), so a restart
 * does not sweep every active session on its first tick. Safe because the persisted value never crosses a due row
 * that existed at mark time; every write that changes when work is next due nulls the column and advances
 * `last_active` in one statement before the row lands, so moved rows are not returned; and a live container is
 * never quiet. Advisory: a failed warm means a cold first tick.
 */
async function warmQuietSessionCache(): Promise<void> {
  try {
    const nowMs = Date.now();
    const live = new Set(getActiveContainerSessionIds());
    let warmed = 0;
    for (const row of await getWarmQuietSessionMarks(new Date(nowMs).toISOString())) {
      if (live.has(row.id)) continue;
      const skipUntilMs = Date.parse(row.sweep_quiet_until);
      if (!Number.isFinite(skipUntilMs) || skipUntilMs <= nowMs) continue;
      quietSessions.set(row.id, { skipUntilMs, lastActive: row.last_active });
      warmed++;
    }
    log.info('Host sweep quiet cache warmed', { warmed });
  } catch (err) {
    log.warn('Host sweep quiet cache warm failed', { err });
  }
}

// Absolute idle ceiling for a running container: a heartbeat file untouched this long means stuck or idle; kill.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Per-claim stuck tolerance: any sign of life since this message was claimed?
export const CLAIM_STUCK_MS = 60 * 1000;
// After a fresh spawn the SLA ignores claims made before the container started, so its startup hook can clear
// orphan processing_ack rows; otherwise a crashed session loops wake -> kill forever on an old claim.
export const SPAWN_GRACE_MS = 60 * 1000;

// Sweep duty registry: a duty declares its window (`phase`) and position (`order`); the driver opens each window
// once and hands the open mailbox session to every duty in it. That keeps one `getActiveSessions()` per tick and
// one mailbox open per duty group per window.

export type SweepPhase =
  /** Before the fan-out; `ctx.sessions` is not loaded yet. */
  | 'tick:pre-session'
  /** W1: inside one plan session. */
  | 'session:plan'
  /** W2: NOTHING open; the wake and its attempt bookkeeping. */
  | 'session:wake'
  /** W4: EXCLUSIVE chain; nothing open; duties open their own windows. */
  | 'session:health'
  /** W5: inside one tail session. */
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
 * 'all' runs every duty in ascending `order`. 'exclusive' is an if/else-if chain: the first duty whose `claims()`
 * holds runs and the rest do NOT (registering the SLA before the reaps would misclassify an idle container).
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
 * The `window` field on both sweep error lines: every phase, plus the driver's observe read and the two sessions
 * the SLA opens around its kill.
 */
export type SweepWindow = SweepPhase | 'session:observe' | 'session:health:sla-observe' | 'session:health:post-kill';

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
  /** Which container the state is about, so a duty can tell it from a replacement registered while it awaited. */
  containerIdentity: ContainerIdentity | null;
}

/** Snapshotted inside the SLA's observe session before the kill: `resetStuckProcessingRows` clears the claims. */
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
  /** The W1 snapshot, the only outbound guard the context exposes. */
  readonly hasOutbound: boolean;
  readonly alive: boolean;
  readonly justWoke: boolean;
  readonly plan: WakePlan;
  readonly observed: ContainerObservation | null;
  readonly killSnapshot: SweepKillSnapshot | null;
  /** A short session in the phase's own window, for a duty that must kill. */
  readonly run: SessionRunner;
  /** Same, for a duty that owns more than one window of its own (the SLA). */
  runIn<T>(window: SweepWindow, action: (mailbox: NanoclawMailboxSession) => T | Promise<T>): Promise<T | undefined>;
  /** Whether `session:wake` actually woke the container, which gates the observe read and the health chain. */
  reportWoke(woke: boolean): void;
  /** Wake instrumentation, so tick timing separates spawn waits from session walking. */
  reportWake(stats: { awaited: boolean; waitMs: number }): void;
}

/** A session-phase duty is reached only through the per-session driver; a loud shape assertion, not a cast. */
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

// Registration sources in order: the in-file built-ins, then each family module at its import time. The test reset
// replays every recorded source so family duties survive `_resetSweepRegistryForTesting()`.
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
 * Runs inside the SLA duty's own observe session before `decideStuckAction`, so the decision and the telemetry row
 * see one snapshot. Reached only when the exclusive chain falls through to the SLA branch.
 */
export function registerSlaObservationHook(hook: SlaObservationHook): void {
  const clash = slaObservationHooks.find((h) => h.order === hook.order);
  if (clash) throw new Error(`SLA observation hook ${hook.name}: order ${hook.order} is already held by ${clash.name}`);
  slaObservationHooks.push(hook);
  slaObservationHooks.sort((a, b) => a.order - b.order);
}

/**
 * Runs inside the post-kill session the SLA opens after `killContainer` returns. The kill's respawn and status
 * clear both open a session on the same key, so nothing may be held across it (invariant I-3).
 */
export function registerSweepKillFollowUp(followUp: SweepKillFollowUp): void {
  const clash = sweepKillFollowUps.find((f) => f.order === followUp.order);
  if (clash)
    throw new Error(`Sweep kill follow-up ${followUp.name}: order ${followUp.order} is already held by ${clash.name}`);
  sweepKillFollowUps.push(followUp);
  sweepKillFollowUps.sort((a, b) => a.order - b.order);
}

// Memoized (four lookups per swept session); invalidated only by registration and the test-only reset.
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
 * Test-only: clear the registry. `builtins: false` leaves it EMPTY; the default replays every recorded duty source
 * in registration order, family modules included.
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
 * Test-only: drop exactly one fake source registered via `registerSweepDutySource`; throws on the built-in source.
 * Call after `_resetSweepRegistryForTesting()`. Never clear the whole list: a real family module's source would be
 * lost for the rest of the file.
 */
export function _unregisterSweepDutySourceForTesting(name: string): void {
  if (name === 'host-sweep:builtin') {
    throw new Error("_unregisterSweepDutySourceForTesting: 'host-sweep:builtin' is not test-owned");
  }
  const index = sweepDutySources.findIndex((s) => s.name === name);
  if (index !== -1) sweepDutySources.splice(index, 1);
}

// Duty failures: `runDutyBody` tags the error with duty and window and rethrows. TICK phases isolate: the next
// duty still runs. SESSION phases propagate to `sweepOnce`'s per-session catch, which does NOT quiet-cache the
// session, so the next tick retries it. Both log the same one line from one place.

/** The driver's W3 observe read reads the mailbox and can fail like a duty, so it has a stable `duty` value. */
const DRIVER_OBSERVE_DUTY = 'driver:observe';

/**
 * The per-session yield, injectable so a test can observe it. Removing it turns a batch of sessions back into one
 * contiguous event-loop freeze.
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
 * A later window's opener failed or its mailbox vanished mid-tick. Already classified and logged where warranted;
 * the per-session frame turns it into "no quiet mark, retried next tick".
 */
export class SweepWindowAbort extends Error {
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

/**
 * The duty and window a tagged failure carries, or `{}`. Exported for the post-kill follow-up chain, which outlives
 * the tick and must still report 'Host sweep duty failed' with the tagged fields.
 */
export function dutyFailureFields(err: unknown): { duty?: string; window?: SweepWindow } {
  if (err === null || typeof err !== 'object' || !(SWEEP_DUTY_TAG in err)) return {};
  const tag = (err as Record<symbol, SweepDutyTag>)[SWEEP_DUTY_TAG];
  return { duty: tag.duty, window: tag.window };
}

async function runDutyBody<T>(duty: string, window: SweepWindow, body: () => T | Promise<T>): Promise<T> {
  const entry = { duty, window, startedAtMs: Date.now() }; // what a stalled tick names
  activeDuties.push(entry);
  try {
    return await body();
  } catch (err) {
    throw tagDutyFailure(err, duty, window);
  } finally {
    const index = activeDuties.indexOf(entry);
    if (index !== -1) activeDuties.splice(index, 1);
  }
}

async function runTickPhase(ctx: SweepTickContext, phase: SweepPhase, generation: number): Promise<void> {
  for (const duty of dutiesForPhase(phase)) {
    if (generation !== tickGeneration) return; // abandoned: never run beside its replacement
    if (tickDutiesRunning.has(duty.name)) {
      log.warn('Host sweep duty still running under an abandoned tick — skipped', { duty: duty.name, window: phase });
      continue;
    }
    tickDutiesRunning.add(duty.name);
    try {
      await runDutyBody(duty.name, phase, () => duty.run(ctx));
    } catch (err) {
      // Isolated: one failing central duty must not cost the tick every later duty.
      log.error('Host sweep duty failed', { err, duty: duty.name, window: phase });
    } finally {
      tickDutiesRunning.delete(duty.name);
    }
  }
}

/** A session whose sweeping tick was abandoned starts no further duty. */
function sessionTickAbandoned(ctx: SweepSessionContext): boolean {
  const owner = sessionsRunning.get(ctx.session.id);
  return owner !== undefined && owner !== tickGeneration;
}

async function runSessionPhase(ctx: SweepSessionContext, phase: SweepPhase): Promise<void> {
  for (const duty of dutiesForPhase(phase)) {
    if (sessionTickAbandoned(ctx)) return;
    await runDutyBody(duty.name, phase, () => duty.run(ctx));
  }
}

/** The if/else-if chain, as data: first `claims()` wins, else the fallthrough. */
async function runExclusiveSessionPhase(ctx: SweepSessionContext, phase: SweepPhase): Promise<void> {
  const duties = dutiesForPhase(phase);
  for (const duty of duties) {
    if (!duty.claims) continue;
    if (sessionTickAbandoned(ctx)) return;
    const claimed = await runDutyBody(duty.name, phase, () => duty.claims!(ctx));
    if (claimed) {
      if (!sessionTickAbandoned(ctx)) await runDutyBody(duty.name, phase, () => duty.run(ctx));
      return;
    }
  }
  const fallthrough = duties.find((d) => !d.claims);
  if (fallthrough && !sessionTickAbandoned(ctx)) await runDutyBody(fallthrough.name, phase, () => fallthrough.run(ctx));
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
  // The snapshot was taken before the kill (the kill clears the claims). `Object.create` shadows one field and
  // leaves every other accessor live on the driver's context.
  const followUpCtx: SweepSessionContext = Object.create(ctx, {
    killSnapshot: { value: snapshot, enumerable: true },
  }) as SweepSessionContext;
  for (const followUp of sweepKillFollowUps) {
    await runDutyBody(followUp.name, 'session:health:post-kill', () => followUp.run(followUpCtx, outcome, mailbox));
  }
}

/**
 * A short session tagged with its window. Only a W1 opener failure backs the session off: W1 already proved the
 * mailbox openable this tick, so a later failure is likely a reclaim race, and backing off would hold due work for
 * 30 minutes on a transient condition.
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
      // A vanished session is steady state: not logged, retried next tick rather than backed off.
      if (err instanceof SessionDbMissingError) throw new SweepWindowAbort(at);
      if (err instanceof SessionDbUnopenableError || !entered) {
        log.error('Host sweep mailbox unopenable', { err, sessionId, window: at });
        throw new SweepWindowAbort(at);
      }
      throw err;
    }
  };
}

/** Inventory id to registered duty name; the only place this file names a duty. */
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
  T19: 'usage-rollup',
  T20: 'claims-reconcile',
  T21: 'claims-self-heal',
  T22: 'orphaned-repo-fence-release',
  T23: 'cli-request-execution-prune',
  T24: 'task-failure-escalation',
  // Fork additions (FORK*), kept so the drift guard in host-sweep-registry.test.ts accounts for every duty.
  FORK1: 'github-token-file-refresh',
  FORK2: 'coordination-orphans',
  FORK3: 'wiki-admission-recovery',
  FORK4: 'mcp-oauth-refresh',
  FORK5: 'promise-watch',
  FORK6: 'provider-fallback-return',
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

/** Computed by `enforceRunningContainerSla`; defined here because the kill follow-ups reference it by name. */
export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Re-exported for `src/host-restart-warn.ts`, from the family's side-effect-free leaf, never its `index.ts`: that
 * file registers duties at eval time and would run the registrar while this module's `const`s are still in TDZ.
 */
export { decideCeilingFollowUp, type CeilingFollowUp } from './modules/sweep-continuation/decide.js';
export {
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './modules/mailbox/ops/continuation.js';
/**
 * THE guard for every host-side write to the container-owned `outbound.db`: it may be written only while no
 * container owns it, checked immediately before the write with no await between (any yield lets a replacement
 * wake in). `withStoppedContainerSession` is the session-opening form; both exist because a second session for a
 * key may not open while one is (I-3). Returns `undefined` when a container owns the file; callers' writes are
 * idempotent or retried next tick.
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
 * Opens a short session through the caller's windowed runner and delegates to `writeOutboundWhenStopped`: opening
 * a session is a yield, so the check must sit inside it. Resolves `undefined` when the mailbox is gone or a
 * container took ownership; callers treat both as "did not run".
 */
export async function withStoppedContainerSession<T>(
  run: SessionRunner,
  session: Session,
  action: (mailbox: NanoclawMailboxSession) => T,
): Promise<T | undefined> {
  return run((mailbox) => writeOutboundWhenStopped(session, mailbox, action));
}

/**
 * Write one deferred on-wake accountability row (plus its inert recall marker) into inbound. The row id doubles as
 * the durable marker the per-class attempt caps count, so every self-heal action goes through here.
 */
export function writeSystemWake(
  mailbox: NanoclawMailboxSession,
  session: Session,
  id: string,
  text: string,
  system: Record<string, unknown>,
  /** 1 = only the NEXT fresh container's first poll sees it; 0 = the running container sees it on its next poll. */
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

// Stays here, not in sweep-container-health: the driver's `!alive` cleanup below must stay synchronous (a dynamic
// import there adds an await a concurrent wake can observe). Its semantics belong to that module, which imports it.
export const providerFailedTicks = new Map<string, number>();

/**
 * One short mailbox session, for duties that must open and close a session around `killContainer` rather than
 * hold one across it (I-3). Resolves `undefined` when the mailbox is gone.
 */
export type SessionRunner = <T>(action: (mailbox: NanoclawMailboxSession) => T | Promise<T>) => Promise<T | undefined>;

let running = false;

/** A tick past this is stuck on an await that may never settle; it is abandoned. 2x the worst live tick. */
export const SWEEP_TICK_STALL_MS = 15 * 60_000;
/** Bumped at each tick start and on abandonment; a tick compares it at its checkpoints. */
let tickGeneration = 0;
/** Duty bodies in flight, innermost last: what a stalled tick is stuck in. */
const activeDuties: Array<{ duty: string; window: SweepWindow; startedAtMs: number }> = [];
/** Tick duties and sessions still running, possibly under an abandoned tick: never re-entered. */
const tickDutiesRunning = new Set<string>();
const sessionsRunning = new Map<string, number>(); // session → the generation sweeping it

export function startHostSweep(): void {
  if (running) return;
  running = true;
  // sweep() always reschedules itself and never rejects, so void is safe. The quiet-cache warm runs once per start.
  quietCacheWarmed = false;
  void sweep();
}

export function stopHostSweep(): void {
  running = false;
}

/**
 * The timer chain must never be skipped: a rejected sweep() promise once left the reschedule unrun while
 * `running` stayed true, silently killing the sweep with every health signal green. Rescheduling is unconditional.
 */
let quietCacheWarmed = false;

async function sweep(): Promise<void> {
  const generation = ++tickGeneration;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tick = (async () => {
      // Once per start, before the first tick: a per-tick warm would race the map the tick writes.
      if (!quietCacheWarmed) {
        quietCacheWarmed = true;
        await warmQuietSessionCache();
      }
      await sweepOnce(generation);
      return 'done' as const;
    })();
    // A tick that never settles would hold the reschedule forever: race it against the stall bound; a loser that
    // resumes stops at its checkpoints.
    const stalled = new Promise<'stalled'>((resolve) => {
      stallTimer = setTimeout(() => resolve('stalled'), SWEEP_TICK_STALL_MS);
    });
    if ((await Promise.race([tick, stalled])) === 'stalled') abandonStalledTick(generation);
  } catch (err) {
    log.error('Host sweep tick threw — rescheduling anyway', { err });
  } finally {
    clearTimeout(stallTimer);
  }
  setTimeout(() => {
    void sweep();
  }, SWEEP_INTERVAL_MS);
}

function abandonStalledTick(generation: number): void {
  const stuck = activeDuties.at(-1);
  if (tickGeneration === generation) tickGeneration++;
  activeDuties.length = 0; // the abandoned tick's entries must not be blamed for the next stall
  log.error('Host sweep tick stalled — abandoning it and rescheduling', {
    stallMs: SWEEP_TICK_STALL_MS,
    duty: stuck?.duty ?? null,
    window: stuck?.window ?? null,
    dutyElapsedMs: stuck ? Date.now() - stuck.startedAtMs : null,
  });
}

/** Last completed tick, so tests can await a fast tick that `Host sweep tick timing` (> 1 s only) never logs. */
const lastTickStats = {
  ticks: 0,
  sweptSessions: 0,
  skippedQuiet: 0,
  wakesStarted: 0,
  spawnsAwaited: 0,
  spawnWaitMs: 0,
};

/** This tick's wake instrumentation; module-level because every per-session context adds into one total. */
const tickWakeStats = { wakesStarted: 0, spawnsAwaited: 0, spawnWaitMs: 0 };

/** Test-only: the counters from the last completed tick. */
export function _lastSweepTickStatsForTesting(): {
  ticks: number;
  sweptSessions: number;
  skippedQuiet: number;
  wakesStarted: number;
  spawnsAwaited: number;
  spawnWaitMs: number;
} {
  return { ...lastTickStats };
}

async function sweepOnce(generation: number): Promise<void> {
  // One timing line per slow tick, with the per-session share, to convict or clear the sweep in stall hunts.
  const sweepStartedAtMs = Date.now();
  tickWakeStats.wakesStarted = 0;
  tickWakeStats.spawnsAwaited = 0;
  tickWakeStats.spawnWaitMs = 0;
  let sweptSessions = 0;
  if (!running) return;

  // One context per tick; `activeContainerSessionIds` is read lazily, at the point the duty that wants it runs.
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

  await runTickPhase(tick, 'tick:pre-session', generation);

  try {
    sessions = await getActiveSessions();
  } catch (err) {
    log.error('Host sweep: failed to load active sessions', { err });
    sessions = [];
  }
  if (generation !== tickGeneration) return; // abandoned: reset nothing the live tick has recorded

  // Failures are isolated per session. Quiet cache: a session the previous sweep found fully quiet is skipped
  // until its next scheduled row is due or the backoff cap; any new inbound bumps `last_active`, invalidating it.
  const sessionsStartedAtMs = Date.now();
  unreadableSessions = [];
  let skippedQuiet = 0;
  // Marks taken this tick, flushed once at the end, and only on the transition into quiet.
  const newQuietMarks: QuietSessionMark[] = [];
  for (const session of sessions) {
    if (generation !== tickGeneration) return; // abandoned: sweep no further
    if (sessionsRunning.has(session.id)) continue; // still inside an abandoned tick
    const mark = quietSessions.get(session.id);
    if (mark && Date.now() < mark.skipUntilMs && mark.lastActive === session.last_active) {
      skippedQuiet++;
      continue;
    }
    quietSessions.delete(session.id);
    sessionsRunning.set(session.id, generation);
    try {
      const quietUntil = await sweepSession(session, tick);
      if (generation !== tickGeneration) return; // abandoned: a verdict from phases it skipped
      if (quietUntil !== null) {
        quietSessions.set(session.id, { skipUntilMs: quietUntil, lastActive: session.last_active });
        // Carry the basis: ingress during a yield can move `last_active`; the flush no-ops on rows that moved.
        newQuietMarks.push({
          sessionId: session.id,
          quietUntil: new Date(quietUntil).toISOString(),
          lastActive: session.last_active,
        });
      }
      sweptSessions++;
    } catch (err) {
      // A duty threw: the work is still due, so NOT quiet-cached and retried next tick. Distinct from 'Host sweep
      // mailbox unopenable'.
      log.error('Host sweep duty failed', { err, sessionId: session.id, ...dutyFailureFields(err) });
    } finally {
      sessionsRunning.delete(session.id);
    }
    // Yield after EVERY swept session: one can cost ~1.5s of synchronous SQLite/fs work.
    await sweepYield();
  }
  if (generation !== tickGeneration) return; // abandoned: persist nothing against reset state
  // Bound the cache to sessions that still exist.
  if (quietSessions.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of quietSessions.keys()) if (!live.has(id)) quietSessions.delete(id);
  }
  // An unreadable mark is not persisted: its causes are process-local and a restart can clear them. Only the W5
  // quiet hint is durable.
  const unreadableIds = new Set(unreadableSessions.map((u) => u.sessionId));
  const durableQuietMarks = newQuietMarks.filter((mark) => !unreadableIds.has(mark.sessionId));
  if (durableQuietMarks.length > 0) {
    try {
      await persistQuietSessionMarks(durableQuietMarks);
    } catch (err) {
      // Degrades downward on purpose: the next tick sweeps these sessions rather than trusting a lost mark.
      log.warn('Host sweep quiet mark persistence failed', { count: durableQuietMarks.length, err });
      for (const mark of durableQuietMarks) quietSessions.delete(mark.sessionId);
    }
  }
  const sessionsMs = Date.now() - sessionsStartedAtMs;
  lastSkippedQuiet = skippedQuiet;
  // One line per tick, never per session.
  if (unreadableSessions.length > 0) {
    log.warn('Host sweep: sessions skipped as UNREADABLE (not quiet)', {
      count: unreadableSessions.length,
      samples: unreadableSessions.slice(0, 5),
    });
  }

  await runTickPhase(tick, 'tick:post-session', generation);
  await runTickPhase(tick, 'tick:housekeeping', generation);
  if (generation !== tickGeneration) return; // abandoned: the stats belong to the live tick

  lastTickStats.ticks++;
  lastTickStats.sweptSessions = sweptSessions;
  lastTickStats.skippedQuiet = skippedQuiet;
  lastTickStats.wakesStarted = tickWakeStats.wakesStarted;
  lastTickStats.spawnsAwaited = tickWakeStats.spawnsAwaited;
  lastTickStats.spawnWaitMs = tickWakeStats.spawnWaitMs;

  const sweepMs = Date.now() - sweepStartedAtMs;
  if (sweepMs >= 1_000) {
    // With spawnsAwaited 0, sessionsMs is the cost of walking the sessions and nothing else.
    log.info('Host sweep tick timing', {
      sweepMs,
      sessionsMs,
      sweptSessions,
      skippedQuiet: lastSkippedQuiet,
      wakesStarted: tickWakeStats.wakesStarted,
      spawnsAwaited: tickWakeStats.spawnsAwaited,
      spawnWaitMs: tickWakeStats.spawnWaitMs,
    });
  }
}

/** Test-only: one whole tick through the registry, without the timer chain. */
export async function _sweepOnceForTesting(): Promise<void> {
  const wasRunning = running;
  running = true;
  try {
    await sweepOnce(++tickGeneration);
  } finally {
    running = wasRunning;
  }
}

function getLastInboundAtMs(mailbox: NanoclawMailboxSession): number | null {
  const timestamp = mailbox.latestInboundTimestamp();
  if (timestamp === null) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function getLastOutboundAtMs(mailbox: NanoclawMailboxSession): number | null {
  const timestamp = mailbox.latestOutboundTimestamp();
  if (timestamp === null) return null;
  const ms = parseSqliteUtc(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Unreadable sessions take the quiet backoff too, but are counted so the tick can report them. */
let unreadableSessions: { sessionId: string; reason: string }[] = [];
function skipUnreadable(sessionId: string, reason: string): number {
  unreadableSessions.push({ sessionId, reason });
  return Date.now() + quietSessionBackoffMs(sessionId);
}

/**
 * Sweep one session. Returns a quiet-until timestamp (ms) when the session is fully quiet and safe to skip until
 * then, or null when it must stay hot.
 */
async function sweepSession(session: Session, tick: SweepTickContext): Promise<number | null> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return skipUnreadable(session.id, 'agent group missing');

  // Every duty runs inside one of these short sessions, never held across a wake or kill (I-3). Reads never
  // provision (I-4): a vanished mailbox resolves undefined and counts as unreadable.
  const baseRun: SessionRunner = (action) => withExistingMailboxSession(agentGroup.id, session.id, action);

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
    reportWake(stats: { awaited: boolean; waitMs: number }): void {
      tickWakeStats.wakesStarted++;
      if (stats.awaited) tickWakeStats.spawnsAwaited++;
      tickWakeStats.spawnWaitMs += stats.waitMs;
    },
  };

  // W1: session:plan. The flag separates "a duty threw" from "the inbound open failed"; a lazily opened outbound
  // handle raises SessionDbUnopenableError instead, which the catch routes to the backoff.
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
    // A vanished session is steady state: counted and backed off, not logged as a fault.
    if (err instanceof SessionDbMissingError) return skipUnreadable(session.id, 'session mailbox vanished');
    // Present but unopenable: nothing to sweep until that changes, and retrying every tick floods the log. Backoff
    // with an error line. The error class decides, not how far we got.
    if (err instanceof SessionDbUnopenableError || !enteredPlanSession) {
      log.error('Host sweep mailbox unopenable', { err, sessionId: session.id, window: 'session:plan' });
      return skipUnreadable(session.id, `session mailbox unreadable: ${String(err)}`);
    }
    // A duty threw: the work is still due, so retry next tick. Quiet-caching would hold due work for the full
    // backoff, and `last_active` does not move on failure to clear it.
    throw err;
  }
  // The seam is the only gate on "does this session have a mailbox" (no parallel `fs.existsSync`): it answers on
  // inbound.db alone, so a never-woken session with no outbound.db is still swept.
  if (!planned) return skipUnreadable(session.id, 'no session mailbox');

  try {
    // W2: session:wake, NOTHING open: the spawn path and recovery admission open sessions of their own (I-3).
    window = 'session:wake';
    await runSessionPhase(ctx, 'session:wake');

    alive = isContainerRunning(session.id);

    // W3: the driver's observe read. Skipped on the iteration that just woke the container, which has not yet
    // cleared stale processing_ack rows; reading them would cause an immediate spawn-kill loop.
    if (alive && !justWoke && plan.hasOutbound) {
      window = 'session:observe';
      observed =
        (await ctx.run((m) =>
          // Carries its own duty identifier so a throw logs with `duty` and `window`.
          runDutyBody(DRIVER_OBSERVE_DUTY, 'session:observe', () => ({
            containerState: m.getContainerState(),
            processingClaimCount: m.getProcessingClaimRows().length,
            lastOutboundAtMs: getLastOutboundAtMs(m),
            lastInboundAtMs: getLastInboundAtMs(m),
            containerIdentity: containerIdentityFor(session.id),
          })),
        )) ?? null;

      // W4: session:health, EXCLUSIVE, nothing open.
      if (observed) {
        window = 'session:health';
        await runExclusiveSessionPhase(ctx, 'session:health');
      }
    }

    // A gone container cannot be mid-failure: clear its debounce so a fresh container does not inherit it.
    // Synchronous on purpose (see providerFailedTicks).
    if (!alive) providerFailedTicks.delete(session.id);

    // W5: session:tail.
    window = 'session:tail';
    let quietUntil: number | null = null;
    const tail = await ctx.run(async (m): Promise<{ ok: true }> => {
      mailbox = m;
      try {
        await runSessionPhase(ctx, 'session:tail');
        // Quiet hint: no container, nothing due or admitted, no continuation. Skip until the next scheduled row
        // (never past it) or the cap.
        if (plan.dueCount === 0 && plan.admittedTasks === 0 && !justWoke && plan.workContinuation === null && !alive) {
          const nextDue = m.getNextFutureProcessAfter();
          const cap = Date.now() + quietSessionBackoffMs(session.id);
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
    // Already classified at the boundary; no quiet mark, swept again next tick.
    if (err instanceof SweepWindowAbort) return null;
    throw err;
  }
}

/** Test-only entry point for one session's sweep tick, over a one-session tick context. */
export async function _sweepSessionForTesting(session: Session): Promise<number | null> {
  // `SweepTickContext.sessions` is a synchronous getter, so resolve the list up front, as `sweepOnce` does.
  const sessions: Session[] = await getActiveSessions();
  let activeContainerSessionIds: ReadonlySet<string> | undefined;
  const tick: SweepTickContext = {
    now: Date.now(),
    get sessions(): readonly Session[] {
      return sessions;
    },
    get activeContainerSessionIds(): ReadonlySet<string> {
      return (activeContainerSessionIds ??= new Set(getActiveContainerSessionIds()));
    },
  };
  return sweepSession(session, tick);
}

// Every duty is registered by its own `src/modules/sweep-*` module. The built-in source stays registered and empty:
// the test reset replays every recorded source and refuses to unregister this one.

function registerBuiltInSweepDuties(): void {}

registerSweepDutySource('host-sweep:builtin', registerBuiltInSweepDuties);
