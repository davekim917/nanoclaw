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

import { ensureEgressNetwork } from './egress-lockdown.js';
import { readContainerConfig } from './container-config.js';
import { resolveContainerResources } from './container-resources.js';
import { getActiveSessions, getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
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
import { purgeIntentBody } from './dashboard/api/scheduled-shared.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  sessionsBaseDir,
  writeOutboundDirect,
  writeSessionMessage,
  admitDueTaskContexts,
  deferMessageForFreshContextRetry,
} from './session-manager.js';
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
  phase: 'queued' | 'running';
  chain: number;
  runner_id?: string;
  resume_attempts: number;
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
        (parsed.runner_id !== undefined && (typeof parsed.runner_id !== 'string' || parsed.runner_id === ''))
      ) {
        return null;
      }
      return {
        id: parsed.id,
        task: parsed.task.trim(),
        phase: parsed.phase,
        chain: parsed.chain as number,
        ...(parsed.runner_id ? { runner_id: parsed.runner_id } : {}),
        resume_attempts: parsed.resume_attempts as number,
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
    const updated = { ...current, resume_attempts: current.resume_attempts + 1 };
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
  expectedId: string,
  expectedAttempts: number,
): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const current = readWorkContinuation(outDb);
    if (!current || current.id !== expectedId || current.resume_attempts !== expectedAttempts) return null;
    const restored = { ...current, resume_attempts: Math.max(0, expectedAttempts - 1) };
    outDb
      .prepare("UPDATE session_state SET value = ?, updated_at = ? WHERE key = 'work_continuation'")
      .run(JSON.stringify(restored), new Date().toISOString());
    return restored;
  })();
}

function restoreStoppedContinuationAttempt(session: Session, expectedId: string, expectedAttempts: number): void {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDbRw(session.agent_group_id, session.id);
    restoreWorkContinuationResumeAttempt(db, expectedId, expectedAttempts);
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
           AND (id LIKE 'ceiling-respawn-%' OR id LIKE 'host-restart-%')
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
         AND (id LIKE 'ceiling-respawn-%' OR id LIKE 'host-restart-%')`,
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
  const marker = `continuation_recovery_parked:${continuation.id}`;
  if (outDb.prepare('SELECT 1 FROM messages_out WHERE content LIKE ? LIMIT 1').get(`%${marker}%`)) return false;
  const routing = readSessionRouting(inDb);
  if (!routing) return false;
  writeMessage({
    id: `continuation-parked-${continuation.id}`,
    kind: 'chat',
    platformId: routing.platform_id,
    channelType: routing.channel_type,
    threadId: routing.thread_id,
    content: JSON.stringify({
      text:
        `⚠️ I could not resume the interrupted work after ${WORK_CONTINUATION_RESUME_MAX_ATTEMPTS} automatic attempts. ` +
        `The task is still saved: ${continuation.task}. Reply in this thread and I will try again.`,
      _system: { kind: marker, continuation_id: continuation.id },
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
}): CeilingFollowUp {
  if (args.hasContinuation) return { action: 'wake-accountable', reason: 'continuation' };
  if (!args.currentTool || !args.toolStartedAt) return { action: 'none' };
  const startedAt = parseSqliteUtc(args.toolStartedAt);
  if (!Number.isFinite(startedAt) || startedAt > args.now || args.now - startedAt > ABSOLUTE_CEILING_MS) {
    return { action: 'none' };
  }
  if (args.priorToolAttempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS) return { action: 'none' };
  return { action: 'wake-accountable', reason: 'tool' };
}

const CEILING_RESPAWN_ID_PREFIX = 'ceiling-respawn-';

export function countToolRecoveryAttemptsSinceRealInbound(inDb: Database.Database): number {
  const row = inDb
    .prepare(
      `SELECT COUNT(*) AS count FROM messages_in
       WHERE id LIKE '${CEILING_RESPAWN_ID_PREFIX}tool-%'
         AND timestamp > COALESCE((
           SELECT MAX(timestamp) FROM messages_in
           WHERE kind != 'system'
             AND COALESCE(json_extract(content, '$.senderId'), '') != 'system'
             AND COALESCE(json_extract(content, '$.sender'), '') != 'system'
         ), '')`,
    )
    .get() as { count: number };
  return row.count;
}

function writeCeilingRespawn(
  inDb: Database.Database,
  session: Session,
  reason: 'continuation' | 'tool',
  recoveryKey: string,
  heartbeatAgeMs: number,
): void {
  const idleMinutes = Math.round(ABSOLUTE_CEILING_MS / 60_000);
  const silentMinutes = Math.round(heartbeatAgeMs / 60_000);
  const text =
    `[system] Your previous container was killed by the ${idleMinutes}-minute idle ceiling ` +
    `(no active turn for ~${silentMinutes} min). If work was in flight: check your durable checkpoints, ` +
    `resume what is safely resumable, and post ONE message accounting for state — done / lost / next. ` +
    `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
    `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay. ` +
    `If nothing was in flight, say so in one line.`;
  insertDeferredMessageWithContextIfNew(inDb, {
    id: `${CEILING_RESPAWN_ID_PREFIX}${recoveryKey}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
      _system: { kind: 'agent_ceiling_respawn', reason, heartbeat_age_ms: heartbeatAgeMs },
    }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
}

/** The follow-up half of the kill-ceiling branch, driven only by durable work state or a fresh tool start. */
function applyCeilingFollowUp(
  inDb: Database.Database,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
): CeilingFollowUp {
  const followUp = decideCeilingFollowUp({
    hasContinuation: workContinuation !== null && canAttemptContinuationRecovery(workContinuation),
    currentTool: containerState?.current_tool ?? null,
    toolStartedAt: containerState?.tool_started_at ?? null,
    priorToolAttempts: countToolRecoveryAttemptsSinceRealInbound(inDb),
    now: Date.now(),
  });
  if (followUp.action === 'wake-accountable') {
    const recoveryKey =
      followUp.reason === 'continuation'
        ? `continuation-${workContinuation!.id}-${workContinuation!.resume_attempts}`
        : `tool-${encodeURIComponent(containerState?.tool_started_at ?? 'unknown')}`;
    writeCeilingRespawn(inDb, session, followUp.reason, recoveryKey, heartbeatAgeMs);
    log.info('Queued ceiling-kill accountability wake', { sessionId: session.id, reason: followUp.reason });
  }
  return followUp;
}

/** Test-only re-export with injected session-DB handles. */
export function _applyCeilingFollowUpForTesting(
  inDb: Database.Database,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
): CeilingFollowUp {
  return applyCeilingFollowUp(inDb, session, containerState, workContinuation, heartbeatAgeMs);
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
  for (const session of sessions) {
    try {
      await sweepSession(session);
    } catch (err) {
      log.error('Host sweep error', { err, sessionId: session.id });
    }
  }

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

  // Prune dashboard_tokens rows past expiry + 1d grace (post-build QA fix SF-6).
  void import('./dashboard/db/dashboard-tokens.js')
    .then((mod) => mod.pruneDashboardTokens())
    .catch(() => {
      /* dashboard module may not be initialized in tests */
    });

  // MODULE-HOOK:orchestrator-dispatch:watchdog — reap tasks that have exceeded
  // their deadline, spawn window, no-progress timeout, or whose child container exited.
  await sweepTaskWatchdog();

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
 * Once the provider is idle, no message is claimed, and no work is due, reap
 * the container immediately so background work does not hold a memory
 * reservation until the general 30-minute idle ceiling.
 */
export function shouldReapIdleTaskContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  providerStatus: string | null | undefined,
): boolean {
  return isTaskThread(threadId) && dueMessageCount === 0 && processingClaimCount === 0 && providerStatus === 'idle';
}

function prepareDueWake(
  inDb: Database.Database,
  agentGroupId: string,
  sessionId: string,
): { admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' } {
  const admittedTasks = admitDueTaskContexts(inDb, agentGroupId, sessionId);
  const dueCount = countDueMessages(inDb);
  return {
    admittedTasks,
    dueCount,
    wakePriority: dueCount > 0 ? getDueWakePriority(inDb) : 'interactive',
  };
}

export function _prepareDueWakeForTesting(
  inDb: Database.Database,
  agentGroupId: string,
  sessionId: string,
): { admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' } {
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

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
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
    const preparedWake = prepareDueWake(inDb, agentGroup.id, session.id);
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
    const recoveryWakeDue = hasDueRecoveryWake(inDb, new Date().toISOString());
    const continuationWakeEligible =
      outDb !== null &&
      !isContainerRunning(session.id) &&
      workContinuation !== null &&
      canAttemptContinuationRecovery(workContinuation) &&
      (dueCount === 0 || recoveryWakeDue) &&
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
        restoreStoppedContinuationAttempt(session, resumedContinuation.id, resumedContinuation.resume_attempts);
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
      if (
        shouldReapIdleTaskContainer(session.thread_id, dueCount, processingClaimCount, containerState?.provider_status)
      ) {
        log.info('Reaping idle scheduled-task container', { sessionId: session.id, threadId: session.thread_id });
        killContainer(session.id, 'scheduled-task-idle');
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
  } finally {
    inDb.close();
    outDb?.close();
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
      `DELETE FROM steer_idempotency WHERE status = 'applied' AND applied_at < datetime('now', '-60 seconds')`,
    ).run();
    // Delete pending rows older than 5 minutes (crash-recovery window expires)
    db.prepare(
      `DELETE FROM steer_idempotency WHERE status = 'pending' AND reserved_at < datetime('now', '-300 seconds')`,
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
  reportContainerOomTelemetry(session, agentGroupFolder, containerState);
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
      applyCeilingFollowUp(inDb, session, containerState, workContinuation, decision.heartbeatAgeMs);
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

function reportContainerOomTelemetry(session: Session, agentGroupFolder: string, state: ContainerState | null): void {
  const count = state?.memory_oom_kill_events;
  if (typeof count !== 'number') return;
  const spawnedAtMs = getContainerSpawnedAt(session.id);
  const delta = oomKillObserver.observe(session.id, spawnedAtMs, count);
  if (delta <= 0) return;

  let configuredLimitMb: number | null = null;
  try {
    configuredLimitMb = resolveContainerResources(readContainerConfig(agentGroupFolder).resources).memory.limitMb;
  } catch {
    // Resource validation already fails closed in the spawn path. Keep OOM
    // diagnostics available even if an operator edits the file mid-run.
  }
  log.warn('Container cgroup OOM kill observed', {
    sessionId: session.id,
    agentGroup: agentGroupFolder,
    newOomKills: delta,
    oomKillCount: count,
    oomEventCount: state?.memory_oom_events ?? null,
    configuredLimitMb,
    cgroupMaxMb: typeof state?.memory_max_bytes === 'number' ? Math.round(state.memory_max_bytes / 1024 / 1024) : null,
    peakMb: typeof state?.memory_peak_bytes === 'number' ? Math.round(state.memory_peak_bytes / 1024 / 1024) : null,
    currentMb:
      typeof state?.memory_current_bytes === 'number' ? Math.round(state.memory_current_bytes / 1024 / 1024) : null,
    telemetryAt: state?.memory_telemetry_at ?? null,
  });
}

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
        "SELECT 1 FROM messages_out WHERE timestamp > datetime('now', '-60 seconds') AND content LIKE '%agent_restart_inactivity%' LIMIT 1",
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
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?)`,
        )
        .run(id, 'chat', routing.platform_id, routing.channel_type, routing.thread_id, content);
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
