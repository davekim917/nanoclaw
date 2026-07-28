/**
 * Host-restart accountability: warn mid-work sessions BEFORE their containers
 * are stopped by a host shutdown/restart, so the interruption is announced
 * and self-accounted instead of silent.
 *
 * Every host start stops all install-labeled containers — graceful shutdown
 * via `stopAllContainers`, startup via `cleanupOrphansStrict` (quiescence is
 * a hard precondition for workgroup FS reconciliation). Without this, a
 * mid-work session loses its turn and its background workers with no
 * explanation, and only comes back when a human pings — the exact
 * "said it was working, then silence" failure family.
 *
 * The note is an on_wake trigger=1 row in the session's inbound.db, so the
 * sweep's due-wake respawns the session shortly after startup and the fresh
 * container must post a public accounting (done / lost / next) and resume
 * from durable state (checkpoints, pending_next).
 *
 * Spam guard: only sessions with plausible work in flight are warned — a
 * tool in flight per container_state, last outbound kind='status' (internal
 * narration, not a user-facing message), or a stored NEXT: promise — the
 * same signals as decideCeilingFollowUp plus pending_next. Quiet sessions
 * whose last act was a user-facing message get no note, so a restart
 * doesn't wake every idle container into a public "nothing happened".
 */
import type Database from 'better-sqlite3';

import { getActiveContainerSessionIds } from './container-runner.js';
import { getActiveSessions, getSession } from './db/sessions.js';
import { getContainerState, insertMessage } from './db/session-db.js';
import { decideCeilingFollowUp } from './host-sweep.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb } from './session-manager.js';
import type { Session } from './types.js';

const RESTART_NOTE_MARKER = 'agent_host_restart';
const RESTART_NOTE_IDEMPOTENCY_MS = 10 * 60 * 1000;

function lastOutboundKind(outDb: Database.Database): string | null {
  const row = outDb.prepare('SELECT kind FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
    | { kind: string }
    | undefined;
  return row?.kind ?? null;
}

function hasPendingNext(outDb: Database.Database): boolean {
  try {
    const row = outDb.prepare("SELECT value FROM session_state WHERE key = 'pending_next'").get() as
      | { value: string }
      | undefined;
    return !!row && row.value.includes('"task"');
  } catch {
    return false; // no session_state table on an old session DB — treat as absent
  }
}

/**
 * Write the restart accountability note for one session if (and only if)
 * work was plausibly in flight. Idempotent within 10 minutes so the
 * shutdown path and the startup backstop can't double-warn on one restart.
 * Returns true when a note was written.
 */
export function warnSessionIfWorkInFlight(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): boolean {
  const cutoffIso = new Date(Date.now() - RESTART_NOTE_IDEMPOTENCY_MS).toISOString();
  const recent = inDb
    .prepare(`SELECT 1 FROM messages_in WHERE timestamp > ? AND content LIKE ? LIMIT 1`)
    .get(cutoffIso, `%${RESTART_NOTE_MARKER}%`);
  if (recent) return false;

  const state = getContainerState(outDb);
  const midWork =
    hasPendingNext(outDb) ||
    decideCeilingFollowUp({
      currentTool: state?.current_tool ?? null,
      lastOutboundKind: lastOutboundKind(outDb),
      priorAttempts: 0,
    }).action === 'wake-accountable';
  if (!midWork) return false;

  insertMessage(inDb, {
    id: `host-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text:
        `[system] The NanoClaw host restarted (${reason}) and stopped your container mid-work. ` +
        `Any in-flight turn, background task, or /tmp state was lost. Post ONE public accounting — ` +
        `done / lost / next — then resume from your durable checkpoints or stored NEXT: task.`,
      sender: 'system',
      senderId: 'system',
      _system: { kind: RESTART_NOTE_MARKER, reason },
    }),
    processAfter: null,
    recurrence: null,
    onWake: 1,
  });
  log.info('Wrote host-restart accountability note', { sessionId: session.id, reason });
  return true;
}

function warnSessions(session: Session, reason: string): void {
  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(session.agent_group_id, session.id);
    outDb = openOutboundDb(session.agent_group_id, session.id);
    warnSessionIfWorkInFlight(inDb, outDb, session, reason);
  } catch (err) {
    log.warn('host-restart warn failed for session', { sessionId: session.id, err });
  } finally {
    inDb?.close();
    outDb?.close();
  }
}

/**
 * Graceful-shutdown path: warn sessions the live registry says have running
 * containers. Runs before stopAllContainers so the note is in place before
 * the container dies.
 */
export function warnActiveContainersOfShutdown(reason: string): void {
  for (const sessionId of getActiveContainerSessionIds()) {
    const session = getSession(sessionId);
    if (session) warnSessions(session, reason);
  }
}

/**
 * Startup backstop (crash path): an unclean previous host left sessions
 * marked container_status='running' whose containers are about to be
 * stopped by the startup quiescence precondition. Warn them first.
 */
export function warnMarkedRunningSessionsOfStartup(reason: string): void {
  for (const session of getActiveSessions().filter((s) => s.container_status === 'running')) {
    warnSessions(session, reason);
  }
}
