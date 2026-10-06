/**
 * Kill accountability: an agent whose container is stopped while it still owes work (edits only on disk, a task list
 * with items it can still move) and with nothing certain to bring it back sits until a human pings. Same row machinery
 * and cap as the ceiling wake; the decision itself is kill-state.ts's, this file writes the note. Kept free of
 * top-level side effects so other families can import it without registering this one.
 */
import { withCentralSync } from '../../db/central-lease.js';
import { withQuietInvalidationSync } from '../../db/sessions.js';
import { writeOutboundWhenStopped, writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import type { ReapFollowUp } from './decide.js';
import {
  decideKill,
  decideKillWithoutEvidence,
  hasKillEvidence,
  NO_EVIDENCE,
  readKillEvidence,
  REAP_RESPAWN_ID_PREFIX,
  STRANDING_KILLS,
  type KillEvidence,
} from './kill-state.js';

export const ACCOUNT_FOR_STATE = 'post ONE message accounting for state — done / lost / next';

export const RESTART_SURVIVAL_RULES =
  `Re-check any work claims in claims/ before resuming a seam — a sibling may have taken it over while you were down. ` +
  `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
  `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay.`;

const MAX_FILES_NAMED = 20;
const MAX_ITEMS_NAMED = 5;
const CONTAINER_WORKTREES_DIR = '/workspace/worktrees';

export interface StrandingKill {
  reason: string;
  minutes?: number;
  /** The ceiling branch's own answer for this kill: it queued its wake, so this one would be a second. */
  ceilingWakeQueued?: boolean;
}

function describeCheckouts(checkouts: KillEvidence['checkouts']): string {
  let namesLeft = MAX_FILES_NAMED;
  return checkouts
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

const ITEM_STATE = { in_progress: 'in progress', pending: 'pending', open: 'open' } as const;

function describeUnfinished(unfinished: KillEvidence['unfinished']): string {
  const lines = unfinished.slice(0, MAX_ITEMS_NAMED).map((item) => `- ${ITEM_STATE[item.status]}: ${item.text}`);
  const more = unfinished.length - lines.length;
  if (more > 0) lines.push(`(+${more} more)`);
  return lines.join('\n');
}

/** With worktree evidence alone this is the note the chat idle reap wrote before the list counted, to the byte. */
function wakeText(cause: string, evidence: KillEvidence): string {
  const listOnly = evidence.checkouts.length === 0;
  let text = `[system] Your previous container ${cause}`;
  text += listOnly
    ? '.'
    : `, and it left work that is not committed and pushed:\n${describeCheckouts(evidence.checkouts)}\n` +
      `Resume what is safely resumable — commit and push what is ready — and ${ACCOUNT_FOR_STATE}. ` +
      `A commit, a push or a PR is evidence; a description of what you meant to do is not. ` +
      `If this work is not yours (siblings in this thread share these checkouts) or is deliberately parked, ` +
      `say so in one line.`;
  if (evidence.unfinished.length > 0) {
    // Work only on disk must be accounted for in a message, and is woken whatever is armed; a list alone is woken
    // only when nothing is, and can be settled in the list.
    text +=
      `\nIts task list still had ${evidence.unfinished.length} item(s) neither done nor marked waiting` +
      `${listOnly ? ', and you had armed nothing to come back to them' : ''}:\n` +
      `${describeUnfinished(evidence.unfinished)}\n` +
      `Settle each one now with update_task_list. If it is in fact finished, mark it done. ` +
      `If the work is still owed, do the next item now. ` +
      `If you will check on it later (a peer agent you are waiting on counts), arm wait or continue_work naming ` +
      `what you will check and when — prose does not keep this thread alive. ` +
      `If you cannot move it yourself, mark it waiting on whoever owes the next move.` +
      (listOnly
        ? ` Post a message only if work was lost or that ask was never made; otherwise the updated list is the answer.`
        : '');
  }
  return `${text} ${RESTART_SURVIVAL_RULES}`;
}

function decisionLog(
  session: Session,
  kill: StrandingKill,
  evidence: KillEvidence,
  priorAttempts: number,
): { fields: Record<string, unknown>; decided: (outcome: ReapFollowUp, armedBy?: string) => ReapFollowUp } {
  const fields: Record<string, unknown> = {
    sessionId: session.id,
    killReason: kill.reason,
    evidence: [
      ...(evidence.checkouts.length > 0 ? ['worktree'] : []),
      ...(evidence.unfinished.length > 0 ? ['task-list'] : []),
    ],
    checkouts: evidence.checkouts.map((checkout) => checkout.name),
    unfinishedItems: evidence.unfinished.length,
    waitingItems: evidence.waiting,
    priorAttempts,
    maxAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  };
  const decided = (outcome: ReapFollowUp, armedBy?: string): ReapFollowUp => {
    log.info('Kill follow-up decided', {
      ...fields,
      ...(armedBy ? { armedBy } : {}),
      outcome: outcome.action === 'none' ? outcome.reason : 'wake',
    });
    return outcome;
  };
  return { fields, decided };
}

/** A kill of a container the registry never named: nothing is attributable to it, so no session is opened for it. */
export function followUpUnattributedKill(session: Session, kill: StrandingKill): ReapFollowUp {
  return decisionLog(session, kill, NO_EVIDENCE, 0).decided(
    decideKillWithoutEvidence(session, NO_EVIDENCE, kill.reason),
  );
}

/**
 * Decides and applies the kill's follow-up. Call after the killed container has exited. A kill that left no evidence
 * is only logged, and takes no lease. Otherwise the decision and the write are one synchronous block; the write sits
 * under the outbound guard although the row is inbound: a replacement that already took the session is handling the
 * thread, and the row would greet the NEXT container with a stale notice.
 */
export async function followUpKill(
  mailbox: NanoclawMailboxSession,
  session: Session,
  startedAtMs: number | null,
  kill: StrandingKill,
): Promise<ReapFollowUp> {
  const evidence = readKillEvidence(mailbox, startedAtMs);
  if (!hasKillEvidence(evidence)) {
    return decisionLog(session, kill, evidence, 0).decided(decideKillWithoutEvidence(session, evidence, kill.reason));
  }
  return withCentralSync((): ReapFollowUp => {
    const { followUp, withheldBy, priorAttempts } = decideKill(mailbox, session, evidence, kill);
    const { fields, decided } = decisionLog(session, kill, evidence, priorAttempts);
    if (followUp.action === 'none') {
      if (followUp.reason === 'shadow') {
        log.info('self-heal: would queue chat-reap accountability wake', {
          class: 'killed-with-work-in-flight',
          ...fields,
        });
      }
      return decided(followUp, followUp.reason === 'armed' ? (withheldBy ?? undefined) : undefined);
    }
    const cause = STRANDING_KILLS.get(kill.reason);
    if (!cause || startedAtMs === null) throw new Error('kill follow-up predicted a wake for a kill it cannot name');
    const written = writeOutboundWhenStopped(session, mailbox, () =>
      // A tick may have quiet-marked this stopped session since the kill; the mark must die with the write.
      withQuietInvalidationSync(session.id, () =>
        writeSystemWake(
          mailbox,
          session,
          `${REAP_RESPAWN_ID_PREFIX}${startedAtMs}`,
          wakeText(cause(kill.minutes), evidence),
          {
            kind: 'agent_reap_respawn',
            checkouts: evidence.checkouts.map((checkout) => checkout.name),
            ...(evidence.unfinished.length > 0 ? { unfinished_items: evidence.unfinished.length } : {}),
          },
        ),
      ),
    );
    if (written === undefined) return decided({ action: 'none', reason: 'armed' }, 'replacement-container');
    if (!written) return decided({ action: 'none', reason: 'armed' }, 'already-queued');
    return decided(followUp);
  }, 'kill follow-up');
}
