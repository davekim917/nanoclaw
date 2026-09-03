/**
 * Per-session core — S2-PR9 (docs/specs/upstream-host-sweep-seam/plan.md).
 *
 * The four duties every swept session runs regardless of what else is true of
 * it: the processing_ack sync (S2) and stale-pending expiry (S3) that open the
 * plan window, the pre-wake orphan-claim reset (S4) that must land before any
 * due-count or wake decision (constraint 7), and the orphan-claim retry (S17).
 *
 * S17 is ONE name on TWO surfaces — `session:tail` order 10 and kill follow-up
 * order 20 — because the same reset covers both the "the container died
 * quietly" path and the "we just killed it" path; only the reason differs. The
 * follow-up registration runs inside the post-kill session the SLA duty opens
 * AFTER `killContainer` returns (constraint 18): it is HANDED that session and
 * never opens one of its own.
 *
 * Bodies below are moved from `src/host-sweep.ts` UNCHANGED (same statements,
 * log strings, thresholds, helper calls). None of these duties kills or wakes,
 * so all four run inside the window the driver already holds — `ctx.mailbox`
 * is that window's session.
 *
 * `deferMessageForFreshContextRetry` is still a raw-handle callee
 * (`session-manager.ts`): mailbox seam PR 4 converted `runHostGatedTaskScripts`,
 * `handleRecurrence` and `syncDoneProposalMirror` but NOT this one (verified on
 * PR 4's head `2d1e345d`), so `legacyInboundHandle()` moves here with the body
 * and this file joins `src/mailbox/RATCHET.json` until the mailbox series
 * converts it — the same deliberate, written-down exception S2-PR7 carries for
 * its raw opener.
 */
import { isContainerRunning } from '../../container-runner.js';
import {
  SWEEP_DUTY_INVENTORY,
  asSessionContext,
  registerSweepDuty,
  registerSweepDutySource,
  registerSweepKillFollowUp,
} from '../../host-sweep.js';
import { log } from '../../log.js';
import { deferMessageForFreshContextRetry } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { type NanoclawMailboxSession } from '../mailbox/index.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';

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

export function _resetStuckProcessingRowsForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(mailbox, session, reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrations — S2, S3, S4 in session:plan; S17 on session:tail AND the kill
// follow-up list (one name, two surfaces).
// ─────────────────────────────────────────────────────────────────────────────

export function registerSessionCoreSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

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
      if (!isContainerRunning(session.id) && mailbox!.getProcessingClaimRows().length > 0) {
        resetStuckProcessingRows(mailbox!, session, 'container not running');
      }
    },
  });

  registerSweepDuty({
    name: id.S17,
    phase: 'session:tail',
    order: 10,
    // 7. Retry cleanup if the pre-wake orphan-claim clear could not finish.
    // resetStuckProcessingRows is idempotent: future retries are not bumped
    // again, and already-cleared claim sets are a no-op.
    run: (ctx) => {
      const { session, mailbox, alive, hasOutbound } = asSessionContext(ctx);
      if (!alive && hasOutbound) resetStuckProcessingRows(mailbox!, session, 'container not running');
    },
  });

  registerSweepKillFollowUp({
    name: id.S17,
    order: 20,
    // The same orphan-claim reset the tail runs, here for the post-kill path.
    // Both kill branches reset; only the reason differs.
    run: (ctx, _outcome, mailbox) => {
      resetStuckProcessingRows(mailbox, ctx.session, ctx.killSnapshot!.reason);
    },
  });
}

registerSweepDutySource('sweep-session-core', registerSessionCoreSweepDuties);
