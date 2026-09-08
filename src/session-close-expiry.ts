/**
 * Releasing everything a CLOSED session can never consume (#520).
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
 * The fix is to release the work AT THE SOURCE rather than to teach readers to
 * ignore it. Once the rows are `expired` and the claims are gone,
 * `sessionHasOpenWork` already answers false — no caller changes, and no third
 * "unconsumable" state to keep in sync with the two that exist.
 *
 * ## All THREE things sessionHasOpenWork counts
 *
 * The predicate is a chain, and clearing only its first link leaves the
 * session pinned exactly as before (Codex round 1 on #583, finding 2):
 *
 *   1. inbound `messages_in` in ('processing','pending')  → expireClosedSessionPending
 *   2. outbound `processing_ack` status = 'processing'    → deleteOrphanProcessingClaims
 *   3. outbound `session_state` work_continuation/pending_next → clearWorkContinuation
 *
 * `expireClosedSessionWork` below does all three, so both entry points get the
 * complete release.
 *
 * ## The two entry points
 *
 *  - `src/modules/sweep-scheduling/index.ts` duty S19, immediately after the
 *    `active -> closed` update. That is the ONLY active->closed transition on
 *    the host (`src/session-close-sites.test.ts` pins it), so it is the whole
 *    of the ongoing leak.
 *  - `drainClosedSessionPendingBacklog()` at boot, for sessions that were
 *    already closed before this landed.
 *
 * The four `archiving -> closed` sites in `src/storage-manager.ts` are
 * deliberately NOT wired up; see `session-close-sites.test.ts` for the case
 * that none of them can strand a row.
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
 * How many closed sessions one backlog drain may OPEN. The DB open is the cost
 * this bounds; the scan around it is one `statSync` per closed row and stays
 * trivial as the table grows.
 *
 * A no-op session still spends budget — exempting it would put the open count
 * back under the control of what the sessions happen to hold, which is the
 * unbounded case this exists to prevent. Progress across boots is guaranteed by
 * the cursor instead.
 */
export const CLOSED_SESSION_BACKLOG_DRAIN_LIMIT = 250;

export interface ClosedSessionRelease {
  /** Inbound rows moved to 'expired'. */
  expired: number;
  /** Orphan outbound 'processing' claims deleted. */
  claimsCleared: number;
  /** Whether a durable follow-up promise was dropped. */
  continuationCleared: boolean;
}

/**
 * Release everything a closed (or about-to-be-closed) session still holds.
 *
 * Takes the mailbox session rather than a key: S19 calls this from INSIDE the
 * sweep's already-open session window, and opening a second mailbox session on
 * the same key would throw the nesting guard (`runMailboxSession`).
 *
 * Callers must have established that the session row is `closed` or is being
 * closed in the same turn — the inbound op drops the age, recurrence and fence
 * guards that are load-bearing for a live session.
 *
 * ## The outbound half and its guard
 *
 * `outbound.db` has ONE writer. The host may touch it only while no container
 * owns the session, and the check has to sit immediately before the mutation
 * with no await between the two. `writeOutboundWhenStopped` is that shape and
 * is the ownership check carried INLINE here — the lexical scanner in
 * `src/mailbox-seam-ratchet.ts` cannot see a write made through a helper the
 * session action calls, so this function owns the property rather than
 * inheriting it from its call sites.
 *
 * Gated on `hasOutbound()` first: a never-woken session has no outbound.db, and
 * reaching for the writable handle would CREATE one — a cleanup pass must not
 * provision files.
 *
 * ## Why the continuation goes too
 *
 * A `work_continuation` (or its legacy `pending_next` spelling) is a promise to
 * resume work on the next wake. A closed session has no next wake: resuming one
 * means waking the session, and every session lookup filters `status='active'`.
 * The promise can never be honoured, and while it survives it pins the
 * directory — which is the entire defect. Its presence here is already an
 * anomaly: S19 refuses to close a session while `readContinuationPresence()`
 * is non-null, so a continuation in a closed session arrived after that check
 * or predates this code. `clearWorkContinuation` drops both keys in one
 * transaction and returns what it held, so the drop is reported rather than
 * silent.
 */
/**
 * `writeOutboundWhenStopped`, for a session reached through the OUTBOUND-keyed
 * funnel instead of the mailbox session.
 *
 * The two guards in `host-sweep.ts` both go through the mailbox session, whose
 * existence check is `inbound.db && outbound.db`
 * (`SqliteAgentMailbox.exists`) — so neither can reach a session that kept
 * outbound.db and lost inbound.db. This is the same guarantee on
 * `withExistingNanoclawOutbound`: `containerOwnsOutbound` runs INSIDE the
 * funnel, synchronously, immediately before the mutation. The funnel demands a
 * synchronous action, so no await can be introduced into that gap.
 *
 * Deliberately here and not beside its two siblings in `host-sweep.ts`.
 * `host-sweep.ts` is upstream-owned, its export surface is a curated allowlist,
 * and its line ceiling is set to zero headroom on purpose
 * (`src/host-sweep-registry.test.ts`) — growing all three for a helper with one
 * fork-owned caller and no relationship to the sweep driver buys nothing. The
 * siblings live there because the sweep families share them across a kill;
 * this one is not shared.
 *
 * Resolves `undefined` when there is no `outbound.db` OR a container owns it —
 * both are "did not run", never a failure.
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
 * Release a closed session that still holds `outbound.db` but has lost
 * `inbound.db`.
 *
 * Keyed on OUTBOUND, because `SqliteAgentMailbox.exists` is
 * `inbound.db && outbound.db`: the mailbox-session funnel answers `undefined`
 * for this cohort, so routing it through `expireClosedSessionWork` would spend
 * a slot of the drain's budget, report success, and release nothing. That is
 * the seam's own rule — the existence question a read asks is keyed to the file
 * the read actually touches (`src/modules/mailbox/index.ts`) — and four earlier
 * findings in this series were instances of getting it wrong.
 *
 * `writeOutboundOnlyWhenStopped` carries the same ownership guarantee as the
 * two-sided path: `containerOwnsOutbound` inside the funnel, synchronously,
 * immediately before the mutation.
 *
 * ## What this does and does not buy
 *
 * It genuinely releases the state. It does NOT, on its own, unpin the
 * directory for reclaim: `sessionHasOpenWork` reads inbound.db FIRST, and
 * `dbHasRows` answers `null` for a file that is not there, which every caller
 * treats as "could not tell" and therefore as pinned. A half-present session is
 * pinned by its missing file, not by its rows. Fixing that is a separate
 * question about the `null` fail-closed and is deliberately not attempted here.
 */
export async function releaseOutboundOnlyClosedSession(
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

/* ─── Backlog drain ────────────────────────────────────────────────────────── */

/**
 * Where the drain remembers how far it got.
 *
 * A function, not a module constant, so a test's mocked `DATA_DIR` is honoured
 * and so a `DATA_DIR` that only exists after boot cannot be captured too early.
 */
function cursorPath(): string {
  return path.join(DATA_DIR, 'closed-session-drain-cursor.json');
}

/**
 * The last session id this drain OPENED, or null for "start from the top".
 *
 * Any failure — missing file, unreadable, malformed JSON, wrong shape — reads
 * as null. A cursor is an optimisation for where to resume, never a
 * precondition, so it must not be able to fail a boot.
 */
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
    // Losing the cursor costs a repeated window next boot, nothing more.
    log.warn('Could not persist the closed-session drain cursor', { err });
  }
}

interface ClosedSessionRow extends Session {
  id: string;
  agent_group_id: string;
}

export interface ClosedSessionDrainResult {
  /** Closed session rows the query returned. */
  scanned: number;
  /** Sessions actually opened — bounded by `limit`. */
  visited: number;
  expired: number;
  claimsCleared: number;
  continuationsCleared: number;
  /** Sessions with a surviving directory that the cap pushed to a later run. */
  deferred: number;
  /**
   * Sessions holding `inbound.db` with no `outbound.db`. The seam has no
   * inbound-keyed funnel, so these are reported rather than released — and a
   * missing file already makes `sessionHasOpenWork` fail closed, so releasing
   * them would not unpin them either.
   */
  inboundOnlySkipped: number;
  /** Where the next run will resume, or null when this run completed a lap. */
  cursor: string | null;
}

/**
 * Drain the sessions that were closed BEFORE this landed.
 *
 * Deliberately not a sweep duty and not a migration: a per-tick pass over every
 * closed session is the per-session cost #516 is about, and a migration would
 * rewrite 1,229 session files in one shot.
 *
 * ## Why a cursor, not "reclaim will take care of it"
 *
 * The first version of this leaned on reclaim removing a drained session's
 * directory so the next boot would skip it. That is true EVENTUALLY and false
 * within an evening: reclaim is asynchronous and bounded per tick, so a host
 * that restarts three times in a night re-walks the same unordered prefix and
 * the tail past the cap never gets opened at all (Codex round 1 on #583,
 * finding 1). With 287 retained directories against a cap of 250, the last 37
 * would starve indefinitely — and those rows clearing is the entire point.
 *
 * So progress is guaranteed rather than incidental: the query is ordered by
 * `id`, the run records the last session it OPENED, and the next run resumes
 * after it, wrapping to the top when the list is exhausted. A run that gets
 * through a whole lap with budget to spare clears the cursor rather than
 * leaving it pointed at an id reclaim may have removed.
 *
 * `sessionsRoot` is the existence gate only — the open itself goes through the
 * mailbox, which is keyed on `DATA_DIR`. The two are the same root in
 * production; the parameter exists so a test can point both at a temp dir.
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
    inboundOnlySkipped: 0,
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

  // Rotate so iteration starts after the cursor and wraps back to the top. An
  // id that is no longer in the table simply yields an empty first half, which
  // is the same as starting from the beginning.
  const cursor = readDrainCursor();
  const ordered = cursor ? [...rows.filter((r) => r.id > cursor), ...rows.filter((r) => r.id <= cursor)] : rows;

  let lastOpened: string | null = null;
  let cappedOut = false;

  for (const row of ordered) {
    // Cheap gate first: a fully reclaimed session has no directory left, and
    // that is the overwhelming majority of the closed rows.
    //
    // Both sides are checked, not just inbound. `sessionHasOpenWork` pins a
    // session on outbound `processing_ack` or `session_state` even when it
    // finds no inbound work, so a session that has lost `inbound.db` while
    // keeping `outbound.db` still needs releasing — and gating on inbound
    // alone would skip it on every boot forever. That is the seam's own rule
    // (`src/modules/mailbox/index.ts`): the existence question a read asks is
    // keyed to the file the read actually touches. Four earlier findings in
    // this series were instances of getting it wrong; this was the fifth.
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
      // Route to the funnel whose existence check matches the files this
      // release will touch. `SqliteAgentMailbox.exists` is `inbound.db &&
      // outbound.db`, so the mailbox session serves ONLY the both-present case
      // — handing it a half-present session spends a slot of the budget,
      // answers `undefined`, and releases nothing.
      //
      // Inbound-only has no funnel and is counted rather than pretended: the
      // seam has no inbound-keyed opener, and releasing that cohort would not
      // unpin it anyway (see `releaseOutboundOnlyClosedSession` — a missing
      // file makes `sessionHasOpenWork` answer `null`, which is fail-closed).
      let released: ClosedSessionRelease | undefined;
      if (hasInbound && hasOutbound) {
        released = await withExistingMailboxSession(row.agent_group_id, row.id, (mailbox) =>
          expireClosedSessionWork(mailbox, row, 'closed-session-backlog'),
        );
      } else if (hasOutbound) {
        released = await releaseOutboundOnlyClosedSession(row.agent_group_id, row, 'closed-session-backlog');
      } else {
        result.inboundOnlySkipped += 1;
        log.warn('Closed session has inbound.db but no outbound.db — no funnel is keyed to release it', {
          sessionId: row.id,
          agentGroupId: row.agent_group_id,
        });
      }
      if (released) {
        result.expired += released.expired;
        result.claimsCleared += released.claimsCleared;
        if (released.continuationCleared) result.continuationsCleared += 1;
      }
    } catch (err) {
      // One unreadable session DB must not stop the drain — the rest of the
      // backlog is still worth clearing, and reclaim already fails closed on
      // a session it cannot read. It still consumed budget and still advances
      // the cursor, so a permanently broken session cannot wedge the window.
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
