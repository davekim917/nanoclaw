/**
 * Expiring the inbound rows a CLOSED session can never consume (#520).
 *
 * ## The leak
 *
 * `expireStalePending` is the sweep's reaper, and it runs as duty S3 inside
 * the per-session loop — a loop over `getActiveSessions()`. A session that
 * reaches `closed` while it still holds `pending` rows therefore takes them
 * permanently out of the reaper's reach. Those rows then keep
 * `sessionHasOpenWork` (src/storage-manager.ts) returning true forever, so
 * reclaim never archives the directory and the session dir is pinned for good:
 * 561 rows across 53 sessions on this install, the oldest 43 days old.
 *
 * The fix is to expire the rows AT THE SOURCE rather than to teach readers to
 * ignore them. Once they are `expired`, `sessionHasOpenWork` already ignores
 * them — no caller changes, and no third "unconsumable" state to keep in sync
 * with the two that exist.
 *
 * ## The two entry points
 *
 * Both go through `expireClosedSessionWork` below, which is the only place the
 * mailbox op is called from:
 *
 *  - `src/modules/sweep-scheduling/index.ts` duty S19, immediately before the
 *    `active -> closed` update. That is the ONLY active->closed transition on
 *    the host (`src/session-close-sites.test.ts` pins it), so it is the whole
 *    of the ongoing leak.
 *  - `drainClosedSessionPendingBacklog()` at boot, for sessions that were
 *    already closed before this landed. Bounded and self-draining: once a
 *    session's rows are expired, reclaim archives and removes its directory,
 *    so the next boot does not see it again.
 *
 * The four `archiving -> closed` sites in `src/storage-manager.ts` are
 * deliberately NOT wired up; see `session-close-sites.test.ts` for the case
 * that none of them can strand a row.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from './db/connection.js';
import { log } from './log.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { sessionsBaseDir, withExistingMailboxSession } from './session-manager.js';

/**
 * How many closed sessions one backlog drain may OPEN. The scan itself is a
 * `statSync` per closed row, which stays trivial as the table grows; this caps
 * the expensive half. Anything left over is picked up by the next boot,
 * because a drained session's directory is reclaimed and stops being counted.
 */
export const CLOSED_SESSION_BACKLOG_DRAIN_LIMIT = 250;

/**
 * Expire everything a closed (or about-to-be-closed) session still holds.
 *
 * Takes the mailbox session rather than a key: S19 calls this from INSIDE the
 * sweep's already-open session window, and opening a second mailbox session on
 * the same key would throw the nesting guard (`runMailboxSession`).
 *
 * Callers must have established that the session row is `closed` or is being
 * closed in the same turn — the op drops the age, recurrence and fence guards
 * that are load-bearing for a live session.
 */
export function expireClosedSessionWork(
  mailbox: NanoclawMailboxSession,
  sessionId: string,
  reason: 'spent-task-session-gc' | 'closed-session-backlog',
): number {
  const expired = mailbox.expireClosedSessionPending();
  if (expired > 0) {
    log.info('Expired inbound rows a closed session can never consume', {
      sessionId,
      count: expired,
      reason,
    });
  }
  return expired;
}

interface ClosedSessionRow {
  id: string;
  agent_group_id: string;
}

/**
 * One-time-per-boot drain of sessions closed BEFORE the S19 expiry landed.
 *
 * Deliberately not a sweep duty and not a migration: a per-tick pass over
 * every closed session is the per-session cost #516 is about, and a migration
 * would rewrite 1,229 session files in one shot. This walks the closed rows
 * once at startup, opens only those whose `inbound.db` still exists (a
 * reclaimed session has none, which is what makes the pass self-draining), and
 * stops after `CLOSED_SESSION_BACKLOG_DRAIN_LIMIT` opens.
 *
 * `sessionsRoot` is the existence gate only — the open itself goes through the
 * mailbox, which is keyed on `DATA_DIR`. The two are the same root in
 * production; the parameter exists so a test can point both at a temp dir.
 */
export async function drainClosedSessionPendingBacklog(
  sessionsRoot: string = sessionsBaseDir(),
  limit: number = CLOSED_SESSION_BACKLOG_DRAIN_LIMIT,
): Promise<{ scanned: number; visited: number; expired: number; deferred: number }> {
  const result = { scanned: 0, visited: 0, expired: 0, deferred: 0 };

  let rows: ClosedSessionRow[];
  try {
    rows = await getDb().all<ClosedSessionRow>("SELECT id, agent_group_id FROM sessions WHERE status = 'closed'");
  } catch (err) {
    log.warn('Could not read closed sessions for the pending-row backlog drain', { err });
    return result;
  }
  result.scanned = rows.length;

  for (const row of rows) {
    // Cheap gate first: a reclaimed session has no directory left, and that is
    // the overwhelming majority of the closed rows.
    if (!fs.existsSync(path.join(sessionsRoot, row.agent_group_id, row.id, 'inbound.db'))) continue;
    if (result.visited >= limit) {
      result.deferred += 1;
      continue;
    }
    result.visited += 1;
    try {
      const expired = await withExistingMailboxSession(row.agent_group_id, row.id, (mailbox) =>
        expireClosedSessionWork(mailbox, row.id, 'closed-session-backlog'),
      );
      result.expired += expired ?? 0;
    } catch (err) {
      // One unreadable session DB must not stop the drain — the rest of the
      // backlog is still worth clearing, and reclaim already fails closed on
      // a session it cannot read.
      log.warn('Could not expire a closed session’s pending rows', {
        sessionId: row.id,
        agentGroupId: row.agent_group_id,
        err,
      });
    }
  }

  if (result.expired > 0 || result.deferred > 0) {
    log.info('Drained the closed-session pending backlog', result);
  }
  return result;
}
