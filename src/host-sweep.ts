/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
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

import { getActiveSessions } from './db/sessions.js';
import { getSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  expireStalePending,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  readSessionRouting,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
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
} from './session-manager.js';
import {
  getContainerSpawnedAt,
  hasContainerEverRun,
  isContainerRunning,
  killContainer,
  wakeContainer,
} from './container-runner.js';
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

// Idle session worktrees accumulate per-session pnpm installs that never get
// cleaned up. After this many hours of no inbound/outbound DB activity AND
// no running container, `node_modules` and `.pnpm-store` directories deep
// under the session tree get removed. The source checkout, git state, and
// session DBs are untouched — only regenerable cache artifacts go.
// Tunable via SESSION_ARTIFACT_IDLE_HOURS (default 24).
const parsedIdleHours = Number(process.env.SESSION_ARTIFACT_IDLE_HOURS);
export const SESSION_ARTIFACT_IDLE_MS =
  (Number.isFinite(parsedIdleHours) && parsedIdleHours > 0 ? parsedIdleHours : 24) * 60 * 60 * 1000;

const PRUNABLE_ARTIFACT_DIRS = new Set(['node_modules', '.pnpm-store']);

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
  const declaredBashMs = bashTimeoutMs(containerState);

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
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
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

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
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

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

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

  // MODULE-HOOK:orchestrator-dispatch:reconciler — complete admitted-but-incomplete tasks.
  // Runs after per-session sweeps so container state is current.
  runReconcilerSweep();

  // Prune steer_idempotency rows: applied rows older than 60s, pending rows older than 5min.
  pruneSteerIdempotency();

  // Reclaim disk from idle session worktrees — only `node_modules` and
  // `.pnpm-store` get removed, and only when no container is bound to the
  // session and its DB files are older than SESSION_ARTIFACT_IDLE_MS.
  try {
    pruneIdleSessionArtifacts();
  } catch (err) {
    log.warn('pruneIdleSessionArtifacts: failed', { err });
  }

  // Auto-archive completed tasks older than 24h so the "Done" lane stays
  // representative of recent work; failed tasks are intentionally skipped.
  autoArchiveOldCompleted();

  // Inbox: generate Haiku titles for sessions that don't have one (or
  // whose existing title is ≥1h old AND has ≥10 new messages since).
  // Concurrency-capped at 3 per tick — keeps the API spend bounded.
  void import('./dashboard/session-title-sweep.js')
    .then((mod) => mod.runSessionTitleSweep())
    .catch((err) => log.warn('session-title sweep failed', { err }));

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

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
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

/**
 * Newest mtime across the session's known DB files. Acts as a coarse
 * last-activity signal — host writes inbound.db on every routed message and
 * the container writes outbound.db on every reply, so the newer of the two
 * tracks real I/O. Falls back to 0 when the session dir has none of the
 * expected files (caller treats 0 as "skip, can't tell").
 */
function sessionLastActivityMs(sessPath: string): number {
  let newest = 0;
  for (const name of ['inbound.db', 'outbound.db', 'archive.db', 'central.db', '.heartbeat']) {
    try {
      const m = fs.statSync(path.join(sessPath, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // file missing — ignore
    }
  }
  return newest;
}

function findPrunableArtifactDirs(root: string): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // lstat semantics — skip symlinks to avoid escaping the session subtree
      // and accidentally pruning a shared store outside it.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (PRUNABLE_ARTIFACT_DIRS.has(entry.name)) {
        found.push(full);
        // Don't descend — the whole subtree gets removed by the caller.
        continue;
      }
      stack.push(full);
    }
  }
  return found;
}

function dirSizeBytes(root: string): number {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          stack.push(full);
        } else if (st.isFile()) {
          total += st.size;
        }
      } catch {
        // ignore
      }
    }
  }
  return total;
}

/**
 * Remove regenerable cache artifacts (`node_modules`, `.pnpm-store`) from
 * session directories whose container isn't running and whose DB files
 * haven't been touched in SESSION_ARTIFACT_IDLE_MS. The session dir, source
 * checkout, git state, and DB files are never touched — only the listed
 * cache directory names. Sessions stay alive (host-side), they just shed
 * their pnpm install footprint until next use.
 */
export function pruneIdleSessionArtifacts(now: number = Date.now(), root: string = sessionsBaseDir()): void {
  let groupDirs: fs.Dirent[];
  try {
    groupDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  let dirsRemoved = 0;
  let bytesFreed = 0;

  for (const groupDirent of groupDirs) {
    if (!groupDirent.isDirectory() || groupDirent.isSymbolicLink()) continue;
    const groupPath = path.join(root, groupDirent.name);

    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessDirent of sessionDirs) {
      if (!sessDirent.isDirectory() || sessDirent.isSymbolicLink()) continue;
      // Only `sess-*` are real per-conversation sessions. Sibling dirs like
      // `.claude-memory` and `.claude-shared` live at the group level and
      // are never cache targets.
      if (!sessDirent.name.startsWith('sess-')) continue;

      const sessionId = sessDirent.name;
      if (isContainerRunning(sessionId)) continue;

      const sessPath = path.join(groupPath, sessionId);
      const lastActivity = sessionLastActivityMs(sessPath);
      if (lastActivity === 0) continue;
      if (now - lastActivity < SESSION_ARTIFACT_IDLE_MS) continue;

      for (const target of findPrunableArtifactDirs(sessPath)) {
        let size = 0;
        try {
          size = dirSizeBytes(target);
          fs.rmSync(target, { recursive: true, force: true });
          dirsRemoved += 1;
          bytesFreed += size;
        } catch (err) {
          log.warn('pruneIdleSessionArtifacts: rm failed', { path: target, err });
        }
      }
    }
  }

  if (dirsRemoved > 0) {
    log.info('Pruned idle session artifacts', {
      dirsRemoved,
      mbFreed: Math.round(bytesFreed / 1024 / 1024),
      idleThresholdHours: Math.round(SESSION_ARTIFACT_IDLE_MS / 3600000),
    });
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
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
    killContainer(session.id, 'absolute-ceiling');
    // Posted AFTER kill to honor the outbound.db single-writer invariant
    // (session-db.ts:openOutboundDbWritable). The helper itself gates on
    // `pendingClaims === 0` (no user was waiting) to avoid spamming
    // restart notices on quiet sessions that just naturally reached the
    // 30-min idle ceiling.
    notifyKillCeiling(inDb, outDb, session, decision.heartbeatAgeMs, pendingClaims);
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
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
    // resetStuckProcessingRows immediately after, which calls
    // retryWithBackoff on every claimed pending message. Unclaimed pending
    // rows just sit until the next wake. Either way the system recovers
    // the user's existing input — a resend would just create duplicates.
    const content = JSON.stringify({
      text:
        `⚠️ I went silent for ${minutes} minutes and the host is restarting me. ` +
        `Your last messages will be picked up automatically on the next wake — ` +
        `no need to resend.`,
      // Machine-readable marker so the idempotency check above (and any
      // future consumer that wants to react) doesn't need to grep prose.
      _system: { kind: 'agent_restart_inactivity', heartbeat_age_ms: heartbeatAgeMs },
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
): void {
  notifyKillCeiling(inDb, outDb, session, heartbeatAgeMs, pendingClaims, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const respondedStmt = outDb.prepare('SELECT 1 FROM messages_out WHERE in_reply_to = ? LIMIT 1');
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
      retryWithBackoff(inDb, msg.id, backoffSec);
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
