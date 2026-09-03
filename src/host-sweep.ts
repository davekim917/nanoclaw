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
import { withExistingNanoclawSession } from './modules/mailbox/session.js';
import type { HostWorkContinuation } from './modules/mailbox/ops/continuation.js';
import { log } from './log.js';
import { getActiveContainerSessionIds, isContainerRunning } from './container-runner.js';
import type { Session } from './types.js';

/**
 * Session-DB timestamp parsing now lives with the mailbox module that owns
 * those columns; re-exported here so existing importers are unchanged.
 */
export { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';
import { parseSqliteUtc } from './modules/mailbox/sqlite-utc.js';

export const SWEEP_INTERVAL_MS = 60_000;

// Quiet-session cache — see the sweep loop. A fully-quiet session is skipped
// for at most this long (or until its next scheduled row is due, if sooner).
export const QUIET_SESSION_BACKOFF_MS = 30 * 60_000;
/**
 * Floor of the per-session jitter band, as a fraction of the cap: a mark
 * expires somewhere in [floor, 1) x the backoff above, never past it.
 *
 * Without a jitter every session marked in the same tick expires in the same
 * tick. Live (#320): the whole quiet population — ~840 sessions — came back on
 * one exact 30-minute grid 48 times a day, and each of those was a ~30 s tick
 * that swept every active session at once. This spreads that cohort across the
 * 15 minutes below the cap. It only ever SHORTENS a skip, so plan.md §4.4's
 * 30-minute ceiling still holds and no session waits longer than it does today.
 */
const QUIET_SESSION_JITTER_FLOOR = 0.5;
interface QuietMark {
  skipUntilMs: number;
  lastActive: string | null;
}
const quietSessions = new Map<string, QuietMark>();
let lastSkippedQuiet = 0;

/**
 * Per-session jitter in [0, 1), derived from the session id — deterministic,
 * deliberately NOT `Math.random()`: two ticks must agree on the same session,
 * and the acceptance cases have to reproduce the spread across runs.
 *
 * FNV-1a with a murmur3 finalizer. The finalizer is load-bearing, not
 * ceremony: raw FNV-1a over ids that differ only in their last characters —
 * which is exactly what `sess-<epoch-ms>-<suffix>` ids are — puts 200 sessions
 * into five distinct buckets, which is a smaller herd rather than no herd.
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
  // `^` yields a SIGNED 32-bit int; without the shift back to unsigned this
  // returns a negative fraction for half the ids and LENGTHENS their backoff.
  return (hash >>> 0) / 0x1_0000_0000;
}

/** This session's jittered backoff cap, in ms. Never exceeds the constant. */
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
 * Rebuild the quiet cache from `sessions.sweep_quiet_until` at boot.
 *
 * The map is process-local, so before this every restart threw the whole cache
 * away and the first tick swept every active session — ~850 of them, a 457 s
 * tick, nine times in the 22 hours of log #320 was filed against. One query,
 * no session-DB opens.
 *
 * Safe by construction rather than by re-derivation, on three counts:
 *  - the persisted value was computed as `min(getNextFutureProcessAfter(),
 *    jittered cap)`, so it can never cross a due row that existed at mark time;
 *  - a row whose `last_active` has moved since is not returned at all —
 *    `updateSession` nulls the column in the same statement, and
 *    `touchSessionActivity` is REQUIRED after any write that changes when work
 *    is next due, so a newly due row always clears the mark;
 *  - a session whose container is alive is never quiet, whatever the row says.
 * Due-ness itself lives only in the session's own `inbound.db`, which this path
 * deliberately does not open; the jittered cap is the outer bound, so the worst
 * case for anything the three checks miss is one backoff window, exactly as it
 * is for a mark taken in this process.
 *
 * Advisory: a failed warm degrades to today's behavior — a cold first tick.
 */
function warmQuietSessionCache(): void {
  try {
    const nowMs = Date.now();
    const live = new Set(getActiveContainerSessionIds());
    let warmed = 0;
    for (const row of getWarmQuietSessionMarks(new Date(nowMs).toISOString())) {
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

/**
 * The ceiling-kill accountability family (S2-PR13) lives in
 * `src/modules/sweep-continuation/`. `src/host-restart-warn.ts` imports
 * `decideCeilingFollowUp` and `WORK_CONTINUATION_RESUME_MAX_ATTEMPTS` from
 * here and is outside that PR's ownership, so both keep resolving from this
 * module. The re-export is from the family's side-effect-free leaf, never from
 * its `index.ts`: that file registers its duties at eval time, and pulling it
 * into this module's own dependency cycle would run the registrar while the
 * registry's `const`s below are still in their temporal dead zone.
 */
export { decideCeilingFollowUp, type CeilingFollowUp } from './modules/sweep-continuation/decide.js';
export {
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from './modules/mailbox/ops/continuation.js';

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
  // Before the first tick, never inside it: a warm that ran per tick would be
  // a second source of truth racing the map the tick is writing.
  warmQuietSessionCache();
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

/**
 * Last completed tick, for the acceptance cases that assert on the FIRST tick
 * after a restart. `Host sweep tick timing` only logs above 1 s, so a spy on it
 * cannot see a fast tick; `ticks` is what lets a test await one.
 */
const lastTickStats = { ticks: 0, sweptSessions: 0, skippedQuiet: 0 };

/** Test-only: the counters from the last completed tick. */
export function _lastSweepTickStatsForTesting(): { ticks: number; sweptSessions: number; skippedQuiet: number } {
  return { ...lastTickStats };
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
  // Marks taken THIS tick, flushed once at the end. One statement per tick,
  // never one per session, and only on the transition into quiet — a re-write
  // on every confirming tick would be ~840 UPDATEs a minute, a new cost rather
  // than a saving. A session already holding a valid mark `continue`s above and
  // never reaches the write.
  const newQuietMarks: QuietSessionMark[] = [];
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
        // Carry the basis: the flush happens after the whole fan-out, and
        // ingress during one of the yields below can move `last_active` (and
        // clear the column) in between. The write compares this and no-ops on
        // the rows that moved, so a stale expiry is never put back.
        newQuietMarks.push({
          sessionId: session.id,
          quietUntil: new Date(quietUntil).toISOString(),
          lastActive: session.last_active,
        });
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
  // "I cannot read this session" is not "this session is quiet". `skipUnreadable`
  // returns the same backoff, and in-process that is right — but its causes are
  // PROCESS-local (descriptor exhaustion, a hot-journal recovery this process
  // failed, an agent group this process could not resolve), and a restart is
  // exactly the event that can clear them. Persisting that mark would carry a
  // dead process's verdict into a fresh one and hold the session for a further
  // backoff window. Only the W5 quiet hint is durable.
  const unreadableIds = new Set(unreadableSessions.map((u) => u.sessionId));
  const durableQuietMarks = newQuietMarks.filter((mark) => !unreadableIds.has(mark.sessionId));
  if (durableQuietMarks.length > 0) {
    try {
      persistQuietSessionMarks(durableQuietMarks);
    } catch (err) {
      // Advisory, and it degrades DOWNWARD on purpose: the in-memory marks go
      // with the failed write, so the next tick sweeps these sessions instead
      // of skipping them on a mark no restart could recover. Worst case is the
      // pre-cache cold sweep, loudly — never a session held past due work.
      log.warn('Host sweep quiet mark persistence failed', { count: durableQuietMarks.length, err });
      for (const mark of durableQuietMarks) quietSessions.delete(mark.sessionId);
    }
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

  lastTickStats.ticks++;
  lastTickStats.sweptSessions = sweptSessions;
  lastTickStats.skippedQuiet = skippedQuiet;

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

/**
 * "I cannot read this session" is not "this session is quiet", but both took
 * the same silent quiet-until return. Same backoff — a session the host cannot
 * open has nothing to sweep — but it is now counted so the tick can say so.
 */
let unreadableSessions: { sessionId: string; reason: string }[] = [];
function skipUnreadable(sessionId: string, reason: string): number {
  unreadableSessions.push({ sessionId, reason });
  return Date.now() + quietSessionBackoffMs(sessionId);
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
    // A later window's opener failed, or its mailbox vanished mid-tick. Already
    // classified at the boundary; the session takes no quiet mark and is swept
    // again on the next tick, exactly as it was before the seam.
    if (err instanceof SweepWindowAbort) return null;
    throw err;
  }
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

// sweepTaskWatchdog moved with the orchestrator family (S2-PR5) into
// src/modules/sweep-orchestrator/task-watchdog.ts — a sibling of that
// family's index.ts, not index.ts itself, so this re-export doesn't create a
// static cycle back through index.ts's own import of this file (registerSweepDuty
// / registerSweepDutySource / SWEEP_DUTY_INVENTORY).
export { sweepTaskWatchdog as _sweepTaskWatchdogForTesting } from './modules/sweep-orchestrator/task-watchdog.js';

// ─────────────────────────────────────────────────────────────────────────────
// The 38 duty names, 39 registrations — none of them here any more.
//
// Every duty this driver runs is registered by its own `src/modules/sweep-*`
// module at import time (the modules barrel `src/modules/index.ts` is what
// production loads). `SWEEP_DUTY_INVENTORY` above is the map from the inventory
// id in plan.md §4.3 to the registered name, and it is the only place this file
// names a duty. The built-in source stays registered and empty: it is part of
// the registry's own contract — `_resetSweepRegistryForTesting()` replays every
// recorded source, and `_unregisterSweepDutySourceForTesting` refuses this one
// as not test-owned.
// ─────────────────────────────────────────────────────────────────────────────

function registerBuiltInSweepDuties(): void {}

registerSweepDutySource('host-sweep:builtin', registerBuiltInSweepDuties);
