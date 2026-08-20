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
  countDueMessages,
  getNextFutureProcessAfter,
  deleteOrphanProcessingClaims,
  expireStalePending,
  getContainerState,
  getDueWakePriority,
  getMessageForRetry,
  getProcessingClaims,
  insertDeferredMessageWithContextIfNew,
  markMessageFailed,
  openInboundDb as openInboundDbByPath,
  readSessionRouting,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { restoreTaskRow, type TaskRowSnapshot } from './modules/scheduling/db.js';
import { countLiveRowsInSessions } from './modules/scheduling/live-count.js';
import { runHostGatedTaskScripts } from './modules/scheduling/host-script.js';
import { purgeIntentBody } from './dashboard/api/scheduled-shared.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  outboundDbPath,
  heartbeatPath,
  sessionsBaseDir,
  writeOutboundDirect,
  writeSessionMessage,
  admitDueTaskContexts,
  deferMessageForFreshContextRetry,
} from './session-manager.js';
import { rollupSessionUsage } from './db/usage.js';
import {
  getContainerSpawnedAt,
  hasContainerEverRun,
  getActiveContainerSessionIds,
  isContainerRunning,
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
import { handleStoragePressureAlert } from './storage-pressure-alert.js';
import { runStorageMaintenanceInBackground } from './storage-maintenance-worker.js';
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
import { pruneChannelIngressReceipts } from './db/channel-ingress-receipts.js';
import { runMemoryCurationInBackground, stopMemoryCurationInBackground } from './modules/memory/curator-worker.js';
import { probeNextGraphScentWorkgroup } from './modules/memory/graph-scent.js';
import { sweepClaimsSelfHeal } from './modules/claims/self-heal.js';

const oomKillObserver = new OomKillObserver();

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;

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

export const WORK_CONTINUATION_RESUME_MAX_ATTEMPTS = 2;
export const CONTINUATION_WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const WORK_CONTINUATION_TASK_MAX_CHARS = 500;

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

export interface HostWorkContinuation {
  id: string;
  task: string;
  source_message_id?: string;
  phase: 'queued' | 'running';
  chain: number;
  runner_id?: string;
  resume_attempts: number;
  recovery_episode: number;
}

export function canAttemptContinuationRecovery(continuation: HostWorkContinuation): boolean {
  return continuation.resume_attempts < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS;
}

export function readWorkContinuation(outDb: Database.Database): HostWorkContinuation | null {
  try {
    const row = outDb.prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() as
      | { value: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<HostWorkContinuation>;
      if (
        typeof parsed.id !== 'string' ||
        parsed.id === '' ||
        typeof parsed.task !== 'string' ||
        parsed.task.trim() === '' ||
        parsed.task.length > WORK_CONTINUATION_TASK_MAX_CHARS ||
        (parsed.phase !== 'queued' && parsed.phase !== 'running') ||
        !Number.isSafeInteger(parsed.chain) ||
        (parsed.chain ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.resume_attempts) ||
        (parsed.resume_attempts ?? -1) < 0 ||
        (parsed.recovery_episode !== undefined &&
          (!Number.isSafeInteger(parsed.recovery_episode) || parsed.recovery_episode < 0)) ||
        (parsed.runner_id !== undefined && (typeof parsed.runner_id !== 'string' || parsed.runner_id === ''))
      ) {
        return null;
      }
      return {
        id: parsed.id,
        task: parsed.task.trim(),
        ...(typeof parsed.source_message_id === 'string' &&
        parsed.source_message_id.length > 0 &&
        parsed.source_message_id.length <= 1024
          ? { source_message_id: parsed.source_message_id }
          : {}),
        phase: parsed.phase,
        chain: parsed.chain as number,
        ...(parsed.runner_id ? { runner_id: parsed.runner_id } : {}),
        resume_attempts: parsed.resume_attempts as number,
        recovery_episode: parsed.recovery_episode ?? 0,
      };
    }

    // Rollout compatibility: the fresh runner owns migration/deletion because
    // the host normally opens outbound.db read-only. A valid legacy promise is
    // sufficient to wake once; the runner converts it before executing.
    const legacy = outDb.prepare("SELECT value FROM session_state WHERE key = 'pending_next'").get() as
      | { value: string }
      | undefined;
    if (!legacy) return null;
    const parsed = JSON.parse(legacy.value) as { task?: unknown; chain?: unknown };
    if (
      typeof parsed.task !== 'string' ||
      parsed.task.trim() === '' ||
      parsed.task.length > WORK_CONTINUATION_TASK_MAX_CHARS
    ) {
      return null;
    }
    return {
      id: 'legacy-pending-next',
      task: parsed.task.trim(),
      phase: 'queued',
      chain: Number.isSafeInteger(parsed.chain) && (parsed.chain as number) >= 0 ? (parsed.chain as number) : 0,
      resume_attempts: 0,
      recovery_episode: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Durable throttle timestamp for an already-attempted recovery. The active
 * container registry is cleared on exit, but session_state survives the
 * crash, so a fast-failing replacement cannot be respawned every sweep tick.
 */
export function readContinuationRecoveryAttemptAt(
  outDb: Database.Database,
  continuation: HostWorkContinuation,
): number {
  if (continuation.id === 'legacy-pending-next' || continuation.resume_attempts === 0) return 0;
  try {
    const row = outDb.prepare("SELECT updated_at FROM session_state WHERE key = 'work_continuation'").get() as
      | { updated_at: string }
      | undefined;
    if (!row) return 0;
    const parsed = parseSqliteUtc(row.updated_at);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Test-only re-export with an injected outbound DB handle. */
export function _hasWorkContinuationForTesting(outDb: Database.Database): boolean {
  return readWorkContinuation(outDb) !== null;
}

export function incrementWorkContinuationResumeAttempt(
  outDb: Database.Database,
  expectedId: string,
): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const current = readWorkContinuation(outDb);
    if (
      !current ||
      current.id !== expectedId ||
      current.id === 'legacy-pending-next' ||
      current.resume_attempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS
    ) {
      return null;
    }
    // The stopped-container host is authorizing one fresh runner to consume
    // this recovery attempt. Clear the prior runner claim so the container can
    // distinguish this authorized start from a capped attempt that has already
    // run and is merely hitchhiking on an unrelated wake.
    const updated: HostWorkContinuation = {
      ...current,
      phase: 'queued',
      resume_attempts: current.resume_attempts + 1,
    };
    delete updated.runner_id;
    outDb
      .prepare("UPDATE session_state SET value = ?, updated_at = ? WHERE key = 'work_continuation'")
      .run(JSON.stringify(updated), new Date().toISOString());
    return updated;
  })();
}

export function migrateLegacyWorkContinuationForRecovery(outDb: Database.Database): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const legacy = readWorkContinuation(outDb);
    if (!legacy || legacy.id !== 'legacy-pending-next') return null;
    const migrated: HostWorkContinuation = {
      ...legacy,
      id: randomUUID(),
      resume_attempts: 1,
    };
    outDb
      .prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(migrated), new Date().toISOString());
    outDb.prepare("DELETE FROM session_state WHERE key = 'pending_next'").run();
    return migrated;
  })();
}

function incrementStoppedContinuationAttempt(session: Session, expectedId: string): HostWorkContinuation | null {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDbRw(session.agent_group_id, session.id);
    if (expectedId !== 'legacy-pending-next') return incrementWorkContinuationResumeAttempt(db, expectedId);
    return migrateLegacyWorkContinuationForRecovery(db);
  } catch (err) {
    log.warn('Failed to increment continuation recovery attempt', { sessionId: session.id, err });
    return null;
  } finally {
    db?.close();
  }
}

export function restoreWorkContinuationResumeAttempt(
  outDb: Database.Database,
  attempted: HostWorkContinuation,
  previous: HostWorkContinuation,
): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const current = readWorkContinuation(outDb);
    if (
      !current ||
      current.id !== attempted.id ||
      current.resume_attempts !== attempted.resume_attempts ||
      previous.resume_attempts !== attempted.resume_attempts - 1
    ) {
      return null;
    }
    if (previous.id === 'legacy-pending-next') {
      outDb.prepare("DELETE FROM session_state WHERE key = 'work_continuation'").run();
      outDb
        .prepare(
          `INSERT INTO session_state (key, value, updated_at) VALUES ('pending_next', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify({ task: previous.task, chain: previous.chain }), new Date().toISOString());
      return previous;
    }
    const restored = { ...previous };
    outDb
      .prepare("UPDATE session_state SET value = ?, updated_at = ? WHERE key = 'work_continuation'")
      .run(JSON.stringify(restored), new Date().toISOString());
    return restored;
  })();
}

function restoreStoppedContinuationAttempt(
  session: Session,
  attempted: HostWorkContinuation,
  previous: HostWorkContinuation,
): void {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDbRw(session.agent_group_id, session.id);
    restoreWorkContinuationResumeAttempt(db, attempted, previous);
  } catch (err) {
    log.warn('Failed to restore continuation recovery attempt after rejected wake', { sessionId: session.id, err });
  } finally {
    db?.close();
  }
}

export function hasDueRecoveryWake(inDb: Database.Database, nowIso: string): boolean {
  return Boolean(
    inDb
      .prepare(
        `SELECT 1 FROM messages_in
         WHERE status = 'pending'
           AND trigger = 1
           AND (process_after IS NULL OR datetime(process_after) <= datetime(?))
           AND (id LIKE 'ceiling-respawn-%' OR id LIKE 'host-restart-%' OR id LIKE 'provider-heal-%')
         LIMIT 1`,
      )
      .get(nowIso),
  );
}

export function parkDueRecoveryWakes(inDb: Database.Database, nowIso: string): number {
  return inDb
    .prepare(
      `UPDATE messages_in
       SET status = 'completed'
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime(?))
         AND (id LIKE 'ceiling-respawn-%' OR id LIKE 'host-restart-%' OR id LIKE 'provider-heal-%')`,
    )
    .run(nowIso).changes;
}

export function notifyContinuationParked(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  continuation: HostWorkContinuation,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => writeOutboundDirect(session.agent_group_id, session.id, message),
): boolean {
  const marker = `continuation_recovery_parked:${continuation.id}:${continuation.recovery_episode}`;
  if (outDb.prepare('SELECT 1 FROM messages_out WHERE content LIKE ? LIMIT 1').get(`%${marker}%`)) return false;
  const sourceRouting = continuation.source_message_id
    ? (inDb
        .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE id = ?')
        .get(continuation.source_message_id) as
        | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
        | undefined)
    : undefined;
  const routing = sourceRouting?.channel_type && sourceRouting.platform_id ? sourceRouting : readSessionRouting(inDb);
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

/**
 * How many self-heal marker rows carrying `idPrefix` were written since the
 * last genuine (non-system) inbound message. Real user input is what resets a
 * recovery budget, so the cap is expressed against it rather than a wall clock.
 */
function countRecoveryAttemptsSinceRealInbound(inDb: Database.Database, idPrefix: string): number {
  const row = inDb
    .prepare(
      `SELECT COUNT(*) AS count FROM messages_in
       WHERE id LIKE ?
         AND datetime(timestamp) > COALESCE((
           SELECT MAX(datetime(timestamp)) FROM messages_in
           WHERE kind != 'system'
             AND COALESCE(
               json_extract(CASE WHEN json_valid(content) THEN content ELSE '{}' END, '$.senderId'),
               ''
             ) != 'system'
             AND COALESCE(
               json_extract(CASE WHEN json_valid(content) THEN content ELSE '{}' END, '$.sender'),
               ''
             ) != 'system'
         ), datetime('0001-01-01T00:00:00.000Z'))`,
    )
    .get(`${idPrefix}%`) as { count: number };
  return row.count;
}

export function countToolRecoveryAttemptsSinceRealInbound(inDb: Database.Database): number {
  return countRecoveryAttemptsSinceRealInbound(inDb, `${CEILING_RESPAWN_ID_PREFIX}tool-`);
}

/**
 * Write one deferred, on-wake accountability row (plus its inert recall marker)
 * into the host-owned inbound DB. The row id doubles as the durable marker the
 * per-class attempt caps count, so every self-heal action goes through here.
 */
function writeSystemWake(
  inDb: Database.Database,
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
  return insertDeferredMessageWithContextIfNew(inDb, {
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
  inDb: Database.Database,
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
  writeSystemWake(inDb, session, `${CEILING_RESPAWN_ID_PREFIX}${recoveryKey}`, text, {
    kind: 'agent_ceiling_respawn',
    reason,
    heartbeat_age_ms: heartbeatAgeMs,
  });
}

/** The follow-up half of the kill-ceiling branch, driven only by durable work state or a fresh tool start. */
function applyCeilingFollowUp(
  inDb: Database.Database,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  const priorToolAttempts = countToolRecoveryAttemptsSinceRealInbound(inDb);
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
  writeCeilingRespawn(inDb, session, followUp.reason, recoveryKey, heartbeatAgeMs, workContinuation, ceilingMs);
  log.info('Queued ceiling-kill accountability wake', { sessionId: session.id, reason: followUp.reason });
  return followUp;
}

/** Test-only re-export with injected session-DB handles. */
export function _applyCeilingFollowUpForTesting(
  inDb: Database.Database,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  return applyCeilingFollowUp(inDb, session, containerState, workContinuation, heartbeatAgeMs, ceilingMs);
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

export function countProviderHealAttemptsSinceRealInbound(inDb: Database.Database): number {
  return countRecoveryAttemptsSinceRealInbound(inDb, PROVIDER_HEAL_ID_PREFIX);
}

/** Age of the newest provider-heal marker row, or null when there is none. */
export function providerHealLastAttemptAgeMs(inDb: Database.Database, now: number): number | null {
  const row = inDb
    .prepare('SELECT MAX(timestamp) AS ts FROM messages_in WHERE id LIKE ?')
    .get(`${PROVIDER_HEAL_ID_PREFIX}%`) as { ts: string | null } | undefined;
  if (!row?.ts) return null;
  const at = parseSqliteUtc(row.ts);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** Newest provider-heal marker id — the per-episode idempotency key for the parked notice. */
function providerHealLastAttemptId(inDb: Database.Database): string | null {
  const row = inDb
    .prepare('SELECT MAX(id) AS id FROM messages_in WHERE id LIKE ?')
    .get(`${PROVIDER_HEAL_ID_PREFIX}%`) as { id: string | null } | undefined;
  return row?.id ?? null;
}

/**
 * Kill the failed container and queue the accountability wake that respawns it.
 * The wake row is written BEFORE the kill so the attempt is durably counted
 * even if the kill fizzles; on_wake rows are only consumed by a fresh
 * container's first poll, so the dying one cannot steal it.
 */
function applyProviderHeal(
  inDb: Database.Database,
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
    inDb,
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
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  failureReason: string | null,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => writeOutboundDirect(session.agent_group_id, session.id, message),
): boolean {
  const episode = providerHealLastAttemptId(inDb) ?? 'unknown';
  const marker = `provider_heal_parked:${episode}`;
  if (outDb.prepare('SELECT 1 FROM messages_out WHERE content LIKE ? LIMIT 1').get(`%${marker}%`)) return false;
  const routing = readSessionRouting(inDb);
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
 * Detection + action for one alive session. Always advances the debounce;
 * acts only when NANOCLAW_SELF_HEAL is armed. Returns true when the container
 * was killed, so the caller skips the reap/SLA checks for this tick.
 */
function sweepProviderHeal(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[4],
): boolean {
  const providerStatus = containerState?.provider_status ?? null;
  const consecutiveFailedTicks = observeProviderStatus(session.id, providerStatus);
  const priorAttempts = countProviderHealAttemptsSinceRealInbound(inDb);
  const msSinceLastAttempt = providerHealLastAttemptAgeMs(inDb, Date.now());
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
      notifyProviderHealParked(
        inDb,
        outDb,
        session,
        containerState?.provider_failure_reason ?? null,
        writeParkedMessage,
      );
    } catch (err) {
      log.warn('self-heal: parked notice failed', { sessionId: session.id, err });
    }
    return true;
  }

  applyProviderHeal(inDb, session, agentGroupFolder, containerState);
  return true;
}

/** Test-only re-export with injected session-DB handles. */
export function _sweepProviderHealForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[4],
): boolean {
  return sweepProviderHeal(inDb, outDb, session, agentGroupFolder, containerState, writeParkedMessage);
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
  stopMemoryCurationInBackground();
}

async function sweep(): Promise<void> {
  // Stall attribution: the sweep is the main 60s-periodic bulk worker, so a
  // slow tick is the first suspect whenever the event-loop stall detector
  // fires. One line per slow tick, with the per-session share, convicts or
  // clears it from the log alone.
  const sweepStartedAtMs = Date.now();
  let sessionsMs = 0;
  let sweptSessions = 0;
  if (!running) return;

  // Re-heal the egress network so already-running agents keep their gateway hop
  // if it was detached out-of-band. Best-effort here: a heal failure isn't a
  // leak (agents stay on the internal net), so log and continue. No-op when
  // lockdown is disabled.
  try {
    ensureEgressNetwork();
  } catch (err) {
    log.error('Egress lockdown re-heal failed', { err });
  }

  let sessions: Session[] = [];
  try {
    sessions = getActiveSessions();
  } catch (err) {
    log.error('Host sweep: failed to load active sessions', { err });
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
  let skippedQuiet = 0;
  for (const session of sessions) {
    const mark = quietSessions.get(session.id);
    if (mark && Date.now() < mark.skipUntilMs && mark.lastActive === session.last_active) {
      skippedQuiet++;
      continue;
    }
    quietSessions.delete(session.id);
    try {
      const quietUntil = await sweepSession(session);
      if (quietUntil !== null) {
        quietSessions.set(session.id, { skipUntilMs: quietUntil, lastActive: session.last_active });
      }
      sweptSessions++;
    } catch (err) {
      log.error('Host sweep error', { err, sessionId: session.id });
    }
    // Yield to the macrotask queue so a large sweep batch cannot trip the
    // event-loop stall detector even on a cold tick.
    // Yield after EVERY swept session, not every 25. A swept session costs
    // up to ~1.5s of synchronous SQLite/filesystem work, so a 10-session
    // batch between yields was one contiguous 15s event-loop freeze — the
    // dominant source of the residual 5-8s stall detections (and delivery
    // latency) after the recovery-storm fixes. Per-session setImmediate
    // overhead is microseconds against that cost.
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Bound the cache to sessions that still exist (closed sessions drop out
  // of getActiveSessions and would otherwise accumulate forever).
  if (quietSessions.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of quietSessions.keys()) if (!live.has(id)) quietSessions.delete(id);
  }
  sessionsMs = Date.now() - sessionsStartedAtMs;
  lastSkippedQuiet = skippedQuiet;

  // Finalize any "Reject with reason…" holds whose reply window elapsed (admin
  // ghosted, or the host restarted mid-capture). Central-DB scan, once per tick
  // — not per session.
  // MODULE-HOOK:approvals-reason-sweep:start
  try {
    const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
    await sweepAwaitingReasonRejects();
  } catch (err) {
    log.error('Reject-with-reason sweep failed', { err });
  }
  // MODULE-HOOK:approvals-reason-sweep:end

  // MODULE-HOOK:orchestrator-dispatch:reconciler — complete admitted-but-incomplete tasks.
  // Runs after per-session sweeps so container state is current.
  runReconcilerSweep();

  // Prune steer_idempotency rows: applied rows older than 60s, pending rows older than 5min.
  pruneSteerIdempotency();
  pruneChannelIngressReceipts();

  // MODULE-HOOK:scheduled-move-recovery — autonomous recovery of unresolved
  // move intents + 90d audit-body prune. Additive (same pattern as the
  // recurrence hook); touches only scheduled_audit (central) + the move's own
  // session inbound rows — no firing-path change (C1).
  try {
    recoverMoveIntents(getDb(), {});
    pruneAuditBodies(getDb(), {});
  } catch (err) {
    log.warn('scheduled-move-recovery: sweep hook failed', { err });
  }

  // Reclaim disk from idle caches and Docker artifacts after per-session
  // sweep work has had a chance to notice and wake due messages.
  // Fire-and-forget into a persistent worker. The worker owns the expensive
  // synchronous filesystem/Docker implementation and its cadence state; the
  // host event loop stays available for channel heartbeats and inbound events.
  void runStorageMaintenanceInBackground(getActiveContainerSessionIds())
    .then((storageReport) => (storageReport ? handleStoragePressureAlert(storageReport) : undefined))
    .catch((err) => log.warn('storage-manager: background maintenance failed', { err }));

  // Auto-archive completed tasks older than 24h so the "Done" lane stays
  // representative of recent work; failed tasks are intentionally skipped.
  autoArchiveOldCompleted();

  // Inbox: generate Haiku titles for sessions that don't have one (or
  // whose existing title is ≥1h old AND has ≥10 new messages since).
  // Concurrency-capped at 3 per tick — keeps the API spend bounded.
  void import('./dashboard/session-title-sweep.js')
    .then((mod) => mod.runSessionTitleSweep())
    .catch((err) => log.warn('session-title sweep failed', { err }));

  // Workgroup memory curation is durable, debounced, and never awaited by the
  // sweep. The module enforces one active pump globally and fails closed.
  void runMemoryCurationInBackground().catch((err) => log.warn('memory-curator: background pump failed', { err }));

  // Graph-scent warmth: probe ONE workgroup per sweep, round-robin. The probe
  // pays the cold-graph cost (up to ~800ms measured) here on the batch timer;
  // readGraphScent only ever queries workgroups a probe marked warm, so the
  // message-write path never runs a cold FTS query.
  try {
    probeNextGraphScentWorkgroup();
  } catch (err) {
    log.warn('graph-scent: warmth probe failed', { err });
  }

  // Prune dashboard_tokens rows past expiry + 1d grace (post-build QA fix SF-6).
  void import('./dashboard/db/dashboard-tokens.js')
    .then((mod) => mod.pruneDashboardTokens())
    .catch(() => {
      /* dashboard module may not be initialized in tests */
    });

  // MODULE-HOOK:orchestrator-dispatch:watchdog — reap tasks that have exceeded
  // their deadline, spawn window, no-progress timeout, or whose child container exited.
  await sweepTaskWatchdog();

  // Fleet-hardening Phase 0.1 (per-turn usage accounting): roll
  // per-session turn_usage rows into the central usage_daily table for `ncl
  // usage`. Reuses the same `sessions` list the per-session loop above already
  // fetched — no extra DB query. Isolated so a rollup failure never blocks
  // the rest of the tick.
  try {
    sweepUsageRollup(sessions);
  } catch (err) {
    log.warn('Usage rollup sweep step failed', { err });
  }

  // Self-heal class 3: nudge (then, if armed, offer takeover of) stale work
  // claims — see src/modules/claims/self-heal.ts. Throttled internally to
  // once per 10 minutes; isolated so a scan failure never blocks the rest of
  // the tick.
  try {
    await sweepClaimsSelfHeal();
  } catch (err) {
    log.warn('Claims self-heal sweep step failed', { err });
  }

  const sweepMs = Date.now() - sweepStartedAtMs;
  if (sweepMs >= 1_000) {
    log.info('Host sweep tick timing', { sweepMs, sessionsMs, sweptSessions, skippedQuiet: lastSkippedQuiet });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/**
 * Scheduled-task containers have no interactive follow-up window to preserve.
 * Once the provider is not executing, no message is claimed, and no work is
 * due, reap the container immediately so background work does not hold a
 * memory reservation until the general 30-minute idle ceiling.
 *
 * This deliberately does NOT key on `provider_status`. Every container clears
 * that column to 'idle' at startup (clearStaleProcessingAcks →
 * clearProviderHealthState, container/agent-runner/src/db/connection.ts), and
 * only the Codex provider ever writes it again — so for every other provider
 * the old `providerStatus === 'idle'` term was true from second one of the
 * container's life and the guard did nothing. `provider_executing` is the
 * maintained equivalent: the shared poll loop sets it around every turn for
 * every provider, including the runner-pushed follow-up turns (wrapping-retry
 * nudges, post-compaction bootstrap re-injection) that hold no processing
 * claim and would otherwise be killable mid-turn.
 *
 * An active work_continuation also blocks the reap. `continue_work` is the
 * only sanctioned way to promise follow-up, and between turn end and
 * continuation admission the container has no claim and is not executing —
 * reaping there punished the agent for doing the sanctioned thing and
 * demoted it to the throttled 10-minute host recovery path. The chat path
 * has always guarded this; the task path now matches.
 */
export function shouldReapIdleTaskContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  providerExecuting: boolean,
  hasActiveContinuation: boolean,
): boolean {
  return (
    isTaskThread(threadId) &&
    dueMessageCount === 0 &&
    processingClaimCount === 0 &&
    !providerExecuting &&
    !hasActiveContinuation
  );
}

/**
 * Chat/channel containers have an interactive follow-up window worth
 * preserving (a human may reply within seconds), so unlike task containers
 * they get a quiet-duration floor before reaping. `provider_status` is not
 * usable here — every container clears it to 'idle' at startup and only the
 * Codex provider (container/agent-runner/src/providers/codex.ts) writes it
 * again, so for other providers it reads 'idle' for the container's whole
 * life. This keys on the durable, provider-agnostic signal instead: no due
 * message, no
 * claimed message, no pending work_continuation promise, and the container's
 * last outbound row (chat or status) is older than CHAT_IDLE_REAP_MS. State
 * lives entirely in inbound.db/outbound.db, so the next @mention respawns
 * and resumes exactly like a stuck-ceiling kill does today.
 */
export const CHAT_IDLE_REAP_MS = 15 * 60 * 1000;

export function shouldReapIdleChatContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  hasActiveContinuation: boolean,
  lastOutboundAtMs: number | null,
  lastInboundAtMs: number | null,
  now: number,
): boolean {
  if (isTaskThread(threadId)) return false; // task threads use shouldReapIdleTaskContainer
  if (dueMessageCount !== 0 || processingClaimCount !== 0 || hasActiveContinuation) return false;
  if (lastOutboundAtMs === null) return false;
  // Idleness is the newest activity in EITHER direction, not just outbound.
  // A container that has consumed a fresh message but not yet emitted its
  // first status looks identical to an idle one from outbound alone, and the
  // other guards do not cover it: the row is already `completed` so dueCount
  // is 0, and processing claims are not written on this path. Observed live
  // 2026-08-12 — a user message landed 16.0 min after the previous reply and
  // the reaper killed the container 11s into the turn, so the turn produced
  // no answer at all. 15 min after the last reply is precisely when a human
  // returns to a thread, so this was the common case, not an edge.
  const lastActivityAtMs = Math.max(lastOutboundAtMs, lastInboundAtMs ?? 0);
  return now - lastActivityAtMs >= CHAT_IDLE_REAP_MS;
}

/** Most recent messages_in timestamp for a session, or null if it has none. */
function getLastInboundAtMs(inDb: Database.Database): number | null {
  const row = inDb.prepare('SELECT timestamp FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  if (!row) return null;
  const ms = Date.parse(row.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent messages_out timestamp for a session, or null if it has never produced output. */
function getLastOutboundAtMs(outDb: Database.Database): number | null {
  const row = outDb.prepare('SELECT timestamp FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  if (!row) return null;
  const ms = parseSqliteUtc(row.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

async function prepareDueWake(
  inDb: Database.Database,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  // Fleet-hardening Phase 1.1: run any opted-in (scriptHost) pre-task scripts
  // on the host BEFORE admission, so a gated/errored fire never becomes due
  // and never spawns a container. See host-script.ts's runHostGatedTaskScripts.
  await runHostGatedTaskScripts(inDb, sessionId);
  const admittedTasks = admitDueTaskContexts(inDb, agentGroupId, sessionId);
  const dueCount = countDueMessages(inDb);
  return {
    admittedTasks,
    dueCount,
    wakePriority: dueCount > 0 ? getDueWakePriority(inDb) : 'interactive',
  };
}

export async function _prepareDueWakeForTesting(
  inDb: Database.Database,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  return prepareDueWake(inDb, agentGroupId, sessionId);
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
 * Sweep one session. Returns a quiet-until timestamp (ms) when the session is
 * fully quiet and safe to skip until then, or null when it must stay hot.
 */
async function sweepSession(session: Session): Promise<number | null> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return Date.now() + QUIET_SESSION_BACKOFF_MS;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return Date.now() + QUIET_SESSION_BACKOFF_MS;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return Date.now() + QUIET_SESSION_BACKOFF_MS;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 1a. Expire long-pending rows so sweep stops re-waking sessions on
    // messages that have been sitting unprocessed past the age cutoff.
    const expired = expireStalePending(inDb, PENDING_MESSAGE_MAX_AGE_MS);
    if (expired > 0) {
      log.info('Expired stale pending messages', {
        sessionId: session.id,
        count: expired,
        maxAgeMs: PENDING_MESSAGE_MAX_AGE_MS,
      });
    }

    // 2. A stopped container with processing claims crashed mid-turn. Defer
    // the paired input first, while it is still inert-able, and clear the
    // orphan claim before any due-count or wake decision can expose its stale
    // recall to a replacement/warm poller. When backoff elapses, the admission
    // seam below replaces that recall from current host state.
    if (!isContainerRunning(session.id) && outDb && getProcessingClaims(outDb).length > 0) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 3. Admit due scheduled occurrences and lifecycle wakes with fresh
    // recall/capabilities
    // immediately before they become wakeable. Task rows stay trigger=0 from
    // creation through this point; paired lifecycle wakes stay trigger=0 throughout
    // backoff. A warm poller cannot race ahead of either context pair, and a
    // repeated sweep is idempotent.
    const preparedWake = await prepareDueWake(inDb, agentGroup.id, session.id);
    const { admittedTasks } = preparedWake;
    let { dueCount, wakePriority } = preparedWake;
    if (admittedTasks > 0) {
      log.debug('Admitted due turns with fresh context', {
        sessionId: session.id,
        count: admittedTasks,
      });
    }

    // 4. Wake a container if work is due and nothing is running. Durable
    // continuation state is also a wake source, but its automatic crash
    // recovery is both throttled and hard-capped per continuation id.
    let justWoke = false;
    const workContinuation = outDb ? readWorkContinuation(outDb) : null;
    if (
      !isContainerRunning(session.id) &&
      workContinuation &&
      workContinuation.resume_attempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS
    ) {
      const parked = parkDueRecoveryWakes(inDb, new Date().toISOString());
      if (parked > 0) {
        dueCount = countDueMessages(inDb);
        wakePriority = dueCount > 0 ? getDueWakePriority(inDb) : 'interactive';
      }
      if (dueCount === 0) notifyContinuationParked(inDb, outDb!, session, workContinuation);
    }
    // Every stopped-session wake must pass through continuation recovery
    // admission, even when an unrelated scheduled row is already due. The
    // runner retains its prior owner claim until this path clears it, so a
    // scheduled wake cannot make saved work bypass the throttle or cap.
    const continuationWakeEligible =
      outDb !== null &&
      !isContainerRunning(session.id) &&
      workContinuation !== null &&
      canAttemptContinuationRecovery(workContinuation) &&
      decideContinuationWake({
        now: Date.now(),
        spawnedAtMs: getContainerSpawnedAt(session.id),
        lastRecoveryAttemptAtMs: readContinuationRecoveryAttemptAt(outDb!, workContinuation),
      });
    const resumedContinuation = continuationWakeEligible
      ? incrementStoppedContinuationAttempt(session, workContinuation!.id)
      : null;
    const continuationWake = resumedContinuation !== null;
    if ((dueCount > 0 || continuationWake) && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', {
        sessionId: session.id,
        count: dueCount,
        priority: wakePriority,
        continuationId: resumedContinuation?.id,
      });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      // Classification is passed into the atomic admission decision so a
      // scheduled wake can never reserve memory as interactive first.
      const woke = await wakeContainer(session, wakePriority);
      justWoke = woke;
      if (!woke && resumedContinuation) {
        restoreStoppedContinuationAttempt(session, resumedContinuation, workContinuation!);
      }
    }

    const alive = isContainerRunning(session.id);

    // 5. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Skip on the same iteration that just woke the container — it hasn't
    // had a chance to clear stale processing_ack rows from a previous crash
    // yet. Without this grace period, stale claims cause an immediate
    // spawn-kill loop.
    if (alive && outDb && !justWoke) {
      const containerState = getContainerState(outDb);
      const processingClaimCount = getProcessingClaims(outDb).length;
      // 5a. Failed-provider self-heal. Runs first: a container whose provider
      // has given up is not idle and not merely stuck, and healing it beats
      // both reaping it as idle and waiting out the 30-minute ceiling. Returns
      // true only when it killed the container, in which case the reap/SLA
      // checks below have nothing left to decide this tick.
      if (sweepProviderHeal(inDb, outDb, session, agentGroup.folder, containerState)) {
        log.debug('Provider self-heal handled this tick — skipping reap/SLA checks', { sessionId: session.id });
      } else if (
        shouldReapIdleTaskContainer(
          session.thread_id,
          dueCount,
          processingClaimCount,
          containerState?.provider_executing === 1,
          workContinuation !== null,
        )
      ) {
        log.info('Reaping idle scheduled-task container', { sessionId: session.id, threadId: session.thread_id });
        killContainer(session.id, 'scheduled-task-idle');
      } else if (
        shouldReapIdleChatContainer(
          session.thread_id,
          dueCount,
          processingClaimCount,
          workContinuation !== null,
          getLastOutboundAtMs(outDb),
          getLastInboundAtMs(inDb),
          Date.now(),
        )
      ) {
        log.info('Reaping idle chat container', {
          sessionId: session.id,
          threadId: session.thread_id,
          idleFloorMs: CHAT_IDLE_REAP_MS,
        });
        killContainer(session.id, 'chat-idle-reap');
      } else {
        enforceRunningContainerSla(inDb, outDb, session, agentGroup.id, agentGroup.folder);
      }
    }

    // 6. Retry cleanup if the pre-wake orphan-claim clear could not finish.
    // resetStuckProcessingRows is idempotent: future retries are not bumped
    // again, and already-cleared claim sets are a no-op.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }
    // A container that is gone cannot be mid-failure. Clearing here stops a
    // fresh container from inheriting the dead one's half-finished debounce and
    // being killed on its first 'failed' observation.
    if (!alive) providerFailedTicks.delete(session.id);

    // 7. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end

    // 8. GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    if (isTaskThread(session.thread_id)) {
      const liveTasks = (
        inDb
          .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { c: number }
      ).c;
      if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
        updateSession(session.id, { status: 'closed' });
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    }

    // Quiet-cache hint: nothing live here — no container, nothing due or
    // admitted, no continuation. Safe to skip until the next scheduled row is
    // due (never past it) or the backoff cap. New inbound invalidates via
    // last_active in the sweep loop.
    if (dueCount === 0 && admittedTasks === 0 && !justWoke && workContinuation === null && !alive) {
      const nextDue = getNextFutureProcessAfter(inDb);
      const cap = Date.now() + QUIET_SESSION_BACKOFF_MS;
      const nextDueMs = nextDue ? Date.parse(nextDue) : Number.POSITIVE_INFINITY;
      return Math.min(Number.isFinite(nextDueMs) ? nextDueMs : cap, cap);
    }
    return null;
  } finally {
    inDb.close();
    outDb?.close();
  }
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

function sweepUsageRollup(sessions: Session[]): void {
  for (const session of sessions) {
    try {
      const outPath = outboundDbPath(session.agent_group_id, session.id);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(outPath).mtimeMs;
      } catch {
        continue; // container never spawned yet — no outbound.db to roll up
      }
      if (shouldSkipUsageRollup(usageRollupMtimeCache.get(session.id), mtimeMs)) continue;

      const outDb = openOutboundDb(session.agent_group_id, session.id);
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

export function pruneSteerIdempotency(): void {
  try {
    const db = getDb();
    // Delete applied rows older than 60 seconds
    db.prepare(
      `DELETE FROM steer_idempotency WHERE status = 'applied' AND datetime(applied_at) < datetime('now', '-60 seconds')`,
    ).run();
    // Delete pending rows older than 5 minutes (crash-recovery window expires)
    db.prepare(
      `DELETE FROM steer_idempotency WHERE status = 'pending' AND datetime(reserved_at) < datetime('now', '-300 seconds')`,
    ).run();
  } catch (err) {
    log.warn('pruneSteerIdempotency: failed', { err });
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

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
  agentGroupFolder: string,
): void {
  const containerState = getContainerState(outDb);
  reportContainerOomTelemetry(inDb, session, agentGroupFolder, containerState);
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState,
    claims: getProcessingClaims(outDb),
    spawnedAtMs: getContainerSpawnedAt(session.id),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    // Snapshot claims BEFORE kill so the notify helper has the pre-kill
    // state — resetStuckProcessingRows clears the claims, so a read
    // afterward would always be empty.
    const pendingClaims = getProcessingClaims(outDb).length;
    const workContinuation = readWorkContinuation(outDb);
    killContainer(session.id, 'absolute-ceiling');
    // Posted AFTER kill to honor the outbound.db single-writer invariant
    // (session-db.ts:openOutboundDbWritable). The helper itself gates on
    // `pendingClaims === 0` (no user was waiting) to avoid spamming
    // restart notices on quiet sessions that just naturally reached the
    // 30-min idle ceiling.
    notifyKillCeiling(inDb, outDb, session, decision.heartbeatAgeMs, pendingClaims, undefined, containerState);
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    // Accountability wake: if the kill plausibly interrupted parked work,
    // queue an on_wake row so the session respawns (next sweep tick's
    // due-wake step) and answers for the interruption instead of staying
    // dead until the next human ping. Best-effort — a failure here must
    // not break the sweep's kill path.
    try {
      applyCeilingFollowUp(
        inDb,
        session,
        containerState,
        workContinuation,
        decision.heartbeatAgeMs,
        decision.ceilingMs,
      );
    } catch (err) {
      log.warn('ceiling-kill follow-up failed', { sessionId: session.id, err });
    }
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
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
  inDb: Database.Database,
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
      inDb,
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
      inDb,
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
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
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
 * The optional `writableOutDb` parameter mirrors `resetStuckProcessingRows`:
 * tests pass an in-memory writable handle; production omits it and the
 * function opens a fresh writable handle by path via writeOutboundDirect.
 */
export function notifyKillCeiling(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  writableOutDb?: Database.Database,
  containerState?: ContainerState | null,
): void {
  try {
    if (pendingClaims === 0) {
      log.debug('kill-ceiling notify skipped — no pending claims, user was not waiting', {
        sessionId: session.id,
      });
      return;
    }
    const routing = readSessionRouting(inDb);
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
    const recent = outDb
      .prepare(
        "SELECT 1 FROM messages_out WHERE datetime(timestamp) > datetime('now', '-60 seconds') AND content LIKE '%agent_restart_inactivity%' LIMIT 1",
      )
      .get();
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
    if (writableOutDb) {
      writableOutDb
        .prepare(
          `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          new Date().toISOString(),
          'chat',
          routing.platform_id,
          routing.channel_type,
          routing.thread_id,
          content,
        );
    } else {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id,
        kind: 'chat',
        platformId: routing.platform_id,
        channelType: routing.channel_type,
        threadId: routing.thread_id,
        content,
      });
    }
  } catch (err) {
    log.warn('kill-ceiling notify failed', { sessionId: session.id, err });
  }
}

/** Test-only re-export with an injected writable outbound DB handle. */
export function _notifyKillCeilingForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  notifyKillCeiling(inDb, outDb, session, heartbeatAgeMs, pendingClaims, outDb, containerState);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  // Progress rows are not answers. Match the container-side pending-message
  // query so an interrupted turn that emitted only status updates is retried.
  const respondedStmt = outDb.prepare("SELECT 1 FROM messages_out WHERE in_reply_to = ? AND kind != 'status' LIMIT 1");
  const markCompletedInboundStmt = inDb.prepare(
    "UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'",
  );
  const now = Date.now();

  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
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
    const responded = respondedStmt.get(msg.id);
    if (responded) {
      markCompletedInboundStmt.run(msg.id);
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
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      deferMessageForFreshContextRetry(inDb, msg.id, backoffSec);
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
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
