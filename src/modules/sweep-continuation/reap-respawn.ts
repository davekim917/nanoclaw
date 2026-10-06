/**
 * Chat-idle-reap accountability: an agent that ends its turn with work only on disk ("waiting on CI") is reaped as
 * idle, and without a follow-up the edits sit until a human pings. Same row machinery and cap as the ceiling wake.
 * Kept free of top-level side effects so the idle-reap family can import it without registering this family.
 */
import { SELF_HEAL_ENABLED } from '../../config.js';
import { writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession, WorktreeInFlight } from '../mailbox/index.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import { decideReapFollowUp, type ReapFollowUp } from './decide.js';

export const ACCOUNT_FOR_STATE = 'post ONE message accounting for state — done / lost / next';

export const RESTART_SURVIVAL_RULES =
  `Re-check any work claims in claims/ before resuming a seam — a sibling may have taken it over while you were down. ` +
  `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
  `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay.`;

const REAP_RESPAWN_ID_PREFIX = 'reap-respawn-';
const MAX_FILES_NAMED = 20;
const CONTAINER_WORKTREES_DIR = '/workspace/worktrees';

function describeCheckouts(record: WorktreeInFlight): string {
  let namesLeft = MAX_FILES_NAMED;
  return record.checkouts
    .map((checkout) => {
      const upstream = checkout.upstream
        ? `pushed upstream ${checkout.upstream}${checkout.upstream_head ? ` at ${checkout.upstream_head.slice(0, 12)}` : ''}`
        : 'no upstream';
      const parts = [
        `- ${CONTAINER_WORKTREES_DIR}/${checkout.name}: branch ${checkout.branch ?? '(detached)'}, ${upstream}`,
      ];
      if (checkout.unpushed > 0) parts.push(`${checkout.unpushed} commit(s) not on the upstream`);
      if (checkout.file_count > 0) {
        const named = checkout.files.slice(0, Math.max(namesLeft, 0));
        namesLeft -= named.length;
        const more = checkout.file_count - named.length;
        parts.push(
          `${checkout.file_count} uncommitted file(s)` +
            (named.length > 0 ? `: ${named.join(', ')}` : '') +
            (more > 0 ? ` (+${more} more)` : ''),
        );
      }
      return parts.join('; ');
    })
    .join('\n');
}

function writeReapRespawn(
  mailbox: NanoclawMailboxSession,
  session: Session,
  killKey: string,
  record: WorktreeInFlight,
  idleMinutes: number,
): void {
  const text =
    `[system] Your previous container was stopped by the ${idleMinutes}-minute chat idle reap after your turn ` +
    `ended, and it left work that is not committed and pushed:\n${describeCheckouts(record)}\n` +
    `Resume what is safely resumable — commit and push what is ready — and ${ACCOUNT_FOR_STATE}. ` +
    `A commit, a push or a PR is evidence; a description of what you meant to do is not. ` +
    `If this work is not yours (siblings in this thread share these checkouts) or is deliberately parked, ` +
    `say so in one line. ${RESTART_SURVIVAL_RULES}`;
  writeSystemWake(mailbox, session, `${REAP_RESPAWN_ID_PREFIX}${killKey}`, text, {
    kind: 'agent_reap_respawn',
    checkouts: record.checkouts.map((checkout) => checkout.name),
  });
}

/**
 * Called inside the post-reap session, under the outbound ownership guard. `killKey` names the reaped container
 * (its spawn instant), so a racing second call writes nothing new. `commit` wraps the one write, so the caller can
 * invalidate the session's quiet mark in the same synchronous turn.
 */
export function applyReapFollowUp(
  mailbox: NanoclawMailboxSession,
  session: Session,
  killKey: string,
  record: WorktreeInFlight,
  idleMinutes: number,
  commit: (write: () => void) => void,
): ReapFollowUp {
  const priorAttempts = mailbox.countRecoveryAttemptsSinceRealInbound(REAP_RESPAWN_ID_PREFIX);
  const followUp = decideReapFollowUp({ inFlightCheckouts: record.checkouts.length, priorAttempts });
  const fields = {
    sessionId: session.id,
    checkouts: record.checkouts.map((checkout) => checkout.name),
    priorAttempts,
    maxAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  };
  if (followUp.action !== 'wake-accountable') {
    if (followUp.reason === 'capped') log.info('Chat-reap accountability wake withheld — attempt cap reached', fields);
    return followUp;
  }
  if (!SELF_HEAL_ENABLED) {
    log.info('self-heal: would queue chat-reap accountability wake', { class: 'reaped-dirty-worktree', ...fields });
    return { action: 'none', reason: 'shadow' };
  }
  commit(() => writeReapRespawn(mailbox, session, killKey, record, idleMinutes));
  log.info('Queued chat-reap accountability wake', fields);
  return followUp;
}
