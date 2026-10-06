/**
 * Duties every swept session runs. S4 must land before any due-count or wake
 * decision. S17 is one name on two surfaces (session tail and kill follow-up);
 * the follow-up is HANDED the post-kill session and never opens its own.
 */
import {
  SWEEP_DUTY_INVENTORY,
  asSessionContext,
  writeOutboundWhenStopped,
  registerSweepDuty,
  registerSweepDutySource,
  registerSweepKillFollowUp,
} from '../../host-sweep.js';
import { containerOwnsOutbound } from '../../container-runner.js';
import { log } from '../../log.js';
import { deferMessageForFreshContextRetry } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { type NanoclawMailboxSession } from '../mailbox/index.js';
import { STALE_CLAIM_MAX_TRIES } from '../mailbox/ops/recovery.js';
import { PENDING_MESSAGE_MAX_AGE_MS } from '../mailbox/ops/sweep.js';

export { PENDING_MESSAGE_MAX_AGE_MS };
export const MAX_TRIES = STALE_CLAIM_MAX_TRIES;
export const BACKOFF_BASE_MS = 5000;

function resetStuckProcessingRows(mailbox: NanoclawMailboxSession, session: Session, reason: string): void {
  const claims = mailbox.getProcessingClaimRows();

  for (const { message_id } of claims) {
    const msg = mailbox.staleClaimFate(message_id);
    // `rescheduled` already waits on a future retry: don't bump tries again.
    if (msg.fate === 'orphan' || msg.fate === 'rescheduled') continue;

    if (msg.fate === 'answered') {
      // Backfill completed on inbound.db only; the host must never write
      // outbound.db here (one-writer invariant, readonly handle).
      mailbox.markInboundCompletedIfPending(msg.id);
      log.info('Reset skipped — response already written; marking completed', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
      continue;
    }

    if (msg.fate === 'exhausted') {
      mailbox.markMessageFailed(msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      deferMessageForFreshContextRetry(mailbox, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop orphan 'processing' rows, or the next tick reads their old timestamp,
  // decides the fresh container is stuck, and kills it before it can clean up.
  try {
    const cleared = mailbox.deleteOrphanProcessingClaims();
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
}

function registerSessionCoreSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S2,
    phase: 'session:plan',
    order: 10,
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      const answered = mailbox!.syncProcessingAcks();
      // Not a successful run: whatever the interrupted turn had left to do is
      // NOT resumed.
      if (answered.length > 0) {
        log.warn('Closed answered-but-unfinished rows the runner will not resume (no ack left)', {
          sessionId: session.id,
          messageIds: answered,
        });
      }
    },
  });

  registerSweepDuty({
    name: id.S3,
    phase: 'session:plan',
    order: 20,
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
    // A stopped container with claims crashed mid-turn: defer the input and clear
    // the orphan claim before any due-count or wake decision can expose its
    // stale recall to a replacement poller.
    run: (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      // Ownership, not liveness: a SPAWNING container is about to own
      // outbound.db, and this reset writes it.
      if (!containerOwnsOutbound(session.id) && mailbox!.getProcessingClaimRows().length > 0) {
        writeOutboundWhenStopped(session, mailbox!, () =>
          resetStuckProcessingRows(mailbox!, session, 'container not running'),
        );
      }
    },
  });

  registerSweepDuty({
    name: id.S17,
    phase: 'session:tail',
    order: 10,
    // Retry cleanup if the pre-wake clear could not finish (idempotent).
    run: (ctx) => {
      const { session, mailbox, alive, hasOutbound } = asSessionContext(ctx);
      // `alive` was sampled before this window opened, so it cannot authorize
      // an outbound write alone; writeOutboundWhenStopped re-checks ownership.
      if (!alive && hasOutbound) {
        writeOutboundWhenStopped(session, mailbox!, () =>
          resetStuckProcessingRows(mailbox!, session, 'container not running'),
        );
      }
    },
  });

  registerSweepKillFollowUp({
    name: id.S17,
    order: 20,
    run: (ctx, _outcome, mailbox) => {
      // Per-write guard: a replacement wake can take outbound ownership at any
      // await between follow-ups.
      writeOutboundWhenStopped(ctx.session, mailbox, () =>
        resetStuckProcessingRows(mailbox, ctx.session, ctx.killSnapshot!.reason),
      );
    },
  });
}

registerSweepDutySource('sweep-session-core', registerSessionCoreSweepDuties);
