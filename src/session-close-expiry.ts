/**
 * Releases everything a CLOSED session can never consume. The reaper only walks active sessions, so leftover work
 * keeps `sessionHasOpenWork` true and pins the session dir for reclaim forever. All three things that predicate
 * counts must be cleared, or the session stays pinned:
 *
 *   1. inbound `messages_in` in ('processing','pending')  → expireClosedSessionPending
 *   2. outbound `processing_ack` status = 'processing'    → deleteOrphanProcessingClaims
 *   3. outbound `session_state` work_continuation/pending_next → clearWorkContinuation
 *
 * Entry points: sweep duty S19 right after the only active→closed transition (pinned by
 * `session-close-sites-ratchet.test.ts`), and `drainClosedSessionPendingBacklog()` at boot.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { containerOwnsOutbound } from './container-runner.js';
import { writeOutboundWhenStopped } from './host-sweep.js';
import { log } from './log.js';
import { withExistingNanoclawOutbound, type NanoclawOutboundSession } from './modules/mailbox/index.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { sessionsBaseDir, withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

/**
 * How many closed sessions one backlog drain may OPEN. No-op sessions spend budget too, or the open count would be
 * unbounded again; the cursor guarantees progress across boots.
 */
const CLOSED_SESSION_BACKLOG_DRAIN_LIMIT = 250;

export interface ClosedSessionRelease {
  expired: number;
  claimsCleared: number;
  continuationCleared: boolean;
}

/**
 * `writeOutboundWhenStopped` for a session reached through the OUTBOUND-keyed funnel: `containerOwnsOutbound`
 * runs synchronously inside the funnel right before the mutation. Kept out of the upstream-owned `host-sweep.ts`
 * (curated exports, zero line headroom). `undefined` when there is no outbound.db or a container owns it.
 */
async function writeOutboundOnlyWhenStopped<T>(
  agentGroupId: string,
  session: Session,
  action: (outbound: NanoclawOutboundSession) => T,
): Promise<T | undefined> {
  return withExistingNanoclawOutbound<T | undefined>(agentGroupId, session.id, (outbound) => {
    if (containerOwnsOutbound(session.id)) {
      log.debug('Skipped a host outbound write — a container owns this session', { sessionId: session.id });
      return undefined;
    }
    return action(outbound);
  });
}

/**
 * Release a closed session that kept `outbound.db` but lost `inbound.db`. Keyed on OUTBOUND: the mailbox funnel's
 * existence check keys on inbound, so it would report success and release nothing for this cohort.
 */
async function releaseOutboundOnlyClosedSession(
  agentGroupId: string,
  session: Session,
  reason: 'spent-task-session-gc' | 'closed-session-backlog',
): Promise<ClosedSessionRelease | undefined> {
  const released = await writeOutboundOnlyWhenStopped(agentGroupId, session, (outbound) => ({
    expired: 0,
    claimsCleared: outbound.deleteOrphanProcessingClaims(),
    continuationCleared: outbound.clearWorkContinuation() !== null,
  }));
  if (released && (released.claimsCleared > 0 || released.continuationCleared)) {
    log.info('Released outbound work a closed session can never consume', {
      sessionId: session.id,
      claimsCleared: released.claimsCleared,
      continuationCleared: released.continuationCleared,
      reason,
    });
  }
  return released;
}

/**
 * Release everything a closed (or closing-this-turn) session holds; the inbound op drops the guards a live session
 * needs. Takes the open mailbox session because S19 calls it inside the sweep's session window (a nested open
 * throws). The outbound write is guarded INLINE by `writeOutboundWhenStopped` (the seam ratchet cannot see through
 * helpers), and gated on `hasOutbound()` so cleanup never creates an outbound.db. The continuation is dropped
 * because a closed session never wakes to honour it.
 */
export function expireClosedSessionWork(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: 'spent-task-session-gc' | 'closed-session-backlog',
): ClosedSessionRelease {
  const result: ClosedSessionRelease = { expired: 0, claimsCleared: 0, continuationCleared: false };

  result.expired = mailbox.expireClosedSessionPending();

  if (mailbox.hasOutbound()) {
    const outbound = writeOutboundWhenStopped(session, mailbox, (writable) => {
      const claimsCleared = writable.deleteOrphanProcessingClaims();
      const held = writable.clearWorkContinuation();
      return { claimsCleared, continuationCleared: held !== null };
    });
    if (outbound) {
      result.claimsCleared = outbound.claimsCleared;
      result.continuationCleared = outbound.continuationCleared;
    }
  }

  if (result.expired > 0 || result.claimsCleared > 0 || result.continuationCleared) {
    log.info('Released work a closed session can never consume', {
      sessionId: session.id,
      expired: result.expired,
      claimsCleared: result.claimsCleared,
      continuationCleared: result.continuationCleared,
      reason,
    });
  }
  return result;
}

/** A function so a test's mocked `DATA_DIR` is honoured and nothing is captured before boot. */
function cursorPath(): string {
  return path.join(DATA_DIR, 'closed-session-drain-cursor.json');
}

/** The last session id this drain OPENED, or null. Any read failure is null: a cursor must never fail a boot. */
function readDrainCursor(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath(), 'utf8')) as { after?: unknown };
    return typeof parsed?.after === 'string' && parsed.after.length > 0 ? parsed.after : null;
  } catch {
    return null;
  }
}

function writeDrainCursor(after: string | null): void {
  try {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ after, updated_at: new Date().toISOString() }));
  } catch (err) {
    log.warn('Could not persist the closed-session drain cursor', { err });
  }
}

interface ClosedSessionRow extends Session {
  id: string;
  agent_group_id: string;
}

export interface ClosedSessionDrainResult {
  scanned: number;
  visited: number;
  expired: number;
  claimsCleared: number;
  continuationsCleared: number;
  deferred: number;
  /** Null when this run completed a lap. */
  cursor: string | null;
}

/**
 * Drain sessions closed before the S19 release existed. Not a sweep duty (per-tick cost) nor a migration.
 * Progress is guaranteed by a cursor, not left to async reclaim: rows are ordered by `id`, the run records the
 * last session it OPENED, the next resumes after it and wraps; a full lap with budget left clears the cursor.
 * `sessionsRoot` is only the existence gate; the open goes through the mailbox, keyed on `DATA_DIR`.
 */
export async function drainClosedSessionPendingBacklog(
  sessionsRoot: string = sessionsBaseDir(),
  limit: number = CLOSED_SESSION_BACKLOG_DRAIN_LIMIT,
): Promise<ClosedSessionDrainResult> {
  const result: ClosedSessionDrainResult = {
    scanned: 0,
    visited: 0,
    expired: 0,
    claimsCleared: 0,
    continuationsCleared: 0,
    deferred: 0,
    cursor: null,
  };

  let rows: ClosedSessionRow[];
  try {
    rows = await getDb().all<ClosedSessionRow>("SELECT * FROM sessions WHERE status = 'closed' ORDER BY id");
  } catch (err) {
    log.warn('Could not read closed sessions for the pending-row backlog drain', { err });
    return result;
  }
  result.scanned = rows.length;

  // Rotate to start after the cursor; a vanished cursor id yields an empty first half, i.e. start from the top.
  const cursor = readDrainCursor();
  const ordered = cursor ? [...rows.filter((r) => r.id > cursor), ...rows.filter((r) => r.id <= cursor)] : rows;

  let lastOpened: string | null = null;
  let cappedOut = false;

  for (const row of ordered) {
    // Gate on either DB existing: outbound `processing_ack`/`session_state` pin a session with no inbound.db too.
    const sessionDir = path.join(sessionsRoot, row.agent_group_id, row.id);
    const hasInbound = fs.existsSync(path.join(sessionDir, 'inbound.db'));
    const hasOutbound = fs.existsSync(path.join(sessionDir, 'outbound.db'));
    if (!hasInbound && !hasOutbound) continue;
    if (result.visited >= limit) {
      result.deferred += 1;
      cappedOut = true;
      continue;
    }
    result.visited += 1;
    lastOpened = row.id;
    try {
      // `NanoclawAgentMailbox.exists()` keys on inbound.db alone and degrades absent outbound reads to empty, so
      // the mailbox funnel serves every session with inbound.db; only inbound-absent sessions need the outbound one.
      const released = hasInbound
        ? await withExistingMailboxSession(row.agent_group_id, row.id, (mailbox) =>
            expireClosedSessionWork(mailbox, row, 'closed-session-backlog'),
          )
        : await releaseOutboundOnlyClosedSession(row.agent_group_id, row, 'closed-session-backlog');
      if (released) {
        result.expired += released.expired;
        result.claimsCleared += released.claimsCleared;
        if (released.continuationCleared) result.continuationsCleared += 1;
      }
    } catch (err) {
      // One unreadable session must not stop the drain; it still spent budget and advances the cursor.
      log.warn('Could not release a closed session’s work', {
        sessionId: row.id,
        agentGroupId: row.agent_group_id,
        err,
      });
    }
  }

  result.cursor = cappedOut ? lastOpened : null;
  writeDrainCursor(result.cursor);

  if (result.visited > 0 || result.deferred > 0) {
    log.info('Drained the closed-session backlog', { ...result });
  }
  return result;
}
